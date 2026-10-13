/** 公开输入和交付原件的统一入口；路径和版本先核实，再交给判定器。 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { designAnythingCorpusPaths, type DesignAnythingBenchVersion } from '../../../../src/lib/agent/eval/corpusPaths'
import { assertManifestAssetBytes, expandAsset, type Manifest, type ManifestAsset } from '../assets/manifestExpand'
import type { TaskSpec } from './taskSpec'
import { prepareArtifactEvidence, type ArtifactEvidence } from './artifactEvidence'
import type { PublicRequirementInput } from './requirementChecks'
import { askInlineTextEvaluator, askSetVlm, VlmUnreadableError } from './vlm'
import { renderClassifyScoresPrompt, TRANSCRIBE_PROMPT_TEMPLATE, TRANSCRIBE_PROMPT_SHA } from './prompts'
import { documentSlots } from './scoring'

export const originalFileSha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

export function checkedArtifactPath(runDir: string, file: string): string {
  const root = fs.realpathSync(path.resolve(runDir, 'artifacts'))
  const target = path.resolve(root, file)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Artifact path escapes the exported pack: ${file}`)
  if (fs.existsSync(target)) {
    const realRelative = path.relative(root, fs.realpathSync(target))
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new Error(`Artifact symlink escapes the exported pack: ${file}`)
  }
  return target
}

/** 只读取本题 manifest 里的附件或公开题面，不允许判据引用内部 closure/notes。 */
export function readPublicRequirementInputs(spec: TaskSpec, version: DesignAnythingBenchVersion, repositoryRoot = process.cwd()): PublicRequirementInput[] {
  const directories = designAnythingCorpusPaths(version)
  const manifest = JSON.parse(fs.readFileSync(path.resolve(repositoryRoot, directories.manifest), 'utf8')) as Manifest
  const task = manifest.tasks.find(item => item.taskId === spec.taskId)
  if (!task) throw new Error(`Public requirement inputs: ${spec.taskId} absent from ${version}`)
  const scenarioFile = `${directories.scenarios}/${spec.taskId}.json`
  const allowed = new Map<string, 'scenario' | ManifestAsset['kind']>([[scenarioFile, 'scenario']])
  for (const asset of task.assets) for (const entry of expandAsset(spec.taskId, asset)) {
    allowed.set(`${directories.assets}/${spec.taskId}/${entry.file}`, asset.kind)
  }
  const wanted = [...new Set((spec.requirementChecks ?? []).flatMap(check => check.inputFiles ?? []))]
  return wanted.map(file => {
    const kind = allowed.get(file)
    if (!kind) throw new Error(`Requirement input is not a public ${version}/${spec.taskId} source: ${file}`)
    const absolute = path.resolve(repositoryRoot, file)
    const sha256 = originalFileSha(absolute)
    if (kind === 'scenario') {
      const scenario = JSON.parse(fs.readFileSync(absolute, 'utf8')) as { steps: Array<{ userMessage?: string }> }
      return { file, sha256, text: scenario.steps.flatMap(step => typeof step.userMessage === 'string' ? [step.userMessage] : []).join('\n\n') }
    }
    if (kind === 'document') return { file, sha256, text: fs.readFileSync(absolute, 'utf8') }
    if (kind === 'audio') {
      assertManifestAssetBytes({ file, kind }, fs.readFileSync(absolute))
      // 保留原件身份，但不伪造 imagePath/text；现有视觉判据据此返回 unjudgeable，零模型调用。
      return { file, sha256, contentType: 'audio/wav' }
    }
    const extension = path.extname(file).toLowerCase()
    return { file, sha256, imagePath: absolute, contentType: extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : 'image/png' }
  })
}

/**
 * 逐件读出原件证据。
 *
 * ## 为什么页数在这里补，而不是在 {@link prepareArtifactEvidence} 里算（#3589）
 *
 * 内联导出的 deck 以 `text/markdown` 交付，`prepareArtifactEvidence` 的 `text/*` 分支只调
 * `setText`，**不写 `pageCount`**。于是「deck 至少 N 页」这条判据读到 `undefined`，恒判不可判 ——
 * 当前 20 题里 20 题都有这条，它同时挡住 M1 最基本的「deck 交没交够页」。
 *
 * 页数此刻其实是**有**的：导出侧 `projectDeckText()` 数出来之后已经写进 manifest 条目的 `pages`，
 * 外部臂的导入器同样从真实内容数出 `deck.pages.length`，两侧都不是自报。所以这里读那个数，
 * **不在评估器里重算一遍** —— 重算等于给「这份 markdown 有几页」立第二份真相。
 *
 * 只在证据自己没确立页数时补（PDF / 渲染出的 HTML / PPTX 都自己算得出，那些不碰），
 * 并在 `metadata` 上留下这一格的出处。
 */
export async function prepareRequirementArtifacts(runDir: string, files: ReadonlyArray<{ file: string; contentType: string; pages?: number }>, cacheDir: string): Promise<Map<string, ArtifactEvidence>> {
  const evidence = new Map<string, ArtifactEvidence>()
  for (const file of files) {
    const prepared = await prepareArtifactEvidence({ filePath: checkedArtifactPath(runDir, file.file), contentType: file.contentType, cacheDir })
    if (prepared.metadata.pageCount === undefined && Number.isInteger(file.pages) && (file.pages as number) > 0) {
      prepared.metadata = { ...prepared.metadata, pageCount: file.pages, pageCountSource: 'manifest' }
    }
    evidence.set(file.file, prepared)
  }
  return evidence
}

/** 结构头里逐页标题的上限：够判体裁，又不让一份 40 页的 deck 把头撑成第二份正文。 */
export const DOCUMENT_HEADER_MAX_TITLES = 40
/** 结构头里首页文字的上限（字符）。 */
export const DOCUMENT_HEADER_FIRST_PAGE_CHARS = 1_500

/**
 * 文档证据前面的结构头（#3948）：页数、逐页标题、首页文字。
 *
 * 判官只拿到全文时，分不开「一份多页汇报」和「一页规格单」—— 两者在文本层面高度相似，
 * book 那份 10 页最终 deck 的判词是 "a one-page press handoff specification"。页数和逐页标题
 * 是体裁最直接的证据，而全文把它们埋掉了。
 *
 * 分页标记取自证据抽取层（PDF / HTML 都写 `## Page N`）；没有分页标记的文本（md / txt）
 * 按一页处理、标题取 markdown 标题行。页数读不出时如实写 unknown，不从文本长度去猜。
 */
export function documentStructureHeader(text: string, pageCount: number | undefined): string {
  const pages = text.split(/^## Page \d+\s*$/m).map(part => part.trim()).filter(part => part.length > 0)
  const paged = /^## Page \d+\s*$/m.test(text)
  const firstLine = (page: string) => page.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? ''
  const titles = paged
    ? pages.map(firstLine)
    : text.split('\n').map(line => line.trim()).filter(line => /^#{1,3}\s+\S/.test(line)).map(line => line.replace(/^#{1,3}\s+/, ''))
  const shown = titles.slice(0, DOCUMENT_HEADER_MAX_TITLES).map((title, index) => `${paged ? `p${index + 1}` : '-'} ${title.slice(0, 120)}`)
  const first = (paged ? pages[0] ?? '' : text).slice(0, DOCUMENT_HEADER_FIRST_PAGE_CHARS)
  return [
    '[Document structure]',
    `Pages: ${pageCount ?? 'unknown'}`,
    `${paged ? 'Page titles' : 'Headings'} (${titles.length}${titles.length > DOCUMENT_HEADER_MAX_TITLES ? `, first ${DOCUMENT_HEADER_MAX_TITLES}` : ''}):`,
    ...(shown.length > 0 ? shown : ['(none)']),
    'First page:',
    first,
    '[Full text]',
  ].join('\n')
}

/**
 * 文档件的**打分式**分类（#3948）：与图像件同一个模板、同一个回复形状、同一个归一化，
 * 由 `solveSlotAssignment` 一次性求解席位。证据是结构头 + 全文。
 *
 * 返回 `reply: null` 表示这一件判不了（读不出文字 / 超长 / 调用失败）；调用方经 `readClassifyScores` 记成因。
 */
export async function classifyDocumentScores(spec: TaskSpec, evidence: ArtifactEvidence, cacheDir: string, pages: number | undefined = evidence.metadata.pageCount): Promise<{
  reply: unknown
  textLines: string[]
  transcriptionFailed: boolean
}> {
  const read = await readDocumentText(evidence, cacheDir)
  const slots = documentSlots(spec)
  if (!slots.length || !read.text.trim() || read.text.length > 96000) return { reply: null, textLines: read.text.split('\n'), transcriptionFailed: true }
  try {
    const prompt = renderClassifyScoresPrompt(slots)
    const body = `${documentStructureHeader(read.text, pages)}\n${read.text}`
    const reply = await askInlineTextEvaluator<unknown>({ subject: evidence.filePath, text: body, prompt: prompt.text, promptSha: prompt.cacheSha, cacheDir })
    return { reply, textLines: read.text.split('\n'), transcriptionFailed: read.transcriptionFailed }
  } catch (error) {
    if (!(error instanceof VlmUnreadableError)) throw error
    return { reply: null, textLines: read.text.split('\n'), transcriptionFailed: true }
  }
}

/** 文档件的文字：原件抽取得到的全文；抽不出且有逐页图时逐页 OCR（与旧通道同一条退路）。 */
async function readDocumentText(evidence: ArtifactEvidence, cacheDir: string): Promise<{ text: string; transcriptionFailed: boolean }> {
  let text = evidence.textComplete ? evidence.text : ''
  let transcriptionFailed = !evidence.textComplete
  if (!text.trim() && evidence.images.length > 0 && evidence.metadata.pageCount === evidence.images.length) {
    // #3952：按页收。此前任一页有一处看不清（`unreadableCount > 0`）就整份放弃，纯图 PDF 67/101 份因此
    // 连归槽都进不去。现在读到的页照常交给分类；只要有一页没读全，`transcriptionFailed` 仍为真 ——
    // 逐字约束不在一份残缺转写上判 fail（那会把仪器看不清记成系统没写）。
    const pages: string[] = []
    let complete = true
    for (const page of evidence.images) {
      try {
        const reply = await askSetVlm<{ lines: string[]; unreadableCount: number }>({ images: [{ path: page.filePath, contentType: 'image/png' }], prompt: TRANSCRIBE_PROMPT_TEMPLATE, promptSha: TRANSCRIBE_PROMPT_SHA, cacheDir })
        if (!Array.isArray(reply.lines) || reply.lines.some(line => typeof line !== 'string') || !Number.isInteger(reply.unreadableCount)) throw new VlmUnreadableError(evidence.filePath, 'invalid document OCR reply')
        if (reply.unreadableCount > 0) complete = false
        pages.push(`## Page ${page.page}\n${reply.lines.join('\n')}`)
      } catch (error) {
        if (!(error instanceof VlmUnreadableError)) throw error
        complete = false
      }
    }
    if (pages.length > 0) {
      text = pages.join('\n\n')
      transcriptionFailed = !complete
    }
  }
  return { text, transcriptionFailed }
}
