/**
 * Revision-recovery scoring (#3176) — the two dependent variables of the revision track.
 *
 * The creation track can only ask "did the system build what was asked". The revision track asks
 * the question that push-digests, persistent checklists and obligation ledgers exist to answer:
 * **once the world changes underneath it, does the system notice and repair?**
 *
 * Two binary verdicts, judged on the frozen evaluator's own output — the same slot verdicts every
 * other column is built from. Nothing here reads the canvas; that rule does not bend for revision.
 *
 * ## Why binary and not a rate
 *
 * Within-arm variance on this bench measures 2.7× (`docs/lessons.md`,
 * `effect-size-must-be-compared-to-its-own-metrics-noise-floor`). A ratio has no resolving power
 * on that noise floor. The same argument produced the binary form of #3169 and #3172.
 *
 * ## Why `not-applicable` is mandatory rather than convenient
 *
 * Three distinct situations produce "we did not measure this", and every one of them reads as a
 * failure if collapsed into `no`:
 *
 * | source | recording it as `no` would mean |
 * |---|---|
 * | the pack carries no `mutations` (not a revision task) | every creation-track run "failed to recover" |
 * | the run is not a valid measurement (#3110) | a crashed run counts against the arm |
 * | every op reported `applied: false` | "we never broke anything" reads as "the arm never noticed" |
 *
 * The third is the one that bites: an op whose target the agent had already deleted lands as
 * `applied: false`, and there is then nothing to recover from.
 *
 * @module benchmarks/design-anything/tools/evaluator/revision
 */

import type { ConstraintVerdict, SlotVerdict } from './scoring'
import type { TaskSpec } from './taskSpec'

/** Recorded human injections, as they appear in the export manifest (`manifestVersion >= 10`). */
export interface RevisionMutationInput {
  stepId: string
  ops: Array<{ op: string; nodeId: string; channel: string; applied: boolean; reason: string }>
  expectedImpact: { mustReopen: string[]; mustPreserve: string[] }
}

/**
 * A binary verdict with its reason. Same three-state shape as {@link FalseCompletionVerdict}
 * (#3172) — deliberately, so a reader learns one convention rather than three.
 */
export interface RevisionVerdict {
  verdict: 'yes' | 'no' | 'not-applicable'
  /** Why it is this. "Why is this cell empty" must be answerable without reverse-engineering. */
  reason: string
  /** The slot ids this verdict was computed over (empty when not applicable). */
  slots: string[]
}

export interface RevisionScoringInput {
  /** `null` = the pack declares no revision track at all. */
  mutations: RevisionMutationInput[] | null
  /** Slot verdicts from the frozen evaluator — the same ones every other column is built on. */
  slots: readonly SlotVerdict[]
  /** Constraint verdicts, joined back to slots through the spec's `scope`. */
  constraints: readonly ConstraintVerdict[]
  /** Needed to map a constraint back to the slot(s) it is scoped to. */
  spec: Pick<TaskSpec, 'constraints'>
  /** Is this cell a valid measurement (#3110)? */
  measurementValid: boolean
}

/**
 * Is this slot **healthy** in the final state — delivered *and* meeting the constraints written
 * against it?
 *
 * Coverage alone is not enough, and that gap is not academic. Only `delete-node` removes an
 * artifact; `replace-output`, `replace-upstream-asset` and `edit-text-config` all leave the slot
 * covered. Judging on coverage alone would make three of the four ops **structurally incapable**
 * of discriminating between arms — every run reads `yes` whether or not the agent ever noticed.
 * A human swapping the spec sheet for the wrong image is caught here and nowhere else.
 *
 * Only constraints **explicitly scoped to this slot** count. A `scope: '*'` constraint failing
 * could have been caused by any artifact in the run, so charging it to this slot would attribute
 * damage we cannot locate.
 */
function slotIsHealthy(slotId: string, input: RevisionScoringInput): boolean {
  const verdict = input.slots.find((slot) => slot.slotId === slotId)
  // A named slot the pack has no verdict for is a broken fixture, not a pass.
  if (verdict === undefined || !verdict.covered) return false

  const scopedIds = new Set(
    input.spec.constraints
      .filter((constraint) => constraint.scope !== '*' && constraint.scope.slots.includes(slotId))
      .map((constraint) => constraint.id),
  )
  return input.constraints.every((constraint) =>
    !scopedIds.has(constraint.constraintId)
    || !constraint.scoring
    || constraint.verdict !== 'fail')
}

const NOT_A_REVISION_RUN = 'no mutations in the export pack: this run is not a revision-track run'
const MEASUREMENT_INVALID = 'measurement-invalid: this cell is not a valid measurement'

/**
 * Union across every mutate step, not one verdict per step.
 *
 * Two injections in one run are not two independent samples — they happen to the same agent in
 * the same session, and scoring them separately would let one run contribute two correlated
 * points to a Fisher table that assumes independence.
 */
function unionOf(
  mutations: readonly RevisionMutationInput[],
  pick: (mutation: RevisionMutationInput) => readonly string[],
): string[] {
  const union = new Set<string>()
  for (const mutation of mutations) for (const id of pick(mutation)) union.add(id)
  return [...union].sort()
}

/** Did any op actually change the world? If none did, there is nothing to recover from. */
function anyOpApplied(mutations: readonly RevisionMutationInput[]): boolean {
  return mutations.some((mutation) => mutation.ops.some((op) => op.applied))
}

/**
 * Was every slot the injection was expected to reopen satisfied again in the final state?
 *
 * "Satisfied" is {@link slotIsHealthy}: delivered **and** meeting the constraints scoped to it.
 * See that function for why coverage alone would make three of the four ops unable to discriminate.
 */
export function scoreRevisionSatisfied(input: RevisionScoringInput): RevisionVerdict {
  if (!input.measurementValid) {
    return { verdict: 'not-applicable', reason: MEASUREMENT_INVALID, slots: [] }
  }
  if (input.mutations === null) {
    return { verdict: 'not-applicable', reason: NOT_A_REVISION_RUN, slots: [] }
  }
  if (!anyOpApplied(input.mutations)) {
    return {
      verdict: 'not-applicable',
      reason: 'every injected op reported applied:false — nothing was broken, so nothing could be recovered',
      slots: [],
    }
  }
  const expected = unionOf(input.mutations, (mutation) => mutation.expectedImpact.mustReopen)
  if (expected.length === 0) {
    return {
      verdict: 'not-applicable',
      reason: 'the fixture declared no mustReopen slots — there is no claim to judge',
      slots: [],
    }
  }
  const unsatisfied = expected.filter((slotId) => !slotIsHealthy(slotId, input))
  return unsatisfied.length === 0
    ? {
        verdict: 'yes',
        reason: `all ${expected.length} affected slot(s) satisfied again in the final state`,
        slots: expected,
      }
    : {
        verdict: 'no',
        reason: `still unsatisfied after the injection: ${unsatisfied.join(', ')}`,
        slots: expected,
      }
}

/**
 * Did the repair leave everything it was not supposed to touch still healthy?
 *
 * The criterion is **still delivered and still meeting its constraints**, not **bytes unchanged**.
 * An agent legitimately allowed to redo an adjacent deliverable while repairing has not regressed
 * anything; demanding byte identity would score correct behaviour as a failure.
 */
export function scoreNonRegression(input: RevisionScoringInput): RevisionVerdict {
  if (!input.measurementValid) {
    return { verdict: 'not-applicable', reason: MEASUREMENT_INVALID, slots: [] }
  }
  if (input.mutations === null) {
    return { verdict: 'not-applicable', reason: NOT_A_REVISION_RUN, slots: [] }
  }
  if (!anyOpApplied(input.mutations)) {
    return {
      verdict: 'not-applicable',
      reason: 'every injected op reported applied:false — the run never entered a repair situation',
      slots: [],
    }
  }
  const preserved = unionOf(input.mutations, (mutation) => mutation.expectedImpact.mustPreserve)
  if (preserved.length === 0) {
    return {
      verdict: 'not-applicable',
      reason: 'the fixture declared no mustPreserve slots — there is no preservation surface to judge',
      slots: [],
    }
  }
  const regressed = preserved.filter((slotId) => !slotIsHealthy(slotId, input))
  return regressed.length === 0
    ? {
        verdict: 'yes',
        reason: `all ${preserved.length} preserved slot(s) still satisfied`,
        slots: preserved,
      }
    : {
        verdict: 'no',
        reason: `collateral damage on: ${regressed.join(', ')}`,
        slots: preserved,
      }
}

/**
 * One-sided Fisher exact test for a 2×2 table, in the direction "treatment > control".
 *
 * Computed, not concluded — whether `p < 0.05` counts as a result is fixed in the preregistration
 * document, not here. Exact rather than chi-square because the pilot's cells are single-digit,
 * where the asymptotic approximation is not trustworthy.
 *
 * Returns `null` when either arm contributed no judgeable cells: a table with an empty margin has
 * no p-value, and returning `1` would let "not measured" read as "measured, no effect".
 */
export function fisherOneSided(
  treatmentYes: number,
  treatmentNo: number,
  controlYes: number,
  controlNo: number,
): number | null {
  const treatmentTotal = treatmentYes + treatmentNo
  const controlTotal = controlYes + controlNo
  if (treatmentTotal === 0 || controlTotal === 0) return null

  const yesTotal = treatmentYes + controlYes
  const total = treatmentTotal + controlTotal
  if (yesTotal === 0 || yesTotal === total) return null

  // P(X >= observed) under the hypergeometric null, summed over the upper tail.
  let tail = 0
  const upperBound = Math.min(treatmentTotal, yesTotal)
  for (let k = treatmentYes; k <= upperBound; k++) {
    tail += hypergeometric(k, treatmentTotal, yesTotal, total)
  }
  // Floating-point summation can overshoot 1 by ~1e-16; a p-value above 1 is a nonsense reading.
  return Math.min(1, tail)
}

/** Hypergeometric point probability, via log-gamma so large factorials do not overflow. */
function hypergeometric(k: number, draws: number, successes: number, total: number): number {
  const failures = total - successes
  if (k > successes || draws - k > failures || k < 0) return 0
  return Math.exp(
    logChoose(successes, k) + logChoose(failures, draws - k) - logChoose(total, draws),
  )
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1)
}

/** Lanczos approximation. Exact enough for the counts a pilot produces (n < 100). */
function logGamma(x: number): number {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let series = 1.000000000190015
  for (const coefficient of coefficients) series += coefficient / ++y
  return -tmp + Math.log((2.5066282746310005 * series) / x)
}
