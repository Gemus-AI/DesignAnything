/**
 * 归槽是**带容量约束的整体指派**，不是一串逐件独立的分类（#3541）。
 *
 * ## 病灶
 *
 * 第一段分类过去对每件产物单独调一次分类器，问的是「这一件属于哪个槽」。模型在那一刻
 * 看不到同题其它件，也看不到规格里每个槽期望几件 —— 判别所必需的两份信息都不在输入里。
 * 于是同类画面全部涌向同一个槽：2026-09-08 三臂各 40 格实测，`bench-da-craft-01--r0`
 * 的六件被塞进 `set`（`expected: 1`），而 `directions`（3）、`care-card`、`hero` 三个槽全空。
 * 第二段再分配（`redistribute.ts`）把那两份信息加回来了，但它是**事后局部修补**：
 * 只在超配与缺件共现时触发、只在有限轮内迭代。22/40 格因此判「不可判」，其中 12 格撞满上限、
 * 搬了 82 件、0 次失败 —— 它一直在搬，就是没收敛。
 *
 * ## 本模块把它改回它本来的形状
 *
 * 槽有容量（`expected`），产物有数量，两边要配平 —— 这是指派问题的定义。所以：
 * 分类器对**每件 × 每个候选槽**给一个可比的分数（`prompts.CLASSIFY_SCORES_PROMPT_TEMPLATE`），
 * 本模块在「每槽不超过它的席位数、每件至多进一个槽」的约束下一次性求全局最优。
 *
 * **为什么这能解决「三个互不相同的探索方向」这种集合层面的属性。** 它并不要求模型能
 * 单看一张图就说出「这是三选一里的第二张」—— 那确实是逐件独立判原理上看不见的。
 * 它只要求模型如实说出「这张图**也**可能是方向稿（40 分），更像成品（90 分）」。
 * 容量约束负责剩下的事：`set` 只有一个席位，六件里只能留一件，其余五件各自去自己第二高
 * 且还有席位的地方。判别力来自**约束**，不来自模型多知道了什么 —— 三条臂的输入一个字节没变。
 *
 * ## 三条纪律
 *
 * 1. **不强搬。** `unassigned` 是目标函数里一个容量无限的去处，它的分数由模型自己给
 *    （「这一件不属于上面任何一个槽」的可能性）。没有哪条规则要求把每件都塞进某个槽 ——
 *    塞进去会把一种可检测的错误换成一种不可检测的错误（#3529 的裁定不变）。
 * 2. **席位满了不等于这一件不属于该槽。** `expected` 说的是「这个槽要几件**交付物**」，
 *    不是「这个槽最多放几个文件」。候选稿 + 定稿放在一个 `expected: 1` 的槽里是
 *    #3113 与 `alternativesAllowed` 明写的正常形态。所以求解分两步：先解席位（那是
 *    需要全局推理的部分），剩下的件再各自就近挂靠（那是纯粹逐件的问题，见
 *    {@link solveSlotAssignment} 的「第二步」）。
 * 3. **不喂 agent 自陈。** 输入只有图与规格 —— 不喂节点 label / zone 名 / 生成顺序。
 *    外部臂没有这些字段，喂进去等于让读数变成「哪条臂是我们自己的」。
 *
 * 本模块是纯函数：不做 I/O、不调模型。分类调用由 `evaluate.ts` 注入，
 * 求解结果由它回填到 `ScoredArtifact.slot`。
 *
 * @module benchmarks/design-anything/tools/evaluator/assignment
 */

import type { UnassignedCause } from './scoring'
import type { SlotSpec } from './taskSpec'

/** 「不属于任何槽」。它是分类器的合法答案，也是指派问题里那个容量无限的去处。 */
export const UNASSIGNED_SLOT = 'unassigned'

/** 分数的上界。分类器按 0..100 打分，超界一律夹到区间内。 */
export const MAX_FIT_SCORE = 100

/**
 * 分类器的新回复形态（#3541）：**每个候选槽各一个分数**，而不是只回一个槽名。
 *
 * `slot` 允许是 {@link UNASSIGNED_SLOT} —— 那一项打的是「这一件哪个槽都不属于」的可能性，
 * 与其它项同尺度、可直接比较。
 */
export interface ClassifyScoresReply {
  scores: Array<{ slot: string; fit: number }>
  confidence: 'high' | 'low'
  reason: string
}

/** 归一化之后的一件产物的分数表。 */
export interface NormalizedScores {
  /** 只含候选清单里的槽；缺席 = 模型没给分，按 0 处理 */
  scores: Map<string, number>
  unassignedScore: number
  confidence: 'high' | 'low'
  reason: string
  /** 回复里出现过但不在候选清单里的槽名（诊断用，不参与求解） */
  unknownSlots: string[]
  /**
   * 走了降级路径。`legacy-single-slot` = 模型回的是 #3541 之前那种「只有一个槽名」的形态，
   * 按「该槽 100 分、其余 0 分」收下 —— 那退化成逐件独立判，读数会偏，所以必须可数。
   */
  degraded: 'legacy-single-slot' | null
}

/** 归一化失败的成因。调用方据此落 `unassignedCause`。 */
export type NormalizeFailure =
  /** 连 `scores` 数组都没有，也不是旧形态 —— 回复形态本身坏了 */
  | 'unreadable'
  /** 回复只提到了本题不存在的槽名，一条可用的分数都没有 */
  | 'unknown-slots-only'

/**
 * 把一次分类回复归一化成分数表。**返回 `null` 之外的一切都可以进求解器。**
 *
 * 三条降级路径，按可信度从高到低：
 * 1. 新形态 `scores[]` —— 正常路径。
 * 2. 旧形态 `{slot, confidence, reason}` —— 按该槽 100 分收下并标 `degraded`。
 *    #3541 之前的缓存不会命中（prompt sha 变了），这条是给「模型没按新格式答」兜底的。
 * 3. 两种都不成立 —— 返回失败成因，由调用方记成未归槽的**成因**而不是「没交这一件」。
 */
export function normalizeClassifyScores(
  reply: unknown,
  candidateSlotIds: readonly string[],
): { ok: true; value: NormalizedScores } | { ok: false; failure: NormalizeFailure } {
  if (reply === null || typeof reply !== 'object') return { ok: false, failure: 'unreadable' }
  const record = reply as Record<string, unknown>
  const confidence: 'high' | 'low' = record.confidence === 'low' ? 'low' : 'high'
  const reason = typeof record.reason === 'string' ? record.reason : ''
  const known = new Set(candidateSlotIds)

  if (Array.isArray(record.scores)) {
    const scores = new Map<string, number>()
    const unknownSlots: string[] = []
    let unassignedScore = 0
    let sawUsable = false
    for (const entry of record.scores as unknown[]) {
      if (entry === null || typeof entry !== 'object') continue
      const item = entry as Record<string, unknown>
      if (typeof item.slot !== 'string') continue
      const fit = clampFit(item.fit)
      if (fit === null) continue
      if (item.slot === UNASSIGNED_SLOT) {
        unassignedScore = Math.max(unassignedScore, fit)
        sawUsable = true
        continue
      }
      if (!known.has(item.slot)) {
        if (!unknownSlots.includes(item.slot)) unknownSlots.push(item.slot)
        continue
      }
      // 同一个槽出现两次取较高的一次：模型偶尔会把同一项写两遍，取高不取低是为了不凭空压低它
      scores.set(item.slot, Math.max(scores.get(item.slot) ?? 0, fit))
      sawUsable = true
    }
    if (!sawUsable) {
      return { ok: false, failure: unknownSlots.length > 0 ? 'unknown-slots-only' : 'unreadable' }
    }
    return { ok: true, value: { scores, unassignedScore, confidence, reason, unknownSlots, degraded: null } }
  }

  // 降级：#3541 之前的单槽形态
  if (typeof record.slot === 'string') {
    if (record.slot === UNASSIGNED_SLOT) {
      return {
        ok: true,
        value: { scores: new Map(), unassignedScore: MAX_FIT_SCORE, confidence, reason, unknownSlots: [], degraded: 'legacy-single-slot' },
      }
    }
    if (!known.has(record.slot)) return { ok: false, failure: 'unknown-slots-only' }
    return {
      ok: true,
      value: {
        scores: new Map([[record.slot, MAX_FIT_SCORE]]),
        unassignedScore: 0,
        confidence,
        reason,
        unknownSlots: [],
        degraded: 'legacy-single-slot',
      },
    }
  }

  return { ok: false, failure: 'unreadable' }
}

/** 分数取整并夹到 `[0, MAX_FIT_SCORE]`；不是有限数则返回 `null`（这一项作废，不当 0 用）。 */
function clampFit(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  if (!Number.isFinite(value)) return null
  return Math.max(0, Math.min(MAX_FIT_SCORE, Math.round(value)))
}

/**
 * 一个槽在求解里的**席位数**。
 *
 * `deliveryGrouping: 'pages'` 的槽期望的是「一份多页作品」，但它可以按逐页图交付 ——
 * 那时件数是页数。与 `redistribute.ts` 的输入构造同源，两处必须用同一条换算，
 * 否则求解器和残留检查会对同一个槽算出不同的容量。
 */
export function imageSlotSeats(slot: SlotSpec): number {
  return slot.deliveryGrouping === 'pages' ? slot.minPages ?? 1 : slot.expected
}

/** 求解器眼里的一个槽：id + 还剩几个席位。 */
export interface AssignmentSlot {
  id: string
  /** 席位数；已被其它归属通道（文档 / 视频）占掉的要先减掉 */
  seats: number
}


/** 求解器眼里的一件产物。 */
export interface AssignmentItem {
  /** 稳定标识，用于回填。`evaluate.ts` 传文件名 */
  key: string
  /** 该件对每个**可行**槽的分数。槽缺席 = 它对这一件不可行（如预分类判它不是这种载体） */
  scores: ReadonlyMap<string, number>
  /** 「哪个槽都不属于」的分数 */
  unassignedScore: number
  /**
   * 席位资格的平局容差（#3948）：这一件只能在「与自己最佳槽的判官原始分差不超过它」的槽占席位，
   * 分差更大的槽只能挂靠。缺席 = 不设上限（与 #3541 的行为逐字一致）。取值是**载体属性**，
   * 由预分类表给出（`carrierKind.ts` 的 `CARRIER_SEAT_TOLERANCE`），求解器本身只有这一条规则。
   */
  seatTolerance?: number
  /**
   * 占席位时的加分（#3948 页数优先）。只在过了 {@link AssignmentItem.seatTolerance} 门、且原始分严格高于
   * `unassignedScore` 的边上生效，只用来在有席位资格的件之间分胜负；不写回判官分，不影响挂靠。
   */
  seatBonus?: ReadonlyMap<string, number>
}

/** 页数加分的上限（满分 100 的 10%）。小于判官的明显分差：15 分以上的分差任何加分都翻不过来。 */
export const PAGE_FLOOR_BONUS = 10

/**
 * 有页数下限的文档槽上，页数读得出的件的占席位加分（#3948）：`round(PAGE_FLOOR_BONUS × min(pages, floor) / floor)`。
 * 页数读不出 → 0（不猜）。目的：判官分数相近时，能达标的件赢得席位。
 */
export function pageFloorSeatBonus(pages: number | undefined, floor: number | undefined): number {
  if (pages === undefined || floor === undefined || floor <= 0) return 0
  // 取整：费用保持整数，求解器的比较不受浮点误差影响
  return Math.round(PAGE_FLOOR_BONUS * Math.min(pages, floor) / floor)
}

/** 一件产物的最终落点。 */
export interface AssignmentPlacement {
  key: string
  /** 槽 id 或 {@link UNASSIGNED_SLOT} */
  slot: string
  /**
   * `seat` = 占了该槽的一个正式席位；
   * `overflow` = 席位已满，作为多余件挂在该槽（候选稿 / 定稿之外的那些）；
   * `unassigned` = 不属于任何槽。
   */
  placement: 'seat' | 'overflow' | 'unassigned'
  /** 只看分数、不看容量时会去的地方 —— 逐件独立判会给出的那个答案 */
  preferred: string
  /** 落点与 {@link AssignmentPlacement.preferred} 不同 = 被容量约束挪开了 */
  displaced: boolean
}

/**
 * 求解带容量约束的最优指派。
 *
 * ## 两步，各自解各自的问题
 *
 * **第一步（全局）**：每槽 `seats` 个席位、每件至多一个席位、`unassigned` 容量无限，
 * 在这些约束下最大化总分。这是需要全局推理的那一半 —— 谁占席位取决于别人能不能占别处。
 * 用最小费用最大流求解（费用 = `MAX_FIT_SCORE - 分数`，全非负；总流量恒为件数，
 * 故最小化总费用 ⟺ 最大化总分）。规模是每格十来件 × 十来槽，代价可忽略。
 *
 * **第二步（逐件）**：第一步落到 `unassigned` 的件，再看一眼它自己分数最高的那个槽 ——
 * 如果**严格高于**它的 `unassigned` 分，就作为多余件挂上去（`overflow`）。
 * 这一步没有全局性可言：第一步的最优性保证了这类件的高分槽此刻一定已经满了
 * （若还有空席位且分数更高，把它挪过去会降低总费用，与最优矛盾），所以这里不存在竞争，
 * 只剩「这一件是散件还是某个槽的额外一件」这个纯粹逐件的问题。
 *
 * 第二步是**必要的**：没有它，`expected: 1` 的槽里那对「候选稿 + 定稿」会被硬拆，
 * 落选的一件被判成散件 —— 那不是修 bug，是换一种方式弄错。
 *
 * ## 平局
 *
 * 费用里带一个次级项：`unassigned` 取 0，槽取「它在 `slots` 里的下标 + 1」。
 * 于是同分时 `unassigned` 优先（诚实的缺省，不硬塞），其次按规格序取靠前的槽。
 * 次级项的量级被压在一分之下（见 `tieScale`），不会翻动任何一次真实的分数比较。
 * 同一份输入永远得到同一份输出。
 */
export function solveSlotAssignment(input: {
  items: readonly AssignmentItem[]
  slots: readonly AssignmentSlot[]
}): AssignmentPlacement[] {
  const { items } = input
  // 席位为 0 或负（已被其它通道占满）的槽仍是**可挂靠**的目的地，但不提供席位
  const slots = input.slots.map((slot) => ({ ...slot, seats: Math.max(0, slot.seats) }))
  if (items.length === 0) return []

  const slotIndex = new Map(slots.map((slot, index) => [slot.id, index]))
  // 次级项最多累计 items.length * slots.length，压在一个分数单位之下即可保证不翻动主序
  const tieScale = items.length * (slots.length + 1) + 1
  // 上界含加分，费用保持非负（加分只会让分数超过 MAX_FIT_SCORE，不会低于 0）
  const costOf = (score: number, tie: number): number => (MAX_FIT_SCORE + PAGE_FLOOR_BONUS - score) * tieScale + tie

  const itemNode = (i: number): number => 1 + i
  const slotNode = (s: number): number => 1 + items.length + s
  const source = 0
  const unassignedNode = 1 + items.length + slots.length
  const sink = unassignedNode + 1
  const flow = new MinCostFlow(sink + 1)

  // 记下 (件, 槽) 边在图里的位置，求完解直接读它有没有被用掉
  const slotEdges: Array<Array<{ slot: string; edge: number }>> = []
  for (let i = 0; i < items.length; i += 1) {
    flow.addEdge(source, itemNode(i), 1, 0)
    const edges: Array<{ slot: string; edge: number }> = []
    const best = bestSlot(items[i], slots)
    for (const [slotId, score] of items[i].scores) {
      const s = slotIndex.get(slotId)
      if (s === undefined) continue
      if (slots[s].seats === 0) continue
      // #3948 席位资格只看判官原始分：严格高于 unassigned（缺了这一条，加分能把 unassigned 翻过去），
      // 且与最合适槽的分差在平局容差内。两条都不成立的槽不建占席位的边，仍可在第二步挂靠。
      if (score <= items[i].unassignedScore) continue
      const tolerance = items[i].seatTolerance
      if (tolerance !== undefined && best !== null && best.score - score > tolerance) continue
      const bonus = items[i].seatBonus?.get(slotId) ?? 0
      edges.push({ slot: slotId, edge: flow.addEdge(itemNode(i), slotNode(s), 1, costOf(score + bonus, s + 1)) })
    }
    slotEdges.push(edges)
    flow.addEdge(itemNode(i), unassignedNode, 1, costOf(items[i].unassignedScore, 0))
  }
  for (let s = 0; s < slots.length; s += 1) {
    if (slots[s].seats > 0) flow.addEdge(slotNode(s), sink, slots[s].seats, 0)
  }
  // `unassigned` 容量无限 —— 用件数封顶即等价，且每件都有这条边，故总流量恒等于件数
  flow.addEdge(unassignedNode, sink, items.length, 0)
  flow.run(source, sink, items.length)

  return items.map((item, i) => {
    const preferred = preferredSlot(item, slots)
    const taken = slotEdges[i].find((entry) => flow.isSaturated(itemNode(i), entry.edge))
    if (taken !== undefined) {
      return { key: item.key, slot: taken.slot, placement: 'seat', preferred, displaced: taken.slot !== preferred }
    }
    // 第二步：席位没抢到的件，挂到自己分数最高且严格高于 unassigned 分的槽上
    const overflow = bestSlot(item, slots)
    if (overflow !== null && overflow.score > item.unassignedScore) {
      return { key: item.key, slot: overflow.id, placement: 'overflow', preferred, displaced: overflow.id !== preferred }
    }
    return { key: item.key, slot: UNASSIGNED_SLOT, placement: 'unassigned', preferred, displaced: preferred !== UNASSIGNED_SLOT }
  })
}

/**
 * 一次求解的占席位总分（#3948）：每个 `seat` 落点的判官分加占席位加分 —— 正是求解器最大化的那个量。
 * `placements` 与 `items` 按下标对应（{@link solveSlotAssignment} 的返回序）。
 */
export function seatedTotal(items: readonly AssignmentItem[], placements: readonly AssignmentPlacement[]): number {
  let total = 0
  placements.forEach((placement, i) => {
    if (placement.placement !== 'seat') return
    total += (items[i].scores.get(placement.slot) ?? 0) + (items[i].seatBonus?.get(placement.slot) ?? 0)
  })
  return total
}

/** 分数最高的可行槽（平局取规格序靠前的）；一个可行槽都没有时返回 `null`。 */
function bestSlot(item: AssignmentItem, slots: readonly AssignmentSlot[]): { id: string; score: number } | null {
  let best: { id: string; score: number } | null = null
  for (const slot of slots) {
    const score = item.scores.get(slot.id)
    if (score === undefined) continue
    if (best === null || score > best.score) best = { id: slot.id, score }
  }
  return best
}

/**
 * 只看分数、不看容量时这一件会去的槽（#3948 导出给 `evaluate.deckSourcePreferredSlot`）：
 * 分数最高、且严格高于 `unassigned` 分的槽；平局取插入序靠前者；都不高于 `unassigned` 时为 {@link UNASSIGNED_SLOT}。
 */
export function preferredSlotOf(scores: ReadonlyMap<string, number>, unassignedScore: number): string {
  let best: { id: string; score: number } | null = null
  for (const [id, score] of scores) if (best === null || score > best.score) best = { id, score }
  return best !== null && best.score > unassignedScore ? best.id : UNASSIGNED_SLOT
}

/** 逐件独立判会给出的答案：分数最高者，平局时 `unassigned` 优先。 */
function preferredSlot(item: AssignmentItem, slots: readonly AssignmentSlot[]): string {
  const best = bestSlot(item, slots)
  return best !== null && best.score > item.unassignedScore ? best.id : UNASSIGNED_SLOT
}

interface FlowEdge { to: number; cap: number; cost: number; rev: number }

/**
 * 最小费用最大流（连续最短增广路 + SPFA）。图小到可以忽略复杂度：
 * 每格十来件、十来槽，增广次数等于件数。
 *
 * SPFA 而不是 Dijkstra：残差边的费用是负的，Dijkstra 需要额外维护势能，而这里的规模
 * 完全不需要那点常数。原图无负环（是个分层 DAG），所以连续最短增广路给出的是全局最优。
 */
class MinCostFlow {
  private readonly graph: FlowEdge[][]

  constructor(nodes: number) {
    this.graph = Array.from({ length: nodes }, () => [] as FlowEdge[])
  }

  /** 返回这条正向边在 `from` 的邻接表里的下标 */
  addEdge(from: number, to: number, cap: number, cost: number): number {
    const index = this.graph[from].length
    this.graph[from].push({ to, cap, cost, rev: this.graph[to].length })
    this.graph[to].push({ to: from, cap: 0, cost: -cost, rev: index })
    return index
  }

  /** 这条正向边是否已被用满（容量 1 的边即「被选中」） */
  isSaturated(from: number, edge: number): boolean {
    return this.graph[from][edge].cap === 0
  }

  run(source: number, sink: number, maxFlow: number): void {
    let sent = 0
    while (sent < maxFlow) {
      const dist = new Array<number>(this.graph.length).fill(Number.POSITIVE_INFINITY)
      const inQueue = new Array<boolean>(this.graph.length).fill(false)
      const prevNode = new Array<number>(this.graph.length).fill(-1)
      const prevEdge = new Array<number>(this.graph.length).fill(-1)
      dist[source] = 0
      const queue: number[] = [source]
      inQueue[source] = true
      while (queue.length > 0) {
        const node = queue.shift() as number
        inQueue[node] = false
        this.graph[node].forEach((edge, index) => {
          if (edge.cap <= 0) return
          const next = dist[node] + edge.cost
          if (next >= dist[edge.to]) return
          dist[edge.to] = next
          prevNode[edge.to] = node
          prevEdge[edge.to] = index
          if (!inQueue[edge.to]) {
            inQueue[edge.to] = true
            queue.push(edge.to)
          }
        })
      }
      if (!Number.isFinite(dist[sink])) return
      let push = maxFlow - sent
      for (let node = sink; node !== source; node = prevNode[node]) {
        push = Math.min(push, this.graph[prevNode[node]][prevEdge[node]].cap)
      }
      for (let node = sink; node !== source; node = prevNode[node]) {
        const edge = this.graph[prevNode[node]][prevEdge[node]]
        edge.cap -= push
        this.graph[edge.to][edge.rev].cap += push
      }
      sent += push
    }
  }
}

/**
 * 一件产物在**求解之前**的状态：分数收下了没有，收不下是因为什么。
 *
 * `slot` 恒为 {@link UNASSIGNED_SLOT} —— 求解之前这一件的落点还不存在，占位值必须是
 * 「还没有归属」而不是某个猜测，否则占位值会被后面的席位统计当成真落点。
 */
export interface PendingClassification {
  slot: string
  confidence: 'high' | 'low'
  reason: string
  /** 只在 `scores === null` 时出现：这一件为什么没能进求解 */
  unassignedCause?: UnassignedCause
  /** `null` = 这一件进不了求解（分类调用失败，或回复里一条可用的分数都没有） */
  scores: NormalizedScores | null
}

/**
 * 把一次分类调用的结果读成待求解状态。
 *
 * #3488 的两条纪律原样保留：**分类器打的分是读数**（`unassigned` 高分是它的正式回答，
 * 不记成因），**调用失败才是仪器故障**（记 `classify-failed`，那不是「系统没交这一件」）。
 * 回复里只提到本题不存在的槽名时记 `classifier-unknown-slot` —— 与 #3488 同一个成因，
 * 只是不再有「换个问法重问一次」那一步：打分式回复里编出来的槽名直接不参与求解，
 * 其余槽的分数照常可用，没有什么要重问的。
 */
export function readClassifyScores(input: {
  reply: unknown
  slots: ReadonlyArray<{ id: string }>
  /** 分类调用彻底失败时写进 reason 的整句 */
  failedReason: string
}): PendingClassification {
  if (input.reply === null || input.reply === undefined) {
    return { slot: UNASSIGNED_SLOT, confidence: 'high', reason: input.failedReason, unassignedCause: 'classify-failed', scores: null }
  }
  const normalized = normalizeClassifyScores(input.reply, input.slots.map((slot) => slot.id))
  if (!normalized.ok) {
    return normalized.failure === 'unknown-slots-only'
      ? {
          slot: UNASSIGNED_SLOT,
          confidence: 'high',
          reason: 'classifier scored only slot ids that do not exist in this task — recorded as unassigned',
          unassignedCause: 'classifier-unknown-slot',
          scores: null,
        }
      : {
          slot: UNASSIGNED_SLOT,
          confidence: 'high',
          reason: `${input.failedReason} (reply carried no usable slot scores)`,
          unassignedCause: 'classify-failed',
          scores: null,
        }
  }
  return {
    slot: UNASSIGNED_SLOT,
    confidence: normalized.value.confidence,
    reason: normalized.value.reason,
    scores: normalized.value,
  }
}
