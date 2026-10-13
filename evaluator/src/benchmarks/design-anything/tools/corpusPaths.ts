import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import {
  benchmarkTaskPath,
  benchmarkVersionForRun,
  designAnythingCorpusPaths,
  type DesignAnythingBenchVersion,
} from '../../../src/lib/agent/eval/corpusPaths'

/** 显式 --tasks 仍覆盖 spec；素材锚始终由 run 的版本固定，不能被当前环境重定向。 */
export function evaluationCorpusPaths(
  run: { scenarioId: string; benchTaskId?: string; benchmarkVersion?: string },
  tasksOverride?: string,
) {
  assertBenchmarkTaskId(run.scenarioId)
  const version = benchmarkVersionForRun(run)
  const taskId = run.benchTaskId ?? run.scenarioId
  return {
    benchmarkVersion: version,
    taskFile: taskFilePath(taskId, tasksOverride, version),
    assetsDir: path.join(designAnythingCorpusPaths(version ?? 'v0.1').assets, taskId),
  }
}

/**
 * 判据包身份（#3550）：整个 tasks 目录的内容哈希。
 *
 * TaskSpec 一份文件同时写「要交什么」（M1 的槽）和「怎么判」（M2 的三段判据）。换一套判据
 * 重判同一批导出包时 `benchmarkVersion` 不会变 —— 它来自 run 的 manifest，记的是**被测对象**
 * 的版本；于是 `evaluatorIdentity()` 看不见尺子换了，新旧读数会被静默当成可比。这个值补上那一段。
 *
 * **逐题的 `specSha` 不能拿来当评估器身份**：槽位清单逐题不同，会让同一批次里不同题的格互判为
 * 「不同评估器」，把一张本来正当的对照表拒掉（见 evaluate.ts 输出处那段注释）。目录级哈希在
 * 一个批次里是常量，正好落在那条约束之内。
 */
export function taskSetSha(tasksDir: string): string {
  const files = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json')).sort()
  if (files.length === 0) throw new Error(`No task specs in ${tasksDir} — cannot identify the ruler pack`)
  const digest = createHash('sha256')
  for (const name of files) {
    // 分隔符只要不出现在文件名与十六进制摘要里就够；用可打印字符，免得转义在工具链里被吃掉
    digest.update(name).update(':')
    digest.update(createHash('sha256').update(fs.readFileSync(path.join(tasksDir, name))).digest('hex')).update(';')
  }
  return `sha256:${digest.digest('hex')}`
}

export function taskFilePath(taskId: string, tasksOverride?: string, version: DesignAnythingBenchVersion = 'v0.1'): string {
  assertBenchmarkTaskId(taskId)
  return tasksOverride ? path.join(tasksOverride, `${taskId}.json`) : benchmarkTaskPath(taskId, version)
}

/** manifest 只能选题号，不能借题号指定路径；显式 --tasks 也不取消这条边界。 */
export function assertBenchmarkTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(taskId)) {
    throw new Error(`Invalid benchmark task id: ${JSON.stringify(taskId)}`)
  }
}
