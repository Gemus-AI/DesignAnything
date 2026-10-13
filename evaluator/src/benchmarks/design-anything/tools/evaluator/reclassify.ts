/**
 * 归槽的**成因分离**与回退重判（#3488）。
 *
 * ## 病灶
 *
 * 第一段分类（`evaluate.ts` 的逐件循环）过去把四种完全不同的情况写成同一个值：
 * 量尺主动说「这一件不属于任何槽」、量尺回了一个不存在的槽名、量尺判入的槽有页数下限
 * 而这一件页数不可知、以及分类调用彻底失败。它们在 `evaluation.json` 里都长成
 * `slot: 'unassigned'`，于是完成度把四种都读成「系统没交这一件」。
 *
 * 第三种（页数下限）自 #3803 起**根本不再发生**：页数是一条读数，不是归属的门，
 * 本模块因此一行页数逻辑都没有。判定点搬去了 `scoring.ts` 的 `scorePageFloors`。
 *
 * 2026-09-06 三臂批次实测：654 件里 126 件未归槽，OD 30.2% / JH 14.9% / GM 11.8% ——
 * **偏差有方向**，谁的交付形态离量尺的假设越远（网页 deck、无页数的 markdown）谁扣得越狠。
 * 最刺眼的一处：OD infovis 的七件分区图表被判进 `deck`、因没有页数被挤出，
 * 而同题 `sector-chart` 槽 0/4 —— 读起来像「三家都没做图表」，实际是量尺把它们丢了。
 *
 * ## 两条修正
 *
 * 1. **`unassigned` 是量尺的正式回答，不是降级出口。** 分类 prompt 明写它是合法选项
 *    （`prompts.ts`：没有这个出口时模型会硬塞进某个槽，覆盖率虚高）。同一批里 75/76 个
 *    「回了不存在的槽名」其实就是模型如实答了 `unassigned` —— 那是读数，不是故障。
 * 2. **被规则挡下时换个问法重问一次。** 槽名不认识 → 附一句指出哪个名字不在清单里，
 *    再问一次。仍不成立才落 `unassigned`，且带上成因。（#3488 落地时这里还有第二种重问：
 *    页数不达标就把该槽从清单里去掉再问。#3803 把页数下限整条从归槽里拿掉之后，
 *    那种重问没有了对象 —— 一件冲着某个槽来的文档现在直接归进去。）
 *
 * 重问必须**换掉 prompt 文本**才有意义：缓存键是「文件字节 + prompt + 模型」，原样再问
 * 一遍只会命中同一条缓存、拿回同一个答案。所以两种重问各自改的都是 prompt 本身。
 *
 * 本模块是纯逻辑：不做 I/O、不认识 prompt 模板，重问的实际调用由调用方注入
 * （与 `redistribute.ts` 的 `askSet` 同一模式）。
 *
 * @module benchmarks/design-anything/tools/evaluator/reclassify
 */

import type { ScoredArtifact, UnassignedCause } from './scoring'
import type { SlotSpec } from './taskSpec'

/** 量尺对「这一件属于哪个槽」的一次回复。`slot` 可以是槽 id，也可以是 `unassigned`。 */
export interface ClassifyReply {
  slot: string
  confidence: 'high' | 'low'
  reason: string
}

/** 量尺主动选择的「不属于任何槽」。它在 prompt 里是合法答案，不是错误。 */
export const MODEL_UNASSIGNED = 'unassigned'

/** 归槽的最终裁定。`slot === MODEL_UNASSIGNED` 且 `unassignedCause` 缺席 = 量尺的正式回答。 */
export interface SlotAssignment {
  slot: string
  confidence: 'high' | 'low'
  /** 写进 `ScoredArtifact.classifierReason` 的整句 */
  reason: string
  unassignedCause?: UnassignedCause
  reclassification?: { from: string; cause: UnassignedCause; resolved: string; reason: string }
  /**
   * 把这一件挡下来的那个槽（量尺回的那个不存在的名字）。
   * 只在 `unassignedCause` 是这一类时出现，供**延后的**回退重判知道该排除谁。
   */
  blockedSlot?: string
}

/**
 * 重问一次。`slots` 是这一次允许选的槽（页数重问时已剔掉出问题的那个）；
 * `note` 是附加给量尺的一句纠正（槽名不认识时用），`null` = 不附加。
 *
 * 抛错的处理权在调用方：调用方在外层已经把「分类彻底失败」映射成 `first === null`，
 * 这里只要求**重问失败时回 `null`**，本模块据此落回第一段的成因。
 */
export type ReaskFn = (slots: readonly SlotSpec[], note: string | null) => Promise<ClassifyReply | null>


/**
 * 把第一段回复裁定成最终归槽，必要时回退重问一次。
 *
 * `first === null` = 分类调用失败或没有可用证据；`noSlotDeclaredReason` 不为空时表示
 * 这条通道**结构上就没有可判的槽**（spec 没声明文档槽），那不是失败、不记成因。
 */
export async function assignSlot(input: {
  /** 这条通道的可判槽清单 */
  slots: readonly SlotSpec[]
  first: ClassifyReply | null
  /** 非空 = 这条通道没有可判槽，`first` 恒为 null 且不算失败 */
  noSlotDeclaredReason?: string
  /** 分类调用失败时写进 reason 的整句 */
  classifyFailedReason: string
  reask: ReaskFn
}): Promise<SlotAssignment> {
  const { slots, first } = input

  if (first === null) {
    if (input.noSlotDeclaredReason !== undefined) {
      return { slot: MODEL_UNASSIGNED, confidence: 'high', reason: input.noSlotDeclaredReason }
    }
    return {
      slot: MODEL_UNASSIGNED,
      confidence: 'high',
      reason: input.classifyFailedReason,
      unassignedCause: 'classify-failed',
    }
  }

  const confidence: 'high' | 'low' = first.confidence === 'low' ? 'low' : 'high'

  // ① 量尺主动答「不属于任何槽」—— 正式回答，原样收下，不记成因
  if (first.slot === MODEL_UNASSIGNED) {
    return { slot: MODEL_UNASSIGNED, confidence, reason: first.reason }
  }

  // ② 槽名不在清单里 —— 附一句指出哪个名字不成立，重问一次
  if (!slots.some((slot) => slot.id === first.slot)) {
    const note = `Your previous answer "${first.slot}" is not one of the slot ids listed above. `
      + 'Answer again using only the ids listed, or "unassigned" if none of them applies.'
    const retry = await input.reask(slots, note)
    const settled = settleRetry({ slots, retry, from: first.slot, cause: 'classifier-unknown-slot' })
    return settled ?? {
      slot: MODEL_UNASSIGNED,
      confidence,
      reason: `classifier returned unknown slot "${first.slot}" and re-asking did not resolve it — recorded as unassigned. ${first.reason}`,
      unassignedCause: 'classifier-unknown-slot',
      blockedSlot: first.slot,
    }
  }

  // ③ 槽名成立 —— 归进去。**页数不看**（#3803）：一件冲着 `brand-strategy` 来的 markdown
  //    就是那个槽的交付物，这件事不因为它数不出页数而改变。页数够不够是它的缺陷，
  //    在 `scoring.ts` 的 `scorePageFloors` 上单独判、单独报。
  return { slot: first.slot, confidence, reason: first.reason }
}

/**
 * 裁定一次重问的回复。**只接受落到某个合法槽的答案** —— 重问后答 `unassigned` 不算解决：
 * 那一件仍然没有归属，成因还是把它逼到这一步的那条规则。
 * 返回 `null` = 没解决，由调用方落 `unassigned` 并记成因。
 */
function settleRetry(input: {
  slots: readonly SlotSpec[]
  retry: ClassifyReply | null
  from: string
  cause: UnassignedCause
}): SlotAssignment | null {
  const { retry, slots } = input
  if (retry === null || retry.slot === MODEL_UNASSIGNED) return null
  if (!slots.some((slot) => slot.id === retry.slot)) return null
  return {
    slot: retry.slot,
    confidence: retry.confidence === 'low' ? 'low' : 'high',
    reason: retry.reason,
    reclassification: { from: input.from, cause: input.cause, resolved: retry.slot, reason: retry.reason },
  }
}

/** 延后重判的一项：第一段已经把它挡下来了，等全部件判完才知道哪些槽还缺件。 */
export interface DeferredReask {
  /** `artifacts[]` 里的下标，回填时按它定位 */
  index: number
  /** 这一件所在的归属通道的全部可判槽 */
  slots: readonly SlotSpec[]
  cause: UnassignedCause
  blockedSlot: string
  /** 已经落在这一件上的裁定，重问不成立时原样保留 */
  fallback: SlotAssignment
  /**
   * **由登记它的那条通道自己提供**的重问函数。不在这里按 Content-Type 现分派：
   * 结构判据面（#3163）判的是「这件产物是被怎么派出去的」，一行像素也不读 ——
   * 按载体分派会让它在重问那一步偷偷换成看图，等于中途换了证据面。
   */
  ask: ReaskFn
}

/**
 * 延后的回退重判（#3488）。
 *
 * ## 为什么必须延后到全部件判完
 *
 * 重问要回答的是「除了那个槽，它还能去哪」。第一版把这个问题原地问了，结果是**把丢件换成了硬塞**：
 * 2026-09-06 批次实测，OD infovis 的六件分区图表与 JH infovis 的七件 deck 页全被答进了 `summary`
 * ——那个槽 `expected: 1` 且早就有件了，于是代表件被顶成一张分区图表，逐字约束与身份锚跟着指错人。
 * 模型不是在撒谎，是被问了一个没有正确答案的问题：约束去掉源槽之后，剩下的选项里没有一个对。
 *
 * ## 判据
 *
 * **重问只能填还缺件的槽。** 一个已经装满 `expected` 件的槽没有丢过任何东西，重问就没有理由动它。
 * 这与第二段再分配的既有纪律同源（`redistribute.ts`：留在源槽超过 `expected` 的部分必须声明
 * `alternateOf`），两段因此不会互相打架。填不进去就老实落 `unassigned` 并带成因 ——
 * 那正是本 issue 想要的读数：**「这一件没测到」看得见，而不是被塞进一个错槽里假装交付了**。
 *
 * 逐项顺序处理并即时扣减缺口，两件延后件不会同时填进同一个只缺一件的槽。
 */
export async function resolveDeferredReasks(input: {
  artifacts: ScoredArtifact[]
  deferred: readonly DeferredReask[]
  /** 各槽的期望件数（`slots[].expected`），按 slot id 取 */
  expectedBySlot: ReadonlyMap<string, number>
}): Promise<void> {
  if (input.deferred.length === 0) return
  const matched = new Map<string, number>()
  for (const artifact of input.artifacts) {
    matched.set(artifact.slot, (matched.get(artifact.slot) ?? 0) + 1)
  }

  for (const item of input.deferred) {
    const candidates = item.slots.filter((slot) => slot.id !== item.blockedSlot
      && (matched.get(slot.id) ?? 0) < (input.expectedBySlot.get(slot.id) ?? slot.expected))
    if (candidates.length === 0) continue
    const note = item.cause === 'classifier-unknown-slot'
      ? `Your previous answer "${item.blockedSlot}" is not one of the slot ids listed above. `
        + 'Answer again using only the ids listed, or "unassigned" if none of them applies.'
      : null
    const retry = await item.ask(candidates, note)
    const settled = settleRetry({ slots: candidates, retry, from: item.blockedSlot, cause: item.cause })
    if (settled === null) continue
    const artifact = input.artifacts[item.index]
    matched.set(artifact.slot, (matched.get(artifact.slot) ?? 1) - 1)
    matched.set(settled.slot, (matched.get(settled.slot) ?? 0) + 1)
    input.artifacts[item.index] = {
      ...artifact,
      slot: settled.slot,
      classifierConfidence: settled.confidence,
      classifierReason: settled.reason,
      reclassification: settled.reclassification,
      unassignedCause: undefined,
    }
  }
}
