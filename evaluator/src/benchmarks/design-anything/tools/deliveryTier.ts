/**
 * 交付方式档位（#3444）—— 「这件成果的**像素**是谁产的」。
 *
 * ## 为什么必须在生产者侧登记
 *
 * 指南 §2.6（评估维度里「交付方式」那一列）要求每件成果记成 `generated`（生成模型产出）、
 * `authored`（手写代码或矢量画出）或 `absent`（没交）。理由是实测：OpenDesign 用手写
 * SVG / HTML 顶替生成图，只判「交没交」时两家同分，而产物根本不是一回事。
 *
 * 判断依据在**评估器那里已经丢了**：#3406 之后矢量件在进评估器前就被栅格化成 png，
 * 「它原本是手画的 SVG」只有导入器知道；「这张图来自 gen-image-generation」只有导出器
 * 知道。评估器按 Content-Type 事后猜是猜不出来的 —— 所以这两组规则必须跑在两个**生产者**
 * 那里，评估器只读、只数、不判。
 *
 * ## v2：判像素，不判载体
 *
 * v1 的外部臂规则问的是「这件载体是不是手工做的」。**实测三条臂后证明这个问题问错了。**
 *
 * JarvisHub 的 `svg_artifacts/*.svg` 有 10 张，其中 6 张只有 1.0–1.3 KB，整张图就是一个
 * `<image href="../images/NN_slide_image_<sha>.png">` 加十来个标题文字 —— 手写的是**版式**，
 * 画面主体是生成图。v1 把这样的页记成 `authored`，于是「JarvisHub 交的东西里没有一件是
 * 模型生成的」这句假话可以从这一列里读出来。
 *
 * 同一批数据上，v1 让两条外部臂在交付集上几乎同分（手写件 15 vs 16 件），而 issue 正文
 * 预期的是 OpenDesign 明显更高。**那个预期不成立不是因为规则算错，是因为规则问的是载体。**
 * 换成按像素判之后，跨题批次上的区别才显出来：OpenDesign 是真手画（authored 11 / composed 3），
 * JarvisHub 是生成图套手写框（authored 2 / composed 7）。
 *
 * 所以 v2 的判据是：**这件产物的手写源标记里，有没有引用位图。**
 * 有 → {@link DeliveryTier.composed}；没有 → `authored`；根本没有手写源 → `generated`。
 *
 * ## 两组规则，一条纪律
 *
 * 规则写死在代码里，**不允许 per-arm 调参**（同 `importExternalRun.ts` 的
 * `ROLE_RULE_VERSION`）。两个版本号各自随规则变更 bump —— 跨版本的档位口径不可同图。
 *
 * ## Gemus 侧结构性不产生 `authored` / `composed`
 *
 * 平台没有「手写矢量」这条通道：每一件图像/视频产物要么来自生成节点，要么是上传的素材，
 * 要么是本地变换的产物。所以 Gemus 批次的手写件恒为 0 —— 那是**结构事实**，不是
 * 「这一批恰好没手画」。读表时不把它当成一次观测。实测佐证：`<batch-root>` 下 11 个批次、
 * 2168 件图像/视频产物，源节点只出现过 `gen-image-generation` / `gen-ppt` /
 * `gen-video-generation` / `gen-storyboard` 四种，四种都判 `generated`。
 *
 * @module benchmarks/design-anything/tools/deliveryTier
 */

import '@/lib/nodes/nodeRegistry'
import { tryGetNodeConfig } from '@/lib/nodes/registry/core'
import { NodeCategory } from '@/types/node'

/**
 * 一件成果的来源档位。
 *
 * `absent` 不在这里 —— 它不是某一件的属性，而是「槽位期望件数减去实际交付件数」，
 * 只有评估器按槽求和时才存在。把它塞进本枚举会需要一个不指向任何文件的 `ExportedFile`。
 *
 * `composed` 是「手写的版式 + 生成的画面」：源标记是人写的，但它引用了位图。这一档单列
 * 而不是并进 `authored`，理由见模块头「v2」那一节 —— 并进去会让「一件模型生成图加个标题」
 * 读成「一件手画的成果」。
 *
 * `reused-input` 是**素材**不是交付：用户（或题面素材包）给的原图被原样当成果交出来时，
 * 它既不是生成的、也不是手画的。不单列的话一件素材会被算成一件生成物。
 *
 * `unknown` 是**一等出口**，不是错误码：导出包不带上游血缘，本地变换件（裁剪、抽帧）
 * 的来源在包里就是不可知的。判成 `generated` 是造读数，判成 `authored` 也是。
 * 与 `identity.ts` 的 `unjudgeable`、`scoring.ts` 的 `not-applicable` 同一条纪律
 * （#2415「缺席 ≠ 0」）。
 */
export type DeliveryTier = 'generated' | 'authored' | 'composed' | 'reused-input' | 'unknown'

/** 登记在 `ExportedFile.provenance` 上的一条来源判定。 */
export interface DeliveryProvenance {
  tier: DeliveryTier
  /** 为什么是这一档。一个读数必须能被反推出依据，否则读表人只能重跑 */
  evidence: string
  /** 产出这条判定的规则版本 —— 跨版本的档位口径不可同图 */
  ruleVersion: string
}

/**
 * Gemus 侧规则版本。改规则必须 bump。
 *
 * `v2`（#3439）：上传进来的输入素材先判 `reused-input`，不再按引用它的节点推档 ——
 * 同一件产物在 v1 与 v2 下可以得到不同的档位（被 deck 引用的题面照片：`generated` → `reused-input`），
 * 两版读数不可同图。
 *
 * `v3`（#3532）：本臂的 deck 页开始以逐页位图进包，按**版面标记里有没有位图**判
 * `composed` / `authored`（见 {@link gemusDeckPageTier}）。既有件的档位一件都没变 ——
 * 变的是包里多了一整类以前不存在的件，于是「同一批题的两次导出」在这一列上不再可比。
 * 这个不可比是真实的，所以要 bump：让 `assertProvenanceRulesComparable` 当场拒表，
 * 而不是让读表人对着一个多了几十件 `composed` 的臂猜发生了什么。
 */
export const GEMUS_PROVENANCE_RULE_VERSION = 'gemus-node-lineage/v3'

/**
 * 外部臂规则版本。改规则必须 bump。
 *
 * `v1` = `external-carrier-syntax/v1`，判的是载体是不是手工做的。
 * `v2` 改判像素（见模块头），名字一起换掉 —— 版本号只递增、判据却换了一个问题时，
 * 读表人无从察觉两批读数不可同图。
 */
export const EXTERNAL_PROVENANCE_RULE_VERSION = 'external-pixel-source/v2'

/**
 * 本地确定性变换节点 —— 它们**不创造内容**，只搬运已有的像素。
 *
 * ## 这个集合为什么必须显式存在
 *
 * Issue #3444 §4 同时写了两条规则：「`execution.mode` 为 `provider` → `generated`」和
 * 「纯本地变换（`image-crop` / `frame-extract`）→ `unknown`」。实测 registry，这两个
 * 节点的 `execution.mode` **正是** `provider`（`UTILITY / provider`）—— 两条规则打架。
 *
 * 裁定按 Issue 的意图走：本地变换不算生成。而 registry 里**没有任何字段**表达
 * 「这个 provider 是不是生成式的」，所以这是一条新知识，只能显式写下来。
 * 它不是在重复既有 SSOT，是在补一个 SSOT 里不存在的区分。
 *
 * 它们判 `unknown` 而不是继承上游档位：导出包不带血缘，这里猜不出来，也不该猜。
 */
export const LOCAL_TRANSFORM_NODE_TYPES: ReadonlySet<string> = new Set(['image-crop', 'frame-extract'])

/**
 * 冲突时的保守序（大 = 更保守）。多个节点引用同一件产物时取最保守的那一档。
 *
 * 方向是刻意的：把一件来源存疑的产物记成 `generated` 会让「生成物件数」虚高，
 * 而这一列正是用来跟对手比「有多少是真生成的」。宁可少认，不可多认。
 *
 * `composed` 排在 `generated` 与 `authored` 之间：它比「纯生成」多一层人的工作，
 * 比「纯手画」少一层。#3532 起本臂也会产出这两档 —— deck 页的版面是 agent 写的标记，
 * 里面的画面才是模型生成的，所以它落 `composed`（页里嵌了生成图）或 `authored`（纯文字页）。
 */
const CONSERVATISM: Record<DeliveryTier, number> = {
  generated: 0,
  composed: 1,
  authored: 2,
  'reused-input': 3,
  unknown: 4,
}

/** 单个 nodeType 的档位判定。registry 查不到（第三方节点、已下架类型）一律 `unknown`。 */
function tierOfNodeType(nodeType: string): DeliveryTier {
  if (LOCAL_TRANSFORM_NODE_TYPES.has(nodeType)) return 'unknown'
  const config = tryGetNodeConfig(nodeType)
  if (config === undefined) return 'unknown'
  if (config.category === NodeCategory.INPUT) return 'reused-input'
  if (config.category === NodeCategory.GENERATION) return 'generated'
  const mode = config.execution?.mode
  if (mode === 'provider' || mode === 'dynamic-provider') return 'generated'
  return 'unknown'
}

/**
 * Gemus 侧：从引用这件产物的终态节点判来源。
 *
 * `sourceNodes` 为空（blob key 出现在任何端口之外）→ `unknown`：没有节点身份就没有依据。
 *
 * `isInputAsset`（#3439）短路成 `reused-input`，**优先于 sourceNodes**：题面素材被
 * `gen-ppt` 的 deck 引用后，它唯一的 sourceNode 就是那个生成节点，按节点推档会推成
 * `generated` —— 把客户的照片报成"模型生成的"，正好是这一列被造出来要防的那种假话。
 * 「它是上传进来的」这个事实比「谁引用了它」更强，所以它先判。
 */
export function gemusDeliveryTier(
  sourceNodes: ReadonlyArray<{ nodeId: string; nodeType: string }>,
  isInputAsset = false,
): DeliveryProvenance {
  if (isInputAsset) {
    return {
      tier: 'reused-input',
      evidence: 'declared as an uploaded input file (node data.config.files) — the run only re-referenced it',
      ruleVersion: GEMUS_PROVENANCE_RULE_VERSION,
    }
  }
  if (sourceNodes.length === 0) {
    return {
      tier: 'unknown',
      evidence: 'no source node references this artifact — the export pack carries no lineage for it',
      ruleVersion: GEMUS_PROVENANCE_RULE_VERSION,
    }
  }

  const tiers = sourceNodes.map((node) => ({ nodeType: node.nodeType, tier: tierOfNodeType(node.nodeType) }))
  const tier = tiers.reduce(
    (worst, item) => (CONSERVATISM[item.tier] > CONSERVATISM[worst] ? item.tier : worst),
    tiers[0].tier,
  )
  // evidence 列出全部 nodeType（不止胜出的那个）：冲突本身是读表人要看见的事实
  const listed = tiers.map((item) => `${item.nodeType}=${item.tier}`).join(', ')
  return {
    tier,
    evidence: tiers.length === 1
      ? `source node ${listed}`
      : `${tiers.length} source nodes (${listed}) — took the most conservative tier`,
    ruleVersion: GEMUS_PROVENANCE_RULE_VERSION,
  }
}

/**
 * 导入器**合成**出来的载体是怎么来的。
 *
 * 这两种件是我们对对手产物做的加工（把 HTML deck 用浏览器渲成逐页图、把没有位图孪生的
 * SVG 栅格化）。它们与源文件不在同一个同源组里，组内规则看不见它们 —— 所以档位必须
 * 在**合成那一刻**就写上，而不是在下游反推。
 */
export type SynthesizedCarrierKind = 'rendered-deck' | 'rasterized-vector'

/**
 * 一件合成载体的来源 —— 在合成那一刻记下。
 *
 * `rasterRefs` 是**这一页**（不是整份源文件）的源标记里引用到的位图。逐页归属是必需的：
 * OpenDesign 的 deck 是一份 103 KB 的 HTML、16 页里只有 2 个 `<img>`，按整份文件判会把
 * 14 页干净的手画页一起记成 `composed`。
 */
export interface SynthesizedCarrierOrigin {
  kind: SynthesizedCarrierKind
  /** 源文件在源目录里的相对路径 */
  from: string
  /** 这一页的源标记里引用到的位图（已按 {@link extractRasterRefs} 提取） */
  rasterRefs: readonly string[]
}

/** 位图扩展名 —— 决定一条引用算不算「内嵌了生成图」。矢量引用（svg）不算。 */
const RASTER_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#].*)?$/i

/** `data:image/png;base64,...` 这种内联位图。矢量的 `data:image/svg+xml` 不算。 */
const RASTER_DATA_URI = /^data:image\/(png|jpe?g|webp|gif|bmp|avif)\b/i

/** 手写源标记的扩展名。CSS 也算：它能用 `background-image` 把位图铺进版面。 */
const HAND_AUTHORED_MARKUP = /\.(svg|html?|css)$/i

/** 这个路径是不是一份手写源标记。 */
export function isHandAuthoredMarkup(relPath: string): boolean {
  return HAND_AUTHORED_MARKUP.test(relPath)
}

/**
 * 从一段源标记里提取它引用到的**位图**。**纯函数**，规则的唯一实现处。
 *
 * 三种引用形式都要认，因为三条臂各用一种：`<img src>`（OpenDesign 的 HTML deck）、
 * `<image href>` / `xlink:href`（JarvisHub 的 SVG 幻灯片）、CSS 的 `url()`（背景铺图）。
 *
 * data URI 截短后返回：一张内联 base64 位图能有几百 KB，原样进 evidence 会让 manifest
 * 涨几个数量级，而读表人需要的只是「这里嵌了一张位图」。
 */
export function extractRasterRefs(markup: string): string[] {
  const refs: string[] = []
  const patterns = [
    /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<image\b[^>]*?\b(?:xlink:)?href\s*=\s*["']([^"']+)["']/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of markup.matchAll(pattern)) refs.push(match[1] ?? '')
  }
  return normalizeRasterRefs(refs)
}

/**
 * 把一批引用字符串收敛成「这里嵌了哪些位图」。
 *
 * 与 {@link extractRasterRefs} 分开导出，是因为逐页归属是在**浏览器里**量的
 * （CSS 背景图只有算完样式才知道，见 `renderDeckPages.ts`），那条通道拿到的已经是
 * URL 而不是标记原文 —— 但「什么算位图」这条判据必须只有一处实现。
 */
export function normalizeRasterRefs(refs: readonly string[]): string[] {
  const kept: string[] = []
  for (const raw of refs) {
    const ref = raw.trim()
    if (ref === '') continue
    if (RASTER_DATA_URI.test(ref)) {
      kept.push(`${ref.slice(0, 32)}…`)
      continue
    }
    if (RASTER_EXTENSION.test(ref)) kept.push(ref)
  }
  return [...new Set(kept)]
}

/**
 * 有手写源时的档位：源标记里有位图 → `composed`，没有 → `authored`。
 *
 * `ruleVersion` 是参数而不是常量：三条臂的 deck 页现在都走这一条判据（#3532），但它们的
 * 规则族不同 —— 外部臂是「只用句法证据」那一族，本臂是「按节点血缘」那一族。判据同一条、
 * 版本各记各的，跨批次的可比性闸（`assertProvenanceRulesComparable`）才能各自守住自己那族。
 */
function tierFromHandAuthoredSource(
  how: string,
  sourcePath: string,
  rasterRefs: readonly string[],
  ruleVersion: string,
): DeliveryProvenance {
  if (rasterRefs.length > 0) {
    const listed = rasterRefs.slice(0, 3).join(', ')
    const more = rasterRefs.length > 3 ? ` (+${rasterRefs.length - 3} more)` : ''
    return {
      tier: 'composed',
      evidence: `${how} ${sourcePath}, whose markup embeds ${rasterRefs.length} raster image(s): ${listed}${more}`
        + ' — the layout is hand-authored, the picture inside it is not',
      ruleVersion,
    }
  }
  return {
    tier: 'authored',
    evidence: `${how} ${sourcePath}, whose markup references no raster image`,
    ruleVersion,
  }
}

/**
 * 本臂 deck 页的档位（#3532）—— 与外部臂的 deck 页**走同一条判据**。
 *
 * 判据是「这一页的版面标记里有没有位图」：有 → `composed`（版面是写出来的，画面不是），
 * 没有 → `authored`。不按 `gen-ppt` 的节点类型推档，那会推成 `generated` ——
 * 把一页人（这里是 agent）排出来的版面报成「模型生成的图」，正是这一列被造出来要防的假话。
 *
 * 跨臂对称：OpenDesign 交一份手写 HTML deck、我们把它渲成图，判的是它的标记；本臂的
 * agent 写出幻灯片标记、产品把它渲成图，判的也是它的标记。同一件事，同一条尺子。
 */
export function gemusDeckPageTier(nodeId: string, portId: string, page: number, slideMarkup: string): DeliveryProvenance {
  return tierFromHandAuthoredSource(
    'rendered from the deck slide markup authored on',
    `${nodeId}:${portId} page ${page}`,
    extractRasterRefs(slideMarkup),
    GEMUS_PROVENANCE_RULE_VERSION,
  )
}

/**
 * 外部臂：只用**句法**证据判来源，不读对手任何流程文件（指南 §2.8）。
 *
 * 三条找手写源的路径（合成件的源、件本身、同组的矢量孪生）之后走的是**同一条**判据 ——
 * 看那份源标记里有没有位图。这是刻意的：一件手写 HTML 直接交出来、和它被我们渲成图交出来，
 * 是同一件东西的两种载体，不该判成两档。
 *
 * ## 已知限制（必须随读数一起报）
 *
 * 对手若自己把 HTML 截成 png、只交 png，包里就找不到任何矢量或标记源文件，
 * 这条规则会把它读成 `generated`。规则对三家是同一条 —— **粗糙是可申辩的，不对称不是**。
 * 这句话同时写进返回的 evidence 原文，让读表人在单元格里就看得到。
 */
export function externalDeliveryTier(input: {
  /** 这件载体在源目录里的相对路径 */
  relPath: string
  contentType: string
  /** 同源组里所有载体的相对路径（含它自己）。用来判「有没有矢量孪生」 */
  groupCarrierPaths: readonly string[]
  /** 它是不是导入器合成出来的；合成件的来源在合成那一刻就已知 */
  synthesized?: SynthesizedCarrierOrigin
  /**
   * 包里每份手写源标记引用到的位图，按源目录相对路径索引。由导入器读文件填 ——
   * 本函数不碰文件系统（同 `role` 规则可单测的理由）。
   */
  markupRasterRefs?: ReadonlyMap<string, readonly string[]>
}): DeliveryProvenance {
  const refsOf = (relPath: string): readonly string[] => input.markupRasterRefs?.get(relPath) ?? []

  if (input.synthesized !== undefined) {
    const how = input.synthesized.kind === 'rasterized-vector'
      ? 'rasterized from hand-authored vector'
      : 'rendered from hand-authored markup'
    return tierFromHandAuthoredSource(how, input.synthesized.from, input.synthesized.rasterRefs, EXTERNAL_PROVENANCE_RULE_VERSION)
  }

  // 件本身就是一份手写源标记（单页 HTML / SVG 被当成交付物直接交出来）。
  // v1 把这种件挡在定义域外，于是 OpenDesign 的 `kit-office-*.html` 四件手写交付物
  // 在评估器里读成 `unknown`、`authoredShare` 掉到 0 —— 「一件手画的都没交」，
  // 而事实是五件交付物里四件是手写的。
  if (isHandAuthoredMarkup(input.relPath)) {
    return tierFromHandAuthoredSource('the artifact is itself hand-authored markup', input.relPath, refsOf(input.relPath), EXTERNAL_PROVENANCE_RULE_VERSION)
  }

  const twin = input.groupCarrierPaths.find(
    (relPath) => relPath !== input.relPath && isHandAuthoredMarkup(relPath),
  )
  if (twin !== undefined) {
    return tierFromHandAuthoredSource('a hand-authored source in the same carrier group:', twin, refsOf(twin), EXTERNAL_PROVENANCE_RULE_VERSION)
  }

  return {
    tier: 'generated',
    evidence: 'no vector/markup source for this artifact anywhere in the bundle. '
      + 'Known limitation: an arm that rasterises its own markup before exporting reads as generated here',
    ruleVersion: EXTERNAL_PROVENANCE_RULE_VERSION,
  }
}

/**
 * 这件产物需不需要登记来源。
 *
 * 定义域是「像素或版面出自谁之手」这个问题**问得通**的件：图像、视频，以及**手写源标记
 * 本身**（单页 HTML / SVG 被当交付物交出来时，它就是那件成果）。
 *
 * v1 只认图像与视频，理由是「§2.8 明确文字不评」。那条理由张冠李戴了：§2.8 说的是不评
 * 文字**内容质量**，不是说一份手写 HTML 交付物没有作者。而评估器确实会把这样一件 HTML
 * 判进图像槽并计进交付集 —— 定义域比计数面窄，那一件就只能读成 `unknown`。
 *
 * 纯文本（`.txt` / `.md`）与 PDF 仍然不在域里：它们不是版面载体，「像素是谁产的」对它们
 * 不成立。缺席即「不适用」—— 评估器据此单独记 `notApplicable`，不与 `unknown` 混。
 */
export function needsProvenance(input: { contentType: string; relPath: string }): boolean {
  return input.contentType.startsWith('image/')
    || input.contentType.startsWith('video/')
    || isHandAuthoredMarkup(input.relPath)
}
