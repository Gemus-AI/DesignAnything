/**
 * M3 设计质量判定（#3443，指南 §2.4）。
 *
 * 每张交付图由**另一家族**的冻结评审模型单独看一遍，按 `dq-v1` 清单逐条打 0/1/2/N-A；
 * 一件的分 = L3 条目 → 按 L2 桶取均值 → 组均值（Detail 的三条不占 Quality 一半）；
 * 一次 run 的分 = **先槽内均值、再跨 core 槽均值**（`expected: 3` 的槽不因件多而权重放大）。
 * 四组分开报（Quality / Aesthetics / Text Rendering / Design Applications），不合并成一个总分；
 * Quality 组按指南 `:169` **只报不主张**。
 *
 * ## 与 `setRubric.ts` 同结构：判定与调用分离
 *
 * {@link planDesignQuality}（选件）、{@link scoreDesignQualityArtifact}（回复 → 一件读数）、
 * {@link scoreDesignQuality}（件 → run）是纯函数；{@link judgeDesignQuality} 只负责调用。
 *
 * ## 三个不打分的出口（reason 逐条写明）
 *
 * 1. 题声明了 `dqRubric` 但清单判不了（信息设计方向待 VisJudge）→ run 级 `not-applicable`。
 * 2. 结构判据面（`--evidence prompt`）→ run 级 `not-applicable`：那条面上的产物是占位图。
 * 3. 某一件调用失败 / 回复不合契约 → 这一件 `unscored`，不重试（与 `setRubric.ts` 同纪律），
 *    进 `needsManualCheck`；其它件照打。
 *
 * ## 渲染器产出件
 *
 * 外部臂的 HTML deck 页由**导入器**渲染成位图、矢量件由导入器栅格化（#3397 / #3406）：噪点、边缘清晰度、
 * 分辨率三条量的是我们渲染器的属性，不是对手的设计 —— 这三条对这些件强制 N/A（白名单，不是整份清单 N/A：
 * Naturalness 判的是「AI 生成图的塑料感」，渲染件照打）。识别只用导出包的文件身份（`deckPages.ts` 的
 * `isImporterRenderedPage` + manifest 的 `rasterizedVectors`），不重建导入器的命名规则。
 * 它同时是跨臂样本构成的读数：`sampleComposition.rendererProduced`。
 *
 * ## 跨臂对称 / 隔离铁律
 *
 * 只读导出包正件（`SlotVerdict.delivered` 里的 `image/*`），不读 `sourceNodes`、不读画布。
 * 本判据属于冻结 benchmark evaluator，运行时机制禁止复用（备忘录 §7.14）。
 *
 * @module benchmarks/design-anything/tools/evaluator/designQuality
 */
import path from 'path'

import type { RunExportManifest } from '../exportRunArtifacts'
import type { ExternalRunExportManifest } from '../importExternalRun'
import { isImporterRenderedPage } from './deckPages'
import type { ArtifactStratum } from './stratum'
import type { DqChecklistItem, DqGroup } from './dqChecklist'
import { renderDqPrompt } from './prompts'
import { RubricReplyError, aggregateRubric, parseRubricReply, type RubricItemVerdict } from './rubric'
import { imageSlots, type ScoredArtifact, type SlotVerdict } from './scoring'
import { slotIsCore, type DqRubricSpec, type SlotStage, type TaskSpec } from './taskSpec'
import { DQ_JUDGE_MODEL_ID, VlmUnreadableError, askVlm } from './vlm'

export const DQ_GROUPS: readonly DqGroup[] = ['quality', 'aesthetics', 'text', 'domain']

/** 渲染器产出件上强制 N/A 的条目（白名单）：这三条量的是渲染器，不是设计。 */
export const RENDERER_NA_ITEMS: readonly string[] = ['quality.detail.noise', 'quality.detail.edge-clarity', 'quality.resolution']

/** 评估器能读的 manifest：Gemus 导出包 + 外部臂导入包（后者多一段 `externalImport`） */
export type EvaluationManifest = RunExportManifest & Partial<Pick<ExternalRunExportManifest, 'externalImport'>>

/**
 * 导出包里哪些产物文件是**导入器**渲染 / 栅格化出来的（按 `artifacts/` 下的文件名）。
 * 渲染页按 `deckPages.ts` 的父目录判据；栅格件按 manifest `rasterizedVectors[].raster`（相对路径）
 * 与件 key（`external:<arm>/<relPath>`）精确对应 —— 不重建导入器的命名规则。
 */
export function rendererProducedFiles(manifest: EvaluationManifest): Set<string> {
  const rendered = new Set(manifest.files.filter(isImporterRenderedPage).map((file) => file.file))
  const arm = manifest.externalImport?.arm
  for (const raster of manifest.externalImport?.rasterizedVectors ?? []) {
    const match = manifest.files.find((file) => file.key === `external:${arm}/${raster.raster}`)
    if (match !== undefined) rendered.add(match.file)
  }
  return rendered
}

export interface DqTarget {
  file: string
  contentType: string
  slotId: string
  slotLabel: string
  isCore: boolean
  stage: SlotStage | undefined
  rendererProduced: boolean
  /**
   * 这一件属于哪一层（#3531）——**纯诊断字段，不参与打分**。
   *
   * 这一列的汇总值同样跨臂不可比，方向与色板相反：模型生成件的均分 Gemus 90.6 /
   * OpenDesign 93.8，而汇总值是 Gemus 93.5 / OpenDesign 86.5 —— 对方的汇总分被它自己
   * 154 件 deck 页（均分 83.0）拖低。逐件落层，报表才能在层内给名次。
   *
   * `undefined` = 该包评估于本字段存在之前，**不等于**「没有层」。
   */
  stratum?: ArtifactStratum
}

/** 选件（纯函数）。作用面 = `rubric.slots ?? 全部图像槽` 的交付集里的 `image/*` 件，spec 槽序。 */
export function planDesignQuality(
  spec: TaskSpec,
  rubric: Pick<DqRubricSpec, 'slots'>,
  slots: readonly SlotVerdict[],
  artifacts: readonly ScoredArtifact[],
  rendered: ReadonlySet<string>,
  /** 文件名 → 层（#3531，`stratum.artifactStrata` 的产物）。缺省 = 逐件不落层字段 */
  strata?: ReadonlyMap<string, ArtifactStratum>,
): DqTarget[] {
  const scope = new Set(rubric.slots ?? imageSlots(spec).map((slot) => slot.id))
  const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
  return spec.slots
    .filter((slot) => scope.has(slot.id))
    .flatMap((slot) => {
      const verdict = slots.find((item) => item.slotId === slot.id)
      return (verdict?.delivered ?? []).flatMap((file) => {
        const artifact = byFile.get(file)
        if (artifact === undefined || !artifact.contentType.startsWith('image/')) return []
        return [{
          file,
          contentType: artifact.contentType,
          slotId: slot.id,
          slotLabel: slot.label,
          isCore: slotIsCore(slot),
          stage: slot.stage,
          rendererProduced: rendered.has(file),
          ...(strata?.get(file) !== undefined ? { stratum: strata.get(file) } : {}),
        }]
      })
    })
}

export type DqGroupScores = Record<DqGroup, number | null>

/** 一条条目判定 + 它在清单里的身份：`evaluation.json` 自描述，标注 CSV 的键与按组校准不必回头查清单 */
export type DqItemVerdict = RubricItemVerdict & { id: string; group: DqGroup }

export interface DqArtifactVerdict extends DqTarget {
  verdict: 'scored' | 'unscored'
  reason: string
  items: DqItemVerdict[]
  /** 一件的四组分：L3 → L2 桶均值 → 组均值；某组全 N/A → null */
  groups: DqGroupScores
}

/** 一组条目 → 两级均值：先按 `l2` 分桶（每桶 `aggregateRubric`），再对有分的桶取均值。 */
function groupMean(items: readonly DqChecklistItem[], verdicts: readonly RubricItemVerdict[], group: DqGroup): number | null {
  const byWording = new Map(verdicts.map((verdict) => [verdict.item, verdict]))
  const buckets = new Map<string, RubricItemVerdict[]>()
  for (const item of items) {
    if (item.group !== group) continue
    const verdict = byWording.get(item.wording)
    if (verdict === undefined) continue
    const bucket = buckets.get(item.l2) ?? []
    bucket.push(verdict)
    buckets.set(item.l2, bucket)
  }
  const means = [...buckets.values()].map((bucket) => aggregateRubric(bucket).mapped0to100).filter((value): value is number => value !== null)
  return means.length === 0 ? null : means.reduce((sum, value) => sum + value, 0) / means.length
}

function meanOrNull(values: readonly (number | null)[]): number | null {
  const scored = values.filter((value): value is number => value !== null)
  return scored.length === 0 ? null : scored.reduce((sum, value) => sum + value, 0) / scored.length
}

/**
 * 回复 → 一件的读数（纯函数）。`parsed === null` 时 `failure` 必须说明是哪一种判不出来。
 * 渲染器产出件：白名单三条强制 N/A，原回复的分与理由记在 reason 里而不是丢掉。
 */
export function scoreDesignQualityArtifact(
  target: DqTarget,
  checklist: readonly DqChecklistItem[],
  parsed: readonly RubricItemVerdict[] | null,
  failure?: string,
): DqArtifactVerdict {
  const empty: DqGroupScores = { quality: null, aesthetics: null, text: null, domain: null }
  if (parsed === null) {
    return { ...target, verdict: 'unscored', reason: failure ?? 'no reply', items: [], groups: empty }
  }
  const byWording = new Map(checklist.map((item) => [item.wording, item]))
  const items: DqItemVerdict[] = parsed.map((verdict) => {
    const item = byWording.get(verdict.item)
    if (item === undefined) throw new RubricReplyError(`reply scored an item that is not on the checklist: ${JSON.stringify(verdict.item)}`)
    const tagged = { ...verdict, id: item.id, group: item.group }
    if (target.rendererProduced && RENDERER_NA_ITEMS.includes(item.id) && verdict.score !== 'n/a') {
      return { ...tagged, score: 'n/a' as const, reason: `forced n/a: renderer-produced file, this item measures the importer's renderer (judge said ${verdict.score}: ${verdict.reason})` }
    }
    return tagged
  })
  const groups = Object.fromEntries(DQ_GROUPS.map((group) => [group, groupMean(checklist, items, group)])) as DqGroupScores
  const applicable = items.filter((item) => item.score !== 'n/a').length
  return {
    ...target,
    verdict: 'scored',
    reason: `${applicable}/${items.length} item(s) scored${target.rendererProduced ? ` (renderer-produced: ${RENDERER_NA_ITEMS.length} renderer items forced n/a)` : ''}`,
    items,
    groups,
  }
}

export interface DesignQualityScore {
  verdict: 'scored'
  checklistVersion: string
  /** run 级四组分：先槽内均值、再跨 core 槽均值；某组无可判件 → null */
  groups: DqGroupScores
  artifactsScored: number
  artifactsUnscored: number
  artifacts: DqArtifactVerdict[]
  /** 跨臂样本构成：打了分的件里几件是渲染器产出、几件是 process / final 槽 */
  sampleComposition: { scored: number; rendererProduced: number; byStage: { process: number; final: number } }
}

/** run 级不判的两个来源必须分得开：报表上「待 VisJudge」只给前者，结构判据面是「未判」 */
export type DesignQualityNotApplicableKind = 'visjudge-pending' | 'structural-surface'

export interface DesignQualityNotApplicable {
  verdict: 'not-applicable'
  kind: DesignQualityNotApplicableKind
  checklistVersion: string
  reason: string
}

/**
 * **这一轮评估根本没跑 M3**（#3765）—— 不是「判了没读数」，也不是「这道题不适用」。
 *
 * 单图设计质量现在有第二条路：直接跑上游 Qwen-Image-Bench（指南 §2.4 第 2 步的方案 B，
 * 操作见 `docs/operations/qjudger-gpu-runbook.md`）。跑那条路的时候本评估器这一把不该再花钱，
 * 所以 `bench:evaluate` 有了 `--dq` 开关，**缺省不跑**。
 *
 * 为什么要专门一个 verdict 而不是写 `null`：`null` 已经有一个意思了 ——「这道题没声明
 * `dqRubric`」。两件事混成同一个值，报表上就分不出「这道题不打设计质量分」和「这一批我们
 * 压根没打」。本仓库反复栽在同一个形状上（#3677 的 `unmeasurable`、#3593 的 `unscored`）。
 */
export interface DesignQualityNotRun {
  verdict: 'not-run'
  reason: string
}

export type DesignQualityResult = DesignQualityScore | DesignQualityNotApplicable | DesignQualityNotRun

/** run 级读数的唯一读法：`evaluate.ts` 的 tally 与 `compareArms.ts` 的 cell 都调它（#3380 / #3441 同纪律） */
export interface DesignQualitySummary {
  groups: DqGroupScores
  artifactsScored: number
  artifactsUnscored: number
  rendererProduced: number
  /** 这道题声明了 dqRubric 但清单判不了（VisJudge 待接） */
  excluded: boolean
  /** 这一轮评估没开 `--dq`，M3 一次都没判（#3765）。与 `excluded` 是两件事 */
  notRun: boolean
}

export function summarizeDesignQuality(result: DesignQualityResult | null | undefined): DesignQualitySummary {
  const scored = result?.verdict === 'scored' ? result : null
  return {
    groups: scored?.groups ?? { quality: null, aesthetics: null, text: null, domain: null },
    artifactsScored: scored?.artifactsScored ?? 0,
    artifactsUnscored: scored?.artifactsUnscored ?? 0,
    rendererProduced: scored?.sampleComposition.rendererProduced ?? 0,
    excluded: result?.verdict === 'not-applicable' && result.kind === 'visjudge-pending',
    notRun: result?.verdict === 'not-run',
  }
}

/**
 * `score.designQuality` 的四态在报表上各印各的字。CSV 的 `dqStatus` 列就是这个值，
 * 它让那 7 个 dq 数值列**空得有理由** —— 空列本身读不出是哪一种空。
 */
export function designQualityStatus(result: DesignQualityResult | null | undefined): 'scored' | 'not-applicable' | 'not-run' | 'undeclared' {
  return result === null || result === undefined ? 'undeclared' : result.verdict
}

/** 件 → run（纯函数）。只有 core 槽进 run 级均值；非 core 槽的件仍逐件记录。 */
export function scoreDesignQuality(checklistVersion: string, verdicts: readonly DqArtifactVerdict[]): DesignQualityScore {
  const scored = verdicts.filter((verdict) => verdict.verdict === 'scored')
  const coreSlots = [...new Set(scored.filter((verdict) => verdict.isCore).map((verdict) => verdict.slotId))]
  const groups = Object.fromEntries(DQ_GROUPS.map((group) => {
    // 槽内先取均值（同槽多件不放大权重），再跨 core 槽取均值
    const perSlot = coreSlots.map((slotId) => meanOrNull(scored.filter((verdict) => verdict.slotId === slotId).map((verdict) => verdict.groups[group])))
    return [group, meanOrNull(perSlot)]
  })) as DqGroupScores
  return {
    verdict: 'scored',
    checklistVersion,
    groups,
    artifactsScored: scored.length,
    artifactsUnscored: verdicts.length - scored.length,
    artifacts: [...verdicts],
    sampleComposition: {
      scored: scored.length,
      rendererProduced: scored.filter((verdict) => verdict.rendererProduced).length,
      byStage: {
        process: scored.filter((verdict) => verdict.stage === 'process').length,
        final: scored.filter((verdict) => verdict.stage === 'final').length,
      },
    },
  }
}

/** 真正的调用：每件一次 `askVlm({ modelId: DQ_JUDGE_MODEL_ID })`。`ask` 可注入，测试用它驱动失败路径。 */
export async function judgeDesignQuality(input: {
  spec: TaskSpec
  rubric: DqRubricSpec
  checklist: readonly DqChecklistItem[]
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  /** 产物文件名 → 磁盘绝对路径 */
  artifactsDir: string
  cacheDir?: string | undefined
  /** 非 pixel 证据面上不判 —— 那条面上产物是占位图 */
  evidenceSurface: 'pixel' | 'prompt'
  /** 导入器渲染 / 栅格化出的文件名（`rendererProducedFiles`） */
  rendered: ReadonlySet<string>
  /** 文件名 → 层（#3531，`stratum.artifactStrata`）。诊断输入，不影响任何分数 */
  strata?: ReadonlyMap<string, ArtifactStratum>
  ask?: (image: { path: string; contentType: string }, prompt: { text: string; cacheSha: string }) => Promise<unknown>
}): Promise<DesignQualityResult> {
  if (input.evidenceSurface !== 'pixel') {
    return { verdict: 'not-applicable', kind: 'structural-surface', checklistVersion: input.rubric.checklistVersion, reason: 'structural evidence surface carries placeholder imagery — design quality cannot be judged from it' }
  }
  const targets = planDesignQuality(input.spec, input.rubric, input.slots, input.artifacts, input.rendered, input.strata)
  const wordings = input.checklist.map((item) => item.wording)
  const promptItems = input.checklist.map((item) => ({ wording: item.wording, naHint: item.naHint, judgeHint: item.judgeHint }))
  const ask = input.ask ?? ((image, rendered) => askVlm<unknown>({
    imagePath: image.path, contentType: image.contentType, prompt: rendered.text, promptSha: rendered.cacheSha, cacheDir: input.cacheDir, modelId: DQ_JUDGE_MODEL_ID,
  }))
  const verdicts: DqArtifactVerdict[] = []
  for (const target of targets) {
    const prompt = renderDqPrompt(promptItems, target.slotLabel, input.rubric.naRules)
    try {
      const reply = await ask({ path: path.join(input.artifactsDir, target.file), contentType: target.contentType }, prompt)
      verdicts.push(scoreDesignQualityArtifact(target, input.checklist, parseRubricReply(wordings, reply)))
    } catch (error) {
      if (error instanceof VlmUnreadableError) verdicts.push(scoreDesignQualityArtifact(target, input.checklist, null, `design-quality call failed after retry — ${error.message}`))
      else if (error instanceof RubricReplyError) verdicts.push(scoreDesignQualityArtifact(target, input.checklist, null, `design-quality reply failed the item contract — ${error.message}`))
      else throw error
    }
  }
  return scoreDesignQuality(input.rubric.checklistVersion, verdicts)
}
