/**
 * 外部臂产物导入器（#3373）—— 让 OpenDesign / JarvisHub 走**同一条**冻结评估路径。
 *
 * ## 为什么是适配器，而不是让评估器多认一种输入
 *
 * `bench:evaluate` 是冻结件，它的边界已经切在正确的地方：只消费 G4 导出包
 * （`manifest.json` + `artifacts/`），不读画布、不读 Blueprint。为了适配外部输入去改它，
 * 等于改了给我们自己打分的那把尺子 —— 冻结就失效了，之前跑的所有读数不可比。
 * 所以适配层放在外面、产出同一份契约，冻结件一个字不动。
 *
 * ## 三条纪律
 *
 * 1. **不读对手的内部过程记录。** JarvisHub 的 `canvas-provenance.md` / `flows/*.json`、
 *    OpenDesign 的 `_meta.json` / `*.artifact.json` / `.file-versions/`（#3509）都不读
 *    —— 指南 §2.8。`runVerdict` 由
 *    操作者从对手自己的运行日志读出后经 `--verdict` 显式传入，并连同来源一起记进 manifest；
 *    判不出时记 `unclassified`，**不摊给被测系统**。
 * 2. **不可得字段一律 null / 空，不伪造。** `llm` / `continuations` / `toolCallHistogram` /
 *    `workflowFile` / `perturbation` / `mutations` / `turns` 全 null；`generationJobs` /
 *    `generationRequests` / `diagnostic.zones` 空。
 * 3. **`role` 归属规则写死在代码里，不允许 per-arm 调参。** 见 {@link ROLE_RULE_VERSION}。
 *
 * ## `role` 归属：同一件交付物的多种载体只计一次
 *
 * 一句话：**同一目录下、去掉序号与载体字段后缀后同名的文件，是同一件交付物的多种载体；
 * 组内取最可判的一份为 `primary`，其余记 `derived`。**
 *
 * - 判不出同源的组**全部记 `primary`**，并进 {@link ExternalImportProvenance.needsRoleReview}
 *   显式人工复核清单。宁可粗一点、但对三家一样粗 —— 粗糙是可申辩的，不对称不是。
 * - 组内代表件按**可判性**排序（位图 > 文本 > PDF > 矢量/容器），同档再比字节数。这一处刻意与
 *   issue 原文的「取字节最大的一份」不同：选一个冻结评估器读不出字的载体作代表，会把一件
 *   交出来的东西变成量不到的东西（同导出侧把缩略图标 `derived` 的理由 —— 低分辨率上 OCR
 *   读不出 hex 会凭空造出约束违规）。JarvisHub 实测两条规则给出同一结果（同页 png ≈ 2.3 MB
 *   vs svg ≈ 3 KB），所以这处偏离不是读数的来源。
 *
 * ## 已知盲区（必须随读数一起报，见 {@link ExternalImportProvenance.blindSpots}）
 *
 * 冻结评估器的文档通道只读 `text/*`，且 `minPages` 下限要求导出包给出**结构页数**。
 * 外部臂的多页汇报以 `.pptx` / 单文件 `.html` 交付，两者都给不出页数 —— 于是带 `minPages`
 * 的汇报槽在外部导入包上**结构性不可判**。这不是「他们没交汇报」，导入器因此把它列成显式
 * 盲区而不是让它读成 0。
 *
 * Usage:
 *   pnpm bench:import-external --source <外部产物目录> --arm jarvishub \
 *     --task bench-arch-04 --run-key jarvishub--case-04 \
 *     --verdict passed --verdict-source "_meta.json status=succeeded" \
 *     --out <export-dir>
 *
 * 退出码：`0` = 导入成功；`1` = 目录里一件可判载体都没有 / 参数非法。
 *
 * @module benchmarks/design-anything/tools/importExternalRun
 */

import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'

import { MANIFEST_VERSION, type ExportedFile, type FileRole, type RunExportManifest, type RunVerdict } from './exportRunArtifacts'
import {
  EXTERNAL_PROVENANCE_RULE_VERSION,
  extractRasterRefs,
  externalDeliveryTier,
  isHandAuthoredMarkup,
  needsProvenance,
  type SynthesizedCarrierOrigin,
} from './deliveryTier'
import { DECK_TEXT_VERSION, readPptxDeck, readSvgDeck, renderDeckText } from './readDeckText'
import { DECK_RENDER_VERSION, renderDeckPages } from './renderDeckPages'
import { VECTOR_RASTER_VERSION, rasterizeSvgFiles } from './rasterizeVector'
import { PAGE_SERIES_DIRS as DECK_PAGE_SERIES_DIRS, renderedDeckPagePath } from './evaluator/deckPages'
import { loadTaskSpec, type TaskSpec } from './evaluator/taskSpec'
import { benchmarkVersionForRun, exportRecordsOriginalFileName, type DesignAnythingBenchVersion } from '../../../src/lib/agent/eval/corpusPaths'
import { readRetiredTaskIds } from './assembleRunCorpus'
import { evaluationCorpusPaths, taskFilePath } from './corpusPaths'

/**
 * `role` 归属规则的版本。**改规则必须 bump**：跨版本的件数口径不可同图。
 * 记进 manifest 的 {@link ExternalImportProvenance}，让读表的人能核对这批读数用的哪一版。
 */
export const ROLE_RULE_VERSION = 'external-carrier-dedupe/v8'

/**
 * 题面素材的 sha256 集合 —— 命中即 `role: 'input'`，不计分（#3515）。
 *
 * 自家导出侧早有这条纪律（`exportRunArtifacts.ts`：「题目给的照片被 deck 引用不会让它
 * 变成这次的交付物」），判据是上传声明；外部臂没有上传声明，只能按**字节**认。
 *
 * **必须按字节，不能按路径。** `inputs/` 只是 OpenDesign 的目录约定：JarvisHub 的产物
 * 来自画布、根本没有这个目录，而 OD 自己也会把素材拷到别处 —— DA20 实测按路径只抓到
 * 242 件，按字节抓到 249 件，差的 7 件正是被拷出去的那些。
 */
export function loadTaskAssetHashes(assetsDir: string): ReadonlySet<string> {
  if (!fs.existsSync(assetsDir)) return new Set()
  const hashes = new Set<string>()
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    hashes.add(createHash('sha256').update(fs.readFileSync(path.join(assetsDir, entry.name))).digest('hex'))
  }
  return hashes
}

/**
 * 外部臂的**内部簿记目录** —— 与 `_meta.json` / `*.artifact.json` 同类，不属于交付面（#3509）。
 *
 * 白名单是按**扩展名**过滤的，管不住「交付载体的扩展名 + 簿记目录」这个组合：OpenDesign 在
 * `.file-versions/<hash>/0001-<uuid>.html` 下存每份产物的历史版本快照，扩展名是 `.html`，
 * 于是整目录的旧版本都被当成正式交付物导入。实测 `da-arch--r0` 69 件里有 19 件（28%）来自
 * 这里，且同一份 deck 被算两遍 —— 历史那份的资源引用已失效，17 页图全是坏的。
 *
 * **只按目录名精确匹配，不做「所有点开头目录」的一刀切**：`.hyperframes-cache/` 里放的是
 * 真实交付的渲染图（da-exhibit 的 `03-product-wall.png` 等，全批 7 个文件其中 4 个媒体），
 * 排掉它会丢真产物。宁可这张表长一点、每一项都有实证，也不要一条猜出来的通配规则。
 */
export const BOOKKEEPING_DIRS: ReadonlySet<string> = new Set(['.file-versions'])

/**
 * 参赛系统自己起的**工具进程运行时目录**，按内容标记识别，不按目录名（#3840）。
 *
 * Codex 参赛线的 `bench-da-architecture-base-b-n06` 用无头 Chrome/Edge 把 SVG 渲染成 PNG，
 * 每渲染一次在工作区留下一整个 Chromium 用户数据目录（`working/chrome1..8/`）：八个目录
 * 1536 个文件，其中 63 张浏览器扩展的图标 PNG、21 个扩展页面 HTML，扩展名全在白名单里，
 * 会被当成 `primary` 交付物收进来。目录名由参赛系统随意起，按名字列表挡不住，所以这里
 * 认的是 Chromium 自己的目录布局：根下有 `Local State` 文件、且 `Default/Preferences` 存在。
 * 两个标记同时命中才算，单独一个 `Default/` 目录不算 —— 交付件也可能叫这个名字。
 */
export function isChromiumUserDataDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'Local State')) && fs.existsSync(path.join(dir, 'Default', 'Preferences'))
}

/**
 * 参赛系统在工作区里装的**依赖包目录**，按目录名精确匹配（#3840）。
 *
 * Codex 参赛线的 `bench-da-infovis-base-a-n06` 与 `bench-da-ecom-base-a-n06` 各在工作区里
 * `npm install` 了一套依赖（sharp 等），`node_modules/` 下 516 / 1806 个文件，其中包自带的
 * README.md / LICENSE.md / *.txt / *.html 共 41 / 26 件扩展名在白名单里，会被当成 `primary`
 * 交付物收进来。`node_modules` 这个名字是 npm 写死的，不由参赛系统决定，所以按名字认是稳的；
 * 同批的 `.npm-cache/` 里没有任何白名单扩展名，不需要列。
 */
export const DEPENDENCY_DIRS: ReadonlySet<string> = new Set(['node_modules'])

/** 导入器自身的版本（合成 manifest 的形状）。 */
export const EXTERNAL_IMPORT_VERSION = 1

/**
 * 可判载体的扩展名白名单 → Content-Type。**白名单而非黑名单**：新出现的扩展名默认**不进**
 * 计分面，而不是默认进 —— 漏收一种载体是可发现的（件数偏低会被人质疑），
 * 错收对手的簿记文件（`_meta.json` / `*.artifact.json` / `flows/*.json`）则是读了它的
 * 内部过程记录，而那是指南 §2.8 明令禁止的事，且不会有任何人察觉。
 *
 * 刻意不含 `.json`：两家产物目录里出现的每一个 `.json` 都是簿记（判定、耗时、资产索引、
 * 逐轮画布快照），没有一个是交付物。
 */
export const CARRIER_CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'text/xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/** 白名单里的扩展名，供报错文案与测试引用。 */
export const CARRIER_EXTENSIONS: readonly string[] = Object.keys(CARRIER_CONTENT_TYPES)

/**
 * 组内代表件的**可判性**档位（大 = 更可判）。见模块头「role 归属」。
 *
 * 位图最高：分类与转写两条通道都读得到它。文本次之：文档通道读得到 —— **SVG 归在这一档**，
 * 理由见下。PDF 再次之（走 Content-Type 确定性归属）。容器最低：`.pptx` / `.docx`
 * 两条通道都不认。
 *
 * ## 为什么 SVG 必须按 `text/*` 报（v2 修正）
 *
 * v1 按文件类型的字面意思报成 `image/svg+xml`。冻结评估器用
 * `contentType.startsWith('image/')` 分流（`evaluate.ts:291`），于是 SVG 被喂进 VLM ——
 * 而 OpenAI 兼容的视觉端点根本不解 SVG。**它不是降级，是让整轮直接死**：
 * apimart 把上游拒绝包装成 503「Please wait and try again later」，`bench:evaluate`
 * 退出码 1，JarvisHub 三个包一个读数都出不来。实测：同一模型同一条路径，
 * 同目录的 `.png` 200、`.svg` 必败。
 *
 * SVG 本来就是 XML 文本，按 `text/xml` 报既符合事实，也让文档通道真的读得到它。
 *
 * 位图仍然排在 SVG 之前，所以「同组既有 png 又有 svg 时取 png」的行为不变。
 *
 * ## v4 的注释在这里下了个错结论，v5 更正（#3406）
 *
 * 上面这段原本还有一句「两臂口径一致」。**不成立。** 按 `text/xml` 报确实让两臂的矢量件
 * 走了同一条通道，但**身份一致性尺不在那条通道上** —— 它判的是
 * `contentType.startsWith('image/')`（`evaluator/identity.ts` 的 `isIdentityJudgeable`）。
 * 于是真实待遇是：
 *
 * - JarvisHub 的 `svg_artifacts/*.svg` 有 `pages/*.png` 孪生 → 位图当正件 → **判得上**
 * - OpenDesign 的 `assets/massing-*.svg` 没有孪生 → 只剩文本 → **一对都判不上**
 *
 * 「同一条通道」说的是分类，不是身份比对。修法见 {@link ./rasterizeVector}：
 * 给没有孪生的矢量件补一张栅格件，两臂这才真的同一个待遇。
 *
 * 这与 #3397 是同一类错误的第三次复发 —— 统一了一条通道，就以为整体对齐了。
 * **每次动载体口径，都要把 spec 里每一类判据重新问一遍「这条通道上三家是不是同一个标准」。**
 */
function readabilityRank(contentType: string): number {
  if (contentType.startsWith('image/')) return 4
  if (contentType.startsWith('text/')) return 3
  if (contentType === 'application/pdf') return 2
  return 0
}

/** 外部产物目录里的一个候选载体。 */
export interface ExternalCarrier {
  /** 相对 `--source` 的路径，用 `/` 分隔（跨平台稳定，进 manifest 的 `key`） */
  relPath: string
  bytes: number
  contentType: string
  /**
   * 这份载体的**结构页数**，只在量得到时才有（#3397）。
   *
   * 两个来源，都不是启发式：HTML deck 用浏览器打开后数它自己的翻页
   * （{@link ./renderDeckPages}）；`.pptx` 数 zip 里的 `ppt/slides/slideN.xml`
   * （{@link ./readDeckText}）。量不到就留 undefined —— 冻结评估器把「页数不可知」
   * 当作不满足任何 `minPages`，那是对的，不要靠猜去绕开它。
   */
  pages?: number
  /**
   * 这份载体是**导入器合成**出来的（#3444）。
   *
   * 渲染页与栅格件与它们的源文件不在同一个同源组里，组内规则看不见它们 —— 所以来源
   * 必须在**合成那一刻**记下，而不是在下游按文件名反推。
   */
  synthesized?: SynthesizedCarrierOrigin
  /**
   * 文件字节的 sha256。**每一份真实存在的字节都要有**：从磁盘收集的在读文件时算，
   * 合成件（渲染页 / 栅格件）在写盘那一刻算。
   *
   * 两处用它，都是「这两份字节是不是同一份」这一个问题的两个方向：认题面素材
   * （{@link loadTaskAssetHashes}）、认字节副本（{@link collapseByteDuplicateGroups}）。
   *
   * v7 的注释写着「合成件没有」并把它限定成只服务前一处。那让 #3561 的字节副本判据
   * 在代表件是合成件时失效 —— JarvisHub 的每张幻灯片正是这种形状（矢量源被栅格化成 png，
   * png 因更可判成为代表件）。补齐它比给判据加特例便宜。
   */
  sha256?: string
}

/** 一组「同一件交付物的多种载体」。 */
export interface CarrierGroup {
  /** 归一化后的同源键（见 {@link normalizeCarrierStem}） */
  key: string
  carriers: ExternalCarrier[]
  /** 代表件 —— 组内唯一的 `primary` */
  primary: ExternalCarrier
  /** 其余载体，记 `derived` */
  derived: ExternalCarrier[]
}

/**
 * 同源键：相对路径去掉「扩展名 → 载体字段后缀 → 文件名前导序号」。
 *
 * 三步都只碰**文件名的形状**，不碰内容、不碰任何对手的元数据：
 *
 * 1. 扩展名 —— 同一件的 png 与 svg 只差它。
 * 2. 载体字段后缀 `.<name>Url` —— 由 JSON 字段路径派生的导出名（`slides.0.imageUrl.png`
 *    与 `slides.0.svgUrl.svg`）。只认结尾是 `Url` 的那一段，故 `...assetHosting.so` 不被误剥。
 * 3. 前导序号 `^\d+[_-]` —— 导出时的枚举前缀（`000_`、`001_`），它在同一件的两个载体上
 *    必然不同。
 *
 * 目录部分原样保留：不同目录的同名文件不合并（`pages/x.png` 与 `svg_artifacts/x.svg`
 * 之间没有任何**语法**证据说它们同源，猜一个就等于按对手导出的丰富程度决定精度）。
 */
/**
 * 「逐页目录」—— 目录里一个文件就是一页，文件名前导数字是**页号**而非导出枚举序号。
 *
 * 取自实测布局：JarvisHub 的 `pages/`（逐页位图）与 `svg_artifacts/`（逐页矢量）。
 * 平铺导出目录不在此列，那里的 `NNN_` 是枚举。
 */
const PAGE_SERIES_DIRS: ReadonlySet<string> = new Set(DECK_PAGE_SERIES_DIRS)

export function normalizeCarrierStem(relPath: string): string {
  const dir = path.posix.dirname(relPath)
  const base = path.posix.basename(relPath)
  const ext = path.posix.extname(base)
  let stem = ext ? base.slice(0, -ext.length) : base
  stem = stem.replace(/\.[A-Za-z0-9]*Url$/, '')
  // 前导序号在**平铺导出目录**里是枚举噪声（`000_x.imageUrl.png` 与 `001_x.svgUrl.svg`
  // 是同一件的两个载体），但在**逐页目录**里它就是页号本身，剥掉会把不同页并成一件。
  // 实测 JarvisHub case-01 的 `svg_artifacts/01_潮汐滨水图书馆.svg` 与
  // `13_潮汐滨水图书馆.svg`（封面与封底同名）因此被并成一组，第 1 页凭空消失，
  // 继而让 {@link linkVectorPagesToBitmaps} 的页号集合对不上、整份 deck 拒绝配对。
  if (!PAGE_SERIES_DIRS.has(path.posix.basename(dir))) stem = stem.replace(/^\d+[_-]/, '')
  return dir === '.' ? stem : `${dir}/${stem}`
}

/**
 * 同一份 deck 的「逐页位图」与「逐页矢量原稿」在**两个平级目录**里，按页号配对。
 *
 * ## v1 的判断错了，这里更正
 *
 * v1 的注释写着「`pages/x.png` 与 `svg_artifacts/x.svg` 之间没有任何语法证据说它们同源」。
 * 实测数据推翻了它：JarvisHub 的两个目录**都带零填充页号**，而且页号集合逐个相等 ——
 *
 * ```
 * pages/ppt_archive_cloud_intro__01.png   ← 末尾数字组 = 01
 * svg_artifacts/01_城市记忆档案馆.svg      ← 开头数字组 = 01
 * 页号集合：pages {1..10} === svg_artifacts {1..10}
 * ```
 *
 * 这是纯粹的文件名形状证据，不需要读对手任何流程文件。
 *
 * ## 为什么必须配对（不配对的代价）
 *
 * 不配对时，同一页会被计成两件：一件位图走视觉通道、一件矢量走文档通道。
 * 同一页因此被判两次、口径还不同 —— 而另外两条臂的 deck 只被判一次（看图）。
 * 配对之后，deck 一律「一页一件、看图判」，三家同一个标准。
 *
 * ## 安全闸：**页号集合必须完全相等才合并**
 *
 * 只要有一侧多出或少掉一页，就说明这两个目录不是同一份 deck 的两种载体（例如只渲染了
 * 一部分页），此时**不合并**并记进 `needsRoleReview` 让人看。宁可件数偏高，不可把两页
 * 不同的东西合成一件。
 */
export function linkVectorPagesToBitmaps(
  groups: readonly CarrierGroup[],
): { groups: CarrierGroup[]; unmatchedDecks: string[] } {
  /** `<deck>/pages/...` 取末尾数字组；`<deck>/svg_artifacts/...` 取开头数字组。 */
  const locate = (relPath: string): { deck: string; channel: 'pages' | 'svg'; index: number } | null => {
    const dir = path.posix.dirname(relPath)
    const base = path.posix.basename(relPath)
    const m = /^(.*)\/(pages|svg_artifacts)$/.exec(dir)
    if (m === null) return null
    const digits = base.match(/\d+/g)
    if (digits === null || digits.length === 0) return null
    const channel = m[2] === 'pages' ? 'pages' : 'svg'
    const raw = channel === 'pages' ? digits[digits.length - 1] : digits[0]
    return { deck: m[1], channel, index: Number.parseInt(raw, 10) }
  }

  const byDeck = new Map<string, { pages: Map<number, CarrierGroup>; svg: Map<number, CarrierGroup> }>()
  for (const group of groups) {
    const at = locate(group.primary.relPath)
    if (at === null) continue
    let slot = byDeck.get(at.deck)
    if (slot === undefined) {
      slot = { pages: new Map(), svg: new Map() }
      byDeck.set(at.deck, slot)
    }
    slot[at.channel].set(at.index, group)
  }

  const absorbed = new Set<CarrierGroup>()
  const merged = new Map<CarrierGroup, CarrierGroup>()
  const unmatchedDecks: string[] = []
  for (const [deck, slot] of byDeck) {
    if (slot.pages.size === 0 || slot.svg.size === 0) continue
    const pageIdx = [...slot.pages.keys()].sort((a, b) => a - b)
    const svgIdx = [...slot.svg.keys()].sort((a, b) => a - b)
    const sameSet = pageIdx.length === svgIdx.length && pageIdx.every((v, i) => v === svgIdx[i])
    if (!sameSet) {
      unmatchedDecks.push(
        `${deck}: pages 页号 [${pageIdx.join(',')}] 与 svg_artifacts 页号 [${svgIdx.join(',')}] 不等，` +
          '不合并（同一页可能被计两件）',
      )
      continue
    }
    for (const index of pageIdx) {
      const bitmap = slot.pages.get(index)
      const vector = slot.svg.get(index)
      if (bitmap === undefined || vector === undefined) continue
      absorbed.add(vector)
      merged.set(bitmap, {
        ...bitmap,
        carriers: [...bitmap.carriers, ...vector.carriers],
        derived: [...bitmap.derived, vector.primary, ...vector.derived],
      })
    }
  }

  const next = groups
    .filter((g) => !absorbed.has(g))
    .map((g) => merged.get(g) ?? g)
  return { groups: next, unmatchedDecks }
}

/**
 * 把载体分组，并在每组里定出 `primary`。
 *
 * 单载体组（绝大多数）恒为 `primary`，没有任何判断发生 —— 这也是 OpenDesign 那一侧的
 * 全部情形（它的产物是一份 deck + 一层 `assets/`，不存在同件多载体）。
 */
export function groupCarriers(carriers: readonly ExternalCarrier[]): CarrierGroup[] {
  const buckets = new Map<string, ExternalCarrier[]>()
  for (const carrier of carriers) {
    const key = normalizeCarrierStem(carrier.relPath)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(carrier)
    else buckets.set(key, [carrier])
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, group]) => {
      const ranked = [...group].sort((a, b) => {
        const rank = readabilityRank(b.contentType) - readabilityRank(a.contentType)
        if (rank !== 0) return rank
        if (b.bytes !== a.bytes) return b.bytes - a.bytes
        return a.relPath < b.relPath ? -1 : 1
      })
      return { key, carriers: group, primary: ranked[0], derived: ranked.slice(1) }
    })
}

/**
 * 跨组字节归并（#3561）—— **同一份字节在一个 run 里只算一件交付物。**
 *
 * ## 为什么组内规则挡不住这一类重复
 *
 * {@link normalizeCarrierStem} 的同源键**带目录**，这是有意的：不同目录的同名文件之间没有
 * 任何**语法**证据说它们同源，按目录猜同源等于让精度随对手的导出布局浮动。
 *
 * 但本案里两份文件的**字节完全相同** —— 那不是语法证据，那是同源的直接证明。原规则挡住的是
 * 猜测，代价是把证明也一起挡在了门外。JarvisHub 每张幻灯片导出两次（平铺的
 * `NNN_<标题>_slides.N.svgUrl.svg` 与 `<deck>/svg_artifacts/NN_<标题>.svg`，两处逐字节相同），
 * 于是 2026-09-09 实测 `da20-v01` 的 40 个 run 里，2046 件 `primary` 有 984 件（48.1%）是别人的
 * 字节副本，被所有逐件尺子各数两遍。同一批数据上 GM 0 件、OpenDesign 14 件（1.3%）——
 * 这条偏差只打一家，方向是把它的交付量往上抬。
 *
 * ## 代表件为什么优先取逐页目录里的那一份
 *
 * 两种布局都被 `isDeckPageFile` 认得出（目录判据 + 平铺文件名判据），所以留哪一份都不会让
 * deck 页读数消失。区别在 {@link linkVectorPagesToBitmaps}：它按 `<deck>/pages` 与
 * `<deck>/svg_artifacts` 的**页号集合**配对位图与矢量，只认目录形态。留平铺那一份，等于把这份
 * deck 从那条配对规则的作用面里摘出去。
 *
 * 其余顺序沿用组内那一套（可判性 → 字节数 → 路径字典序）。字节副本的前两项必然相等，所以实际
 * 落在字典序上，是确定性的。
 *
 * ## 被取代的那一份不删
 *
 * 它降为 `derived`（评估器只对 `primary` 计分，见 `exportRunArtifacts.ts` 的 `role` 注释），
 * 文件照常留在包里。删了就无法复核「这份包压掉了什么」，而这批读数要进论文。
 */
export function collapseByteDuplicateGroups(
  groups: readonly CarrierGroup[],
): { groups: CarrierGroup[]; collapsed: string[] } {
  const inPageSeriesDir = (relPath: string): boolean =>
    PAGE_SERIES_DIRS.has(path.posix.basename(path.posix.dirname(relPath)))
  const rank = (group: CarrierGroup, other: CarrierGroup): number => {
    const pageDir = Number(inPageSeriesDir(other.primary.relPath)) - Number(inPageSeriesDir(group.primary.relPath))
    if (pageDir !== 0) return pageDir
    const readability = readabilityRank(other.primary.contentType) - readabilityRank(group.primary.contentType)
    if (readability !== 0) return readability
    if (other.primary.bytes !== group.primary.bytes) return other.primary.bytes - group.primary.bytes
    return group.primary.relPath < other.primary.relPath ? -1 : 1
  }

  const unhashed: CarrierGroup[] = []
  const byHash = new Map<string, CarrierGroup[]>()
  for (const group of groups) {
    const sha = group.primary.sha256
    // 代表件没有字节指纹时不参与归并 —— 没有证明就不合并，与本模块其余规则同一条纪律。
    if (sha === undefined) {
      unhashed.push(group)
      continue
    }
    const bucket = byHash.get(sha)
    if (bucket) bucket.push(group)
    else byHash.set(sha, [group])
  }

  const collapsed: string[] = []
  const kept: CarrierGroup[] = [...unhashed]
  for (const bucket of byHash.values()) {
    if (bucket.length === 1) {
      kept.push(bucket[0])
      continue
    }
    const [winner, ...losers] = [...bucket].sort(rank)
    kept.push({
      key: winner.key,
      carriers: [...winner.carriers, ...losers.flatMap((group) => group.carriers)],
      primary: winner.primary,
      derived: [...winner.derived, ...losers.flatMap((group) => [group.primary, ...group.derived])],
    })
    for (const loser of losers) {
      collapsed.push(`${loser.primary.relPath} ≡ ${winner.primary.relPath}（字节相同，只计一件）`)
    }
  }
  return {
    groups: kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    collapsed: collapsed.sort(),
  }
}

/**
 * 「没有位图孪生」的矢量件 —— 需要补一张栅格件才判得动身份的那些（#3406）。
 *
 * 判据只有一条，不猜：**这一组里有没有一个 `image/*`**。有就不碰
 * （JarvisHub 的 `svg_artifacts/*.svg` 已由 {@link linkVectorPagesToBitmaps} 与
 * `pages/*.png` 并成一组，位图早就是正件），没有才补。
 *
 * 必须先过一遍页系列合并再判，否则那一族每张 svg 单独成组、看起来都「没有孪生」，
 * 会给 JarvisHub 凭空多造出十张栅格件，把件数口径搞乱。
 */
export function orphanVectors(carriers: readonly ExternalCarrier[]): ExternalCarrier[] {
  const orphans: ExternalCarrier[] = []
  for (const group of linkVectorPagesToBitmaps(groupCarriers(carriers)).groups) {
    if (group.carriers.some((carrier) => carrier.contentType.startsWith('image/'))) continue
    for (const carrier of group.carriers) {
      if (carrier.relPath.toLowerCase().endsWith('.svg')) orphans.push(carrier)
    }
  }
  return orphans
}

/**
 * 疑似「同一件的多种载体」但**判不出同源**的清单 —— 显式人工复核，导入器绝不自动合并。
 *
 * 判据：同一目录下有 ≥3 个单载体组，且它们是同一种 Content-Type。这在实测里命中的正是
 * `pages/*.png`（逐页渲染）与 `svg_artifacts/*.svg`（矢量原稿）这两族 —— 语法上看不出它们
 * 与彼此、与顶层 `slides.N.*` 是同一份 deck，所以只报不并。
 */
export function suspectedCarrierFamilies(groups: readonly CarrierGroup[]): string[] {
  const byDir = new Map<string, Map<string, number>>()
  for (const group of groups) {
    if (group.carriers.length !== 1) continue
    const dir = path.posix.dirname(group.primary.relPath)
    const byType = byDir.get(dir) ?? new Map<string, number>()
    byType.set(group.primary.contentType, (byType.get(group.primary.contentType) ?? 0) + 1)
    byDir.set(dir, byType)
  }
  const suspects: string[] = []
  for (const [dir, byType] of [...byDir.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [contentType, count] of [...byType.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (count >= 3) {
        suspects.push(
          `${dir === '.' ? '<root>' : dir}: ${count} single-carrier ${contentType} files — possibly one `
          + 'multi-page deliverable rendered per page; NOT merged (no syntactic evidence of same source)',
        )
      }
    }
  }
  return suspects
}

/**
 * 冻结评估器在这份导入包上**结构性判不出**的槽 —— 与「没交付」是两件事，必须分开报。
 *
 * 只报一类，因为只有这一类被实测确认：带 `minPages` 的文档槽。评估器的文档通道只读
 * `text/*`，且页数下限要 `ExportedFile.pages`。
 *
 * ## v3 的判断错了，这里更正（#3397）
 *
 * v3 的注释写着「`.pptx` 和单文件 `.html` 都给不出结构页数，导入器**不猜**」，
 * 于是这两种 deck 一律记盲区。「不猜」是对的，但**当时把「量」也一并放弃了**：
 *
 * - HTML deck：导入器早就用浏览器把它渲染成逐页位图了，页数是**已经量到手的事实**。
 * - `.pptx`：页数就是 zip 里 `ppt/slides/slideN.xml` 的个数，是 OOXML 的容器结构。
 *
 * 两者都不是「在对手的标记语言上编启发式」。实测代价：JarvisHub 的真 10 页 PPT 与
 * OpenDesign 的真 16 页 HTML deck 双双被记成「没交」，而我们自己的 `deck.md` 带着
 * `pages = 12` 正常判入 —— 每一个跨臂**完成度**读数都因此系统性偏向我们。
 *
 * 现在两条路径都回填了 `pages`，这里只剩「确实量不到」的那种情况才报盲区。
 */
export function describeBlindSpots(spec: TaskSpec, files: readonly ExportedFile[]): string[] {
  const hasPagedText = files.some(
    (file) => file.role === 'primary' && file.contentType.startsWith('text/') && file.pages !== undefined,
  )
  if (hasPagedText) return []
  return spec.slots
    .filter((slot) => slot.minPages !== undefined)
    .map((slot) =>
      `slot "${slot.id}" requires >= ${slot.minPages} pages on a text/* carrier; this pack has none — `
      + 'the slot reads as uncovered for instrument reasons, NOT because no deck was delivered. '
      + 'See the per-file blind spots below for which carrier fell short and why')
}

/** 导入留档 —— 这份包是怎么来的、哪些判断是人做的、哪些量不到。 */
export interface ExternalImportProvenance {
  externalImportVersion: number
  /** 臂名（`jarvishub` / `opendesign`），只作标识，不参与任何判定 */
  arm: string
  /** 外部产物目录的绝对路径，原样记下 —— 读数可追回同一堆文件 */
  sourceDir: string
  importedAt: string
  roleRuleVersion: string
  /**
   * 交付方式档位规则的版本（#3444）。与 {@link roleRuleVersion} 并列而不是合并：
   * `role` 回答「计不计分」，交付方式回答「怎么来的」，两个正交问题各自可以单独改版。
   */
  provenanceRuleVersion: string
  /** `runVerdict` 是人从对手运行日志读出来的，来源原文记在这里 */
  verdictSource: string
  /**
   * 操作者给的题号已经退役时，他给的那个老题号（#3808）。
   *
   * 那 20 道题在 v0.6 里换了编号，外部臂手上的产物与台账仍按老编号存。归位是我们对这份产物
   * 做的一次改写，所以必须可核对：缺席 = 题号原样收下，在场 = 这份包是从哪个老编号归过来的。
   */
  renumberedFrom?: string
  /** 进了计分面的载体数 / 被 `role` 规则去重掉的载体数 / 扩展名不在白名单的文件数 */
  carrierCounts: { primary: number; derived: number; input: number; skipped: number }
  /** 扩展名不在白名单、因此没进包的文件（含对手的簿记文件），列出来让「没读它」可核对 */
  skippedFiles: string[]
  /** 判不出同源、全部记 primary 的组 —— 显式人工复核清单 */
  needsRoleReview: string[]
  /**
   * 被字节副本判据压掉的载体（#3561），每行 `<被取代的> ≡ <留下的>`。
   *
   * 报出来是为了让「这批导入压掉了多少份重复」成为包里自带的信息，而不是靠人事后逐字节去查。
   * v7 之前这个数是 0 而包里有 48% 的副本 —— 不是它报错了，是根本没人问过这个问题。
   */
  byteDuplicatesCollapsed: string[]
  /** 冻结评估器在这份包上结构性判不出的槽 */
  blindSpots: string[]
  /**
   * 被渲染成逐页位图的 HTML deck —— **这是我们对产物做的加工，必须可核对**。
   *
   * 三条臂的 deck 都要按「看页面」判：JarvisHub 自带 `pages/*.png`、我们自己渲染成图，
   * 只有 OpenDesign 交的是不带渲染的 HTML。不渲染它就等于同一件东西两种标准
   * （它被读源码、另两家被看图）。渲染 = 用浏览器打开看，不等于替它做。
   */
  renderedDecks: {
    /** 源 HTML 的相对路径 */
    source: string
    /** 命中的幻灯片选择器 */
    selector: string
    /** 渲染出的页数 */
    pages: number
    /** 渲染器版本 */
    renderer: string
    /** 加载期失败的资源 —— 非空即这次渲染的保真度存疑 */
    failedRequests: string[]
    /** 渲染后仍裂掉的 img */
    brokenImages: string[]
    /** 截不出来的页 —— 空 `pages` + 满 `failedPages` = 这份 deck 在浏览器里就是白纸 */
    failedPages: { page: number; reason: string }[]
  }[]
  /**
   * 被抽成逐页文本的 `.pptx` —— 同样是我们对产物做的加工，必须可核对（#3397）。
   *
   * `.pptx` 对冻结评估器是不透明二进制，不抽它，JarvisHub 交的真 PPT 就被记成没交。
   * 抽 = 打开这个文件，不等于替它写内容；抽出来的字仍过同一个分类器。
   */
  extractedDecks: {
    /** 源 pptx 的相对路径 */
    source: string
    /** 正文取自哪一种载体 */
    sourceKind: 'svg-page-series' | 'pptx'
    /** 抽出的文本载体的相对路径 —— 与源同目录同名，故自动归为同一件 */
    text: string
    /** 页数：矢量页个数，或 zip 里 `ppt/slides/slideN.xml` 的个数 */
    pages: number
    /** 抽取口径版本 */
    extractor: string
  }[]
  /**
   * 被栅格化的**无位图孪生**矢量件（#3406）—— 同样是我们对产物做的加工，必须可核对。
   *
   * 不栅格化的话，手写矢量的那条臂在身份一致性上一对都判不上
   * （身份尺只认 `image/*`），而这恰好打在 OpenDesign 最擅长的做法上。
   * 详见 {@link ./rasterizeVector} 模块头。
   */
  rasterizedVectors: {
    /** 源 SVG 的相对路径 */
    source: string
    /** 栅格件的相对路径 —— 与源同目录同名，故自动归为同一件、并因位图更可判而成为正件 */
    raster: string
    /** 实际出图像素 */
    width: number
    height: number
    /** 栅格化口径版本 */
    renderer: string
  }[]
  /**
   * 随包带上的页面依赖（#3956）：HTML 引用的本地样式表与字体，放在 `<run>/support/`（压平名），
   * 不进 `files[]`、不参与归槽。缺席 = 旧导入器，没带过。
   */
  supportFiles?: string[]
}

/** 导入器合成的导出包 manifest —— `RunExportManifest` 加一段导入留档。 */
export type ExternalRunExportManifest = RunExportManifest & {
  externalImport: ExternalImportProvenance
}

/** 递归收集目录下**扩展名在白名单里**的文件；其余原样记进 skipped。 */
export function collectCarriers(sourceDir: string): { carriers: ExternalCarrier[]; skipped: string[] } {
  const carriers: ExternalCarrier[] = []
  const skipped: string[] = []
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        // 簿记目录整棵跳过，但要留痕：读表的人能看见我们排除了什么（#3509）。
        if (BOOKKEEPING_DIRS.has(entry.name) || DEPENDENCY_DIRS.has(entry.name) || isChromiumUserDataDir(abs)) {
          skipped.push(`${rel}/**`)
          continue
        }
        walk(abs, rel)
        continue
      }
      if (!entry.isFile()) continue
      const contentType = CARRIER_CONTENT_TYPES[path.extname(entry.name).toLowerCase()]
      if (contentType === undefined) {
        skipped.push(rel)
        continue
      }
      const buf = fs.readFileSync(abs)
      carriers.push({
        relPath: rel,
        bytes: buf.byteLength,
        contentType,
        sha256: createHash('sha256').update(buf).digest('hex'),
      })
    }
  }
  walk(sourceDir, '')
  return { carriers, skipped }
}

/** `artifacts/` 下的文件名：相对路径压平。目录分隔符换成 `__`，避免同名撞车。 */
export function flattenArtifactName(relPath: string): string {
  return relPath.replace(/\//g, '__')
}

/**
 * 页面依赖（#3956）：HTML 显示所需、但本身不是交付件的文件。`.js` 不在内 —— 评估器关闭脚本执行。
 */
export const SUPPORT_EXTENSIONS: readonly string[] = ['.css', '.woff', '.woff2', '.ttf', '.otf']

/**
 * 改写一份 HTML / CSS 里的本地相对引用（#3952 / #3956）。**纯函数**。
 *
 * 引用先按 `fromRelPath` 解析成源目录内的相对路径，再问 `targetOf` 它在导出包里该写成什么；
 * 回 `undefined` 的原样保留。绝对 URL、`data:`、页内锚点、源目录之外的路径从不改写，
 * 断了就如实记断。
 *
 * 为什么要改写：导出包把 `dir/img.png` 压平成 `dir__img.png`，页面依赖另放进 `support/`。
 * 不改写，评估器从导出包打开这份 HTML 时图与样式全部失效 —— 那是我们导入适配器的 bug，
 * 不是被测系统的缺陷（审计里断图引用的 81% 由压平造成）。
 */
export function rewriteLocalRefs(text: string, fromRelPath: string, targetOf: (relPath: string) => string | undefined): string {
  const base = path.posix.dirname(fromRelPath)
  const rewrite = (ref: string): string => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(ref)) return ref
    const [, target = '', suffix = ''] = /^([^?#]*)(.*)$/s.exec(ref) ?? []
    let decoded: string
    try { decoded = decodeURIComponent(target) } catch { return ref }
    const resolved = path.posix.normalize(path.posix.join(base, decoded))
    if (resolved.startsWith('../') || resolved === '..') return ref
    const mapped = targetOf(resolved)
    return mapped === undefined ? ref : `${encodeURI(mapped)}${suffix}`
  }
  return text
    .replace(/(\s(?:src|href|poster|xlink:href)\s*=\s*)(["'])([^"']*)\2/gi, (_, lead: string, quote: string, ref: string) => `${lead}${quote}${rewrite(ref)}${quote}`)
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_, quote: string, ref: string) => `url(${quote}${rewrite(ref.trim())}${quote})`)
    .replace(/(@import\s+)(["'])([^"']+)\2/gi, (_, lead: string, quote: string, ref: string) => `${lead}${quote}${rewrite(ref)}${quote}`)
}

/**
 * 从 HTML 载体出发，收集它们（以及它们引用的 `.css`）用到的页面依赖（#3956）。
 * 只收源目录内真实存在、扩展名在 {@link SUPPORT_EXTENSIONS} 里、且本身不是载体的文件。
 * 与 {@link rewriteLocalRefs} 共用同一套引用解析，两处不会对「引用指向哪」给出不同答案。
 */
export function collectSupportFiles(sourceDir: string, htmlRelPaths: readonly string[], carrierRelPaths: ReadonlySet<string>): string[] {
  const found = new Set<string>()
  const queue = [...htmlRelPaths]
  while (queue.length > 0) {
    const from = queue.shift()!
    let text: string
    try { text = fs.readFileSync(path.join(sourceDir, from), 'utf-8') } catch { continue }
    rewriteLocalRefs(text, from, (relPath) => {
      if (found.has(relPath) || carrierRelPaths.has(relPath)) return undefined
      if (!SUPPORT_EXTENSIONS.includes(path.posix.extname(relPath).toLowerCase())) return undefined
      if (!fs.statSync(path.join(sourceDir, relPath), { throwIfNoEntry: false })?.isFile()) return undefined
      found.add(relPath)
      if (relPath.toLowerCase().endsWith('.css')) queue.push(relPath)
      return undefined
    })
  }
  return [...found].sort()
}

/**
 * 合成一份合法的 G4 导出包 manifest。**纯函数**（不碰文件系统），故 role 规则可单测。
 */
export function buildExternalManifest(input: {
  arm: string
  taskId: string
  benchmarkVersion?: DesignAnythingBenchVersion
  runKey: string
  sourceDir: string
  spec: TaskSpec
  carriers: readonly ExternalCarrier[]
  skipped: readonly string[]
  runVerdict: RunVerdict
  verdictSource: string
  importedAt: string
  renderedDecks?: ExternalImportProvenance['renderedDecks']
  extractedDecks?: ExternalImportProvenance['extractedDecks']
  rasterizedVectors?: ExternalImportProvenance['rasterizedVectors']
  supportFiles?: readonly string[]
  /**
   * 包里每份手写源标记引用到的位图，按源目录相对路径索引（#3444 v2）。
   *
   * 读文件的是 {@link main}，判档位的是 `externalDeliveryTier` —— 本函数仍然是纯函数，
   * 只把这张表转交下去。缺省空表时每份源标记都读成「没引用位图」，即全部判 `authored`。
   */
  markupRasterRefs?: ReadonlyMap<string, readonly string[]>
  /** 导入过程中实测到的盲区（如整页纯图的 pptx），与 spec 派生的那批并列 */
  extraBlindSpots?: readonly string[]
  /** 题面素材的 sha256（{@link loadTaskAssetHashes}）。命中的载体判 `role: 'input'`。 */
  taskAssetHashes?: ReadonlySet<string>
  /** 操作者给的老题号（已退役）；`taskId` 是归位后的那个。见 {@link ExternalImportProvenance.renumberedFrom}。 */
  renumberedFrom?: string
}): ExternalRunExportManifest {
  const benchmarkVersion = benchmarkVersionForRun({ scenarioId: input.taskId, benchmarkVersion: input.benchmarkVersion })
  // #3515：题面素材在**分组之前**剔出去。留在组里它可能被选成代表件 —— 那会让
  // 「我们给的照片」变成某个交付槽的正件，逐字约束与身份锚跟着指向它。
  const assetHashes = input.taskAssetHashes ?? new Set<string>()
  const isTaskAsset = (carrier: ExternalCarrier): boolean =>
    carrier.sha256 !== undefined && assetHashes.has(carrier.sha256)
  const inputCarriers = input.carriers.filter(isTaskAsset)
  const linked = linkVectorPagesToBitmaps(groupCarriers(input.carriers.filter((c) => !isTaskAsset(c))))
  // #3561：同一份字节只算一件交付物。放在页系列配对**之后** —— 先按目录把同一份 deck 的位图页与
  // 矢量页并好，再问「这两个组是不是同一份字节」，否则会先按字节把两个 deck 目录并掉、页号配对
  // 随之失去作用面。
  const collapsedGroups = collapseByteDuplicateGroups(linked.groups)
  const groups = collapsedGroups.groups
  const files: ExportedFile[] = []
  const toExported = (carrier: ExternalCarrier, role: FileRole, group: CarrierGroup): ExportedFile => ({
    // 外部件没有对象存储身份，但仍需要一个在这一轮内稳定、可 diff 两次导入的名字
    // （同 inline 件的 `inline:<nodeId>:<portId>` 约定）。
    key: `external:${input.arm}/${carrier.relPath}`,
    source: 'blob',
    file: flattenArtifactName(carrier.relPath),
    ...(exportRecordsOriginalFileName(benchmarkVersion) && carrier.synthesized === undefined
      ? { originalFileName: path.posix.basename(carrier.relPath.replace(/\\/g, '/')) }
      : {}),
    bytes: carrier.bytes,
    contentType: carrier.contentType,
    // 外部臂没有画布节点 —— 如实记空，不造一个假 nodeId。
    sourceNodes: [],
    role,
    artifactRefs: [],
    ...(carrier.pages === undefined ? {} : { pages: carrier.pages }),
    // #3444 交付方式：只用句法证据，不读对手任何流程文件。合成件的来源在合成那一刻
    // 已经记下（`carrier.synthesized`），其余件看同源组里有没有手写源文件。
    ...(needsProvenance({ contentType: carrier.contentType, relPath: carrier.relPath })
      ? {
        provenance: externalDeliveryTier({
          relPath: carrier.relPath,
          contentType: carrier.contentType,
          groupCarrierPaths: group.carriers.map((item) => item.relPath),
          markupRasterRefs: input.markupRasterRefs ?? new Map(),
          ...(carrier.synthesized === undefined ? {} : { synthesized: carrier.synthesized }),
        }),
      }
      : {}),
  })
  for (const group of groups) {
    files.push(toExported(group.primary, 'primary', group))
    for (const carrier of group.derived) files.push(toExported(carrier, 'derived', group))
  }
  // 素材件仍然全部导出（导入侧要它才不裂图），只是不计分 —— 与自家导出侧同一处置。
  // 每件自成一组：它不与任何交付物同源，组内规则对它没有意义。
  for (const carrier of inputCarriers) {
    files.push(toExported(carrier, 'input', {
      key: carrier.relPath,
      carriers: [carrier],
      primary: carrier,
      derived: [],
    }))
  }

  const provenance: ExternalImportProvenance = {
    externalImportVersion: EXTERNAL_IMPORT_VERSION,
    arm: input.arm,
    sourceDir: input.sourceDir,
    importedAt: input.importedAt,
    roleRuleVersion: ROLE_RULE_VERSION,
    provenanceRuleVersion: EXTERNAL_PROVENANCE_RULE_VERSION,
    verdictSource: input.verdictSource,
    carrierCounts: {
      primary: files.filter((file) => file.role === 'primary').length,
      derived: files.filter((file) => file.role === 'derived').length,
      input: files.filter((file) => file.role === 'input').length,
      skipped: input.skipped.length,
    },
    skippedFiles: [...input.skipped],
    needsRoleReview: [...suspectedCarrierFamilies(groups), ...linked.unmatchedDecks],
    byteDuplicatesCollapsed: collapsedGroups.collapsed,
    blindSpots: [...describeBlindSpots(input.spec, files), ...(input.extraBlindSpots ?? [])],
    renderedDecks: input.renderedDecks ?? [],
    extractedDecks: input.extractedDecks ?? [],
    rasterizedVectors: input.rasterizedVectors ?? [],
    supportFiles: [...(input.supportFiles ?? [])],
    ...(input.renumberedFrom === undefined ? {} : { renumberedFrom: input.renumberedFrom }),
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    exportedAt: input.importedAt,
    scenarioId: input.taskId,
    benchTaskId: input.taskId,
    ...(benchmarkVersion ? { benchmarkVersion } : {}),
    runKey: input.runKey,
    // 外部臂没有我们的 session / workflow 身份。
    sessionId: null,
    workflowId: null,
    files,
    missingKeys: [],
    // 不可得字段一律空 / null，不伪造：`[]` 在评估器里读作「零生成请求」，
    // 而外部臂的生成记账在它自己的库里，我们既拿不到也不该猜。
    generationJobs: [],
    // #3490：外部臂没有我们的画布，也没有 MediaGenerationJob —— 两侧读数恒为空，
    // 这不是「没记」而是「这个臂上不存在这件事」。
    generationRequests: [],
    llm: null,
    finalMessage: null,
    toolCallHistogram: null,
    continuations: null,
    // 外部臂没有我们的义务面，复核声明按构造为空（#3415）。
    evidenceReviews: null,
    turns: null,
    workflowFile: null,
    perturbation: null,
    mutations: null,
    runVerdict: input.runVerdict,
    diagnostic: { zones: [], nodeZoneIds: {} },
    externalImport: provenance,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * 允许的 `--verdict` 值 —— 与 `classifyScenarioRun` 的终态词汇同源。
 * `unclassified` 是**显式的判不出**：既有归因纪律要求归不掉必须显式说，不摊给被测系统。
 */
export const EXTERNAL_VERDICTS = [
  'passed',
  'product_failed',
  'infra_failed',
  'measurement_incomplete',
  'unclassified',
] as const

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function requireArg(flag: string): string {
  const value = getArg(flag)
  if (value === undefined || value === '') throw new Error(`Missing required ${flag}`)
  return value
}

/**
 * 操作者给的 `--task` 落在哪个题号上（#3808）。
 *
 * v0.6 里有 20 道题换了编号，而外部臂手上的产物与台账仍按老编号存。照旧收下那个编号，
 * 归到它今天的题号，并把他给的那个记进 {@link ExternalImportProvenance.renumberedFrom} ——
 * 归位是我们对这份产物做的一次改写，必须可核对。
 *
 * **只在 v0.6 上改写。** 那 20 个老编号在 v0.1–v0.5 是真实存在的**另一批题**（da20 那一批），
 * 无条件改写等于把一份历史产物悄悄挂到另一道题上，而读表的人分不出来。
 *
 * 解析必须发生在读题面之前：题面路径是按题号找的，不先归位就会停在
 * 「No task spec at …」—— 所以这一步不是装饰，是导入走得下去的前提。
 */
export function resolveImportTaskId(
  requested: string,
  benchmarkVersion: DesignAnythingBenchVersion | undefined,
  repositoryRoot: string,
): { taskId: string; renumberedFrom?: string } {
  if (benchmarkVersion !== 'v0.6') return { taskId: requested }
  const current = readRetiredTaskIds(repositoryRoot).get(requested)
  return current === undefined ? { taskId: requested } : { taskId: current, renumberedFrom: requested }
}

async function main(): Promise<void> {
  const sourceDir = path.resolve(requireArg('--source'))
  const arm = requireArg('--arm')
  const requestedTaskId = requireArg('--task')
  // 外部跑的题库版本由操作者显式提供；环境变量不能改写历史来源。
  const benchmarkVersion = benchmarkVersionForRun({ scenarioId: requestedTaskId, benchmarkVersion: getArg('--benchmark-version') })
  const { taskId, renumberedFrom } = resolveImportTaskId(requestedTaskId, benchmarkVersion, process.cwd())
  if (renumberedFrom !== undefined) console.log(`--task ${renumberedFrom} was retired in v0.6; importing it as ${taskId}`)
  const runKey = getArg('--run-key') ?? `${arm}--${path.basename(sourceDir)}`
  const outRoot = path.resolve(requireArg('--out'))
  const tasksDir = getArg('--tasks')
  const verdictArg = getArg('--verdict') ?? 'unclassified'
  if (!(EXTERNAL_VERDICTS as readonly string[]).includes(verdictArg)) {
    throw new Error(`--verdict must be one of ${EXTERNAL_VERDICTS.join(' | ')}, got "${verdictArg}"`)
  }
  // 归因纪律：`unclassified` 必须显式，且不得伪装成 passed。errorClass 只有 passed 时为 null。
  const errorClass = getArg('--error-class') ?? (verdictArg === 'passed' ? null : verdictArg)
  const verdictSource = getArg('--verdict-source')
    ?? "not provided — the operator did not cite the arm's own run log"

  const specFile = taskFilePath(taskId, tasksDir, benchmarkVersion)
  if (!fs.existsSync(specFile)) throw new Error(`No task spec at ${specFile} for --task "${taskId}"`)
  const spec = loadTaskSpec(specFile)

  const { carriers, skipped } = collectCarriers(sourceDir)
  if (carriers.length === 0) {
    throw new Error(
      `${sourceDir}: no scorable carrier files (allowed extensions: ${CARRIER_EXTENSIONS.join(' ')}). `
      + 'Refusing to write an empty pack — it would read as "the system delivered nothing".',
    )
  }

  // #3444 v2：先把每份手写源标记引用到的位图读出来。判档位的规则在 `deliveryTier.ts`，
  // 这里只负责读文件 —— 那个模块必须保持无 I/O 才能单测。
  // 读不动的文件（编码坏了 / 已被删）记成「没引用位图」：那会让它判 `authored`，
  // 是这一列里更保守的一档（见 `CONSERVATISM` 的方向说明）。
  const markupRasterRefs = new Map<string, readonly string[]>()
  for (const carrier of carriers) {
    if (!isHandAuthoredMarkup(carrier.relPath)) continue
    try {
      markupRasterRefs.set(carrier.relPath, extractRasterRefs(fs.readFileSync(path.join(sourceDir, carrier.relPath), 'utf-8')))
    } catch {
      markupRasterRefs.set(carrier.relPath, [])
    }
  }

  const runDir = path.join(outRoot, runKey)
  const artifactsDir = path.join(runDir, 'artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  // #3952 / #3956：页面依赖按我们自家导出器的契约放 —— `<run>/support/`，页面用 `../support/<file>` 引用，
  // 不进 manifest 的 `files[]`（见 `exportRunArtifacts.ts` 的 support 目录与 `stageSlideFonts`）。
  const carrierRelPaths = new Set(carriers.map((c) => c.relPath))
  const htmlRelPaths = carriers.filter((c) => c.contentType === 'text/html').map((c) => c.relPath)
  const supportFiles = collectSupportFiles(sourceDir, htmlRelPaths, carrierRelPaths)
  const supportSet = new Set(supportFiles)
  const supportDir = path.join(runDir, 'support')
  for (const relPath of supportFiles) {
    fs.mkdirSync(supportDir, { recursive: true })
    const from = path.join(sourceDir, relPath)
    const to = path.join(supportDir, flattenArtifactName(relPath))
    if (!relPath.toLowerCase().endsWith('.css')) {
      fs.copyFileSync(from, to)
      continue
    }
    fs.writeFileSync(to, rewriteLocalRefs(fs.readFileSync(from, 'utf-8'), relPath, (target) =>
      supportSet.has(target) ? flattenArtifactName(target)
        : carrierRelPaths.has(target) ? `../artifacts/${flattenArtifactName(target)}` : undefined), 'utf-8')
  }
  for (const carrier of carriers) {
    const from = path.join(sourceDir, carrier.relPath)
    const to = path.join(artifactsDir, flattenArtifactName(carrier.relPath))
    if (carrier.contentType !== 'text/html') {
      fs.copyFileSync(from, to)
      continue
    }
    // `sha256` 仍是源文件的，它用于同源分组与去重，说的是「交了哪份」；`bytes` 跟写进包里的那份走。
    const html = rewriteLocalRefs(fs.readFileSync(from, 'utf-8'), carrier.relPath, (target) =>
      carrierRelPaths.has(target) ? flattenArtifactName(target)
        : supportSet.has(target) ? `../support/${flattenArtifactName(target)}` : undefined)
    fs.writeFileSync(to, html, 'utf-8')
    carrier.bytes = Buffer.byteLength(html)
  }

  // 幻灯片结构的 HTML → 逐页位图，让三条臂的 deck 按同一个标准（看页面）被判。
  // 必须从**源目录**渲染：导出包已拍平改名，HTML 里的相对图片引用会全部失效。
  const renderedDecks: ExternalImportProvenance['renderedDecks'] = []
  const renderedCarriers: ExternalCarrier[] = []
  // relPath → 这份 deck 的结构页数。回填到载体上，minPages 槽才判得动（#3397）。
  const deckPageCounts = new Map<string, number>()
  if (!process.argv.includes('--no-render-decks')) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-render-'))
    try {
      for (const carrier of carriers.filter((c) => c.contentType === 'text/html')) {
        const stem = flattenArtifactName(carrier.relPath).replace(/\.html$/i, '')
        const deck = await renderDeckPages({
          htmlPath: path.join(sourceDir, carrier.relPath),
          outDir: scratch,
          stem,
        })
        if (deck === null) continue
        for (const [i, absPage] of deck.pages.entries()) {
          const relPath = renderedDeckPagePath(stem, i + 1)
          const dest = path.join(artifactsDir, flattenArtifactName(relPath))
          fs.copyFileSync(absPage, dest)
          renderedCarriers.push({
            relPath,
            bytes: fs.statSync(dest).size,
            contentType: 'image/png',
            sha256: createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),
            // 这一页是我们用浏览器渲染对手手写的 HTML 得到的 —— 来源在此刻已知（#3444）。
            // `rasterRefs` 是**这一页**引用到的位图，由渲染器在浏览器里逐页量出来：
            // 手写版式里嵌一张生成图，与整页手画，不是一回事。
            synthesized: {
              kind: 'rendered-deck',
              from: carrier.relPath,
              rasterRefs: deck.rasterRefsByPage[absPage] ?? [],
            },
          })
        }
        // 结构页数 = 截出来的 + 截不出来的。零面积那几页在浏览器里也是页，
        // 只是那份产物自己渲染坏了（实测 OpenDesign case-34：12 页全白）。
        // 记 0 页会把「deck 有 12 页但画不出来」谎报成「deck 只有 0 页」。
        deckPageCounts.set(carrier.relPath, deck.pages.length + deck.failedPages.length)
        renderedDecks.push({
          source: carrier.relPath,
          selector: deck.selector,
          pages: deck.pages.length,
          renderer: DECK_RENDER_VERSION,
          failedRequests: deck.failedRequests,
          brokenImages: deck.brokenImages,
          failedPages: deck.failedPages,
        })
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  // 没有位图孪生的矢量件 → 栅格件。写成与源**同目录同名**的 `.png`，于是它自动与那份
  // SVG 归为同一件，并因位图更可判（`readabilityRank`：image 4 > text 3）成为正件 ——
  // 与 JarvisHub 的 `pages/*.png` 压住 `svg_artifacts/*.svg` 完全同一个形状。
  // 不这么做的话，手写矢量的那条臂在身份一致性上一对都判不上（#3406）。
  const rasterizedVectors: ExternalImportProvenance['rasterizedVectors'] = []
  const rasterCarriers: ExternalCarrier[] = []
  /** 画不出来的矢量件 —— 记盲区，不造空壳 */
  const unrasterizable: string[] = []
  if (!process.argv.includes('--no-raster-vectors')) {
    const existing = new Set(carriers.map((c) => c.relPath))
    const targets = orphanVectors(carriers)
      .map((c) => ({ relPath: c.relPath, absPath: path.join(sourceDir, c.relPath) }))
      // 源目录里已经有同名 .png 时不动它 —— 那是对手自己交的位图，是更好的证据。
      // （能走到这里说明它没跟这份 svg 归成一组，属于反常，宁可跳过也不覆盖。）
      .filter((t) => !existing.has(t.relPath.replace(/\.svg$/i, '.png')))
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'svg-raster-'))
    try {
      const { rendered, failed } = await rasterizeSvgFiles({
        svgs: targets,
        outDir: scratch,
        nameOf: (relPath) => flattenArtifactName(relPath.replace(/\.svg$/i, '.png')),
      })
      for (const raster of rendered) {
        const relPath = raster.source.replace(/\.svg$/i, '.png')
        const dest = path.join(artifactsDir, flattenArtifactName(relPath))
        fs.copyFileSync(raster.file, dest)
        rasterCarriers.push({
          relPath,
          bytes: fs.statSync(dest).size,
          contentType: 'image/png',
          sha256: createHash('sha256').update(fs.readFileSync(dest)).digest('hex'),
          // 栅格件的源是对手手画的矢量图 —— 来源在此刻已知（#3444）
          synthesized: {
            kind: 'rasterized-vector',
            from: raster.source,
            rasterRefs: markupRasterRefs.get(raster.source) ?? [],
          },
        })
        rasterizedVectors.push({
          source: raster.source,
          raster: relPath,
          width: raster.width,
          height: raster.height,
          renderer: VECTOR_RASTER_VERSION,
        })
      }
      for (const failure of failed) {
        unrasterizable.push(
          `${failure.source}: ${failure.reason} —— 身份尺只认位图，这件矢量产物因此判不上，`
          + '记 unjudgeable 而不是 fail',
        )
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  }

  // deck → 逐页文本。写成与源**同目录同名**的 `.txt`，于是它自动与该 deck 的其它载体
  // 归为同一件，并因更可判（`readabilityRank`：text 3 > 容器 0）成为 primary ——
  // 复用既有的同源合并规则，不为它另开一条路径。
  //
  // **正文优先取逐页 SVG，其次才是 `.pptx`**，理由见 {@link ./readDeckText} 模块头：
  // 那份 pptx 常常是导出侧重新组装的（满幅图 + 文字进备注），而 `svg_artifacts/` 里的
  // 矢量页是对手画布上的真页面，`<text>` 就是页面上看得见的字。
  const extractedDecks: ExternalImportProvenance['extractedDecks'] = []
  const extractedCarriers: ExternalCarrier[] = []
  /** 抽不出一个字的 deck —— 记盲区，不造空壳载体 */
  const emptyDecks: string[] = []
  const takenPaths = new Set(carriers.map((c) => c.relPath))
  const pptxOf = (dir: string) => carriers.find(
    (c) => path.posix.dirname(c.relPath) === dir && c.relPath.toLowerCase().endsWith('.pptx'))
  const svgPagesOf = (dir: string) => carriers
    .filter((c) => path.posix.dirname(c.relPath) === `${dir}/svg_artifacts`
      && c.relPath.toLowerCase().endsWith('.svg'))
    .map((c) => ({ index: Number(/(\d+)/.exec(path.posix.basename(c.relPath))?.[1] ?? NaN), relPath: c.relPath }))
    .filter((e) => Number.isFinite(e.index))
    .sort((a, b) => a.index - b.index)

  const deckDirs = new Set<string>()
  for (const c of carriers) {
    const dir = path.posix.dirname(c.relPath)
    if (path.posix.basename(dir) === 'svg_artifacts') deckDirs.add(path.posix.dirname(dir))
    else if (c.relPath.toLowerCase().endsWith('.pptx')) deckDirs.add(dir)
  }

  for (const deckDir of [...deckDirs].sort()) {
    const svgs = svgPagesOf(deckDir)
    const pptx = pptxOf(deckDir)
    let deck = svgs.length > 0
      ? readSvgDeck(svgs.map((e) => fs.readFileSync(path.join(sourceDir, e.relPath), 'utf-8')))
      : null
    let source = `${deckDir}/svg_artifacts`
    let sourceKind: 'svg-page-series' | 'pptx' = 'svg-page-series'
    if (deck === null && pptx !== undefined) {
      deck = await readPptxDeck(path.join(sourceDir, pptx.relPath))
      source = pptx.relPath
      sourceKind = 'pptx'
    }
    // 一个字都抽不出来时**不造**那份只有页码的空文本 —— 它是个空壳，占着 primary 名额，
    // 还可能凭 `pages` 满足 minPages 而让一个没有内容的槽显示为已覆盖。如实记盲区。
    if (deck === null || !deck.slides.some((text) => text !== '')) {
      emptyDecks.push(
        `${deckDir}: no text could be read from this deck (${svgs.length} vector page(s), `
        + `${pptx === undefined ? 'no' : 'a'} .pptx) — the document channel cannot see it; `
        + 'its page bitmaps are scored on the image channel instead. The document slot reads as '
        + 'uncovered for instrument reasons, NOT because no deck was delivered')
      continue
    }
    const stem = pptx === undefined
      ? path.posix.basename(deckDir)
      : path.posix.basename(pptx.relPath).slice(0, -'.pptx'.length)
    const relPath = deckDir === '.' ? `${stem}.txt` : `${deckDir}/${stem}.txt`
    // 源目录里本来就有同名 .txt 时不动它 —— 对手自己交的文本是更好的证据。
    if (takenPaths.has(relPath)) continue
    const dest = path.join(artifactsDir, flattenArtifactName(relPath))
    fs.writeFileSync(dest, renderDeckText(deck), 'utf-8')
    extractedCarriers.push({ relPath, bytes: fs.statSync(dest).size, contentType: 'text/plain', pages: deck.pages })
    extractedDecks.push({ source, sourceKind, text: relPath, pages: deck.pages, extractor: DECK_TEXT_VERSION })
  }

  const manifest = buildExternalManifest({
    benchmarkVersion,
    arm,
    taskId,
    ...(renumberedFrom === undefined ? {} : { renumberedFrom }),
    runKey,
    sourceDir,
    spec,
    carriers: [
      ...carriers.map((c) => {
        const pages = deckPageCounts.get(c.relPath)
        return pages === undefined ? c : { ...c, pages }
      }),
      ...renderedCarriers,
      ...rasterCarriers,
      ...extractedCarriers,
    ],
    skipped,
    runVerdict: { verdict: verdictArg, errorClass, detail: verdictSource },
    verdictSource,
    importedAt: new Date().toISOString(),
    renderedDecks,
    extractedDecks,
    rasterizedVectors,
    supportFiles,
    markupRasterRefs,
    extraBlindSpots: [...emptyDecks, ...unrasterizable],
    // #3515 题面素材按字节认。素材目录由 run 的语料版本固定（`evaluationCorpusPaths`
    // 的既有纪律：素材锚不能被当前环境重定向），显式 --tasks 不改变它。
    taskAssetHashes: loadTaskAssetHashes(
      evaluationCorpusPaths({ scenarioId: taskId, benchmarkVersion }).assetsDir,
    ),
  })
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  const counts = manifest.externalImport.carrierCounts
  console.log(
    `${runKey}: ${counts.primary} primary, ${counts.derived} derived, `
    + `${counts.input} input, ${counts.skipped} skipped → ${runDir}`,
  )
  for (const line of manifest.externalImport.byteDuplicatesCollapsed) console.log(`  = byte dup: ${line}`)
  for (const line of manifest.externalImport.needsRoleReview) console.log(`  ! role review: ${line}`)
  for (const line of manifest.externalImport.blindSpots) console.log(`  ! blind spot: ${line}`)
  for (const d of manifest.externalImport.renderedDecks) {
    const warn = d.failedRequests.length > 0 || d.brokenImages.length > 0 || d.failedPages.length > 0
      ? `  ⚠ ${d.failedRequests.length} failed request(s), ${d.brokenImages.length} broken img,`
        + ` ${d.failedPages.length} page(s) unrenderable`
      : ''
    console.log(`  rendered deck: ${d.source} → ${d.pages} page(s) via ${d.selector}${warn}`)
  }
  if (manifest.externalImport.rasterizedVectors.length > 0) {
    const v = manifest.externalImport.rasterizedVectors
    console.log(`  rasterized ${v.length} orphan vector(s) via ${VECTOR_RASTER_VERSION}: `
      + v.map((r) => `${r.source} → ${r.width}×${r.height}`).join(', '))
  }
  for (const d of manifest.externalImport.extractedDecks) {
    console.log(`  extracted deck text: ${d.source} [${d.sourceKind}] → ${d.text} (${d.pages} page(s), ${d.extractor})`)
  }
}

// 入口守卫：tsx / 原生 ESM / esbuild cjs bundle 三种运行方式都判得出来（#3285 棘轮形状，
// 见 scripts/audit-storage-ledger-2140.ts）。只看 import.meta.url 在 cjs bundle 下恒假。
const isScriptEntrypoint = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module
  : import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isScriptEntrypoint) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
