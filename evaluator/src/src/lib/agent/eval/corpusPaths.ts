/** 题库路径与版本的唯一事实来源；纯函数可供 schema、runner 和评估脚本共用。 */
export const DESIGN_ANYTHING_BENCH_VERSIONS = ['v0.1', 'v0.1.1', 'v0.2', 'v0.3', 'v0.4', 'v0.5', 'v0.6'] as const
export type DesignAnythingBenchVersion = typeof DESIGN_ANYTHING_BENCH_VERSIONS[number]
export const DESIGN_ANYTHING_BENCH_VERSION_ENV = 'DESIGN_ANYTHING_BENCH_VERSION'
/**
 * 题库根的覆盖入口（#3584）—— 指向一个**包含** `benchmarks/design-anything/<version>/` 的目录。
 *
 * 编题产出的候选包（`planning/candidate-packages/<batch>/`）就是这种目录：它只有 `benchmarks/`，
 * 没有 `src/`，所以不能把 cwd 指过去（runner 同时要在 cwd 下找内部 fixture 与仓库文件）。
 * 于是「仓库根」与「题库根」是两件事：前者仍是 cwd，后者由这个 env 指定，缺省等于前者。
 *
 * 只影响 `benchmarks/design-anything/` 前缀下的路径；内部 fixture 与历史别名素材照旧在仓库根。
 */
export const DESIGN_ANYTHING_CORPUS_ROOT_ENV = 'DESIGN_ANYTHING_CORPUS_ROOT'
/** 题库路径的共同前缀 —— 判「这条相对路径该锚在题库根还是仓库根」的唯一判据。 */
export const DESIGN_ANYTHING_ROOT_PREFIX = 'benchmarks/design-anything/'
export const INTERNAL_SCENARIOS_REL = 'src/lib/agent/eval/scenarios'
export const INTERNAL_TASKS_REL = 'benchmarks/design-anything/tools/tasks'
export const LEGACY_DESIGN_ANYTHING_ASSETS_REL = 'src/lib/agent/eval/assets/references/bench-da'

export function parseDesignAnythingBenchVersion(value: string | undefined): DesignAnythingBenchVersion {
  if (value === undefined) return 'v0.1.1'
  if (value === 'v0.1' || value === 'v0.1.1' || value === 'v0.2' || value === 'v0.3' || value === 'v0.4' || value === 'v0.5' || value === 'v0.6') return value
  throw new Error(`Unknown DesignAnything benchmark version: ${value}`)
}

export function designAnythingCorpusPaths(version: DesignAnythingBenchVersion) {
  const root = `benchmarks/design-anything/${version}`
  return { root, scenarios: `${root}/scenarios`, tasks: `${root}/tasks`, assets: `${root}/assets`, manifest: `${root}/manifest.json` }
}

/**
 * v0.5 之前的题库版本 —— 它们的**导出包形态**已经定型，不会再跟着工具演进（#3585）。
 *
 * 这是下面两条能力判据的唯一列表：判「不在这份冻结名单里」而不是「等于某个版本号」。
 * 写成 `benchmarkVersion === 'v0.5'` 时，每出一版都要有人记得去加一个字符串，忘了不会
 * 报错，只是导出包里少了东西、读数跟着变（v0.6 的 deck 就这样静默退回了纯文本投影）。
 * v0.1–v0.4 由 {@link assertWritableBenchmarkVersion} 及其冻结约定保证不再产生新导出，
 * 之后的每一版都需要完整形态 —— 所以默认开、只列出不要它的那几版。
 */
const FROZEN_EXPORT_SHAPE_VERSIONS: ReadonlyArray<DesignAnythingBenchVersion> = ['v0.1', 'v0.1.1', 'v0.2', 'v0.3', 'v0.4']

/** 没有版本身份（非 DA 题）时一律按历史形态处理：不凭空升级一条不属于本题库的产物。 */
function hasCurrentExportShape(version: DesignAnythingBenchVersion | undefined): boolean {
  return version !== undefined && !FROZEN_EXPORT_SHAPE_VERSIONS.includes(version)
}

/** 导出包是否保留 deck 的真实页面 HTML 与随页素材（否则只留 `projectDeckText` 的纯文本投影）。 */
export function exportRetainsDeckHtml(version: DesignAnythingBenchVersion | undefined): boolean {
  return hasCurrentExportShape(version)
}

/** 导出包是否记录交付件的原始文件名（`artifact-property` 的 `filename` 判据读它）。 */
export function exportRecordsOriginalFileName(version: DesignAnythingBenchVersion | undefined): boolean {
  return hasCurrentExportShape(version)
}

/** 该仓库相对路径是否属于版本化题库（据此锚到题库根，而不是仓库根）。 */
export function isDesignAnythingCorpusPath(repoRelativePath: string): boolean {
  return repoRelativePath.startsWith(DESIGN_ANYTHING_ROOT_PREFIX)
}

export function assertWritableBenchmarkVersion(version: DesignAnythingBenchVersion): void {
  if (version === 'v0.1' || version === 'v0.1.1') throw new Error(`DesignAnything ${version} is frozen/read-only; explicitly select an unfrozen revision for writes (dry-run remains available)`)
}

/** 只接受规范仓库相对路径；拒绝遍历、Windows 路径、空段和 URL。 */
export function isEvalAssetPath(value: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) return false
  return /^src\/lib\/agent\/eval\/assets\/(references|seeds)\/.+/.test(value)
    || /^benchmarks\/design-anything\/v0\.(?:1(?:\.1)?|2|3|4|5|6)\/assets\/.+/.test(value)
}

/** 旧引用是不可变的 v0.1 别名，绝不跟随当前 runner 选择的版本。 */
export function resolveEvalAssetPath(value: string): { path: string; root: string } {
  if (!isEvalAssetPath(value)) throw new Error(`Scenario reference asset escapes eval asset root: ${value}`)
  if (value.startsWith(`${LEGACY_DESIGN_ANYTHING_ASSETS_REL}/`)) {
    const root = designAnythingCorpusPaths('v0.1').assets
    return { path: `${root}/${value.slice(LEGACY_DESIGN_ANYTHING_ASSETS_REL.length + 1)}`, root }
  }
  const version = /^benchmarks\/design-anything\/(v0\.(?:1(?:\.1)?|2|3|4|5|6))\/assets\//.exec(value)?.[1]
  return { path: value, root: version ? designAnythingCorpusPaths(parseDesignAnythingBenchVersion(version)).assets : `src/lib/agent/eval/assets/${value.split('/')[5]}` }
}

/** 从实际题目的引用推导版本；混用两版素材在花钱之前拒绝。 */
export function benchmarkVersionFromReferences(references: ReadonlyArray<{ path: string }> | undefined): DesignAnythingBenchVersion | undefined {
  const versions = new Set<DesignAnythingBenchVersion>()
  for (const asset of references ?? []) {
    const resolved = resolveEvalAssetPath(asset.path)
    const version = /^benchmarks\/design-anything\/(v0\.(?:1(?:\.1)?|2|3|4|5|6))\/assets\//.exec(resolved.path)?.[1]
    if (version) versions.add(parseDesignAnythingBenchVersion(version))
  }
  if (versions.size > 1) throw new Error('Scenario mixes DesignAnything benchmark asset versions')
  return [...versions][0]
}

/** 纯文本题也可显式声明版本；有图片时声明必须与实际引用一致。 */
export function benchmarkVersionFromScenario(scenario: { id: string; benchmarkVersion?: string; referenceAssets?: ReadonlyArray<{ path: string }> }): DesignAnythingBenchVersion | undefined {
  const fromAssets = benchmarkVersionFromReferences(scenario.referenceAssets)
  const declared = scenario.benchmarkVersion === undefined ? undefined : parseDesignAnythingBenchVersion(scenario.benchmarkVersion)
  if (declared && fromAssets && declared !== fromAssets) throw new Error('Scenario benchmarkVersion conflicts with its asset versions')
  return declared ?? fromAssets ?? (scenario.id.startsWith('bench-da-') ? 'v0.1' : undefined)
}

/** 历史导出没有版本字段时固定解释为 v0.1；评估端不读取环境变量。 */
export function benchmarkVersionForRun(run: { scenarioId: string; benchmarkVersion?: string }): DesignAnythingBenchVersion | undefined {
  if (run.benchmarkVersion !== undefined) return parseDesignAnythingBenchVersion(run.benchmarkVersion)
  if (!run.scenarioId.startsWith('bench-da-')) return undefined
  return 'v0.1'
}

export function benchmarkTaskPath(taskId: string, version: DesignAnythingBenchVersion = 'v0.1'): string {
  return `${taskId.startsWith('bench-da-') ? designAnythingCorpusPaths(version).tasks : INTERNAL_TASKS_REL}/${taskId}.json`
}
