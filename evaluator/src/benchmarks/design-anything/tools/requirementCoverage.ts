/** 需求台账的结构与证据绑定检查；语义是否穷尽仍须独立人工审核。 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import { designAnythingCorpusPaths, parseDesignAnythingBenchVersion, type DesignAnythingBenchVersion } from '../../../src/lib/agent/eval/corpusPaths'
import { parseScenario, type EvalScenario } from '../../../src/lib/agent/eval/scenarioSchema'
import { expandAsset, normalizeDocumentNewlines, type Manifest } from './assets/manifestExpand'
import { resolveChecklist } from './evaluator/dqChecklist'
import { loadTaskSpec, slotAccepts, type TaskSpec } from './evaluator/taskSpec'
import { identityRuleContext, retiredIdentityReason } from './evaluator/truthSource'
import { readPublicRequirementInputs } from './evaluator/requirementEvidence'

const nonempty = z.string().refine(value => value.trim().length > 0, 'Must be nonempty')
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256')
const coverageValues = ['full', 'partial', 'missing', 'diagnostic', 'manual'] as const
const requirementSchema = z.object({
  id: nonempty,
  requirement: nonempty,
  source: nonempty,
  sourceFile: nonempty,
  sourceQuote: nonempty,
  rules: z.array(nonempty),
  coverage: z.enum(coverageValues),
  reason: nonempty,
})

export const requirementCoverageTaskSchema = z.object({
  taskId: nonempty,
  scenarioSha256: hashSchema,
  specSha256: hashSchema,
  requirements: z.array(requirementSchema).min(1),
})

export const requirementCoverageSchema = z.object({
  schemaVersion: z.literal(1),
  benchmarkVersion: nonempty,
  baselineVersion: z.enum(['v0.3', 'v0.4']),
  tasks: z.array(requirementCoverageTaskSchema).min(1),
})

/** 新编题绑定自己的真实字节，不声明不存在的历史基线。 */
export const draftRequirementCoverageSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('authoring-draft'),
  benchmarkVersion: z.literal('v0.6'),
  tasks: z.array(requirementCoverageTaskSchema.strict()).min(1),
}).strict()

export type RequirementCoverageLedger = z.infer<typeof requirementCoverageSchema>
export type DraftRequirementCoverageLedger = z.infer<typeof draftRequirementCoverageSchema>
export type RequirementCoverage = typeof coverageValues[number]
export interface RequirementCoverageGap {
  taskId: string
  requirementId: string
  requirement: string
  coverage: Exclude<RequirementCoverage, 'full'>
  reason: string
}

export interface RequirementCoverageReport {
  status: 'ready' | 'not-ready' | 'invalid'
  /** ready 仅表示台账中已记录的需求通过门，不代表程序证明了语义穷尽。 */
  scope: 'recorded-requirements-only; independent completeness review required'
  errors: string[]
  gaps: RequirementCoverageGap[]
  counts: { tasks: number; requirements: number } & Record<RequirementCoverage, number>
  wiring?: { status: 'complete' | 'incomplete'; wired: number; total: number; automated: number; manual: number; diagnostic: number }
}

export interface RequirementCoverageOptions {
  mode?: 'version-corpus' | 'authoring-draft'
  version?: DesignAnythingBenchVersion
  repositoryRoot?: string
  ledgerFile?: string
  requireFull?: boolean
  requireWired?: boolean
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function isCanonicalRelativeFile(file: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(file)
    && file.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** 引用存在与引用是否计分是两件事；诊断量和被排除的 DQ 清单不能单独支持 full。 */
function ruleReferences(spec: TaskSpec): Map<string, boolean> {
  const references = new Map<string, boolean>([['slots:*', true]])
  for (const check of spec.requirementChecks ?? []) references.set(`requirementChecks:${check.id}`, check.method !== 'diagnostic' && check.method !== 'manual')
  for (const slot of spec.slots) references.set(`slots:${slot.id}`, true)
  for (const constraint of spec.constraints ?? []) references.set(`constraints:${constraint.id}`, constraint.kind !== 'pixel-color')
  for (const rule of spec.setConsistency ?? []) references.set(`setConsistency:${rule.id}`, true)
  // 退役的身份判据（#3518 配色槽锚、#3557 血脉链）打分时一律 not-applicable：引用合法，但撑不起 full（#3609）
  for (const rule of spec.identityConsistency ?? []) references.set(`identityConsistency:${rule.id}`, retiredIdentityReason(rule, identityRuleContext(spec, rule)) === null)
  for (const rule of spec.carryThrough ?? []) references.set(`carryThrough:${rule.id}`, true)
  for (const rule of spec.setVlmRubric ?? []) {
    const targets = spec.slots.filter(slot => slotAccepts(slot, 'image') && (rule.slots === undefined || rule.slots.includes(slot.id)))
    const expectedImages = targets.reduce((total, slot) => total + slot.expected, 0)
    // 对齐 planSetRubric / scoreSetRubric 的最小图数；无来源的 v2 规则仍沿用旧集合门。
    // 这里只排除声明形状必然不足的规则；运行中仍可能缺图、转写失败或语义 N/A。
    references.set(`setVlmRubric:${rule.id}`, expectedImages >= (rule.sourceSlots === undefined ? 2 : 1))
  }
  if (spec.dqRubric) {
    const checklist = resolveChecklist(spec.dqRubric)
    references.set('dqRubric', Array.isArray(checklist) && checklist.length > 0)
  }
  return references
}

/** 附件必须既登记在本题 manifest 中，又实际作为文本输入送给被测系统。 */
function publicSources(
  repositoryRoot: string,
  version: DesignAnythingBenchVersion,
  taskId: string,
  scenario: EvalScenario,
  manifest: Manifest,
): Map<string, string[]> {
  const directories = designAnythingCorpusPaths(version)
  const sources = new Map<string, string[]>([[
    `${directories.scenarios}/${taskId}.json`,
    scenario.steps.flatMap(step => 'userMessage' in step ? [step.userMessage] : []),
  ]])
  const inputTexts = (scenario.setup.initialCanvas?.nodes ?? []).flatMap(node => {
    const config = node.type === 'text-prompt' ? node.data?.config : undefined
    const text = config && typeof config === 'object' && 'text' in config ? config.text : undefined
    return typeof text === 'string' ? [normalizeDocumentNewlines(text)] : []
  })
  const task = manifest.tasks.find(entry => entry.taskId === taskId)
  for (const asset of task?.assets ?? []) {
    if (asset.kind !== 'document') continue
    for (const document of expandAsset(taskId, asset)) {
      const relativeFile = `${directories.assets}/${taskId}/${document.file}`
      if (!isCanonicalRelativeFile(relativeFile)) continue
      const text = normalizeDocumentNewlines(readFileSync(path.resolve(repositoryRoot, relativeFile), 'utf8'))
      if (inputTexts.includes(text)) sources.set(relativeFile, [text])
    }
  }
  return sources
}

/** 可供 validateCorpus 导入；缺口默认只进 gaps，--require-full 才升级为阻断错误。 */
export function validateRequirementCoverage(options: RequirementCoverageOptions = {}): RequirementCoverageReport {
  const version = options.version ?? 'v0.4'
  const isDraft = options.mode === 'authoring-draft'
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd())
  const directories = designAnythingCorpusPaths(version)
  const report: RequirementCoverageReport = {
    status: 'invalid',
    scope: 'recorded-requirements-only; independent completeness review required',
    errors: [],
    gaps: [],
    counts: { tasks: 0, requirements: 0, full: 0, partial: 0, missing: 0, diagnostic: 0, manual: 0 },
  }
  const finish = (): RequirementCoverageReport => {
    if (report.wiring) report.wiring.status = report.errors.length === 0 && report.wiring.wired === report.wiring.total ? 'complete' : 'incomplete'
    if ((isDraft || options.requireWired) && report.wiring?.status !== 'complete') report.errors.push('Executable coverage required: one or more recorded requirements have no valid check binding')
    if (options.requireFull && report.gaps.length > 0) {
      report.errors.push(`Full coverage required: ${report.gaps.length} recorded requirements are not full`)
    }
    report.status = report.errors.length ? 'invalid' : report.gaps.length ? 'not-ready' : 'ready'
    return report
  }

  if (isDraft && version !== 'v0.6') {
    report.errors.push('authoring-draft coverage requires explicit v0.6')
    return finish()
  }
  if (!isDraft && version === 'v0.6') {
    report.errors.push('v0.6 version-corpus publication validation is not supported; select authoring-draft')
    return finish()
  }

  let ledger: RequirementCoverageLedger | DraftRequirementCoverageLedger
  let manifest: Manifest
  let scenarioIds: string[]
  let specIds: string[]
  try {
    const ledgerFile = path.resolve(repositoryRoot, options.ledgerFile ?? `${directories.root}/closure/requirements.json`)
    ledger = (isDraft ? draftRequirementCoverageSchema : requirementCoverageSchema).parse(JSON.parse(readFileSync(ledgerFile, 'utf8')))
    manifest = JSON.parse(readFileSync(path.resolve(repositoryRoot, directories.manifest), 'utf8')) as Manifest
    if (!Array.isArray(manifest.tasks)) throw new Error('Manifest tasks must be an array')
    if (manifest.tasks.some(task => !task || typeof task.taskId !== 'string' || task.taskId.trim() === '')) throw new Error('Manifest tasks must have nonempty task IDs')
    const idsIn = (directory: string) => readdirSync(path.resolve(repositoryRoot, directory), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => entry.name.slice(0, -5)).sort()
    scenarioIds = idsIn(directories.scenarios)
    specIds = idsIn(directories.tasks)
  } catch (error) {
    report.errors.push(`Cannot load requirement coverage inputs: ${message(error)}`)
    return finish()
  }

  if (ledger.benchmarkVersion !== version) report.errors.push(`Ledger benchmarkVersion ${ledger.benchmarkVersion} does not match ${version}`)
  if ('baselineVersion' in ledger && version === ledger.baselineVersion) report.errors.push('Ledger benchmarkVersion must differ from baselineVersion')
  if (!scenarioIds.length) report.errors.push('Scenario task set must be nonempty')
  const scenarioSet = new Set(scenarioIds)
  const specSet = new Set(specIds)
  const ledgerSet = new Set<string>()
  const manifestSet = new Set<string>()
  if (!manifest.tasks.length) report.errors.push('Manifest task set must be nonempty')
  for (const task of manifest.tasks) {
    if (manifestSet.has(task.taskId)) report.errors.push(`Duplicate manifest task: ${task.taskId}`)
    manifestSet.add(task.taskId)
  }
  for (const task of ledger.tasks) {
    if (ledgerSet.has(task.taskId)) report.errors.push(`Duplicate ledger task: ${task.taskId}`)
    ledgerSet.add(task.taskId)
  }
  for (const taskId of scenarioIds) {
    if (!specSet.has(taskId)) report.errors.push(`Missing TaskSpec task: ${taskId}`)
    if (!ledgerSet.has(taskId)) report.errors.push(`Missing ledger task: ${taskId}`)
    if (!manifestSet.has(taskId)) report.errors.push(`Missing manifest task: ${taskId}`)
  }
  for (const taskId of specIds) if (!scenarioSet.has(taskId)) report.errors.push(`TaskSpec task has no scenario: ${taskId}`)
  for (const taskId of ledgerSet) if (!scenarioSet.has(taskId) || !specSet.has(taskId)) report.errors.push(`Ledger task is outside the exact scenario/TaskSpec task set: ${taskId}`)
  for (const taskId of manifestSet) {
    if (!scenarioSet.has(taskId) || !specSet.has(taskId) || !ledgerSet.has(taskId)) report.errors.push(`Manifest task is outside the exact scenario/TaskSpec/ledger task set: ${taskId}`)
  }

  report.counts.tasks = ledger.tasks.length
  for (const task of ledger.tasks) {
    const prefix = task.taskId
    let references = new Map<string, boolean>()
    let sources = new Map<string, string[]>()
    let loadedSpec: TaskSpec | undefined
    if (scenarioSet.has(task.taskId) && specSet.has(task.taskId)) {
      try {
        const scenarioFile = path.resolve(repositoryRoot, directories.scenarios, `${task.taskId}.json`)
        const specFile = path.resolve(repositoryRoot, directories.tasks, `${task.taskId}.json`)
        if (sha256(scenarioFile) !== task.scenarioSha256) report.errors.push(`${prefix}: stale scenarioSha256`)
        if (sha256(specFile) !== task.specSha256) report.errors.push(`${prefix}: stale specSha256`)
        const scenario = parseScenario(JSON.parse(readFileSync(scenarioFile, 'utf8')))
        const spec = loadTaskSpec(specFile)
        loadedSpec = spec
        if (isDraft && spec.specVersion !== 3) report.errors.push(`${prefix}: authoring-draft requires TaskSpec v3`)
        if (scenario.id !== task.taskId || scenario.benchmarkVersion !== version) report.errors.push(`${prefix}: scenario identity/version mismatch`)
        if (spec.taskId !== task.taskId) report.errors.push(`${prefix}: TaskSpec identity mismatch`)
        references = ruleReferences(spec)
        sources = publicSources(repositoryRoot, version, task.taskId, scenario, manifest)
        if (spec.specVersion === 3) readPublicRequirementInputs(spec, version, repositoryRoot)
      } catch (error) {
        report.errors.push(`${prefix}: cannot validate task inputs: ${message(error)}`)
      }
    }
    const requirementIds = new Set<string>()
    for (const requirement of task.requirements) {
      const where = `${prefix}/${requirement.id}`
      report.counts.requirements += 1
      report.counts[requirement.coverage] += 1
      if (requirementIds.has(requirement.id)) report.errors.push(`${where}: duplicate requirement ID`)
      requirementIds.add(requirement.id)
      if (requirement.coverage !== 'full') {
        report.gaps.push({ taskId: task.taskId, requirementId: requirement.id, requirement: requirement.requirement, coverage: requirement.coverage, reason: requirement.reason })
      }
      if (!isCanonicalRelativeFile(requirement.sourceFile) || !sources.has(requirement.sourceFile)) {
        report.errors.push(`${where}: sourceFile is not this task's public scenario or attached text: ${requirement.sourceFile}`)
      } else if (!sources.get(requirement.sourceFile)?.some(text => text.includes(requirement.sourceQuote))) {
        report.errors.push(`${where}: sourceQuote does not occur verbatim in the public input`)
      }
      const seenReferences = new Set<string>()
      for (const reference of requirement.rules) {
        if (seenReferences.has(reference)) report.errors.push(`${where}: duplicate rule reference ${reference}`)
        seenReferences.add(reference)
        if (!references.has(reference)) report.errors.push(`${where}: invalid rule reference ${reference}`)
      }
      if (requirement.coverage === 'full' && !requirement.rules.some(reference => references.get(reference) === true)) {
        report.errors.push(`${where}: full coverage requires an active scoring rule; diagnostic-only, excluded, or statically unjudgeable rules are insufficient`)
      }
      if (version === 'v0.5' || loadedSpec?.specVersion === 3) {
        report.wiring ??= { status: 'incomplete', wired: 0, total: 0, automated: 0, manual: 0, diagnostic: 0 }
        report.wiring.total += 1
        const checks = loadedSpec?.requirementChecks?.filter(check => check.requirementId === requirement.id) ?? []
        if (!checks.length || checks.some(check => !requirement.rules.includes(`requirementChecks:${check.id}`))) report.errors.push(`${where}: every executable check must bind its own requirement and be listed in rules`)
        else {
          report.wiring.wired += 1
          if (checks.some(check => check.method === 'manual')) report.wiring.manual += 1
          else if (checks.every(check => check.method === 'diagnostic')) report.wiring.diagnostic += 1
          else report.wiring.automated += 1
        }
        if (requirement.rules.some(reference => reference.startsWith('requirementChecks:') && !checks.some(check => reference === `requirementChecks:${check.id}`))) report.errors.push(`${where}: check reference belongs to a different requirement`)
      }
    }
    for (const check of loadedSpec?.requirementChecks ?? []) if (!requirementIds.has(check.requirementId)) report.errors.push(`${prefix}: check ${check.id} references an unrecorded requirement ${check.requirementId}`)
  }
  return finish()
}

export function requirementCoverageExitCode(report: RequirementCoverageReport): 0 | 1 {
  return report.errors.length > 0 ? 1 : 0
}

function main(): void {
  const args = process.argv.slice(2)
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag)
    if (index < 0) return undefined
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a value`)
    return args[index + 1]
  }
  const mode = value('--mode')
  if (mode !== undefined && mode !== 'authoring-draft' && mode !== 'version-corpus') throw new Error('Unknown requirement coverage mode')
  const version = parseDesignAnythingBenchVersion(value('--version') ?? 'v0.4')
  const report = validateRequirementCoverage({ mode, version, repositoryRoot: value('--repository-root'), ledgerFile: value('--ledger'), requireFull: args.includes('--require-full'), requireWired: args.includes('--require-wired') })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = requirementCoverageExitCode(report)
}

const isScriptEntry = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module
  : Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isScriptEntry) {
  try { main() } catch (error) {
    console.error(message(error))
    process.exitCode = 1
  }
}
