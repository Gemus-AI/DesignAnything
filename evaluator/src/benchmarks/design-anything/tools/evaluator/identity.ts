/**
 * 跨产物**身份**一致性（#3173）—— 「同一个 logo 有没有在五件产物上保持同一个」。
 *
 * ## 它补的是哪个盲区
 *
 * 身份一致性此前只在**产物上恰好印了字**的时候可判：`text-verbatim` 走转写文本的子串匹配，
 * `setConsistency` 走转写里的 token 编辑距离，两条都以 OCR 命中为前提。而产物印没印字是
 * 模型**每轮自由选**的，不是题目要求的 —— 于是「这条判据可不可判」成了一个未建模的随机项，
 * 且缺席被记成 `not-applicable`，读起来像「这题没这个问题」。
 * #3169 实测：space 阶梯上 `setConsistencyApplicable` **恒为 0**。
 *
 * ## ⚠️ 隔离铁律（不可违反）
 *
 * 本判据属于**冻结 benchmark evaluator**。将来的 runtime auditor（#3177）**禁止**复用
 * 本模块与 `IDENTITY_PROMPT_SHA`。运行时机制与量尺共享偏差 = 自证循环（备忘录 §7.14）：
 * 系统用同一把尺子既指导自己修复、又证明自己修好了。
 *
 * ## 结构：判定与调用分离
 *
 * {@link scoreIdentityRule} 是**纯函数**（pairwise 结果喂进来），{@link judgeIdentity}
 * 负责真正的双图调用。理由与 `scoring.ts` 同源：一批读数出了争议时，拿缓存里的 pairwise
 * 结果重跑纯函数就能逐条复核，不需要重新相信一次模型。
 *
 * @module benchmarks/design-anything/tools/evaluator/identity
 */

import path from 'path'

import { renderIllegibleSidePrompt, renderIdentityPrompt } from './prompts'
import type { IdentityConsistencyRule, SlotStage } from './taskSpec'
import type { ScoredArtifact } from './scoring'
import type { SlotVerdict } from './scoring'
import { VlmUnreadableError, askPairVlm } from './vlm'
import { resolveIdentityAsset, type IdentityAssetBindings } from './assetBindings'
import { identityBand, retiredIdentityReason, type IdentityBand } from './truthSource'

/**
 * 单对判定。
 *
 * `unjudgeable` 是**一等出口**，不是错误码：主体在某一张里根本不存在、太小、被遮挡，
 * 或视觉调用失败。把它折进 `different` 就是拿仪器的盲区冒充被测对象的缺陷 ——
 * 这是本仓库反复踩的同一个坑（#2415「缺席 ≠ 0」）。
 */
export type PairVerdict = 'same' | 'different' | 'unjudgeable'

export interface IdentityPairVerdict {
  anchorFile: string
  subjectFile: string
  subjectSlot: string
  verdict: PairVerdict
  reason: string
  /** 见 {@link IllegibleSide}。只在 `unjudgeable` 时出现；旧包缺席。 */
  illegibleSide?: IllegibleSide
}

/** 双图判定的分布 —— 纯粹的一致性读数（#3380），缺件不在里面。 */
export interface IdentityPairTally {
  same: number
  different: number
  unjudgeable: number
  /**
   * 判不出来里，**读不出的那一侧是被测系统的产物**的对数（#3806）。
   *
   * `checked`（被查的那张看不清）、`both`（两张都看不清）、`neither`（两张都看得清但找不到
   * 足够特定的特征）三种都归这里 —— 三种都是「这一组产物无法互证身份」，是被测对象的缺陷。
   * 只有 `reference`（素材包里那张参考图自己糊）不算，那是出题的问题（#3428）。
   *
   * 旧包（提示词加 `illegibleSide` 之前跑的）这个数恒为 0，而 `unjudgeable` 不为 0 ——
   * 两者之差就是「还没有归属读数」的对数，聚合侧据此决定报点值还是报区间。
   */
  unjudgeableOnSystem: number
  /**
   * 判不出来里，**判官给出了归属**的对数（四种取值任一）。与 {@link unjudgeableOnSystem}
   * 的差 = 归给素材包那张参考图的对数；与 `unjudgeable` 的差 = **还没有归属读数**的对数
   * （旧包，或判官这一对没答上来）。后者不为零时聚合侧必须退回区间 —— 它们的去向未知。
   */
  unjudgeableAttributed: number
}

export interface IdentityVerdict {
  ruleId: string
  subject: IdentityConsistencyRule['subject']
  verdict: 'pass' | 'fail' | 'not-applicable'
  /**
   * 这条规则在主张什么（#3518）—— `assets` 有没有编造、`run` 是不是同一个物件、
   * `lineage` 是不是从它发展来的。三种主张不同，合成一个通过率就看不出赢在哪。
   *
   * 可选：#3518 之前的 evaluation.json 没有它，报表层归到 `unbanded` 并打标记——
   * 「没分档」与「这一档没规则」必须在表面上分得开。
   */
  band?: IdentityBand
  /** 判定依据的一句话，让「为什么是这个结论」不必反推 */
  reason: string
  anchorFile: string | null
  pairs: IdentityPairVerdict[]
  /**
   * 零交付的 subject 槽（#3380）—— 把「少交了一件」这个成因从 `reason` 字符串里拎成结构化字段，
   * 让「缺件 fail」与「视觉不一致 fail」在 JSON 里就分得开。`verdict` 的取值规则**不变**。
   *
   * anchor 缺席 / 不可判的提前返回分支下为 `[]`，语义是「未计算」——那两个分支整条规则
   * 是 not-applicable，不进任何 fail 统计。可选：#3380 之前的 evaluation.json 没有它。
   */
  missingSubjectSlots?: string[]
  /** {@link tallyPairs} 的结果，写进 JSON 免得报表层再推导一遍。可选：旧文件缺省时从 `pairs` 现算。 */
  pairTally?: IdentityPairTally
}

/** `pairs` → 分布。**唯一实现**：evaluate.ts 与 compareArms.ts 都调这里，不各写一遍 filter。 */
export function tallyPairs(pairs: readonly IdentityPairVerdict[]): IdentityPairTally {
  return {
    same: pairs.filter((pair) => pair.verdict === 'same').length,
    different: pairs.filter((pair) => pair.verdict === 'different').length,
    unjudgeable: pairs.filter((pair) => pair.verdict === 'unjudgeable').length,
    unjudgeableOnSystem: pairs.filter((pair) => pair.verdict === 'unjudgeable'
      && (pair.illegibleSide === 'checked' || pair.illegibleSide === 'both' || pair.illegibleSide === 'neither')).length,
    unjudgeableAttributed: pairs.filter((pair) => pair.verdict === 'unjudgeable' && pair.illegibleSide !== undefined).length,
  }
}

/**
 * 一档里**算进图对分母**的「判不出来」对数（#3806）。
 *
 * **唯一实现**：跨臂主表与逐题分布都调这里 —— 同一个概念在报表里只能有一个数，
 * 两处各写一遍正是这条 issue 已经犯过一次的错。
 *
 * - 运行内锚（`run`）：锚与主体两侧都是被测系统自己的产物，判不出来是产物的属性不是
 *   观测条件的属性，所以每一对都算它的。
 * - 其余档：锚是素材包里的参考图（外生）。只有归到系统那一侧的（`checked` / `both` /
 *   `neither`）算进分母，归到参考图自己糊的（`reference`）退出 —— 那是出题的问题（#3428）。
 * - 这一档还有**没归属**的对时（旧包，或判官这一对没答上来），整档回落到旧口径：
 *   判不出来一律退出分母。此时调用方必须把「还有几对没归属」印出来，否则读表人会把
 *   一个缩水的分母读成定论。
 */
export function abstainsInDenominator(
  pairs: IdentityPairTally,
  band: typeof IDENTITY_BAND_ORDER[number],
): number {
  if (band === 'run') return pairs.unjudgeable
  if (pairs.unjudgeable > pairs.unjudgeableAttributed) return 0
  return pairs.unjudgeableOnSystem
}

/**
 * 这条 fail 是不是缺件造成的（#3380）。
 *
 * 用 {@link scoreIdentityRule} 的**判定不变式**而不是 `missingSubjectSlots`：分支顺序保证
 * `fail` 且没有任何 `different` 对 ⇔ 有 subject 槽零交付。旧 evaluation.json 没有新字段，
 * 但它的 `verdict` 与 `pairs` 同样满足这条不变式 —— 新旧形状在这一个计数上同口径，
 * 不会出现同一张表里一个臂认得出缺件 fail、另一个臂认不出的跨臂不对称。
 */
export function isFailFromMissing(verdict: Pick<IdentityVerdict, 'verdict' | 'pairs' | 'pairTally'>): boolean {
  if (verdict.verdict !== 'fail') return false
  return (verdict.pairTally ?? tallyPairs(verdict.pairs)).different === 0
}

/**
 * 一档的读数。`not-applicable` 不进 `applicable` —— 与既有身份口径逐字相同。
 *
 * `pairs` 是这一档的双图判定分布，**与规则级计数分开算**：规则级把「缺件 fail」与
 * 「视觉不一致 fail」折成同一个数，pair 级的 `different` 才是纯粹的一致性读数（#3380），
 * 也正是跨臂比较实际引用的那个量。它必须分档，否则 `lineage` 那一档的系统性偏差
 * （血脉链正确的答案常常就是「不是同一个」）会摊进总数里、看不见。
 */
export interface IdentityBandTally {
  passed: number
  applicable: number
  pairs: IdentityPairTally
}

/**
 * 三档 + 未分档的计数（#3518）。
 *
 * **唯一实现**：evaluate.ts 的逐 run CSV 与 compareArms.ts 的格子都调这里，不各写一遍 filter ——
 * 与 {@link tallyPairs} 同一条纪律。
 *
 * `unbanded` 装的是 #3518 之前跑出来的 evaluation.json：那时规则上没有 `band`，
 * 不能推成任何一档（锚的形状只在 spec 里，导出包里没有）。报表把它单独报并打 `~`，
 * 因为「这批还没分档」与「这一档一条规则都没有」是两件完全不同的事。
 */
export interface IdentityBandSummary {
  bands: Record<IdentityBand, IdentityBandTally>
  unbanded: IdentityBandTally
}

export function summarizeIdentityBands(verdicts: readonly IdentityVerdict[]): IdentityBandSummary {
  const empty = (): IdentityBandTally => ({ passed: 0, applicable: 0, pairs: { same: 0, different: 0, unjudgeable: 0, unjudgeableOnSystem: 0, unjudgeableAttributed: 0 } })
  const summary: IdentityBandSummary = {
    bands: { assets: empty(), run: empty(), lineage: empty() },
    unbanded: empty(),
  }
  for (const verdict of verdicts) {
    const tally = verdict.band === undefined ? summary.unbanded : summary.bands[verdict.band]
    // pair 分布无条件累加：not-applicable 的规则本来就没有对，写成无条件免得日后
    // 某个分支既 not-applicable 又留下了对，读数悄悄少一截
    const pairs = verdict.pairTally ?? tallyPairs(verdict.pairs)
    tally.pairs.same += pairs.same
    tally.pairs.different += pairs.different
    tally.pairs.unjudgeable += pairs.unjudgeable
    tally.pairs.unjudgeableOnSystem += pairs.unjudgeableOnSystem
    tally.pairs.unjudgeableAttributed += pairs.unjudgeableAttributed
    if (verdict.verdict === 'not-applicable') continue
    tally.applicable += 1
    if (verdict.verdict === 'pass') tally.passed += 1
  }
  return summary
}

/**
 * 身份三档在 CSV 里的列名与取值（#3518）—— **两者共用同一份档次顺序**，
 * 理由与 compareArms 的空行纪律同一条：CSV 是位置寻址的，列名与取值分两处写迟早会错位。
 */
export const IDENTITY_BAND_ORDER = ['assets', 'run', 'lineage', 'unbanded'] as const

export function identityBandTally(summary: IdentityBandSummary, band: typeof IDENTITY_BAND_ORDER[number]): IdentityBandTally {
  return band === 'unbanded' ? summary.unbanded : summary.bands[band]
}

export function identityBandColumns(): string[] {
  return IDENTITY_BAND_ORDER.flatMap((band) => {
    const name = `identity${band[0].toUpperCase()}${band.slice(1)}`
    return [`${name}Passed`, `${name}Applicable`, `${name}PairsSame`, `${name}PairsDifferent`, `${name}PairsUnjudgeable`]
  })
}

export function identityBandValues(summary: IdentityBandSummary): number[] {
  return IDENTITY_BAND_ORDER.flatMap((band) => {
    const tally = identityBandTally(summary, band)
    return [tally.passed, tally.applicable, tally.pairs.same, tally.pairs.different, tally.pairs.unjudgeable]
  })
}

/** 模型回复形状；字段缺失/答歪在 {@link toPairVerdict} 收敛，不在别处信任。 */
export interface IdentityReply {
  verdict?: unknown
  reason?: unknown
}

/** 归属那一问的回复（#3806）。与 {@link IdentityReply} 分开：两者是两次独立调用。 */
export interface IllegibleSideReply {
  illegibleSide?: unknown
  reason?: unknown
}

/**
 * 判不出来时，**读不出的是哪一侧**（#3806）。
 *
 * 这一档存在的理由是：素材锚那一档的锚是素材包里的参考图（外生），主体是被测系统的产物（内生）。
 * 「参考图本身糊」该退出分母 —— 那是我们出题的问题（#3428 记着 bench 参考素材全部由
 * gpt-image-2 生成、无出处）；「系统的图里看不见那个产品」不该退出 —— 那是被测对象的缺陷。
 * 没有这个字段之前两者只能一起报成区间。
 *
 * `neither` = 两张都看得清，只是找不到足够特定的特征来判同一性。它归**被测系统**：
 * 交出一组彼此无法互证的图，本身就是身份一致性没做到。
 */
export type IllegibleSide = 'reference' | 'checked' | 'both' | 'neither'

/**
 * 回复 → 判定。非法取值一律 `unjudgeable`（答歪不该被读成「不是同一个」）。
 *
 * `illegibleSide` 只在 `unjudgeable` 时有意义，且**答歪或缺席时留 `undefined` 而不是猜一个**：
 * 旧包（提示词加这个字段之前跑的）没有它，缺席必须与「答了但答不上来」分得开 ——
 * 前者是这批数据还没这个读数，后者是判官的回答。聚合侧据此决定要不要退出分母。
 */
export function toPairVerdict(reply: IdentityReply | null): { verdict: PairVerdict; reason: string } {
  const verdict = reply?.verdict
  const reason = typeof reply?.reason === 'string' ? reply.reason : ''
  if (verdict === 'same' || verdict === 'different' || verdict === 'unjudgeable') return { verdict, reason }
  return { verdict: 'unjudgeable', reason: reason || `evaluator returned an unrecognised verdict "${String(verdict)}"` }
}

/**
 * 归属回复 → `illegibleSide`（#3806）。答歪或缺席一律 `undefined`，**不猜** ——
 * 「还没有这个读数」与「判官答不上来」在聚合侧是同一种处置（退回区间），
 * 但都不该被伪造成某一侧。
 */
export function toIllegibleSide(reply: IllegibleSideReply | null): IllegibleSide | undefined {
  const raw = reply?.illegibleSide
  return raw === 'reference' || raw === 'checked' || raw === 'both' || raw === 'neither' ? raw : undefined
}

/**
 * 规则级判定 —— **纯函数**。
 *
 * ```
 * not-applicable = anchor 槽无交付 | anchor 不是图像 | 一对可判的都没有
 * fail           = 任一对 different  或  任一 subjectSlot 的 delivered 为空
 * pass           = 至少一对可判，且无 different
 * ```
 *
 * ## 两条必须分清的边界（本模块存在的全部意义）
 *
 * - **subject 槽一件都没交 → `fail`。** 少交一件 = 身份没有被带到那件上。
 *   这正是本 issue 要修的盲区：当前 `setConsistency` 把它记成 `not-applicable`，
 *   读起来像「这题没这个问题」。
 * - **subject 槽交了、但交的不是图像（或读不出）→ `unjudgeable`，不是 `fail`。**
 *   身份尺看不见它。判 fail 就是造一条根本没发生的违规。
 *
 * 两者的差别是「有没有交」，不是「看不看得见」—— 这条区分不做，尺子就会同时高估和低估。
 */
export function scoreIdentityRule(input: {
  rule: IdentityConsistencyRule
  anchorFile: string | null
  /** anchor 是不是这把尺子看得懂的载体（图像）。false → not-applicable */
  anchorJudgeable: boolean
  /** 每个 subject 槽的交付件数（含非图像件）—— 用来把「没交」与「看不见」分开 */
  deliveredCountBySlot: ReadonlyMap<string, number>
  pairs: readonly IdentityPairVerdict[]
}): IdentityVerdict {
  const { rule, anchorFile, pairs } = input
  const base = { ruleId: rule.id, subject: rule.subject, anchorFile, pairs: [...pairs], missingSubjectSlots: [] as string[], pairTally: tallyPairs(pairs) }

  if (anchorFile === null) {
    const where = rule.anchorSlot !== undefined ? `anchor slot "${rule.anchorSlot}" delivered nothing` : `none of the anchor assets ${JSON.stringify(rule.anchorAssets ?? [])} could be read`
    return { ...base, verdict: 'not-applicable', reason: `${where} — there is no identity to compare against` }
  }
  if (!input.anchorJudgeable) {
    return { ...base, verdict: 'not-applicable', reason: `anchor "${anchorFile}" is not an image — this ruler cannot read it` }
  }

  // 「没交」优先于「看不见」：一个槽零交付是真实缺陷，哪怕其余对都判不了
  const missing = rule.subjectSlots.filter((slotId) => (input.deliveredCountBySlot.get(slotId) ?? 0) === 0)
  if (missing.length > 0) {
    return { ...base, missingSubjectSlots: missing, verdict: 'fail', reason: `subject slot(s) ${missing.join(', ')} delivered nothing — the identity was never carried onto them` }
  }

  const different = pairs.filter((pair) => pair.verdict === 'different')
  if (different.length > 0) {
    return {
      ...base,
      verdict: 'fail',
      reason: `${different.length} artifact(s) carry a different ${rule.subject}: ${different.map((pair) => pair.subjectFile).join(', ')}`,
    }
  }

  const judged = pairs.filter((pair) => pair.verdict === 'same').length
  if (judged === 0) {
    return { ...base, verdict: 'not-applicable', reason: `no pair could be judged — every subject artifact was unreadable or carried no visible ${rule.subject}` }
  }
  return { ...base, verdict: 'pass', reason: `${judged} artifact(s) carry the same ${rule.subject} as the anchor` }
}

/** 这把尺子看得懂的载体。只有栅格图 —— 给视频抽帧比对量的是"抽的那一帧"，不是身份。 */
export function isIdentityJudgeable(artifact: ScoredArtifact | undefined): boolean {
  return artifact !== undefined && artifact.contentType.startsWith('image/')
}

/**
 * 跑一条身份规则（含双图调用）。
 *
 * `evidence !== 'pixel'` 时整条规则 `not-applicable` —— #3163 的结构判据面上产物是占位图，
 * 拿它比身份量到的是占位图长不长得一样。与该档把 `pixelStrategy` 记成 `n/a` 同一条纪律。
 */
export async function judgeIdentity(input: {
  rule: IdentityConsistencyRule
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  /** 产物文件名 → 磁盘绝对路径 */
  artifactsDir: string
  /** 同版公开附件及其 SHA；缺省时没有可用素材锚。 */
  assetBindings?: IdentityAssetBindings | undefined
  cacheDir?: string | undefined
  /** 非 pixel 证据面上不判 —— 见函数说明 */
  evidenceSurface: 'pixel' | 'prompt'
  /** 这条规则属于哪道题。逐条退役（`isCoveredBySetRubric`）按题 + 规则定位，规则 id 自己不唯一。 */
  taskId: string
  /**
   * **锚槽**的 `stage`（#3566）。分档要区分「N 个互斥的备选」与「N 个并存的成员」，而这件事
   * 写在槽上、不写在规则上，故由调用方从 spec 取 —— 本函数拿到的 `slots` 是判定结果，不带 spec 属性。
   */
  anchorStage?: SlotStage | undefined
  /**
   * 这道题整套细则的全部条目原文（#3566）。逐条退役的理由是「同一道题的整套细则问得更准」，
   * 所以退役由那句话在不在这份 spec 里**派生**，不是由一张例外表断言。
   */
  setRubricItems?: readonly string[] | undefined
}): Promise<IdentityVerdict> {
  const { rule, slots, artifacts } = input
  const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
  const band = identityBand(rule, input.anchorStage)
  const anchors = resolveAnchors(rule, slots, byFile, input.artifactsDir, input.assetBindings)
  // 多锚时 anchorFile 记全部锚名，读表人一眼看到这条规则是对着什么比的
  const anchorFile = anchors.length > 0 ? anchors.map((anchor) => anchor.file).join(' | ') : null
  const anchorSet = new Set(anchors.map((anchor) => anchor.file))
  const deliveredCountBySlot = new Map(
    rule.subjectSlots.map((slotId) => [slotId, slots.find((slot) => slot.slotId === slotId)?.delivered.length ?? 0]),
  )

  // 已退役的三类规则（配色 #3518、血脉链 #3557/#3566、被整套细则覆盖 #3557）在这里一律记
  // not-applicable。放在**双图调用之前** —— 退役的规则一次模型调用都不该花。
  const retired = retiredIdentityReason(rule, { taskId: input.taskId, anchorStage: input.anchorStage, setRubricItems: input.setRubricItems })
  if (retired !== null) {
    return {
      ruleId: rule.id,
      subject: rule.subject,
      band,
      verdict: 'not-applicable',
      reason: retired,
      anchorFile: null,
      pairs: [],
      missingSubjectSlots: [],
      pairTally: tallyPairs([]),
    }
  }

  if (input.evidenceSurface !== 'pixel') {
    return {
      ruleId: rule.id,
      subject: rule.subject,
      band,
      verdict: 'not-applicable',
      reason: 'structural evidence surface carries placeholder imagery — identity cannot be judged from it',
      anchorFile,
      pairs: [],
      missingSubjectSlots: [],
      pairTally: tallyPairs([]),
    }
  }

  // 锚已在 resolveAnchors 里按"是图像"筛过；一个都没剩即不可判
  const anchorJudgeable = anchors.length > 0
  const pairs: IdentityPairVerdict[] = []

  if (anchorJudgeable) {
    const prompt = renderIdentityPrompt(rule.subject, rule.comparisonScope)
    const illegibleSidePrompt = renderIllegibleSidePrompt(rule.subject)
    for (const slotId of rule.subjectSlots) {
      const slot = slots.find((item) => item.slotId === slotId)
      for (const file of slot?.delivered ?? []) {
        // 同槽内一致性：锚件不与自己比（那恒真，且白烧一次双图调用）
        if (anchorSet.has(file)) continue
        const subject = byFile.get(file)
        if (!isIdentityJudgeable(subject) || subject === undefined) {
          // 交了、但这把尺子看不见 —— unjudgeable，**不是** fail
          pairs.push({
            anchorFile: anchors[0].file, subjectFile: file, subjectSlot: slotId, verdict: 'unjudgeable',
            reason: `artifact is ${subject?.contentType ?? 'missing'} — not an image this ruler can read`,
            // 交上来的这一件本身不是这把尺子能读的载体 —— 读不出的那一侧是被测系统（#3806）
            illegibleSide: 'checked',
          })
          continue
        }
        // 每个锚各比一次，再按"任一同一即同一"合成这一件的判定
        const perAnchor: IdentityPairVerdict[] = []
        for (const anchor of anchors) {
          perAnchor.push({
            anchorFile: anchor.file,
            subjectFile: file,
            subjectSlot: slotId,
            ...await judgeIdentityPair({
              prompt,
              illegibleSidePrompt,
              anchor: { path: anchor.path, contentType: anchor.contentType },
              subject: { path: path.join(input.artifactsDir, file), contentType: subject.contentType },
              cacheDir: input.cacheDir,
            }),
          })
          // 已经命中同一即可停：后面的锚不会改变结论，省下的是真金白银的双图调用
          if (perAnchor[perAnchor.length - 1].verdict === 'same') break
        }
        pairs.push(mergeAnchorVerdicts(perAnchor))
      }
    }
  }

  return { ...scoreIdentityRule({ rule, anchorFile, anchorJudgeable, deliveredCountBySlot, pairs }), band }
}

/**
 * **判一对**：整个仓库里唯一一处「拿两张图问模型是不是同一个」的调用（#3634）。
 *
 * 抽出来不是为了少写几行，是为了让「定点重判」与「整批评估」在结构上无法给出不同的答案。
 * 校准量的是这个函数；κ 一旦算出来，它背书的就是正式批次真正用的那条路径 —— 两处各写一遍
 * 再加一条断言相等的测试，断言会随代码漂移，共用调用路径不会。
 *
 * 合成（多锚「任一同一即同一」）刻意留在调用方：人工标注看到的是**一对**图，
 * 校准的判定单元也是一对，把合成塞进来会让这个函数和标注者看到的东西对不上。
 */
export async function judgeIdentityPair(input: {
  /** 由 `renderIdentityPrompt(subject, comparisonScope)` 渲染。传渲染结果而不是参数，
   *  是为了让整批路径保持「每条规则渲染一次」的现状，不因本次抽取而改变行为。 */
  prompt: { text: string; cacheSha: string }
  /**
   * 归属那一问的提示词（#3806）。**只在判成 `unjudgeable` 之后才发**，
   * 所以它不影响同一性判定，也不动 {@link IDENTITY_PROMPT_SHA} —— 台账 §5.2 的 κ 0.887
   * 是对着那份模板标的，改它这一列就得退出主表。缺席则不追问（旧路径逐字不变）。
   */
  illegibleSidePrompt?: { text: string; cacheSha: string }
  anchor: { path: string; contentType: string }
  subject: { path: string; contentType: string }
  cacheDir?: string | undefined
}): Promise<{ verdict: PairVerdict; reason: string; illegibleSide?: IllegibleSide }> {
  try {
    const reply = await askPairVlm<IdentityReply>({
      anchorPath: input.anchor.path,
      anchorContentType: input.anchor.contentType,
      subjectPath: input.subject.path,
      subjectContentType: input.subject.contentType,
      prompt: input.prompt.text,
      promptSha: input.prompt.cacheSha,
      cacheDir: input.cacheDir,
    })
    const judged = toPairVerdict(reply)
    if (judged.verdict !== 'unjudgeable' || input.illegibleSidePrompt === undefined) return judged
    // 只对判不出来的那些对追问归属：实测三臂合计 82 对，而全部图对是 599 对
    try {
      const sideReply = await askPairVlm<IllegibleSideReply>({
        anchorPath: input.anchor.path,
        anchorContentType: input.anchor.contentType,
        subjectPath: input.subject.path,
        subjectContentType: input.subject.contentType,
        prompt: input.illegibleSidePrompt.text,
        promptSha: input.illegibleSidePrompt.cacheSha,
        cacheDir: input.cacheDir,
      })
      const side = toIllegibleSide(sideReply)
      return side === undefined ? judged : { ...judged, illegibleSide: side }
    } catch (error) {
      // 归属问不出来不该动同一性判定 —— 退回没有归属的那一版，聚合侧据此报区间
      if (!(error instanceof VlmUnreadableError)) throw error
      return judged
    }
  } catch (error) {
    if (!(error instanceof VlmUnreadableError)) throw error
    // 调用失败 → unjudgeable。一对判不出来不该炸掉整批，更不该被读成一条违规
    return { verdict: 'unjudgeable', reason: 'identity call failed after retry — excluded from the verdict' }
  }
}

/** 一个已解析的锚：显示名、磁盘路径、类型。 */
interface ResolvedAnchor { file: string; path: string; contentType: string }

const ASSET_CONTENT_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

/**
 * 素材锚的载体类型：题包里的素材没有 manifest 记类型，只能按扩展名定（#3634 起共用）。
 * 认不出来返回 `undefined` —— 这把尺子读不了的载体不该硬塞一个类型给它。
 *
 * 导出包里的件**不走这里**：它们的类型由 manifest 记着，按扩展名重猜会掩盖记错类型的数据问题。
 */
export function identityAssetContentType(file: string): string | undefined {
  return ASSET_CONTENT_TYPES[path.extname(file).toLowerCase()]
}

/**
 * 把规则里的锚声明解析成可比对的图像文件列表。
 *
 * - `anchorAssets`：同版 scenario 已绑定的附件，路径或 SHA 不符时拒绝读取
 * - `anchorSlot` + `anchorSelect: 'any'`：该槽交付集里的每一件图像
 * - `anchorSlot`（缺省）：代表件
 */
export function resolveAnchors(
  rule: IdentityConsistencyRule,
  slots: readonly SlotVerdict[],
  byFile: ReadonlyMap<string, ScoredArtifact>,
  artifactsDir: string,
  assetBindings: IdentityAssetBindings | undefined,
): ResolvedAnchor[] {
  if (rule.anchorAssets !== undefined) {
    if (assetBindings === undefined) throw new Error('Identity asset bindings are required for anchorAssets')
    return rule.anchorAssets.flatMap((file) => {
      const contentType = identityAssetContentType(file)
      if (contentType === undefined) return []
      return [{ file, path: resolveIdentityAsset(assetBindings, file), contentType }]
    })
  }
  const slot = slots.find((item) => item.slotId === rule.anchorSlot)
  const candidates = rule.anchorSelect === 'any'
    ? slot?.delivered ?? []
    : slot?.representative !== null && slot?.representative !== undefined ? [slot.representative] : []
  return candidates.flatMap((file) => {
    const artifact = byFile.get(file)
    return isIdentityJudgeable(artifact) && artifact !== undefined
      ? [{ file, path: path.join(artifactsDir, file), contentType: artifact.contentType }]
      : []
  })
}

/**
 * 多锚合成：任一 `same` → same；否则任一 `different` → different；否则 unjudgeable。
 *
 * 顺序是刻意的：多锚的语义是"与其中一个同一"，所以有一个 same 就足以证明；
 * 全是 different 才是真的没带上身份；一个都判不出来则仍是仪器盲区。
 */
export function mergeAnchorVerdicts(perAnchor: readonly IdentityPairVerdict[]): IdentityPairVerdict {
  const same = perAnchor.find((pair) => pair.verdict === 'same')
  if (same !== undefined) return same
  const different = perAnchor.filter((pair) => pair.verdict === 'different')
  if (different.length > 0) {
    const [first] = different
    return {
      ...first,
      reason: perAnchor.length === 1
        ? first.reason
        : `differs from every anchor tried (${perAnchor.map((pair) => pair.anchorFile).join(', ')}): ${first.reason}`,
    }
  }
  return perAnchor[0]
}
