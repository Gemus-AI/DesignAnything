/** 身份素材锚只消费同版 scenario 的公开附件；读取复用运行器的真实路径围栏并核对 SHA。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { benchmarkVersionFromScenario, designAnythingCorpusPaths, INTERNAL_SCENARIOS_REL, resolveEvalAssetPath } from '../../../../src/lib/agent/eval/corpusPaths'
import { assertInsideAssetRoot } from '../../../../src/lib/agent/eval/scenario/materializeReferenceAssets'
import { parseScenario } from '../../../../src/lib/agent/eval/scenarioSchema'
import { evaluationCorpusPaths } from '../corpusPaths'
import type { TaskSpec } from './taskSpec'

export interface IdentityAssetBindings {
  projectRoot: string
  references: ReadonlyMap<string, { path: string; sha256: string }>
}

export function resolveIdentityAsset(bindings: IdentityAssetBindings, file: string): string {
  const reference = bindings.references.get(file)
  if (!reference) throw new Error(`Identity asset is not a bound scenario reference: ${file}`)
  const absolute = assertInsideAssetRoot(bindings.projectRoot, reference.path)
  const observed = createHash('sha256').update(readFileSync(absolute)).digest('hex')
  if (observed !== reference.sha256) throw new Error(`Identity asset checksum mismatch: ${reference.path}`)
  return absolute
}

/**
 * 锚文件 → 磁盘路径。**两条路径不同源**：素材锚的文件在题包里（走绑定校验），
 * 槽锚的在导出包的 `artifacts/` 里（直接拼路径）。
 *
 * 抽出来共用是因为已经有第三处要做同一个判断了（抽样器 #3519、定点重判 #3634），
 * 而「这个锚在哪」错了不会报错，只会安静地比错两张图。
 */
export function resolveIdentityAnchorPath(input: {
  band: 'assets' | 'run' | 'lineage'
  file: string
  bindings: IdentityAssetBindings
  artifactsDir: string
}): string {
  return input.band === 'assets'
    ? resolveIdentityAsset(input.bindings, input.file)
    : path.join(input.artifactsDir, input.file)
}

/** 批次派发前核对 spec 身份及所有素材锚；任何失败都发生在模型调用之前。 */
export function prepareIdentityAssetBindings(
  run: { scenarioId: string; benchTaskId?: string; benchmarkVersion?: string },
  spec: TaskSpec,
  projectRoot = process.cwd(),
): IdentityAssetBindings {
  const corpus = evaluationCorpusPaths(run)
  const taskId = run.benchTaskId ?? run.scenarioId
  if (spec.taskId !== taskId) throw new Error(`TaskSpec taskId mismatch: expected ${taskId}, got ${spec.taskId}`)
  const files = [...new Set((spec.identityConsistency ?? []).flatMap(rule => rule.anchorAssets ?? []))]
  const bindings: IdentityAssetBindings = { projectRoot, references: new Map() }
  if (files.length === 0) return bindings
  const scenarios = taskId.startsWith('bench-da-')
    ? designAnythingCorpusPaths(corpus.benchmarkVersion ?? 'v0.1').scenarios
    : INTERNAL_SCENARIOS_REL
  const scenario = parseScenario(JSON.parse(readFileSync(path.join(projectRoot, scenarios, `${taskId}.json`), 'utf8')))
  const expectedVersion = corpus.benchmarkVersion ?? (taskId.startsWith('bench-da-') ? 'v0.1' : undefined)
  if (scenario.id !== taskId || benchmarkVersionFromScenario(scenario) !== expectedVersion) {
    throw new Error(`Identity asset scenario/version mismatch: ${taskId}`)
  }
  const expectedRoot = path.resolve(projectRoot, corpus.assetsDir)
  const references = new Map<string, { path: string; sha256: string }>()
  for (const file of files) {
    if (/[\\/:]/.test(file) || file === '.' || file === '..') throw new Error(`Invalid identity asset filename: ${file}`)
    const expectedPath = path.join(expectedRoot, file)
    const matches = (scenario.referenceAssets ?? []).filter(reference => {
      return path.resolve(projectRoot, resolveEvalAssetPath(reference.path).path) === expectedPath
    })
    if (matches.length !== 1) throw new Error(`Identity asset must match exactly one same-version scenario reference: ${taskId}/${file}`)
    references.set(file, { path: matches[0].path, sha256: matches[0].sha256 })
  }
  const bound = { projectRoot, references }
  for (const file of files) resolveIdentityAsset(bound, file)
  return bound
}
