/**
 * 载体预分类（#3948）：一件产物是**什么载体**，决定它能连哪些槽、按什么规则占席位。
 *
 * 归槽只有一个求解器、一条席位规则（`assignment.solveSlotAssignment`）：一件东西只能在与自己
 * 最佳槽的判官原始分差不超过**容差**的槽占席位。容差是载体的属性，写在下面这张表里，求解器
 * 本身不认识载体。
 *
 * 判据只读 manifest 的 `key` / `contentType` / `pages`，不调模型、不看文件名里的词（#3838 的
 * 「判据只读 key、不猜词表」）。唯一需要判官的是截图文件夹：结构规则只提**候选**
 * （{@link imageSeriesCandidates}），认不认由判官按同一条相对门决定，见 `evaluate.ts`。
 *
 * @module benchmarks/design-anything/tools/evaluator/carrierKind
 */

import { isDeckPageFile, isImporterRenderedPage, PAGE_SERIES_DIRS } from './deckPages'
import { isDocumentClassifiableCarrier } from './documentCarrier'

export type CarrierKind = 'document' | 'image' | 'video' | 'document-page' | 'other'

/**
 * 载体 → 席位容差。`undefined` = 不设上限。
 *
 * **图像：不设上限**（与 #3541 逐字一致）。图像件是单一用途的交付，判官逐件打分时看不到同题别的件，
 * 首选常给错；容量约束下的大分差挪位是纠错机制 —— craft-01「六件被判进 set」由它挪回
 * hero / scene / directions，`assignment.test.ts` 的三条单测锁的就是它。量化读数（v1.15 留档
 * 打分离线重解，不调判官）：图像件上加容差 10，完成度只降不升（gm-sol 71 格里降 9 格、
 * gm-deepseek 228 格里降 45 格）；被挡下的挪位抽查 10 件，7 件原本放对了。
 *
 * **文档：10**。文档件的体裁在文本层面高度重叠 —— 一份汇报本来就含排期表的内容，判官会给它
 * 在排期表槽也打高分。大分差挪位在这里意味着同一份文件顶两个交付（#3838 的反面）。两条实测
 * 读数把取值夹在 (0, 14)（判官 deepseek-flash，思考关闭，v0.6 architecture-base-a-n24）：
 * `x3704-win` 的 19 页 deck 打 90 / 85 / 90（排期表 / 材料表 / 汇报），判官分不开，它必须能挪进
 * 汇报槽（分差 0）；`x3704-ctl` 去掉 .md 的反事实里，19 页 deck 打 78（排期表）/ 92（汇报），
 * 分差 14，它不能去顶空着的排期表席位。
 *
 * 视频按 Content-Type 确定性归属（一份 spec 至多一个视频槽），分数恒为满分，容差无意义。
 */
export const CARRIER_SEAT_TOLERANCE: Readonly<Record<'document' | 'image' | 'video', number | undefined>> = {
  document: 10,
  image: undefined,
  video: undefined,
}

/** 预分类所需的 manifest 字段。 */
export interface CarrierFile {
  key: string
  file: string
  contentType: string
  pages?: number
}

/**
 * 一件产物的载体。`document-page` = 另一份文档的一页（GM 的 `deck-page:`、导入器的渲染页、
 * 外部臂的逐页系列），它不单独连任何槽 —— 是否例外放行由 `evaluate.excludeDeckPagesFromSlots` 决定。
 */
export function carrierOf(file: Pick<CarrierFile, 'key' | 'contentType'>): CarrierKind {
  if (file.contentType.startsWith('video/')) return 'video'
  if (file.contentType.startsWith('image/')) return isDeckPageFile(file) ? 'document-page' : 'image'
  if (isDocumentClassifiableCarrier(file.contentType) || file.contentType.startsWith('text/')) return 'document'
  return 'other'
}

/** 截图文件夹候选：同一目录、同一文件名干（数字换成 `#`）、至少两张的一组图。 */
export interface ImageSeriesCandidate {
  /** 目录（key 去掉文件名） */
  dir: string
  /** 文件名干，数字换成 `#`，如 `slide-#.png` */
  stem: string
  /** 组内产物文件名，按序号升序 */
  members: string[]
}

/** 候选组的最小张数。页数够不够是形态读数（#3803），不是认不认得出 deck 的门。 */
export const IMAGE_SERIES_MIN_MEMBERS = 2

/**
 * 从 manifest 里挑出截图文件夹候选。**只提候选，不做认定**：同样的结构既可能是一份截图 deck，
 * 也可能是视频帧、分镜、同一系列的产品照 —— 只看文件名分不开（v0.6 实测：Codex 的
 * `presentation-pages/slide-N` 与 `walkthrough_frames/frame_N`，OD 的 `PNG/N-presentation-pN`
 * 与 `exports/wear-wN`）。
 *
 * 排除已有源文件的页：GM 的 `deck-page:`、导入器的 `__rendered__`，以及逐页系列目录
 * （`pages/` / `svg_artifacts/`）里同一上级目录下已有带页数文档的那些 —— 它们是那份文档的页。
 * 没有配套文档的逐页系列目录（JH 实测 13 组）进候选：今天它们在任何槽里都算不上交付。
 */
export function imageSeriesCandidates(files: readonly CarrierFile[]): ImageSeriesCandidate[] {
  const pagedDocumentDirs = new Set(files
    .filter((file) => carrierOf(file) === 'document' && file.pages !== undefined)
    .map((file) => dirOf(file.key)))
  const groups = new Map<string, { dir: string; stem: string; members: Array<{ file: string; order: number[] }> }>()
  for (const file of files) {
    if (!file.contentType.startsWith('image/')) continue
    if (file.key.startsWith('deck-page:') || isImporterRenderedPage(file)) continue
    const dir = dirOf(file.key)
    const parent = dir.slice(dir.lastIndexOf('/') + 1)
    if (PAGE_SERIES_DIRS.includes(parent) && pagedDocumentDirs.has(dirOf(dir))) continue
    const name = file.key.slice(file.key.lastIndexOf('/') + 1)
    const numbers = name.match(/\d+/g)
    if (numbers === null) continue
    const stem = name.replace(/\d+/g, '#')
    const id = `${dir}\u0000${stem}`
    const group = groups.get(id) ?? { dir, stem, members: [] }
    group.members.push({ file: file.file, order: numbers.map(Number) })
    groups.set(id, group)
  }
  return [...groups.values()]
    .filter((group) => group.members.length >= IMAGE_SERIES_MIN_MEMBERS)
    .map((group) => ({
      dir: group.dir,
      stem: group.stem,
      members: group.members
        .sort((a, b) => compareOrder(a.order, b.order))
        .map((member) => member.file),
    }))
}

function dirOf(key: string): string {
  const slash = key.lastIndexOf('/')
  return slash < 0 ? '' : key.slice(0, slash)
}

function compareOrder(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}
