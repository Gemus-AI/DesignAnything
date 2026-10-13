/**
 * 结构判据的证据面（#3163）—— 把"这件产物长什么样"换成"这件产物是被怎么派出去的"。
 *
 * ## 为什么需要另一条证据面
 *
 * mock 生图通道（`AGENT_EVAL_MOCK_GENERATION`）把像素换成同一张占位图。冻结的视觉评估器
 * 在那种输入上分不出槽 —— 不是它坏了，是证据没了。所以 mock 档必须换判据，而换判据这件事
 * 要**显式声明**（`--evidence prompt` + 另一个 rubricVersion），不能在评估器内部悄悄分叉：
 * 两种判据的数值不可跨批比较，混在同一个 rubric 名下迟早被人当成同一条曲线读。
 *
 * ## 它到底在量什么
 *
 * 量的是**派活**：agent 有没有把 brief 拆成正确的若干件、给每件建了节点、写了对路的提示词、
 * 落在对的区域里、并且真的跑出了产物。**不**量渲染保真度 —— 那正是 mock 档故意不测的东西。
 *
 * 对"长程规划能力"这个问题，派活恰好是被问的那一面。但它是一把**不同的尺子**，
 * 不是原尺子的省钱版：一个把提示词写得完美却渲染跑偏的系统，在这把尺子上得满分。
 *
 * ## 证据取三段，都来自图本身
 *
 * - 生成节点的 `data.label`：agent 给这件交付物起的名字
 * - 上游经 `prompt` 端口连进来的文本节点正文：真正发出去的指令
 * - 所在区域（`comment-zone`）的标题：agent 自己的分组意图
 *
 * 三段拼起来喂给**同一个**分类 prompt。分类器、槽定义、计分函数、顺序契约全部不变，
 * 只有证据的载体从像素变成文本。
 *
 * ## 与像素判据的实测一致性（真实图，8 run，#3163 上线前的验证）
 *
 * 同一批 `ledger-full` 的 8 个 run，两把尺子并排：
 *
 * | 题 | 像素判据 | 结构判据 |
 * |---|---|---|
 * | space r0–r2 | 100 / 100 / 100 | 100 / 100 / 100 |
 * | space r3（生图被饿死 15 张） | **50** | **50** |
 * | ui r0–r3 | 95.8 / 87.5 / 95.8 / 95.8 | 100 / 100 / 100 / 100 |
 *
 * 两处形态都对得上：**交付失败**（space r3 根本没派出去那么多活）两把尺子逐点相同；
 * **渲染/归类失败**（ui 上那 1–3 件派对了但像素归不进槽）结构判据高 4.2–12.5pp。
 * 方向恒为「结构 ≥ 像素」，因为它量的是派活，不量出图。
 *
 * **代价写在这里，别到读数时才想起**：结构判据的天花板更高，agent 派活正确时它就顶到
 * 100%。凡是活在"出图对不对"里的效应，在这把尺子上一律不可见。它能看见的是
 * "该派的活有没有派全" —— 长程规划恰好是这一面，但也仅限这一面。
 *
 * @module benchmarks/design-anything/tools/evaluator/structuralEvidence
 */

import fs from 'fs'
import path from 'path'

interface GraphNode {
  id: string
  type?: string
  data?: {
    label?: string
    title?: string
    config?: Record<string, unknown>
    agentZoneId?: string | null
  }
}

interface GraphConnection {
  source: string
  target: string
  targetHandle?: string
}

export interface StructuralGraph {
  nodes: Map<string, GraphNode>
  /** target nodeId → 经 `prompt` 端口连入的 source nodeId 列表 */
  promptSources: Map<string, string[]>
}

/**
 * 读导出包里的图。`manifest.workflowFile` 是相对**导出根**（run 目录的上一层）的路径。
 *
 * 找不到时抛而不是回退到空图 —— 空图会让每件产物的证据变成空串，分类器把它们全判
 * `unassigned`，读数变成"agent 什么都没交"。那是最危险的一类静默失败：它长得像一个结果。
 */
export function loadStructuralGraph(runDir: string, workflowFile: string | null | undefined): StructuralGraph {
  if (!workflowFile) {
    throw new Error(
      `${runDir}: manifest 没有 workflowFile —— 结构判据（--evidence prompt）需要图，`
      + '而这份导出包里没有。用当前 exporter 重新导出，或改回 --evidence pixel。',
    )
  }
  const file = path.resolve(runDir, '..', workflowFile)
  if (!fs.existsSync(file)) {
    throw new Error(`${runDir}: workflowFile 指向 ${file}，但该文件不存在`)
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    workflow?: { nodes?: GraphNode[]; connections?: GraphConnection[] }
  }
  const nodes = new Map<string, GraphNode>()
  for (const node of parsed.workflow?.nodes ?? []) nodes.set(node.id, node)
  const promptSources = new Map<string, string[]>()
  for (const conn of parsed.workflow?.connections ?? []) {
    if (conn.targetHandle !== 'prompt') continue
    const list = promptSources.get(conn.target) ?? []
    list.push(conn.source)
    promptSources.set(conn.target, list)
  }
  return { nodes, promptSources }
}

/** 从节点 config 里取自由文本 —— `text` 是 text-prompt 的正文，`prompt` 是内联写法。 */
function nodeText(node: GraphNode | undefined): string {
  const config = node?.data?.config
  if (!config) return ''
  for (const key of ['text', 'prompt']) {
    const value = config[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/**
 * 拼一件产物的结构证据。`sourceNodes` 为空（产物追不到生成它的节点）时返回 `null` ——
 * 交给调用方判 `unassigned` 并进 needsManualCheck，而不是拿空串去问分类器。
 */
export function buildStructuralEvidence(
  graph: StructuralGraph,
  sourceNodeIds: string[],
): string | null {
  const parts: string[] = []
  for (const nodeId of sourceNodeIds) {
    const node = graph.nodes.get(nodeId)
    if (!node) continue
    const label = node.data?.label ?? node.data?.title
    if (label) parts.push(`Node label: ${label}`)
    const inline = nodeText(node)
    if (inline) parts.push(`Node prompt: ${inline}`)
    for (const sourceId of graph.promptSources.get(nodeId) ?? []) {
      const upstream = nodeText(graph.nodes.get(sourceId))
      if (upstream) parts.push(`Prompt: ${upstream}`)
    }
    const zoneId = node.data?.agentZoneId
    if (zoneId) {
      const zone = graph.nodes.get(zoneId)
      const zoneTitle = zone?.data?.title ?? zone?.data?.label
      if (zoneTitle) parts.push(`Zone: ${zoneTitle}`)
    }
  }
  return parts.length === 0 ? null : parts.join('\n')
}
