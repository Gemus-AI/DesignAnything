/** 原件未变化时离线导入人工审核；不调用模型，不改旧 M1/M2/M3 读数。 */
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { pathToFileURL } from 'url'

import { applyRequirementManualReviews, type RequirementCheckResult, type RequirementEvidenceBinding } from './evaluator/requirementChecks'
import { loadTaskSpec } from './evaluator/taskSpec'
import type { RequirementCheck } from './evaluator/requirementSpec'

const hash = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 原始字节必须位于显式根目录；拒绝相对路径和符号链接逃逸。 */
function resolveEvidence(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`Unsafe evidence path: ${relative}`)
  const file = fs.realpathSync(path.resolve(root, relative))
  const rel = path.relative(fs.realpathSync(root), file)
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) throw new Error(`Evidence path escapes its root: ${relative}`)
  return file
}

export function reviewRequirements(options: { evaluationFile: string; reviewsFile: string; specFile: string; repoRoot: string }): RequirementCheckResult {
  const evaluationFile = fs.realpathSync(options.evaluationFile)
  const runDir = path.dirname(evaluationFile)
  const evaluation = JSON.parse(fs.readFileSync(evaluationFile, 'utf-8')) as { requirements?: RequirementCheckResult; [key: string]: unknown }
  const previous = evaluation.requirements
  if (!previous || !Array.isArray(previous.checks)) throw new Error('Evaluation has no requirement-check results')
  const specSha = hash(options.specFile)
  if (specSha !== previous.specSha) throw new Error('TaskSpec changed after evaluation; reevaluate first')
  if (!previous.manifestSha || hash(path.join(runDir, 'manifest.json')) !== previous.manifestSha) throw new Error('Run manifest changed or was not bound; reevaluate first')
  const spec = loadTaskSpec(options.specFile) as ReturnType<typeof loadTaskSpec> & { requirementChecks?: RequirementCheck[] }
  const currentChecks = spec.requirementChecks
  if (!currentChecks || currentChecks.length !== previous.checks.length) throw new Error('TaskSpec requirement checks do not match the evaluation')
  const bindings = new Map<string, RequirementEvidenceBinding>()
  for (const check of previous.checks) {
    const descriptor = currentChecks.find((item) => item.id === check.checkId)
    if (!descriptor || JSON.stringify(descriptor) !== JSON.stringify(check.binding.check)) throw new Error(`Requirement descriptor changed: ${check.checkId}`)
    const current: RequirementEvidenceBinding = { ...check.binding, specSha, manifestSha: previous.manifestSha, check: descriptor,
      artifacts: check.binding.artifacts.map((artifact) => ({ ...artifact, sha256: hash(resolveEvidence(path.join(runDir, 'artifacts'), artifact.file)) })),
      dependencies: check.binding.dependencies.map((dependency) => ({ file: dependency.file, sha256: hash(resolveEvidence(runDir, dependency.file)) })),
      inputs: check.binding.inputs.map((input) => ({ file: input.file, sha256: hash(resolveEvidence(options.repoRoot, input.file)) })) }
    bindings.set(check.checkId, current)
  }
  const reviews: unknown = JSON.parse(fs.readFileSync(options.reviewsFile, 'utf-8'))
  if (!Array.isArray(reviews) || !reviews.length) throw new Error('Reviews must be a nonempty JSON array')
  const result = applyRequirementManualReviews(previous, reviews, bindings)
  evaluation.requirements = result
  // 同目录临时文件再替换，校验失败不改已有评估；保留调用者提供的人工文件作为审计输入。
  const temporary = `${evaluationFile}.requirements-${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(evaluation, null, 2)}\n`, 'utf-8')
  fs.renameSync(temporary, evaluationFile)
  fs.writeFileSync(path.join(runDir, 'requirement-review-queue.json'), `${JSON.stringify(result.pendingManual, null, 2)}\n`, 'utf-8')
  return result
}

function main(): void {
  const args = process.argv.slice(2)
  const read = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }
  const evaluationFile = read('--evaluation'), reviewsFile = read('--reviews'), specFile = read('--spec')
  if (!evaluationFile || !reviewsFile || !specFile) throw new Error('Usage: pnpm exec tsx benchmarks/design-anything/tools/reviewRequirements.ts --evaluation <run/evaluation.json> --reviews <reviewed-array.json> --spec <task.json> [--repo <repository-root>]')
  const result = reviewRequirements({ evaluationFile, reviewsFile, specFile, repoRoot: read('--repo') ?? process.cwd() })
  console.log(JSON.stringify({ eligible: result.eligible, allRequiredSatisfied: result.allRequiredSatisfied, counts: result.counts }, null, 2))
}

const isScriptEntrypoint = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module
  : Boolean(process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)

if (isScriptEntrypoint) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
