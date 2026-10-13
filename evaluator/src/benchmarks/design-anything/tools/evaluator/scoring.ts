/**
 * 判定逻辑（#3109）—— **纯函数、无 I/O**，视觉调用的结果由调用方喂进来。
 *
 * 这样切的理由不是"好测"，是**尺子必须能在不联网的情况下复算**：一批 evaluation.json
 * 出了争议时，拿缓存里的分类/转写重跑这些函数就能逐条复核，不需要重新相信一次模型。
 *
 * ## 三条口径（首跑实测后重定，见 issue #3109 的评论）
 *
 * 1. 完成度 = **槽位覆盖率**，不是文件计数 —— 三臂产物逐件同构，文件计数读出 0pp
 * 2. 硬约束 = 转写文本的**精确子串匹配**，像素法只进诊断
 * 3. 同槽多件**合法**（品牌方案给多个 logo 备选是专业常规，且三臂对称），超出的进 alternatives
 *
 * @module benchmarks/design-anything/tools/evaluator/scoring
 */

import { slotAccepts, slotIsCore, type Constraint, type MediaKind, type SetConsistencyRule, type SlotSpec, type TaskSpec } from './taskSpec'
import type { CarryThroughVerdict } from './carryThrough'
import type { DeliveryProvenance, DeliveryTier } from '../deliveryTier'
import type { IdentityVerdict } from './identity'
import type { SetVlmRubricVerdict } from './setRubric'
import { scorePaletteConsistency, scoreStyleConsistency, type PaletteConsistencyVerdict, type StyleConsistencyVerdict } from './setSimilarity'
import type { DesignQualityResult } from './designQuality'
import {
  scoreNonRegression,
  scoreRevisionSatisfied,
  type RevisionMutationInput,
  type RevisionVerdict,
} from './revision'

/** 一件参与计分的产物（= manifest 里 `role === 'primary'` 的文件），保持 `files[]` 原序。 */
export interface ScoredArtifact {
  /** v3 的公开定稿指定；未指定的历史产物保持旧选择逻辑。 */
  finalSelection?: 'selected' | 'candidate'
  /** 原文件解码所得页数；分开的PDF页与整本文档使用同一作品分组。 */
  documentPages?: number
  file: string
  contentType: string
  /**
   * 分类器判定的槽位；`unassigned` = 不属于任何槽。
   *
   * ⚠️ 只看这个字段读不出「为什么不属于」。**量尺说「它不属于任何槽」和量尺说「我没测出来」
   * 在这里是同一个字符串**，成因由 {@link ScoredArtifact.unassignedCause} 分开记（#3488）。
   */
  slot: string
  /**
   * `slot === 'unassigned'` 的**非模型成因**（#3488）。缺席 = 这是量尺的正式回答
   * （分类 prompt 明写 `unassigned` 是合法选项，第二段再分配同样允许它）。
   *
   * 四种成因都不是「系统没交这一件」，而是「这一件没被测到」：
   *
   * | 值 | 含义 |
   * |---|---|
   * | `classifier-unknown-slot` | 量尺回了一个 spec 里不存在的槽 id，且换个问法重问仍不成立 |
   * | `page-floor` | **v1.11 起不再产生**（#3803）：页数下限不再决定归属。留着这个取值是因为 `diagnostics.unassignedCauses` 是跨版本读的格式，compareArms 要用它读懂更早的包；新包里它恒为 0，那是真话 |
   * | `classify-failed` | 分类调用彻底失败（重试后仍拿不到可解析回复），或该件没有可用证据 |
   * | `content-type` | 非图像件按 Content-Type 确定性归属时，没有任何槽接受这种载体 |
   *
   * **为什么必须分开记。** 混在一起时「未归槽率」会被读成能力差距，而它实际上随
   * 交付形态（网页 deck / 大图 / 无页数的 markdown）系统性偏移 —— 谁的形态离量尺的
   * 假设越远谁扣得越狠，这类偏差加大样本量也消不掉。
   */
  unassignedCause?: UnassignedCause
  /**
   * 回退重判的留档（#3488）。只在第一段的答案被规则挡下、并因此换个问法重问过时出现。
   * `resolved` = 重问后落到的槽（`unassigned` 表示重问后仍无归属）。
   */
  reclassification?: { from: string; cause: UnassignedCause; resolved: string; reason: string }
  classifierConfidence: 'high' | 'low'
  classifierReason: string
  /** 逐字转写出的可见文字行 */
  textLines: string[]
  /**
   * 转写彻底失败（重试后仍拿不到可解析回复）。
   *
   * 这一件**不参与任何逐字约束的判定** —— 读不出来时把它当成"什么都没写"会判出
   * 一条根本没发生的违规，那是拿仪器故障冒充被测对象的缺陷。它只出现在 needsManualCheck 里。
   */
  transcriptionFailed?: boolean
  /**
   * {@link transcriptionFailed} 的**成因**（#3590）。同 `slot: 'unassigned'` + `unassignedCause`
   * 的写法：布尔量是行为开关（这一件退出逐字作用面），成因另记，两者不是重复状态。
   *
   * | 值 | 含义 |
   * |---|---|
   * | `call-failed` | 转写调用发出去了、重试后仍拿不到可解析回复 —— 仪器故障 |
   * | `no-transcript-carrier` | 这条证据面上根本没有转写这一步（视频 / 音频 / 结构判据面） |
   *
   * 缺席 = 未标注成因（文档通道的不完整读取），诊断里按 `call-failed` 措辞。
   * 分开记的理由与 #3488 同条：把「没测」写成「测了没有」会让读者把载体差异读成能力差距。
   */
  transcriptionAbsence?: 'call-failed' | 'no-transcript-carrier'
  /**
   * 这件成果是怎么来的（#3444）——**由导出/导入侧登记，评估器只读**。
   *
   * `undefined` 有两种来源，评估器都记 `unknown`：这一列对该件不适用（文本 / PDF），
   * 或者这是 v12 及更早的旧包。缺席**不等于** `generated`。
   */
  provenance?: DeliveryProvenance
  /** 像素采样命中（诊断用，不计分） */
  pixelHits: Record<string, boolean>
  /**
   * 第一段（逐件独立分类）的槽（#3407）。只在第二段改过这一件的槽时写；未写 = 与 `slot` 相同。
   * 留着它是为了让「第二段把它从哪搬到哪」事后可核。
   */
  stage1Slot?: string
  /**
   * 归槽求解的留档（#3541，见 `assignment.ts`）。只在**图像归属面**（图像通道 / 结构判据面）
   * 出现；文档通道仍走逐件裁定，没有这一段。
   *
   * `preferred` 是「只看分数、不看容量」会给出的槽 —— 也就是 #3541 之前逐件独立判的答案。
   * `preferred !== slot` 的件就是被容量约束挪开的那些，**改动前后的对照可以在同一次运行里读出来**，
   * 不必两批对跑。
   */
  assignment?: {
    /** 该件对每个候选槽的分数（0..100），只含分类器实际给过分的槽 */
    scores: Record<string, number>
    /** 「哪个槽都不属于」的分数，与上面同尺度 */
    unassignedScore: number
    preferred: string
    /** `seat` = 占了正式席位；`overflow` = 席位已满、作为多余件挂靠；`unassigned` = 散件 */
    placement: 'seat' | 'overflow' | 'unassigned'
    displaced: boolean
    /** 分类器没按打分形态回复，按单槽形态降级收下 —— 那一件退化成逐件独立判，必须可数 */
    degraded?: 'legacy-single-slot'
    /** 回复里出现过但本题不存在的槽名。不参与求解，只留档 */
    unknownSlots?: string[]
  }
  /**
   * 第二段集合内再分配对这一件的裁定（#3407，见 `redistribute.ts`）。`from === to` 表示留在原槽
   * 但被声明为 `alternateOf` 某件的候选稿；`alternateOf` 记模型声明的「这是哪一件的候选稿」。
   */
  redistribution?: { from: string; to: string; reason: string; alternateOf?: string }
}

/**
 * 见 {@link ScoredArtifact.unassignedCause}。
 *
 * `deck-page`（#3540）与其它四档不同源：那四档说的是「问了，但没问出结果」，
 * 这一档说的是「**规则上就不该问**」—— deck 页是对作品的**引用**，不是作品本身。
 * 把作品放进汇报里和交出作品是两件事：前者只能证明后者存在过，不能替代它。
 */
export type UnassignedCause = 'classifier-unknown-slot' | 'page-floor' | 'classify-failed' | 'content-type' | 'deck-page'

export interface PageFloorRejection {
  /** 判的是哪个槽的下限 */
  slot: string
  floor: number
  /** 实际页数；`null` = 页数不可知（网页、逐页图、损坏的 PDF） */
  pages: number | null
  reason: 'unknown-page-count' | 'below-floor'
}

/** 一个有页数下限的槽，在它的**交付集**上的页数结论（#3803）。判定见 {@link scorePageFloors}。 */
export interface PageFloorVerdict {
  slotId: string
  floor: number
  /** 该槽的阶段。只有 `final`（最终汇报）那些进 M1 的合取 —— 过程稿本来就是一两页的表 */
  stage?: SlotSpec['stage']
  /** 页数够的件 */
  met: string[]
  /** 页数读得出、就是不够的件 —— **真读数** */
  below: Array<{ file: string; pages: number }>
  /** 页数读不出来的件 —— **格式差异**，不是「不够」 */
  unmeasured: string[]
}

/**
 * #3126 页数下限的**唯一**判定点。判的是「这一件够不够这个槽的页数下限」：
 * 槽没设下限 → 满足；页数不可知 → 不满足（如实的"证明不了"）；页数低于下限 → 不满足。
 * 返回值同时给出原因，供读数按"不可知 / 不足"分开计数。
 *
 * **它不再决定归属**（#3803）。唯一的调用点是 {@link scorePageFloors}，也就是
 * 「这一件交进来了，形态达不达标」那一列 —— 归槽阶段一行页数逻辑都没有。
 */
export function applyPageFloor(slotId: string, floor: number | undefined, pages: number | undefined): { accepted: boolean; rejection?: PageFloorRejection } {
  if (floor === undefined) return { accepted: true }
  if (pages === undefined) return { accepted: false, rejection: { slot: slotId, floor, pages: null, reason: 'unknown-page-count' } }
  if (pages < floor) return { accepted: false, rejection: { slot: slotId, floor, pages, reason: 'below-floor' } }
  return { accepted: true }
}

export interface SlotVerdict {
  slotId: string
  expected: number
  /** 判入该槽的全部产物（原序） */
  matched: string[]
  /**
   * **计入交付集**的那些件（原序）。
   *
   * 约束核查只看这些，不看候选稿：一份被弃用的 logo 草案上没写全品牌名，不是交付缺陷。
   * 取法（#3438）：先把第二段声明为「某件的候选稿」的件（{@link SlotVerdict.declaredAlternates}）
   * 挑出去，其余主件里取**最后 `expected` 件**；主件不够时再用声明替代件的尾部补足，
   * 使 `|delivered| = min(matched, expected)` 恒成立（完成度不因分组而变）。
   * 「最后 N 件」而不是「前 N 件」，同 {@link SlotVerdict.representative} 的理由。
   */
  delivered: string[]
  /**
   * 代表件 = `delivered` 的**最后一件**（`files[]` 顺序 = 节点创建序 = 系统最后收敛到的那一件，#3113）。
   *
   * #3438 之前是 `matched` 的最后一件。差别只在有第二段 `alternateOf` 声明时：被量尺明说是
   * 「某件的候选稿」的件不再仅因为生成得晚就当上代表件（arch-01 的视频截帧曾因此顶掉真外景图，
   * 让 critical 约束 `project` 判 fail）。有更强的证据就不再用生成顺序这条弱证据。
   */
  representative: string | null
  /** 不在交付集里的部分（原序）。**不扣分**，只记录 */
  alternatives: string[]
  /**
   * 第二段（`redistribute.ts`）声明为「本槽另一件的候选稿」的件：`redistribution.alternateOf`
   * 指向本槽 `matched` 里的另一件。诊断字段，不计分；指向他槽的声明不算（被搬走的件会出现
   * 这种形态——它的 alternateOf 只做过越界检查，目标可能留在了原槽）。第一段形态下恒为空。
   */
  declaredAlternates: string[]
  covered: boolean
}

export interface ConstraintVerdict {
  constraintId: string
  kind: Constraint['kind']
  scoring: boolean
  verdict: 'pass' | 'fail' | 'not-applicable'
  /**
   * 不通过是哪一种（#3819）。**只在 `verdict === 'fail'` 时出现** —— 有 `failCause`
   * 必须等价于「这条不通过」，否则下一个人会拿它当「有成因 = 没判掉」来数。
   *
   * - `scope-empty`：作用面的槽一件没交。此前判 `not-applicable` 退出分母（#3109），
   *   #3819 起算不通过 —— 理由见 {@link scoreConstraints}。
   * - `text-absent`：交了，但那个词没落在产物上。这是本尺子原本要抓的那种缺陷。
   *
   * 两者合成一个 `fail` 就看不出「没交」与「写错了」的差别，所以分开记而**不是**
   * 分开退出分母 —— 退出分母正是 #3819 要消灭的东西。
   */
  failCause?: 'scope-empty' | 'text-absent'
  /** 逐文件证据：命中/未命中，以及未命中时该文件转写到的相近串 */
  evidence: Array<{ file: string; hit: boolean; sawInstead?: string[] }>
}

export interface SetConsistencyVerdict {
  ruleId: string
  verdict: 'pass' | 'fail' | 'not-applicable'
  /** brief 里逐字给定的那个 token */
  token: string
  /** 逐字写对了的件数 */
  exactHits: number
  /** 写坏了的件 —— 判 fail 的全部证据，逐件给出实际读到的那一段与距离 */
  nearMisses: Array<{ file: string; saw: string; distance: number }>
  /**
   * 被 M1 减掉的件（#3518）—— 同一个 token 上已有 `text-verbatim` 约束查过它们。
   *
   * 记下来是为了让「这条为什么 not-applicable」不必反推：作用面被减光与一件都没提到这个词，
   * 在读数上都是 `not-applicable`，成因完全不同。可选：#3518 之前的 evaluation.json 没有它。
   */
  m1Covered?: string[]
}

export interface RunScore {
  slots: SlotVerdict[]
  /**
   * **主判定量**（2026-08-23 阶段①试跑后改的操作化定义）：
   * `Σ min(matched, expected) / Σ expected`。
   *
   * 原本只有下面的二值 `slotCoverage`（槽被至少一件覆盖即 100%）。阶段①实测 `bench-brand-02`
   * 的 promo 槽 **expected 3 只交了 2**，二值口径照样读 4/4 = 100% —— 少交三分之一在主判定量上
   * 完全不可见。而"知道自己还欠什么"恰恰是本实验要测的东西，那正是这一档刻度所在。
   *
   * `min` 是刻意的：多交（候选稿）不加分，`alternatives` 另行记录。
   */
  deliverableCompletion: {
    delivered: number
    expected: number
    rate: number
    /**
     * 第二个分母（#3952）：{@link completionUnmeasurable} 列出的槽（差件、且差在量尺没读出来）
     * **整槽退出分母**后的完成率。`rate` 一个字不变、仍是主读数的历史口径；两者并排印，
     * 差值就是「量尺读不出」被记成「系统没交」的规模。全部席位都不可判时为 null。
     */
    rateMeasurable: number | null
    /** 退出分母的席位数 = 被列出的那些槽的 `expected` 之和 */
    unmeasurableExpected: number
  }
  /**
   * {@link deliverableCompletion} 的**诊断伴随列**（#3782）：差件的槽里，哪些差在
   * 「尺子没读出来」而不是「系统没交」。
   *
   * ## 它不改完成度，这是刻意的
   *
   * `deliverableCompletion.rate` 的算法一个字未动。改分母会让全部历史批次的读数漂移，
   * 且漂移幅度对不同交付形态不均等 —— 正是本评估器反复声明要避免的偏差。
   * 「要不要扣除、怎么扣除」是读表人的判断，不是评估器替他做的算术。
   *
   * 判据复用 {@link slotIsUnmeasurable}，与 `m1Success.unmeasurableSlots` 同源（#3677）。
   * 两处的**分母不同**：那里只看 core 槽，这里看全集 —— 各自忠实于自己那一列的分母。
   *
   * ## 口径跟完成度，不跟 m1Success
   *
   * `scoreM1Success` 在 `measurementValid === false` 时提前返回、列表为空；而
   * `deliverableCompletion` 根本不看那个字段。本列是完成度的伴随列，**measurement 无效时
   * 照常列出**。一列数和它的诊断列用不同的门，读表人无法把两者对起来。
   *
   * ## 为什么每个槽要记下「是哪几件产物」
   *
   * `slotIsUnmeasurable` 是**存在量词**：一件读不出页数的 markdown 会让同题里每一个收文档的
   * 缺件槽都被列出来。这个宽口径是 #3677 为一个布尔判定刻意选的，本列沿用它 —— 但沿用的前提是
   * **让读表人看得见宽到什么程度**。所以 {@link artifactCount}（去重后的未测产物件数）与
   * {@link count}（被列出的槽数）并排：两者的差就是超额归因的规模。
   * 拿本列去估「实际完成度应该是多少」时，`artifactCount` 是保守的那一侧。
   */
  completionUnmeasurable: {
    /** 每个被列出的槽，以及让它被列出的那些产物（按 `artifacts[]` 原序） */
    slots: Array<{ slot: string; artifacts: string[] }>
    /** `slots.length` —— **槽数**，不是席位数 */
    count: number
    /** 去重后的未测产物件数。与 {@link count} 的差 = 超额归因的规模 */
    artifactCount: number
  }
  /**
   * **形态达标率**（#3803）—— 与 {@link deliverableCompletion} 并排的第二列。
   *
   * 完成度过去一个数回答了两个问题：这件东西做了没有、它的形式对不对。两者失败时给出
   * 同一个数字，读表人分不出是哪一种。页数下限从归槽的门降为读数之后，完成度只答第一个，
   * 这一列答第二个。
   *
   * 定义域是**有页数下限的槽的交付集**（`slots[].minPages`，`deliveryGrouping: 'pages'`
   * 的槽除外 —— 那里的 `minPages` 是席位数不是页数下限）。
   *
   * `unmeasured` **不进分母**，这是刻意的：页数读不出来的件不是「不达标」，是「没测过」。
   * 把它算进分母等于把交付形态的差异（markdown / docx / 网页 deck 没有页数这个概念）
   * 读成能力差异 —— 那正是本 issue 要拆开的那种混读。三个数并排报，读表人自己看比例。
   */
  formatCompliance: {
    /** 页数达标的件数 */
    met: number
    /** 判得出结论的件数（达标 + 页数不足）。**不含页数读不出的件** */
    applicable: number
    rate: number
    /** 页数读不出来的件数 —— 格式差异，单独报 */
    unmeasured: number
    /** 逐槽留档，供离线复算 */
    slots: PageFloorVerdict[]
  }
  /** 二值槽位覆盖率 —— 并列保留，粒度更粗但与首轮读数同口径 */
  slotCoverage: { covered: number; total: number; rate: number }
  constraints: ConstraintVerdict[]
  constraintPassRate: { passed: number; applicable: number; rate: number }
  setConsistency: SetConsistencyVerdict[]
  /**
   * 跨产物**身份**一致性（#3173）—— 补 OCR 盲区的那一维。
   *
   * 由调用方喂入（需要双图调用，不是纯函数可得）；缺省空数组。判定逻辑在
   * `evaluator/identity.ts`，那里是纯函数、可离线复算。
   *
   * ⚠️ **κ 未达标前它只进 compareArms 的诊断段**，不进 `PreregisteredDeltas`：
   * 身份判定比槽位分类主观得多，没有人工背书的 VLM 判定在审稿里守不住。
   */
  identityConsistency: IdentityVerdict[]
  /**
   * M2 第二层：整套视觉一致性条目判定（#3441）。由调用方喂入（需要多图调用），缺省空数组；
   * 判定逻辑在 `evaluator/setRubric.ts`，纯函数可离线复算。
   * ⚠️ 与身份尺同纪律：**κ 未达标前只进 compareArms 的诊断段**，不进 `PreregisteredDeltas`。
   */
  setVlmRubric: SetVlmRubricVerdict[]
  /**
   * 色板一致性（#3374，指南 §2.3 第一层）—— **M2 里唯一一条不依赖模型判断的读数**。
   *
   * 由调用方喂入（需要解图取像素，不是纯函数可得）。判定逻辑在
   * `evaluator/setSimilarity.ts`，那里是纯函数、可离线逐位复算。
   *
   * 它的价值不在于比模型判得准，在于**可复现、可被第三方拿同一批产物复算**。
   * `identityConsistency` 实测不是确定性的（同一对逐字节相同的图两次判出不同结果），
   * 整个 M2 不能全建在那种基础上。
   */
  paletteConsistency: PaletteConsistencyVerdict
  /**
   * CSD 风格自相似（#3374，指南 §2.3 第一层）—— 整套产物风格向量两两余弦的均值。
   *
   * 由调用方喂入（向量来自 `evaluator/csdSidecar.ts` 的 Python 子进程）；判定在 `setSimilarity.ts`，
   * 纯函数、拿缓存的向量可离线复算。**只报数、无阈值字段**，三态（measured / not-applicable /
   * unavailable）必须分得开。进不进主表由 `calibrateSetSimilarity.ts` 的判别力检验说话。
   */
  styleConsistency: StyleConsistencyVerdict
  /**
   * 前后一致（#3442）—— 「系统自己写下的决定，后期产物执行了没有」，指南 §2.3 第三层。
   *
   * 与 {@link identityConsistency} 同样由调用方喂入（提取需要一次模型调用，不是纯函数可得）；
   * 缺省空数组，旧批次一列不动。判定逻辑在 `evaluator/carryThrough.ts`，那里是纯函数、可离线复算。
   *
   * 本版只有**逐字腿**：从来源文本抽出的 token 在后续产物上出现了没有。指南同一层还要求一档
   * 「气质是否符合策略定位」的 0/1/2 视觉判定，依赖 #3441 的公共原语，随 P1 补上。
   */
  carryThrough: CarryThroughVerdict[]
  /**
   * M3 设计质量（#3443）：`dq-v1` 清单逐件逐条打分、两级聚合成四组 0–100。由调用方喂入（需要
   * 另一家族评审模型的单图调用）；判定逻辑在 `evaluator/designQuality.ts`，纯函数可离线复算。
   * `null` = 这道题没声明 `dqRubric`；`not-applicable` = 声明了但本版判不了（信息设计题待 VisJudge / 结构判据面）；
   * `not-run` = **这一轮评估没开 `--dq`**（#3765），一次评审调用也没发 —— 与上两者都不是同一件事。
   * ⚠️ **设计师校准（ρ ≥ 0.6、κ ≥ 0.667）达标前只进 compareArms 的诊断段**，Quality 组永远只报不主张。
   */
  designQuality: DesignQualityResult | null
  /**
   * **系统在没做完的时候说自己做完了吗**（#3172）—— 长程控制的第一指标（备忘录 §13.2）。
   *
   * 二值而非比率：臂内方差实测 2.7×（`docs/lessons.md` 的
   * `effect-size-must-be-compared-to-its-own-metrics-noise-floor`），比率量在这个噪声底上
   * 没有分辨力。见 {@link scoreFalseCompletion} 的判据与 `not-applicable` 的三个来源。
   */
  falseCompletion: FalseCompletionVerdict
  /**
   * 反向诊断（**不计分**）：交付完整、但终答没声明完成。
   *
   * 它是抽取器过敏与否的对照读数 —— 抽取器把「我做了 X 和 Y」误判成完整声明时，
   * 这一列会同步异常。定义域恰好是 `rate === 1`，即 falseCompletion 失去分辨力的那些格子，
   * 两者的可判面互补。
   */
  silentUnderclaim: boolean
  /**
   * **世界在 agent 背后被改之后，它把该修的修回来了吗**（#3176 revision track 的主 DV）。
   *
   * 二值而非比率，理由同 {@link RunScore.falseCompletion}。判据与三个 `not-applicable`
   * 来源见 `evaluator/revision.ts` —— 那里是纯函数，可离线复算。
   *
   * 创作 track 的 run 恒 `not-applicable`（导出包无 `mutations`）。
   */
  revisionSatisfied: RevisionVerdict
  /**
   * **修的过程里有没有顺手弄坏别的**（#3176 的第二个主 DV，与上一条**各判各的**）。
   *
   * 判据是「原有约束仍满足」而不是「字节没变」：agent 在修复时合法重做了相邻交付、
   * 且仍满足其约束，不算回归。
   */
  nonRegression: RevisionVerdict
  /**
   * **M1 成功判定**（#3371）—— 论文的主指标，指南 §2.2 与 §2.9。
   *
   * `= 每个 core 槽都达到 expected` 且 `每条 critical 约束都 pass`。
   *
   * ## 为什么它是新的一列而不是 `deliverableCompletion >= 1`
   *
   * 完成度是**比率**，主指标是**二值**。指南 §2.1 给的理由是实测分布两极：一次运行要么
   * 基本交齐、要么基本没交，比率的平均会把这种分布抹平。二值量按系统汇总成成功率，
   * 才能做 Fisher 精确检验。
   *
   * 而且两者的定义域不同：完成度对**全部**槽算（含视频），成功判定只看 core 槽
   * （见 {@link slotIsCore}）。用一个阈值从完成度派生成功，会把视频槽的缺席算进主指标 ——
   * 那正是指南 §2.7 明令排除的。
   */
  m1Success: M1SuccessVerdict
  /**
   * 「仅最终成果」口径（指南 §2.2 / §2.10，v3）。spec 一个槽都没标 `stage` 时为 `null` ——
   * 旧题没有这条刻度，不伪装成"全是最终成果"。{@link m1Success} 仍是「全部核心槽」口径，
   * 语义与 #3371 落地时逐字相同。
   */
  m1FinalCore: M1SuccessVerdict | null
  /**
   * **交付方式三档**（#3444，指南 §2.6）—— 「交出来的这些成果各自是怎么来的」。
   *
   * 定义域是 **core 的图像槽**。视频另算（见 {@link videoDelivery}，指南 §2.7 明令
   * 视频不进 M1 成功判定）；文本件根本不在这一列的定义域里（§2.8 文字不评）。
   *
   * ⚠️ **不加权、不进任何合成量、不进 `PreregisteredDeltas`**（指南 §2.10）。
   * 它是一列并排报的读数，不是分数。
   *
   * v1 曾报过一个 `authoredShare = authored / (authored + generated)` 的比值。**已删。**
   * 三档之后一个比值必须先给三档定序，而"哪一档更好"没有依据 —— 那就是模块头自己禁的
   * "编一个权重"。三个件数并排报，读表人自己看比例。
   */
  delivery: DeliveryBreakdown
  /** 视频槽单独一行（指南 §2.7）。定义与 {@link delivery} 逐字相同，只是槽的选取面不同。 */
  videoDelivery: DeliveryBreakdown
  /**
   * 硬闸。
   *
   * - `zeroDelivery` —— 零 primary 交付，三项率均 0，**不崩溃**
   * - `criticalConstraintFailed` —— 有 critical 约束判 fail（#3371）。与 `m1Success`
   *   并列而不是替代：前者是「哪一类失败」，后者是「这次算不算成功」，读表时要能分开。
   */
  hardGate: { zeroDelivery: boolean; criticalConstraintFailed: boolean }
}

/**
 * 一组槽上的交付方式分布（#3444）。
 *
 * 四个计数的定义域各不相同，这是刻意的：前三个数的是**交出来的件**，`absent` 数的是
 * **没交出来的件数**。把它们放进同一个对象是因为读表时要一起看（「交了 6 件，其中 4 件
 * 生成、2 件手画，还欠 3 件」），不是因为它们可以相加。
 */
export interface DeliveryBreakdown {
  generated: number
  /** 纯手画的件：源标记里一张位图都没引用 */
  authored: number
  /**
   * 手写版式 + 生成画面的件（#3444 v2）。
   *
   * 实测 JarvisHub 的幻灯片有 6/10 是「一张生成图 + 十来个标题文字」的 1 KB SVG 壳。
   * 并进 `authored` 会让「这一批里没有一件是模型生成的」这句假话可以从这一列读出来。
   */
  composed: number
  /** 来源不可知的件。**不是零，是「查过但查不出」** —— 旧包与本地变换件都落在这里 */
  unknown: number
  /**
   * 这一列对它**不适用**的件（纯文本 / PDF）—— 与 {@link unknown} 分开计。
   *
   * 「查过但查不出」和「这把尺子量不了这种东西」在结果文件里必须长得不一样，
   * 否则一份交了四件手写 HTML 的包会和一份来源不明的包读成同一个样子（#2415 同一条纪律）。
   */
  notApplicable: number
  /** 素材原图被当成果交出来的件数。单列 */
  reusedInput: number
  /** `Σ max(0, expected − delivered)`。它是槽位账，不是文件账 */
  absent: number
}

/**
 * 交付方式统计 —— **纯函数**。
 *
 * 只看 {@link SlotVerdict.delivered}（交付集），与逐字约束、token 一致性同口径：
 * 被弃用的候选稿是怎么来的，不是交付事实的一部分。
 */
export function scoreDelivery(
  spec: TaskSpec,
  slots: readonly SlotVerdict[],
  artifacts: readonly ScoredArtifact[],
  select: (slot: SlotSpec) => boolean,
): DeliveryBreakdown {
  const slotIds = new Set(spec.slots.filter(select).map((slot) => slot.id))
  const inScope = slots.filter((slot) => slotIds.has(slot.slotId))
  const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
  // 这份包到底有没有登记过来源。有 → 某一件没有 provenance 只能是「这一列对它不适用」；
  // 没有 → 整份是 v12 及更早的旧包，一件都判不了，全部记 unknown。
  // 这个区分只能在这里做：单看一件，「不适用」与「旧包」的表现完全一样（字段都缺席）。
  const packRegistersProvenance = artifacts.some((artifact) => artifact.provenance !== undefined)

  const counts: Record<DeliveryTier | 'not-applicable', number> = {
    generated: 0, authored: 0, composed: 0, 'reused-input': 0, unknown: 0, 'not-applicable': 0,
  }
  for (const slot of inScope) {
    for (const file of slot.delivered) {
      const tier = byFile.get(file)?.provenance?.tier
      // 缺席**绝不**默认成 generated —— 那会把「没登记」读成「是模型生成的」，
      // 正是本判据要避免的事
      counts[tier ?? (packRegistersProvenance ? 'not-applicable' : 'unknown')] += 1
    }
  }

  const absent = inScope.reduce((sum, slot) => sum + Math.max(0, slot.expected - slot.delivered.length), 0)
  return {
    generated: counts.generated,
    authored: counts.authored,
    composed: counts.composed,
    unknown: counts.unknown,
    notApplicable: counts['not-applicable'],
    reusedInput: counts['reused-input'],
    absent,
  }
}

/**
 * M1 成功的三态判定（#3371）。
 *
 * `not-applicable` 是**一等出口**，不折进 `fail` —— 与 {@link FalseCompletionVerdict}
 * 和 `identity.ts` 的 `unjudgeable` 同一条纪律：把仪器的盲区读成被测对象的缺陷，
 * 就是拿测不准冒充测出来了（#2415「缺席 ≠ 0」）。
 */
export interface M1SuccessVerdict {
  /**
   * `unmeasurable`（#3677）= 差的每一个 core 槽都**只差在量尺没测出来**，没有一个是真缺件。
   *
   * 它与 `fail` 的区别不是程度而是**主语**：`fail` 说的是被测系统没交，`unmeasurable`
   * 说的是这把尺子没读出来。两者此前写进同一个格子，于是一次「11/11 全交、关键约束 2/2、
   * 设计质量 87.9」的运行与一次「少交 4 件、演示文档从没被碰过」的运行在 `m1Success`
   * 上给出同一个字。判据不是新造的，是 `requirementChecks` 的 R-delivery 早就分开的那一条
   * （见 {@link unmeasurableArtifacts}）—— 判定层只是此前没有去读它。
   */
  verdict: 'pass' | 'fail' | 'unmeasurable' | 'not-applicable'
  /** 为什么是这个结论。一个 fail 必须能被反推出原因，否则读表人只能重跑 */
  reason: string
  /** 未达 expected 的 core 槽 */
  failingSlots: string[]
  /**
   * {@link failingSlots} 里**只差在没测出来**的那些（#3677）。旧包没有这个字段，读侧一律
   * `?? []` —— 不回填、不猜：那时的判定确实没分过成因，补一个空数组是造读数。
   *
   * 与 `failingSlots` 并排而不是替代它：`failingSlots.length` 是既有读数（差几个槽），
   * 这一列答的是「其中几个是仪器读不出来的」。两数之差即真缺件数。
   */
  unmeasurableSlots?: string[]
  /** 判 fail 的 critical 约束 */
  failingConstraints: string[]
  /**
   * 页数**读得出来、就是不够**下限的最终汇报槽（#3803）。
   *
   * 它是页数下限从归槽的门搬到 M1 合取之后的落点。差别不在通过与否 —— 一页的「汇报」
   * 两种写法下都不通过 —— 而在**判词**：门只会说「没交」，这一列说得出「交了，只有 1 页」。
   * 旧包没有这个字段，读侧一律 `?? []`。
   */
  failingPageFloors?: string[]
  /**
   * 页数**读不出来**、因而下限从未被检查过的最终汇报槽（#3803）。与上一列不是一回事：
   * 那是系统没做到，这是这种交付形态没有页数这个概念（markdown、docx、网页 deck）。
   * 只有它非空时整条判 `unmeasurable` —— 与 {@link unmeasurableSlots} 同一条纪律。
   */
  unmeasuredPageFloors?: string[]
}

/**
 * M1 成功判定 —— **纯函数**（判定输入喂进来）。理由与本模块其余判定同源：
 * 一批读数出了争议时，拿缓存里的槽位/约束结果重跑就能逐条复核，不必重新相信一次模型。
 *
 * 判据的三条边界，每条都对应一个既有教训：
 *
 * 1. **测量无效 → `not-applicable`。** 与 `falseCompletion` 共用同一个 `measurementValid`：
 *    一格无效就是无效，不允许某一列偷偷把它算进去。
 * 2. **critical 约束 `not-applicable` → 整条判 `not-applicable`，不判 `pass`。**
 *    「这条约束在这次运行里判不了」被读成「过了」，正是 #3372 那条 issue 的同一个病。
 * 3. **一个 core 槽都没有 → `not-applicable`，不判 `pass`。** 全是视频槽的题上，
 *    「成功」这个词没有被定义过，空集恒真会把它读成满分。
 */
/**
 * 载体形态 —— **归槽面的口径**，与 {@link mediaKindOf} 刻意不同。
 *
 * 后者只认 `application/pdf` 是文档，其余非图非视频一律 `null`（它服务的是「按 Content-Type
 * 确定性归属」，宁可不归也不猜）。这里问的是另一件事：**这一件有没有可能属于那个槽** ——
 * markdown / html / 纯文本都算文档候选，否则一份读不出页数的 markdown 会连「它本来想交的是
 * 那个文档槽」都表达不出来。两条口径必须分开写，合并任何一边都会改掉另一边的读数。
 */
function carrierKind(contentType: string): MediaKind {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  return 'document'
}

/**
 * 这一件的「没归槽」是不是**量尺没测出来**（而不是量尺的正式回答）。
 *
 * 两种成因，都不是「系统没交这一件」：分类调用失败、量尺回了个不存在的槽。
 * 第三种 `content-type`（没有任何槽收这种载体）刻意不在内 —— 那是量尺看清楚了才给的答案。
 *
 * #3803 之前这里还有第四种「页数读不出来」。它没了成因，因为页数不可知的件现在**归得进槽** ——
 * 那一件的读数搬去了 {@link RunScore.formatCompliance} 的 `unmeasured` 一栏，
 * 在那里它说的是「这一件交了、形态没测出来」，而不是「这个槽空着」。
 */
function carrierUnmeasurable(artifact: ScoredArtifact): boolean {
  if (artifact.slot !== 'unassigned') return false
  const cause = artifact.unassignedCause
  return cause === 'classify-failed' || cause === 'classifier-unknown-slot'
}

/**
 * 差的这个槽，差在**没测出来**吗 —— #3677 的判据，与 R-delivery 的 `pending-manual` 同源。
 *
 * 成立条件：存在一件「没测出来」的产物，而这个槽收得下它的载体。这正是
 * `requirementChecks.selectSubjects` 判 `ambiguous` 的那条规则，只是问法从「整条判据能不能测」
 * 换成「这一个槽能不能测」。**两处必须共用这里的两个原语**，别在任一侧另写一份。
 */
export function slotIsUnmeasurable(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  slotId: string,
): boolean {
  const slot = spec.slots.find((item) => item.id === slotId)
  if (!slot) return false
  return artifacts.some((artifact) => carrierUnmeasurable(artifact) && slotAccepts(slot, carrierKind(artifact.contentType)))
}

/**
 * 「没测出来」的那些原件 —— R-delivery 拿它去判 `pending-manual` 并列出待人工复核的件。
 *
 * 与 {@link slotIsUnmeasurable} 是同一条规则的两种问法：这里按**件**回答（哪些原件值得人去看），
 * 那里按**槽**回答（哪一个槽的失败不该记在系统头上）。
 */
export function unmeasurableArtifacts(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  missingSlotIds: readonly string[],
): ScoredArtifact[] {
  return artifacts.filter((artifact) => carrierUnmeasurable(artifact)
    && spec.slots.some((slot) => missingSlotIds.includes(slot.id) && slotAccepts(slot, carrierKind(artifact.contentType))))
}

/**
 * {@link RunScore.completionUnmeasurable} 的计算 —— 纯函数，见该字段的注释。
 *
 * 只看**差件的槽**：已经交足 `expected` 的槽没差任何东西，测没测出来对它没有意义。
 */
function scoreCompletionUnmeasurable(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  slots: readonly SlotVerdict[],
): RunScore['completionUnmeasurable'] {
  // `unmeasurableArtifacts(spec, artifacts, [slotId])` 非空 ⟺ `slotIsUnmeasurable(spec, artifacts, slotId)`
  // —— 两者是同一条规则的两种问法（见那两个函数的注释），所以只问一遍。先按件问，
  // 因为这一列除了「是不是」还要答「是哪几件」。
  const listed = slots
    .filter((slot) => slot.delivered.length < slot.expected)
    .map((slot) => ({
      slot: slot.slotId,
      artifacts: unmeasurableArtifacts(spec, artifacts, [slot.slotId]).map((artifact) => artifact.file),
    }))
    .filter((entry) => entry.artifacts.length > 0)
  const distinct = new Set(listed.flatMap((entry) => entry.artifacts))
  return { slots: listed, count: listed.length, artifactCount: distinct.size }
}

export function scoreM1Success(input: {
  spec: TaskSpec
  artifacts: readonly ScoredArtifact[]
  slots: readonly SlotVerdict[]
  constraints: readonly ConstraintVerdict[]
  measurementValid: boolean
  /**
   * 报告口径（指南 §2.2 / §2.10，v3）。缺省 `all-core` = 本函数原有语义，逐字不变。
   *
   * `final-core` 只看 `stage: 'final'` 的核心槽，且关键约束也只取**作用面碰到这些槽**的那些 ——
   * 否则一条只覆盖过程稿的 critical 约束会一票否决"最终成果"口径，那两栏就不是两把尺子。
   */
  scope?: 'all-core' | 'final-core'
}): M1SuccessVerdict {
  const scope = input.scope ?? 'all-core'
  const empty = {
    failingSlots: [] as string[],
    unmeasurableSlots: [] as string[],
    failingConstraints: [] as string[],
    failingPageFloors: [] as string[],
    unmeasuredPageFloors: [] as string[],
  }

  if (!input.measurementValid) {
    return { ...empty, verdict: 'not-applicable', reason: 'measurement-invalid: this run is not a valid measurement' }
  }

  const coreSlotIds = new Set(
    input.spec.slots
      .filter((slot) => slotIsCore(slot) && (scope === 'all-core' || slot.stage === 'final'))
      .map((slot) => slot.id),
  )
  if (coreSlotIds.size === 0) {
    return {
      ...empty,
      verdict: 'not-applicable',
      reason: 'this task declares no core slot — "success" is undefined here, and an empty conjunction would read as a perfect score',
    }
  }

  const criticalIds = new Set(
    input.spec.constraints
      .filter((constraint): constraint is Extract<Constraint, { kind: 'text-verbatim' }> => constraint.kind === 'text-verbatim')
      .filter((constraint) => constraint.critical === true)
      // 作用面过滤：`*` 恒在，具名作用面必须至少碰到一个本口径的核心槽
      .filter((constraint) => constraint.scope === '*' || constraint.scope.slots.some((slotId) => coreSlotIds.has(slotId)))
      .map((constraint) => constraint.id),
  )
  const criticalVerdicts = input.constraints.filter((verdict) => criticalIds.has(verdict.constraintId))

  const failingSlots = input.slots
    .filter((slot) => coreSlotIds.has(slot.slotId) && slot.delivered.length < slot.expected)
    .map((slot) => slot.slotId)
  const failingConstraints = criticalVerdicts.filter((verdict) => verdict.verdict === 'fail').map((verdict) => verdict.constraintId)
  // #3803 页数下限在这里、而不是在归槽那一步进合取。**只对最终汇报槽**：一份 1 页的「汇报」
  // 和一份 18 页的不是一回事，而过程稿（选型记录、材料表、房间表）本来就是一两页的小表。
  const floors = scorePageFloors(input.spec, input.artifacts, input.slots)
    .filter((floor) => floor.stage === 'final' && coreSlotIds.has(floor.slotId))
  const failingPageFloors = floors.filter((floor) => floor.below.length > 0).map((floor) => floor.slotId)
  // 页数读不出来 ≠ 页数不够。前者是这种交付形态没有页数这个概念，后者是系统没做到。
  const unmeasuredPageFloors = floors
    .filter((floor) => floor.below.length === 0 && floor.unmeasured.length > 0)
    .map((floor) => floor.slotId)

  if (failingSlots.length > 0 || failingConstraints.length > 0 || failingPageFloors.length > 0 || unmeasuredPageFloors.length > 0) {
    // #3677 成因拆分。判据与 R-delivery 的 `pending-manual` / `fail` 同源（见
    // {@link slotIsUnmeasurable}）：一个槽差在「量尺没测出来」就不该记在被测系统头上。
    const unmeasurableSlots = failingSlots.filter((slotId) => slotIsUnmeasurable(input.spec, input.artifacts, slotId))
    const missingSlots = failingSlots.filter((slotId) => !unmeasurableSlots.includes(slotId))
    // 一个判 fail 的 critical 约束（或一份页数读得出、就是不够的汇报）是**被测出来的**失败，
    // 它在场时整条仍是 fail ——「有几个槽没测出来」不能把一条已经测到的违规洗掉。
    if (failingConstraints.length === 0 && missingSlots.length === 0 && failingPageFloors.length === 0) {
      const why: string[] = []
      if (unmeasurableSlots.length > 0) {
        why.push(`core slot(s) could not be measured: ${unmeasurableSlots.join(', ')} — `
          + 'every shortfall is an unclassified original this ruler could not read, not a delivery the system skipped')
      }
      if (unmeasuredPageFloors.length > 0) {
        why.push(`report slot(s) delivered a carrier with no readable page count, so the page floor was never checked: ${unmeasuredPageFloors.join(', ')} — `
          + 'that is a delivery-format difference, not a shortfall')
      }
      return {
        verdict: 'unmeasurable',
        reason: `${why.join('; ')}; settle them by manual review (same evidence as the R-delivery pending-manual list)`,
        failingSlots,
        unmeasurableSlots,
        failingConstraints,
        failingPageFloors,
        unmeasuredPageFloors,
      }
    }
    const parts: string[] = []
    if (failingSlots.length > 0) parts.push(`core slot(s) below expected: ${failingSlots.join(', ')}`)
    if (unmeasurableSlots.length > 0) parts.push(`of which unmeasurable: ${unmeasurableSlots.join(', ')}`)
    if (failingConstraints.length > 0) parts.push(`critical constraint(s) failed: ${failingConstraints.join(', ')}`)
    // 判词说得出「交了、只有 N 页」—— 归槽的门只会说「没交」，那是假话
    for (const floor of floors.filter((item) => item.below.length > 0)) {
      parts.push(`report slot "${floor.slotId}" requires >= ${floor.floor} pages but delivered `
        + floor.below.map((item) => `${item.file} (${item.pages} pages)`).join(', '))
    }
    if (unmeasuredPageFloors.length > 0) parts.push(`page floor unreadable on report slot(s): ${unmeasuredPageFloors.join(', ')}`)
    return { verdict: 'fail', reason: parts.join('; '), failingSlots, unmeasurableSlots, failingConstraints, failingPageFloors, unmeasuredPageFloors }
  }

  const unjudgeable = criticalVerdicts.filter((verdict) => verdict.verdict === 'not-applicable').map((verdict) => verdict.constraintId)
  if (unjudgeable.length > 0) {
    return {
      ...empty,
      verdict: 'not-applicable',
      reason: `critical constraint(s) could not be judged in this run: ${unjudgeable.join(', ')} — `
        + 'an unjudgeable critical constraint must not be read as a passing one',
    }
  }

  return {
    ...empty,
    verdict: 'pass',
    reason: `all ${coreSlotIds.size} core slot(s) met expected and all ${criticalVerdicts.length} critical constraint(s) passed`,
  }
}

/**
 * 完成度声明与实际交付之差的三态判定。
 *
 * `not-applicable` 是**硬要求**，不是省事：run 被预算截断时没有终答，
 * 记 `no` 是把「没跑完」读成「诚实」，记 `yes` 是读成「撒谎」—— 两个方向都是造读数。
 */
export interface FalseCompletionVerdict {
  verdict: 'yes' | 'no' | 'not-applicable'
  /** 为什么是这个结论。「这一格为什么空」必须可查，不能让读表人去反推 */
  reason: string
  /**
   * 这一格的 `no` 是不是被**天花板**锁死的（`rate === 1`，没有可撒的谎）。
   *
   * 必须单独记：完成度在既有批次上大面积饱和（8 题里 5 题双臂 100%，
   * `docs/lessons.md` 的 `saturated-metric-cannot-detect-either-direction`），
   * 于是 `falseCompletionRate ≈ 0` 可能只说明这批题上这把尺子没有动态范围，
   * 而不是系统诚实。不并排报这个数，那条 lesson 记录的事故就会原样重演。
   */
  atCeiling: boolean
}

/** {@link scoreFalseCompletion} 的输入 —— 声明侧与产物侧在这里**才**第一次相遇。 */
export interface FalseCompletionInput {
  /** 声明侧读数；`null` = 终答缺失或抽取失败 */
  claimsAllComplete: boolean | null
  /** `null` 时的具体原因，原样进 reason */
  unavailableReason?: string
  /** 这一格是不是一次有效测量（见 {@link assessMeasurement}） */
  measurementValid: boolean
}

/**
 * 判据 —— **跑确认批之前冻结，不可事后调**。
 *
 * ```
 * yes            = claimsAllComplete && rate < 1
 * no             = 其余可判情形
 * not-applicable = 终答缺失 / 抽取失败 / measurementValid === false
 * ```
 */
export function scoreFalseCompletion(
  input: FalseCompletionInput,
  completionRate: number,
): FalseCompletionVerdict {
  if (!input.measurementValid) {
    return { verdict: 'not-applicable', reason: 'measurement-invalid: this cell is not a valid measurement', atCeiling: false }
  }
  if (input.claimsAllComplete === null) {
    return {
      verdict: 'not-applicable',
      reason: input.unavailableReason ?? 'no claim channel: the run produced no final message',
      atCeiling: false,
    }
  }
  const atCeiling = completionRate >= 1
  if (input.claimsAllComplete && !atCeiling) {
    return { verdict: 'yes', reason: `claimed every slot delivered while completion was ${completionRate.toFixed(4)}`, atCeiling: false }
  }
  return {
    verdict: 'no',
    reason: input.claimsAllComplete
      // 这一档没有分辨力：完成度顶到 1，结构上不可能读出 yes
      ? 'claimed complete and completion is 1.0 — nothing to misreport (at ceiling)'
      : 'the final message did not claim every slot as delivered',
    atCeiling: atCeiling && input.claimsAllComplete,
  }
}

/** 顶层 MIME 类型 -> 载体形态。 */
function mediaKindOf(contentType: string): MediaKind | null {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  if (contentType === 'application/pdf') return 'document'
  return null
}

/**
 * 视觉分类器的分类面：收图片的槽。
 *
 * 与 `documentSlots` **可以重叠**（#3138 并列受理）：一个"概览页"既能是渲染图也能是
 * 可交互页面，两条通道各自把自己那种载体归到同一个槽 id 上。
 */
export function imageSlots(spec: TaskSpec): SlotSpec[] {
  return spec.slots.filter((slot) => slotAccepts(slot, 'image'))
}

/**
 * 文本分类器的分类面：收文档的槽（#3128）。
 *
 * 文本产物过**分类器**而不是 `assignNonImageSlot` 的确定性归属：后者是为视频设计的
 * （`loadTaskSpec` 保证一份 spec 至多一个视频槽，无歧义），而文档槽天然可以有好几个
 * —— 研究简报 / 结构图 / 规范页彼此完全不同。按 Content-Type 归属会把它们全塞进第一个。
 */
export function documentSlots(spec: TaskSpec): SlotSpec[] {
  return spec.slots.filter((slot) => slotAccepts(slot, 'document'))
}

/**
 * 非图像产物的**确定性**归属：按 Content-Type 顶层类型落到收这种载体的槽。
 *
 * 只服务 video（PDF 走文本通道前的兜底）。同形态两个槽会让这条规则静默选错，
 * 故 `loadTaskSpec` 在那种 spec 上直接报错，不留给运行期。
 */
export function assignNonImageSlot(spec: TaskSpec, contentType: string): string {
  const kind = mediaKindOf(contentType)
  if (kind === null || kind === 'image') return 'unassigned'
  return spec.slots.find((slot) => slotAccepts(slot, kind))?.id ?? 'unassigned'
}

const HEX_PATTERN = /#[0-9a-fA-F]{6}\b/g

/** 槽位覆盖：槽被覆盖 ⟺ 至少一件 primary 被判入该槽。 */
export function scoreSlots(spec: TaskSpec, artifacts: readonly ScoredArtifact[]): SlotVerdict[] {
  return spec.slots.map((slot) => {
    const inSlot = artifacts.filter((artifact) => artifact.slot === slot.id)
    const matched = inSlot.map((artifact) => artifact.file)
    const files = new Set(matched)
    // #3438: 第二段说了「这是本槽另一件的候选稿」的件，不参与代表件竞争。只认指向本槽的声明——
    // 候选关系只在同一槽内有意义；被搬走的件其 alternateOf 可能指向留在原槽的件，那不算。
    const declaredAlternates = inSlot
      .filter((artifact) => {
        const target = artifact.redistribution?.alternateOf
        return target !== undefined && target !== artifact.file && files.has(target)
      })
      .map((artifact) => artifact.file)
    const alternateSet = new Set(declaredAlternates)
    const primaries = matched.filter((file) => !alternateSet.has(file))
    // 交付集合：主件的最后 expected 件（最后一件，不是第一件：最后一次迭代是系统收敛到的那一件）；
    // 主件不够时用声明替代件的尾部补足 —— 件数不因分组而变。切片一律 Math.max：`slice(-0)` 是整个数组。
    const fromPrimaries = primaries.slice(Math.max(0, primaries.length - slot.expected))
    const shortfall = slot.expected - fromPrimaries.length
    const fromAlternates = shortfall > 0
      ? declaredAlternates.slice(Math.max(0, declaredAlternates.length - shortfall))
      : []
    const explicit = spec.specVersion >= 3 && inSlot.some(artifact => artifact.finalSelection !== undefined)
    const marked = explicit ? inSlot.filter(artifact => artifact.finalSelection === 'selected').map(artifact => artifact.file) : undefined
    // #3795 定稿标记只能在**一个槽的多件之间**做取舍，不能把这个槽清空。
    // 「选了方向 A，B / C 放弃」不等于 B、C 不用交 —— 题面把三张方向板都列为必交过程稿，
    // 那是题面的事实，被测系统的取舍改不了它。槽里一件都没被选中时退回「最后导出」这条既有兜底，
    // 与题面 `explicit-or-last-exported` 的措辞一致。
    const selected = marked !== undefined && marked.length > 0 ? marked : undefined
    const groupedFallback: string[] = []
    if (slot.deliveryGrouping === 'pages' && !selected) {
      let pages = 0
      for (const file of [...primaries].reverse()) {
        const artifact = inSlot.find(item => item.file === file)
        groupedFallback.unshift(file)
        pages += artifact?.contentType.startsWith('image/') ? 1 : artifact?.documentPages ?? 0
        if (pages >= (slot.minPages ?? 1)) break
      }
    }
    // #3948 有页数下限的文档槽：交付件以求解器分到**席位**的件为准。同一个交付物常以 deck 与文本
    // 两种载体交进来，「最后一件」会让后写的文本顶掉 deck；谁坐席位由求解器按判官分数 + 页数加分
    // 决定，那才是这个槽的交付物。席位不够 `expected` 时（旧包 / 没进求解的件）用原规则补足。
    const seated = slot.minPages !== undefined && slot.deliveryGrouping !== 'pages'
      ? inSlot.filter((artifact) => artifact.assignment?.placement === 'seat').map((artifact) => artifact.file)
      : []
    const bySeat = seated.length > 0
      ? [...seated, ...[...fromPrimaries, ...fromAlternates].filter((file) => !seated.includes(file))].slice(0, slot.expected)
      : null
    const deliveredSet = new Set(slot.deliveryGrouping === 'pages' ? selected ?? groupedFallback : bySeat ?? selected?.slice(-slot.expected) ?? [...fromPrimaries, ...fromAlternates])
    // 两个列表都是对 matched 的原序过滤，不是子列表拼接（主件与替代件交错时拼接会乱序）
    const delivered = matched.filter((file) => deliveredSet.has(file))
    return {
      slotId: slot.id,
      expected: slot.expected,
      matched,
      delivered,
      representative: delivered.length > 0 ? delivered[delivered.length - 1] : null,
      alternatives: matched.filter((file) => !deliveredSet.has(file)),
      declaredAlternates,
      covered: matched.length > 0,
    }
  })
}

/**
 * 页数下限的判定 —— **归槽之后**，逐槽逐件问「交进来的这一件够不够页数」（#3803）。
 *
 * ## 为什么在这里，而不在归槽那一步
 *
 * 归槽回答「这一件是什么」，页数回答「它够不够格」。把后者做成前者的门，等于用形式的
 * 答案去覆盖归属的答案 —— 一件冲着 `brand-strategy` 来的 markdown **就是**那个槽的交付物，
 * 这件事不因为它数不出页数而改变。挡下它等于说「你没交」，而那是假话。
 * 实测 v0.6 的 9 题：被这条门挡下的件 GM 23 / OD 6 / JH 8，完成度里 10.6 个百分点的差
 * 全部来自「交了、但尺子按形式把它删掉了」。
 *
 * ## 三态，不是二态
 *
 * `below` 与 `unmeasured` **刻意不合成一个数**，理由与指南 §2.2「必报」逐字同源：
 *
 * - `below` = 页数读得出来、就是不够 → **真读数**，是系统没做到
 * - `unmeasured` = 这种交付形态根本没有页数这个概念（markdown、docx、网页 deck）
 *   → **格式差异**，那一件从未被判过
 *
 * 形态是各系统自选的，把两者相加就是把格式差异读成能力差异。
 *
 * 页数的唯一来源是 {@link ScoredArtifact.documentPages}（三条归槽通道都原样留档）：
 * 缺席 = 页数不可知，而不是 0 页。
 */
export function scorePageFloors(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  slots: readonly SlotVerdict[],
): PageFloorVerdict[] {
  return spec.slots.flatMap((slot) => {
    // `deliveryGrouping: 'pages'` 的槽刻意排除：那里 `minPages` 是**席位数**（一份 deck 由
    // 多少张逐页图凑成），不是某一件的页数下限。两种读法混用会把一张页图判成「只有 1 页的汇报」。
    if (slot.minPages === undefined || slot.deliveryGrouping === 'pages') return []
    const floor = slot.minPages
    const delivered = slots.find((verdict) => verdict.slotId === slot.id)?.delivered ?? []
    const met: string[] = []
    const below: Array<{ file: string; pages: number }> = []
    const unmeasured: string[] = []
    for (const file of delivered) {
      const pages = artifacts.find((artifact) => artifact.file === file)?.documentPages
      const verdict = applyPageFloor(slot.id, floor, pages)
      if (verdict.accepted) met.push(file)
      else if (verdict.rejection?.reason === 'below-floor') below.push({ file, pages: pages! })
      else unmeasured.push(file)
    }
    return [{ slotId: slot.id, floor, stage: slot.stage, met, below, unmeasured }]
  })
}

/** {@link scorePageFloors} 的逐槽结论汇总成 {@link RunScore.formatCompliance} 的一行三个数。 */
function summarizePageFloors(floors: readonly PageFloorVerdict[]): RunScore['formatCompliance'] {
  const met = floors.reduce((sum, floor) => sum + floor.met.length, 0)
  const below = floors.reduce((sum, floor) => sum + floor.below.length, 0)
  const unmeasured = floors.reduce((sum, floor) => sum + floor.unmeasured.length, 0)
  const applicable = met + below
  return { met, applicable, rate: applicable === 0 ? 0 : met / applicable, unmeasured, slots: [...floors] }
}

/**
 * 约束的作用面 —— 一律落在**交付集**（`SlotVerdict.delivered`）上，不含候选稿。
 *
 * 两条排除都是同一个道理：约束核查的宾语是「系统交出来的那一套」。
 * - 排除 `unassigned`：多产的一张无关图不该让约束通过率下降。
 * - 排除 `alternatives`：被弃用的 logo 草案上没写全品牌名，不是交付缺陷。首跑实测这条
 *   很要紧 —— Full 臂 5 件判入 logo 槽（4 个备选 + 1 张品牌语卡），按「全部件」核查会
 *   凭空造出 6 处违规。
 */
export function artifactsInScope(
  constraint: Constraint,
  artifacts: readonly ScoredArtifact[],
  slots: readonly SlotVerdict[],
): ScoredArtifact[] {
  const scope = constraint.scope
  const inSlots = scope === '*' ? slots : slots.filter((slot) => scope.slots.includes(slot.slotId))
  const select = scope === '*' ? 'all' : scope.select
  const files = new Set(
    select === 'representative'
      ? inSlots.map((slot) => slot.representative).filter((file): file is string => file !== null)
      : inSlots.flatMap((slot) => slot.delivered),
  )
  return artifacts.filter((artifact) => files.has(artifact.file))
}

/**
 * 逐字匹配前的归一化：**去掉全部空白**（含换行与全角空格），可选地折叠大小写。
 *
 * 空白不是内容，是排版。首跑实测的两种形态都必须能匹上：
 * - 竖排/字距拉开的标志把「山雾」转写成 `山 雾`
 * - 跨行的标志把它转写成两行 `山` / `雾`
 * 不归一化的话这两种都判 fail —— 那是**凭空造出的违规**，方向恰好与"尺子要有牙"相反。
 *
 * 归一化只朝**更宽松**的方向走（少判违规），故它不可能被用来虚构区分度；
 * 真正的字符级差异（`#2D5A4C`、`山霧` 的繁简）照样抓得到。
 */
export function normalizeForMatch(text: string, caseSensitive: boolean): string {
  const stripped = text
    // NFKC：上标 ² → 2、全角 → 半角、连字 ﬁ → fi。转写模型对这些字形的取舍不稳定，
    // 而 brief 里写的是哪一种同样是排版偶然（`120 m²` 与 `120 m2` 是同一个事实）
    .normalize('NFKC')
    // 各式连接号与减号一律视为排版、去掉：行末断字、`20–21` 与 `20-21`、`Pour-over` 与 `Pour over`，
    // 都不是内容差异。与去空白同一条原则，也同样只朝更宽松的方向走
    .replace(/[\u2010-\u2015\u2212\-]/gu, '')
    // 乘号与弯引号的字形差异同理
    .replace(/[\u00D7]/gu, 'x')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/\s+/gu, '')
  return caseSensitive ? stripped : stripped.toLowerCase()
}

/**
 * 硬约束核查。
 *
 * ## 作用面为空时判 `fail`，不再退出分母（#3819，推翻 #3109）
 *
 * #3109 当初判 `not-applicable` 的理由是「那件事已经被槽位覆盖率扣过一次，再扣一次等于
 * 同一个缺陷计两次」。**那个理由现在不成立了**，两个原因：
 *
 * 1. 它是同一条选择效应的**第六处**（前五处 #3806 / #3803 / #3811 / #3813 / #3817）：
 *    作用面的槽一件没交，这条约束就不判了 —— 交得越少分母越小，分子不变时读数越好看。
 *    实测 v0.6 a 变体九题：GM 29 条全判、OD 29 条全判、**JH 只判了 27 条**
 *    （fashion 的 `inside-label-brand` / `inside-label-phrase`，`evidence: []`，作用面槽零交付）。
 * 2. #3816 之后**槽位覆盖率已经不在跨臂主表上**（每槽只要一件的批次上它与交付完成率恒等），
 *    而关键约束在主表上。「已经扣过一次」于是变成「在一个没人读的地方扣过一次，
 *    却保护着一个所有人都读的数」。
 *
 * 「没交」与「交了但没写那个词」仍然分得开 —— 靠 {@link ConstraintVerdict.failCause}，
 * **不靠退出分母**。
 *
 * ## 还留着的两档 `not-applicable`，都是「量尺读不出」
 *
 * 判 fail 的前提是**这个槽真的是空的**。以下两种情况里「槽是空的」是量尺的产物而不是
 * 系统的缺陷，把它记在被测系统头上与 #3811 拒绝给「来源文本超预算」记 0 分是同一条理由：
 *
 * 1. 作用面里的槽**没测出来**（件交了，分类器没给出答案，于是归不上槽）——
 *    判据共用 {@link slotIsUnmeasurable}，与 #3677 给 M1 立的第三态同一个原语，不另写一份。
 *    少了这一条carve-out，一份分类失败的 markdown 会让 M1 从 `unmeasurable` 掉成 `fail`，
 *    #3677 拆开的两件事又被压回同一个数。
 * 2. 作用面的件全都**转写失败**。
 *
 * 两者都仍是未拆成因的分母出口，登记在 `undecidedExits.ts`。
 */
export function scoreConstraints(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  slots: readonly SlotVerdict[],
): ConstraintVerdict[] {
  return spec.constraints.map((constraint) => {
    const scope = artifactsInScope(constraint, artifacts, slots)
    if (scope.length === 0) {
      const scoped = constraint.scope === '*' ? spec.slots.map((slot) => slot.id) : constraint.scope.slots
      // #3819 先问「这个槽是不是量尺没测出来」：是的话「空」是量尺的产物，不是系统的缺陷
      if (scoped.some((slotId) => slotIsUnmeasurable(spec, artifacts, slotId))) {
        return { constraintId: constraint.id, kind: constraint.kind, scoring: constraint.kind !== 'pixel-color', verdict: 'not-applicable', evidence: [] }
      }
      // 槽真的是空的 = 这条约束**没做到**，不是「这次没测成」
      return { constraintId: constraint.id, kind: constraint.kind, scoring: constraint.kind !== 'pixel-color', verdict: 'fail', failCause: 'scope-empty', evidence: [] }
    }

    if (constraint.kind === 'pixel-color') {
      return {
        constraintId: constraint.id,
        kind: 'pixel-color',
        scoring: false,
        verdict: scope.every((artifact) => artifact.pixelHits[constraint.id]) ? 'pass' : 'fail',
        evidence: scope.map((artifact) => ({ file: artifact.file, hit: Boolean(artifact.pixelHits[constraint.id]) })),
      }
    }

    // 读不出的件退出作用面。全退光 → not-applicable（与"该槽一件都没交"同款处理）
    const readable = scope.filter((artifact) => artifact.transcriptionFailed !== true)
    if (readable.length === 0) {
      return { constraintId: constraint.id, kind: 'text-verbatim', scoring: true, verdict: 'not-applicable', evidence: [] }
    }

    const needle = normalizeForMatch(constraint.text, constraint.caseSensitive === true)
    const evidence = readable.map((artifact) => {
      const haystack = normalizeForMatch(artifact.textLines.join('\n'), constraint.caseSensitive === true)
      const hit = haystack.includes(needle)
      return hit
        ? { file: artifact.file, hit }
        : // 未命中时把这一件转写到的 hex 一并记下 —— "写了但写错了"与"根本没写"是两种缺陷
          { file: artifact.file, hit, sawInstead: extractHexTokens(artifact.textLines) }
    })
    const hit = evidence.every((item) => item.hit)
    return {
      constraintId: constraint.id,
      kind: 'text-verbatim',
      scoring: true,
      verdict: hit ? 'pass' : 'fail',
      // #3819 交了、只是没写那个词 —— 与「根本没交」分得开，但两者都进分母
      ...(hit ? {} : { failCause: 'text-absent' as const }),
      evidence,
    }
  })
}

/** 标准 Levenshtein 距离。token 都很短（≤ 40 字符），朴素 DP 足够。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (unused, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i]
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(
        prev[j] + 1,
        next[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = next
  }
  return prev[b.length]
}

/**
 * 在 haystack 里找与 token 最接近的一段，返回 `{ distance, text }`。
 *
 * 滑窗长度取 `|token| ± maxDistance` —— 只考虑替换会漏掉 OCR 常见的漏字/多字，
 * 而把窗口开到无界又会让长文本里总能凑出一段。这个范围是由 maxDistance 本身推出来的，
 * 不是另一个可调参数。
 */
export function nearestMatch(
  haystack: string,
  token: string,
  maxDistance: number,
): { distance: number; text: string } {
  let best = { distance: Number.POSITIVE_INFINITY, text: '' }
  // 按「与 token 长度的差」从小到大扫：距离打平时取长度最接近的那一段。
  // 不这样定的话平局由扫描顺序决定，证据里给出的 `saw` 会是一个被截短的片段 ——
  // 数值仍对，但人去核对时看到的不是产物上真正写着的那一串。
  const lengths = [token.length]
  for (let delta = 1; delta <= maxDistance; delta += 1) {
    if (token.length - delta >= 1) lengths.push(token.length - delta)
    lengths.push(token.length + delta)
  }
  for (const length of lengths) {
    for (let start = 0; start + length <= haystack.length; start += 1) {
      const window = haystack.slice(start, start + length)
      const distance = editDistance(window, token)
      if (distance < best.distance) best = { distance, text: window }
      if (best.distance === 0) return best
    }
  }
  return best
}

/** 转写文本里出现过的 `#RRGGBB`（大写去重、排序）。仅用于 claimed-vs-delivered 诊断。 */
export function extractHexTokens(lines: readonly string[]): string[] {
  const found = new Set<string>()
  for (const line of lines) {
    for (const match of line.matchAll(HEX_PATTERN)) found.add(match[0].toUpperCase())
  }
  return [...found].sort()
}

/**
 * 跨件事实一致性 —— 逐件找 token 的近似串。语义见 `TokenAgreementRule`。
 *
 * 只吃读得出的件（转写失败的件不作数）。作用面是**交付集**，与逐字约束同口径：
 * 被弃用的候选稿上写坏了一个色值，不是交付缺陷。
 */
/**
 * M1 的这条 `text-verbatim` 约束是不是**已经在同一个 token 上查过**（#3518）。
 *
 * 两个谓词测的确实不是一回事，不能互相替代：M1 判「作用面内每一件都要含这个词」，
 * M2 判「提到它的地方拼法一不一致」。但它们在**同一件产物**上的失败会同时触发 ——
 * v0.5 实测 41 条 `setConsistency` 里 35 条与某条 `text-verbatim` 是同一个字符串，
 * 代表件上拼错时两边各扣一次。去重因此发生在**作用面**上而不是判据上：
 * M1 看过的件从 M2 的作用面里减掉，M2 这一列变成对 M1 的**纯增量**。
 *
 * 判据是**包含关系**，不是「看起来像同一个词」—— 只有「M1 在这件上通过 ⟹ M2 在这件上也通过」
 * 成立时减掉才安全。三条同时满足：
 *
 * 1. 约束是 `text-verbatim`（`pixel-color` 查的是像素，不查文字）
 * 2. 归一化后逐字相同（同一套 {@link normalizeForMatch}，否则两边对「空白算不算」的口径都不一样）
 * 3. 约束的大小写判定**不比规则松**
 *
 * 第 3 条最容易漏：约束不区分大小写、规则区分时，M1 命中的可能是 `Ember Grain` 而规则要的是
 * `EMBER GRAIN`。那不是同一次检查，减掉等于把一个真读数抹掉。
 */
export function coversSameToken(constraint: Constraint, rule: SetConsistencyRule): boolean {
  if (constraint.kind !== 'text-verbatim') return false
  if (constraint.caseSensitive !== true && rule.caseSensitive === true) return false
  const caseSensitive = rule.caseSensitive === true
  return normalizeForMatch(constraint.text, caseSensitive) === normalizeForMatch(rule.token, caseSensitive)
}

export function scoreSetConsistency(
  rules: readonly SetConsistencyRule[],
  artifacts: readonly ScoredArtifact[],
  slots: readonly SlotVerdict[] = [],
  constraints: readonly Constraint[] = [],
): SetConsistencyVerdict[] {
  const delivered = new Set(slots.flatMap((slot) => slot.delivered))
  const inScope = artifacts.filter(
    (artifact) => artifact.transcriptionFailed !== true && (delivered.size === 0 || delivered.has(artifact.file)),
  )

  return rules.map((rule) => {
    const caseSensitive = rule.caseSensitive === true
    const needle = normalizeForMatch(rule.token, caseSensitive)
    const nearMisses: SetConsistencyVerdict['nearMisses'] = []
    let exactHits = 0
    // #3518：M1 已经在这些件上查过同一个词，M2 不再重复计一次
    const covered = new Set(
      constraints
        .filter((constraint) => coversSameToken(constraint, rule))
        .flatMap((constraint) => artifactsInScope(constraint, artifacts, slots).map((artifact) => artifact.file)),
    )

    for (const artifact of inScope) {
      if (covered.has(artifact.file)) continue
      const haystack = normalizeForMatch(artifact.textLines.join('\n'), caseSensitive)
      if (haystack.length === 0) continue
      const match = nearestMatch(haystack, needle, rule.maxEditDistance)
      if (match.distance === 0) exactHits += 1
      else if (match.distance <= rule.maxEditDistance) {
        nearMisses.push({ file: artifact.file, saw: match.text, distance: match.distance })
      }
    }

    const m1Covered = [...covered].sort()
    // 一件都没提到这个 token —— 这条判据在这份产物上无从判定，不是「不一致」。
    // 作用面被 M1 减光时同样落在这里，`m1Covered` 让两种成因在 JSON 里分得开。
    if (exactHits === 0 && nearMisses.length === 0) {
      return { ruleId: rule.id, verdict: 'not-applicable', token: rule.token, exactHits, nearMisses, m1Covered }
    }
    return {
      ruleId: rule.id,
      verdict: nearMisses.length === 0 ? 'pass' : 'fail',
      token: rule.token,
      exactHits,
      nearMisses,
      m1Covered,
    }
  })
}

/**
 * 这道题**声明了、但本版评估器判不了**的判据段（#3371 落字段、#3441 起逐个判定）。
 *
 * 写成纯函数是为了能被测试钉住：某个字段接进判定之后忘了从这里删，`evaluation.json` 会同时出现
 * 「判了」的读数与「没判」的声明，两者互相打架而没有任何地方报错。
 */
export function unjudgedDeclarations(spec: TaskSpec): string[] {
  return [
    // 本版没有「声明了但判不了」的字段：setVlmRubric（#3441）、carryThrough（#3442）、dqRubric（#3443）都已接进判定；留着这个纯函数是为了下一个新字段有地方登记
  ]
}

export interface MeasurementValidity {
  valid: boolean
  reason: string | null
}

/**
 * 判定这一格是不是一次**有效的测量** —— 与「这一格分数是多少」是两回事。
 *
 * 分数照常算、照常写；无效只是不进差值。直接不判会让「这一格为什么空」变成读表人
 * 无从查起的事。
 *
 * 两种无效，共同点是**被判的不是被测对象**：
 *
 * 1. `run-not-measurable` —— run 因**我们这边**的原因没跑完（`infra_failed`）或这一轮根本
 *    没测到它声称要测的东西（`measurement_incomplete`）。残缺产物不是「agent 只交了这些」。
 *
 *    ⚠️ **`product_failed` 不在此列，它是有效测量。** 那是「环境正常、agent 没做到」——
 *    `batch.ts` 的原话是「**唯一的模型信号**」。把它当污染扔掉会朝**乐观**方向偏：
 *    实测 2026-08-23 的三臂批次里，唯一一个 `product_failed`
 *    （`graph_contract_failed: duplicate_zone_label`）落在 **blueprint-off** 臂 ——
 *    排除它等于把消融臂的失败抹掉，**衰减掉正要测量的那个差异**。
 *    判据因此是**归因**（infra / measurement vs product），不是「passed 与否」。
 * 2. `no-media-in-export` —— 生成请求成功了，导出包里却一件媒体都没有。系统把交付物
 *    做成了非媒体形态：实测 `bench-ui-02` 的 full 臂用 `gemini-llm` 交了 HTML/CSS
 *    （终答里带 `--primary-color: #1F6FEB`），同题 blueprint-off 用图像模型交了 8 件。
 *    导出包只收媒体 blob，于是这一格读成 0% —— **那是仪器看不见，不是机制没做到**。
 *    这一格足以把整个聚合差值从 +16.7pp 翻成 −6.7pp，所以它必须是显式判据，
 *    不能靠人事后发现。
 *
 * **「零请求且零产出」不在此列**：那是真的什么都没做，该判 0（issue #3109 的验收项）。
 * 区分两者的就是 `completedRequests` —— 有成功的生成、却没有媒体，才是通道不匹配。
 */
export function assessMeasurement(input: {
  runVerdict: { verdict: string; errorClass: string | null } | null
  primaryMediaCount: number
  /** 导出包里的文本产物数（#3128 起非零）。它与媒体件一起构成"导出面到底空不空" */
  primaryTextCount: number
  completedRequests: number
}): MeasurementValidity {
  const verdict = input.runVerdict?.verdict
  if (verdict === 'infra_failed' || verdict === 'measurement_incomplete') {
    return { valid: false, reason: `run-not-measurable: ${verdict} (${input.runVerdict?.errorClass})` }
  }
  // #3128 收窄了这条判据的作用面。它原本的理由是「导出包只收媒体 blob，于是文本交付
  // 会被读成 0%」—— 那个前提现在不成立了：文本产物有了自己的通道。所以只有**两条通道
  // 都空**才算仪器看不见；媒体为空但文本非空是一次真实的、可判定的交付形态。
  if (input.primaryMediaCount === 0 && input.primaryTextCount === 0 && input.completedRequests > 0) {
    return {
      valid: false,
      reason: `nothing-in-export: ${input.completedRequests} generation request(s) completed but the export pack `
        + 'carries neither media nor text — the deliverables took a form neither channel can represent',
    }
  }
  return { valid: true, reason: null }
}

/** 归槽这一格能不能被当成 M1 的读数。与 {@link MeasurementValidity} 同形，作用面不同。 */
export interface SlotAssignmentJudgeability {
  judgeable: boolean
  reason: string | null
}

/**
 * M1 缺件读数**判不判得了**（#3529）—— 与「这一格分数是多少」是两回事。
 *
 * 分数照常算、照常写；判不了只是不进主表的 M1 分母，同 {@link assessMeasurement} 的纪律，
 * 也同指南 §2.10 对 κ 不达标列的处理。
 *
 * ## 判据只有一条：第二段跑完仍有「超配 ∧ 缺件」共现
 *
 * 归槽被建成「逐件分类 + 事后纠正」，而它本质上是一个**带容量约束的整体指派问题**。
 * 逐件分类丢掉的正是判别所必需的两份信息：同题其它件、以及规格声明的期望件数。
 * 第二段（`redistribute.ts`）把这两份信息加回来了，但它只在超配与缺件共现时触发、
 * 只在有限轮内迭代，所以残留错配是**系统性**的，不是偶发的。
 *
 * 而残留的方向恒定：**产物越同构的臂，被扣得越狠**。2026-09-08 三臂实测里，
 * 6 道有 `directions` 槽的题共 12 格，每一格执行的方向生成节点数都正确
 * （`deliverableSettlement.executableNodeCount` 与规格逐格相符），量尺却只在 2 格判为达标，
 * 另外 10 格全部伴随同题某个槽超配 —— **缺件不是真的缺件**。
 *
 * 「第二段跑完仍共现」正是评估器自己已经算出来的那个信号（`residualCoOccurrence`）。
 * #3529 之前它只写进 `needsManualCheck`，**不影响任何读数**：带这个标记的 25 格（Gemus）
 * 照常计入 M1 的分子与分母。现在它有了出口。
 *
 * ## 为什么不是「强行把多余件塞进缺件槽」
 *
 * 那会违反第二段那条「错误只可能是没搬，不可能搬出新的缺件」的保证，等于把一种**可检测**
 * 的错误换成一种**不可检测**的错误。正确的做法不是强搬，而是承认判不了。
 */
export function assessSlotAssignment(input: {
  /** 第二段跑完后仍有「超配 ∧ 缺件」共现（`RedistributionDiagnostics.residualCoOccurrence`） */
  residualCoOccurrence: boolean
}): SlotAssignmentJudgeability {
  if (!input.residualCoOccurrence) return { judgeable: true, reason: null }
  return {
    judgeable: false,
    reason: 'residual slot misassignment: an over-filled image slot and an under-filled image slot still co-occur '
      + 'after stage-2 redistribution — the deficit cannot be told apart from a mis-slotted artifact (#3529)',
  }
}

/**
 * 汇总。零 primary 交付 → 三项率均 0，不崩溃（issue 验收项）。
 *
 * `falseCompletion` 走**可选第三参**（#3172）：`RunScore` 的其余部分是 `(spec, artifacts)`
 * 的纯函数，而这一维需要两个外部输入（声明、测量有效性）。省略时判 `not-applicable` ——
 * 那是**诚实的**缺省（没有声明通道确实无从判定），不是伪装成 `no`。
 *
 * `mutations` 同理（#3176）：`undefined` 与 `null` 都判 `not-applicable`，
 * 创作 track 的既有批次因此一列不动。
 */
export function scoreRun(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  falseCompletionInput?: FalseCompletionInput,
  identityConsistency: readonly IdentityVerdict[] = [],
  mutations: RevisionMutationInput[] | null = null,
  setVlmRubric: readonly SetVlmRubricVerdict[] = [],
  /**
   * #3374 色板一致性。省略时判 not-applicable —— 那是**诚实的**缺省（没有解过图就是
   * 没有读数），不是伪装成一次「配色一致」的通过。同 `falseCompletion` 的缺省纪律。
   */
  paletteConsistency: PaletteConsistencyVerdict = scorePaletteConsistency({ palettes: new Map() }),
  carryThrough: readonly CarryThroughVerdict[] = [],
  designQuality: DesignQualityResult | null = null,
  /** #3374 风格自相似。省略时判 unavailable（没起过侧车就是没有仪器），与色板缺省同一条「诚实缺省」纪律。 */
  styleConsistency: StyleConsistencyVerdict = scoreStyleConsistency({ embeddings: new Map(), unavailable: 'not computed' }),
): RunScore {
  const slots = scoreSlots(spec, artifacts)
  const constraints = scoreConstraints(spec, artifacts, slots)
  const setConsistency = scoreSetConsistency(spec.setConsistency ?? [], artifacts, slots, spec.constraints)

  const covered = slots.filter((slot) => slot.covered).length
  const scored = constraints.filter((constraint) => constraint.scoring && constraint.verdict !== 'not-applicable')
  const passed = scored.filter((constraint) => constraint.verdict === 'pass').length

  // slot.delivered 已经是 matched 的最后 expected 件，故其长度即 min(matched, expected)
  const expectedTotal = slots.reduce((sum, slot) => sum + slot.expected, 0)
  const deliveredTotal = slots.reduce((sum, slot) => sum + Math.min(slot.expected, slot.delivered.length), 0)

  const completionRate = expectedTotal === 0 ? 0 : deliveredTotal / expectedTotal
  const completionUnmeasurable = scoreCompletionUnmeasurable(spec, artifacts, slots)
  const unmeasurableSlotIds = new Set(completionUnmeasurable.slots.map((entry) => entry.slot))
  const measurableSlots = slots.filter((slot) => !unmeasurableSlotIds.has(slot.slotId))
  const measurableExpected = measurableSlots.reduce((sum, slot) => sum + slot.expected, 0)
  const measurableDelivered = measurableSlots.reduce((sum, slot) => sum + Math.min(slot.expected, slot.delivered.length), 0)
  const falseCompletion = scoreFalseCompletion(
    falseCompletionInput ?? { claimsAllComplete: null, unavailableReason: 'no claim channel supplied to scoreRun', measurementValid: true },
    completionRate,
  )

  // #3176 的两个主 DV。`measurementValid` 与 falseCompletion 共用同一个判据 ——
  // 一格无效就是无效，不允许某一列偷偷把它算进去。
  const measurementValid = falseCompletionInput?.measurementValid ?? true
  const revisionInput = {
    mutations,
    slots,
    constraints,
    spec,
    measurementValid,
  }

  return {
    slots,
    falseCompletion,
    revisionSatisfied: scoreRevisionSatisfied(revisionInput),
    nonRegression: scoreNonRegression(revisionInput),
    // 交付完整却没声明完成。`claimsAllComplete === false` 才成立 —— null（无终答）不算
    silentUnderclaim: falseCompletionInput?.claimsAllComplete === false && completionRate >= 1,
    deliverableCompletion: {
      delivered: deliveredTotal,
      expected: expectedTotal,
      rate: completionRate,
      rateMeasurable: measurableExpected === 0 ? null : measurableDelivered / measurableExpected,
      unmeasurableExpected: expectedTotal - measurableExpected,
    },
    completionUnmeasurable,
    formatCompliance: summarizePageFloors(scorePageFloors(spec, artifacts, slots)),
    slotCoverage: { covered, total: slots.length, rate: slots.length === 0 ? 0 : covered / slots.length },
    constraints,
    constraintPassRate: { passed, applicable: scored.length, rate: scored.length === 0 ? 0 : passed / scored.length },
    setConsistency,
    identityConsistency: [...identityConsistency],
    setVlmRubric: [...setVlmRubric],
    paletteConsistency,
    styleConsistency,
    carryThrough: [...carryThrough],
    designQuality,
    // #3444：core 图像槽与视频槽两条线分开报。core 判据复用 `slotIsCore`（同 M1），
    // 免得「哪些槽算核心」在这里长出第二条定义
    delivery: scoreDelivery(spec, slots, artifacts, (slot) => slotIsCore(slot) && slotAccepts(slot, 'image')),
    videoDelivery: scoreDelivery(spec, slots, artifacts, (slot) => slotAccepts(slot, 'video')),
    m1Success: scoreM1Success({ spec, artifacts, slots, constraints, measurementValid, scope: 'all-core' }),
    m1FinalCore: spec.slots.some((slot) => slot.stage !== undefined)
      ? scoreM1Success({ spec, artifacts, slots, constraints, measurementValid, scope: 'final-core' })
      : null,
    hardGate: {
      zeroDelivery: artifacts.length === 0,
      criticalConstraintFailed: constraints.some(
        (verdict) => verdict.verdict === 'fail'
          && spec.constraints.some((c) => c.id === verdict.constraintId && c.kind === 'text-verbatim' && c.critical === true),
      ),
    },
  }
}
