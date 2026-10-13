/**
 * 评估侧任务 spec（#3109）—— 与 `src/lib/agent/eval/scenarios/bench-*.json` **同源不同侧**。
 *
 * scenario 是被测输入（brief 原文、预算、步骤），spec 是判据（该交出哪些槽、哪些约束是硬的）。
 * 刻意不合成一份文件：判据要能在不改被测输入的前提下独立冻结与版本化，而 scenario 改一个字
 * 就换了被测题目。两者由 `taskId` 对齐，`assertSpecMatchesScenario` 之类的强绑定**不做** ——
 * 闭源产品的 run 根本没有 scenario 文件，spec 必须能独立成立。
 *
 * @module benchmarks/design-anything/tools/evaluator/taskSpec
 */

import fs from 'fs'
import path from 'path'
import { validateRequirementChecks, type RequirementCheck } from './requirementSpec'

import { DQ_CHECKLIST_VERSIONS, DQ_DOMAIN_FACETS, isDqChecklistVersion, type DqChecklistSelection, type DqDomainFacet } from './dqChecklist'
import { assertDeclaredTruthSource, identityTruthSource, type TruthSource } from './truthSource'

/**
 * 约束的作用面。
 *
 * - `'*'` = **落进任一声明槽的全部产物**（含候选稿，排除 `unassigned`）。对应 brief 里
 *   「每一件上都必须出现」这类措辞 —— 候选稿也是系统交出来的件。
 * - `{ slots, select: 'all' }` = 那些槽里的全部产物。用于「三张社媒图上都要有」。
 * - `{ slots, select: 'representative' }` = 那些槽的**代表件**（= 最后一件，#3113 的顺序契约）。
 *   用于「规范页上要写出 hex」这种本质上只针对定稿的一份文件的约束：系统做了两版规范页、
 *   最后收敛到的那版写对了，就该判过。
 */
export type ConstraintScope = '*' | { slots: string[]; select: 'all' | 'representative' }

/**
 * 逐字文本约束 —— **硬约束的主力**。
 *
 * 判据是转写文本里的精确子串匹配。首跑证明这是唯一有区分度的通道：
 * `#2D56AA` / `#2D5A4C` 两处真违规，像素法一个都抓不到。
 */
export interface TextVerbatimConstraint {
  id: string
  kind: 'text-verbatim'
  text: string
  scope: ConstraintScope
  /** 默认 false（hex 大小写不该判错）；品牌名之类要区分大小写时显式开 */
  caseSensitive?: boolean
  /**
   * 这条约束失败是否直接判整跑不成功（#3371）。默认 `false`。
   *
   * 指南 §4.8 的用例：信息设计题里「图上的数值与数据文件不符」——任何一处不符，
   * 这次运行就不成功，不因为交齐了件数而通过。
   *
   * **只有 `text-verbatim` 有这个字段**，`PixelColorConstraint` 刻意没有：那条明说是
   * 「只作诊断，不计分」，给一个诊断量生杀权等于让它悄悄变成判据。类型层不给位置，
   * 加载期再拒一次（JSON 进来时类型挡不住）。
   */
  critical?: boolean
}

/**
 * 像素色值约束 —— **只作诊断，不计分**，`scoring` 因此被类型钉成 `false`。
 *
 * 首跑实测 tol=10 下 27/27 全过，区分度为 0。留着它是因为"主色到底有没有出现"仍是想看的
 * 事实；但一旦让它计分，"调阈值换区分度"就成了一条对着数据调尺子的路，预注册当场作废。
 * 类型层禁止 `scoring: true`，比写在注释里可靠。
 */
export interface PixelColorConstraint {
  id: string
  kind: 'pixel-color'
  hex: string
  /** 每通道容差。**跑数据前写死**，不因看到结果而改 */
  tolerance: number
  scoring: false
  scope: ConstraintScope
}

export type Constraint = TextVerbatimConstraint | PixelColorConstraint

/** 交付物的载体形态。 */
export type MediaKind = 'image' | 'video' | 'document'

const MEDIA_KINDS: readonly MediaKind[] = ['image', 'video', 'document']

/**
 * 「该槽收不收这种载体」的唯一判据 —— 含缺省值。
 *
 * 缺省藏在各调用点里正是 #3138 的成因：`imageSlots` 写 `?? 'image'`、`documentSlots`
 * 写严格相等，两处对"没声明"给出不同答案，而没有任何一处会说出来。
 */
export function slotAccepts(slot: SlotSpec, kind: MediaKind): boolean {
  return (slot.mediaKinds ?? ['image']).includes(kind)
}

/**
 * 「这个槽进不进 M1 成功判定」的唯一判据 —— 含缺省值（#3371）。
 *
 * 缺省是 `true`，**只有一个例外**：只收视频的槽缺省为 `false`。理由是指南 §2.7 的既定
 * 事实——两家外部产品的视频通道在我们的环境里都不能用，且决定不替它们修，所以视频
 * 不进成功判定，单独按三档记。让缺省承担这条规则、而不是要求每个写题人记得写
 * `core: false`，是因为漏写不会报错，而漏写的方向恰好是**高估**外部系统的失败率。
 *
 * 缺省藏在调用点里的代价见 {@link slotAccepts} 的 #3138 教训，故这里同样只有一处。
 */
export function slotIsCore(slot: SlotSpec): boolean {
  if (slot.core !== undefined) return slot.core
  const kinds = slot.mediaKinds ?? ['image']
  return !(kinds.length === 1 && kinds[0] === 'video')
}

export interface SlotSpec {
  id: string
  /** 给分类器看的自然语言描述（进 prompt） */
  label: string
  description?: string
  /**
   * 该槽**可以接受**的载体形态，默认 `['image']`。
   *
   * 槽位说的是"交付角色"（概览页 / 品牌规范页 / 主渲染图），载体是它以什么形态到达。
   * 一个角色可以有不止一种合法载体：仪表盘的"概览页"既可以是渲染图，也可以是一个真的
   * 可交互页面（`gen-webpage`）。#3138 之前这里是**单值**且缺省 `'image'`，于是任何
   * 非栅格图交付一律 `unassigned` → 该题判 0；而题面从未要求过图片。因为交付形态是模型
   * 每轮自由选的，这不是"漏一档分"，是一个未建模的随机项，命中一次就把整题打到 0。
   *
   * 放宽是**并列受理**而不是替换：产品/空间/动效那些实质是视觉的槽仍只收图，否则等于
   * 给"用 HTML 绕开生图"发奖励。判据是**文本打分对该槽是否忠实** —— 规范页的实质就是
   * 一组被记录下来的取值，文本打分完全忠实；空间布局图的实质是几何，只读文字会把
   * "写了字但没画图"判成通过。
   *
   * 归属通道按形态分：`'image'` 与 `'document'` 各过一次分类器（#3128，两条面可以重叠）；
   * `'video'` 走 Content-Type 确定性归属，故全 spec 至多一个 video 槽 —— 分类器只看得懂
   * 静态图，给视频抽一帧让它分类，量的是"抽的那一帧像不像"而不是"交了没交"。
   */
  mediaKinds?: readonly MediaKind[]
  /**
   * 该槽只收**至少这么多页**的多页文档（#3126）。缺省 = 不设页数下限。
   *
   * 页数是导出包里的结构事实（`ExportedFile.pages`，现由 `gen-ppt` 的 deck 提供），
   * 不是分类器的判断。设它的理由是实测：`research-deck`（"多页研究汇报"）被一篇
   * analyzer 的单页分析稿判入，于是完成度读 5/5 满分而 PPT 是个空壳，跨件约束的代表件
   * 也变成了那篇分析稿 —— 一个缺陷同时污染三个维度。
   *
   * 判据放在结构上而不是提示词里：让分类器去分辨"这算不算一份汇报"，量的是它的判断力，
   * 而"有几页"本来就有确定答案。页数不可知的件（`pages` 缺省）**不满足**任何页数下限 ——
   * 那是如实的"证明不了"，不是"给它算过"。
   */
  minPages?: number
  /** v3：多页作品可交一份文档或逐页图像，仍按一套作品计交付单位。 */
  deliveryGrouping?: 'pages'
  /** 该槽期望的交付件数。同槽多件合法，超出的进 alternatives，不判错 */
  expected: number
  /**
   * 是否允许候选稿。
   *
   * **它今天不被任何判定消费**（#3782 核实）：超出 `expected` 的件一律进
   * {@link SlotVerdict.alternatives}，不扣分，与本字段取什么值无关。原注释许诺过一个
   * `overDelivered` 诊断，那个诊断从未存在；实测 v0.6 的 216 个槽本字段全是 `false`，
   * 兑现它等于把一个恒等过滤写成新字段、零新信息，故删除该承诺而不是实现它。
   * `lintTaskSpec` 仍校验它的存在与类型，写题时照填。
   */
  alternativesAllowed: boolean
  /**
   * 这个槽进不进 **M1 成功判定**（#3371）。缺省见 {@link slotIsCore}。
   *
   * ## 它**不**影响什么
   *
   * `deliverableCompletion` 与 `slotCoverage` 的算法一个字不受它影响 —— 完成度按 brief
   * 要求的**全部**类别算（指南 §2.2 的算式是 `Σ min(delivered, expected) / Σ expected`，
   * 对全集），只有「这次跑算不算成功」这个布尔量看 core。
   *
   * 让 core 同时收窄完成度会让既有批次的分母漂移：`bench-arch-01` 有一个 video 槽，
   * 分母会从 6 掉到 5，而那批读数已经跑完并被引用过。**一个字段只改一个量。**
   */
  core?: boolean
  /**
   * 成果阶段（DesignAnything-Bench 指南 §2.2 / §3，v3）：
   * `process` = 为推进项目而交的过程成果（方向稿、策略页、规范页、修图规则、汇报 deck）；
   * `final` = 客户真正拿去用的最终成果（logo、包装、页面、效果图、图表）。
   * M1 的成功判定按「全部核心槽」与「仅 final 核心槽」各算一遍并列报（见 `scoring.ts`），
   * 让读者分得清一个系统是输在没按流程交过程稿，还是输在最终东西没交齐。
   * 可选 —— 旧 spec 不声明，此时 `finalCore` 口径为 null，不伪装成「全是最终成果」。
   */
  stage?: SlotStage
}

/** {@link SlotSpec.stage} 的闭合枚举。 */
export type SlotStage = 'process' | 'final'

const SLOT_STAGES: readonly SlotStage[] = ['process', 'final']

/**
 * 一致性对象类型（DesignAnything-Bench 指南 §4.1）：这道题里"必须保持同一的是什么"。
 * 内部属性，不出现在题面；给评估器锚定、效力分析合并用（设计师分组按 §2.5 的专业背景，
 * 不按它）。闭合枚举。
 */
export type SubjectType =
  | 'identity-communication'
  | 'physical-object'
  | 'space'
  | 'character-world'
  | 'garment'
  | 'digital-product'
  | 'publication'
  | 'data'

const SUBJECT_TYPES: readonly SubjectType[] = [
  'identity-communication', 'physical-object', 'space', 'character-world',
  'garment', 'digital-product', 'publication', 'data',
]

/**
 * 跨件事实一致性 —— **只判 brief 明说的事实有没有被写坏**。
 *
 * ## 判的是什么
 *
 * 对一个 brief 里逐字给定的 token（主色 hex、品牌名、日期、场地、指标名……），在每一件
 * 交付物的转写文本里滑窗找最小编辑距离：
 *
 * - 距离 `0` —— 写对了
 * - 距离在 `(0, maxEditDistance]` —— **写坏了**，这就是违规（实测形态：brief 给 `#2D5A4A`，
 *   Full 臂印 `#2D56AA`、plan-in-text 印 `#2D5A4C`）
 * - 距离 `> maxEditDistance` —— 这件根本没提这个 token。**不是一致性问题**，
 *   那是覆盖率/逐字约束的事，此处不判（否则同一个缺陷会被扣两次）
 *
 * ## 判的不是什么
 *
 * 不判「整套读起来像不像一个品牌」。色板重叠度这类量**没有 ground truth** ——
 * brief 里没有任何一句话规定重叠度该是多少，"多少算一致"就成了一个没有锚点的阈值，
 * 而它算出来是个数字、看起来客观，比一个明说是主观的评分更危险。程度类判断交给人工。
 * 机器只判 brief 里有对错的事实。
 */
export interface TokenAgreementRule {
  id: string
  kind: 'token-agreement'
  /** brief 里逐字给定的 token */
  token: string
  /**
   * 判为「近似串」的最大编辑距离。**显式写在 spec 里而不是藏在代码里**——
   * 这是一个会影响读数的自由度，必须可审计，且必须在看数据之前定。
   *
   * 定法是先验而非调参：短 token（如 6 位 hex）取 `2` = 过半字符仍相同；
   * 长 token（品牌名/日期串）取 `2` 已足够宽，再大就会开始撞上无关文字。
   */
  maxEditDistance: number
  /** 默认 false。品牌名之类需要区分大小写时显式开 */
  caseSensitive?: boolean
}

export type SetConsistencyRule = TokenAgreementRule

/**
 * 跨产物**身份**一致性（#3173）—— 「同一个 logo 有没有在五件产物上保持同一个」。
 *
 * ## 为什么它不是一条 `Constraint`
 *
 * 不是因为怕污染 `constraintPassRate`（那条其实可以绕开：`PixelColorConstraint` 已经用
 * 类型钉死的 `scoring: false` 待在 `constraints[]` 里而不进分母）。真正的原因是
 * **`ConstraintScope` 解析成一个扁平的产物集合**（`artifactsInScope`：`'*'` 或
 * `{ slots, select }` → `Set<file>`），它没有任何位置可以表达 **anchor 槽 vs subject 槽的
 * 非对称关系**，更表达不了 pairwise 比较。硬塞进去要么给 `Constraint` 加一个只对一种
 * kind 有意义的字段，要么让 `artifactsInScope` 走特例分支 —— 两条都是把一个**集合级**
 * 性质伪装成逐件性质。`setConsistency` 已经是这个形状的先例，照它走。
 *
 * ## 为什么没有任何数值参数
 *
 * 判定是二值的，不给「调松一点」的旋钮。像素约束的教训就在隔壁：一旦有阈值，
 * 「调容差换区分度」就成了一条对着数据调尺子的路，预注册当场作废。
 *
 * ## 规则从哪来（**流程约束，不是代码能挡的**）
 *
 * anchor / subject 的落点是人写的，而写它的人读过 #3169 的事后发现。三条纪律：
 * ① 只从 brief 语义推出（anchor = brief 明说的 hero/定稿件）；② 规则作为独立 commit
 * 先落地、再谈跑数；③ 每条规则在 `notes` 里引到 brief 的具体一句。写不出那句话的规则
 * 说明它来自读数而不是题面。
 */
export interface IdentityConsistencyRule {
  id: string
  kind: 'identity-consistency'
  /**
   * 被追踪的主体。闭合枚举 —— 自由文本会让 prompt 的行为面无界。
   *
   * `'space'` 是 issue 原枚举之外的一项，由语料倒逼：space 家族的 brief 逐字要求
   * 「三张渲染必须是同一个空间」「三张图必须是同一个展台」，而那既不是 logo 也不是 product。
   * 不加它就等于把 issue 点名要覆盖的一整个家族排除在外。
   */
  subject: 'logo' | 'product' | 'character' | 'palette' | 'space'
  /**
   * 身份的**定义件**所在的槽。与 {@link anchorAssets} 二选一，恰好写一个。
   * 缺省取该槽的代表件（= 最后一件，#3113 的顺序契约）；见 {@link anchorSelect}。
   */
  anchorSlot?: string
  /**
   * 用素材包里的附件当锚（DesignAnything-Bench 指南 §2.3 / §4.2，v3）：客户给的产品照片、
   * logo 源文件、釉色样片。文件名相对
   * `src/lib/agent/eval/assets/references/bench-da/<taskId>/`（与 scenario 的 referenceAssets
   * 同一份文件），与 manifest 登记的一致。语义是**任一命中**：被比较件只要与其中任何一张是
   * 同一个主体就算 same —— 四个瓶子各一张原图、一只鞋三个角度，都是这个形状。
   * 与 {@link anchorSlot} 二选一。评估时文件不存在 → 该规则 not-applicable，不判 fail。
   */
  anchorAssets?: string[]
  /**
   * anchor 槽有多件时拿哪一件当锚。只对 {@link anchorSlot} 有意义。
   *
   * - `representative`（缺省）：最后一件。适用于"定稿"类槽。
   * - `any`：该槽交付集里的每一件都是候选锚，被比较件与任一件同一即 same。
   *   用于"定稿从 N 个方向稿之一发展而来"—— brief 说的是"其中一个"，不是"最后一个"；
   *   系统选了第一个方向而按缺省取最后一件，会把一次正确的收敛判成"定稿不从方向来"。
   */
  anchorSelect?: 'representative' | 'any'
  /**
   * 真值来源的**冗余声明**（#3518）。可选：不写则由锚派生（`anchorAssets` → `assets`，
   * `anchorSlot` → `run`），写了必须与派生值一致，否则加载期拒绝。
   *
   * 它不是一个选择 —— 加它是为了让「这条规则属于 M1 侧还是 M2 侧」在 spec 里读得出来，
   * 而不必回头去看锚是哪一种。四类判据里只有身份规则的取值会变，所以只有它有这个字段。
   */
  truthSource?: TruthSource
  /**
   * 必须与 anchor 保持同一身份的槽。
   *
   * **可以包含 `anchorSlot` 本身** —— 那是「同槽内互相一致」，语料里的主流形态
   * （space-01「三张渲染必须是同一个空间」、product-01「三视图 + 两个 CMF + 场景图必须是
   * 同一台设备」）。这不是自比：anchor 是该槽的**代表件**（最后一件），被比的是该槽
   * 交付集里的**其余件**，判定时代表件自身被跳过。
   */
  subjectSlots: string[]
  /**
   * 题面要求每件产物上出现几个该主体（#3469 的 OCCM 列）。**可选，绝大多数题不该有它。**
   *
   * 只有题面把数量写成一条可核对的事实时才写（「四个瓶子各出现一次」）。写不出那句话就不要写这个
   * 数 —— 它会让一条来自读数的猜测冒充题面要求。判定见 `subjectSimilarity.scoreSubjectCount`，
   * 它是**诊断列**：只报「几件数对了」，不进任何一致性分数，也不改变本规则的 pass/fail。
   */
  subjectCount?: number
  /**
   * **必填的书面证据**：brief 里要求这条身份约束的那一句原文。
   *
   * 判定不读它。它存在是为了让「这条规则来自题面而不是来自读数」可被 review ——
   * 写不出那句话的规则不该进 spec（见 `identity.ts` 模块头的流程约束）。
   * 加载期强制非空，比写在纪律文档里可靠。
   *
   * ⚠️ **它不进裁判 prompt，别把比较作用面写在这里**（#3592）。作用面是
   * {@link comparisonScope}，那是另一个字段。
   */
  notes: string
  /**
   * 这条规则要拿「哪一部分」比同一性（#3592）。**可选，绝大多数规则不该有它。**
   *
   * ## 它解决的问题
   *
   * 身份模板问的是笼统的「这是不是同一个东西」，「什么算不同」清单里有一条
   * `changed colour identity`。而素材题这一档的定义就是「给定既有物件、在它之上做设计」——
   * 锚是未贴标的空瓶，委托内容正是给它贴标上色。于是**把活干对了会被判成「不是同一个物件」**
   * （实测 QUARTO 两条判定都给了 different，理由都是「参考图是没有标签的透明瓶」）。
   *
   * 写上作用面（"compare only the container form, proportions, clear body and cap;
   * the label, its print and the liquid tint are the design work"）之后，这句话会作为
   * 一段额外指令注入模板。
   *
   * ## 为什么不复用 `notes`
   *
   * `notes` 装的是**题面出处**（v0.1 的 38 条全是 `brief: "..."` 形式的引文）。把它原样注入
   * 等于往裁判耳边塞一句题面引文 —— 那既不是作用面，还会让每一条既有规则的 prompt 都变。
   * 两个字段各自单一职责，`notes` 一个字都不改。
   *
   * ## 不写它的规则，渲染出来的 prompt 逐字节不变
   *
   * 段落整段省略，所以 `cacheSha` 不变、缓存全命中、历史读数一条不动，
   * {@link IDENTITY_PROMPT_TEMPLATE} 本身也没改（评估器身份 `IDENTITY_PROMPT_SHA` 因此不变）。
   * **写了作用面的规则才换问题**，而那正是作者主动声明的一次改动。
   */
  comparisonScope?: string
}

/**
 * 应改集的判据 —— **语义**：转写文本里出现新规格的任一 token。
 *
 * 「任一」而不是「全部」：一次修订会在不同载体上以不同措辞落地（爆炸图上写「无顶盖」、
 * 材料表上写「吸音格栅」），要求全部命中等于要求所有产物用同一套词，那量的是措辞统一性
 * 而不是传播。
 *
 * 这条判据**没有第三态**：`mustUpdate` 是 ground truth 声明的应改集，声明本身已经断言了
 * 这一件必须带上新规格，于是「什么都没提」正是未更新的常态形态。
 */
export interface TextAnyOfEvidence {
  kind: 'text-any-of'
  tokens: string[]
  /** 默认 false。修订 token 多是散文词而非代号；代号类要区分大小写时显式开。 */
  caseSensitive?: boolean
}

/**
 * 应改集的判据 —— 代号型修订（旧值 → 新值），判据与 #3176 的三态**逐格相同**。
 *
 * 这一支有第三态 `silent`（新旧两值都没有 = 这一件不承载该代号），因为它拿得到
 * 「印了旧值」这个正面证据，能把「没改」与「不参与」分开；`text-any-of` 拿不到。
 */
export interface TextVerbatimRevisionEvidence {
  kind: 'text-verbatim'
  oldToken: string
  newToken: string
  /** 默认 true —— 代号类 token 大小写有意义。 */
  caseSensitive?: boolean
}

export type UpdateEvidence = TextAnyOfEvidence | TextVerbatimRevisionEvidence

/**
 * 应不动集的判据 —— **结构**：`refKey`（`artifactId@contentVersion`）仍是冻结基线那一个。
 *
 * 刻意与应改集不对称。精度腿问的是「该不动的动没动」，refKey 未变是充分证据；让它也读内容
 * （「改了但改错了」也算失分）既贵又引入 VLM 噪声，而多出来的分辨力这条腿并不需要。
 * 目前只有一种判据，仍写成带 `kind` 的对象：判据种类是会长的，而 spec 一旦冻结就改不动。
 */
export interface PreserveEvidence {
  kind: 'ref-key-unchanged'
}

/**
 * 修订传播的 ground truth（#3286 定分区，#3287 定判据）。
 *
 * `mustUpdate` / `mustPreserve` 必须**恰好划分**全部槽位：漏掉一个槽会让它同时掉出两条腿，
 * 而那正是「这把尺子看不见什么」最容易被悄悄改进来的形态 —— 没有任何东西会报错。
 *
 * 分区**按内容而不是按拓扑**给定。DISC fixture 里既有「在下游闭包内却应保持」的槽，也有
 * 「在闭包外却应更新」的槽 —— 那是 Block 3 判别力的唯一来源（守卫见
 * `src/lib/agent/eval/__tests__/revisionPartitionCrossCut.test.ts`）。
 */
export interface RevisionSpec {
  /** 这次修订的代号，进读数表头 */
  id: string
  /** 应改集 */
  mustUpdate: string[]
  /** 应不动集。CTRL（全传播对照题）为空数组 —— 精度腿在该题上不可判，不是判 0 */
  mustPreserve: string[]
  updateEvidence: UpdateEvidence
  preserveEvidence: PreserveEvidence
}

/**
 * 前后一致（carry-through）—— 「前期文本里自己写下的决定，后期产物执行了没有」（#3371）。
 *
 * 指南 §2.3 第三层，全篇唯一一条**文献里没有先例**的判据：ViStoryBench / DreamBench++ /
 * OmniContext 判的都是「产物之间像不像」，这一条判的是「产物有没有服从一份更早的文本」。
 *
 * ## 本 issue 只解析，不判定
 *
 * 判定实现另开。字段先落地的理由是**它是写题的前置条件**：252 道题的作者要在 brief 里
 * 写出「先给三个方向、选一个深化」这样的决定链，就必须有地方声明「从哪份文本抽、核对到
 * 哪几件」。字段缺席时作者只能写出旧口径的题，等字段补上之后 252 份全要返工。
 *
 * ## 为什么 `fromSlot` 必须收 document
 *
 * 决定链的源头是文本（策略稿、方向说明），不是图。指向一个只收图的槽，说明这条规则
 * 想抽的东西根本不在那里 —— 加载期拒掉，比跑完之后拿到一列空读数便宜。
 */
export interface CarryThroughRule {
  id: string
  /** 决定的来源槽（文本类）。取其代表件。 */
  fromSlot: string
  /** 需要核对是否执行了该决定的槽。不得包含 `fromSlot` 自身。 */
  toSlots: string[]
  /**
   * 要从来源槽里抽哪几项决定 —— 给提取器看的自然语言项名（"primary color code"、
   * "three keywords"），不是逐字 token（token 要跑完才知道）。合并 #3379 时保留：
   * 没有这一项，规则只说了"要核对决定有没有被执行"，没说核对**哪个**决定。
   */
  extract?: string[]
  /**
   * **必填的书面证据**：brief 里要求这条决定链的那一句原文。
   * 与 {@link IdentityConsistencyRule.notes} 同源纪律 —— 写不出那句话的规则来自读数而非题面。
   */
  notes: string
}

/**
 * 整套成果由视觉模型判的一致性条目（#3371）—— 指南 §2.3 第二层。
 *
 * 措辞借 DRS-Bench 的属性名（typography consistency / stylistic coherence）与
 * DreamBench++ 的概念保持四条，档位压成 0/1/2 与 M3 同量表。
 *
 * 本 issue 只解析不判定，理由同 {@link CarryThroughRule}。
 */
/**
 * 条目的职责（#3552）。闭合枚举，缺省不许猜 —— 与 #3550 同一条纪律。
 *
 * - `consistency`：产物**之间**互相比对（去掉别的件这条就问不成）。这是 M2 这一层要量的东西。
 * - `compliance`：产物与**简报给定的事实**比对（面积、尺寸、街道名、CSV 数值、菜单顺序）。
 *   它与 M1 / `constraints` 是同一件事，**不重复计入 M2**。
 */
export const SET_VLM_ITEM_KINDS = ['consistency', 'compliance'] as const
export type SetVlmItemKind = typeof SET_VLM_ITEM_KINDS[number]

export interface SetVlmRubricItem {
  /** 判定条目的措辞。冻结后不得改字 —— 改一个字就是换了一把尺子。 */
  item: string
  kind: SetVlmItemKind
}

export interface SetVlmRubricRule {
  id: string
  /**
   * 判定条目。裸字符串是旧题包的形状（职责未声明，只进 `unlabelled` 一组）；
   * v0.1.2 起必须写成 {@link SetVlmRubricItem}，由题包 lint 守住。
   */
  items: Array<string | SetVlmRubricItem>
  /** 只对这些槽打分；缺省 = 全部槽。 */
  slots?: string[]
  /**
   * v2：作为既定规范的来源槽，每槽仅取最终代表件的原文及可用图像。
   * 与目标 slots 分开声明，避免把来源自身当作已经执行规范的成果。
   */
  sourceSlots?: string[]
}

/**
 * M3 设计质量清单的选取（#3371）—— 指南 §2.4 与 §4.1。
 *
 * 20 个方向只映射到 7 份清单（Product / Spatial / Graphic / Fashion Styling /
 * Storyboard / Game / Art Design），加信息设计方向的 VisJudge 特例。所以这里记的是
 * **选了哪一份**，不是清单本身 —— 清单是跨题共享的冻结件，不该在 252 份 spec 里各抄一遍。
 *
 * 本 issue 只解析不判定，理由同 {@link CarryThroughRule}。
 */
/** {@link DqRubricSpec.domainFacet} 的闭合枚举；清单内容（含 facet 列表）冻结在 `dqChecklist.ts`，这里只是转出。 */
export type { DqDomainFacet }

/** 清单选择字段的形状由 `dqChecklist.ts` 拥有（`DqChecklistSelection`）；spec 在其上加作用面与 N/A 说明。 */
export interface DqRubricSpec extends DqChecklistSelection {
  /** 已冻结的清单版本，必须是 `DQ_CHECKLIST_VERSIONS` 之一（#3443 起加载期闭合） */
  checklistVersion: string
  /** 打分覆盖的槽；缺省 = 全部图像槽。 */
  slots?: string[]
  /** 该方向额外追加的领域条目措辞。 */
  domainItems?: string[]
  /**
   * 按方向取的清单条目（Qwen-Image-Bench Design Applications；`VisJudge-Bench` 是信息设计
   * 方向的整套替换清单，指南 §4.8）。闭合枚举 —— 合并 #3379 时保留：它的
   * `checklistVersion` 是自由字符串，拼错不会在加载期被发现。
   */
  domainFacet?: DqDomainFacet
  /**
   * 是否加 AesEval-Bench 的 Layout 四子项。版式类成果（deck、内页、信息图）才开。
   * 与 {@link checklistVersion} 正交：清单选的是"打哪个方向的分"，这条选的是"要不要额外
   * 打版式"。合并 #3379 时保留 —— 它的形状表达不了这一项，而 20 道题里有版式类成果。
   */
  layoutExtras?: boolean
  /** 人读的 N/A 规则说明（如 "hero/family: Anatomical Fidelity N/A"），判定不解析。 */
  naRules?: string
}

/** 条目原文（喂给判定模型的就是这一串，`kind` 不进 prompt —— 加标记不改提问）。 */
export function setVlmItemTexts(rule: Pick<SetVlmRubricRule, 'items'>): string[] {
  return rule.items.map((item) => (typeof item === 'string' ? item : item.item))
}

/** 逐条职责；旧题包的裸字符串为 `null`。 */
export function setVlmItemKinds(rule: Pick<SetVlmRubricRule, 'items'>): Array<SetVlmItemKind | null> {
  return rule.items.map((item) => (typeof item === 'string' ? null : item.kind))
}

export interface TaskSpec {
  specVersion: 1 | 2 | 3
  /** v3 将每项公开要求接到实际文件、图文或有身份绑定的人工检查。 */
  requirementChecks?: RequirementCheck[]
  finalSelectionPolicy?: 'explicit-or-last-exported'
  taskId: string
  /** 人类注释，判定不读。用于记下"这份 spec 为什么这样写" */
  notes?: string
  slots: SlotSpec[]
  constraints: Constraint[]
  setConsistency: SetConsistencyRule[]
  /**
   * 身份一致性判据（#3173）。**可选** —— `setConsistency` 是必填，于是全部既有 spec JSON
   * 与测试 fixture 都写死了它；再加一个必填字段会让它们同时失效，而那批改动与本判据无关。
   */
  identityConsistency?: IdentityConsistencyRule[]
  /** 一致性对象类型（指南 §4.1 内部分类）。可选 —— 旧 spec 不声明 */
  subjectType?: SubjectType
  /**
   * 修订传播的 ground truth（#3287）。**可选** —— 只有 revision track 的题有这一段，
   * 创作 track 的 spec 缺席即三条腿全不可判。
   */
  revision?: RevisionSpec
  /**
   * 前后一致（指南 §2.3 第三层）。可选 —— 本 issue 只解析与透传，判定实现另开。
   */
  carryThrough?: CarryThroughRule[]
  /**
   * 整套一致性的视觉模型条目（指南 §2.3 第二层）。可选，语义同上。
   */
  setVlmRubric?: SetVlmRubricRule[]
  /**
   * M3 设计质量清单的选取（指南 §2.4）。可选，语义同上。
   */
  dqRubric?: DqRubricSpec
  /**
   * 色板一致性的判定阈值（#3374，指南 §2.3 第一层）。
   *
   * **可选，且缺席是常态**：色板 ΔE 的读数恒报（它是连续量），但「多大算不一致」
   * 必须由一次校准跑批定出来再写进这里，不能凭推理拍一个。缺席 = 这道题只报数不判，
   * 那是诚实的缺省，不是「判过了且通过」。
   */
  paletteConsistency?: PaletteConsistencySpec
}

/** 色板一致性的阈值声明（#3374）。声明这个字段就等于声明「这道题的阈值已经校准过」。 */
export interface PaletteConsistencySpec {
  /** 两两平均 ΔE00 的上限；超过判 fail */
  maxMeanDeltaE: number
}

/**
 * 加载并校验。**任何不自洽都抛错**，不做宽容修补：
 * 一份写歪的 spec 会让整批读数错得毫无征兆，而它在第一行代码之前就完全可判。
 */
export function loadTaskSpec(file: string): TaskSpec {
  const spec = JSON.parse(fs.readFileSync(file, 'utf-8')) as TaskSpec
  const where = path.basename(file)

  if (![1, 2, 3].includes(spec.specVersion)) throw new Error(`${where}: unsupported specVersion ${spec.specVersion}`)
  if (!spec.taskId) throw new Error(`${where}: missing taskId`)
  if (!Array.isArray(spec.slots) || spec.slots.length === 0) throw new Error(`${where}: slots must be non-empty`)
  if (spec.specVersion === 3) validateRequirementChecks(spec.requirementChecks, spec.slots)
  else if (spec.requirementChecks !== undefined) throw new Error(`${where}: requirementChecks requires specVersion 3`)
  if (spec.finalSelectionPolicy !== undefined && (spec.specVersion !== 3 || spec.finalSelectionPolicy !== 'explicit-or-last-exported')) throw new Error(`${where}: unsupported finalSelectionPolicy`)

  const slotIds = new Set<string>()
  const nonImageKinds = new Set<string>()
  for (const slot of spec.slots) {
    if (slot.deliveryGrouping !== undefined && (spec.specVersion !== 3 || slot.deliveryGrouping !== 'pages' || slot.expected !== 1 || !slot.minPages || !slotAccepts(slot, 'image') || !slotAccepts(slot, 'document'))) throw new Error(`${where}: grouped pages require v3, one document unit, a page floor, and image/document support`)
    if (slotIds.has(slot.id)) throw new Error(`${where}: duplicate slot id "${slot.id}"`)
    slotIds.add(slot.id)
    if (!Number.isInteger(slot.expected) || slot.expected < 1) {
      throw new Error(`${where}: slot "${slot.id}" expected must be a positive integer`)
    }
    if (slot.id === 'unassigned') throw new Error(`${where}: "unassigned" is reserved by the classifier`)
    if (slot.stage !== undefined && !SLOT_STAGES.includes(slot.stage)) {
      throw new Error(`${where}: slot "${slot.id}" stage "${slot.stage}" unknown (expected one of ${SLOT_STAGES.join(', ')})`)
    }
    if (slot.minPages !== undefined) {
      if (!Number.isInteger(slot.minPages) || slot.minPages < 2) {
        throw new Error(`${where}: slot "${slot.id}" minPages must be an integer >= 2 — a floor of 1 excludes nothing`)
      }
      if (!slotAccepts(slot, 'document')) {
        throw new Error(`${where}: slot "${slot.id}" declares minPages but does not accept "document" — page counts only exist on document artifacts`)
      }
    }
    if (slot.mediaKinds !== undefined) {
      if (!Array.isArray(slot.mediaKinds) || slot.mediaKinds.length === 0) {
        throw new Error(`${where}: slot "${slot.id}" mediaKinds must be a non-empty array — a slot that accepts nothing can never be covered`)
      }
      for (const kind of slot.mediaKinds) {
        if (!MEDIA_KINDS.includes(kind)) throw new Error(`${where}: slot "${slot.id}" unknown mediaKind "${kind}"`)
      }
      if (new Set(slot.mediaKinds).size !== slot.mediaKinds.length) {
        throw new Error(`${where}: slot "${slot.id}" repeats a mediaKind`)
      }
    }
    // #3128：`document` 与 `image` 各过一次分类器，故两种槽都可以有多个，且可以是同一个槽
    // （#3138 并列受理）。`video` 仍走 Content-Type 确定性归属 —— 分类器只看得懂静态图，
    // 给视频抽一帧让它分类，量的是"抽的那一帧像不像"而不是"交了没交"。
    if (slotAccepts(slot, 'video')) {
      if (nonImageKinds.has('video')) {
        throw new Error(`${where}: two slots accept "video" — video is assigned by Content-Type and the two cannot be told apart`)
      }
      nonImageKinds.add('video')
    }
    if (slot.core !== undefined) {
      if (typeof slot.core !== 'boolean') throw new Error(`${where}: slot "${slot.id}" core must be a boolean`)
      // 指南 §2.7 是硬规则而不是缺省偏好：两家外部产品的视频通道在我们的环境里都不能用，
      // 且已决定不替它们修，所以视频不进成功判定。允许某道题把它写回 true，等于让那道题
      // 单独按另一套口径判成功率，而成功率是主指标。
      const kinds = slot.mediaKinds ?? ['image']
      if (slot.core === true && kinds.length === 1 && kinds[0] === 'video') {
        throw new Error(
          `${where}: slot "${slot.id}" is video-only and cannot declare core:true — `
          + 'video is excluded from the success verdict for every task (external video pipelines are known-unavailable and deliberately unfixed), '
          + 'so a per-task opt-in would make the primary metric mean different things on different tasks',
        )
      }
    }
  }

  const constraintIds = new Set<string>()
  for (const constraint of spec.constraints ?? []) {
    if (constraintIds.has(constraint.id)) throw new Error(`${where}: duplicate constraint id "${constraint.id}"`)
    constraintIds.add(constraint.id)
    assertScope(where, constraint.id, constraint.scope, slotIds)
    if (constraint.kind === 'pixel-color') {
      // 类型层已禁 true，但 JSON 不过类型 —— 运行期再挡一次
      if ((constraint as { scoring: unknown }).scoring !== false) {
        throw new Error(`${where}: constraint "${constraint.id}" — pixel-color must declare scoring:false (diagnostic only)`)
      }
      if (!/^#[0-9a-fA-F]{6}$/.test(constraint.hex)) throw new Error(`${where}: constraint "${constraint.id}" hex must be #RRGGBB`)
      // 类型层没给 pixel-color 这个字段，但 JSON 不过类型 —— 运行期再挡一次。
      // 一个明说「只作诊断、不计分」的量拿到生杀权，就是悄悄把诊断变成了判据。
      if ((constraint as { critical?: unknown }).critical !== undefined) {
        throw new Error(
          `${where}: constraint "${constraint.id}" — pixel-color cannot declare critical: it is diagnostic-only (scoring:false), `
          + 'and a diagnostic signal must never be able to fail a run',
        )
      }
    } else if (constraint.kind === 'text-verbatim') {
      if (!constraint.text) throw new Error(`${where}: constraint "${constraint.id}" text must be non-empty`)
      // 归一化去掉了全部空白与连接号，"Bar"/"ash" 这种纯字母短 token 会在 sidebar / wash 里
      // 免费命中。数字串与 CJK 不在此列：它们不和英文单词粘连。
      if (/^[A-Za-z]+$/.test(constraint.text.trim()) && constraint.text.trim().length < 4) {
        throw new Error(`${where}: constraint "${constraint.id}" text "${constraint.text}" is a Latin-letter token shorter than 4 characters — it would match inside unrelated words`)
      }
      if (constraint.critical !== undefined && typeof constraint.critical !== 'boolean') {
        throw new Error(`${where}: constraint "${constraint.id}" critical must be a boolean`)
      }
    } else {
      throw new Error(`${where}: unknown constraint kind "${(constraint as { kind: string }).kind}"`)
    }
  }

  for (const rule of spec.setConsistency ?? []) {
    if (rule.kind !== 'token-agreement') throw new Error(`${where}: unknown setConsistency kind "${(rule as { kind: string }).kind}"`)
    if (!rule.token || rule.token.trim().length < 3) {
      throw new Error(`${where}: setConsistency "${rule.id}" token must be at least 3 characters — shorter tokens collide with unrelated text`)
    }
    if (!Number.isInteger(rule.maxEditDistance) || rule.maxEditDistance < 1) {
      throw new Error(`${where}: setConsistency "${rule.id}" maxEditDistance must be a positive integer`)
    }
    // 距离上界不能逼近 token 长度，否则"近似"会退化成"任何东西都算近似"
    if (rule.maxEditDistance * 3 > rule.token.replace(/\s+/g, '').length) {
      throw new Error(
        `${where}: setConsistency "${rule.id}" maxEditDistance ${rule.maxEditDistance} is too large for a `
        + `${rule.token.length}-char token — it would match unrelated text`,
      )
    }
  }

  if (spec.subjectType !== undefined && !SUBJECT_TYPES.includes(spec.subjectType)) {
    throw new Error(`${where}: subjectType "${spec.subjectType}" unknown (expected one of ${SUBJECT_TYPES.join(', ')})`)
  }

  const identityIds = new Set<string>()
  for (const rule of spec.identityConsistency ?? []) {
    if (rule.kind !== 'identity-consistency') {
      throw new Error(`${where}: unknown identityConsistency kind "${(rule as { kind: string }).kind}"`)
    }
    if (identityIds.has(rule.id)) throw new Error(`${where}: duplicate identityConsistency id "${rule.id}"`)
    identityIds.add(rule.id)
    if (!IDENTITY_SUBJECTS.includes(rule.subject)) {
      throw new Error(`${where}: identityConsistency "${rule.id}" unknown subject "${rule.subject}" (expected one of ${IDENTITY_SUBJECTS.join(', ')})`)
    }
    const hasSlotAnchor = rule.anchorSlot !== undefined
    const hasAssetAnchor = rule.anchorAssets !== undefined
    if (hasSlotAnchor === hasAssetAnchor) {
      throw new Error(`${where}: identityConsistency "${rule.id}" must declare exactly one of anchorSlot / anchorAssets`)
    }
    if (hasSlotAnchor && !slotIds.has(rule.anchorSlot as string)) {
      throw new Error(`${where}: identityConsistency "${rule.id}" anchors unknown slot "${rule.anchorSlot}"`)
    }
    assertDeclaredTruthSource(where, 'identityConsistency', rule.id, (rule as { truthSource?: unknown }).truthSource, identityTruthSource(rule))
    if (rule.anchorSelect !== undefined) {
      if (!hasSlotAnchor) throw new Error(`${where}: identityConsistency "${rule.id}" anchorSelect only applies to anchorSlot`)
      if (rule.anchorSelect !== 'representative' && rule.anchorSelect !== 'any') {
        throw new Error(`${where}: identityConsistency "${rule.id}" anchorSelect must be "representative" or "any"`)
      }
    }
    if (hasAssetAnchor) {
      const assets = rule.anchorAssets as unknown
      if (!Array.isArray(assets) || assets.length === 0) {
        throw new Error(`${where}: identityConsistency "${rule.id}" anchorAssets must be a non-empty array`)
      }
      for (const file of assets) {
        // 这把尺子只读栅格图；文件名里不许带路径 —— 锚固定在本题的素材目录下
        if (typeof file !== 'string' || !/^[^/\\]+\.(png|jpe?g|webp)$/i.test(file)) {
          throw new Error(`${where}: identityConsistency "${rule.id}" anchorAssets entry ${JSON.stringify(file)} must be a bare image file name (png/jpg/webp)`)
        }
      }
      if (new Set(assets).size !== assets.length) throw new Error(`${where}: identityConsistency "${rule.id}" repeats an anchor asset`)
    }
    if (!Array.isArray(rule.subjectSlots) || rule.subjectSlots.length === 0) {
      throw new Error(`${where}: identityConsistency "${rule.id}" subjectSlots must be a non-empty array`)
    }
    for (const slotId of rule.subjectSlots) {
      if (!slotIds.has(slotId)) throw new Error(`${where}: identityConsistency "${rule.id}" references unknown slot "${slotId}"`)
    }
    if (new Set(rule.subjectSlots).size !== rule.subjectSlots.length) {
      throw new Error(`${where}: identityConsistency "${rule.id}" repeats a subject slot`)
    }
    // OCCM 的应有数量：写了就必须是正整数。0 表达不了任何题面要求（「不该出现」不是身份一致性），
    // 小数与负数是笔误 —— 静默收下会让 `scoreSubjectCount` 拿一个永远数不到的期望去判每一件
    if (rule.subjectCount !== undefined && (!Number.isInteger(rule.subjectCount) || rule.subjectCount < 1)) {
      throw new Error(`${where}: identityConsistency "${rule.id}" subjectCount must be a positive integer, got ${JSON.stringify(rule.subjectCount)}`)
    }
    // #3592 作用面写了就必须是一句能进 prompt 的话；空串 / 非字符串是笔误，静默收下会让
    // 作者以为自己限定了比较范围，而渲染出来的 prompt 一个字没变 —— 正是本 issue 要消灭的那种沉默
    if (rule.comparisonScope !== undefined && (typeof rule.comparisonScope !== 'string' || rule.comparisonScope.trim().length === 0)) {
      throw new Error(`${where}: identityConsistency "${rule.id}" comparisonScope must be a nonempty sentence when present`)
    }
    // 规则的来源必须可 review。空 notes = 无法证明它不是对着读数写的
    if (typeof rule.notes !== 'string' || rule.notes.trim().length === 0) {
      throw new Error(
        `${where}: identityConsistency "${rule.id}" must carry notes quoting the brief sentence that requires it — `
        + 'a rule with no citable source cannot be shown to come from the task statement rather than from prior readings',
      )
    }
  }

  if (spec.revision !== undefined) assertRevision(where, spec.revision, slotIds)

  assertCarryThrough(where, spec, slotIds)
  assertSetVlmRubric(where, spec, slotIds)
  assertDqRubric(where, spec.dqRubric, slotIds)

  // #3374 色板阈值：写歪的阈值（负数 / 0 / NaN）会让整道题的判定静默失真 ——
  // 0 让每一题都 fail，负数让每一题都 fail 且看不出为什么。加载期就拒
  if (spec.paletteConsistency !== undefined) {
    const max = spec.paletteConsistency.maxMeanDeltaE
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) {
      throw new Error(
        `${where}: paletteConsistency.maxMeanDeltaE must be a positive finite number, got ${JSON.stringify(max)}`,
      )
    }
  }

  return spec
}

/**
 * `carryThrough` 的加载期校验（#3371）。
 *
 * 判定尚未实现，校验先落地 —— 一份写歪的规则在 252 道题冻结之后才发现，代价是整批返工；
 * 而它在第一行判定代码之前就完全可判。这与 {@link loadTaskSpec} 头部注释同一条纪律。
 */
function assertCarryThrough(where: string, spec: TaskSpec, slotIds: ReadonlySet<string>): void {
  const seen = new Set<string>()
  const slotById = new Map(spec.slots.map((slot) => [slot.id, slot]))
  for (const rule of spec.carryThrough ?? []) {
    if (!rule.id) throw new Error(`${where}: carryThrough rule must have an id`)
    if (seen.has(rule.id)) throw new Error(`${where}: duplicate carryThrough id "${rule.id}"`)
    seen.add(rule.id)

    const from = slotById.get(rule.fromSlot)
    if (!from) throw new Error(`${where}: carryThrough "${rule.id}" reads from unknown slot "${rule.fromSlot}"`)
    // 决定链的源头是文本（策略稿 / 方向说明），不是图。指向只收图的槽 = 想抽的东西
    // 根本不在那里，跑完只会拿到一列空读数。
    if (!slotAccepts(from, 'document')) {
      throw new Error(
        `${where}: carryThrough "${rule.id}" reads from slot "${rule.fromSlot}" which does not accept "document" — `
        + 'a decision to carry through is written text, so its source slot must be able to hold a document',
      )
    }

    if (!Array.isArray(rule.toSlots) || rule.toSlots.length === 0) {
      throw new Error(`${where}: carryThrough "${rule.id}" toSlots must be a non-empty array`)
    }
    for (const slotId of rule.toSlots) {
      if (!slotIds.has(slotId)) throw new Error(`${where}: carryThrough "${rule.id}" references unknown slot "${slotId}"`)
    }
    if (new Set(rule.toSlots).size !== rule.toSlots.length) {
      throw new Error(`${where}: carryThrough "${rule.id}" repeats a target slot`)
    }
    // 自比不是传播：一份文本对自己永远一致，那一格恒 pass 而毫无信息
    if (rule.toSlots.includes(rule.fromSlot)) {
      throw new Error(
        `${where}: carryThrough "${rule.id}" lists its own source slot "${rule.fromSlot}" as a target — `
        + 'a text is always consistent with itself, so that cell would pass unconditionally',
      )
    }
    // 与 identityConsistency 同源纪律：写不出题面那句话的规则来自读数而不是题面
    if (typeof rule.notes !== 'string' || rule.notes.trim().length === 0) {
      throw new Error(
        `${where}: carryThrough "${rule.id}" must carry notes quoting the brief sentence that requires it — `
        + 'a rule with no citable source cannot be shown to come from the task statement rather than from prior readings',
      )
    }
  }
}

/** `setVlmRubric` 的加载期校验（#3371）。判定尚未实现，理由同 {@link assertCarryThrough}。 */
function assertSetVlmRubric(where: string, spec: TaskSpec, slotIds: ReadonlySet<string>): void {
  const seen = new Set<string>()
  for (const rule of spec.setVlmRubric ?? []) {
    if (!rule.id) throw new Error(`${where}: setVlmRubric rule must have an id`)
    if (seen.has(rule.id)) throw new Error(`${where}: duplicate setVlmRubric id "${rule.id}"`)
    seen.add(rule.id)
    if (!Array.isArray(rule.items) || rule.items.length === 0) {
      throw new Error(`${where}: setVlmRubric "${rule.id}" items must be a non-empty array — a rubric with no items scores nothing`)
    }
    for (const item of rule.items) {
      // 裸字符串 = 旧题包（职责未声明）；对象形 = v0.1.2 起的形状，`kind` 必须是闭合枚举里的一个。
      // 「必须写 kind」不在这里强制 —— 那是题包 lint 的事（#3552），旧版本仍要能加载。
      if (typeof item === 'string') {
        if (item.trim().length === 0) throw new Error(`${where}: setVlmRubric "${rule.id}" has an empty item`)
        continue
      }
      if (item === null || typeof item !== 'object' || typeof item.item !== 'string' || item.item.trim().length === 0) {
        throw new Error(`${where}: setVlmRubric "${rule.id}" has an empty item`)
      }
      if (!SET_VLM_ITEM_KINDS.includes(item.kind)) {
        throw new Error(
          `${where}: setVlmRubric "${rule.id}" item kind "${item.kind}" unknown `
          + `(expected one of ${SET_VLM_ITEM_KINDS.join(', ')})`,
        )
      }
    }
    for (const slotId of rule.slots ?? []) {
      if (!slotIds.has(slotId)) throw new Error(`${where}: setVlmRubric "${rule.id}" references unknown slot "${slotId}"`)
    }
    if (rule.sourceSlots !== undefined) {
      if (spec.specVersion < 2) throw new Error(`${where}: setVlmRubric "${rule.id}" sourceSlots requires specVersion 2 or later`)
      if (!Array.isArray(rule.sourceSlots) || rule.sourceSlots.length === 0) {
        throw new Error(`${where}: setVlmRubric "${rule.id}" sourceSlots must be a non-empty array`)
      }
      if (new Set(rule.sourceSlots).size !== rule.sourceSlots.length) throw new Error(`${where}: setVlmRubric "${rule.id}" repeats a source slot`)
      if (!Array.isArray(rule.slots) || rule.slots.length === 0 || new Set(rule.slots).size !== rule.slots.length) {
        throw new Error(`${where}: setVlmRubric "${rule.id}" sourceSlots requires explicit, non-empty, unique target slots`)
      }
      for (const slotId of rule.sourceSlots) {
        const slot = spec.slots.find(candidate => candidate.id === slotId)
        if (slot === undefined) throw new Error(`${where}: setVlmRubric "${rule.id}" references unknown source slot "${slotId}"`)
        if (slot.expected !== 1) throw new Error(`${where}: setVlmRubric "${rule.id}" source slot "${slotId}" must have expected 1`)
        if (!slotAccepts(slot, 'image') && !slotAccepts(slot, 'document')) throw new Error(`${where}: setVlmRubric "${rule.id}" source slot "${slotId}" must accept image or document`)
        if (rule.slots.includes(slotId)) throw new Error(`${where}: setVlmRubric "${rule.id}" source and target slots overlap at "${slotId}"`)
      }
      for (const slotId of rule.slots) {
        if (!slotAccepts(spec.slots.find(slot => slot.id === slotId)!, 'image')) {
          throw new Error(`${where}: setVlmRubric "${rule.id}" target slot "${slotId}" must accept images; document/video evidence needs a separate rule`)
        }
      }
    }
  }
}

/** `dqRubric` 的加载期校验（#3371 落字段，#3443 把 `checklistVersion` 闭合到冻结清单）。 */
function assertDqRubric(where: string, rubric: DqRubricSpec | undefined, slotIds: ReadonlySet<string>): void {
  if (rubric === undefined) return
  if (typeof rubric.checklistVersion !== 'string' || !isDqChecklistVersion(rubric.checklistVersion)) {
    throw new Error(
      `${where}: dqRubric.checklistVersion "${String(rubric.checklistVersion)}" is not a frozen checklist `
      + `(expected one of ${DQ_CHECKLIST_VERSIONS.join(', ')}) — the checklist is a shared frozen artifact `
      + 'and the spec records which one was used, not its contents',
    )
  }
  for (const slotId of rubric.slots ?? []) {
    if (!slotIds.has(slotId)) throw new Error(`${where}: dqRubric references unknown slot "${slotId}"`)
  }
  if (rubric.domainFacet !== undefined && !DQ_DOMAIN_FACETS.includes(rubric.domainFacet)) {
    throw new Error(`${where}: dqRubric.domainFacet "${rubric.domainFacet}" unknown (expected one of ${DQ_DOMAIN_FACETS.join(', ')})`)
  }
  if (rubric.layoutExtras !== undefined && typeof rubric.layoutExtras !== 'boolean') {
    throw new Error(`${where}: dqRubric.layoutExtras must be a boolean`)
  }
  for (const item of rubric.domainItems ?? []) {
    if (typeof item !== 'string' || item.trim().length === 0) throw new Error(`${where}: dqRubric has an empty domainItem`)
  }
}

/**
 * 修订分区的自洽性 —— **恰好划分全部槽位**。
 *
 * 不是洁癖：一个既不在 `mustUpdate` 也不在 `mustPreserve` 的槽会同时掉出召回腿和精度腿，
 * 于是「这一槽被怎么处理都不影响读数」，而读表的人看到的仍是一个像是覆盖全题的百分比。
 * 分区是 ground truth，ground truth 不允许有沉默的洞。
 */
function assertRevision(where: string, revision: RevisionSpec, slotIds: ReadonlySet<string>): void {
  if (!revision.id) throw new Error(`${where}: revision must carry an id`)
  for (const [field, ids] of [['mustUpdate', revision.mustUpdate], ['mustPreserve', revision.mustPreserve]] as const) {
    if (!Array.isArray(ids)) throw new Error(`${where}: revision.${field} must be an array`)
    for (const slotId of ids) {
      if (!slotIds.has(slotId)) throw new Error(`${where}: revision.${field} references unknown slot "${slotId}"`)
    }
  }
  const partitioned = [...revision.mustUpdate, ...revision.mustPreserve]
  if (new Set(partitioned).size !== partitioned.length) {
    throw new Error(`${where}: revision partitions overlap — a slot cannot be both mustUpdate and mustPreserve`)
  }
  const missing = [...slotIds].filter((slotId) => !partitioned.includes(slotId))
  if (missing.length > 0) {
    throw new Error(
      `${where}: revision leaves slot(s) unpartitioned: ${missing.join(', ')} — `
      + 'an unlisted slot falls out of both legs and can be handled any way at all without moving the reading',
    )
  }

  const evidence = revision.updateEvidence
  if (evidence?.kind === 'text-any-of') {
    if (!Array.isArray(evidence.tokens) || evidence.tokens.length === 0) {
      throw new Error(`${where}: revision.updateEvidence.tokens must be a non-empty array`)
    }
    for (const token of evidence.tokens) {
      // 与 setConsistency 同一条：太短的 token 会撞上无关文字，让「更新了」变成免费的
      if (typeof token !== 'string' || token.trim().length < 2) {
        throw new Error(`${where}: revision.updateEvidence token ${JSON.stringify(token)} must be at least 2 characters`)
      }
    }
  } else if (evidence?.kind === 'text-verbatim') {
    if (!evidence.oldToken || !evidence.newToken) {
      throw new Error(`${where}: revision.updateEvidence must carry both oldToken and newToken`)
    }
    if (evidence.oldToken === evidence.newToken) {
      throw new Error(`${where}: revision.updateEvidence oldToken equals newToken — every artifact would read as updated`)
    }
  } else {
    throw new Error(`${where}: unknown revision.updateEvidence kind "${(evidence as { kind?: string } | undefined)?.kind}"`)
  }
  if (revision.preserveEvidence?.kind !== 'ref-key-unchanged') {
    throw new Error(`${where}: unknown revision.preserveEvidence kind "${(revision.preserveEvidence as { kind?: string } | undefined)?.kind}"`)
  }
}

/**
 * {@link IdentityConsistencyRule.subject} 的闭合枚举。JSON 不过类型，运行期再挡一次。
 * 素材入库自检（#3428 的 `setSubject`）按同一份词表声明主体，两处同源。
 */
export const IDENTITY_SUBJECTS: ReadonlyArray<IdentityConsistencyRule['subject']> = ['logo', 'product', 'character', 'palette', 'space']

/**
 * 一条身份规则的**理论最大 pair 数** = Σ over subjectSlots 的 `expected`。
 *
 * 导出给加载期日志用：pair 数直接等于双图调用次数，而那是真金白银。作者在**冻结之前**
 * 就该看得见自己签了多大的账 —— 这不是运行期上界（上界是一个旋钮，且会静默截断读数），
 * 是一次知情披露。
 */
export function maxIdentityPairs(spec: TaskSpec, rule: IdentityConsistencyRule): number {
  const expectedBySlot = new Map(spec.slots.map((slot) => [slot.id, slot.expected]))
  // 锚的数量：素材锚 = 文件数；any 锚 = anchor 槽的 expected；缺省 = 1（代表件）
  const anchorCount = rule.anchorAssets !== undefined
    ? rule.anchorAssets.length
    : rule.anchorSelect === 'any' ? (expectedBySlot.get(rule.anchorSlot ?? '') ?? 1) : 1
  const subjectCount = rule.subjectSlots.reduce(
    // anchor 槽自身在列时，锚件不与自己比，故减去锚的件数
    (sum, slotId) => sum + (expectedBySlot.get(slotId) ?? 0) - (slotId === rule.anchorSlot ? anchorCount : 0),
    0,
  )
  return Math.max(0, subjectCount) * anchorCount
}

/**
 * 写题提示（#3434）—— **不是校验**：不抛错、不 `console.warn`，只返回文本，由调用方决定打不打。
 *
 * 唯一一条规则：`anchorSlot` 指向 `expected > 1` 的槽却没写 `anchorSelect`。缺省「代表件」是给
 * 定稿槽设计的；锚槽装的是「N 件不同对象」（六件首饰、三个模块）时，缺省会把「被比件是不是
 * 这 N 件之一」错判成「是不是最后那一件」，而且错得静默 —— 加载不报，判定给出看似合理的 reason。
 *
 * 为什么不做成加载期错误：11 道已跑批次的冻结 spec（product / space / motion）也有多件锚槽，
 * 它们的语义是「同一对象的多视图」、缺省正确，改它们会让 spec 与已跑读数脱节。为什么不
 * `console.warn`：单测反复加载全部 spec 会刷屏，冻结 spec 永远告警、无人看。
 * da 语料由 `daCorpusLint.test.ts` 强制 lint 为空；冻结 spec 不进那条断言。
 */
export function lintTaskSpec(spec: TaskSpec): string[] {
  const expectedBySlot = new Map(spec.slots.map((slot) => [slot.id, slot]))
  const hints: string[] = []
  for (const rule of spec.identityConsistency ?? []) {
    if (rule.anchorSlot === undefined || rule.anchorSelect !== undefined) continue
    const slot = expectedBySlot.get(rule.anchorSlot)
    if (slot === undefined || slot.expected <= 1) continue
    hints.push(
      `identityConsistency "${rule.id}": anchorSlot "${rule.anchorSlot}" (${slot.label}) expects ${slot.expected} items `
      + 'but declares no anchorSelect — the default compares against the LAST item only. '
      + 'Write anchorSelect: "any" when the slot holds N different objects (match any of them), '
      + 'or anchorSelect: "representative" to state explicitly that every item is one object seen from different views.',
    )
  }
  return hints
}

function assertScope(where: string, id: string, scope: ConstraintScope, slotIds: ReadonlySet<string>): void {
  if (scope === '*') return
  if (!scope || !Array.isArray(scope.slots) || scope.slots.length === 0) {
    throw new Error(`${where}: constraint "${id}" scope must be "*" or { slots: [...], select: "all" | "representative" }`)
  }
  if (scope.select !== 'all' && scope.select !== 'representative') {
    throw new Error(`${where}: constraint "${id}" scope.select must be "all" or "representative"`)
  }
  for (const slotId of scope.slots) {
    if (!slotIds.has(slotId)) throw new Error(`${where}: constraint "${id}" scopes unknown slot "${slotId}"`)
  }
}
