/**
 * M3 设计质量清单 `dq-v1`（#3443，指南 §2.4）—— **冻结数据**。
 *
 * 清单在代码里冻结、带 sha，而不是写在 spec 里：条目措辞改一个字就是换一把尺子，
 * 跨方向、跨批次要可比，措辞就只能有一份。spec 只记「用哪一版、哪个方向、要不要版式子项」。
 *
 * 措辞**逐字**取自 Qwen-Image-Bench `checklists.py`（arXiv 2605.28091）与 AesEval-Bench
 * （ICLR 2026，arXiv 2603.01083）的 Layout 四指标定义，2026-09-05 取回并核对，原文见
 * `docs/plans/3443-design-quality-rubric.md` 附录。**不改字**：Qwen 条目里的 "the prompt"
 * 在本 benchmark 里指该槽的 `label`，这条映射写在判定 prompt 模板里，不写进条目。
 *
 * ## 结构
 *
 * 四组（`group`）= 报表上的四列：Quality / Aesthetics / Text Rendering / Design Applications。
 * 每组下按 `l2` 分桶：L3 条目 → L2 均值 → 组均值（指南 `:193`），所以 Detail 的三条不会占
 * Quality 的一半权重。AesEval 的 Layout 四子项挂在 Aesthetics / Composition 之下作 L3
 * （指南 `:175`「在 Composition 下面补」），不是第五组；只在 `layoutExtras: true` 时加入。
 *
 * ## 隔离铁律
 *
 * 本清单属于冻结 benchmark evaluator。运行时机制禁止复用它：系统用同一把尺子既指导自己
 * 修复、又证明自己修好了，就是自证循环（备忘录 §7.14）。
 *
 * @module benchmarks/design-anything/tools/evaluator/dqChecklist
 */
import { promptSha } from './prompts'

export type DqGroup = 'quality' | 'aesthetics' | 'text' | 'domain'

/** `domainFacet` 的闭合枚举：按方向取一条 Design Applications 条目；`VisJudge-Bench` 是信息设计方向的整套替换清单（指南 §4.8）。 */
export type DqDomainFacet =
  | 'Graphic Design'
  | 'Product Design'
  | 'Spatial Design'
  | 'Fashion Styling'
  | 'Game Design'
  | 'Art Design'
  | 'Storyboard Creation'
  | 'VisJudge-Bench'

export const DQ_DOMAIN_FACETS: readonly DqDomainFacet[] = [
  'Graphic Design', 'Product Design', 'Spatial Design', 'Fashion Styling',
  'Game Design', 'Art Design', 'Storyboard Creation', 'VisJudge-Bench',
]

export interface DqChecklistItem {
  /** 稳定 id，进标注 CSV 的键与渲染器件白名单 */
  id: string
  group: DqGroup
  /** L2 桶名：同组内先按它取均值 */
  l2: string
  /** 条目原文，逐字；回复按序号对应、按它校验（#3466），所以全局唯一 */
  wording: string
  /** 什么情况下该判 N/A（进 prompt）；空串 = 没有按规则的 N/A */
  naHint: string
  /** 打分口径附注（进 prompt）；AesEval 的 Layout 子项固定「只在缺陷明显时判 0」 */
  judgeHint: string
  source: 'qwen-image-bench' | 'aeseval-bench'
}

/** spec 里选清单的那几个字段（`DqRubricSpec` 的子集，此处不依赖 taskSpec.ts 以免环） */
export interface DqChecklistSelection {
  checklistVersion: string
  domainFacet?: DqDomainFacet
  domainItems?: string[]
  layoutExtras?: boolean
}

export const DQ_CHECKLIST_VERSIONS = ['dq-v1'] as const
export type DqChecklistVersion = (typeof DQ_CHECKLIST_VERSIONS)[number]

const Q = 'qwen-image-bench' as const
const A = 'aeseval-bench' as const
const item = (id: string, group: DqGroup, l2: string, wording: string, naHint = '', judgeHint = '', source: typeof Q | typeof A = Q): DqChecklistItem =>
  ({ id, group, l2, wording, naHint, judgeHint, source })

const NO_TEXT = 'N/A when the image contains no text'
const COARSE = 'Judged coarsely: score 0 only when the defect is obvious'

/** 基础 15 条：Quality 6 + Aesthetics 6 + Text Rendering 3 */
const BASE_V1: readonly DqChecklistItem[] = [
  item('quality.realism.physical-logic', 'quality', 'Realism', 'Does the image adhere to real-world physical laws (e.g., gravity, reflection, shadow direction, object stability)?'),
  item('quality.realism.material-texture', 'quality', 'Realism', 'Do the surface materials of objects (such as skin, fabric, metal, wood) exhibit realistic texture and material properties?'),
  item('quality.detail.noise', 'quality', 'Detail', 'Is the image rich in detail without excessive noise or unnatural smoothing?'),
  item('quality.detail.edge-clarity', 'quality', 'Detail', 'Are the outlines and edges of objects sharp, well-defined, and free from blurring or aliasing?'),
  item('quality.detail.naturalness', 'quality', 'Detail', "Does the image appear natural and free from the artificial 'plastic' or 'greasy' look commonly associated with AI-generated images?"),
  item('quality.resolution', 'quality', 'Resolution', 'Is the overall image resolution high-definition, free from visible pixelation or compression artifacts?'),
  item('aesthetics.composition', 'aesthetics', 'Composition', 'Is the composition of the image balanced, visually guided, and aesthetically pleasing?'),
  item('aesthetics.color-harmony', 'aesthetics', 'Color Harmony', 'Is the overall color palette harmonious, cohesive, and appropriate for the mood of the image?'),
  item('aesthetics.lighting-atmosphere', 'aesthetics', 'Lighting & Atmosphere', 'Does the lighting and shadow atmosphere of the image (such as contrast between light and dark, and the overall lighting atmosphere) match the scene setting of the prompt?'),
  item('aesthetics.anatomical-fidelity', 'aesthetics', 'Anatomical Fidelity', 'Are the facial feature proportions, skeletal structure, and limb articulation anatomically correct and consistent with human biology?', 'N/A when no human figure is depicted'),
  item('aesthetics.emotional-expression', 'aesthetics', 'Emotional Expression', "Does the image's overall aesthetic tone effectively convey the intended emotion and mood described in the prompt?"),
  item('aesthetics.style-control', 'aesthetics', 'Style Control', "Does the image accurately capture and represent the specific artistic style requested in the prompt (e.g., Van Gogh's brushwork, Cyberpunk aesthetic)?"),
  item('text.accuracy', 'text', 'Accuracy', 'Is the text clear, legible, and free from garbled characters, misspellings, or typographical errors?', NO_TEXT),
  item('text.layout', 'text', 'Layout', 'Is the text layout (e.g., centering, alignment, line spacing, margins) in the image visually appealing and professionally structured?', NO_TEXT),
  item('text.font', 'text', 'Font', 'Does the font style used in the image match the font type specified in the prompt (e.g., SimSun, Heiti, handwritten, serif)?', NO_TEXT),
]

/** Design Applications：按 `domainFacet` 取一条。`VisJudge-Bench` 不在这里 —— 它是整套替换，本版排除。 */
const FACET_V1: Readonly<Record<Exclude<DqDomainFacet, 'VisJudge-Bench'>, DqChecklistItem>> = {
  'Graphic Design': item('domain.graphic-design', 'domain', 'Graphic Design', 'Does the graphic design (e.g., advertisement, poster) exhibit a clear information hierarchy, effective visual guidance, and professional layout?'),
  'Product Design': item('domain.product-design', 'domain', 'Product Design', 'Does the product design in the image demonstrate reasonable industrial design logic (e.g., ergonomic grip, logical interface placement, structural integrity)?'),
  'Spatial Design': item('domain.spatial-design', 'domain', 'Spatial Design', 'Does the interior or architectural space conform to the principles of perspective, proportion, and building design standards?'),
  'Fashion Styling': item('domain.fashion-styling', 'domain', 'Fashion Styling', 'Does the clothing cut and silhouette match the style described in the prompt (e.g., Hanfu, cyberpunk, haute couture)?'),
  'Game Design': item('domain.game-design', 'domain', 'Game Design', 'Do the game props and UI elements have practical in-game usability (e.g., icon recognizability, interactive affordances, clear feedback cues)?'),
  'Art Design': item('domain.art-design', 'domain', 'Art Design', 'Does the image successfully demonstrate the specific artistic design style required by the prompt?'),
  'Storyboard Creation': item('domain.storyboard-creation', 'domain', 'Storyboard Creation', "Does the image's scene composition follow the panel layout requirements outlined in the prompt (e.g., three-panel, four-panel, split-screen)?"),
}

/** AesEval-Bench Layout 四子项，挂在 Aesthetics / Composition 之下；只问「缺陷是否明显」（指南 §2.4 第 5 步）。 */
const LAYOUT_V1: readonly DqChecklistItem[] = [
  item('aesthetics.composition.balance', 'aesthetics', 'Composition', 'Balance is the distribution of visual weight in design. It can be symmetrical (with equal weights on both sides) or asymmetrical (with unequal weights but still achieving visual balance).', '', COARSE, A),
  item('aesthetics.composition.layering', 'aesthetics', 'Composition', "Use size, color, contrast, and other visual cues to establish a hierarchical structure of design elements to guide the audience's eyes.", '', COARSE, A),
  item('aesthetics.composition.whitespace', 'aesthetics', 'Composition', 'White space refers to the blank area around the elements in a design. Effective utilization of white space can create balance, visual hierarchy, and clarity.', '', COARSE, A),
  item('aesthetics.composition.alignment', 'aesthetics', 'Composition', 'Alignment refers to the arrangement of design elements relative to each other or a specific axis or grid. Proper alignment creates a sense of order and organization, making the design easier to navigate.', '', `${COARSE} — only whether elements are visibly misaligned`, A),
]

interface DqChecklist {
  base: readonly DqChecklistItem[]
  facet: Readonly<Record<Exclude<DqDomainFacet, 'VisJudge-Bench'>, DqChecklistItem>>
  layout: readonly DqChecklistItem[]
}

export const DQ_CHECKLISTS: Readonly<Record<DqChecklistVersion, DqChecklist>> = {
  'dq-v1': { base: BASE_V1, facet: FACET_V1, layout: LAYOUT_V1 },
}

function catalogOf(checklist: DqChecklist): DqChecklistItem[] {
  return [...checklist.base, ...Object.values(checklist.facet), ...checklist.layout]
}

/** 清单身份：整个冻结目录（基础 + 全部 facet + layout）序列化后的 sha，进评估器身份与可比性键。 */
export const DQ_CHECKLIST_SHA: Readonly<Record<DqChecklistVersion, string>> = Object.fromEntries(
  DQ_CHECKLIST_VERSIONS.map((version) => [version, promptSha(JSON.stringify(catalogOf(DQ_CHECKLISTS[version])))]),
) as Record<DqChecklistVersion, string>

export function isDqChecklistVersion(version: string): version is DqChecklistVersion {
  return (DQ_CHECKLIST_VERSIONS as readonly string[]).includes(version)
}

/** 本版评估器判不了、必须整题排除的情况。 */
export interface DqChecklistExcluded {
  excluded: 'visjudge-pending'
  reason: string
}

function assertUniqueWordings(items: readonly DqChecklistItem[], where: string): void {
  const seen = new Map<string, string>()
  for (const entry of items) {
    const prior = seen.get(entry.wording)
    if (prior !== undefined) {
      throw new Error(`${where}: checklist wording collides between "${prior}" and "${entry.id}" — the judge echoes wording verbatim to name an item, so two items cannot share one`)
    }
    seen.set(entry.wording, entry.id)
  }
}

for (const version of DQ_CHECKLIST_VERSIONS) assertUniqueWordings(catalogOf(DQ_CHECKLISTS[version]), version)

/**
 * spec 的选择 → 这道题要打的条目，**顺序固定**：基础 15 → facet 1 → `domainItems`（每条一个 `domain` 组 L3，
 * id 按序号派生）→ layout 4。顺序进 prompt 也进缓存键。
 *
 * `VisJudge-Bench` 方向整题排除：指南 §4.8 要求信息设计整套换清单，把通用条目（重力、面部比例）
 * 套在图表上产出的是语义不对应的数字，不如不判。
 */
export function resolveChecklist(rubric: DqChecklistSelection): DqChecklistItem[] | DqChecklistExcluded {
  if (!isDqChecklistVersion(rubric.checklistVersion)) {
    throw new Error(`unknown dqRubric.checklistVersion "${rubric.checklistVersion}" (frozen versions: ${DQ_CHECKLIST_VERSIONS.join(', ')})`)
  }
  if (rubric.domainFacet === 'VisJudge-Bench') {
    return { excluded: 'visjudge-pending', reason: 'information-design direction needs the VisJudge-Bench checklist as a whole (guide §4.8); the generic dq-v1 items do not apply to charts and this evaluator version does not carry VisJudge' }
  }
  const checklist = DQ_CHECKLISTS[rubric.checklistVersion]
  const items = [
    ...checklist.base,
    ...(rubric.domainFacet === undefined ? [] : [checklist.facet[rubric.domainFacet]]),
    // domainItems 共用一个 L2 桶：它们是同一方向的补充条目；facet 条目自成一桶。两级均值下 facet 与全部补充条目各占 Design Applications 的一半。
    ...(rubric.domainItems ?? []).map((wording, index) => item(`domain.custom-${index + 1}`, 'domain', 'Domain Items', wording)),
    ...(rubric.layoutExtras === true ? checklist.layout : []),
  ]
  assertUniqueWordings(items, `dqRubric(${rubric.checklistVersion})`)
  return items
}
