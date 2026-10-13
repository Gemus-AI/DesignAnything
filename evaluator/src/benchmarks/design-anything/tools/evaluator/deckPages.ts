/**
 * 「这张图是 deck 的一页」的唯一判据（#3441，#3532 起覆盖三条臂）。
 *
 * 三条臂的 deck 载体在**产品内部**就不同：外部臂的 deck 到达导出边界时已经是图
 * （OpenDesign 自渲染、JarvisHub 镜像里本来就是逐页图），本臂的 deck 是一个结构化端口对象。
 * #3532 之前本臂只落文字投影，于是「PPT 做得好不好」这件事在三条臂上只被回答了两次 ——
 * 本臂那次结构性缺席，而缺席同时**反向**扭曲了两列读数（色板对本臂不利、设计质量对本臂有利）。
 *
 * 现在三条臂的 deck 都以逐页位图进导出包，来源三种：
 *
 * - 本臂：导出时用产品自己的幻灯片渲染器出页，合成 key `deck-page:<nodeId>:<portId>:<NN>`
 *   （`renderGemusDeck.ts`）；
 * - 外部臂的 HTML deck：导入器渲染成 `__rendered__/<stem>__page-NN.png`（`importExternalRun.ts`）；
 * - 外部臂自带的逐页系列：`<deck>/pages/NN.png`，或由 `svg_artifacts/` 栅格化。
 *
 * 这些页在评估器里被图像分类器归到**别的图像槽**（da 题的 deck 槽全是纯文档槽，`imageSlots`
 * 不含它），所以「哪些图是 deck 页」必须能被认出来：#3441 用它量整套一致性的样本不对称，
 * #3531 用它做色板与设计质量的**产物形态**分层。写入侧（两个导出器）与读取侧
 * （`setRubric.ts` / `stratum.ts`）共用这一个模块，判据与命名都不在两处各写一遍。
 *
 * 判据只看导出包的 `key`，不看画布 —— 跨臂对称铁律。外部件看 `external:<arm>/<relPath>`
 * 的直接父目录，本臂件看合成 key 前缀；两条都是纯字符串判据，第三方拿同一份 manifest 可复算。
 *
 * @module benchmarks/design-anything/tools/evaluator/deckPages
 */
import type { ExportedFile } from '../exportRunArtifacts'

/** 导入器把 HTML deck 逐页渲染出的位图放在这个目录下（相对导入包根） */
export const RENDERED_DECK_DIR = '__rendered__'
/**
 * 外部臂自带的逐页系列目录名（JarvisHub 实测布局）：`pages/`（逐页位图）与 `svg_artifacts/`
 * （逐页矢量；没有位图孪生时由导入器栅格化成同目录同名 png）。导入器按这两个目录名成组。
 */
export const PAGE_SERIES_DIRS: readonly string[] = ['pages', 'svg_artifacts']

/**
 * 第三种逐页布局：**把每一页平铺在产物根目录**，用来源对象的字段路径命名（JarvisHub 实测）。
 *
 * 形如 `000_TIDELINE-LIBRARY-—-投标汇报-Deck（最终交付）_slides.0.imageUrl.png` ——
 * `_slides.<n>.<字段>` 是那份 deck 对象序列化后的路径，本身就是「这是第 n 页」的证据。
 *
 * 前两条判据都按**目录**认页，认不出这一种。代价是实测出来的：2026-09-08 各 40 格里，
 * JarvisHub 有 820 件 deck 页（449 `.png` + 371 `.svg`）因此被当成独立作品，其中 **396 件顶进了
 * 交付槽位**，其余污染了 #3531 的形态分层 —— 而那一层正是为修色板的辛普森悖论才建的。
 */
const FLAT_SLIDE_FILE_PATTERN = /_slides\.\d+\.(?:imageUrl|svgUrl)\.[A-Za-z0-9]+$/

/**
 * 逐页位图的文件名：`<stem>__page-NN.png`。**三条臂共用这一个构造**（#3532）。
 *
 * 这不是美观问题。报告侧按文件形态分层（#3531），命名不同形就要为每条臂各写一套识别逻辑，
 * 而那正是「同一份数据两条读法」。两个导出器都从这里取名字，形状就只有一处定义。
 */
export function deckPageFileName(stem: string, page: number): string {
  return `${stem}__page-${String(page).padStart(2, '0')}.png`
}

/** 导入器渲染页的相对路径：`__rendered__/<stem>__page-01.png` */
export function renderedDeckPagePath(stem: string, page: number): string {
  return `${RENDERED_DECK_DIR}/${deckPageFileName(stem, page)}`
}

const EXTERNAL_KEY_PREFIX = 'external:'

/**
 * 本臂渲染出的 deck 页在导出包里的合成 key 前缀（#3532）。
 *
 * 与 inline 文本件的 `inline:<nodeId>:<portId>` 同款：这些页没有对象存储身份（它们是导出
 * 那一刻渲染出来的，从没进过 MinIO），但仍需要一个在这一轮内稳定、可 diff 两次导出的名字。
 */
export const GEMUS_DECK_PAGE_KEY_PREFIX = 'deck-page:'

/** 本臂 deck 页的合成 key：`deck-page:<nodeId>:<portId>:<NN>` */
export function gemusDeckPageKey(nodeId: string, portId: string, page: number): string {
  return `${GEMUS_DECK_PAGE_KEY_PREFIX}${nodeId}:${portId}:${String(page).padStart(2, '0')}`
}

/**
 * 导出包里的一件是不是 deck 的一页。**三条臂都判**（#3532 起）。
 *
 * 本臂看合成 key 前缀；外部件看**直接父目录**是不是渲染目录或逐页系列目录 —— 与导入器的
 * 成组规则同口径（它也只看直接父目录），两个读者对同一份常量不能有两种读法。目录认不出来的
 * 平铺布局再看文件名（{@link FLAT_SLIDE_FILE_PATTERN}）。
 *
 * 三条判据都只读 `key`，第三方拿同一份 manifest 可复算 —— 跨臂对称是这把尺子的立身之本。
 * 本臂的对象存储 key（`users/.../pages/hero.png`）按构造命不中前缀，所以路径里恰好有同名段的
 * 普通图不会被误判成 deck 页。
 */
export function isDeckPageFile(file: Pick<ExportedFile, 'key'>): boolean {
  if (file.key.startsWith(GEMUS_DECK_PAGE_KEY_PREFIX)) return true
  const parent = externalParentDir(file)
  if (parent !== null && (parent === RENDERED_DECK_DIR || PAGE_SERIES_DIRS.includes(parent))) return true
  // 平铺布局只对外部件判：本臂的 key 是对象存储路径，不含来源对象的字段名。
  return file.key.startsWith(EXTERNAL_KEY_PREFIX) && FLAT_SLIDE_FILE_PATTERN.test(file.key)
}

/** 是不是**导入器自己**渲染出的页（`__rendered__/`）—— 与外部臂自带的逐页位图分开：前者的像素是我们渲染器的属性。 */
export function isImporterRenderedPage(file: Pick<ExportedFile, 'key'>): boolean {
  return externalParentDir(file) === RENDERED_DECK_DIR
}

/**
 * 导入器渲染页的**源文件名干**（`__rendered__/<stem>__page-07.png` → `<stem>`），非渲染页 → null。
 *
 * 用途只有一个（#3540）：判断这一页背后那份文件**自己有没有顶上槽**。导入器把包里每一份多页
 * HTML 都渲进同一个目录，不管它是汇报 deck 还是一份独立交付物 —— 2026-09-08 实测 OpenDesign
 * 的 45 种渲染页来源里，44 种是 deck，1 种（`cloud-ridge-directions`）是写成网页的方案方向。
 * 后者的源文件走文档通道、进不了图像槽，**渲染页是它唯一的进场方式**，一刀切会把一条真实的
 * 交付通道判成没交付。
 */
export function renderedDeckPageStem(file: Pick<ExportedFile, 'key'>): string | null {
  if (!isImporterRenderedPage(file)) return null
  const base = file.key.slice(file.key.lastIndexOf('/') + 1)
  const match = /^(.+)__page-\d+\.png$/.exec(base)
  return match === null ? null : match[1]
}

/** 外部件的直接父目录名；非外部件或没有父目录 → null */
function externalParentDir(file: Pick<ExportedFile, 'key'>): string | null {
  if (!file.key.startsWith(EXTERNAL_KEY_PREFIX)) return null
  const segments = file.key.slice(EXTERNAL_KEY_PREFIX.length).split('/')
  return segments.length < 2 ? null : segments[segments.length - 2]
}
