/**
 * Spearman 秩相关（#3443）—— 设计质量评审模型与设计师打分的一致性。
 *
 * 指南 §2.4 第 6 步：设计师核对达标（r ≥ 0.6，κ ≥ 0.667）的组才进主表。κ 已有（`kappa.ts`），
 * 这里补秩相关：0/1/2 是有序档，「差一档」与「差两档」在 κ 里同等惩罚，秩相关能看出方向一致性。
 *
 * 并列取平均秩（Spearman 的标准处理），所以不能用 `1 - 6Σd²/(n(n²-1))` 的无并列公式 ——
 * 三档打分几乎全是并列。实现 = 对平均秩算 Pearson。
 *
 * @module benchmarks/design-anything/tools/evaluator/correlation
 */

export interface CorrelationResult {
  n: number
  /** 某一侧全同一个值（方差为 0）或 n < 2 时无定义，为 null */
  rho: number | null
}

/** 平均秩：并列的值取它们名次的均值。 */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const ranks = new Array<number>(values.length)
  let start = 0
  while (start < order.length) {
    let end = start
    while (end + 1 < order.length && order[end + 1].value === order[start].value) end += 1
    const rank = (start + end) / 2 + 1
    for (let i = start; i <= end; i += 1) ranks[order[i].index] = rank
    start = end + 1
  }
  return ranks
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length
  if (n < 2) return null
  const meanX = xs.reduce((sum, x) => sum + x, 0) / n
  const meanY = ys.reduce((sum, y) => sum + y, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}

/** Spearman ρ（并列取平均秩）。两个向量按位置配对，长度必须相同。 */
export function spearman(xs: readonly number[], ys: readonly number[]): CorrelationResult {
  if (xs.length !== ys.length) throw new Error(`spearman: vectors differ in length (${xs.length} vs ${ys.length})`)
  return { n: xs.length, rho: pearson(averageRanks(xs), averageRanks(ys)) }
}
