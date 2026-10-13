/**
 * M2 第二层：整套成果的视觉一致性条目判定（#3441，指南 §2.3）。
 *
 * 「整套像不像同一套视觉语言」是**集合性质**：字体统一、版式系统统一、风格语言统一，
 * 双图看不到「第三张用了另一套字」。所以一条规则 = 一次多图调用（复用 #3407 的 `askSetVlm`），
 * 条目措辞由 spec 冻结（`SetVlmRubricRule.items`，改一个字就是换一把尺子），逐条 0/1/2/N-A。
 *
 * ## 与 `identity.ts` 同结构：判定与调用分离
 *
 * {@link planSetRubric}（选图、排序、截断）与 {@link scoreSetRubric}（回复 → 规则级读数）是纯函数，
 * {@link judgeSetRubric} 只负责真正的调用。一批读数出了争议时，拿缓存里的回复重跑纯函数就能逐条复核。
 *
 * ## not-applicable 的三个来源（reason 逐条写明，不折叠）
 *
 * 1. 作用面内可判图 < 2 —— 一张图构不成「整套」。**缺件是 M1 的事，这里不记 0**：
 *    指南 §2.3 末段「避免同一缺失扣两次」，#3380 实测过把缺件折进一致性 verdict 会让臂间差别读不出来。
 * 2. 调用失败 / 回复不可解析 / 语义校验失败（缺条目、越界分）—— 这一次判不出来，不重试
 *    （`runEvaluatorCall` 只对 JSON 语法错重试一次；语义错误从第一次解析起就收敛，同 `toPairVerdict`）。
 * 3. 结构判据面（`--evidence prompt`）—— 那条面上产物是占位图。
 *
 * ## 跨臂对称
 *
 * 只读导出包正件（`SlotVerdict.delivered` 里的 `image/*` 件），不读 `sourceNodes`、不读画布。
 * 外部臂的 HTML deck 已被导入器逐页渲染成图、无孪生 SVG 已被栅格化（#3397 / #3406），到这里都是位图。
 * **已知不对称**：Gemus 的 deck 是文本投影、不进图像作用面，而外部臂的 deck 页（导入器渲染的、或自带的逐页位图）
 * 会被图像分类器归进**别的图像槽**（da 题的 deck 槽全是纯文档槽）从而进作用面 ——
 * {@link SetRubricPlan.deckImages} 按 `deckPages.ts` 的文件判据把它量化出来，compareArms 据此在报表上打 ⚠️；本 issue 不修它。
 *
 * ## 隔离铁律
 *
 * 本判据属于**冻结 benchmark evaluator**。运行时机制禁止复用本模块与 `SET_RUBRIC_PROMPT_SHA`：
 * 系统用同一把尺子既指导自己修复、又证明自己修好了，就是自证循环（备忘录 §7.14）。
 *
 * @module benchmarks/design-anything/tools/evaluator/setRubric
 */
import path from 'path'
import { promptSha, renderSetRubricPrompt, renderSourceSetRubricPrompt } from './prompts'
import { RubricReplyError, aggregateRubric, parseRubricReply, type RubricAggregate, type RubricItemVerdict } from './rubric'
import { imageSlots, type ScoredArtifact, type SlotVerdict } from './scoring'
import { setVlmItemKinds, setVlmItemTexts, type SetVlmItemKind, type SetVlmRubricRule, type TaskSpec } from './taskSpec'
import { VlmUnreadableError, askSetVlm } from './vlm'

/**
 * 单次请求最多放几张图。与 `redistribute.ts` 的 `MAX_REDISTRIBUTION_CANDIDATES` 同量级（#3407 决定 #4）。
 * 超限按比例分配名额（见 {@link planSetRubric}），不是悬崖式砍到每槽一张。
 */
export const SET_RUBRIC_MAX_IMAGES = 12
/**
 * 来源文本完整发送；超预算明确不可判，**不截断、不让摘要改写规范**。
 *
 * 那条纪律是本常量存在的理由：判据是从源文档推出来的，截掉一半等于让判官照着一份被删过的
 * 规范打分，它会把本该 fail 的条目判 pass。宁可不判，也不能判一份假规范。
 *
 * **数值按判官的上下文定，不是拍脑袋**（#3811）。判官是 `openai/gpt-5.6-luna`
 * （`vlm.ts` 的 `EVALUATOR_MODEL_ID`）；12 万字约 3 万 token，加 {@link SET_RUBRIC_MAX_IMAGES}
 * 张图与判据清单仍有充裕余量。此前是 24_000 —— 那个数没有任何依据，实测把 12 条规则挡在门外
 * （最长一条 66_957 字），而**挡掉的恰好是写得最长的那一臂**：源文本越长越不会被测，
 * 是一条奖励啰嗦的规则。
 */
export const SET_RUBRIC_MAX_SOURCE_TEXT_CHARS = 120_000

/**
 * 「这一条没测出来」的成因（#3811）。**归被测系统还是归尺子，是两个相反的结论**，
 * 从前它们压成同一个 `not-applicable`，报表只数条数、不看 reason。
 *
 * 写成 const 数组再派生类型（#3817）：遍历式门禁要逐个取值验「归得出 system / ruler」，
 * 而纯类型在运行期什么都不剩。给类型加一档却不登记，`undecidedExits.test.ts` 会红。
 */
export const SET_RUBRIC_UNAVAILABLE_CAUSES = [
  /** 系统：来源槽一件没交 */
  'source-slot-empty',
  /** 系统：来源槽交了，但那一件读不出文字（转写失败 / 无可读文本） */
  'source-slot-unreadable',
  /** 系统：目标槽一张图都没交 —— 沿用既有裁定，缺件是 M1 的读数，这里只退出分母 */
  'no-target-image',
  /** 系统：作用面不足两张图 —— 一张图构不成「一套」，同上只退出分母 */
  'insufficient-images',
  /** 尺子：来源文本超出 {@link SET_RUBRIC_MAX_SOURCE_TEXT_CHARS} */
  'source-text-over-budget',
  /** 尺子：目标件不是可读的图像证据 */
  'target-not-image',
  /** 尺子：图数超出 {@link SET_RUBRIC_MAX_IMAGES} */
  'image-budget',
  /** 尺子：判官调用失败 / 回复不合契约 / 无回复 */
  'judge-failed',
  /** 尺子：结构判据面上产物是占位图，或来源根本没进计划 */
  'not-planned',
] as const
export type SetRubricUnavailableCause = typeof SET_RUBRIC_UNAVAILABLE_CAUSES[number]

/** 成因归谁。报表的「规则损耗」按这个拆成两半（#3811）。 */
export function setRubricCauseOwner(cause: SetRubricUnavailableCause): 'system' | 'ruler' {
  return cause === 'source-slot-empty' || cause === 'source-slot-unreadable'
    || cause === 'no-target-image' || cause === 'insufficient-images' ? 'system' : 'ruler'
}

export interface SetRubricImage {
  file: string
  slotId: string
  contentType: string
  /** 仅 v2 来源规则出现；旧计划对象不补字段。 */
  role?: 'source' | 'target'
}

export interface SetRubricSourceEvidence {
  slotId: string
  file: string | null
  contentType: string | null
  textSha: string | null
  textChars: number
  imageNumber: number | null
  status: 'ready' | 'missing' | 'unreadable'
  reason: string | null
}

export interface SetRubricSource extends SetRubricSourceEvidence {
  /** 只在调用计划保留原文；结果中的元数据通过 textSha 绑定 artifacts.textLines。 */
  text: string
}

export interface SetRubricPlan {
  /** 旧规则按 spec 槽序 → 交付集顺序；v2 先按 sourceSlots 放来源图，再放同序目标图。图序进入缓存键。 */
  images: SetRubricImage[]
  /** 因图数上限被剔除的件（记账，让「没看这几张」可核对） */
  truncated: string[]
  /**
   * `images` 里是 deck 页的图数 —— 跨臂不对称的读数。两个判据取并集：文件本身是外部臂 deck 的一页
   * （`isDeckPageFile`，由 evaluate.ts 从 manifest 算出传入），或它交付进了声明 `minPages` 的槽。
   */
  deckImages: number
  sources?: SetRubricSource[]
  /** 来源规则必须完整取得声明的来源及已交目标，不能悄悄退回旧模式。 */
  unavailable?: string
  /** `unavailable` 的归属（#3811）。与它同生同灭：有一个就有另一个。 */
  unavailableCause?: SetRubricUnavailableCause
  missingTargetSlots?: string[]
  unsupportedTargetFiles?: string[]
}

/**
 * 逐条读数 + 这一条的职责（#3552）。旧题包的裸字符串条目没有 `kind` —— 缺席是「作者没声明」，
 * 不是「不属于任何一组」，所以它落进 `byKind.unlabelled` 而不是被算进 consistency。
 */
export interface SetVlmItemVerdict extends RubricItemVerdict {
  kind?: SetVlmItemKind
}

export interface SetVlmRubricVerdict {
  ruleId: string
  /**
   * `judged` = 判官真的跑过。`not-applicable` = 退出分母，尺子够不着或真的没有可看的东西。
   * `unmet` 只出现在 v1.12–v1.17 写下的旧记录里（来源槽空记 0 进分母，#3811）；
   * v1.18（#3952）起不再产生，留在类型里是为了旧记录还读得进来。
   */
  verdict: 'judged' | 'not-applicable' | 'unmet'
  /** 判定依据 / 没判成的具体来源 */
  reason: string
  /** 没判成时的成因归属（#3811）。`judged` 时不出现。 */
  unavailableCause?: SetRubricUnavailableCause
  images: SetRubricImage[]
  truncated: string[]
  deckImages: number
  items: SetVlmItemVerdict[]
  /** 打了分（非 N/A）的条目数 */
  applicable: number
  mean0to2: number | null
  mapped0to100: number | null
  /**
   * 按条目职责分组的读数（#3552）。**M2 只读 `consistency` 那一组。**
   *
   * `mapped0to100` 是全部条目一起算的那个数，留着是为了与旧读数对齐口径 —— 它把
   * 「几件产物是不是同一套」和「某一件照没照简报做」混在一起，
   * **不得单独当作 M2 的一致性读数**。`unlabelled` 是旧题包（裸字符串条目）落进来的地方。
   */
  byKind?: Record<SetVlmItemKind | 'unlabelled', RubricAggregate>
  sourceEvidence?: SetRubricSourceEvidence[]
  missingTargetSlots?: string[]
  unsupportedTargetFiles?: string[]
}

/**
 * 比例截断：每个有图的槽至少留 1 张，余下名额按各槽超出 1 张的部分按比例分配（最大余数法），
 * 每槽取**靠后**的件（最后一件是系统收敛到的那一件，#3113 顺序契约）。
 * 有图的槽数本身超过上限 → 抛错：这不是「图太多」而是「题的形状放不进一次调用」，测试钉住。
 */
function allocate(perSlot: ReadonlyArray<{ slotId: string; files: SetRubricImage[] }>, cap: number): { kept: SetRubricImage[]; truncated: string[] } {
  const withImages = perSlot.filter((slot) => slot.files.length > 0)
  const total = withImages.reduce((sum, slot) => sum + slot.files.length, 0)
  if (total <= cap) return { kept: withImages.flatMap((slot) => slot.files), truncated: [] }
  if (withImages.length > cap) {
    throw new Error(`setVlmRubric: ${withImages.length} slots carry images but the per-request cap is ${cap} — the rule's slot scope does not fit one call`)
  }
  const spare = cap - withImages.length
  const extras = withImages.map((slot) => slot.files.length - 1)
  const extraTotal = extras.reduce((sum, extra) => sum + extra, 0)
  const raw = extras.map((extra) => (extraTotal === 0 ? 0 : (extra * spare) / extraTotal))
  const quota = raw.map((value) => Math.floor(value))
  let remaining = spare - quota.reduce((sum, value) => sum + value, 0)
  const byRemainder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of byRemainder) {
    if (remaining <= 0) break
    if (quota[index] < extras[index]) {
      quota[index] += 1
      remaining -= 1
    }
  }
  const kept: SetRubricImage[] = []
  const truncated: string[] = []
  withImages.forEach((slot, index) => {
    const keep = 1 + quota[index]
    const cut = slot.files.length - keep
    truncated.push(...slot.files.slice(0, cut).map((image) => image.file))
    kept.push(...slot.files.slice(cut))
  })
  return { kept, truncated }
}

/**
 * 选图（纯函数）。作用面 = `rule.slots ?? 全部图像槽` 的交付集里的 `image/*` 件。
 * `deckPageFiles`：导出包里是 deck 页的产物文件名集合（`isDeckPageFile` 过滤 manifest 所得），只用于 `deckImages` 计数。
 */
export function planSetRubric(
  rule: SetVlmRubricRule,
  spec: TaskSpec,
  slots: readonly SlotVerdict[],
  artifacts: readonly ScoredArtifact[],
  deckPageFiles: ReadonlySet<string> = new Set(),
): SetRubricPlan {
  const scope = new Set(rule.slots ?? imageSlots(spec).map((slot) => slot.id))
  const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
  const deckSlots = new Set(spec.slots.filter((slot) => slot.minPages !== undefined).map((slot) => slot.id))
  // spec 槽序，不是 rule.slots 的书写顺序：同一题的两条规则看同一组图时顺序必须一致，缓存才能命中
  const perSlot = spec.slots
    .filter((slot) => scope.has(slot.id))
    .map((slot) => {
      const verdict = slots.find((item) => item.slotId === slot.id)
      const files = (verdict?.delivered ?? []).flatMap((file) => {
        const artifact = byFile.get(file)
        return artifact !== undefined && artifact.contentType.startsWith('image/')
          ? [{ file, slotId: slot.id, contentType: artifact.contentType }]
          : []
      })
      return { slotId: slot.id, files }
    })
  const deckImages = (images: readonly SetRubricImage[]) => images.filter(image => deckSlots.has(image.slotId) || deckPageFiles.has(image.file)).length
  if (rule.sourceSlots === undefined) {
    const { kept, truncated } = allocate(perSlot, SET_RUBRIC_MAX_IMAGES)
    return { images: kept, truncated, deckImages: deckImages(kept) }
  }

  const sourceImages: SetRubricImage[] = []
  const sources: SetRubricSource[] = rule.sourceSlots.map(slotId => {
    const file = slots.find(slot => slot.slotId === slotId)?.representative ?? null
    const artifact = file === null ? undefined : byFile.get(file)
    const text = artifact?.textLines.join('\n') ?? ''
    const base = { slotId, file, contentType: artifact?.contentType ?? null, text, textSha: artifact === undefined ? null : promptSha(text), textChars: text.length, imageNumber: null }
    if (file === null) return { ...base, status: 'missing', reason: `source slot "${slotId}" delivered nothing` }
    if (artifact === undefined || artifact.transcriptionFailed === true) {
      return { ...base, status: 'unreadable', reason: `source artifact "${file}" is unavailable or its transcription failed` }
    }
    if (artifact.contentType.startsWith('image/')) {
      sourceImages.push({ file, slotId, contentType: artifact.contentType, role: 'source' })
      return { ...base, status: 'ready', reason: null, imageNumber: sourceImages.length }
    }
    if (text.trim() === '' || artifact.contentType.startsWith('video/')) {
      return { ...base, status: 'unreadable', reason: `source artifact "${file}" has no readable text or supported source image` }
    }
    return { ...base, status: 'ready', reason: null }
  })
  const missingTargetSlots = [...scope].filter(slotId => (slots.find(slot => slot.slotId === slotId)?.delivered.length ?? 0) === 0)
  const unsupportedTargetFiles = slots.filter(slot => scope.has(slot.slotId)).flatMap(slot => slot.delivered)
    .filter(file => !byFile.get(file)?.contentType.startsWith('image/'))
  const targets = perSlot.map(slot => ({ ...slot, files: slot.files.map(image => ({ ...image, role: 'target' as const })) }))
  const capacity = SET_RUBRIC_MAX_IMAGES - sourceImages.length
  const targetSlotCount = targets.filter(slot => slot.files.length > 0).length
  // 来源不参与比例裁切；来源占满预算时整条不可判，来源元数据仍完整保留。
  const allocation = capacity < targetSlotCount || capacity < 1
    ? { kept: [] as SetRubricImage[], truncated: targets.flatMap(slot => slot.files.map(image => image.file)) }
    : allocate(targets, capacity)
  const images = [...sourceImages, ...allocation.kept]
  const badSource = sources.find(source => source.status !== 'ready')
  // #3811 成因与措辞由同一条链产出，不在别处按 reason 文本再猜一次 —— 那正是本条要消灭的读法
  const problem: { reason: string; cause: SetRubricUnavailableCause } | undefined = badSource !== undefined
    ? { reason: badSource.reason!, cause: badSource.status === 'missing' ? 'source-slot-empty' : 'source-slot-unreadable' }
    : sources.reduce((sum, source) => sum + source.textChars, 0) > SET_RUBRIC_MAX_SOURCE_TEXT_CHARS
      ? { reason: `source text exceeds the ${SET_RUBRIC_MAX_SOURCE_TEXT_CHARS}-character budget; no source text was truncated`, cause: 'source-text-over-budget' }
      : unsupportedTargetFiles.length > 0
        ? { reason: `target artifact(s) ${unsupportedTargetFiles.join(', ')} are not readable image evidence`, cause: 'target-not-image' }
        : capacity < 1 || allocation.truncated.length > 0
          ? { reason: `source and target evidence exceeds the ${SET_RUBRIC_MAX_IMAGES}-image budget; sources were preserved and the rule was not judged over truncated targets`, cause: 'image-budget' }
          : undefined
  return {
    images, truncated: allocation.truncated, deckImages: deckImages(images), sources, missingTargetSlots, unsupportedTargetFiles,
    ...(problem === undefined ? {} : { unavailable: problem.reason, unavailableCause: problem.cause }),
  }
}

/** 回复 → 规则级读数（纯函数）。`parsed === null` 时 `failure` 必须说明是哪一种判不出来。 */
export function scoreSetRubric(
  rule: SetVlmRubricRule,
  plan: SetRubricPlan,
  parsed: readonly RubricItemVerdict[] | null,
  failure?: string,
): SetVlmRubricVerdict {
  const base = {
    ruleId: rule.id, images: plan.images, truncated: plan.truncated, deckImages: plan.deckImages,
    ...(plan.sources === undefined ? {} : {
      sourceEvidence: plan.sources.map(({ text: _text, ...evidence }) => evidence),
      missingTargetSlots: plan.missingTargetSlots ?? [],
      unsupportedTargetFiles: plan.unsupportedTargetFiles ?? [],
    }),
  }
  const emptyByKind = (): Record<SetVlmItemKind | 'unlabelled', RubricAggregate> => ({
    consistency: { applicable: 0, mean0to2: null, mapped0to100: null },
    compliance: { applicable: 0, mean0to2: null, mapped0to100: null },
    unlabelled: { applicable: 0, mean0to2: null, mapped0to100: null },
  })
  const notApplicable = (reason: string, cause: SetRubricUnavailableCause): SetVlmRubricVerdict => ({
    ...base, verdict: 'not-applicable', items: [], applicable: 0,
    mean0to2: null, mapped0to100: null, byKind: emptyByKind(), reason, unavailableCause: cause,
  })
  // 显式的失败原因优先：结构判据面 / 调用失败在选图之前或之后都可能发生，reason 必须指认真正的来源
  if (parsed === null && failure !== undefined) return notApplicable(failure, 'judge-failed')
  if (rule.sourceSlots !== undefined) {
    if (plan.sources === undefined) return notApplicable('source evidence was not planned; cannot fall back to image-only scoring', 'not-planned')
    // #3952：来源槽空 / 读不出也只退出分母，不记 0。指南 §2.3「不交的系统在 M1 已记为不成功；
    // M2 第三层对它记 N/A，不记 0，避免同一缺失扣两次」—— v1.12（#3811）的记 0 与这条相反。
    // 成因仍逐条记着（`setRubricCauseOwner` 照旧归系统），报表的「规则损耗」一栏看得见。
    if (plan.unavailable !== undefined) return notApplicable(plan.unavailable, plan.unavailableCause ?? 'not-planned')
    if (!plan.images.some(image => image.role === 'target')) return notApplicable('no target image was delivered — missing deliverables are an M1 reading, not an M2 one', 'no-target-image')
  } else if (plan.images.length < 2) {
    const scope = rule.slots === undefined ? 'all image slots' : `slots [${rule.slots.join(', ')}]`
    return notApplicable(plan.images.length === 0
      ? `no image slot in scope (${scope}) delivered an image — either nothing was delivered (an M1 reading, not an M2 one) or the scope names no image slot (check rule.slots)`
      : `only 1 judgeable image in scope (${scope}) — a set of one cannot be inconsistent; missing deliverables are an M1 reading, not an M2 one`,
    plan.images.length === 0 ? 'no-target-image' : 'insufficient-images')
  }
  if (parsed === null) return notApplicable('no reply', 'judge-failed')
  const aggregate = aggregateRubric(parsed)
  // 逐条挂上职责：`parseRubricReply` 按清单顺序逐条对齐，下标就是对应关系
  const kinds = setVlmItemKinds(rule)
  const items: SetVlmItemVerdict[] = parsed.map((verdict, index) => {
    const kind = kinds[index]
    return kind === null || kind === undefined ? { ...verdict } : { ...verdict, kind }
  })
  const byKind = emptyByKind()
  byKind.consistency = aggregateRubric(items.filter((item) => item.kind === 'consistency'))
  byKind.compliance = aggregateRubric(items.filter((item) => item.kind === 'compliance'))
  byKind.unlabelled = aggregateRubric(items.filter((item) => item.kind === undefined))
  return {
    ...base,
    verdict: 'judged',
    items,
    ...aggregate,
    byKind,
    reason: aggregate.applicable === 0
      ? `all ${parsed.length} item(s) judged not applicable to this set`
      : `${aggregate.applicable}/${parsed.length} item(s) scored over ${plan.images.length} image(s)`
        + (plan.truncated.length > 0 ? ` (${plan.truncated.length} truncated by the ${SET_RUBRIC_MAX_IMAGES}-image cap)` : ''),
  }
}

export interface SetRubricSummary {
  /** 判了的规则数（verdict === 'judged'）—— **判官真跑过**才算，记 0 分那些不算 */
  judgedRules: number
  /** 记 0 分进分母的规则数（verdict === 'unmet'，#3811）。只有 v1.18 之前的旧记录会非 0（#3952） */
  unmetRules: number
  /** 打了分（非 N/A）的条目数，跨规则求和 */
  applicableItems: number
  /**
   * 有分规则的 `mapped0to100` 均值；没有有分规则 → null（全 N/A 不是 0 分）。
   *
   * ⚠️ 这是**全部条目一起算**的数：它把「几件产物是不是同一套」和「某一件照没照简报做」
   * 混在一起（#3552）。**M2 的一致性读数用 `consistencyMean0to100`**，这一列只作对旧读数
   * 的口径对齐。
   */
  mean0to100: number | null
  /** 只算 `kind: 'consistency'` 条目的均值 —— **M2 这一层的读数就是它** */
  consistencyMean0to100: number | null
  consistencyItems: number
  /** 只算 `kind: 'compliance'` 条目：与 M1 / constraints 同一件事，单列报，不进 M2 */
  complianceMean0to100: number | null
  complianceItems: number
  /** 旧题包里没声明职责的条目数。>0 就说明这一批的 M2 读数还带着未拆开的部分 */
  unlabelledItems: number
  /** 进请求的 deck 槽图数，跨规则求和 */
  deckImages: number
}

/**
 * 一次 run 的规则级读数 → run 级汇总。`evaluate.ts` 的 tally 与 `compareArms.ts` 的 cell 都调它，
 * 不各写一遍（#3380 为身份尺立的同一条纪律：聚合口径只能有一份实现）。
 */
export function summarizeSetRubric(verdicts: readonly SetVlmRubricVerdict[]): SetRubricSummary {
  const mean = (values: readonly number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  const groupMeans = (group: SetVlmItemKind): number[] => verdicts
    .map((rule) => rule.byKind?.[group].mapped0to100 ?? null)
    .filter((value): value is number => value !== null)
  const groupItems = (group: SetVlmItemKind): number =>
    verdicts.reduce((sum, rule) => sum + (rule.byKind?.[group].applicable ?? 0), 0)
  return {
    judgedRules: verdicts.filter((rule) => rule.verdict === 'judged').length,
    unmetRules: verdicts.filter((rule) => rule.verdict === 'unmet').length,
    applicableItems: verdicts.reduce((sum, rule) => sum + rule.applicable, 0),
    mean0to100: mean(verdicts.map((rule) => rule.mapped0to100).filter((value): value is number => value !== null)),
    consistencyMean0to100: mean(groupMeans('consistency')),
    consistencyItems: groupItems('consistency'),
    complianceMean0to100: mean(groupMeans('compliance')),
    complianceItems: groupItems('compliance'),
    // 旧文件整段没有 `byKind`（#3552 之前判的）。那时**每一条都是未声明职责**，
    // 不是「零条未声明」—— 否则旧批次会被读成「这一格没有一致性要求」。
    unlabelledItems: verdicts.reduce((sum, rule) => sum + (rule.byKind === undefined ? rule.applicable : rule.byKind.unlabelled.applicable), 0),
    deckImages: verdicts.reduce((sum, rule) => sum + rule.deckImages, 0),
  }
}

/** 真正的调用。`ask` 可注入，测试用它驱动失败路径。 */
export async function judgeSetRubric(input: {
  rule: SetVlmRubricRule
  spec: TaskSpec
  slots: readonly SlotVerdict[]
  artifacts: readonly ScoredArtifact[]
  /** 产物文件名 → 磁盘绝对路径 */
  artifactsDir: string
  /** 导出包里是外部臂 deck 页的产物文件名（`isDeckPageFile`），只进 `deckImages` 计数 */
  deckPageFiles?: ReadonlySet<string>
  cacheDir?: string | undefined
  /** 非 pixel 证据面上不判 —— 那条面上产物是占位图 */
  evidenceSurface: 'pixel' | 'prompt'
  ask?: (images: ReadonlyArray<{ path: string; contentType: string }>, prompt: { text: string; cacheSha: string }) => Promise<unknown>
}): Promise<SetVlmRubricVerdict> {
  const plan = planSetRubric(input.rule, input.spec, input.slots, input.artifacts, input.deckPageFiles)
  if (input.evidenceSurface !== 'pixel') {
    return scoreSetRubric(input.rule, plan, null, 'structural evidence surface carries placeholder imagery — set consistency cannot be judged from it')
  }
  if (input.rule.sourceSlots !== undefined) {
    if (plan.unavailable !== undefined || !plan.images.some(image => image.role === 'target')) return scoreSetRubric(input.rule, plan, null)
  } else if (plan.images.length < 2) return scoreSetRubric(input.rule, plan, null)
  const labels = plan.images.map(image => ({ slotId: image.slotId, label: input.spec.slots.find(slot => slot.id === image.slotId)?.label ?? image.slotId }))
  // 只有条目**原文**进 prompt —— `kind` 是记账用的元信息，加它不改提问、缓存键不变（#3552）
  const itemTexts = setVlmItemTexts(input.rule)
  const prompt = plan.sources === undefined
    ? renderSetRubricPrompt(itemTexts, labels)
    : renderSourceSetRubricPrompt(
      itemTexts,
      labels.map((label, index) => ({ ...label, role: plan.images[index].role! })),
      plan.sources.map(source => ({ slotId: source.slotId, file: source.file!, text: source.text, textSha: source.textSha!, imageNumber: source.imageNumber })),
    )
  const ask = input.ask ?? ((images, rendered) => askSetVlm<unknown>({ images, prompt: rendered.text, promptSha: rendered.cacheSha, cacheDir: input.cacheDir }))
  try {
    const reply = await ask(
      plan.images.map((image) => ({ path: path.join(input.artifactsDir, image.file), contentType: image.contentType })),
      prompt,
    )
    return scoreSetRubric(input.rule, plan, parseRubricReply(itemTexts, reply))
  } catch (error) {
    if (error instanceof VlmUnreadableError) return scoreSetRubric(input.rule, plan, null, `set rubric call failed after retry — ${error.message}`)
    if (error instanceof RubricReplyError) return scoreSetRubric(input.rule, plan, null, `set rubric reply failed the item contract — ${error.message}`)
    throw error
  }
}
