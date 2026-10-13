/**
 * 0 / 1 / 2 / N-A 条目判定的公共原语（#3441）。
 *
 * M2 第二层（`setRubric.ts`）、M3 设计质量（#3443）、carryThrough 的气质一档（#3442）
 * 都是「模型对一份冻结条目清单逐条打三档」。解析纪律与聚合口径只能有一份 ——
 * 三处各写一遍，「N/A 不进分母」这类规则的分歧不会有任何测试看见。
 *
 * ## 两条纪律
 *
 * - **解析失败即抛，不补默认值。** 回复里缺一条、多一条、分数越界，都说明这一次判不出来；
 *   条目按**序号**对应、措辞只作校验（#3466：逐字回声匹配在首批读数上丢了 3/9 条规则与 7/56 件）；
 *   静默补 0 或补 N/A 都是拿解析故障冒充读数（与 `parseJsonReply` 同源）。调用方把
 *   {@link RubricReplyError} 与 `VlmUnreadableError` 同等处理：这一次 `not-applicable`，不重试
 *   （`runEvaluatorCall` 只对 JSON 语法错重试一次；语义错误从第一次拿到解析结果起就收敛，
 *   与 `identity.ts` 的 `toPairVerdict` 同一条纪律）。
 * - **N/A 不进分母。** 全 N/A 的聚合是 `null` 而不是 0：「这份产物上无从判定」与「判了且很差」
 *   在读数里必须长得不一样（#2415「缺席 ≠ 0」）。
 *
 * @module benchmarks/design-anything/tools/evaluator/rubric
 */

export type RubricScore = 0 | 1 | 2 | 'n/a'

export interface RubricItemVerdict {
  /** 条目原文 —— 与清单里的措辞逐字相同 */
  item: string
  score: RubricScore
  reason: string
}

/** 指南 §2.4 第 3 步：0/1/2 映射 0/60/100（Qwen-Image-Bench 的映射，逐条映射后取均值）。 */
export const RUBRIC_SCALE_MAP: Readonly<Record<0 | 1 | 2, number>> = { 0: 0, 1: 60, 2: 100 }

/** 回复形状不合契约。语义错误，不是传输错误 —— 不重试。 */
export class RubricReplyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RubricReplyError'
  }
}

/** 分数归一化：数字或数字字符串 → 0/1/2，大小写 / 斜杠不同的 N/A → 'n/a'，其余 null。κ 的人工标签侧也走它。 */
export function normalizeScore(raw: unknown): RubricScore | null {
  if (raw === 0 || raw === 1 || raw === 2) return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '0' || trimmed === '1' || trimmed === '2') return Number(trimmed) as 0 | 1 | 2
    if (/^n\/?a$/i.test(trimmed)) return 'n/a'
  }
  return null
}

/** 措辞的宽松形态：去掉抄进来的编号前缀、大小写、标点与多余空白。只用于反查条目，不改判定里记录的原文。 */
function looseWording(text: string): string {
  return text.replace(/^\s*\d+\s*[.)]\s*/, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * 回复里的一条 → 声明清单里的哪一条（#3466）。
 *
 * 提示词把条目编成 1..N，回复带 `n`：**序号是确定性的，改写措辞不可能穷举**，所以序号优先；
 * 回声的原文只做校验 —— 它若唯一对上了**另一条**声明条目，说明模型答串了行，拒绝而不是猜。
 * 没有 `n`（或越界）时退回措辞：先逐字，再宽松形态（模型常把 "1. " 一起抄进来），仍要求唯一。
 */
function resolveItem(items: readonly string[], n: unknown, item: unknown): string {
  const loose = items.map(looseWording)
  const byLoose = (text: string): string | null => {
    const hits = items.filter((_, index) => loose[index] === looseWording(text))
    return hits.length === 1 ? hits[0] : null
  }
  const echoed = typeof item === 'string' ? (items.includes(item) ? item : byLoose(item)) : null
  if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= items.length) {
    const numbered = items[n - 1]
    if (echoed !== null && echoed !== numbered) {
      throw new RubricReplyError(`reply entry n=${n} names a different item (${JSON.stringify(item)}) — the row is ambiguous`)
    }
    return numbered
  }
  if (echoed !== null) return echoed
  throw new RubricReplyError(`reply scored an undeclared item: ${JSON.stringify(item)}${n === undefined ? '' : ` (n=${JSON.stringify(n)})`}`)
}

/**
 * 回复 → 逐条判定，**按声明顺序**返回，`item` 记声明原文（不是回声）。
 *
 * 契约：声明的每个条目在回复里**恰好出现一次**（按序号或措辞对上，见 {@link resolveItem}），不多不少；
 * `score` 在 `0 | 1 | 2 | "n/a"` 内（数字字符串与大小写不同的 N/A 归一化，其余一律拒绝）。
 */
export function parseRubricReply(items: readonly string[], reply: unknown): RubricItemVerdict[] {
  if (typeof reply !== 'object' || reply === null || !Array.isArray((reply as { items?: unknown }).items)) {
    throw new RubricReplyError('reply has no "items" array')
  }
  const replied = (reply as { items: unknown[] }).items
  const byItem = new Map<string, { score: RubricScore; reason: string }>()
  for (const entry of replied) {
    if (typeof entry !== 'object' || entry === null) throw new RubricReplyError('an entry in "items" is not an object')
    const { n, item, score, reason } = entry as { n?: unknown; item?: unknown; score?: unknown; reason?: unknown }
    if (typeof item !== 'string' && n === undefined) throw new RubricReplyError('an entry in "items" has neither "n" nor a string "item"')
    const resolved = resolveItem(items, n, item)
    if (byItem.has(resolved)) throw new RubricReplyError(`reply scored item twice: ${JSON.stringify(resolved)}`)
    const normalized = normalizeScore(score)
    if (normalized === null) throw new RubricReplyError(`item ${JSON.stringify(resolved)} has an out-of-scale score: ${JSON.stringify(score)}`)
    byItem.set(resolved, { score: normalized, reason: typeof reason === 'string' ? reason : '' })
  }
  const missing = items.filter((item) => !byItem.has(item))
  if (missing.length > 0) throw new RubricReplyError(`reply did not score: ${missing.map((item) => JSON.stringify(item)).join(', ')}`)
  return items.map((item) => ({ item, ...byItem.get(item)! }))
}

export interface RubricAggregate {
  /** 打了分（非 N/A）的条目数 —— 分母 */
  applicable: number
  /** 0–2 均值；全 N/A → null */
  mean0to2: number | null
  /** 逐条 0/60/100 后的均值；全 N/A → null */
  mapped0to100: number | null
}

/** 聚合。N/A 不进分母；全 N/A 是 `null`，不是 0。 */
export function aggregateRubric(verdicts: readonly RubricItemVerdict[]): RubricAggregate {
  const scored = verdicts.filter((verdict): verdict is RubricItemVerdict & { score: 0 | 1 | 2 } => verdict.score !== 'n/a')
  if (scored.length === 0) return { applicable: 0, mean0to2: null, mapped0to100: null }
  return {
    applicable: scored.length,
    mean0to2: scored.reduce((sum, verdict) => sum + verdict.score, 0) / scored.length,
    mapped0to100: scored.reduce((sum, verdict) => sum + RUBRIC_SCALE_MAP[verdict.score], 0) / scored.length,
  }
}
