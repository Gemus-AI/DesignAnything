/**
 * 第二段分类：超配槽**集合内再分配**（#3407）。
 *
 * ## 为什么要有第二段
 *
 * 第一段（`evaluate.ts` 的分类循环）对每件产物**单独**调一次分类器，模型看不到同题的其它件，
 * 也看不到规格里的期望件数。「同类画面、不同角色」的槽位对因此塌缩：三张体量方案与一张主视觉
 * 单看都是「滨水图书馆外观透视」，五张一起到就全进 hero-visual（bench-da-batch1-0905c：
 * 20 题里 18 题的缺件槽 100% 与同题某个超配槽共现，101 件产物因此没计入任何槽）。
 *
 * 这两份能把它们分开的信息评估器一直有：**同题其它件**（相对比较）和**规格的期望件数**
 * （目标形状）。第二段把它们用起来 —— 把超配槽的全部件放进同一个请求，附全部其它图像槽的
 * 描述与期望件数，让模型做集合内的相对判断。用的只有图像与规格，三条臂对称，agent 造不了假
 * （不喂节点 label / zone 名 / 生成顺序：agent 自陈可污染，外部臂没有这些字段）。
 *
 * ## 触发与迭代
 *
 * 题级触发：∃ 图像槽 `matched > expected` **且** ∃ 图像槽 `matched < expected`。单看超配不触发 ——
 * `expected=1` 的槽装「候选 + 定稿」是 #3113 与 `alternativesAllowed` 明写的正常形态。
 *
 * 错位可以是链：book-01 的三张章首页在 cover（该去 chapter-art），而 chapter-art 正好 6=6
 * 不超配，里面却藏着一张该去 spread 的样张。所以目标是**全部**其它图像槽（不只缺件槽），
 * 且要迭代：第 1 轮 cover→chapter-art 之后 chapter-art 才变超配、才能在第 2 轮把样张交出去。
 * 上限 {@link MAX_REDISTRIBUTION_ROUNDS} 轮。**已问过的问题不再问**：某槽的候选集自上次
 * 回复以来没变，它的多余件已被 `alternateOf` 合法解释，不再当源。
 *
 * ## 收敛判据加一条：缺件槽还在时，对同一组件再追问一次（#3529）
 *
 * 「候选集没变就不再问」单独用会**提前收敛**。实测 `bench-da-product-01--r1`：`scene` 槽 3 件
 * 装在期望 2 件的槽里，模型判定第 3 件是另一件的候选稿（合法的 `alternateOf`），于是这一组
 * 被记为已解释、不再当源 —— 而 `directions` 仍然差一件，上限 3 轮里只跑了 1 轮。
 *
 * 所以判据改成「候选集没变 **且** 已经追问过一次」。追问的提示里**点名还空着的槽**（槽 id
 * 与期望件数都来自规格，三条臂对称，不是 agent 自陈）。每组件只追问一次：追问后仍不动
 * 就是真的不该动，再问只会拿到同一个答案。
 *
 * 因此**不再有「一轮无移动即停」**：那条 break 会让追问永远轮不到（product-01 那一格正是
 * 第 1 轮零移动）。终止由「计划为空」与轮数上限共同保证 —— 一组件被问过且追问过之后就不再
 * 入选，签名变了（有件搬进来）才重新成为问题。
 *
 * ## 回复的有效性（无效即重问一次再回退并记账，绝不让一次坏回复把读数弄错）
 *
 * - 每件恰好出现一次，编号 1..N 无越界、无重复、无缺失
 * - 槽只能是源槽、任一目标槽、或 `unassigned`（没有这个出口时模型会硬塞，见 `prompts.ts`）
 * - 留在源槽的件数 ≥ `min(expected, N)`：第二段的职责是把「装多了」的部分分出去，不是把源槽搬空
 * - 留在源槽超过 `expected` 的部分，每一件都要 `alternateOf` 另一件留下的件（它是某件的候选稿）
 *
 * 这套规则让第二段的错误只可能是「没搬」，不可能是「搬出新的缺件」。**#3529 不放宽它们**：
 * 放宽换来的移动率，代价是可能搬出新的缺件，方向不可控。
 *
 * 无效回复**按项重问一次**再回退（#3529）。实测 `bench-da-craft-01--r0` 两遍都因为同一个
 * 不存在的槽名 `source` 整项作废 —— 分类器回一个非法槽名是可检测、可重问的，而整项回退让
 * 那一格的 `set` 槽装了 6 件、`directions` / `hero` / `care-card` 三个槽全空。重问用同一份
 * 候选集与同一段模板，只在提示里回显上次错在哪。成因分档见 {@link RedistributionRejection}：
 * 此前「模型不认识槽名」与「编号格式坏了」都塌进同一句 `invalid reply`，看不出该修哪一头。
 *
 * ## 残留错配的出口：不强搬，而是承认判不了
 *
 * 上面三条降低错配率，但降不到零。**剩下的那些不能被当成真读数** —— `residualCoOccurrence`
 * 为真的运行，它的 M1 缺件读数在报表里标「不可判」，进诊断不进主表分母（判据在
 * `scoring.assessSlotAssignment`，与指南 §2.10 对 κ 不达标列的处理同源）。
 *
 * 刻意**不做**的是「直接判定错配、强行把超配槽的多余件塞进缺件槽」：那违反上面那条
 * 「不可能搬出新的缺件」的保证，等于把一种可检测的错误换成一种不可检测的错误。
 *
 * ## #3541 之后：它是**求解后的残留检查**，不再是归槽的主力
 *
 * 第一段已经换成一次带容量约束的整体指派（`assignment.ts`）：席位由规格的期望件数给定，
 * 谁占哪个席位一次求解定下来。**「同类画面全部涌向同一个槽」在结构上不再可能** ——
 * 那正是本模块过去要修的东西。
 *
 * 本模块因此保留但退居其后，做两件求解器做不到的事：
 *
 * 1. **集合层面的复核。** 求解器拿到的是逐件独立的分数，它看不见「这三张是互不相同的
 *    三个方向」这种集合属性。求解之后仍有「超配 ∧ 缺件」共现时，把那一组图放在一起再看
 *    一眼，仍是唯一能分开它们的办法。
 * 2. **候选稿的声明。** 席位满了之后挂上来的多余件（`assignment.ts` 的 `overflow`）
 *    要不要算作某件的候选稿，只有把它们放在一起才说得清；`scoreSlots` 的代表件选择读的
 *    正是这条 `alternateOf` 声明。
 *
 * 触发条件一个字没改，但**触发频次预期大幅下降**：超配现在只可能来自 `overflow` 挂靠
 * 与非图像通道的件，而不再来自分类塌缩。跑完仍共现的才标「不可判」（#3529 的出口不变）。
 *
 * 本模块是纯函数：不做 I/O，VLM 调用由调用方注入（`evaluate.ts` 用 `askSetVlm`）。
 * `scoring.ts` 一字不动 —— 分槽对了，M1 / 硬闸 / 约束的两条腿自然对。
 *
 * @module benchmarks/design-anything/tools/evaluator/redistribute
 */

import { imageSlots, type ScoredArtifact } from './scoring'
import type { SlotSpec, TaskSpec } from './taskSpec'
import { VlmUnreadableError } from './vlm'

export const MAX_REDISTRIBUTION_ROUNDS = 3

/**
 * 单次多图请求的候选件上限（决定 #4）。`openai/gpt-5.6-luna` 经 apimart 的多图上限没有文档可查，
 * 这里取保守常数：超过它的源槽**回退第一段并记账**，不分批 —— 分批会让集合内的相对判断跨批失效，
 * 而超限本身（一个槽装了十几件）就该进人工复核清单。实测拿到模型上限后再调。
 */
export const MAX_REDISTRIBUTION_CANDIDATES = 12

export interface RedistributeAssignment {
  /** 请求里的图编号，1..N */
  image: number
  slot: string
  alternateOf: number | null
  reason: string
}

export interface RedistributeReply {
  assignments: RedistributeAssignment[]
}

/** 一次第二段请求的输入：一个超配的源槽、它的全部图像候选件、以及本题其它全部图像槽。 */
export interface RedistributionPlanItem {
  source: SlotSpec
  /** 源槽里 `contentType` 为 image/* 的件，按 `artifacts[]` 原序（顺序是 #3113 契约，不得重排） */
  candidates: ScoredArtifact[]
  /** 本题其它全部图像槽 —— 含 exactly-full 的，错位的目的地未必是缺件槽 */
  targets: SlotSpec[]
  /** 各图像槽当前件数（含非图像件，与 `scoreSlots.matched` 同口径），进提示词 */
  counts: Record<string, number>
  /**
   * 本题当前**还空着**的图像槽 id（`matched < expected`），按规格序（#3529）。
   *
   * 只在 {@link RedistributionPlanItem.nudge} 为真时进提示词。第一问保持原样是刻意的：
   * 第一问的提示词一个字节都不变，既有缓存因此仍然命中，重评估不必为这条改动重烧一遍。
   */
  deficits: string[]
  /**
   * 这一问是不是**追问**（#3529）：同一组候选件已经问过一次、题级仍有缺件槽。
   *
   * 每组件只追问一次。追问的提示里点名 {@link RedistributionPlanItem.deficits}。
   */
  nudge: boolean
}

/**
 * 无效回复的成因分档（#3529）。
 *
 * 此前四种成因都塌进一句 `invalid reply`，于是读诊断的人看不出该修哪一头：
 * 模型不认识槽名（可以在提示里回显槽表重问）与编号格式坏了（是解析/输出形态问题），
 * 下一步动作不同。分档是为了让这两件事在 `failed[].kind` 上分得开。
 */
export type RedistributionRejectionKind =
  /** 回了一个本题不存在的槽名（`craft-01--r0` 的 `source` 就是这一档） */
  | 'unknown-slot'
  /** 编号越界 / 重复 / 条目数与候选件数不符 */
  | 'index'
  /** 连 `assignments` 数组都没有 —— 回复形态本身坏了 */
  | 'shape'
  /** 编号合法，但违反留守件数 / `alternateOf` 那几条契约 */
  | 'contract'

/** 一次无效回复：分档 + 原文级理由。理由进诊断，分档进统计。 */
export interface RedistributionRejection {
  kind: RedistributionRejectionKind
  message: string
}

export interface RedistributionMove {
  file: string
  from: string
  to: string
  reason: string
}

export interface RedistributionDiagnostics {
  rounds: number
  triggered: Array<{ round: number; slot: string; candidates: string[] }>
  moved: RedistributionMove[]
  failed: Array<{
    round: number
    slot: string
    files: string[]
    reason: string
    /**
     * 成因分档（#3529）。`undefined` = 这条不是回复内容被判无效
     * （候选件超上限、模型调用读不出来），那两种在 `reason` 里自述。
     */
    kind?: RedistributionRejectionKind
    /** 重问过一次仍然无效（#3529）。只重问一次，所以最多是 true */
    retried?: boolean
  }>
  /** 追问过的组（#3529）：候选集没变、题级仍有缺件，于是点名空槽再问一次 */
  nudged: Array<{ round: number; slot: string; deficits: string[]; moved: number }>
  /** 第二段跑完后仍有「超配 ∧ 缺件」共现 —— 残余疑似错分，进人工复核清单 */
  residualCoOccurrence: boolean
  /** 未运行的原因（结构判据模式不读像素） */
  skipped?: string
}

export interface RedistributionResult {
  artifacts: ScoredArtifact[]
  diagnostics: RedistributionDiagnostics
}

/** 各图像槽的当前件数（与 `scoreSlots.matched` 同口径：按 slot id 过滤，不分载体）。 */
function countBySlot(spec: TaskSpec, artifacts: readonly ScoredArtifact[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const slot of imageSlots(spec)) {
    counts[slot.id] = artifacts.filter((artifact) => artifact.slot === slot.id).length
  }
  return counts
}

/** 题级触发：某图像槽超配 且 某图像槽缺件。 */
export function hasCoOccurrence(spec: TaskSpec, artifacts: readonly ScoredArtifact[]): boolean {
  const counts = countBySlot(spec, artifacts)
  const slots = imageSlots(spec)
  return slots.some((slot) => counts[slot.id] > slot.expected)
    && slots.some((slot) => counts[slot.id] < slot.expected)
}

/** 候选集签名：源槽 id + 有序候选文件名。同签名 = 同一个问题。 */
function candidateSignature(slotId: string, candidates: readonly ScoredArtifact[]): string {
  return `${slotId}\n${candidates.map((artifact) => artifact.file).join('\n')}`
}

/**
 * 一个源槽「已问到什么程度」（#3529）。
 *
 * 此前只记签名，于是「问过」= 「不再问」。缺件槽还空着时那是提前收敛，所以要多记一位：
 * 同一个签名有没有被追问过。签名一变（有件搬进来）这一位随之作废。
 */
export interface SettledSource {
  signature: string
  /** 这个签名已经被点名空槽追问过一次 */
  nudged: boolean
}

/** 本题当前还空着的图像槽 id，按规格序。 */
function deficitSlots(spec: TaskSpec, counts: Record<string, number>): string[] {
  return imageSlots(spec).filter((slot) => counts[slot.id] < slot.expected).map((slot) => slot.id)
}

/**
 * 算出本轮要问的 (源槽, 候选件, 目标槽)。
 *
 * `settled` 是「已问到什么程度」：签名相同**且已追问过**的源槽不再入选；签名相同但还没
 * 追问过、且题级仍有缺件槽时，作为**追问**入选一次（`nudge: true`，#3529）。传空 Map 即第一轮。
 *
 * 注意本函数只在 {@link hasCoOccurrence} 为真时产出条目，所以「题级仍有缺件槽」在这里恒真；
 * 之所以仍然显式算 {@link RedistributionPlanItem.deficits}，是因为提示词要**点名**是哪几个槽，
 * 而不只是知道有槽空着。
 */
export function planRedistribution(
  spec: TaskSpec,
  artifacts: readonly ScoredArtifact[],
  settled: ReadonlyMap<string, SettledSource> = new Map(),
): RedistributionPlanItem[] {
  if (!hasCoOccurrence(spec, artifacts)) return []
  const counts = countBySlot(spec, artifacts)
  const slots = imageSlots(spec)
  const deficits = deficitSlots(spec, counts)
  const items: RedistributionPlanItem[] = []
  for (const source of slots) {
    if (counts[source.id] <= source.expected) continue
    // 只取图像载体：双载体槽（image + document）的 matched 里可能混有文本通道判入的件，
    // 不能喂给多图请求
    const candidates = artifacts.filter((artifact) => artifact.slot === source.id && artifact.contentType.startsWith('image/'))
    if (candidates.length < 2) continue
    const seen = settled.get(source.id)
    const asked = seen?.signature === candidateSignature(source.id, candidates)
    // 问过且追问过 → 这一组已经说到头了。问过但没追问过 → 缺件槽还空着，点名再问一次
    if (asked && seen.nudged) continue
    items.push({
      source,
      candidates,
      targets: slots.filter((slot) => slot.id !== source.id),
      counts,
      deficits,
      nudge: asked,
    })
  }
  return items
}

export interface ApplyResult {
  artifacts: ScoredArtifact[]
  moved: RedistributionMove[]
  /** 无效回复的分档与理由；`null` = 有效 */
  invalid: RedistributionRejection | null
}

/**
 * 校验并应用一条回复。**只改被点名件的 `slot`，不改顺序**；无效回复返回原数组与原因。
 */
export function applyRedistribution(
  artifacts: readonly ScoredArtifact[],
  item: RedistributionPlanItem,
  reply: RedistributeReply,
): ApplyResult {
  const n = item.candidates.length
  const unchanged: ApplyResult = { artifacts: [...artifacts], moved: [], invalid: null }
  // 分档与理由一起返回：理由进诊断给人读，分档进统计给「该修哪一头」定位（#3529）
  const invalid = (kind: RedistributionRejectionKind, message: string): ApplyResult =>
    ({ ...unchanged, invalid: { kind, message } })

  if (!Array.isArray(reply?.assignments)) return invalid('shape', 'reply has no assignments array')
  if (reply.assignments.length !== n) return invalid('index', `expected ${n} assignments, got ${reply.assignments.length}`)
  const seen = new Set<number>()
  const allowed = new Set([item.source.id, ...item.targets.map((slot) => slot.id), 'unassigned'])
  for (const assignment of reply.assignments) {
    if (!Number.isInteger(assignment.image) || assignment.image < 1 || assignment.image > n) {
      return invalid('index', `image index ${String(assignment.image)} out of range 1..${n}`)
    }
    if (seen.has(assignment.image)) return invalid('index', `image ${assignment.image} assigned twice`)
    seen.add(assignment.image)
    if (!allowed.has(assignment.slot)) return invalid('unknown-slot', `unknown slot "${String(assignment.slot)}"`)
    if (assignment.alternateOf !== null && (!Number.isInteger(assignment.alternateOf) || assignment.alternateOf < 1 || assignment.alternateOf > n)) {
      return invalid('index', `image ${assignment.image} declares alternateOf ${String(assignment.alternateOf)} out of range 1..${n}`)
    }
  }

  const staying = reply.assignments.filter((assignment) => assignment.slot === item.source.id)
  const mustStay = Math.min(item.source.expected, n)
  if (staying.length < mustStay) {
    return invalid('contract', `only ${staying.length} of ${n} stay in "${item.source.id}" — at least ${mustStay} must stay (stage 2 may not empty a slot)`)
  }
  const stayingNumbers = new Set(staying.map((assignment) => assignment.image))
  const primaries = staying.filter((assignment) => assignment.alternateOf === null)
  if (primaries.length > item.source.expected) {
    return invalid('contract', `${primaries.length} items stay in "${item.source.id}" without alternateOf but it expects ${item.source.expected} — surplus must be declared as alternates`)
  }
  for (const assignment of staying) {
    if (assignment.alternateOf === null) continue
    if (assignment.alternateOf === assignment.image || !stayingNumbers.has(assignment.alternateOf)) {
      return invalid('contract', `image ${assignment.image} declares alternateOf ${assignment.alternateOf}, which is not another item staying in "${item.source.id}"`)
    }
  }

  const byFile = new Map<string, RedistributeAssignment>()
  reply.assignments.forEach((assignment) => byFile.set(item.candidates[assignment.image - 1].file, assignment))
  const moved: RedistributionMove[] = []
  const next = artifacts.map((artifact) => {
    const assignment = byFile.get(artifact.file)
    if (assignment === undefined) return artifact
    const alternateOf = assignment.alternateOf === null ? undefined : item.candidates[assignment.alternateOf - 1].file
    if (assignment.slot === artifact.slot) {
      if (alternateOf === undefined) return artifact
      return { ...artifact, redistribution: { from: artifact.slot, to: artifact.slot, reason: assignment.reason, alternateOf } }
    }
    moved.push({ file: artifact.file, from: artifact.slot, to: assignment.slot, reason: assignment.reason })
    return {
      ...artifact,
      stage1Slot: artifact.stage1Slot ?? artifact.slot,
      slot: assignment.slot,
      redistribution: { from: artifact.slot, to: assignment.slot, reason: assignment.reason, ...(alternateOf === undefined ? {} : { alternateOf }) },
    }
  })
  return { artifacts: next, moved, invalid: null }
}

export function skippedRedistribution(artifacts: readonly ScoredArtifact[], reason: string): RedistributionResult {
  return {
    artifacts: [...artifacts],
    diagnostics: { rounds: 0, triggered: [], moved: [], failed: [], nudged: [], residualCoOccurrence: false, skipped: reason },
  }
}

/**
 * 编排：触发 → 逐源槽问 → 应用 → 再触发，直到计划为空或到上限。
 *
 * **终止性**：一组候选件被问过一次、追问过一次之后就不再入选（见 {@link planRedistribution}），
 * 所以计划一定会变空；轮数上限是第二道保险。#3529 之前还有一条「一轮无移动即停」，
 * 它会让追问永远轮不到（追问针对的正是「问过但没动」的那一组），已删。
 *
 * `askSet` 的第二参是**上一次无效回复的回显**（#3529）：非空即表示这是重问。
 * 抛 {@link VlmUnreadableError} 时该项回退第一段并记账；其它错误照常抛出
 * （网络/配置故障不该被伪装成「这一槽判不出来」）。
 */
export async function runRedistribution(
  spec: TaskSpec,
  initial: readonly ScoredArtifact[],
  askSet: (item: RedistributionPlanItem, correction?: RedistributionRejection) => Promise<RedistributeReply>,
  maxRounds: number = MAX_REDISTRIBUTION_ROUNDS,
): Promise<RedistributionResult> {
  let artifacts: ScoredArtifact[] = [...initial]
  const diagnostics: RedistributionDiagnostics = { rounds: 0, triggered: [], moved: [], failed: [], nudged: [], residualCoOccurrence: false }
  const settled = new Map<string, SettledSource>()

  for (let round = 1; round <= maxRounds; round += 1) {
    const items = planRedistribution(spec, artifacts, settled)
    if (items.length === 0) break
    diagnostics.rounds = round
    for (const item of items) {
      const files = item.candidates.map((artifact) => artifact.file)
      diagnostics.triggered.push({ round, slot: item.source.id, candidates: files })
      // 无论回复有效与否都记为已问；`nudged` 记这一组是不是已经说到头了。
      //
      // **追问只对「答了但没动」的组有意义**：模型看过这一组、给了合法答案、什么都没搬，
      // 才值得点名空槽再看一眼。调用失败、两遍都无效、候选超上限这三种，问题不在「模型
      // 没注意到还有空槽」，再问一遍是烧钱不是修 bug —— 所以它们直接标 `nudged: true` 收尾。
      const markAsked = (candidates: readonly ScoredArtifact[], nudged: boolean): void => {
        settled.set(item.source.id, { signature: candidateSignature(item.source.id, candidates), nudged })
      }
      markAsked(item.candidates, item.nudge)
      if (item.candidates.length > MAX_REDISTRIBUTION_CANDIDATES) {
        markAsked(item.candidates, true)
        diagnostics.failed.push({
          round, slot: item.source.id, files,
          reason: `${item.candidates.length} candidates exceed the per-request cap of ${MAX_REDISTRIBUTION_CANDIDATES} — kept stage-1 slots`,
        })
        continue
      }

      // 无效回复重问一次（#3529）：同一份候选件、同一段模板，只回显上次错在哪。
      // 只重问一次 —— 第二次仍无效说明不是一次性抖动，再问是烧钱不是修 bug。
      let applied: ApplyResult | null = null
      let firstRejection: RedistributionRejection | null = null
      let unreadable: string | null = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let reply: RedistributeReply
        try {
          reply = await askSet(item, firstRejection ?? undefined)
        } catch (error) {
          if (!(error instanceof VlmUnreadableError)) throw error
          unreadable = error.message
          break
        }
        const result = applyRedistribution(artifacts, item, reply)
        if (result.invalid === null) {
          applied = result
          break
        }
        if (firstRejection === null) {
          firstRejection = result.invalid
          continue
        }
        // 两遍都无效：记第二遍的分档与理由，并标出「重问过」。两遍分档不同时把第一遍也带上 ——
        // 「先格式坏、再槽名错」与「两遍同一个槽名错」是两种不同的故障
        const first = firstRejection
        markAsked(item.candidates, true)
        diagnostics.failed.push({
          round, slot: item.source.id, files, kind: result.invalid.kind, retried: true,
          reason: `invalid reply twice — kept stage-1 slots: ${result.invalid.message}`
            + (first.kind === result.invalid.kind ? '' : ` (first attempt: ${first.kind} — ${first.message})`),
        })
      }
      if (unreadable !== null) {
        markAsked(item.candidates, true)
        diagnostics.failed.push({
          round, slot: item.source.id, files,
          reason: `evaluator reply unreadable: ${unreadable}`,
          ...(firstRejection === null ? {} : { retried: true, kind: firstRejection.kind }),
        })
        continue
      }
      if (applied === null) continue

      artifacts = applied.artifacts
      // 有效回复后「已解释」的是**这次问过且留下的那组件**：它们的多余部分已被 alternateOf 说明。
      // 只算模型看过的件 —— 同一轮里别的槽刚搬进来的件它没看过，不能算进去。下一轮只要源槽里
      // 还是这一组、且已经追问过，就不再问；集合变了（有件搬进来）才重新成为问题。
      const asked = new Set(item.candidates.map((candidate) => candidate.file))
      markAsked(artifacts.filter((artifact) => artifact.slot === item.source.id && asked.has(artifact.file)), item.nudge)
      if (item.nudge) {
        diagnostics.nudged.push({ round, slot: item.source.id, deficits: item.deficits, moved: applied.moved.length })
      }
      diagnostics.moved.push(...applied.moved)
    }
  }

  diagnostics.residualCoOccurrence = hasCoOccurrence(spec, artifacts)
  return { artifacts, diagnostics }
}
