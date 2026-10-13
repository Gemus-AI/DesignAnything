/**
 * 从实际交付文件读取证据；不把代理文本、空白截图或未读页面当成成果。
 * 来源目录授权由调用者负责。本模块只管理自己的内容寻址缓存，并拒绝链接逃逸。
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { createRequire } from 'module'
import { promisify } from 'util'
import { fileURLToPath, pathToFileURL } from 'url'

import sharp from 'sharp'

import { extractSvgText, readPptxDeckFromBuffer, renderDeckText } from '../readDeckText'

export interface ArtifactEvidence {
  filePath: string
  contentType: string
  sha256: string
  text: string
  textComplete: boolean
  /** 未确认自包含的视频不能仅凭入口文件 SHA 接受人工审核。 */
  manualReviewBlocked?: true
  /**
   * 这把尺子**读不出这件的内容**（#3607 后续）。当前只有视频。
   *
   * 与 {@link limitations} 的区别是**成因的性质**：`limitations` 说的是「这一次没读全」
   * （PDF 只渲出 3/8 页、HTML 有资源缺失），那是仪器侧的偶发情况，值得让人看一眼；
   * 这一条说的是「这类载体本来就没有这把尺子读得懂的内容证据」，与这一次读得怎么样无关。
   *
   * 两者混在一起的代价是实测过的：视频的「抽样帧不足以证明整片」被写成 `limitations`，
   * 于是任何把视频列进 declared sources 的判据整条 `pending-manual`，同判据里的 deck
   * 一个模型调用都发不出去 —— 与 #3587 是同一个坑的另一个入口。
   */
  contentUnreadable?: true
  images: Array<{ filePath: string; sha256: string; page?: number; timeSeconds?: number }>
  /** HTML 实际读取的同包资源，复核时必须连同主文件重新核验。 */
  dependencies?: Array<{ filePath: string; sha256: string }>
  metadata: {
    width?: number
    height?: number
    format?: string
    contentType?: string
    colorSpace?: string
    hasAlpha?: boolean
    durationSeconds?: number
    pageCount?: number
    /**
     * `pageCount` 这一格是从哪来的（#3589）。缺席 = 从原件字节自己读出来的（PDF / 渲染出的
     * HTML / PPTX）。`'manifest'` = 原件本身不带页数（内联 markdown deck），数字取自导出清单
     * 里由真实内容数出来的 `pages`，由 `prepareRequirementArtifacts` 补上。
     * `'print'` = 没有分页容器的 HTML，页数是浏览器按它自己的打印样式（`@page`、
     * `break-after: page`）分出来的页（#3952）。
     */
    pageCountSource?: 'manifest' | 'print'
    pageSizes?: Array<{ widthPoints: number; heightPoints: number }>
  }
  limitations: ArtifactLimitation[]
}

/**
 * 证据的**通道**（#3703）。一份交付件同时供三种取证：读文字、看逐页画面、播内嵌媒体。
 * 三者各自可以独立完整或残缺 —— 一支视频加载失败不会让文档里的任何一个字变得读不出来。
 *
 * 此前没有这个维度：`limitations` 是一个扁平的字符串数组，`textComplete` 由「数组空不空」
 * 决定，于是**任意通道的任意瑕疵一票否决其余所有通道**。实测代价见 #3703：b4 的 42 份 deck
 * 里 7 份内嵌了 6–16 MB 的视频，视频请求在页面 load 之后仍在飞、被记成加载失败，
 * 整份文档因此被判「文字没读全」—— 文字完全可读，视频文件也确实在导出目录里。
 */
export type EvidenceChannel = 'text' | 'visual' | 'media'

/** 一条「这一次没读全」。`channels` 说的是**它影响哪几路取证**，不是它发生在哪一层。 */
export interface ArtifactLimitation {
  channels: readonly EvidenceChannel[]
  message: string
}

/** 落在指定通道上的 limitation。不传通道 = 全部。 */
export function limitationsOn(
  evidence: Pick<ArtifactEvidence, 'limitations'>,
  ...channels: readonly EvidenceChannel[]
): ArtifactLimitation[] {
  if (channels.length === 0) return evidence.limitations
  return evidence.limitations.filter((item) => item.channels.some((channel) => channels.includes(channel)))
}

/** 拼给人读的一行。空数组返回空串，调用方自己决定回退文案。 */
export function limitationText(limitations: readonly ArtifactLimitation[]): string {
  return limitations.map((item) => item.message).join('; ')
}

/** 三个通道全废 —— 这一件连打开都没打开。 */
const ALL_CHANNELS: readonly EvidenceChannel[] = ['text', 'visual', 'media']

function limit(result: ArtifactEvidence, channels: readonly EvidenceChannel[], message: string): void {
  result.limitations.push({ channels, message })
}

/** 上限只使证据不可判，不把截断部分描述为完整文件。 */
export const ARTIFACT_EVIDENCE_LIMITS = {
  fileBytes: 256 * 1024 * 1024,
  textCharacters: 1_000_000,
  pdfPages: 64,
  renderLongestSide: 2048,
  imagePixels: 100_000_000,
} as const

// #3703: v3 —— `limitations` 从 `string[]` 变成带通道的对象。旧缓存按 v2 的形状存着，
// 直接读会让 `limitationsOn` 在 `item.channels` 上炸。版本变了即整轮未命中，自然重读。
// #3952: v4 —— 无分页容器的 HTML 改走打印分页、PPTX 经 LibreOffice 渲染。旧缓存里这两类都是残缺读数。
const EVIDENCE_VERSION = 'artifact-evidence/v4'
const executeFile = promisify(execFile)
// 输入白名单在探测/解码前生效；拒绝 HLS、DASH、concat 等会打开其他文件的格式。
const VIDEO_INPUT_OPTIONS = ['-format_whitelist', 'mov,matroska', '-protocol_whitelist', 'file', '-strict', 'strict']
const MOV_INPUT_OPTIONS = ['-enable_drefs', '0', '-use_absolute_path', '0']
// **已知的容器** box 及其合法子项。#3607 起这张表不再兼任「允许出现的 box 词表」：
// 表上没有的 box 不再整件拒收，而是先试着按 box 序列解析它的内容 —— 解得开就照常下降
// （藏在里面的 dref 一样会被查到），解不开才当作不透明叶子。
//
// 改法的由来：旧注释说「未知结构不能按叶子跳过后声称完整」，那个担心是对的，但用**词表**
// 近似它的代价是任何编码器写了一个没被列过的标准 box，整支视频就不可判 —— 实测 13 支真实
// 视频 13 支全灭，理由只有 `meta/keys`（QuickTime 元数据键表）和 `root/uuid`（ISO 标准的
// 顶层扩展 box）两种，两者都不携带外部引用。新写法把「未知」与「不可解析」分开：真正跳过的
// 只有解析不出 box 结构的字节，而 dref 必然是一个合法 box，所以它藏不进那类字节里。
const MOV_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  root: ['ftyp', 'free', 'wide', 'mdat', 'moov'],
  moov: ['mvhd', 'trak', 'udta', 'meta'],
  trak: ['tkhd', 'edts', 'mdia', 'udta'],
  edts: ['elst'], mdia: ['mdhd', 'hdlr', 'minf'],
  minf: ['vmhd', 'smhd', 'hmhd', 'nmhd', 'hdlr', 'dinf', 'stbl'], dinf: ['dref'],
  stbl: ['stsd', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco', 'co64', 'sdtp', 'stps', 'cslg', 'sgpd', 'sbgp', 'stz2'],
  udta: ['meta', '©swr', '©too', '©nam', '©ART', '©cmt', '©day', '©gen', '©alb'],
  meta: ['hdlr', 'ilst'], ilst: ['©too', '©nam', '©ART', '©cmt', '©day', '©gen', '©alb', 'aART', 'covr', 'trkn', 'disk', 'cpil', 'pgap', 'tmpo'],
  videoSample: ['avcC', 'hvcC', 'av1C', 'vpcC', 'btrt', 'pasp', 'colr', 'clap', 'fiel', 'gama', 'glbl', 'mdcv', 'clli'],
  audioSample: ['esds', 'wave', 'btrt', 'chan', 'chnl', 'alac', 'dac3', 'dec3', 'dOps', 'glbl'],
  wave: ['frma', 'enda', 'mp4a', 'esds', 'alac', 'chan', 'btrt', 'glbl', '\0\0\0\0'],
}

/** MOV 也能引用外部轨道；仅允许每条 dref 明示使用本文件的 URL 项。 */
function assertSelfContainedMovie(file: string): void {
  const descriptor = fs.openSync(file, 'r')
  const read = (offset: number, size: number): Buffer => {
    const buffer = Buffer.alloc(size)
    if (fs.readSync(descriptor, buffer, 0, size, offset) !== size) throw new Error('Incomplete MOV container structure')
    return buffer
  }
  let visited = 0
  let references = 0
  const boxAt = (offset: number, end: number) => {
    if (++visited > 100_000 || offset + 8 > end) throw new Error('MOV structure exceeds the safe inspection budget')
    const header = read(offset, 8)
    const shortSize = header.readUInt32BE(0)
    const headerSize = shortSize === 1 ? 16 : 8
    const size = shortSize === 0 ? end - offset : shortSize === 1 ? Number(read(offset + 8, 8).readBigUInt64BE()) : shortSize
    if (!Number.isSafeInteger(size) || size < headerSize || offset + size > end) throw new Error('Invalid MOV container box')
    return { type: header.toString('latin1', 4, 8), data: offset + headerSize, end: offset + size }
  }
  /**
   * 这段字节是不是一串完整的 box。
   *
   * 只做**结构**判断，不做策略判断：解得开就交给 `inspect` 去查策略，解不开才当叶子。
   * box type 要求是可打印 ASCII（外加 `©`，QuickTime 元数据用它），否则随机的媒体字节
   * 很容易凑巧凑出一个"合法长度"。
   */
  const parsesAsBoxes = (start: number, end: number): boolean => {
    if (end - start < 8) return false
    try {
      for (let offset = start; offset < end;) {
        const box = boxAt(offset, end)
        if (!/^[ -~©]{4}$/u.test(box.type)) return false
        offset = box.end
      }
      return true
    } catch { return false }
  }
  const inspect = (start: number, end: number, depth: number, parent: string): void => {
    if (depth > 10) throw new Error('Unexpected MOV container nesting')
    for (let offset = start; offset < end;) {
      const box = boxAt(offset, end)
      if (box.type === 'cmov' || box.type === 'rmra') throw new Error('Compressed or reference MOV movies cannot establish self-contained data references')
      const known = MOV_CHILDREN[parent]?.includes(box.type) === true
      if (MOV_CHILDREN[box.type] && known) {
        const fullBoxBytes = box.type === 'meta' ? 4 : 0
        if (fullBoxBytes && (box.data + 4 > box.end || read(box.data, 4).readUInt32BE(0) !== 0)) throw new Error('Unsupported MOV metadata layout')
        inspect(box.data + fullBoxBytes, box.end, depth + 1, box.type)
      } else if (!known && parsesAsBoxes(box.data, box.end)) {
        // 未知但内容确实是一串 box —— 照常下降。下降过程中抛出的违规（外部 dref、cmov）
        // 原样向上抛，不在这里吞掉：那会让「解析失败」变成绕过检查的入口
        inspect(box.data, box.end, depth + 1, box.type)
      }
      if (box.type === 'stsd') {
        if (box.data + 8 > box.end) throw new Error('Incomplete MOV sample descriptions')
        const count = read(box.data + 4, 4).readUInt32BE(0)
        if (!count || count > 1024) throw new Error('Unsupported MOV sample descriptions')
        let cursor = box.data + 8
        for (let index = 0; index < count; index += 1) {
          const entry = boxAt(cursor, box.end)
          const video = ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v', 'apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x', 'jpeg', 'mjpa', 'mjpb', 'png '].includes(entry.type)
          const audio = ['mp4a', 'ac-3', 'ec-3', 'alac', 'Opus', 'sowt', 'twos', 'lpcm'].includes(entry.type)
          if (!video && !audio) throw new Error(`Unsupported MOV sample type: ${entry.type}`)
          if (entry.data + (video ? 78 : 28) > entry.end) throw new Error('Incomplete MOV sample header')
          const audioVersion = audio ? read(entry.data + 8, 2).readUInt16BE(0) : 0
          const headerBytes = video ? 78 : audioVersion === 0 ? 28 : audioVersion === 1 ? 44 : audioVersion === 2 ? 64 : -1
          if (headerBytes < 0 || entry.data + headerBytes > entry.end) throw new Error('Unsupported MOV audio sample header')
          inspect(entry.data + headerBytes, entry.end, depth + 1, video ? 'videoSample' : 'audioSample')
          cursor = entry.end
        }
        if (cursor !== box.end) throw new Error('Unexpected MOV sample description bytes')
      }
      if (box.type === 'dref') {
        if (box.data + 8 > box.end) throw new Error('Incomplete MOV data references')
        const count = read(box.data + 4, 4).readUInt32BE(0)
        if (!count || count > 1024) throw new Error('Unsupported MOV data references')
        let cursor = box.data + 8
        for (let index = 0; index < count; index += 1) {
          const entry = boxAt(cursor, box.end)
          if (entry.type !== 'url ' || entry.data + 4 !== entry.end || read(entry.data, 4).readUInt32BE(0) !== 1) throw new Error('MOV contains external or unsupported data references')
          references += 1
          cursor = entry.end
        }
        if (cursor !== box.end) throw new Error('Unexpected MOV data reference bytes')
      }
      offset = box.end
    }
  }
  try {
    inspect(0, fs.fstatSync(descriptor).size, 0, 'root')
    if (!references) throw new Error('MOV has no verified self-contained data reference')
  } finally { fs.closeSync(descriptor) }
}

/** EBML DocType 是容器自己的字段；不根据文件名把 Matroska 冒充 WebM。 */
function ebmlDocumentType(header: Buffer): string | undefined {
  if (header.readUInt32BE(0) !== 0x1a45dfa3) return undefined
  const integer = (offset: number, keepMarker = false): { value: number; end: number } | undefined => {
    let length = 1
    while (length <= 8 && !(header[offset] & (0x80 >> (length - 1)))) length += 1
    if (length > 8 || offset + length > header.length) return undefined
    let value = header[offset] & (keepMarker ? 255 : (0xff >> length))
    for (let index = 1; index < length; index += 1) value = value * 256 + header[offset + index]
    return Number.isSafeInteger(value) ? { value, end: offset + length } : undefined
  }
  const size = integer(4)
  if (!size || size.end + size.value > header.length) return undefined
  const end = size.end + size.value
  for (let offset = size.end; offset < end;) {
    const id = integer(offset, true)
    const length = id && integer(id.end)
    if (!id || !length || length.end + length.value > end) return undefined
    if (id.value === 0x4282) return header.toString('ascii', length.end, length.end + length.value)
    offset = length.end + length.value
  }
  return undefined
}

function videoContentType(file: string, format: string | undefined, majorBrand: string | undefined): string | undefined {
  if (format?.split(',').includes('mov')) {
    assertSelfContainedMovie(file)
    if (majorBrand === 'qt  ') return 'video/quicktime'
    if (majorBrand && /^(?:iso[0-9m]|mp4[12]|avc1|dash|M4V |MSNV)$/.test(majorBrand)) return 'video/mp4'
    return undefined
  }
  if (!format?.split(',').includes('matroska')) return undefined
  const descriptor = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(4096)
    const bytes = fs.readSync(descriptor, header, 0, header.length, 0)
    if (bytes < 5) return undefined
    const type = ebmlDocumentType(header.subarray(0, bytes))
    return type === 'webm' ? 'video/webm' : type === 'matroska' ? 'video/x-matroska' : undefined
  } finally { fs.closeSync(descriptor) }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0].slice(0, 300)
}

async function fileSha(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

/** 缓存根可以由调用方指定，但任何输出都必须位于它的真实目录之内。 */
function cachePath(root: string, name: string): string {
  const resolved = path.resolve(root, name)
  if (!contained(root, resolved)) throw new Error('Artifact evidence cache path escapes cacheDir')
  if (fs.existsSync(resolved) && !contained(root, fs.realpathSync(resolved))) {
    throw new Error('Artifact evidence cache symlink escapes cacheDir')
  }
  return resolved
}

async function deadline<T>(promise: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Evidence operation timed out after ${milliseconds} ms`)), milliseconds)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function setText(result: ArtifactEvidence, text: string, complete = true): void {
  if (text.length > ARTIFACT_EVIDENCE_LIMITS.textCharacters) {
    result.text = ''
    result.textComplete = false
    limit(result, ['text'], `Text exceeds ${ARTIFACT_EVIDENCE_LIMITS.textCharacters} characters; no truncated text is presented as complete`)
  } else {
    result.text = text
    result.textComplete = complete
  }
}

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * 读一份 .docx 的正文（#3680）。
 *
 * **只取文字，刻意不产出页数。** docx 文件里没有「渲染后有几页」这个事实 —— 分页是排版器
 * 打开它时才算出来的；我们自己生成的那份（`src/lib/renderers/wordRenderer.ts` 走 `docx` 库）
 * 连 `docProps/app.xml` 的 `<Pages>` 都是空元素。数分页符再加一是编数据，
 * `importExternalRun.ts` 已经对同一件事裁过：「当作不满足任何 `minPages`，那是对的，
 * 不要靠猜去绕开它」。所以页数保持不可知，带 `minPages` 的槽照旧判「没测出来」。
 *
 * **不写 `limitations`。** 「这类载体没有页数」不是「这一次没读全」，而写进 `limitations`
 * 会让引用它的整条判据被拖成 `pending-manual`（`requirementChecks` 的 `sourceIncomplete`
 * 那条路，#3607 踩过一次）。缺席的 `pageCount` 自己就表达了不可知。
 */
async function readDocx(result: ArtifactEvidence): Promise<void> {
  const mammoth = await import('mammoth')
  const { value } = await mammoth.extractRawText({ buffer: fs.readFileSync(result.filePath) })
  setText(result, value)
  result.metadata.format = 'docx'
}

/** RGB 通道模型不等于 sRGB；有 ICC 时优先读取其描述，未知配置不冒充 sRGB。 */
function imageColorSpace(metadata: sharp.Metadata): string | undefined {
  const profile = metadata.icc
  if (profile === undefined) return metadata.space
  let description = ''
  try {
    const count = Math.min(profile.readUInt32BE(128), 256)
    for (let index = 0; index < count; index += 1) {
      const entry = 132 + index * 12
      if (profile.toString('ascii', entry, entry + 4) !== 'desc') continue
      const offset = profile.readUInt32BE(entry + 4)
      const type = profile.toString('ascii', offset, offset + 4)
      if (type === 'desc') description = profile.toString('ascii', offset + 12, offset + 12 + profile.readUInt32BE(offset + 8)).replace(/\0/g, '')
      if (type === 'mluc') {
        const length = profile.readUInt32BE(offset + 20)
        const start = offset + profile.readUInt32BE(offset + 24)
        description = Buffer.from(profile.subarray(start, start + length)).swap16().toString('utf16le')
      }
      break
    }
  } catch { /* 损坏或未知 ICC 描述保留为未知，禁止按 RGB 通道猜 sRGB。 */ }
  if (/^srgb(?:\b|v)/i.test(description)) return 'srgb'
  if (/\b(?:display[ -]?p3|dci[ -]?p3)\b/i.test(description) || description === 'sP3C') return 'display-p3'
  if (/adobe\s*rgb/i.test(description)) return 'adobe-rgb'
  return metadata.space === 'cmyk' ? 'cmyk' : 'icc-unknown'
}

/**
 * 读一份 PDF 的逐页文字与逐页画面。
 *
 * `pdfPath` 缺省就是原件；HTML 打印件与 PPTX 转出的 PDF 也走这里（#3952），那时原件另有其物，
 * 缓存目录与缓存键仍按原件算。`textLayerAuthoritative`：这份 PDF 是浏览器从 HTML 的 DOM 打印来的，
 * 某页抽不出字就是那页的 DOM 本来没有字，与有容器 HTML 的逐页读法同一个口径 —— 图里的字归视觉
 * 通道，不算文字没读全。PPTX 转出的 PDF 不适用（见 PPTX 分支）。
 */
async function readPdf(result: ArtifactEvidence, outputDir: string, pdfPath = result.filePath, textLayerAuthoritative = false): Promise<void> {
  // 使用已有完整 PDF.js 构建；不切换 unpdf 的全局解析器，避免改变旧评估口径。
  const canvas = await import('@napi-rs/canvas')
  Object.assign(globalThis, { DOMMatrix: canvas.DOMMatrix, Path2D: canvas.Path2D, ImageData: canvas.ImageData })
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const moduleRequire = createRequire(path.resolve(process.cwd(), 'package.json'))
  const standardFontDataUrl = `${pathToFileURL(path.join(path.dirname(moduleRequire.resolve('pdfjs-dist/package.json')), 'standard_fonts')).href}/`
  const loading = getDocument({
    data: new Uint8Array(fs.readFileSync(pdfPath)),
    disableFontFace: true,
    useSystemFonts: true,
    standardFontDataUrl,
  })
  try {
    const pdf = await deadline(loading.promise)
    result.metadata.pageCount = pdf.numPages
    result.metadata.format = 'pdf'
    if (pdf.numPages > ARTIFACT_EVIDENCE_LIMITS.pdfPages) {
      limit(result, ['text', 'visual'], `PDF has ${pdf.numPages} pages, exceeding the ${ARTIFACT_EVIDENCE_LIMITS.pdfPages}-page evidence limit; no pages were silently omitted`)
      return
    }
    result.metadata.pageSizes = []
    const pageTexts: string[] = []
    let complete = true
    const started = Date.now()
    for (let number = 1; number <= pdf.numPages; number += 1) {
      if (Date.now() - started > 90_000) {
        limit(result, ['text', 'visual'], `PDF processing exceeded 90 seconds; pages ${number}–${pdf.numPages} are unread`)
        complete = false
        break
      }
      const page = await deadline(pdf.getPage(number))
      const dimensions = page.getViewport({ scale: 1 })
      result.metadata.pageSizes.push({ widthPoints: dimensions.width, heightPoints: dimensions.height })
      try {
        const content = await deadline(page.getTextContent())
        const text = content.items.map((item) => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim()
        pageTexts.push(`## Page ${number}\n\n${text}`)
        if (text === '' && !textLayerAuthoritative) {
          complete = false
          limit(result, ['text'], `PDF page ${number} has no extractable text; visible image text requires visual inspection`)
        }
      } catch (error) {
        complete = false
        limit(result, ['text'], `PDF page ${number} text could not be read: ${errorText(error)}`)
      }
      try {
        const scale = Math.min(1.5, ARTIFACT_EVIDENCE_LIMITS.renderLongestSide / Math.max(dimensions.width, dimensions.height))
        if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid page dimensions')
        const viewport = page.getViewport({ scale })
        const target = canvas.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const rendering = page.render({
          canvas: target as unknown as HTMLCanvasElement,
          canvasContext: target.getContext('2d') as unknown as CanvasRenderingContext2D,
          viewport,
        })
        try { await deadline(rendering.promise) } catch (error) { rendering.cancel(); throw error }
        const filePath = cachePath(outputDir, `page-${String(number).padStart(3, '0')}.png`)
        fs.writeFileSync(filePath, target.toBuffer('image/png'))
        result.images.push({ filePath, sha256: await fileSha(filePath), page: number })
      } catch (error) {
        limit(result, ['visual'], `PDF page ${number} could not be rendered: ${errorText(error)}`)
      } finally {
        page.cleanup()
      }
    }
    setText(result, pageTexts.join('\n\n'), complete && pageTexts.length === pdf.numPages)
    if (result.images.length !== pdf.numPages) limit(result, ['visual'], `Only ${result.images.length}/${pdf.numPages} PDF pages have visual evidence; whole-deck visual checks are not complete`)
  } finally {
    await deadline(loading.destroy(), 5_000).catch(() => undefined)
  }
}

/**
 * PPTX → PDF（#3952），交给 {@link readPdf} 按 PDF 同等读取。返回 null = 这台机器没有 LibreOffice。
 *
 * 显式设了 `BENCHMARK_SOFFICE_PATH` 却找不到可执行文件是**操作错误**，照抛不降级 ——
 * 与 `sidecarPreflight` 同一条纪律：env 没设才允许优雅降级，设了就必须指得对。
 * 每次转换用独立的用户配置目录：LibreOffice 共用一个配置时并发实例会互相锁死。
 */
async function renderPptxToPdf(file: string, outputDir: string): Promise<string | null> {
  const configured = process.env.BENCHMARK_SOFFICE_PATH
  const outDir = cachePath(outputDir, 'pptx-render')
  fs.mkdirSync(outDir, { recursive: true })
  // 配置目录放在系统临时目录的短路径下：它内部层级很深，建在证据缓存里会超过 Windows 的
  // 260 字符路径上限，LibreOffice 此时退出码 0、一个字不报、也不出 PDF（实测）。
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-'))
  try {
    await executeFile(configured || 'soffice', [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, file,
    ], { timeout: 120_000, windowsHide: true })
  } catch (error) {
    if (!configured && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally {
    fs.rmSync(profile, { recursive: true, force: true })
  }
  const pdf = path.join(outDir, `${path.basename(file, path.extname(file))}.pdf`)
  if (!fs.existsSync(pdf)) throw new Error('LibreOffice produced no PDF for this PPTX')
  return pdf
}

async function readVideo(result: ArtifactEvidence): Promise<void> {
  const ffprobe = process.env.BENCHMARK_FFPROBE_PATH || 'ffprobe'
  const { stdout } = await executeFile(ffprobe, [
    '-v', 'error', ...VIDEO_INPUT_OPTIONS, ...MOV_INPUT_OPTIONS, '-show_entries', 'format=duration,format_name:format_tags=major_brand:stream=codec_type,width,height,duration', '-of', 'json', result.filePath,
  ], { timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true })
  const probe = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string; tags?: { major_brand?: string } }
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>
  }
  const stream = probe.streams?.find((entry) => entry.codec_type === 'video')
  if (stream === undefined) throw new Error('No decodable video stream')
  const contentType = videoContentType(result.filePath, probe.format?.format_name, probe.format?.tags?.major_brand)
  if (contentType === undefined) throw new Error('Video is not a recognized self-contained MP4, MOV, WebM, or Matroska container')
  delete result.manualReviewBlocked
  const duration = Number(stream.duration ?? probe.format?.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Video duration is not readable')
  result.metadata = { width: stream.width, height: stream.height, format: probe.format?.format_name, contentType, durationSeconds: duration }
  // **不抽帧。** 抽出来的帧没有任何计分用途：`visualReady()` 对视频一律返回「抽样帧不足以
  // 证明整片合规」，身份尺也把视频排除在外，所以视觉 / 内容 / 身份三类判定一帧都不看。
  // 剩下的唯一读者是人工复核，而人工复核要看的是**原片**，不是十二张缩略图。
  // 于是每支视频十二次 ffmpeg 调用换来的是一堆没人读的 png。
  //
  // 视频在这把尺子上贡献的是**容器头**：时长、分辨率、真实 container type，
  // 它们由上面那次 ffprobe 一次取齐，与帧无关。
  result.contentUnreadable = true
}

/**
 * 一条失败的子资源请求，到底是「文件不在」还是「加载没走完」（#3703 P2）。
 *
 * 旧文案把两者压成一句 `missing or blocked`，于是排查时分不开：b4 那 7 份 deck 是靠人工
 * 逐个去目录里核对文件确实存在（8.53 MB、就在同目录）才定的性。文件在不在，代码自己就
 * 能答，不该让人去答。
 */
function describeFailedResource(url: string): string {
  if (!url.startsWith('file:')) return `${url} (not a file in this export)`
  try {
    const target = fileURLToPath(url)
    return fs.existsSync(target)
      ? `${url} (present on disk; the evaluator did not finish loading it)`
      : `${url} (no such file in the export)`
  } catch {
    return `${url} (unresolvable file reference)`
  }
}

/**
 * 这份 HTML 有没有**自己声明**打印分页（#3952）：打印样式下有强制分页（`break-before/after: page`
 * 及旧写法 `page-break-*: always`），或 `@page` 规则给了纸张尺寸。只有声明了，打印出来的页数才是
 * 文档自己的页数；否则页数取决于评估器选的纸张。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- playwright-core 是可选运行期依赖，类型不进本模块
async function declaresPrintPagination(page: any): Promise<boolean> {
  await page.emulateMedia({ media: 'print' })
  try {
    // 回调里不写具名的内部函数：tsx（esbuild keepNames）会给它包一层 `__name(...)`，而页面里没有这个
    // 辅助函数，整份证据会因 ReferenceError 作废（实测；vitest 的编译不包，单测看不出来）。
    return await page.evaluate(() => {
      const pending: CSSRule[] = []
      for (const sheet of Array.from(document.styleSheets)) {
        try { pending.push(...Array.from(sheet.cssRules)) } catch { /* 跨源样式表读不到规则，按未声明处理 */ }
      }
      while (pending.length > 0) {
        const rule = pending.pop()!
        if (rule instanceof CSSPageRule && rule.style.getPropertyValue('size').trim() !== '') return true
        if (rule instanceof CSSMediaRule && window.matchMedia(rule.conditionText).matches) pending.push(...Array.from(rule.cssRules))
      }
      const forced = new Set(['page', 'always', 'left', 'right', 'recto', 'verso'])
      return Array.from(document.querySelectorAll('body *')).some((element) => {
        const style = getComputedStyle(element)
        return forced.has(style.breakBefore) || forced.has(style.breakAfter)
      })
    })
  } finally {
    await page.emulateMedia({ media: null })
  }
}

/** 使用交付文件自己的 DOM/样式读取逐页结果；资源缺失时保留诊断，不返回一套假完整图。 */
async function readHtml(result: ArtifactEvidence, outputDir: string): Promise<void> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch(process.env.BENCHMARK_BROWSER_EXECUTABLE_PATH
    ? { executablePath: process.env.BENCHMARK_BROWSER_EXECUTABLE_PATH, headless: true }
    : { channel: 'chrome', headless: true })
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, javaScriptEnabled: false, serviceWorkers: 'block' })
    const sourceDirectory = path.dirname(result.filePath)
    const allowedRoot = path.basename(sourceDirectory) === 'artifacts' ? path.dirname(sourceDirectory) : sourceDirectory
    // #3703: 记住**每条失败请求是什么类型**。`missing or blocked` 此前把「样式表不在包里」
    // 与「视频流没等到」压成同一句话，而两者影响的通道完全不同：前者让画面不对，后者
    // 一个字都不影响。判定要分通道，就得先把类型留下来。
    const failed = new Map<string, string>()
    const dependencies = new Set<string>()
    context.on('request', (request) => {
      if (!request.url().startsWith('file:')) return
      try {
        const target = fs.realpathSync(fileURLToPath(request.url()))
        if (target !== result.filePath && contained(allowedRoot, target)) dependencies.add(target)
      } catch { /* 请求失败事件会保留缺失资源。 */ }
    })
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (/^(data:|about:)/.test(url)) return route.continue()
      if (url.startsWith('file:')) {
        try {
          const target = fs.realpathSync(fileURLToPath(url))
          if (target === result.filePath || contained(allowedRoot, target)) return route.continue()
        } catch { /* 缺失资源会在下方统一记录。 */ }
      }
      failed.set(url, route.request().resourceType())
      return route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    page.on('requestfailed', (request) => { failed.set(request.url(), request.resourceType()) })
    page.on('response', (response) => { if (response.status() >= 400) failed.set(response.url(), response.request().resourceType()) })
    // #3703: **不等媒体**，这是契约不是碰运气。`load` 之后仍在飞的流式媒体请求会被中止，
    // 于是一支完好的大视频照样进 `failed` 集合 —— 实测 1 MB 过、6 MB 起全灭。
    // 换 `networkidle` 只是把阈值往后推（让量尺去等一支 15 MB 的视频缓冲完，单份 deck 的
    // 探测时长不可控），所以这里明确选「不等」，并让媒体通道的失败**不计入文字完整性**。
    // 需要看视频的判据自己去读 media 通道那条具名读数。
    await page.goto(pathToFileURL(result.filePath).href, { waitUntil: 'load', timeout: 15_000 })
    const frameSelector = 'iframe[data-benchmark-page]'
    let selector: string | null = await page.locator(frameSelector).count() > 0 ? frameSelector : null
    if (selector === null) {
      for (const candidate of ['.slide', '[data-slide]', 'section.page']) {
        if (await page.locator(candidate).count() > 0) { selector = candidate; break }
      }
    }
    // #3952：没有分页容器不等于没有页。外部系统的文档普遍用打印分页（`div.page`、
    // `section { break-after: page }`、`@page`）—— 那是文档**自己声明**的实际页面。
    // 交给浏览器按它自己的打印样式分页，再按 PDF 读；不按标题或视口高度替它发明页界。
    // 此前这里只收 body 文字并记「没读全」，OD / Codex 的 3000 余份文档正文因此全部作废。
    let count = 0
    const texts: string[] = []
    if (selector === null) {
      await page.evaluate(() => document.fonts.ready)
      const printed = cachePath(outputDir, 'print.pdf')
      // 声明了 `@page size` 的按它自己的纸张；没声明的按上面的视口大小（1920×1080）出页 ——
      // 外部系统常把屏幕版式的页写成 1920 宽而不写打印纸张，按 A4 打会把右半边截掉（实测）。
      await page.pdf({ path: printed, printBackground: true, preferCSSPageSize: true, width: '1920px', height: '1080px' })
      await readPdf(result, outputDir, printed, true)
      result.metadata.format = 'html'
      if (await declaresPrintPagination(page)) {
        result.metadata.pageCountSource = 'print'
      } else {
        // 没声明分页的流式长页面：打印出来的页数只取决于我们选的纸张（实测 Codex 一份规格书 1920×1080
        // 下 2 页，同一文档它自己导出的 PDF 8 页）。那是评估器发明的页界 —— 文字与画面照收，页数不报，
        // 带页数下限的槽对它记「没测出来」，不记「页数不够」。
        delete result.metadata.pageCount
        delete result.metadata.pageSizes
        limit(result, ['visual'], 'HTML declares no print pagination; the page images are print-flow slices at the evaluator viewport, not document pages, so no page count is reported')
      }
    } else {
      count = await page.locator(selector).count()
      result.metadata.pageCount = count
      result.metadata.format = 'html'
      if (count > ARTIFACT_EVIDENCE_LIMITS.pdfPages) {
        limit(result, ['text', 'visual'], `HTML has ${count} pages, exceeding the ${ARTIFACT_EVIDENCE_LIMITS.pdfPages}-page evidence limit`)
        return
      }
      const hasActive = selector !== frameSelector && await page.locator(`${selector}.active`).count() > 0
      for (let index = 0; index < count; index += 1) {
        try {
          if (hasActive) await page.evaluate(({ sel, activeIndex }) => {
            document.querySelectorAll(sel).forEach((element, number) => element.classList.toggle('active', number === activeIndex))
          }, { sel: selector, activeIndex: index })
          const locator = page.locator(selector).nth(index)
          const frame = selector === frameSelector ? await (await locator.elementHandle())?.contentFrame() : null
          const body = frame === null || frame === undefined ? locator : frame.locator('body')
          await (frame ?? page).evaluate(() => document.fonts.ready)
          const brokenImages = await body.locator('img').evaluateAll((elements) => elements.filter((element) => {
            const image = element as HTMLImageElement
            return !image.complete || image.naturalWidth === 0
          }).length)
          // #3952：断图只缺画面，这一页的字照样读得全 —— 只降视觉通道，文字与截图照收
          if (brokenImages > 0) limit(result, ['visual'], `HTML page ${index + 1}: ${brokenImages} image resource(s) are missing or undecodable`)
          const dimensions = await locator.boundingBox()
          if (dimensions === null || dimensions.width < 1 || dimensions.height < 1) throw new Error('Page has no visible area')
          if (dimensions.width * dimensions.height > ARTIFACT_EVIDENCE_LIMITS.imagePixels) throw new Error('Page raster exceeds image pixel limit')
          texts.push(`## Page ${index + 1}\n\n${await body.innerText()}`)
          const filePath = cachePath(outputDir, `page-${String(index + 1).padStart(3, '0')}.png`)
          await locator.screenshot({ path: filePath, timeout: 15_000, animations: 'disabled' })
          result.images.push({ filePath, sha256: await fileSha(filePath), page: index + 1 })
        } catch (error) {
          limit(result, ['text', 'visual'], `HTML page ${index + 1} could not be fully read: ${errorText(error)}`)
        }
      }
    }
    // #3703: 媒体子资源与其余子资源分开报，落在不同通道上。
    //
    // **媒体通道的失败不进文字完整性**，因为 `goto(..., { waitUntil: 'load' })` 按契约就是
    // 不等媒体流式请求完成的（见下面 goto 处的注释）—— 一支 8 MB 的 `<video autoplay>` 的
    // range 请求在页面收尾时被中止，文件本身完好无损。把它算进「文字没读全」，等于让量尺
    // 用自己的等待策略去否定一份读得好好的转写。
    const mediaFailures = [...failed].filter(([, type]) => type === 'media').map(([url]) => url)
    const otherFailures = [...failed].filter(([, type]) => type !== 'media').map(([url]) => url)
    if (otherFailures.length > 0) {
      limit(result, ['visual'], `HTML has ${otherFailures.length} unusable non-media resource(s): ${otherFailures.slice(0, 5).map(describeFailedResource).join(', ')}`)
    }
    if (mediaFailures.length > 0) {
      limit(result, ['media'], `HTML has ${mediaFailures.length} media resource(s) the evaluator did not load: ${mediaFailures.slice(0, 5).map(describeFailedResource).join(', ')}`)
    }
    result.dependencies = await Promise.all([...dependencies].sort().map(async (filePath) => ({ filePath, sha256: await fileSha(filePath) })))
    if (selector === null) return
    if (result.images.length !== count) limit(result, ['visual'], `Only ${result.images.length}/${count} HTML pages have visual evidence`)
    // #3703: 文字完整性只由 text 通道决定。一份文档的文字读全了就是读全了，与它内嵌的
    // 视频能不能播无关；视觉通道的残缺照样如实记着，由需要画面的判据自己去读。
    setText(result, texts.join('\n\n'), texts.length === count && limitationsOn(result, 'text').length === 0)
  } finally {
    await browser.close()
  }
}

async function validCache(manifest: string, source: ArtifactEvidence, outputDir: string): Promise<ArtifactEvidence | null> {
  // HTML 依赖逐次重读；视频每次重过容器/引用安全门，不信任旧缓存中的解码结论。
  if (source.contentType === 'text/html' || source.contentType === 'application/xhtml+xml' || source.contentType.startsWith('video/')) return null
  if (!fs.existsSync(manifest)) return null
  try {
    const cached = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string; evidence: ArtifactEvidence }
    const result = cached.evidence
    if (cached.version !== EVIDENCE_VERSION || result.sha256 !== source.sha256 || result.contentType !== source.contentType || result.limitations.length > 0) return null
    for (const item of result.images) {
      const filePath = item.filePath === result.filePath ? source.filePath : cachePath(outputDir, path.relative(outputDir, item.filePath))
      if (!fs.existsSync(filePath) || await fileSha(filePath) !== item.sha256) return null
      item.filePath = filePath
    }
    return { ...result, filePath: source.filePath }
  } catch {
    return null
  }
}

export async function prepareArtifactEvidence(options: {
  filePath: string
  contentType: string
  cacheDir: string
}): Promise<ArtifactEvidence> {
  if (!options.filePath.trim() || !options.cacheDir.trim()) throw new Error('Artifact filePath and cacheDir must not be empty')
  const filePath = fs.realpathSync(path.resolve(options.filePath))
  if (!fs.statSync(filePath).isFile()) throw new Error('Artifact filePath must be a regular file')
  fs.mkdirSync(path.resolve(options.cacheDir), { recursive: true })
  const cacheRoot = fs.realpathSync(path.resolve(options.cacheDir))
  const result: ArtifactEvidence = {
    filePath, contentType: options.contentType.split(';')[0].trim().toLowerCase(), sha256: await fileSha(filePath),
    text: '', textComplete: false, images: [], metadata: {}, limitations: [],
  }
  if (result.contentType.startsWith('video/')) result.manualReviewBlocked = true
  const key = crypto.createHash('sha256').update(`${EVIDENCE_VERSION}\n${result.sha256}\n${result.contentType}`).digest('hex')
  const outputDir = cachePath(cacheRoot, key)
  fs.mkdirSync(outputDir, { recursive: true })
  if (!contained(outputDir, filePath) && filePath !== outputDir) {
    // 通过真实目录再次确认中间目录没有链接逃逸。
    if (!contained(cacheRoot, fs.realpathSync(outputDir))) throw new Error('Artifact evidence output directory escapes cacheDir')
  } else throw new Error('Artifact source must not be inside its generated evidence directory')
  const manifest = cachePath(outputDir, 'evidence.json')
  const cached = await validCache(manifest, result, outputDir)
  if (cached !== null) return cached
  if (fs.statSync(filePath).size > ARTIFACT_EVIDENCE_LIMITS.fileBytes) {
    limit(result, ALL_CHANNELS, `File exceeds the ${ARTIFACT_EVIDENCE_LIMITS.fileBytes}-byte evidence limit; SHA-256 was read but content was not decoded`)
    return result
  }
  try {
    if (result.contentType === 'application/pdf') {
      await readPdf(result, outputDir)
    } else if (result.contentType.startsWith('video/')) {
      await readVideo(result)
    } else if (result.contentType.startsWith('image/')) {
      const metadata = await sharp(filePath, { limitInputPixels: ARTIFACT_EVIDENCE_LIMITS.imagePixels }).metadata()
      // metadata() 只读头部；真正解码一次，损坏的像素数据不能冒充可用图像。
      await sharp(filePath, { limitInputPixels: ARTIFACT_EVIDENCE_LIMITS.imagePixels }).resize(1, 1).raw().toBuffer()
      result.metadata = { width: metadata.width, height: metadata.height, format: metadata.format, colorSpace: imageColorSpace(metadata), hasAlpha: metadata.hasAlpha }
      if (result.contentType === 'image/svg+xml') {
        setText(result, extractSvgText(fs.readFileSync(filePath, 'utf8')))
        result.metadata.pageCount = 1
        const raster = cachePath(outputDir, 'page-001.png')
        await sharp(filePath).resize({ width: ARTIFACT_EVIDENCE_LIMITS.renderLongestSide, height: ARTIFACT_EVIDENCE_LIMITS.renderLongestSide, fit: 'inside', withoutEnlargement: true }).png().toFile(raster)
        result.images.push({ filePath: raster, sha256: await fileSha(raster), page: 1 })
      } else {
        result.images.push({ filePath, sha256: result.sha256 })
        if ((metadata.pages ?? 1) > 1) limit(result, ['visual'], `Image contains ${metadata.pages} frames/pages; only its first image is represented`)
      }
    } else if (result.contentType === DOCX_CONTENT_TYPE) {
      await readDocx(result)
    } else if (result.contentType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      const deck = await readPptxDeckFromBuffer(fs.readFileSync(filePath))
      if (deck === null) throw new Error('PPTX does not contain readable slides')
      const rendered = await renderPptxToPdf(filePath, outputDir)
      if (rendered !== null) {
        // #3952：与 PDF 同等对待 —— 逐页画面 + 画面上真正显示的字（LibreOffice 导出不带演讲者备注）。
        // 文字层**不**算权威：整页贴图的幻灯片很常见（实测 OD 的 PPTX 11 页全是图），那种页抽不出字
        // 要按纯图 PDF 走逐页识别，不能读成「这页没有字」。
        await readPdf(result, outputDir, rendered)
        result.metadata.format = 'pptx'
        if (result.metadata.pageCount !== deck.pages) limit(result, ['visual'], `LibreOffice rendered ${result.metadata.pageCount} page(s) but the PPTX has ${deck.pages} slide(s)`)
      } else {
        result.metadata.pageCount = deck.pages
        setText(result, renderDeckText(deck), false)
        limit(result, ['text', 'visual'], 'PPTX text may include speaker notes; LibreOffice is not available on this machine (set BENCHMARK_SOFFICE_PATH), so no visual pages were rendered and displayed text and deck image reuse are not established')
      }
    } else if (result.contentType === 'text/html' || result.contentType === 'application/xhtml+xml') {
      await readHtml(result, outputDir)
    } else if (result.contentType.startsWith('text/') || result.contentType === 'application/json') {
      setText(result, fs.readFileSync(filePath, 'utf8'))
    } else {
      limit(result, ALL_CHANNELS, `Unsupported content type: ${result.contentType || '(empty)'}`)
    }
  } catch (error) {
    limit(result, ALL_CHANNELS, `Artifact evidence could not be fully read: ${errorText(error)}`)
  }
  fs.writeFileSync(manifest, `${JSON.stringify({ version: EVIDENCE_VERSION, evidence: result }, null, 2)}\n`, 'utf8')
  return result
}
