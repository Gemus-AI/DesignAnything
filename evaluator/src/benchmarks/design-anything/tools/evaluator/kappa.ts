/**
 * Cohen's κ（#3109）—— 槽位分类器与人工参考标签的一致性。
 *
 * 存在的理由：`prompts.ts` 里说过，0.944 那个数是用**同类但非逐字相同**的 prompt 跑出来的，
 * 而那 27 张图的人工标签没有落库。在用现在这套 prompt + 模型重测之前，那个数不能被引用。
 * 重测是一次人工标注工作（人先逐张定标签），这里只提供算法与入口。
 *
 * κ 而不是一致率：一致率在类别分布倾斜时会虚高（全判 logo 也能拿到不低的一致率），
 * κ 扣掉了随机一致的部分。§7.6 的门槛是一致率 ≥85% **或** κ ≥0.60。
 *
 * @module benchmarks/design-anything/tools/evaluator/kappa
 */

/**
 * 达标线（协议 §6，`gemus-eval-v0.1.md` §7.6）—— **跑批之前写死，看到数字之后不得修改**。
 *
 * 两个数都要过，不是二选一：κ 在类别分布倾斜时会偏低，一致率在同样情况下会虚高，
 * 只报占优的那个会误导。设计质量那把另有自己的线（ρ ≥ 0.6 且 κ ≥ 0.667，按组分判），
 * 不走这里。
 *
 * 常量放在 kappa.ts 而不是各工具里：五把尺子共用同一条线，两处写同一个数就会漂。
 */
export const CALIBRATION_THRESHOLD = { kappa: 0.6, agreementRate: 0.85 } as const

/** κ 为 null（两侧都只用了一个类别，期望一致率 = 1）时**不算达标** —— 无定义不是通过。 */
export function meetsCalibrationThreshold(result: Pick<KappaResult, 'kappa' | 'agreementRate'>): boolean {
  return result.kappa !== null
    && result.kappa >= CALIBRATION_THRESHOLD.kappa
    && result.agreementRate >= CALIBRATION_THRESHOLD.agreementRate
}

export interface LabelPair {
  file: string
  human: string
  classifier: string
}

export interface KappaResult {
  n: number
  agreements: number
  agreementRate: number
  /** 两个标注者都只用一个类别时 κ 无定义（期望一致率 = 1），此时为 null */
  kappa: number | null
  disagreements: LabelPair[]
}

export function cohensKappa(pairs: readonly LabelPair[]): KappaResult {
  const n = pairs.length
  if (n === 0) return { n: 0, agreements: 0, agreementRate: 0, kappa: null, disagreements: [] }

  const disagreements = pairs.filter((pair) => pair.human !== pair.classifier)
  const agreements = n - disagreements.length
  const observed = agreements / n

  const humanCounts = new Map<string, number>()
  const classifierCounts = new Map<string, number>()
  for (const pair of pairs) {
    humanCounts.set(pair.human, (humanCounts.get(pair.human) ?? 0) + 1)
    classifierCounts.set(pair.classifier, (classifierCounts.get(pair.classifier) ?? 0) + 1)
  }
  let expected = 0
  for (const [label, count] of humanCounts) {
    expected += (count / n) * ((classifierCounts.get(label) ?? 0) / n)
  }

  return {
    n,
    agreements,
    agreementRate: observed,
    kappa: expected === 1 ? null : (observed - expected) / (1 - expected),
    disagreements,
  }
}

/**
 * 人工标签文件 → LabelPair 的 human 侧。格式刻意用最笨的 CSV（`<键>,<标签>` 每行一条）：
 * 标注是人干的活，格式越笨越不容易在标注环节出错。
 *
 * **按最后一个逗号切，不是第一个**（#3699）。标签一侧是受控取值（槽 id、`same`、`0/1/2/n/a`），
 * 里面永远没有逗号；键一侧不是 —— 协议 §5 给整套一致性定的键是 `<runKey>|<ruleId>|<条目原文>`，
 * 而条目原文是一整句英文，逗号很常见。按第一个逗号切会把键截断在句子中间，之后每一条都对不上，
 * 表现为「标了 117 条但一条都没匹配上」。整套一致性的标签是这条规则的第一批使用者，
 * 在此之前没有任何标签文件的键里带过逗号，所以这个缺陷一直没被触发。
 */
export function parseLabelCsv(text: string): Map<string, string> {
  const labels = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const comma = trimmed.lastIndexOf(',')
    if (comma === -1) throw new Error(`Label line is not "<key>,<label>": ${trimmed}`)
    labels.set(trimmed.slice(0, comma).trim(), trimmed.slice(comma + 1).trim())
  }
  return labels
}
