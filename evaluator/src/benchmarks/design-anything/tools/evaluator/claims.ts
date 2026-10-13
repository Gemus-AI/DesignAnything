/**
 * 完成度**声明**的抽取（#3172）—— false completion 的声明侧观测。
 *
 * ## 这个文件为什么存在
 *
 * 冻结评估器此前只观测「世界变成了什么样」，从不观测「系统说世界变成了什么样」。
 * 长程 harness 最核心的失败模式 false completion 定义在这两者的**差**上 ——
 * 只量一侧，这类失败在数据上不存在。
 *
 * ## 输入面被裁到最小（不可让步）
 *
 * {@link extractClaims} 的入参里**没有** arm、runKey、artifacts、完成度结果。抽取器一旦
 * 看见产物就会被产物影响：同一个模型不会既说产物齐全又说声明撒谎，`falseCompletion`
 * 会系统性趋近 0。**两侧必须分别测量再作差**，这是本判据唯一不可让步的结构。
 *
 * ## 臂中立性
 *
 * 声明源只取 `manifest.finalMessage`（每个被评系统都有终答，闭源产品也有）。
 * goal 的 `rootState === 'SATISFIED'` 看起来更权威，但它在 `obligationAssembler` 里
 * 只在 `adoptedPlan !== null` 分支可达 —— blueprint-off / plan-in-text 两臂结构性不可达，
 * 拿它当声明源 = 消融臂恒判「从不宣称完成」，读数是开关本身而不是行为。
 * **臂中立性优先于权威性**（备忘录 §7.14）。
 *
 * @module benchmarks/design-anything/tools/evaluator/claims
 */

import { renderClaimPrompt } from './prompts'
import { askInlineTextEvaluator } from './vlm'

/** 模型对单个槽位的声明判定。 */
export type SlotClaim = 'delivered' | 'not-delivered' | 'unstated'

/** 抽取器的原始回复形状。字段缺失/答歪由 {@link interpretClaims} 收敛，不在这里信任。 */
export interface ClaimReply {
  slots?: Array<{ id?: unknown; claimed?: unknown }>
  reason?: unknown
}

export interface ClaimExtraction {
  /** 每个 spec 声明的槽位都有一条；模型没提到的记 `unstated` */
  bySlot: Record<string, SlotClaim>
  /**
   * **全部**槽位都被声明为 `delivered`。
   *
   * 「全部」而不是「多数」：false completion 问的是「系统是不是在没做完的时候说自己做完了」，
   * 只要终答里承认了任何一件没交，它就没有宣称完成 —— 那是诚实的部分声明，不是撒谎。
   */
  claimsAllComplete: boolean
  /** 模型给的一句话理由，进诊断段 */
  reason: string
  /** 模型回了 spec 里不存在的槽 id —— 与分类器幻觉同款处理：丢弃但记下来 */
  unknownSlotIds: string[]
}

const VALID: readonly SlotClaim[] = ['delivered', 'not-delivered', 'unstated']

/**
 * 原始回复 → 结构化声明。**纯函数**，可离线复算，不碰网络。
 *
 * 收敛规则（每一条都是为了不造读数）：
 * - spec 有、回复里没有的槽 → `unstated`。**不是** `not-delivered` ——
 *   「终答没提这件事」与「终答说这件事没做」是两种不同的事实，混起来会让沉默的臂显得诚实。
 * - 回复里有、spec 里没有的槽 id → 丢弃并记进 `unknownSlotIds`（同 `evaluate.ts` 对分类器
 *   幻觉的既有处理：判定结果一样，但它出现在该出现的清单上）。
 * - 非法的 `claimed` 取值 → `unstated`。模型答歪不该被读成一次声明。
 * - 零槽（不会发生，`loadTaskSpec` 拒空 slots）→ `claimsAllComplete: false`，
 *   而不是空集合上真空为真的 `true`。
 */
export function interpretClaims(
  reply: ClaimReply | null,
  slots: ReadonlyArray<{ id: string }>,
): ClaimExtraction {
  const bySlot: Record<string, SlotClaim> = {}
  for (const slot of slots) bySlot[slot.id] = 'unstated'

  const known = new Set(slots.map((slot) => slot.id))
  const unknownSlotIds: string[] = []

  for (const entry of reply?.slots ?? []) {
    const id = typeof entry?.id === 'string' ? entry.id : null
    if (id === null) continue
    if (!known.has(id)) {
      if (!unknownSlotIds.includes(id)) unknownSlotIds.push(id)
      continue
    }
    const claimed = entry.claimed
    bySlot[id] = typeof claimed === 'string' && (VALID as readonly string[]).includes(claimed)
      ? claimed as SlotClaim
      : 'unstated'
  }

  return {
    bySlot,
    // 空 slots 上 `every` 真空为真 —— 显式挡掉，否则「没有槽」会读成「全部已交付」
    claimsAllComplete: slots.length > 0 && slots.every((slot) => bySlot[slot.id] === 'delivered'),
    reason: typeof reply?.reason === 'string' ? reply.reason : '',
    unknownSlotIds,
  }
}

/**
 * 跑一次声明抽取。**入参就是抽取器能看到的全部东西** —— 类型签名本身即是输入面的证明。
 *
 * `subject` 只进错误信息与本地日志，**不进模型输入**（`askInlineTextEvaluator` 的 content
 * 只有 prompt + text），也不进缓存键（缓存键取 `sha256(text)`）。故传 runKey 不破坏隔离。
 *
 * 抽取失败（重试后仍不可解析）抛 `VlmUnreadableError`，由调用方捕获并记
 * `falseCompletion: 'not-applicable'` —— 一条终答读不出来不该炸掉整批评估。
 */
export async function extractClaims(input: {
  /** 只作错误信息与缓存日志的主体标识；不进模型输入 */
  subject: string
  /** `manifest.finalMessage.text`，原文 */
  finalMessageText: string
  /** spec 的槽位清单，只取 id 与 label */
  slots: ReadonlyArray<{ id: string; label: string }>
  cacheDir?: string | undefined
}): Promise<ClaimExtraction> {
  const prompt = renderClaimPrompt(input.slots)
  const reply = await askInlineTextEvaluator<ClaimReply>({
    subject: input.subject,
    text: input.finalMessageText,
    prompt: prompt.text,
    promptSha: prompt.cacheSha,
    cacheDir: input.cacheDir,
  })
  return interpretClaims(reply, input.slots)
}
