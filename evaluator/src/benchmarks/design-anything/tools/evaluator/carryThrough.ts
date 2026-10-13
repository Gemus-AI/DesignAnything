/**
 * 前后一致（carry-through，#3442）—— 「系统自己在前期文本里写下的决定，后期产物执行了没有」。
 *
 * ## 它与其它判据的根本差别：要核对的约束不在题面上
 *
 * `constraints[]` 的每一条逐字约束，token 在**写题时**就已知（brief 要求主色是 `#2D5A4A`）。
 * 这一层打破了那个假设：决定是系统运行时才写下的（策略稿说「主色 `#1F6FEB`」），
 * 所以 token 要先从**一件产物**里读出来，再拿去核对**另一些产物**。缺的不是一条规则，
 * 是「运行时派生约束」这个形状。
 *
 * ## 跨臂对称性靠一个事实保证
 *
 * 提取的输入是 {@link ScoredArtifact.textLines}。三条臂在这里是同一条通道 —— 我们自家的
 * inline 文本件、JarvisHub 从 pptx / SVG 抽出的逐页文本、OpenDesign 渲染页的视觉转写，
 * 最后都落成 `textLines`。提取器不知道也不需要知道文本是从哪种载体来的。
 *
 * ## 结构：判定与调用分离（同 `identity.ts`）
 *
 * {@link scoreCarryThrough} 是**纯函数**（提取结果喂进来），{@link judgeCarryThrough} 负责
 * 真正的模型调用。理由一样：一批读数出了争议时，拿缓存里的提取结果重跑纯函数就能逐条复核，
 * 不需要重新相信一次模型。把「抽了什么」和「有没有命中」合成一次调用，结果就不可复算了。
 *
 * ## ⚠️ 隔离铁律（不可违反）
 *
 * 本判据属于**冻结 benchmark evaluator**。将来的 runtime auditor（#3177）**禁止**复用本模块与
 * `CARRY_EXTRACT_PROMPT_SHA`：运行时机制与量尺共享偏差 = 自证循环。
 *
 * ## 本 issue 的 P0 只做逐字腿
 *
 * 指南 §2.3 第三层还有一档「气质是否符合策略定位」的 0/1/2 视觉判定，依赖 #3441 的公共原语，
 * 落在 P1。逐字腿先行不是拆得随意：逐字可复算、可被第三方拿同一批产物验证，模型判定是它的补充
 * 而不是替代（PPTEval 实测跨件连贯判断与人一致性最低，0.55）。
 *
 * @module benchmarks/design-anything/tools/evaluator/carryThrough
 */

import path from 'path'

import { renderCarryExtractPrompt, renderCarryTemperamentPrompt } from './prompts'
import { RUBRIC_SCALE_MAP, RubricReplyError, aggregateRubric, parseRubricReply, type RubricAggregate, type RubricScore } from './rubric'
import { extractHexTokens, normalizeForMatch, type ScoredArtifact, type SlotVerdict } from './scoring'
import type { CarryThroughRule } from './taskSpec'
import { VlmUnreadableError, askInlineTextEvaluator, askVlm } from './vlm'

/**
 * 一个 token 有多长才还算「决定」而不是「一句话」。
 *
 * 上界是必需的确定性护栏，不是可调旋钮：提取器把整句散文当 token 交回来时，它同样是来源
 * 文本的子串（子串复查放行），却几乎不可能逐字出现在任何一件后续产物上 —— 于是每一格都判 fail，
 * 而那是仪器造出来的违规。40 取自 `scoring.ts` 里同一条口径（`editDistance` 的「token 都很短
 * （≤ 40 字符）」）。数的是**归一化后**的长度，与命中判定同一把尺。
 */
const MAX_TOKEN_LENGTH = 40

/** 提取阶段丢弃一个 token 的原因。进 `evaluation.json` —— 提取器在不在编，要能被数出来。 */
export type CarryRejectReason =
  /** 项名不在 `rule.extract` 里 —— 模型自己发明的要求，不能变成对产物的约束 */
  | 'unknown-item'
  /** 归一化后不是来源文本的子串 —— 提取器编的 */
  | 'not-in-source'
  /** 归一化后超过 {@link MAX_TOKEN_LENGTH} —— 是一句话，不是一个决定 */
  | 'too-long'
  /** 不是字符串，或归一化后为空 */
  | 'malformed'

export interface CarryRejectedToken {
  item: string
  token: string
  reason: CarryRejectReason
}

/** 一项已被子串复查放行的决定。`tokens` 恒非空 —— 空的那些在提取期就被丢掉了。 */
export interface CarryDecision {
  item: string
  tokens: string[]
}

/**
 * 提取阶段的产物。{@link judgeCarryThrough} 调模型 + 复查后得到，喂给纯函数。
 *
 * `unavailable` 非 null = 这一条根本没跑到核对那一步（来源件读不出、没声明项名、调用失败）。
 * 它与「跑了但没命中」必须分开：前者是仪器够不着，后者是被测系统的缺陷。
 */
export interface CarryExtraction {
  /** 来源槽的代表件；`null` = 来源槽零交付 */
  fromFile: string | null
  /** 没能进行提取的原因（整句话，直接进 verdict 的 reason）；`null` = 提取正常跑完 */
  unavailable: string | null
  decisions: CarryDecision[]
  rejected: CarryRejectedToken[]
}

/** 一次「这个 token 在这一件上出现了没有」的核对。逐件记录，让 verdict 可以离线重算。 */
export interface CarryTokenCheck {
  slot: string
  file: string
  item: string
  token: string
  hit: boolean
  /** 未命中时这一件转写到的 hex —— 「写了但写错了」与「根本没写」是两种缺陷（同 `scoreConstraints`） */
  sawInstead?: string[]
}

/**
 * 气质一档的**唯一**条目措辞（#3442 P1）。冻结在代码里而不是 spec 里：spec 侧每题各写一遍
 * 就会出现 20 种问法，跨题的气质分不再是同一个量。改这一行 = 换一把尺子，必须同时重跑全部批次。
 */
export const CARRY_TEMPERAMENT_ITEM = "the artifact's visual character matches the positioning stated in the strategy text"

/** 一个目标槽代表件的气质判定。逐槽记录，让均值可以离线重算。 */
export interface CarryTemperamentVerdict {
  slot: string
  /** 被判的那一件（该槽代表件） */
  file: string
  score: RubricScore
  reason: string
}

/**
 * 气质一档的聚合。`applicable` / `mean0to2` / `mapped0to100` 直接来自 `rubric.ts`（#3441），
 * 三处判据共用同一套口径 —— 「N/A 不进分母、全 N/A 是 null 不是 0」只能有一份实现。
 */
export interface CarryTemperament extends RubricAggregate {
  verdicts: CarryTemperamentVerdict[]
  /** 一件都没判成的原因；`null` = 至少判了一件。与 `applicable === 0` 一起读 */
  unavailable: string | null
}

export interface CarryThroughVerdict {
  ruleId: string
  verdict: 'pass' | 'fail' | 'not-applicable'
  /** 判定依据的一句话，让「为什么是这个结论」不必反推 */
  reason: string
  fromFile: string | null
  /** 提取到、且通过子串复查的决定 */
  decisions: CarryDecision[]
  /** 被复查丢掉的 token。拒绝率高 = 提取器在编，是 P2 校准要看的那个数 */
  extractorRejected: CarryRejectedToken[]
  /** 命中的（决定 × 目标槽）格数 */
  hits: number
  /** 分母 = 决定数 × 有可读交付的目标槽数 */
  applicable: number
  checks: CarryTokenCheck[]
  /**
   * 气质一档（#3442 P1）—— 与 `verdict` **并列**，不折进它。
   *
   * 逐字腿是确定性的、可被第三方拿同一批产物复算；气质档是模型判定，κ 未达标前不该
   * 反过来把一条可复算的 pass 翻成 fail。两者合成一个 verdict 就再也分不开了。
   */
  temperament: CarryTemperament
}

/** 提取器的回复形状；字段缺失/答歪在 {@link toCarryExtraction} 收敛，不在别处信任。 */
export interface CarryExtractReply {
  decisions?: unknown
}

/**
 * 模型回复 → 可核对的决定 —— **纯函数**，且是本模块唯一的信任边界。
 *
 * 三道确定性复查，都只朝**少判违规**的方向走：
 *
 * 1. **项名必须在 `rule.extract` 里。** 模型发明的项名会变成一条没人要求过的约束。
 * 2. **token 归一化后必须是来源文本的子串。** 提取器编出来的词不能变成对别人的要求 ——
 *    这是本判据最容易失效的地方，也是它必须与命中判定分成两步的原因。
 * 3. **token 归一化后不超过 {@link MAX_TOKEN_LENGTH}。** 见该常量的说明。
 *
 * 复查用的归一化与命中判定**同一个函数、同一个大小写口径**（`normalizeForMatch(_, false)`）。
 * 两处不一致的话，会出现「复查说这个 token 在来源里」而「命中判定认为它不在」的自相矛盾。
 *
 * 一项决定的 token 被全部丢光时，这一项整个消失（而不是留一个空壳判 fail）：
 * 「策略里没写下可核对的东西」是来源件的缺陷，属 M1 那一栏该管的，不在这里记 0。
 */
export function toCarryExtraction(input: {
  reply: CarryExtractReply | null
  /** 来源件的转写文本（`textLines.join('\n')`） */
  sourceText: string
  /** `rule.extract` 声明的项名 */
  items: readonly string[]
}): { decisions: CarryDecision[]; rejected: CarryRejectedToken[] } {
  const haystack = normalizeForMatch(input.sourceText, false)
  const declared = new Set(input.items)
  const byItem = new Map<string, string[]>()
  const rejected: CarryRejectedToken[] = []
  const entries = Array.isArray(input.reply?.decisions) ? input.reply.decisions : []

  for (const entry of entries) {
    const item = (entry as { item?: unknown } | null)?.item
    if (typeof item !== 'string') continue
    const rawTokens = (entry as { tokens?: unknown }).tokens
    const tokens = Array.isArray(rawTokens) ? rawTokens : []
    for (const token of tokens) {
      if (typeof token !== 'string') {
        rejected.push({ item, token: String(token), reason: 'malformed' })
        continue
      }
      if (!declared.has(item)) {
        rejected.push({ item, token, reason: 'unknown-item' })
        continue
      }
      const needle = normalizeForMatch(token, false)
      if (needle.length === 0) {
        rejected.push({ item, token, reason: 'malformed' })
        continue
      }
      if (needle.length > MAX_TOKEN_LENGTH) {
        rejected.push({ item, token, reason: 'too-long' })
        continue
      }
      if (!haystack.includes(needle)) {
        rejected.push({ item, token, reason: 'not-in-source' })
        continue
      }
      const kept = byItem.get(item) ?? []
      // 同一项里重复给同一个 token 只算一次：分母是「决定 × 槽」，重复会悄悄给这一项加权
      if (!kept.some((existing) => normalizeForMatch(existing, false) === needle)) kept.push(token)
      byItem.set(item, kept)
    }
  }

  // 按 `rule.extract` 的声明顺序输出 —— 读表人看到的顺序与题面一致，且与模型回复的顺序无关
  const decisions = input.items.flatMap((item) => {
    const tokens = byItem.get(item)
    return tokens !== undefined && tokens.length > 0 ? [{ item, tokens }] : []
  })
  return { decisions, rejected }
}

/**
 * 规则级判定 —— **纯函数**。
 *
 * ```
 * not-applicable = 来源槽零交付 | 来源件读不出/没声明项名/调用失败 | 提取为空 | 目标槽全无可读交付
 * fail           = 有一格（决定 × 槽）没执行
 * pass           = 每一格都执行了
 * ```
 *
 * ## 分母为什么是「决定 × 槽」而不是「决定 × 件」
 *
 * 一个槽可以交多件（品牌方案给三张应用图）。按件算的话，同一条决定在交得多的槽上被要求得更多次，
 * 交得少的臂反而分母小 —— 那是把「交了几件」这个已经被完成度量过的东西又混进一致性读数。
 *
 * 于是一格的判据是：这条决定的**每个 token 都至少在该槽的某一件可读交付上出现**。
 * 取「某一件」而不是「每一件」是刻意的：三个关键词分别印在三张应用图上，是正常的专业做法，
 * 按「每一件都要写全」会判出大量根本不存在的违规。逐件读数照样留在 {@link CarryThroughVerdict.checks}
 * 里，将来要换成更严的口径不必重跑模型。
 *
 * ## 目标槽零交付**不进分母**
 *
 * 缺件是 M1 完成度那一栏的事，在这里再扣一次等于同一个缺陷计两次（同 `scoreConstraints` 的
 * `not-applicable` 口径）。转写失败的件同样退出作用面 —— 读不出来时当成「什么都没写」，
 * 会判出一条根本没发生的违规。
 */
export function scoreCarryThrough(input: {
  rule: CarryThroughRule
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  extraction: CarryExtraction
  /**
   * 气质一档的判定（#3442 P1）。**与逐字腿相互独立**：逐字腿判 not-applicable 时它照样有读数，
   * 因为「策略里没写下可逐字核对的东西」恰恰是气质档存在的理由。
   */
  temperament: CarryTemperament
}): CarryThroughVerdict {
  const { rule, slots, artifacts, extraction, temperament } = input
  const base = {
    ruleId: rule.id,
    fromFile: extraction.fromFile,
    decisions: [...extraction.decisions],
    extractorRejected: [...extraction.rejected],
    temperament,
  }
  const notApplicable = (reason: string): CarryThroughVerdict =>
    ({ ...base, verdict: 'not-applicable', reason, hits: 0, applicable: 0, checks: [] })

  if (extraction.fromFile === null) {
    return notApplicable(`source slot "${rule.fromSlot}" delivered nothing — there is no written decision to carry`)
  }
  if (extraction.unavailable !== null) return notApplicable(extraction.unavailable)
  if (extraction.decisions.length === 0) {
    return notApplicable(`"${extraction.fromFile}" states no verbatim-checkable decision — nothing for the later pieces to execute`)
  }

  const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
  const targets = rule.toSlots.flatMap((slotId) => {
    const slot = slots.find((item) => item.slotId === slotId)
    const readable = (slot === undefined ? [] : slot.delivered).flatMap((file) => {
      const artifact = byFile.get(file)
      // 位图不进逐字腿（#3555）。**这是跳过，不是判不通过** —— 一张渲染图不印出
      // `#3B2417` / `严禁渐变` / `1600×1600 px` 不是缺陷，要求它印才是类别错误。
      // 判据按**这一件实际是什么**定，不按槽声明了什么：同一个槽既收文档又收图时，
      // 交上来的那一件是文档就查、是图就跳，气质腿那边正好相反。
      return artifact !== undefined
        && artifact.transcriptionFailed !== true
        && !artifact.contentType.startsWith('image/')
        ? [artifact] : []
    })
    return readable.length > 0 ? [{ slotId, readable }] : []
  })
  if (targets.length === 0) {
    return notApplicable(
      `none of the target slots (${rule.toSlots.join(', ')}) delivered a text-bearing artifact this leg can read `
      + '— pictures are skipped here by design (#3555) and a shortfall is M1\'s reading, not this one\'s',
    )
  }

  const checks: CarryTokenCheck[] = []
  const missed: string[] = []
  let hits = 0

  for (const target of targets) {
    for (const decision of extraction.decisions) {
      let carried = true
      for (const token of decision.tokens) {
        const needle = normalizeForMatch(token, false)
        let seenOnAny = false
        for (const artifact of target.readable) {
          const hit = normalizeForMatch(artifact.textLines.join('\n'), false).includes(needle)
          if (hit) seenOnAny = true
          checks.push({
            slot: target.slotId,
            file: artifact.file,
            item: decision.item,
            token,
            hit,
            ...(hit ? {} : { sawInstead: extractHexTokens(artifact.textLines) }),
          })
        }
        if (!seenOnAny) carried = false
      }
      if (carried) hits += 1
      else missed.push(`${decision.item} → ${target.slotId}`)
    }
  }

  const applicable = extraction.decisions.length * targets.length
  if (hits === applicable) {
    return {
      ...base,
      verdict: 'pass',
      reason: `all ${applicable} decision/slot pair(s) carry the decisions written in "${extraction.fromFile}"`,
      hits,
      applicable,
      checks,
    }
  }
  return {
    ...base,
    verdict: 'fail',
    reason: `${applicable - hits} of ${applicable} decision/slot pair(s) do not carry the decision: ${missed.join('; ')}`,
    hits,
    applicable,
    checks,
  }
}

/**
 * 跑一条 carry-through 规则（含提取调用）。
 *
 * 结构判据面（`--evidence prompt`）上每一件都是 `transcriptionFailed`（那条面上不存在转写），
 * 于是来源件必然读不出、整条记 `not-applicable`。不为它单开分支：那不是这把尺子的特例，
 * 就是「来源件读不出」本身。
 */
export interface CarryThroughSummary {
  /** 判了的规则数（verdict 非 not-applicable）。0 = 这一轮这层没有任何读数 */
  judgedRules: number
  /** 命中的（决定 × 目标槽）格数，跨规则求和 */
  hits: number
  /** 分母，跨规则求和。**与 hits 双列不合成一个率** —— 合成之后「零可判」与「可判但全中」会读成同一个数 */
  applicable: number
  /** 提取器被确定性复查丢掉的 token 数。拒绝率是「提取器在不在编」的直接读数（#3442 P2 校准看这个） */
  rejectedTokens: number
  /** 气质档打了分的槽数（N/A 不进分母） */
  temperamentApplicable: number
  /** 气质档 0–100 均值；一个槽都没判成 → null，不是 0 */
  temperamentMean0to100: number | null
}

/**
 * 一次运行的这一层汇总 —— **唯一实现**，CSV 与 compareArms 都调它。
 *
 * 各写一遍 filter 的代价见 #3380：同一批数据按两处口径算出两个数，而没有任何测试会看见分歧。
 *
 * 气质均值按**槽**求平均而不是先按规则再平均：规则数逐题不同（多数题只有一条），
 * 按规则套一层平均只会让单规则题的那一个槽被放大。
 */
export function summarizeCarryThrough(verdicts: readonly CarryThroughVerdict[]): CarryThroughSummary {
  const scored = verdicts.flatMap((rule) => rule.temperament.verdicts).filter((item) => item.score !== 'n/a')
  return {
    judgedRules: verdicts.filter((rule) => rule.verdict !== 'not-applicable').length,
    hits: verdicts.reduce((sum, rule) => sum + rule.hits, 0),
    applicable: verdicts.reduce((sum, rule) => sum + rule.applicable, 0),
    rejectedTokens: verdicts.reduce((sum, rule) => sum + rule.extractorRejected.length, 0),
    temperamentApplicable: scored.length,
    temperamentMean0to100: scored.length === 0
      ? null
      : scored.reduce((sum, item) => sum + RUBRIC_SCALE_MAP[item.score as 0 | 1 | 2], 0) / scored.length,
  }
}

/** 一件都没判成时的气质档。`unavailable` 说清是哪一类够不着，不是「分数为 0」。 */
export function noTemperament(unavailable: string): CarryTemperament {
  return { verdicts: [], applicable: 0, mean0to2: null, mapped0to100: null, unavailable }
}

/** 逐槽判定 → 聚合。纯函数，聚合口径全部来自 `rubric.ts`（#3441）。 */
export function toTemperament(verdicts: readonly CarryTemperamentVerdict[]): CarryTemperament {
  // 条目只有一条且是模块常量，逐行再抄一遍 `item` 是噪音；聚合只读 `score`，在这里补齐形状即可
  const asRubric = verdicts.map((verdict) => ({ item: CARRY_TEMPERAMENT_ITEM, score: verdict.score, reason: verdict.reason }))
  return { ...aggregateRubric(asRubric), verdicts: [...verdicts], unavailable: null }
}

/**
 * 跑气质一档：每个目标槽的**代表件**一次单图调用（#3442 P1）。
 *
 * ## 为什么是代表件、而且一槽只判一次
 *
 * 问的是「这一件符不符合策略定位」。同一个槽交了三张应用图时，三张都判会让交得多的槽在均值里
 * 占更大权重 —— 那是把「交了几件」混进气质读数，与逐字腿分母取「槽」而不是「件」同一条理由。
 *
 * ## 不进模型的三种情况（都记 `n/a`，不记 0）
 *
 * - 槽零交付 —— 缺件是 M1 那一栏的事（指南 §2.3「避免同一缺失扣两次」）。
 * - 代表件不是位图（文档槽的代表件是文本投影）—— 没有可看的气质，不是气质不好。
 * - 调用失败 / 回复不合契约 —— 这一次判不出来，不重试（`rubric.ts` 的纪律）。
 *
 * 三种都留一条 `verdicts` 记录而不是静默跳过：读表的人要能看出「这一槽为什么没进分母」。
 */
async function judgeTemperament(input: {
  rule: CarryThroughRule
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  sourceText: string
  artifactsDir: string
  cacheDir?: string | undefined
  ask: (image: { path: string; contentType: string }, prompt: { text: string; cacheSha: string }) => Promise<unknown>
}): Promise<CarryTemperament> {
  const items = [CARRY_TEMPERAMENT_ITEM]
  const prompt = renderCarryTemperamentPrompt(input.sourceText, items)
  const byFile = new Map(input.artifacts.map((artifact) => [artifact.file, artifact]))
  const verdicts: CarryTemperamentVerdict[] = []

  for (const slotId of input.rule.toSlots) {
    const representative = input.slots.find((slot) => slot.slotId === slotId)?.representative ?? null
    if (representative === null) {
      verdicts.push({ slot: slotId, file: '', score: 'n/a', reason: 'slot delivered nothing — a shortfall M1 already counts' })
      continue
    }
    const artifact = byFile.get(representative)
    if (artifact === undefined || !artifact.contentType.startsWith('image/')) {
      verdicts.push({ slot: slotId, file: representative, score: 'n/a', reason: 'representative is not a bitmap — it carries no visual character to read' })
      continue
    }
    try {
      const reply = await input.ask({ path: path.join(input.artifactsDir, representative), contentType: artifact.contentType }, prompt)
      const [parsed] = parseRubricReply(items, reply)
      verdicts.push({ slot: slotId, file: representative, score: parsed!.score, reason: parsed!.reason })
    } catch (error) {
      if (!(error instanceof VlmUnreadableError) && !(error instanceof RubricReplyError)) throw error
      verdicts.push({ slot: slotId, file: representative, score: 'n/a', reason: `temperament call did not yield a usable verdict: ${error.message}` })
    }
  }
  return toTemperament(verdicts)
}

export async function judgeCarryThrough(input: {
  rule: CarryThroughRule
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  /** 产物文件名 → 磁盘绝对路径。气质一档要真的读图 */
  artifactsDir: string
  /** 非 pixel 证据面上不判气质 —— 那条面上产物是占位图（同 `setRubric.ts`） */
  evidenceSurface: 'pixel' | 'prompt'
  cacheDir?: string | undefined
  /** 注入点，只给测试用；生产走 `askVlm` */
  askTemperament?: (image: { path: string; contentType: string }, prompt: { text: string; cacheSha: string }) => Promise<unknown>
}): Promise<CarryThroughVerdict> {
  const { rule, slots, artifacts } = input
  const fromSlot = slots.find((slot) => slot.slotId === rule.fromSlot)
  const fromFile = fromSlot?.representative ?? null
  const empty = { decisions: [] as CarryDecision[], rejected: [] as CarryRejectedToken[] }
  const score = (extraction: CarryExtraction, temperament: CarryTemperament): CarryThroughVerdict =>
    scoreCarryThrough({ rule, slots, artifacts, extraction, temperament })

  if (fromFile === null) {
    const reason = `source slot "${rule.fromSlot}" delivered nothing — there is no strategy text to judge against`
    return score({ fromFile: null, unavailable: null, ...empty }, noTemperament(reason))
  }

  const source = artifacts.find((artifact) => artifact.file === fromFile)
  if (source === undefined || source.transcriptionFailed === true) {
    const reason = `source artifact "${fromFile}" could not be transcribed — its decisions are unreadable`
    return score({ fromFile, unavailable: reason, ...empty }, noTemperament(reason))
  }
  const sourceText = source.textLines.join('\n')
  if (sourceText.trim() === '') {
    const reason = `source artifact "${fromFile}" carries no text — there is no written decision to extract`
    return score({ fromFile, unavailable: reason, ...empty }, noTemperament(reason))
  }

  // 气质档先跑：它**不依赖**抽取结果，来源文本可读就能判。抽取抽不出逐字 token 时
  // （规则型条目的常态）这一档正是唯一还能说话的读数，不该跟着逐字腿一起沉默。
  const temperament = input.evidenceSurface !== 'pixel'
    ? noTemperament('structural evidence surface carries placeholder imagery — visual character cannot be judged from it')
    : await judgeTemperament({
      rule,
      slots,
      artifacts,
      sourceText,
      artifactsDir: input.artifactsDir,
      cacheDir: input.cacheDir,
      ask: input.askTemperament
        ?? ((image, prompt) => askVlm<unknown>({
          imagePath: image.path,
          contentType: image.contentType,
          prompt: prompt.text,
          promptSha: prompt.cacheSha,
          cacheDir: input.cacheDir,
        })),
    })

  const items = rule.extract ?? []
  if (items.length === 0) {
    return score({
      fromFile,
      unavailable: `rule "${rule.id}" declares no extract items — its decision chain is not verbatim-checkable, so this rule is carried by the temperament leg alone`,
      ...empty,
    }, temperament)
  }

  const prompt = renderCarryExtractPrompt(items)
  let reply: CarryExtractReply | null
  try {
    reply = await askInlineTextEvaluator<CarryExtractReply>({
      subject: `${rule.id} @ ${fromFile}`,
      text: sourceText,
      prompt: prompt.text,
      promptSha: prompt.cacheSha,
      cacheDir: input.cacheDir,
    })
  } catch (error) {
    if (!(error instanceof VlmUnreadableError)) throw error
    // 调用失败 → not-applicable。一次抽取失败不该被读成「决定没被执行」
    return score({ fromFile, unavailable: 'decision extraction failed after retry — this rule was not judged', ...empty }, temperament)
  }

  return score({ fromFile, unavailable: null, ...toCarryExtraction({ reply, sourceText, items }) }, temperament)
}
