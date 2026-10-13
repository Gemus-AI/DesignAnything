/**
 * DesignAnything-Bench 冻结评估器 · 确定性层（#3109 / ICLR 计划 G8）。
 *
 * ## 铁律：单一判定路径
 *
 * **只消费 G4 导出包**（`manifest.json` + `artifacts/`）。不读画布、不读 Blueprint、
 * 不读 GraphContract —— 那些只有 Full 臂产生，读了就等于让被测机制同时当量尺，
 * 消融结果在评估这一步就被预先决定了（§9.5 铁律）。闭源产品的导出目录人工整理成
 * 同一结构后走**同一个脚本**。
 *
 * ## 口径（#3106 首跑实测后重定，issue #3109 的评论是判据来源）
 *
 * | 维度 | 怎么量 |
 * |---|---|
 * | Deliverable Completion | **槽位覆盖率**（冻结分类器归类）。**不是文件计数** —— 三臂产物逐件同构，文件计数读出 0pp |
 * | Constraint Compliance | 转写文本的**精确子串匹配**。像素采样降级为诊断，`scoring:false` 写死在 spec |
 * | Set Consistency | 只做确定性部分：跨件 hex token 一致性 |
 * | 诊断（不计分） | 像素命中、claimed-vs-delivered、needsManualCheck |
 *
 * ## 输入必须是 manifest v5
 *
 * 两次拒旧包都出于同一条理由：**旧包缺的字段会让判定静默地量错东西**。
 * v3 加 `role`（v2 的缩略图与主媒体不可分，拿 v2 评分会让 OCR 在低分辨率缩略图上
 * 读不出 hex → 凭空造出约束违规）；v5 加 inline 文本通道（#3128 —— v4 及更早的包
 * 只收媒体 blob，**所有文字交付物结构性缺席**，拿它评分会把交了但量不到读成没交）。
 * 故遇旧包直接 exit 1 要求重导出，而不是「尽力而为」。
 *
 * Usage:
 *   pnpm bench:evaluate --export tmp/bench-arm-full/export
 *   pnpm bench:evaluate --export tmp/bench-arm-full/export --labels tmp/labels.csv   # κ 重测
 *   pnpm bench:evaluate --export <dir> --concurrency 4 --continue-on-error            # #3418 题间并发 + 单题失败不牵连整队
 *
 * `--concurrency`（默认 1）：题间并发。各题之间无数据依赖，结果按**输入序**归位后再写 CSV /
 * 喂 κ，同一份导出包并发跑与串行跑的 `evaluation.csv` 逐字节相同。默认不开：评估真金白银调用
 * 量尺，默认值变更会让既有调用方的成本与速率特征无预警改变。
 * `--continue-on-error`（默认关）：单题失败记录并继续，其余题照判、CSV 照写；末尾仍以 exit 1
 * 报出失败清单。缓存让重跑不重复烧钱，但没有它一次瞬时网络抖动会让剩余题的**时间**全部损失。
 *
 * 退出码：`0` = 每个 run 都判完；`1` = manifest 版本不符 / spec 缺失 / 视觉调用失败。
 *
 * @module benchmarks/design-anything/tools/evaluate
 */

import 'dotenv/config'

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

import sharp from 'sharp'

import type { ExportedFile, RunExportManifest } from './exportRunArtifacts'
import { spearman } from './evaluator/correlation'
import { embedStyle } from './evaluator/csdSidecar'
import { DQ_GROUPS, designQualityStatus, judgeDesignQuality, rendererProducedFiles, summarizeDesignQuality, type DesignQualityResult, type EvaluationManifest } from './evaluator/designQuality'
import { DQ_CHECKLIST_SHA, resolveChecklist, type DqGroup } from './evaluator/dqChecklist'
import { cohensKappa, parseLabelCsv, type LabelPair } from './evaluator/kappa'
import { mapBounded } from './evaluator/mapBounded'
import { checkSidecarWeights, formatSidecarPreflight } from './evaluator/sidecarPreflight'
import {
  CARRY_EXTRACT_PROMPT_SHA,
  CARRY_TEMPERAMENT_PROMPT_SHA,
  CLAIM_PROMPT_SHA,
  CLASSIFY_PROMPT_SHA,
  CLASSIFY_SCORES_PROMPT_SHA,
  DQ_PROMPT_SHA,
  IDENTITY_PROMPT_SHA,
  REDISTRIBUTE_PROMPT_SHA,
  SET_RUBRIC_PROMPT_SHA,
  SOURCE_SET_RUBRIC_PROMPT_SHA,
  TRANSCRIBE_PROMPT_SHA,
  TRANSCRIBE_PROMPT_TEMPLATE,
  promptSha,
  renderClassifyPrompt,
  renderClassifyScoresPrompt,
  renderRedistributePrompt,
} from './evaluator/prompts'
import {
  runRedistribution,
  skippedRedistribution,
  type RedistributeReply,
  type RedistributionDiagnostics,
} from './evaluator/redistribute'
import { extractClaims, type ClaimExtraction } from './evaluator/claims'
import { isDeckPageFile, renderedDeckPageStem } from './evaluator/deckPages'
import { artifactStrata } from './evaluator/stratum'
import { judgeCarryThrough, summarizeCarryThrough, type CarryThroughVerdict } from './evaluator/carryThrough'
import { identityBandColumns, identityBandValues, isFailFromMissing, judgeIdentity, summarizeIdentityBands, tallyPairs, type IdentityBandSummary, type IdentityVerdict } from './evaluator/identity'
import { prepareIdentityAssetBindings, type IdentityAssetBindings } from './evaluator/assetBindings'
import { judgeSetRubric, summarizeSetRubric, type SetVlmRubricVerdict } from './evaluator/setRubric'
import { readPdfPageCount } from './evaluator/pdfPages'
import type { ArtifactEvidence, EvidenceChannel } from './evaluator/artifactEvidence'
import { applyFinalSelection, judgeFinalSelection, FINAL_SELECTION_SHA, type FinalSelectionResult } from './evaluator/finalSelection'
import { prepareRequirementArtifacts, readPublicRequirementInputs, originalFileSha, classifyDocumentScores, documentStructureHeader } from './evaluator/requirementEvidence'
import { CARRIER_SEAT_TOLERANCE, IMAGE_SERIES_MIN_MEMBERS, imageSeriesCandidates } from './evaluator/carrierKind'
import { isDocumentClassifiableCarrier } from './evaluator/documentCarrier'
import { judgeRequirementChecks, REQUIREMENT_CHECK_PROMPT_SHA, type RequirementCheckResult } from './evaluator/requirementChecks'
import { normalizeScore } from './evaluator/rubric'
import { unjudgedDeclarations } from './evaluator/scoring'
import {
  PALETTE_RULE_VERSION,
  STYLE_RULE_VERSION,
  readPalette,
  scorePaletteConsistency,
  scoreStyleConsistency,
  type Palette,
  type PaletteConsistencyVerdict,
  type StyleConsistencyVerdict,
} from './evaluator/setSimilarity'
import {
  assessMeasurement,
  assessSlotAssignment,
  assignNonImageSlot,
  documentSlots,
  extractHexTokens,
  imageSlots,
  scoreRun,
  scoreSlots,
  type FalseCompletionInput,
  type M1SuccessVerdict,
  type MeasurementValidity,
  type SlotAssignmentJudgeability,
  type RunScore,
  type ScoredArtifact,
  type UnassignedCause,
} from './evaluator/scoring'
import { assignSlot, MODEL_UNASSIGNED, resolveDeferredReasks, type ClassifyReply, type DeferredReask, type SlotAssignment } from './evaluator/reclassify'
import {
  imageSlotSeats,
  MAX_FIT_SCORE,
  normalizeClassifyScores,
  pageFloorSeatBonus,
  preferredSlotOf,
  readClassifyScores,
  seatedTotal,
  solveSlotAssignment,
  UNASSIGNED_SLOT,
  type ClassifyScoresReply,
  type NormalizedScores,
} from './evaluator/assignment'
import { lintTaskSpec, loadTaskSpec, maxIdentityPairs, slotAccepts, slotIsCore, type SlotSpec, type TaskSpec } from './evaluator/taskSpec'
import {
  EVALUATOR_MODEL_ID,
  EVALUATOR_SAMPLING,
  DQ_JUDGE_MODEL_ID,
  EVALUATOR_VERSION,
  RUBRIC_VERSION,
  VlmUnreadableError,
  readEvaluatorTransportFailures,
  type EvaluatorTransportFailure,
  askInlineTextEvaluator,
  askSetVlm,
  askTextEvaluator,
  askVlm,
  type ImageNormalization,
} from './evaluator/vlm'
import { buildStructuralEvidence, loadStructuralGraph } from './evaluator/structuralEvidence'
import { evaluationCorpusPaths, taskSetSha } from './corpusPaths'
import type { DesignAnythingBenchVersion } from '../../../src/lib/agent/eval/corpusPaths'

/** 评估器要求的最低 manifest 版本。低于它拒绝评分（见模块头）。 */
const REQUIRED_MANIFEST_VERSION = 5

/**
 * 像素采样策略 —— **写死并记录**，不因看到数据而改。
 *
 * 最近邻缩到 128×128 后逐像素比通道差：缩放用 nearest 是刻意的，双线性会把相邻像素
 * 平均出原图里不存在的颜色，那等于给这条诊断信号注入伪命中。
 */
const PIXEL_STRATEGY = 'nearest-resize-128x128, per-channel abs diff <= tolerance, hit if any pixel matches'

/**
 * 证据面（#3163）。`pixel` = 冻结的视觉判据（默认，历史读数全部出自它）；
 * `prompt` = 结构判据，证据换成"这件产物是被怎么派出去的"。
 *
 * 两者**不可跨批比较**，所以 `rubricVersion` 带上后缀，让任何把两条曲线画在一起的尝试
 * 在读表那一步就露馅。
 */
type EvidenceSurface = 'pixel' | 'prompt'

export interface EvaluationOutput {
  evaluatorVersion: string
  /**
   * 这一轮 run 的终态，原样抄自 manifest（v4 起）。`null` = 旧包，未知。
   *
   * **判定照常做、结果照常写**，但比较器会把非 `passed` 的格子排除在差值之外：
   * 一个半路崩掉的 run 的残缺产物不是"agent 只交了这些"。判而不用，是为了让排除这件事
   * 可核对 —— 直接不判会让"这一格为什么空"变成读表人无从查起的事。
   */
  runVerdict: { verdict: string; errorClass: string | null; detail?: string } | null
  rubricVersion: string
  classifierModel: string
  sampling: string
  /** 评估器身份（模板 sha）。`redistributeSha` 自 v0.3 起有（#3407）；`setRubricSha` v0.5（#3441）；`carryExtractSha` / `carryTemperamentSha`（#3442）；`dqSha` v0.6（#3443）；旧文件缺省 */
  prompts: { classifySha: string; classifyScoresSha?: string; transcribeSha: string; claimSha: string; identitySha: string; redistributeSha?: string; setRubricSha?: string; sourceSetRubricSha?: string; carryExtractSha?: string; carryTemperamentSha?: string; dqSha?: string; requirementSha?: string; finalSelectionSha?: string }
  /**
   * M3 清单身份与评审模型（#3443，v0.6 起）：都进可比性键 —— 换清单措辞或换评审模型的读数不可同图。
   *
   * **没开 `--dq` 时这两个字段（以及 `prompts.dqSha`）一律缺席**（#3765）。缺席是读数的一部分，
   * 不是省事：它让「跑过 M3 的批」与「没跑的批」在 `evaluatorIdentity` 上就不是同一把尺子。
   */
  dqChecklistSha?: string
  dqJudgeModel?: string
  pixelStrategy: string
  /** #3374 色板判据的规则版本。改提取策略或距离定义必须 bump */
  paletteRuleVersion: string
  /** #3374 风格判据的规则版本（侧车预处理 + 距离定义）。旧文件缺省 */
  styleRuleVersion?: string
  /** 实际用的 CSD 权重 sha；侧车不可用时 null。旧文件缺省 */
  csdWeightsSha256?: string | null
  manifestVersion: number
  specVersion: number
  taskId: string
  /**
   * 判据包身份（#3550）：本次判定实际用的 tasks 目录的内容哈希，进可比性键。
   * 与 `benchmarkVersion` 是两件事 —— 后者记的是 agent 当初读的题面版本（被测对象），
   * 这个记的是判分规则。旧文件缺省。
   */
  taskSetSha?: string
  benchmarkVersion?: DesignAnythingBenchVersion
  runKey: string
  evaluatedAt: string
  artifacts: ScoredArtifact[]
  score: RunScore
  /** v3 的全部公开要求验收；缺证据/待人工不算通过，旧 M1 指标仍独立保留。 */
  requirements?: RequirementCheckResult
  finalSelection?: FinalSelectionResult
  diagnostics: {
    /** 被排除在计分面之外的平台派生物（缩略图）。列出来是为了让「过滤生效了」可核对 */
    derivedFiles: string[]
    /**
     * 题面自带的**输入素材**（`role: 'input'`，#3439 起）。**不计分**，列出来是为了让
     * 「这份清单是全的」重新可核对（#3498）。
     *
     * #3439 之前每个导出件必然落在 `primary`（计分面）或 `derived`（平台缩略图）两档之一，
     * 于是 `artifacts` + `derivedFiles` 就是 `manifest.files` 的全部。第三档 `input` 出现后
     * 这两个筛子都不收它，`evaluation.json` 里没有任何一处说「这一轮有 N 件是题面输入」——
     * 读表人会把这几件读成「导出丢了」。
     *
     * 字段**恒写**（一件都没有时是 `[]`），所以「缺席」只有一个含义：这份 evaluation.json
     * 出自本改动之前的评估器。`[]` 与缺席不能长得一样，这是本仓库反复踩的同一个坑。
     *
     * 不升 `EVALUATOR_VERSION`：它是纯诊断字段，不进 `score.*`、不移动任何一列读数
     * （对照 `pageFloorRejections` 的同款处置）。v0.5/v0.6 之所以为新增字段升版本，是因为
     * 那两次新增的是**判定**段，缺席会被读成「未判」。
     */
    inputFiles: string[]
    /**
     * 每份证据的**分通道** limitation（#3703）。**不计分**，列出来是为了让「这一份读数为什么
     * 少了一块」当场可核对：判定层现在按通道取证，读表人也得看得见哪一路缺了什么。
     *
     * 尤其是 media 通道 —— 它自本改动起不再污染文字与视觉两路，于是「视频没读到」这件事
     * 除了这里就再没有别的地方会说出来了。
     *
     * 字段**恒写**（一条都没有时是 `[]`），缺席只意味着这份 evaluation.json 出自本改动之前。
     */
    evidenceLimitations: Array<{ file: string; channels: readonly EvidenceChannel[]; message: string }>
    /** 分类器判 unassigned 或 low confidence 的产物 —— 人该看一眼的清单 */
    needsManualCheck: Array<{ file: string; slot: string; confidence: string; reason: string }>
    /**
     * 有页数下限的槽里，**交付了但页数不达标**的件（#3126 的读数，指南 §2.2）。**不计分**，
     * 但按系统汇总必报：`unknown-page-count` 的多少直接量出"交付格式读不出页数"这件事
     * 在该系统上有多常见 —— 那是格式差异，不是能力差异，不该藏在成功率里。
     * 旧 evaluation.json 没有这个字段（可选），读表侧按空数组处理。
     *
     * #3803 起它的口径变了：此前数的是**被挡在槽外**的件，现在数的是**归进了槽、形态不达标**
     * 的件。页数不再决定归属，所以「被挡在槽外」这个状态不存在了。
     */
    pageFloorRejections?: Array<{ file: string; slot: string; floor: number; pages: number | null; reason: 'unknown-page-count' | 'below-floor' }>
    /**
     * 未归槽的**成因分档**（#3488）。**不计分**，但必须与完成度并排看得见：
     * 「量尺说它不属于任何槽」和「量尺没测出来」在 `slot` 这一个字段上长得一模一样，
     * 只看完成度就会把后者读成「系统没交」。
     *
     * `modelChoice` = 量尺的正式回答（含第二段再分配判出的 unassigned），其余四档都是
     * 没测到。旧 evaluation.json 没有这个字段（可选），读表侧按全 0 处理。
     */
    unassignedCauses?: Record<UnassignedCause | 'modelChoice' | 'transcription-failed', number>
    /**
     * 发出去之前被等比缩过的图（#3488）。**不计分**，是知情披露：这几件上量尺看到的
     * 不是原图。空数组 = 一件都没缩，与字段缺席（旧包）不是一回事。
     */
    imageNormalizations?: ImageNormalization[]
    /**
     * 评审调用在传输层失败的件（#3593）。这些件被判成不可判而不是整题作废 —— 「没判」与
     * 「判了不过」必须分得开，读表人据此决定是重评这一题还是接受缺口。空数组 = 一次都没失败，
     * 与字段缺席（旧包）不是一回事。
     */
    evaluatorTransportFailures?: EvaluatorTransportFailure[]
    /**
     * 自称 vs 实际（#3113 的 finalMessage 通道）。**不计分** ——
     * 让声明计分等于让系统靠断言得分。这里只量差值。
     */
    claimedVsDelivered: { claimedHex: string[]; deliveredHex: string[]; mismatch: boolean }
    /**
     * 声明侧的原始读数（#3172）—— per-slot 声明、模型幻觉出的槽 id、以及一句话理由。
     * `null` = 没有终答或抽取失败（`score.falseCompletion.reason` 里写明是哪一种）。
     *
     * **与 `claimedVsDelivered` 是两把不同的尺子**：后者比的是终答里提到的 hex 与产物上
     * 读出的 hex（一条品牌色旁证），语义原样保留、一字未动。
     */
    claims: (ClaimExtraction & { finalMessagePresent: boolean }) | null
    /**
     * 这道题**声明了、但本版评估器还判不了**的判据段（#3371）。
     *
     * `carryThrough` / `setVlmRubric` / `dqRubric` 三个字段先落地是为了让 252 道题的作者
     * 能按新口径写题，判定实现另开。空数组 = 这道题没声明任何未判定段。
     *
     * `carryThrough` 已于 #3442 P0 判定（`score.carryThrough`），故不再出现在这张清单里。
     *
     * **为什么是一条显式清单，而不是把声明原样回声进结果文件。** 把一份没有被计算过的
     * 声明抄进 `evaluation.json`，读起来就像一条读数；而这份文件里的每一项都是读数。
     * 「声明了但没判」与「判了且通过」在结果文件里必须长得不一样 —— 这正是本批 issue
     * 要修的那个病（#3372：`identityConsistency` 缺席被报表读成一致性通过）。
     */
    declaredButUnjudged: string[]
    /**
     * 这份包里**有图像或视频件、但一件都没带来源登记**（#3444）。
     *
     * v12 及更早的包结构上就没有 `provenance` 字段，于是交付方式那一列会整列读成
     * `unknown`。不显式报出来的话，一个 `authoredShare: null` 读起来像「这一格没有
     * 可归档的成果」，而事实是「这把尺子在这份包上根本没有输入」——
     * 与 `revision` 对 v9 以前的包判 not-applicable 同一条纪律。
     */
    provenanceMissing: boolean
    /**
     * 第二段分类「超配槽集合内再分配」的记账（#3407，v0.3 起）：几轮、问了哪些槽、搬了哪些件、
     * 哪些槽的回复无效而回退第一段、跑完后是否仍有「超配 ∧ 缺件」共现。`skipped` = 未运行的原因
     * （结构判据模式不读像素）。旧 evaluation.json 没有这个字段（可选）。
     *
     * 触发只发生在有缺件的题，件数刚好的题永远不触发 —— 这是机制的形状不是漏洞，但跨臂比较时
     * 必须看得见：`compareArms` 把轮数与移动件数列成两列，某臂触发率显著高于其它臂时读数要连同
     * 这两列一起报。
     */
    redistribution?: RedistributionDiagnostics
  }
  /** 生成侧记账，两个口径都报（#3115）。outputs ≠ requests 是真实现象，不是 bug */
  generation: {
    outputs: number
    requests: number
    /** 其中成功的请求数 —— 用来把「产出了但通道看不见」与「真的什么都没产出」分开 */
    completedRequests: number
    /** orchestrator 一个会话的 LLM 成本，原样抄自导出包 `llm.estimatedCostUsd` */
    estimatedCostUsd: number | null
    /**
     * 整格 LLM 成本 = orchestrator + teammates（#3895）。导出包带 `llm.cellCostUsd` 时取它，
     * 不带（旧包 / teammate 用量查询失败）时回落 `estimatedCostUsd`；外部臂没有 `llm` 段 → null。
     * 字段缺席 = 本 evaluation 早于 #3895，读者自行回落 `estimatedCostUsd`。
     */
    cellCostUsd?: number | null
    /**
     * 这一轮实际用到的**图像/视频生成模型**（#3530）。自家臂逐条来自导出包的
     * `generationJobs`；外部臂恒为空数组 —— 它们是闭源产品，导出包里没有这一层，
     * 而且**无从获得**。
     *
     * 这一列存在的理由：三条臂的文本底模已经对齐（`AGENT_MODEL_PROVIDER` /
     * `AGENT_EVAL_MODEL_PIN` 记在每份报告的 harness flags 里），图像模型**没有对齐、
     * 而且不可能对齐**。于是「我们的跨件色板一致性不如对方」这句话无法区分两种解释：
     * 我们的编排没能把配色传下去，还是对方用了一个参考图遵循度更好的图像模型。
     * 既然消不掉，就必须说出来 —— 而且要**长在表上**，与读数同时出现。
     *
     * 空数组有两种来源，报表必须分开显示：外部臂（结构性不可观测）与旧包
     * （该字段之前评估的）。前者是事实，后者是仪器盲区。
     *
     * `undefined` = 该包评估于本字段存在之前。**不要**反推外部臂用了什么模型：
     * 从产物反推生成器既不可靠也无法复核，把一个诚实的「不可观测」换成一个可疑的猜测
     * 是负收益。
     */
    models?: Array<{ providerId: string; modelId: string; requests: number }>
  }
  /**
   * 这一格能不能进跨臂差值。**判定照常做、数值照常写**，无效只是不进差值 ——
   * 直接不判会让「这一格为什么空」变成读表人无从查起的事。
   *
   * 两种无效，共同点是**被判的不是被测对象**：
   *
   * 1. `run-not-passed`：run 半路崩了，残缺产物不是"agent 只交了这些"。
   * 2. `no-media-in-export`：生成请求成功了，导出包里却一件媒体都没有 ——
   *    系统把交付物做成了非媒体形态（实测 bench-ui-02 的 full 臂用 `gemini-llm`
   *    交了 HTML/CSS，而同题 blueprint-off 用图像模型交了 8 件）。导出包**只收媒体 blob**，
   *    于是这一格读成 0%。那是仪器看不见，不是机制没做到 —— 而这一格恰好足以翻转
   *    整个聚合差值的符号，所以它必须是一条显式判据，不能靠人事后发现。
   *
   * 「零请求且零产出」不在此列：那是真的什么都没做，该判 0。
   */
  measurement: MeasurementValidity
  /**
   * M1 缺件读数判不判得了（#3529）。判据见 `scoring.assessSlotAssignment`。
   *
   * 与 {@link EvaluationOutput.measurement} 是两个不同作用面：那个说「这一整格是不是一次
   * 有效的测量」，这个只说「这一格的 M1 缺件读数能不能被当成读数」。归槽残留错配不影响
   * 成本、约束、一致性那几列，把整格判无效会连带丢掉它们。
   *
   * `undefined` = 该包评估于本字段之前。报表按「未记录」渲染，**不当成可判**——
   * 那正好是 #3529 之前的状态：判不了的格子一路计进了 M1 的分母。
   */
  slotAssignment: SlotAssignmentJudgeability
}

interface TranscribeReply { lines: string[]; unreadableCount: number }

/**
 * 按成因清点未归槽的件（#3488）。**四档"没测到" + 一档"量尺说的"** ——
 * 合成一个「未归槽率」会让格式差异读成能力差异，这正是本判据要挡的那件事。
 */
/**
 * deck 页退出归槽（#3540）。**就地改 `artifacts`**，在全部件判完、再分配开始之前调用一次。
 *
 * ## 规则
 *
 * **一张展示 hero 主视觉的幻灯片，不算交付了 hero 主视觉。** 幻灯片是对作品的**引用**：
 * 它只能证明作品存在过，不能替代作品。而归槽的分类器只看画面内容，引用与本体在画面上几乎一样。
 *
 * ## 一处例外：源文件自己没顶上槽的渲染页
 *
 * 导入器把包里每一份多页 HTML 都渲进 `__rendered__/`，**不管它是汇报 deck 还是一份独立交付物**。
 * 2026-09-08 实测 OpenDesign 的 45 种渲染页来源里 44 种是 deck，1 种是写成网页的方案方向 ——
 * 那份源文件走文档通道、进不了图像槽，渲染页是它唯一的进场方式，一刀切会把一条真实的交付通道
 * 判成没交付。
 *
 * 判据不去问「这份源文件是不是 deck」（那要一份看名字的词表，不可复算），而是问
 * **「这份源文件自己顶上槽了没有」**：顶上了，它的渲染页就是同一件交付物的第二种形态，不该再顶
 * 一次；没顶上，渲染页就是它唯一的进场方式。源文件不在包里时按 deck 页处置 —— 那是实测里
 * 44/45 的情形，也是保守的一侧。
 *
 * 已知边界：本函数跑在回退重判**之前**（那个顺序是必须的，否则「哪些槽还缺件」的账里混着
 * deck 页），所以例外读的是源文件重判**之前**的归属。源文件恰好在重判里被捡进某个槽时，
 * 它的渲染页已经被放行 —— 偏松的一侧，且实测未出现。
 *
 * **本函数必须跑在 `solveSlotAssignment` 之前**（#3548）。逐件分类的旧结构里「事后撤出」与
 * 「事前排除」是等价的 —— 每件独立判，撤一件不影响别件。**整体指派把这个等价关系打破了**：
 * 求解是全局的，任何一件的存在都改变别件的落点。deck 页在求解那一刻若仍是候选件，它会占掉
 * 某个槽的席位，一件本该坐那儿的真实交付物被安排去次高的槽；撤出 deck 页时**不重解**，
 * 于是前一个槽空着、后一个超配 —— 正是 #3529 判不可判的形态。实测 `bench-da-book-01--r1`：
 * 4 个席位（`spread` / `lettering` / `chapter-art` / `endpapers`）被 deck 页占走，
 * 同题 13 件非 deck 产物里 4 件因此落在 overflow / 散件上。
 *
 * 提前到求解之前不缺任何输入：例外判据读的是 HTML **源文件**自己顶没顶上槽，而源文件走
 * 文档 / 文本通道，它的落点在归槽循环里就已经定了。
 */
export function excludeDeckPagesFromSlots(
  artifacts: ScoredArtifact[],
  files: readonly Pick<ExportedFile, 'key' | 'file'>[],
  /**
   * 源文件「属于哪个槽」的判据（#3948）。缺省读它此刻的槽 —— 只在源文件的落点已经定下时成立。
   * 求解前调用时必须传 {@link deckSourcePreferredSlot}：那一刻所有待求解件的槽都还是占位值。
   */
  sourceSlot?: (file: string) => string,
): void {
  const slotByFile = new Map(artifacts.map((artifact) => [artifact.file, artifact.slot]))
  const slotOfSource = sourceSlot ?? ((file: string) => slotByFile.get(file))
  // 源文件名干 → 包里那份源文件的产物名。`<stem>.html` / `<stem>.htm`，同一个干只可能有一份。
  const sourceByStem = new Map<string, string>()
  for (const file of files) {
    const match = /^(.+)\.html?$/i.exec(file.file)
    if (match !== null) sourceByStem.set(match[1], file.file)
  }
  const exempt = new Set<string>()
  for (const file of files) {
    const stem = renderedDeckPageStem(file)
    if (stem === null) continue
    const source = sourceByStem.get(stem)
    // 源文件在包里、且它自己没顶上任何槽 —— 这一页是那份交付物唯一的进场方式
    if (source !== undefined && slotOfSource(source) === MODEL_UNASSIGNED) exempt.add(file.file)
  }
  const deckPages = new Set(files.filter(isDeckPageFile).map((file) => file.file))
  for (const artifact of artifacts) {
    if (!deckPages.has(artifact.file) || exempt.has(artifact.file)) continue
    artifact.slot = MODEL_UNASSIGNED
    artifact.unassignedCause = 'deck-page'
    delete artifact.reclassification
  }
}

/** 一件待求解的产物（#3541 / #3948）。 */
export interface PendingAssignment {
  /** 指向 `artifacts[]` */
  index: number
  scores: NormalizedScores
  /** 载体决定席位容差，见 `carrierKind.CARRIER_SEAT_TOLERANCE` */
  carrier: 'document' | 'image' | 'video'
}

/**
 * 源文件的**判官首选**（#3948）：只看分数、不看容量时它会去的槽。
 *
 * `excludeDeckPagesFromSlots` 的例外问的是「这份源文件自己属不属于某个槽」。求解前它的槽还是
 * 占位值，读槽会把每一份源文件都读成「不属于任何槽」、放行它的全部渲染页去抢图像槽
 * （#3782 否决 P1 的第 2 条理由）。首选只由判官分数决定，求解前就已确定，没有先后依赖。
 * 分类失败、没有分数的源文件与旧规则一致：读它的占位槽（`unassigned`），渲染页放行。
 */
export function deckSourcePreferredSlot(
  artifacts: readonly Pick<ScoredArtifact, 'file' | 'slot'>[],
  pending: readonly Pick<PendingAssignment, 'index' | 'scores'>[],
): (file: string) => string {
  const preferred = new Map(pending.map((entry) => [artifacts[entry.index].file, preferredSlotOf(entry.scores.scores, entry.scores.unassignedScore)]))
  const slotByFile = new Map(artifacts.map((artifact) => [artifact.file, artifact.slot]))
  return (file) => preferred.get(file) ?? slotByFile.get(file) ?? MODEL_UNASSIGNED
}

/** 确定性归属（视频）与旧题面单槽回复在求解器里的形态：该槽满分，其余不可行。 */
export function singleSlotScores(slot: string, reason: string, confidence: 'high' | 'low'): NormalizedScores {
  return { scores: new Map([[slot, MAX_FIT_SCORE]]), unassignedScore: 0, confidence, reason, unknownSlots: [], degraded: null }
}

/** 文档件在各文档槽上的占席位加分（#3948）：只对有页数下限、且不是逐页分组的槽。 */
export function documentSeatBonus(
  slots: ReadonlyArray<Pick<SlotSpec, 'id' | 'minPages' | 'deliveryGrouping'>>,
  pages: number | undefined,
): Map<string, number> {
  const bonus = new Map<string, number>()
  for (const slot of slots) {
    if (slot.minPages === undefined || slot.deliveryGrouping === 'pages') continue
    const value = pageFloorSeatBonus(pages, slot.minPages)
    if (value > 0) bonus.set(slot.id, value)
  }
  return bonus
}

/** 截图文件夹候选给判官看的图：第一张、中间一张、最后一张（去重后按序）。 */
export function imageSeriesSamples(members: readonly string[]): string[] {
  return [...new Set([members[0], members[Math.floor((members.length - 1) / 2)], members[members.length - 1]])]
}

/** 截图文件夹里被判官认作一份文档的一组（#3948）：成员按序，第一张是代表件。 */
export interface ImageSeriesProposal {
  /** 文件名干（数字换成 `#`） */
  stem: string
  members: string[]
  /** 判官把整组当一件文档给的分 */
  scores: NormalizedScores
}

/**
 * 截图文件夹（#3948）第一步：结构规则提出的候选组，由判官判它**像不像**一份文档。
 *
 * 判官看到的证据：组内张数（作页数）、文件名干（数字换成 `#`）、组内文件名（最多 40 个），以及
 * 按序号取的第一张、中间一张、最后一张。回复形状与文档打分相同（每个文档槽一个分，加 `unassigned`）。
 * 最高文档槽分严格高于 `unassigned` 分（同一条相对门）才成为提名；认不认由 {@link adoptImageSeries} 决定。
 * 每组一次判官调用，结果进缓存（键 = 三张图的字节 + 渲染后的 prompt）。
 */
async function proposeImageSeries(input: {
  runDir: string
  manifestFiles: readonly ExportedFile[]
  artifacts: readonly ScoredArtifact[]
  pending: readonly PendingAssignment[]
  slots: readonly SlotSpec[]
  cacheDir: string
}): Promise<ImageSeriesProposal[]> {
  const candidates = imageSeriesCandidates(input.manifestFiles.filter((file) => file.role === 'primary'))
  if (candidates.length === 0) return []
  const carrierByFile = new Map(input.pending.map((entry) => [input.artifacts[entry.index].file, entry.carrier]))
  const contentTypeByFile = new Map(input.artifacts.map((artifact) => [artifact.file, artifact.contentType]))
  const slotIds = input.slots.map((slot) => slot.id)
  const base = renderClassifyScoresPrompt(input.slots)
  const proposals: ImageSeriesProposal[] = []
  for (const candidate of candidates) {
    // 只收已经作为图像件进了求解的成员：分类失败的件本来就不参与归属
    const members = candidate.members.filter((file) => carrierByFile.get(file) === 'image')
    if (members.length < IMAGE_SERIES_MIN_MEMBERS) continue
    const header = [
      '[Image set]',
      `This artifact is a set of ${members.length} images in one folder, file name pattern "${candidate.stem}".`,
      'Files, in order:',
      ...members.slice(0, 40),
      'The attached images are the first, a middle and the last image of the set, in order.',
      'Score the WHOLE SET as ONE artifact (for example, one presentation delivered as page screenshots).',
      'If the images are separate deliverables rather than pages of one document, score "unassigned" high.',
    ].join('\n')
    const text = `${base.text}\n\n${header}`
    let reply: unknown = null
    try {
      reply = await askSetVlm<unknown>({
        images: imageSeriesSamples(members).map((file) => ({
          path: path.join(input.runDir, 'artifacts', file),
          contentType: contentTypeByFile.get(file)!,
        })),
        prompt: text,
        promptSha: promptSha(text),
        cacheDir: input.cacheDir,
      })
    } catch (error) {
      if (!(error instanceof VlmUnreadableError)) throw error
      continue
    }
    const normalized = normalizeClassifyScores(reply, slotIds)
    if (!normalized.ok) continue
    if (preferredSlotOf(normalized.value.scores, normalized.value.unassignedScore) === UNASSIGNED_SLOT) continue
    proposals.push({ stem: candidate.stem, members, scores: normalized.value })
  }
  return proposals
}

/**
 * 把一组截图当成一件文档之后的状态（纯函数，返回新数组）：代表件（第一张）换成这一组的文档分、
 * 页数 = 张数；其余成员作为它的页记 `deck-page` 退出归槽面。代表件自己若被 deck 页规则判掉过
 * （JH 的 `pages/page_NN.png`），这里撤销 —— 它已经不是某份文档的一页，而是那份文档本身。
 */
export function withImageSeries(
  proposal: ImageSeriesProposal,
  artifacts: readonly ScoredArtifact[],
  pending: readonly PendingAssignment[],
): { artifacts: ScoredArtifact[]; pending: PendingAssignment[] } {
  const [representative, ...pages] = proposal.members
  const pageSet = new Set(pages)
  const nextArtifacts = artifacts.map((artifact) => {
    if (artifact.file === representative) {
      const document: ScoredArtifact = {
        ...artifact,
        documentPages: proposal.members.length,
        classifierConfidence: proposal.scores.confidence,
        classifierReason: `image set of ${proposal.members.length} ("${proposal.stem}") read as one document: ${proposal.scores.reason}`,
      }
      delete document.unassignedCause
      return document
    }
    if (!pageSet.has(artifact.file)) return artifact
    const page: ScoredArtifact = { ...artifact, slot: MODEL_UNASSIGNED, unassignedCause: 'deck-page' }
    delete page.reclassification
    return page
  })
  const nextPending = pending.map((entry) => artifacts[entry.index].file === representative
    ? { ...entry, scores: proposal.scores, carrier: 'document' as const }
    : entry)
  return { artifacts: nextArtifacts, pending: nextPending }
}

/**
 * {@link adoptImageSeries} 穷举的提名组数上限：2^16 次求解。实测一次求解（60 件 × 24 槽）约 0.5 ms，
 * 封顶时约一分钟。v0.6 五个打分集里一格的**候选**组最多 14 个（OD infovis-base-b-n24；其余 ≤ 12，
 * gm 两集 ≤ 1），提名组只会更少，故现有全部格都在上限内。超过上限直接报错（该格评估失败、
 * `--continue-on-error` 下其余格照跑），不静默退化成逐组贪心 —— 贪心会把结果弄反（见下）。
 */
export const IMAGE_SERIES_MAX_PROPOSALS = 16

/**
 * 截图文件夹（#3948）第二步：判官提名的组里认下哪几组，由**占席位总分**决定 —— 穷举提名组的全部
 * 子集，取总分最高的那一种；同分取认得少的（维持逐张，与相对门「严格高于」同向），再同取序靠前的。
 *
 * 判官只看组本身，看不到「这些图逐张看各自对上了哪个槽」。实测反例（Codex book-material-01）：
 * 六张正式跨页图 `05-photo-spread_pages-04-05_p64_FINAL.png` … `10-…` 数字抹掉后文件名相同，
 * 判官把它们读成一份 12 页的汇报。同一格里 13 张 `slide-NN.png` 是真的汇报 deck，其中九张也画着
 * 跨页。只认后者：正式跨页图占跨页槽、deck 占汇报槽，总分最高；只认前者：跨页槽让给幻灯片
 * （判官给它们的分更低，slide-07 只有 60），总分更低。
 *
 * **必须是子集穷举，不能逐组贪心。** 逐组时先轮到的跨页组会被认下 —— 此刻幻灯片还逐张在场，能把
 * 跨页槽顶上，总分确实变高 —— 轮到幻灯片组时汇报槽已经被占，它反而认不下，结果正好颠倒。
 *
 * 比较的量就是求解器最大化的那个量（`seatedTotalOf`），不另立判据、不多调判官。
 */
export function adoptImageSeries(input: {
  proposals: readonly ImageSeriesProposal[]
  artifacts: ScoredArtifact[]
  pending: PendingAssignment[]
  seatedTotalOf: (artifacts: readonly ScoredArtifact[], pending: readonly PendingAssignment[]) => number
}): { artifacts: ScoredArtifact[]; pending: PendingAssignment[] } {
  const { proposals } = input
  if (proposals.length > IMAGE_SERIES_MAX_PROPOSALS) {
    throw new Error(`${proposals.length} image-set proposals exceed IMAGE_SERIES_MAX_PROPOSALS (${IMAGE_SERIES_MAX_PROPOSALS})`)
  }
  let best = { state: { artifacts: input.artifacts, pending: input.pending }, total: input.seatedTotalOf(input.artifacts, input.pending), size: 0 }
  for (let mask = 1; mask < 1 << proposals.length; mask += 1) {
    let state = { artifacts: input.artifacts, pending: input.pending }
    let size = 0
    proposals.forEach((proposal, bit) => {
      if ((mask & (1 << bit)) === 0) return
      state = withImageSeries(proposal, state.artifacts, state.pending)
      size += 1
    })
    const total = input.seatedTotalOf(state.artifacts, state.pending)
    if (total > best.total || (total === best.total && size < best.size)) best = { state, total, size }
  }
  return best.state
}

/**
 * 进入归槽求解的候选件（#3548）。
 *
 * **规则性排除必须发生在求解之前。** 逐件分类的旧结构里「事后撤出」与「事前排除」是等价的 ——
 * 每件独立判，撤一件不影响别件。整体指派把这个等价关系打破了：求解是全局的，任何一件的存在
 * 都改变别件的落点，而事后撤出它并不会把席位还回去。
 *
 * 判据是「这一件已经被某条规则判成没有归属了吗」（`unassignedCause` 非空），不是「它是不是
 * deck 页」—— 前者是这条纪律本身，后者只是它今天唯一的实例。
 */
export function seatableForAssignment<T extends { index: number }>(
  pending: readonly T[],
  artifacts: readonly Pick<ScoredArtifact, 'unassignedCause'>[],
): T[] {
  return pending.filter((entry) => artifacts[entry.index].unassignedCause === undefined)
}

/**
 * 求解跑完之后的残留断言（#3548）：被排除规则判掉的件，到最后必须还是没有归属。
 *
 * **断言而不是再撤一次。** 再撤一次会把「顺序错了」这件事悄悄吃掉，而顺序正是本条的全部内容 ——
 * 席位一旦被占走就不会自己还回来，撤了也只是把错误从「可见」变成「不可见」。
 *
 * 判据取的是**排除规则自己的裁决**（`unassignedCause`），不是「这一件是不是 deck 页」。
 * 两者不等价：`excludeDeckPagesFromSlots` 刻意放行一种 deck 页 —— 源 HTML 在包里、且源文件
 * 自己没顶上任何槽，那一页是那份交付物唯一的进场方式，它**允许**坐在槽里。按 deck 页全集数
 * 会把这种例外当成违规（实测在 OD 两格上误报）。守的是顺序，不是形态。
 */
export function assertNoSeatedDeckPage(
  artifacts: readonly Pick<ScoredArtifact, 'file' | 'slot' | 'unassignedCause'>[],
): void {
  const seated = artifacts.find((artifact) => artifact.unassignedCause !== undefined && artifact.slot !== MODEL_UNASSIGNED)
  if (seated === undefined) return
  throw new Error(
    `"${seated.file}" was ruled out of slots (${seated.unassignedCause}) but still holds slot "${seated.slot}" `
    + 'after slot assignment — rule-based exclusion must run before solveSlotAssignment (#3548)',
  )
}

export { isDocumentClassifiableCarrier } from './evaluator/documentCarrier'

/**
 * 人工标签该跟**哪个**槽比（#3782）。
 *
 * 答案是 `assignment.preferred`，不是最终的 `artifact.slot`。#3541 之后最终落点是
 * 「分类器分数 + 容量约束」的合成结果，而**人在标注时脑子里没有容量约束** —— 人给出的是首选。
 * 拿这两种不同性质的判断去算 κ，量到的一部分是「这一件被席位约束挪开了」，而那不是分类器判错。
 *
 * 实测代价（41 个 GM 包、1054 件带 `assignment` 的产物）：`slot !== preferred` 的有 66 件，
 * 6.3%。其中 63 件是抢不到席位被挪走的（`placement: 'seat'` 且 `displaced`）。
 * 263 个 `overflow` 落点里有 261 个 `slot === preferred`——它们落在自己首选的槽上、
 * 只是以挂靠身份，对 κ 没有影响。
 *
 * 旧包没有 `assignment` 字段（#3541 之前）时回退到 `slot`：那时两者本来就是同一个东西
 *（逐件独立判，落点就是首选）。**不回填、不猜**，与 #3677 对旧包的处置同源。
 */
export function labelComparisonSlot(
  artifact: Pick<ScoredArtifact, 'slot' | 'assignment'>,
): string {
  return artifact.assignment?.preferred ?? artifact.slot
}

export function tallyUnassignedCauses(
  artifacts: readonly ScoredArtifact[],
): Record<UnassignedCause | 'modelChoice' | 'transcription-failed', number> {
  const tally = {
    'classifier-unknown-slot': 0,
    'page-floor': 0,
    'classify-failed': 0,
    // #3677 `classify-failed` 的一个子档：分类调用本身没毛病，是**这一件读不出内容**，
    // 所以分类器手里根本没有可判的东西。两者的出路不同 —— 前者重问一次可能就有答案，
    // 后者要换一种能被读出来的交付形态。混在一格里时 `m1FailingSlotCount` 的成因不可区分。
    // 只在这里分档、不新增 `UnassignedCause` 取值：判定层（M1 / R-delivery）对两者的处置
    // 完全相同（都是「没测出来」），给它们不同的取值只会让那条判据多一个分支。
    'transcription-failed': 0,
    'content-type': 0,
    // #3540 规则性排除，不是问不出结果。这一档的计数就是「这条规则本轮拦下了多少件」——
    // 缺席不能是静默的，读表人要能看出交付面被这条规则改动了多少。
    'deck-page': 0,
    modelChoice: 0,
  }
  for (const artifact of artifacts) {
    if (artifact.slot !== 'unassigned') continue
    if (artifact.unassignedCause === undefined) tally.modelChoice += 1
    else if (artifact.unassignedCause === 'classify-failed' && artifact.transcriptionFailed === true) tally['transcription-failed'] += 1
    else tally[artifact.unassignedCause] += 1
  }
  return tally
}

/** 像素命中：图里是否存在与目标色每通道差都 <= tolerance 的像素。 */
async function pixelHit(file: string, hex: string, tolerance: number): Promise<boolean> {
  const target = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16))
  const { data, info } = await sharp(file)
    .resize(128, 128, { fit: 'inside', kernel: 'nearest' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  for (let i = 0; i + 2 < data.length; i += info.channels) {
    if (
      Math.abs(data[i] - target[0]) <= tolerance
      && Math.abs(data[i + 1] - target[1]) <= tolerance
      && Math.abs(data[i + 2] - target[2]) <= tolerance
    ) return true
  }
  return false
}

/** 侧车不可用的原因只提示一次（见 evaluateRun 里的风格块）。 */
const warnedStyleUnavailable = new Set<string>()

export async function evaluateRun(
  runDir: string,
  spec: TaskSpec,
  cacheDir: string,
  assetBindings: IdentityAssetBindings,
  evidence: EvidenceSurface = 'pixel',
  originalSpecFile?: string,
  /**
   * 这一轮跑不跑 M3 设计质量（#3765）。**缺省不跑** —— 单图设计质量改由上游
   * Qwen-Image-Bench 单独出（指南 §2.4 方案 B），本评估器这一把只在显式 `--dq` 时才花钱。
   * 关掉时 `score.designQuality` 记 `not-run`，且三个 dq 身份字段一律不写 —— 后者让
   * 「跑过 M3 的包」与「没跑的包」算出不同的可比性键，混表在比较那一步就被拒。
   */
  runDesignQuality = false,
): Promise<EvaluationOutput> {
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')) as EvaluationManifest
  const corpusPaths = evaluationCorpusPaths(manifest)
  if (manifest.manifestVersion < REQUIRED_MANIFEST_VERSION) {
    throw new Error(
      `${runDir}: manifestVersion ${manifest.manifestVersion} < ${REQUIRED_MANIFEST_VERSION}. `
      + 'Re-export with `pnpm bench:export-artifacts`. Older packs are refused rather than best-efforted: '
      + 'v2 cannot separate delivered artifacts from platform thumbnails (scoring them invents constraint '
      + 'violations on low-res derivatives), and v4 and earlier carry no text artifacts at all (#3128) — '
      + 'every written deliverable would be scored as never produced.',
    )
  }

  // 图像分类 prompt 只列**收图片的槽**。视频槽走 Content-Type 确定性归属，混进 prompt 只会
  // 诱导分类器把某张静态图判成"视频"。
  const classifiable = imageSlots(spec).map(slot => slot.deliveryGrouping === 'pages' ? { ...slot, minPages: undefined } : slot)
  // #3541 图像归属面改成打分式：分类器对每个候选槽各回一个分数，谁占哪个席位由
  // `solveSlotAssignment` 在容量约束下一次性求解。#3948 起 v3 的文档件也走打分式、进同一次求解。
  // 页数下限在求解里**不**建成门（#3803：页数是读数），只作有页数下限的文档槽上的占席位加分。
  const classifyScoresPrompt = renderClassifyScoresPrompt(classifiable)

  // #3128 文本通道的分类面是**收文档的槽**。#3138 起它与图像面**可以重叠** —— 一个"概览页"
  // 既能是渲染图也能是可交互页面，两条通道各自把自己那种载体归到同一个槽 id 上。
  // 一份 spec 没声明任何文档槽时这里是空集 —— 那时所有文本产物判 unassigned，
  // 是正确的：题面要的就是视觉实质的交付物（logo / 渲染图 / 物料板）。
  const textClassifiable = documentSlots(spec).map(slot => slot.deliveryGrouping === 'pages' ? { ...slot, minPages: undefined } : slot)
  const textClassifyPrompt = textClassifiable.length > 0 ? renderClassifyPrompt(textClassifiable) : null
  const primary = manifest.files.filter((file) => file.role === 'primary')
  if (spec.specVersion === 3 && evidence !== 'pixel') throw new Error('TaskSpec v3 requires real artifact evidence; structural placeholders cannot satisfy public requirements')
  const requirementArtifacts = spec.specVersion === 3 ? await prepareRequirementArtifacts(runDir, primary, cacheDir) : new Map<string, ArtifactEvidence>()
  const publicInputs = spec.specVersion === 3 ? readPublicRequirementInputs(spec, corpusPaths.benchmarkVersion ?? 'v0.1') : []
  // 结构判据要图；`pixel` 档一行也不读，导出包缺 workflowFile 也照旧能跑。
  const graph = evidence === 'prompt' ? loadStructuralGraph(runDir, manifest.workflowFile) : null

  // #3488 发出去之前被等比缩过的图。按文件名去重：同一张图会经过分类与转写两次调用，
  // 两次缩法一样（纯函数），记一条就够。
  const imageNormalizations = new Map<string, ImageNormalization>()
  // #3488 回退重判**延后到全部件判完**：要问的是「除了那个槽它还能去哪」，而这个问题只有在
  // 知道哪些槽还缺件之后才有正确答案。原地问会把丢件换成硬塞（实测 13 件被答进一个 expected=1
  // 且早已装满的槽，代表件跟着被顶掉）。见 `resolveDeferredReasks` 的模块注释。
  const deferredReasks: DeferredReask[] = []
  // #3541 / #3948 全部有归属可言的件（图像、文档、视频）先只记分数，等全部件判完再一次性求解席位。
  // `index` 指向 `artifacts[]`，求解后按它回填。`carrier` 决定席位容差（`carrierKind.CARRIER_SEAT_TOLERANCE`），
  // `seatBonus` 是有页数下限的文档槽上的页数加分。
  const pendingAssignments: PendingAssignment[] = []

  let artifacts: ScoredArtifact[] = []
  for (const file of primary) {
    const filePath = path.join(runDir, 'artifacts', file.file)
    const prepared = requirementArtifacts.get(file.file)
    // #3948 v3 的文档件（html / pdf / pptx / docx 与全部 text/*）走打分式分类，进与图像件同一次求解。
    // 证据是原件抽取的全文，前面加结构头（页数、逐页标题、首页文字）—— 体裁最直接的证据。
    if (spec.specVersion === 3 && prepared && (isDocumentClassifiableCarrier(file.contentType) || file.contentType.startsWith('text/'))) {
      const pages = prepared.metadata.pageCount ?? file.pages
      if (textClassifiable.length === 0) {
        // 本题没有文档槽：不发请求、不记成因 —— 那不是测量失败，题面要的就是视觉实质的交付物（#3782 第 4 条）
        artifacts.push({ file: file.file, contentType: file.contentType, slot: MODEL_UNASSIGNED,
          ...(pages === undefined ? {} : { documentPages: pages }),
          classifierConfidence: 'high', classifierReason: 'spec declares no document slot — text artifacts are not part of the scored surface',
          textLines: prepared.text.split('\n'), ...(prepared.textComplete ? {} : { transcriptionFailed: true }), pixelHits: {},
          ...(file.provenance ? { provenance: file.provenance } : {}),
        })
        continue
      }
      const classified = await classifyDocumentScores(spec, prepared, cacheDir, pages)
      const placeholder = readClassifyScores({ reply: classified.reply, slots: textClassifiable,
        failedReason: 'document classification unavailable from actual content' })
      if (placeholder.scores !== null) {
        pendingAssignments.push({ index: artifacts.length, scores: placeholder.scores, carrier: 'document' })
      }
      artifacts.push({ file: file.file, contentType: file.contentType, slot: placeholder.slot,
        ...(pages === undefined ? {} : { documentPages: pages }),
        classifierConfidence: placeholder.confidence, classifierReason: placeholder.reason,
        ...(placeholder.unassignedCause ? { unassignedCause: placeholder.unassignedCause } : {}),
        textLines: classified.textLines, ...(classified.transcriptionFailed ? { transcriptionFailed: true } : {}), pixelHits: {},
        ...(file.provenance ? { provenance: file.provenance } : {}),
      })
      continue
    }

    // #3128 文本通道：文字交付物过**同一个**分类 prompt，只是喂文本而不是像素。
    // 不走 `assignNonImageSlot` 的确定性归属 —— 那条是为视频设计的（一份 spec 至多一个
    // 视频槽，无歧义），而文档槽可以有好几个（研究简报 / 结构图 / 规范页 …），
    // 按 Content-Type 归属会把它们全塞进第一个文档槽。
    // 转写在这条通道上是恒等的：文本自己就是转写结果，省掉一半评估器往返。
    if (file.contentType.startsWith('text/')) {
      const body = fs.readFileSync(filePath, 'utf-8')
      let classified: ClassifyReply | null = null
      if (textClassifyPrompt !== null) {
        try {
          classified = await askTextEvaluator<ClassifyReply>({
            textPath: filePath, prompt: textClassifyPrompt.text, promptSha: textClassifyPrompt.cacheSha, cacheDir,
          })
        } catch (error) {
          if (!(error instanceof VlmUnreadableError)) throw error
          console.warn(`    ! text classification failed for ${file.file} — recorded as unassigned`)
        }
      }
      // #3488 归槽裁定：`unassigned` 是量尺的正式回答（prompt 明写它合法），非模型成因
      // 单独记 `unassignedCause`；槽名不认识时把该件换个问法重问一次。
      // #3803 起页数下限**不参与归槽** —— 页数原样记在 `documentPages` 上，够不够由
      // `scoring.ts` 的 `scorePageFloors` 在交付集上单独判。
      const assignment = await assignSlot({
        slots: textClassifiable,
        first: classified,
        ...(textClassifyPrompt === null
          ? { noSlotDeclaredReason: 'spec declares no document slot — text artifacts are not part of the scored surface' }
          : {}),
        classifyFailedReason: 'text classification failed — recorded as unassigned (measurement failure, not a missing deliverable)',
        // #3488 第一段不重问 —— 重问延后到全部件判完（那时才知道哪些槽还缺件）
        reask: async () => null,
      })
      // #3948 旧题面（v3 之前）的单槽回复也进同一次求解：按「该槽满分」收下（与 #3541 的
      // `legacy-single-slot` 降级同一条换算），席位统一由求解器配平，不再在求解前手工扣减。
      if (assignment.slot !== MODEL_UNASSIGNED) {
        pendingAssignments.push({ index: artifacts.length, scores: singleSlotScores(assignment.slot, assignment.reason, assignment.confidence), carrier: 'document' })
      }
      if (assignment.blockedSlot !== undefined && assignment.unassignedCause !== undefined) {
        deferredReasks.push({
          index: artifacts.length, slots: textClassifiable,
          cause: assignment.unassignedCause, blockedSlot: assignment.blockedSlot, fallback: assignment,
          ask: async (slots, note) => {
            const retryPrompt = renderClassifyPrompt(slots, note ?? undefined)
            try {
              return await askTextEvaluator<ClassifyReply>({
                textPath: filePath, prompt: retryPrompt.text, promptSha: retryPrompt.cacheSha, cacheDir,
              })
            } catch (error) {
              if (!(error instanceof VlmUnreadableError)) throw error
              return null
            }
          },
        })
      }
      artifacts.push({
        file: file.file,
        contentType: file.contentType,
        slot: assignment.slot,
        classifierConfidence: assignment.confidence,
        classifierReason: assignment.reason,
        ...(assignment.unassignedCause === undefined ? {} : { unassignedCause: assignment.unassignedCause }),
        ...(assignment.reclassification === undefined ? {} : { reclassification: assignment.reclassification }),
        // 页数原样留档（manifest 给了才有）。文本载体多半没有页数这个概念 ——
        // 那正是 `scorePageFloors` 要如实报「没测出来」的那一档，不是「页数不够」。
        ...(file.pages === undefined ? {} : { documentPages: file.pages }),
        // 文本产物的"转写"是它自己。空行保留：逐字约束按整段归一化匹配，行边界不参与判定。
        textLines: body.split('\n'),
        // 像素约束对文本没有对应物 —— 留空而不是记 false：false 会被读成"查过且没命中"。
        pixelHits: {},
        // #3444：手写的 HTML / SVG 交付物走的是**这条**通道（它们按 text/* 报），
        // 而它们正是交付方式那一列最该认出来的一种件。漏在这里的话，manifest 登记得
        // 再对也没用 —— 评估器读不到就只能记成「这一列对它不适用」。实测 OpenDesign
        // case-25 的四件手写单页 HTML 就是这样丢的
        ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
      })
      continue
    }

    if (!file.contentType.startsWith('image/')) {
      const assignedSlot = assignNonImageSlot(spec, file.contentType)
      // 页数照读（manifest 没给就从 PDF 自己读），但**只作读数** —— #3803 起它不决定归属。
      // 读不出 = 页数不可知，`scorePageFloors` 把那一档如实报成「没测出来」而不是「页数不够」。
      const pages = file.pages ?? (file.contentType === 'application/pdf' ? await readPdfPageCount(filePath) : undefined)
      // #3488 这条通道没有分类器，唯一的未归槽成因是确定性的：没有任何槽接受这种载体
      // （`content-type`）。那不是「系统没交这一件」，故记成因。
      const unassignedCause = assignedSlot === 'unassigned' ? 'content-type' as const : undefined
      // #3948 确定性归属也进同一次求解（该槽满分）：席位只由求解器配平，没有第二条写入路径
      if (assignedSlot !== 'unassigned') {
        pendingAssignments.push({ index: artifacts.length, scores: singleSlotScores(assignedSlot, 'assigned by Content-Type', 'high'), carrier: 'video' })
      }
      artifacts.push({
        file: file.file,
        contentType: file.contentType,
        slot: assignedSlot,
        classifierConfidence: 'high',
        classifierReason: assignedSlot === 'unassigned'
          ? `no slot accepts Content-Type "${file.contentType}" (deterministic assignment, no classifier call)`
          : 'assigned by Content-Type (non-image deliverable, no classifier call)',
        ...(unassignedCause === undefined ? {} : { unassignedCause }),
        ...(pages === undefined ? {} : { documentPages: pages }),
        textLines: [],
        // #3590 这条通道上**不存在转写这一步** —— 视频、音频、以及没走文档证据的 PDF 都从这里进来，
        // 它们的 `textLines` 恒为空。不标的话逐字约束会把空数组读成「读过了、这一件没写这个词」，
        // 记一次未命中并把整条约束拉成 fail。实测代价：14 件全交齐的一轮，三条 text-verbatim 因为
        // 作用面里有一支 mp4 全判 fail，M1 跟着被翻成失败（失败证据里 `sawInstead` 是空数组 ——
        // 那正是「什么都没读到」的自证）。与上面结构判据通道同一条处置，理由也同一条。
        transcriptionFailed: true,
        transcriptionAbsence: 'no-transcript-carrier',
        pixelHits: {},
        // #3444：视频件走这条通道，它在交付方式那一列的定义域里。原样抄，不推断
        ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
      })
      continue
    }

    // #3163 结构判据：证据换成"这件产物是被怎么派出去的"，槽定义与分类 prompt 一字不动。
    // 逐字约束在这条通道上**不适用** —— 占位图没有可转写的字，`textLines` 留空会让
    // 作用面内的约束判不出结果（scoring 因此把它们记为 not applicable，不是判负）。
    if (graph !== null) {
      const evidenceText = buildStructuralEvidence(graph, (file.sourceNodes ?? []).map((n) => n.nodeId))
      let structural: ClassifyScoresReply | null = null
      if (evidenceText !== null) {
        try {
          structural = await askInlineTextEvaluator<ClassifyScoresReply>({
            subject: (file.sourceNodes ?? []).map((n) => n.nodeId).join(',') || file.file,
            text: evidenceText, prompt: classifyScoresPrompt.text, promptSha: classifyScoresPrompt.cacheSha, cacheDir,
          })
        } catch (error) {
          if (!(error instanceof VlmUnreadableError)) throw error
          console.warn(`    ! structural classification failed for ${file.file} — recorded as unassigned`)
        }
      }
      // #3541 这条通道与图像通道共用同一个归属面（图像槽），所以也共用同一次求解 ——
      // 结构判据一行像素都不读，而容量约束本来就不是像素证据，两件事不冲突。
      const structuralPlaceholder = readClassifyScores({
        reply: structural,
        slots: classifiable,
        failedReason: evidenceText === null
          ? 'artifact has no source node in the exported graph — no structural evidence to classify'
          : 'structural classification failed — recorded as unassigned (measurement failure, not a missing deliverable)',
      })
      if (structuralPlaceholder.scores !== null) {
        pendingAssignments.push({ index: artifacts.length, scores: structuralPlaceholder.scores, carrier: 'image' })
      }
      artifacts.push({
        file: file.file,
        contentType: file.contentType,
        slot: structuralPlaceholder.slot,
        classifierConfidence: structuralPlaceholder.confidence,
        classifierReason: structuralPlaceholder.reason,
        ...(structuralPlaceholder.unassignedCause === undefined ? {} : { unassignedCause: structuralPlaceholder.unassignedCause }),
        textLines: [],
        // 这条证据面上**不存在**转写。标 `transcriptionFailed` 是复用既有的"这件读不出字"
        // 语义：逐字约束与 token 一致性据此把它移出作用面，全部移光就判 not-applicable
        // 而不是 fail。不标的话空 `textLines` 会被当成"读过且没写"，凭空造出违规
        //（#2415「缺席 ≠ 0」的同一个坑）。
        transcriptionFailed: true,
        transcriptionAbsence: 'no-transcript-carrier',
        pixelHits: {},
        ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
      })
      continue
    }

    // #3488 一张图分类不出来是**这一件**的问题（同下面转写失败的既有处理）。过去它直接抛，
    // 于是一次瞬时故障让整道题的读数消失 —— 那正是"把没测到记成没交付"的最重一档。
    let classified: ClassifyScoresReply | null = null
    try {
      classified = await askVlm<ClassifyScoresReply>({
        imagePath: filePath, contentType: file.contentType, prompt: classifyScoresPrompt.text, promptSha: classifyScoresPrompt.cacheSha, cacheDir,
        onNormalized: (normalization) => imageNormalizations.set(file.file, { ...normalization, file: file.file }),
      })
    } catch (error) {
      if (!(error instanceof VlmUnreadableError)) throw error
      console.warn(`    ! image classification failed for ${file.file} — recorded as unassigned`)
    }
    // 一张图读不出来不该炸掉整批评估（前科：2026-08-23 三臂批次 12 个 job 里 3 个因此整步失败）。
    // 记成 transcriptionFailed，它就退出逐字判定的作用面并进 needsManualCheck ——
    // 既不假装读到了，也不把读不到判成违规。
    let transcribed: TranscribeReply | null = null
    try {
      transcribed = await askVlm<TranscribeReply>({
        imagePath: filePath, contentType: file.contentType, prompt: TRANSCRIBE_PROMPT_TEMPLATE, promptSha: TRANSCRIBE_PROMPT_SHA, cacheDir,
        onNormalized: (normalization) => imageNormalizations.set(file.file, { ...normalization, file: file.file }),
      })
    } catch (error) {
      if (!(error instanceof VlmUnreadableError)) throw error
      console.warn(`    ! transcription failed for ${file.file} — excluded from verbatim checks`)
    }
    const pixelHits: Record<string, boolean> = {}
    for (const constraint of spec.constraints) {
      if (constraint.kind === 'pixel-color') {
        pixelHits[constraint.id] = await pixelHit(filePath, constraint.hex, constraint.tolerance)
      }
    }
    // #3541 这一件的槽在这里还定不下来 —— 它取决于同题其它件抢到了哪些席位。
    // 先把分数收下、占一个位置，全部件判完之后一次性求解（见循环之后的 `solveSlotAssignment`）。
    // #3488 的两条纪律原样保留：分类器打的分是**读数**（`unassigned` 是它的合法答案），
    // 调用失败才是仪器故障、单独记成因。
    const imagePlaceholder = readClassifyScores({
      reply: classified,
      slots: classifiable,
      failedReason: 'image classification failed — recorded as unassigned (measurement failure, not a missing deliverable)',
    })
    if (imagePlaceholder.scores !== null) {
      pendingAssignments.push({ index: artifacts.length, scores: imagePlaceholder.scores, carrier: 'image' })
    }
    artifacts.push({
      file: file.file,
      contentType: file.contentType,
      slot: imagePlaceholder.slot,
      classifierConfidence: imagePlaceholder.confidence,
      classifierReason: imagePlaceholder.reason,
      ...(imagePlaceholder.unassignedCause === undefined ? {} : { unassignedCause: imagePlaceholder.unassignedCause }),
      textLines: transcribed && Array.isArray(transcribed.lines) ? transcribed.lines : [],
      ...(transcribed === null ? { transcriptionFailed: true, transcriptionAbsence: 'call-failed' as const } : {}),
      ...(file.provenance === undefined ? {} : { provenance: file.provenance }),
      pixelHits,
    })
  }

  // #3541 / #3948 归槽求解：图像、文档、视频的席位一次性配平。
  //
  // **必须在 `resolveDeferredReasks` 之前**：旧题面文本通道的回退重判只填「还缺件的槽」，
  // 而哪些槽还缺件取决于求解结果。
  // #3548 deck 页在**进入求解之前**退出归槽面。规则性排除必须发生在求解之前：整体指派是全局的，
  // 一件不该参与的产物只要参与了，就会改变别件的落点，而事后撤出它并不会把席位还回去。
  // #3948 例外（源文件自己不属于任何槽时放行它的渲染页）读的是源文件的**判官首选**，不是它此刻的
  // 槽 —— 此刻所有待求解件的槽都还是占位值，读槽会把每一份源文件都当成「没顶上槽」。
  excludeDeckPagesFromSlots(artifacts, manifest.files, deckSourcePreferredSlot(artifacts, pendingAssignments))

  // 席位统一按槽的 `expected`（逐页分组的槽按页数，见 `imageSlotSeats`）—— 一个槽只有那么多位置，
  // 全部通道的件在同一次求解里争，不再在求解前按通道手工扣减。
  const assignmentSlots = spec.slots.map((slot) => ({ id: slot.id, seats: imageSlotSeats(slot) }))
  const assignmentItems = (arts: readonly ScoredArtifact[], seatable: readonly PendingAssignment[]) => seatable.map((entry) => ({
    key: String(entry.index),
    scores: entry.scores.scores,
    unassignedScore: entry.scores.unassignedScore,
    ...(CARRIER_SEAT_TOLERANCE[entry.carrier] === undefined ? {} : { seatTolerance: CARRIER_SEAT_TOLERANCE[entry.carrier] }),
    ...(entry.carrier === 'document' ? { seatBonus: documentSeatBonus(textClassifiable, arts[entry.index].documentPages) } : {}),
  }))

  // #3948 截图文件夹：结构规则提候选、判官提名，认下哪几组取占席位总分最高的组合（`adoptImageSeries`）。
  let pending = pendingAssignments
  if (textClassifiable.length > 0) {
    const proposals = await proposeImageSeries({ runDir, manifestFiles: manifest.files, artifacts, pending, slots: textClassifiable, cacheDir })
    ;({ artifacts, pending } = adoptImageSeries({
      proposals,
      artifacts,
      pending,
      seatedTotalOf: (arts, entries) => {
        const items = assignmentItems(arts, seatableForAssignment(entries, arts))
        return seatedTotal(items, solveSlotAssignment({ slots: assignmentSlots, items }))
      },
    }))
  }
  const seatable = seatableForAssignment(pending, artifacts)

  if (seatable.length > 0) {
    const placements = solveSlotAssignment({ slots: assignmentSlots, items: assignmentItems(artifacts, seatable) })
    placements.forEach((placement, order) => {
      const entry = seatable[order]
      const artifact = artifacts[entry.index]
      artifacts[entry.index] = {
        ...artifact,
        slot: placement.slot,
        // 模型那句话说的是「这一件是什么」；被容量挪开时补一句说明落点为什么不是它的首选，
        // 否则读 evaluation.json 的人会看到一句「这是主视觉」配着 directions 槽
        classifierReason: placement.displaced
          ? `${artifact.classifierReason} [capacity-constrained assignment: preferred "${placement.preferred}"]`
          : artifact.classifierReason,
        assignment: {
          scores: Object.fromEntries(entry.scores.scores),
          unassignedScore: entry.scores.unassignedScore,
          preferred: placement.preferred,
          placement: placement.placement,
          displaced: placement.displaced,
          ...(entry.scores.degraded === null ? {} : { degraded: entry.scores.degraded }),
          ...(entry.scores.unknownSlots.length === 0 ? {} : { unknownSlots: entry.scores.unknownSlots }),
        },
      }
    })
  }

  // #3548 残留断言：排除已经在求解之前跑过了，跑完不该再有 deck 页坐在槽里。
  // 断言而不是再撤一次 —— 再撤一次会把「顺序错了」这件事悄悄吃掉，而顺序正是本条的全部内容。
  assertNoSeatedDeckPage(artifacts)

  // #3488 回退重判在这里发生 —— 第一段全部判完、缺件情况已知，重问才有正确答案可选。
  // **只填还缺件的槽**：已经装满 expected 的槽没丢过任何东西，重问没有理由动它。
  // 必须在第二段再分配之前：再分配读的是槽位分布，分布还没定就动它等于用旧账做判断。
  await resolveDeferredReasks({
    artifacts,
    // 被规则判掉的件不进重判：那一段问的是「除了被挡下的那个槽它还能去哪」，而它哪个槽都不去
    // （#3540 的 deck 页是目前唯一实例）。判据与进求解那一步同源，不另写一遍（#3548）。
    deferred: seatableForAssignment(deferredReasks, artifacts),
    expectedBySlot: new Map(spec.slots.map((slot) => [slot.id, slot.expected])),
  })

  // #3407 第二段分类：超配槽集合内再分配。第一段逐件独立判分不开「同类画面、不同角色」（三张体量
  // 方案与一张主视觉单看都是外观透视），放在一起、附上期望件数才分得开。只在「某图像槽超配 ∧
  // 某图像槽缺件」的题触发；结构判据不读像素，跳过并记账。
  // 必须在下面第一次 `scoreSlots`（身份一致性的 anchor）之前 —— 否则身份维度用的是旧分槽。
  const redistribution = evidence === 'prompt'
    ? skippedRedistribution(artifacts, 'structural-evidence surface does not read pixels')
    : await runRedistribution({ ...spec, slots: spec.slots.map(slot => slot.deliveryGrouping === 'pages' ? { ...slot, expected: slot.minPages ?? 1 } : slot) }, artifacts, async (item, correction) => {
        const line = (slot: { id: string; label: string; description?: string; expected: number }) =>
          ({ id: slot.id, label: slot.label, description: slot.description, expected: slot.expected, count: item.counts[slot.id] ?? 0 })
        // #3529 两个附加段各自改变缓存键：重问与追问是两个不同的问题，不能命中首问那一条。
        // 都不传时渲染结果与 #3529 之前逐字节相同，首问的既有缓存照常命中
        const prompt = renderRedistributePrompt(line(item.source), item.targets.map(line), {
          ...(correction === undefined ? {} : { correction }),
          ...(item.nudge ? { deficits: item.deficits } : {}),
        })
        return askSetVlm<RedistributeReply>({
          images: item.candidates.map((candidate) => ({ path: path.join(runDir, 'artifacts', candidate.file), contentType: candidate.contentType })),
          prompt: prompt.text,
          promptSha: prompt.cacheSha,
          cacheDir,
        })
      })
  artifacts = redistribution.artifacts
  const finalSelection = spec.specVersion === 3 ? await judgeFinalSelection({ spec, artifacts, finalMessage: manifest.finalMessage?.text ?? '', cacheDir }) : undefined
  if (finalSelection) artifacts = applyFinalSelection(artifacts, finalSelection)

  const primaryMedia = primary.filter((file) => file.contentType.startsWith('image/') || file.contentType.startsWith('video/'))
  const primaryText = primary.filter((file) => file.contentType.startsWith('text/'))
  const completed = manifest.generationJobs
    .filter((job) => job.status === 'COMPLETED')
    .reduce((sum, job) => sum + job.count, 0)

  const runVerdict = manifest.runVerdict ?? null
  const measurement = assessMeasurement({
    runVerdict,
    primaryMediaCount: primaryMedia.length,
    primaryTextCount: primaryText.length,
    completedRequests: completed,
  })
  // #3529 归槽残留错配的出口。第二段跑完仍有「超配 ∧ 缺件」共现时，这一格的 M1 缺件读数
  // 分不出「真的没交」与「交了但归错槽」，标为不可判、进诊断不进主表分母。
  const slotAssignment = assessSlotAssignment({ residualCoOccurrence: redistribution.diagnostics.residualCoOccurrence })

  const claimedHex = extractHexTokens(manifest.finalMessage ? [manifest.finalMessage.text] : [])
  const deliveredHex = extractHexTokens(artifacts.flatMap((artifact) => artifact.textLines))

  // #3172 声明侧观测 —— **输入面只有终答文本 + 槽位清单**。不传 arm / runKey / 产物 /
  // 完成度结果：抽取器一旦看见产物就会被产物影响，false completion 会系统性趋近 0。
  // 两侧分别测量，作差在 `scoreFalseCompletion` 里发生。
  let claims: ClaimExtraction | null = null
  let claimUnavailable = 'no claim channel: the run produced no final message'
  if (manifest.finalMessage !== null) {
    try {
      claims = await extractClaims({
        subject: manifest.runKey,
        finalMessageText: manifest.finalMessage.text,
        slots: spec.slots.map((slot) => ({ id: slot.id, label: slot.label })),
        cacheDir,
      })
    } catch (error) {
      if (!(error instanceof VlmUnreadableError)) throw error
      // 一条终答读不出来不该炸掉整批评估（同转写失败的既有处理）。记 not-applicable
      // 而不是 no —— 抽取器故障不是「系统很诚实」。
      claimUnavailable = 'claim extraction failed — the final message could not be parsed into slot claims'
      console.warn(`    ! claim extraction failed for ${manifest.runKey} — false completion recorded as not-applicable`)
    }
  }
  // #3173 身份一致性 —— 需要槽位判定（anchor = 代表件），故先算一次 slots。
  // `scoreSlots` 是纯函数、无 I/O，多调一次的代价是一次数组遍历。
  const slotVerdicts = scoreSlots(spec, artifacts)
  const identityConsistency: IdentityVerdict[] = []
  // #3566：逐条退役的理由要在这份 spec 里能查到，故把整套细则的条目原文一起传下去。
  const setRubricItemTexts = (task: typeof spec): string[] => (task.setVlmRubric ?? [])
    .flatMap((rubric) => rubric.items.map((item) => (typeof item === 'string' ? item : item.item)))
  for (const rule of spec.identityConsistency ?? []) {
    identityConsistency.push(await judgeIdentity({
      rule,
      slots: slotVerdicts,
      artifacts,
      taskId: spec.taskId,
      // #3566：分档要看锚槽是过程稿还是最终件，而那是槽的属性，判定结果里没有。
      anchorStage: rule.anchorSlot === undefined
        ? undefined
        : spec.slots.find((slot) => slot.id === rule.anchorSlot)?.stage,
      setRubricItems: setRubricItemTexts(spec),
      artifactsDir: path.join(runDir, 'artifacts'),
      // 素材锚已在批次派发前绑定同版 scenario；读取时再次核对真实路径和 SHA。
      assetBindings,
      cacheDir,
      evidenceSurface: evidence,
    }))
  }

  // #3441 M2 第二层：整套视觉一致性。与身份尺同一位置（再分配之后、scoreRun 之前），同一份 slotVerdicts。
  const setVlmRubric: SetVlmRubricVerdict[] = []
  // deck 页只按导出包的文件身份认（deckPages.ts）：外部臂的 deck 页被分类进别的图像槽，靠槽认不出来
  const deckPageFiles = new Set(manifest.files.filter(isDeckPageFile).map((file) => file.file))
  // #3531 逐件的层（形态 × 成因）。**纯诊断**：不改任何分数，只让色板配对与设计质量逐件
  // 带着自己的层落进 `evaluation.json`，报表因此能在层内给名次而不是拿汇总值跨臂排名。
  const strata = artifactStrata(manifest.files)
  for (const rule of spec.setVlmRubric ?? []) {
    setVlmRubric.push(await judgeSetRubric({
      rule, spec, slots: slotVerdicts, artifacts,
      artifactsDir: path.join(runDir, 'artifacts'),
      cacheDir,
      evidenceSurface: evidence,
      deckPageFiles,
    }))
  }

  // #3374 色板一致性 —— **本判据不调任何模型、不联网**，只解图取像素。
  // 作用面 = core 图像槽的**交付集**，与逐字约束、token 一致性同口径：被弃用的候选稿
  // 配色跑偏，不是交付缺陷。
  //
  // 结构判据面（`--evidence prompt`）上整条不判：那条面上的产物是占位图，
  // 拿它比配色量到的是占位图的配色。同 `judgeIdentity` 的 `evidenceSurface` 纪律。
  const paletteScopeSlots = new Set(
    spec.slots.filter((slot) => slotIsCore(slot) && slotAccepts(slot, 'image')).map((slot) => slot.id),
  )
  const palettes = new Map<string, Palette>()
  if (evidence === 'pixel') {
    const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
    for (const slot of slotVerdicts.filter((item) => paletteScopeSlots.has(item.slotId))) {
      for (const file of slot.delivered) {
        // 只解位图。视频抽帧比配色量到的是"抽的那一帧"，不是这套产物的配色
        if (byFile.get(file)?.contentType.startsWith('image/') !== true) continue
        const palette = await readPalette(path.join(runDir, 'artifacts', file))
        // 读不出的件**不进 Map** —— 塞一个空色板会让"读不出"变成一次真实读数
        if (palette !== null) palettes.set(file, palette)
      }
    }
  }
  const paletteConsistency: PaletteConsistencyVerdict = scorePaletteConsistency({
    palettes,
    threshold: spec.paletteConsistency?.maxMeanDeltaE,
    strata,
  })
  // #3374 CSD 风格自相似 —— 与色板**同一个作用面**（core 图像槽的交付集、只解位图），向量由 Python 侧车算出。
  // 侧车整体失败 → `unavailable`（仪器缺席），评估其余照常；结构判据面 → `not-applicable`（东西不适用），
  // 两者与「少于两件」「真不像」都必须在结果文件里分得开。
  let styleConsistency: StyleConsistencyVerdict
  if (evidence !== 'pixel') {
    styleConsistency = {
      ...scoreStyleConsistency({ embeddings: new Map() }),
      reason: 'structural evidence surface carries placeholder imagery — style cannot be judged from it',
    }
  } else {
    const byFile = new Map(artifacts.map((artifact) => [artifact.file, artifact]))
    const styleFiles: string[] = []
    for (const slot of slotVerdicts.filter((item) => paletteScopeSlots.has(item.slotId))) {
      for (const file of slot.delivered) {
        if (byFile.get(file)?.contentType.startsWith('image/') === true) styleFiles.push(file)
      }
    }
    // 少于两件时不起侧车：一件东西与自己没有一致性可言，仪器在不在都一样判 not-applicable。
    // 不这么写的话，一个只交了一件图的 run 在没装权重的机器上会读成 `unavailable`（仪器缺席），
    // 而真相是「东西不够」—— 两者在报表上是两格不同的字，聚合时也会虚高 styleUnavailableRuns。
    const embedded = styleFiles.length < 2
      ? null
      : await embedStyle(styleFiles.map((file) => path.join(runDir, 'artifacts', file)), { cacheDir })
    if (embedded === null) {
      styleConsistency = scoreStyleConsistency({ embeddings: new Map() })
    } else if (embedded.status === 'unavailable') {
      const reason = embedded.unavailable
      // 同一个原因只警告一次：一批 88 个 run 全因缺权重而不可用时，刷 88 行同样的话只会淹没别的输出
      if (!warnedStyleUnavailable.has(reason)) {
        warnedStyleUnavailable.add(reason)
        console.error(`  ! style sidecar unavailable — ${reason}`)
      }
      styleConsistency = scoreStyleConsistency({ embeddings: new Map(), unavailable: reason })
    } else {
      const embeddings = new Map(
        styleFiles.flatMap((file) => {
          const vector = embedded.style.get(path.join(runDir, 'artifacts', file))
          return vector === undefined ? [] : [[file, vector] as const]
        }),
      )
      styleConsistency = scoreStyleConsistency({
        embeddings,
        provenance: embedded.provenance ?? undefined,
        failedFiles: embedded.failures.size,
      })
    }
  }
  // #3442 前后一致 —— 复用同一份 slots（来源件 = `fromSlot` 的代表件）。提取只读 textLines，
  // 与身份尺不同，它在文本通道与图像通道上是同一条路径，故不分证据面分支。
  const carryThrough: CarryThroughVerdict[] = []
  for (const rule of spec.carryThrough ?? []) {
    carryThrough.push(await judgeCarryThrough({
      rule,
      slots: slotVerdicts,
      artifacts,
      artifactsDir: path.join(runDir, 'artifacts'),
      cacheDir,
      evidenceSurface: evidence,
    }))
  }

  // #3443 M3 设计质量：另一家族评审模型逐件打分。未声明 dqRubric → null；声明了但清单判不了 → not-applicable
  // #3765 开关关着时 → not-run（第四态），一次评审调用也不发。
  // 顺序是故意的：开关先于题面判 —— 关掉了就是「这一批没打过这把尺子」，
  // 而不是「这道题没声明 dqRubric」；两件事写成同一个值就再也分不开。
  let designQuality: DesignQualityResult | null = runDesignQuality
    ? null
    : { verdict: 'not-run', reason: 'M3 not run for this evaluation (pass --dq to bench:evaluate to run it; single-image design quality otherwise comes from upstream Qwen-Image-Bench)' }
  if (runDesignQuality && spec.dqRubric !== undefined) {
    const checklist = resolveChecklist(spec.dqRubric)
    designQuality = Array.isArray(checklist)
      ? await judgeDesignQuality({
          spec, rubric: spec.dqRubric, checklist, slots: slotVerdicts, artifacts,
          artifactsDir: path.join(runDir, 'artifacts'),
          cacheDir,
          evidenceSurface: evidence,
          rendered: rendererProducedFiles(manifest),
          strata,
        })
      : { verdict: 'not-applicable', kind: checklist.excluded, checklistVersion: spec.dqRubric.checklistVersion, reason: checklist.reason }
  }
  const falseCompletionInput: FalseCompletionInput = {
    claimsAllComplete: claims === null ? null : claims.claimsAllComplete,
    unavailableReason: claimUnavailable,
    measurementValid: measurement.valid,
  }
  const reviewFile = path.join(runDir, 'requirement-reviews.json')
  const manualReviews: unknown = spec.specVersion === 3 && fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : []
  if (!Array.isArray(manualReviews)) throw new Error(`${reviewFile}: expected an array of explicit review records`)
  const requirements = spec.specVersion === 3 ? await judgeRequirementChecks({ checks: spec.requirementChecks ?? [], spec,
    specSha: originalFileSha(originalSpecFile ?? corpusPaths.taskFile), manifestSha: originalFileSha(path.join(runDir, 'manifest.json')),
    originalFileNames: new Map(primary.flatMap(file => file.originalFileName ? [[file.file, file.originalFileName] as const] : [])),
    artifacts, slots: slotVerdicts, evidenceByFile: requirementArtifacts, publicInputs, cacheDir, manualReviews, finalSelection,
  }) : undefined

  // #3176: revision 判定的输入是 manifest 里的注入留档。`?? null` 覆盖 v9 及更早的包
  // （没有这个字段）—— 它们判 not-applicable，既有批次一列不动。
  const score = scoreRun(spec, artifacts, falseCompletionInput, identityConsistency, manifest.mutations ?? null, setVlmRubric, paletteConsistency, carryThrough, designQuality, styleConsistency)

  return {
    evaluatorVersion: EVALUATOR_VERSION,
    runVerdict,
    // #3163：结构判据带后缀 —— 两条证据面的数值不可跨批比较，名字里必须看得见。
    rubricVersion: evidence === 'prompt' ? `${RUBRIC_VERSION}+structural` : RUBRIC_VERSION,
    classifierModel: EVALUATOR_MODEL_ID,
    sampling: EVALUATOR_SAMPLING,
    // 这里记的是**评估器身份**（模板 sha），不是缓存键。槽位清单逐题不同，把它算进
    // 身份会让同一批次里不同题的 cell 互相判为"不同评估器"，compareArms 的可比性闸
    // 会拒绝一张本来完全正当的对照表。缓存键另有其值（render*Prompt().cacheSha）。
    prompts: { classifySha: CLASSIFY_PROMPT_SHA, classifyScoresSha: CLASSIFY_SCORES_PROMPT_SHA, transcribeSha: TRANSCRIBE_PROMPT_SHA, claimSha: CLAIM_PROMPT_SHA, identitySha: IDENTITY_PROMPT_SHA, redistributeSha: REDISTRIBUTE_PROMPT_SHA, setRubricSha: SET_RUBRIC_PROMPT_SHA, sourceSetRubricSha: SOURCE_SET_RUBRIC_PROMPT_SHA, carryExtractSha: CARRY_EXTRACT_PROMPT_SHA, carryTemperamentSha: CARRY_TEMPERAMENT_PROMPT_SHA, ...(runDesignQuality ? { dqSha: DQ_PROMPT_SHA } : {}), requirementSha: REQUIREMENT_CHECK_PROMPT_SHA, finalSelectionSha: FINAL_SELECTION_SHA },
    // M3 的身份是评估器常量，与题无关：同一批次里有没有 dqRubric 的题必须算同一个评估器。
    // **开关关着时三个字段一律不写**（#3765）—— 这不是省几个字段，是让「跑过 M3 的包」与
    // 「没跑的包」算出不同的可比性键（`compareArms.evaluatorIdentity` 用 `?? 'none'` 读它们），
    // 混表在比较那一步就被拒。否则一张表里一半格有 M3 一半没有，均值建立在不同的格集上。
    ...(runDesignQuality ? { dqChecklistSha: DQ_CHECKLIST_SHA['dq-v1'], dqJudgeModel: DQ_JUDGE_MODEL_ID } : {}),
    pixelStrategy: evidence === 'prompt' ? 'n/a — structural evidence surface (no pixels read)' : PIXEL_STRATEGY,
    // #3374：色板判据的规则版本随读数一起走 —— 跨版本的 ΔE 数值不可同图
    paletteRuleVersion: PALETTE_RULE_VERSION,
    styleRuleVersion: STYLE_RULE_VERSION,
    csdWeightsSha256: styleConsistency.weightsSha256,
    manifestVersion: manifest.manifestVersion,
    specVersion: spec.specVersion,
    taskId: spec.taskId,
    taskSetSha: taskSetSha(path.dirname(originalSpecFile ?? corpusPaths.taskFile)),
    ...(corpusPaths.benchmarkVersion ? { benchmarkVersion: corpusPaths.benchmarkVersion } : {}),
    runKey: manifest.runKey,
    evaluatedAt: new Date().toISOString(),
    artifacts,
    ...(requirements ? { requirements } : {}),
    ...(finalSelection ? { finalSelection } : {}),
    score,
    diagnostics: {
      derivedFiles: manifest.files.filter((file) => file.role === 'derived').map((file) => file.file),
      // #3498: 第三档恒写。#3439 之前的包一件都没有 → `[]`，与「本改动之前评估的包」（字段缺席）可分。
      inputFiles: manifest.files.filter((file) => file.role === 'input').map((file) => file.file),
      // #3803 页数结论的唯一来源是 `score.formatCompliance` —— 它判的是**交付集**里的件
      // （归槽之后），而不再是「被挡在槽外的件」。两种成因刻意不合成一个数：
      // `below-floor` 是真读数，`unknown-page-count` 是交付形态没有页数这个概念。
      pageFloorRejections: score.formatCompliance.slots.flatMap((floor) => [
        ...floor.below.map((item) => ({ file: item.file, slot: floor.slotId, floor: floor.floor, pages: item.pages, reason: 'below-floor' as const })),
        ...floor.unmeasured.map((file) => ({ file, slot: floor.slotId, floor: floor.floor, pages: null, reason: 'unknown-page-count' as const })),
      ]),
      // #3703: 纯诊断，不进 score 段。顺序跟着 `requirementArtifacts` 的插入序，与 `artifacts` 同源。
      evidenceLimitations: [...requirementArtifacts].flatMap(([file, evidence]) =>
        evidence.limitations.map((item) => ({ file, channels: item.channels, message: item.message }))),
      unassignedCauses: tallyUnassignedCauses(artifacts),
      imageNormalizations: [...imageNormalizations.values()],
      evaluatorTransportFailures: [...readEvaluatorTransportFailures(runDir)],
      needsManualCheck: [
        // #3593 评审调用传输层失败的件：这一件没判，不是没交、也不是判了不过
        ...readEvaluatorTransportFailures(runDir).map((failure) => ({
          // 主体可能是「锚 vs 被查件」两条路径的拼接，只剥目录前缀，不做 relative
          file: failure.subject.split(path.join(runDir, 'artifacts') + path.sep).join(''),
          slot: '*',
          confidence: 'n/a',
          reason: `evaluator call not answered — ${failure.message}`,
        })),
        ...artifacts
          // 结构判据下 `transcriptionFailed` 对**每一件**都成立（这条面上没有转写这回事），
          // 拿它当异常信号会把整张清单填满，真正该人看的两类（unassigned / low）就淹了。
          .filter((artifact) => artifact.slot === 'unassigned' || artifact.classifierConfidence === 'low'
            || (evidence !== 'prompt' && artifact.transcriptionFailed === true))
          .map((artifact) => ({
            file: artifact.file,
            slot: artifact.slot,
            confidence: artifact.classifierConfidence,
            reason: artifact.transcriptionFailed
              // #3590 成因照实说：视频/音频上从来没有转写这一步，把它写成「转写失败」
              // 会让读清单的人去查一个根本不存在的故障
              ? `${artifact.transcriptionAbsence === 'no-transcript-carrier'
                ? 'this carrier has no transcription step'
                : 'transcription failed'} — excluded from verbatim checks. ${artifact.classifierReason}`
              : artifact.classifierReason,
          })),
        // #3407 第二段回复无效而回退第一段的槽：这些件的槽位是第一段的、未经集合内复核
        ...redistribution.diagnostics.failed.map((failure) => ({
          file: failure.files.join(' | '),
          slot: failure.slot,
          confidence: 'n/a',
          reason: `stage-2 redistribution fell back to stage-1 slots (round ${failure.round}): ${failure.reason}`,
        })),
        // 第二段跑完仍有「超配 ∧ 缺件」共现 —— 残余疑似错分，M1 的缺件腿可能仍不可信
        ...(redistribution.diagnostics.residualCoOccurrence
          ? [{
              file: '*',
              slot: '*',
              confidence: 'n/a',
              reason: `over-allocated and under-allocated image slots still co-occur after ${redistribution.diagnostics.rounds} redistribution round(s) — suspected misclassification remains; M1 shortfall for this run may be unreliable`,
            }]
          : []),
        // #3443 设计质量判不出来的件：这一件的四组分缺席（不是 0），人读一眼是模型故障还是图本身
        ...(designQuality?.verdict === 'scored'
          ? designQuality.artifacts
            .filter((artifact) => artifact.verdict === 'unscored')
            .map((artifact) => ({ file: artifact.file, slot: artifact.slotId, confidence: 'n/a', reason: `design quality unscored — ${artifact.reason}` }))
          : []),
      ],
      claimedVsDelivered: {
        claimedHex,
        deliveredHex,
        mismatch: claimedHex.length > 0 && claimedHex.join(',') !== deliveredHex.join(','),
      },
      claims: claims === null ? null : { ...claims, finalMessagePresent: manifest.finalMessage !== null },
      declaredButUnjudged: unjudgedDeclarations(spec),
      // #3444：判据是「有该登记的件、却一件都没登记」。包里本来就没有图像/视频时
      // 这一列不适用，报 true 会把"无从判定"说成"旧包"
      provenanceMissing: primaryMedia.length > 0 && !primary.some((file) => file.provenance !== undefined),
      redistribution: redistribution.diagnostics,
    },
    generation: {
      outputs: primaryMedia.length,
      requests: manifest.generationJobs.reduce((sum, job) => sum + job.count, 0),
      completedRequests: completed,
      estimatedCostUsd: manifest.llm?.estimatedCostUsd ?? null,
      cellCostUsd: cellCostOf(manifest.llm),
      models: summarizeGenerationModels(manifest.generationJobs),
    },
    measurement,
    slotAssignment,
  }
}

/**
 * 逐次生图调用 → 「这一轮用了哪些生成模型」（#3530）。
 *
 * 按 `providerId + modelId` 合并、按请求数降序，同一批读数两次跑出来的顺序稳定。
 * 状态不过滤：失败的请求也说明这一轮试图用哪个模型，滤掉会让一个全失败的模型凭空消失。
 */
function summarizeGenerationModels(
  jobs: readonly { status: string; providerId: string; modelId: string; count: number }[],
): Array<{ providerId: string; modelId: string; requests: number }> {
  const byModel = new Map<string, { providerId: string; modelId: string; requests: number }>()
  for (const job of jobs) {
    const key = `${job.providerId}/${job.modelId}`
    const entry = byModel.get(key) ?? { providerId: job.providerId, modelId: job.modelId, requests: 0 }
    entry.requests += job.count
    byModel.set(key, entry)
  }
  return [...byModel.values()].sort((a, b) => b.requests - a.requests || `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`))
}

/**
 * not-applicable 不计入分母 —— 与硬约束同口径。blueprint-off 首跑「规范页一个 hex 都没写」
 * 就落在这里：那不是「一致性没做到」，而是这条判据在这份产物上无从判定，两者不能混算。
 * 身份尺同口径。**双列不合成一个率** —— 合成之后「零可判」与「可判但全过」会读成同一个数。
 */
function tallyConsistency(evaluation: EvaluationOutput): {
  setPassed: number
  setApplicable: number
  /**
   * #3796 题库为这把尺子**声明**了几条规则 —— 取值就是 `evaluation.score.<尺子>` 的数组长度：
   * 每条声明的规则恒有一条判定落在里面，`not-applicable` 也在内。
   *
   * 有了它，「声明 N / 判了 M / 损耗 K」三个数在 CSV 里就齐了，不必再去翻 `tasks/<taskId>.json`
   * 做差。本批 M2 两把尺子声明 52 + 56 条、只判了 17 + 6 条 —— 在这几列存在之前，
   * 这种量级的分母缩水在报表上完全隐形。
   */
  setDeclaredRules: number
  identityPassed: number
  identityApplicable: number
  identityDeclaredRules: number
  /** #3518 三档：`assets` 有没有编造 / `run` 是不是同一个物件 / `lineage` 是不是从它发展来的 */
  identityBands: IdentityBandSummary
  /** #3380 双图判定分布 —— 纯粹的一致性读数，与规则级 verdict 并列报 */
  identityPairsSame: number
  identityPairsDifferent: number
  identityPairsUnjudgeable: number
  /** #3380 规则级 fail 里有几条来自 subject 槽零交付（M1 缺件，不是视觉不一致） */
  identityFailFromMissing: number
  /** #3441 整套一致性：判了的规则数、打分条目数、0–100 均值（无可判规则 → null）、来自 deck 槽的图数 */
  setRubricDeclaredRules: number
  setRubricJudgedRules: number
  setRubricApplicableItems: number
  setRubricMean0to100: number | null
  setRubricDeckImages: number
  /** #3442 前后一致：命中格数 / 分母（双列不合成率）、提取器被拒 token 数、气质档槽数与 0–100 均值 */
  carryHits: number
  carryApplicable: number
  carryDeclaredRules: number
  carryJudgedRules: number
  carryRejectedTokens: number
  carryTemperamentApplicable: number
  carryTemperamentMean0to100: number | null
  /** #3443 设计质量：四组 0–100（未声明 / 判不了 / 无可判件 → null）、打分件数、未打分件数、渲染器产出件数 */
  dq: Record<DqGroup, number | null>
  dqStatus: ReturnType<typeof designQualityStatus>
  dqArtifactsScored: number
  dqArtifactsUnscored: number
  dqRendererProduced: number
} {
  const setApplicable = evaluation.score.setConsistency.filter((rule) => rule.verdict !== 'not-applicable')
  const identityApplicable = evaluation.score.identityConsistency.filter((rule) => rule.verdict !== 'not-applicable')
  // 分布与成因都从 identity.ts 的同一份实现取，不在这里再写一遍 filter
  const tallies = evaluation.score.identityConsistency.map((rule) => rule.pairTally ?? tallyPairs(rule.pairs))
  // 汇总口径取 setRubric.ts 的同一份实现，与 compareArms 的 cell 同源
  const rubric = summarizeSetRubric(evaluation.score.setVlmRubric ?? [])
  // 同源：CSV 与 compareArms 的这一层读数都走 carryThrough.ts 的这一份实现
  const carry = summarizeCarryThrough(evaluation.score.carryThrough ?? [])
  const dq = summarizeDesignQuality(evaluation.score.designQuality)
  return {
    setPassed: setApplicable.filter((rule) => rule.verdict === 'pass').length,
    setApplicable: setApplicable.length,
    setDeclaredRules: evaluation.score.setConsistency.length,
    identityPassed: identityApplicable.filter((rule) => rule.verdict === 'pass').length,
    identityApplicable: identityApplicable.length,
    identityDeclaredRules: evaluation.score.identityConsistency.length,
    // 三档计数取 identity.ts 的同一份实现，与 compareArms 的格子同源
    identityBands: summarizeIdentityBands(evaluation.score.identityConsistency),
    identityPairsSame: tallies.reduce((sum, tally) => sum + tally.same, 0),
    identityPairsDifferent: tallies.reduce((sum, tally) => sum + tally.different, 0),
    identityPairsUnjudgeable: tallies.reduce((sum, tally) => sum + tally.unjudgeable, 0),
    identityFailFromMissing: evaluation.score.identityConsistency.filter(isFailFromMissing).length,
    setRubricDeclaredRules: (evaluation.score.setVlmRubric ?? []).length,
    setRubricJudgedRules: rubric.judgedRules,
    setRubricApplicableItems: rubric.applicableItems,
    setRubricMean0to100: rubric.mean0to100,
    setRubricDeckImages: rubric.deckImages,
    carryHits: carry.hits,
    carryApplicable: carry.applicable,
    carryDeclaredRules: (evaluation.score.carryThrough ?? []).length,
    carryJudgedRules: carry.judgedRules,
    carryRejectedTokens: carry.rejectedTokens,
    carryTemperamentApplicable: carry.temperamentApplicable,
    carryTemperamentMean0to100: carry.temperamentMean0to100,
    dq: dq.groups,
    dqStatus: designQualityStatus(evaluation.score.designQuality),
    dqArtifactsScored: dq.artifactsScored,
    dqArtifactsUnscored: dq.artifactsUnscored,
    dqRendererProduced: dq.rendererProduced,
  }
}

/**
 * M1 失败槽的成因两列（#3677）。总数一列、成因两列，读表人不必翻 JSON 的 `diagnostics`。
 *
 * `not-applicable` 与旧包（无 `unmeasurableSlots`）都留空：前者没判过，后者判过但没分过成因，
 * 两种"不知道"都不能写成 0。
 */
function m1CauseColumns(verdict: M1SuccessVerdict): [string | number, string | number] {
  if (verdict.verdict === 'not-applicable' || verdict.unmeasurableSlots === undefined) return ['', '']
  return [verdict.unmeasurableSlots.length, verdict.failingSlots.length - verdict.unmeasurableSlots.length]
}

/**
 * 「只看最终成果」口径的四列（#3804）。与上面四列一一对应并列 —— 一个口径的数字
 * 要不要当门面，不该取决于谁比较容易拿到。
 *
 * `null` = 这道题一个槽都没标 `stage`，那条刻度在这道题上不存在 → 四列留空。
 * 写 0 会让它冒充「判过且零通过」，与 {@link m1CauseColumns} 对旧包的处置同一条纪律。
 */
function m1FinalCoreColumns(verdict: M1SuccessVerdict | null): [string, string, string | number, string | number] {
  if (verdict === null) return ['', '', '', '']
  const judged = verdict.verdict !== 'not-applicable'
  return [
    verdict.verdict,
    verdict.reason,
    judged ? verdict.failingSlots.length : '',
    judged && verdict.unmeasurableSlots !== undefined ? verdict.unmeasurableSlots.length : '',
  ]
}

/** 可空分数的渲染：null 用占位符，不是 0 */
function fixedOrBlank(value: number | null, digits: number, blank: string): string {
  return value === null ? blank : value.toFixed(digits)
}

/** 单个 run 的进度块。刻意没有任何 await：并发下整段一次打完，不与其它 run 交错。 */
function printRunSummary(evaluation: EvaluationOutput): void {
  const tally = tallyConsistency(evaluation)
  if (evaluation.requirements) console.log(`${evaluation.runKey}: PUBLIC REQUIREMENTS ${evaluation.requirements.allRequiredSatisfied ? 'PASS' : 'NOT SATISFIED'} ${JSON.stringify(evaluation.requirements.counts)} (distinct from M1 delivery)`)
  console.log(
    `${evaluation.runKey}: M1 ${evaluation.score.m1Success.verdict}`
    + `, delivered ${evaluation.score.deliverableCompletion.delivered}/${evaluation.score.deliverableCompletion.expected}`
    + `, slots ${evaluation.score.slotCoverage.covered}/${evaluation.score.slotCoverage.total}`
    + `, constraints ${evaluation.score.constraintPassRate.passed}/${evaluation.score.constraintPassRate.applicable}`
    + `, set-consistency ${tally.setPassed}/${tally.setApplicable}`
    + `, identity ${tally.identityPassed}/${tally.identityApplicable} (pairs same/diff/unj ${tally.identityPairsSame}/${tally.identityPairsDifferent}/${tally.identityPairsUnjudgeable}${tally.identityFailFromMissing > 0 ? `, ${tally.identityFailFromMissing} fail from missing slot` : ''})`
    + `, set-rubric ${tally.setRubricMean0to100 === null ? 'n/a' : tally.setRubricMean0to100.toFixed(0)} (${tally.setRubricApplicableItems} items, ${tally.setRubricJudgedRules} rules)`
    + `, carry ${tally.carryHits}/${tally.carryApplicable}`
    + ` (temperament ${tally.carryTemperamentMean0to100 === null ? 'n/a' : tally.carryTemperamentMean0to100.toFixed(0)} over ${tally.carryTemperamentApplicable} slot(s)`
    + `${tally.carryRejectedTokens > 0 ? `, ${tally.carryRejectedTokens} token(s) rejected by the substring recheck` : ''})`
    + `, dq ${tally.dqStatus === 'not-run' ? 'off (--dq 未开)'
      : tally.dqStatus === 'undeclared' ? 'undeclared'
        : tally.dqStatus === 'not-applicable' ? 'n/a'
          : `${DQ_GROUPS.map((group) => `${group[0]}=${fixedOrBlank(tally.dq[group], 0, '-')}`).join('/')} (${tally.dqArtifactsScored} scored${tally.dqArtifactsUnscored > 0 ? `, ${tally.dqArtifactsUnscored} unscored` : ''})`}`
    + `, gen ${evaluation.generation.outputs} outputs / ${evaluation.generation.requests} requests`
    + `, false-completion ${evaluation.score.falseCompletion.verdict}`
    + (evaluation.score.falseCompletion.atCeiling ? ' (at ceiling)' : '')
    + (evaluation.measurement.valid ? '' : `  [不可比：${evaluation.measurement.reason}]`),
  )
  for (const rule of evaluation.score.identityConsistency.filter((item) => item.verdict === 'fail')) {
    console.log(`    IDENTITY-FAIL ${rule.ruleId}: ${rule.reason}`)
  }
  for (const constraint of evaluation.score.constraints.filter((item) => item.scoring && item.verdict === 'fail')) {
    const sawInstead = [...new Set(constraint.evidence.flatMap((item) => item.sawInstead ?? []))]
    console.log(`    FAIL ${constraint.constraintId}${sawInstead.length > 0 ? ` (saw instead: ${sawInstead.join(', ')})` : ''}`)
  }
}

/**
 * 导出包 `llm` 段 → 整格 LLM 成本（#3895）。缺 `cellCostUsd`（`manifestVersion` 18 之前的包，
 * 或 teammate 用量查询失败）回落 orchestrator-only 的 `estimatedCostUsd`；没有 `llm` 段（外部臂）→ null。
 */
export function cellCostOf(llm: RunExportManifest['llm'] | undefined): number | null {
  if (!llm) return null
  return llm.cellCostUsd ?? llm.estimatedCostUsd
}

function csvRow(values: Array<string | number>): string {
  return values
    .map((value) => (typeof value === 'string' && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : String(value)))
    .join(',')
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const exportRoot = getArg('--export')
  if (!exportRoot) {
    throw new Error('Usage: bench:evaluate --export <export dir> [--tasks <dir>] [--cache <dir>] [--out <csv>] [--labels <csv>] [--identity-labels <csv>] [--set-rubric-labels <csv>] [--carry-labels <csv>] [--dq] [--dq-labels <csv>] [--evidence pixel|prompt] [--concurrency <n>] [--continue-on-error]')
  }
  const concurrencyArg = getArg('--concurrency') ?? '1'
  const concurrency = Number(concurrencyArg)
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`--concurrency 必须是正整数，收到 "${concurrencyArg}"`)
  }
  const continueOnError = process.argv.includes('--continue-on-error')
  const tasksDir = getArg('--tasks')
  const cacheDir = getArg('--cache') ?? path.join('tmp', 'bench-vlm-cache')
  // #3163：默认仍是冻结的视觉判据。结构判据必须显式点名 —— 默认值切换会让历史读数
  // 在没人察觉的情况下换了尺子。
  const evidenceArg = getArg('--evidence') ?? 'pixel'
  if (evidenceArg !== 'pixel' && evidenceArg !== 'prompt') {
    throw new Error(`--evidence 只接受 pixel | prompt，收到 "${evidenceArg}"`)
  }
  const evidence: EvidenceSurface = evidenceArg
  // #3765 M3 开关。**缺省不跑**：单图设计质量现在由上游 Qwen-Image-Bench 单独出
  // （指南 §2.4 方案 B），本评估器这一把每格要发一批 opus 单图调用，不该默认花。
  const runDesignQuality = process.argv.includes('--dq')

  // 旁挂权重指错了就当场停 —— 继续跑只会让那几列静默空着而退出码仍是 0（见 sidecarPreflight）。
  // env 没设的一律放行：那是「这台机器没装权重」，优雅降级那条路原样保留。
  const sidecarProblems = formatSidecarPreflight(checkSidecarWeights())
  if (sidecarProblems) throw new Error(sidecarProblems)

  // 单个 run 目录也接受 —— 排查一份产物时不必先造一层目录
  const runDirs = fs.existsSync(path.join(exportRoot, 'manifest.json'))
    ? [exportRoot]
    : fs.readdirSync(exportRoot)
      .map((name) => path.join(exportRoot, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
      .sort()

  if (runDirs.length === 0) throw new Error(`No run directories with manifest.json under ${exportRoot}`)

  const rows: string[] = [csvRow([
    'runKey', 'taskId',
    'm1Success', 'm1SuccessReason', 'm1FailingSlotCount', 'm1UnmeasurableSlotCount', 'm1MissingSlotCount',
    // #3804 「只看最终成果」口径此前算了却没有出口：它在 `evaluation.json` 里，
    // 但既不进这份 CSV 也不进跨臂报表，于是照着 CSV 读 M1 的人只拿得到上面那一个数。
    // 实测两个口径会给出**相反的排序**（v0.6 n24 a 变体 9 题：GM 0 pass vs 5 pass）。
    'm1FinalCore', 'm1FinalCoreReason', 'm1FinalCoreFailingSlotCount', 'm1FinalCoreUnmeasurableSlotCount',
    'deliverableDelivered', 'deliverableExpected', 'deliverableCompletionRate',
    'slotCovered', 'slotTotal', 'slotCoverageRate',
    'constraintPassed', 'constraintApplicable', 'constraintPassRate',
    'setConsistencyPass', 'setConsistencyApplicable', 'setConsistencyDeclaredRules',
    'identityConsistencyPassed', 'identityConsistencyApplicable', 'identityConsistencyDeclaredRules',
    'identityPairsSame', 'identityPairsDifferent', 'identityPairsUnjudgeable', 'identityFailFromMissing',
    ...identityBandColumns(),
    'setVlmRubricMean0to100', 'setVlmRubricApplicableItems', 'setVlmRubricDeclaredRules', 'setVlmRubricJudgedRules', 'setVlmRubricDeckImages',
    'paletteConsistency', 'paletteMeanDeltaE', 'palettePairs',
    'styleConsistency', 'styleMeanCosine', 'stylePairs',
    'carryThroughHits', 'carryThroughApplicable', 'carryThroughTemperamentMean',
    'carryThroughDeclaredRules', 'carryThroughJudgedRules', 'carryThroughRejectedTokens', 'carryThroughTemperamentApplicable',
    'dqStatus', 'dqQuality', 'dqAesthetics', 'dqText', 'dqDomain', 'dqArtifactsScored', 'dqArtifactsUnscored', 'dqRendererProduced',
    'deliveryGenerated', 'deliveryAuthored', 'deliveryComposed', 'deliveryUnknown',
    'deliveryNotApplicable', 'deliveryReusedInput', 'deliveryAbsent',
    'videoDelivery', 'provenanceMissing',
    'generationOutputs', 'generationRequests', 'estimatedCostUsd', 'cellCostUsd',
    'runVerdict', 'runErrorClass', 'measurementValid', 'measurementReason',
    'zeroDelivery', 'claimedVsDeliveredMismatch',
    'falseCompletion', 'falseCompletionAtCeiling', 'silentUnderclaim', 'falseCompletionReason',
    'revisionSatisfied', 'revisionSatisfiedReason', 'nonRegression', 'nonRegressionReason',
    'needsManualCheck',
    'redistributionRounds', 'redistributedCount',
    'unassignedModelChoice', 'unassignedUnknownSlot', 'unassignedPageFloor', 'unassignedClassifyFailed', 'unassignedTranscriptionFailed', 'unassignedContentType',
    'imagesNormalized',
    'requirementsSatisfied', 'requirementsEligible', 'requirementsPassed', 'requirementsFailed', 'requirementsUnjudgeable', 'requirementsPendingManual',
    'evaluatorVersion', 'rubricVersion', 'classifierModel',
  ])]
  const labelPairs: LabelPair[] = []
  const labelFile = getArg('--labels')
  const humanLabels = labelFile ? parseLabelCsv(fs.readFileSync(labelFile, 'utf-8')) : null
  // #3173 身份判定的 κ 校准。复用同一份 kappa 基础设施，"file" 位放
  // `pairKey = <anchor>|<subject>`，human 取 same / different。
  // **这条通道只提供入口，数字要人来标** —— κ 达标之前身份尺只进诊断段。
  const identityLabelPairs: LabelPair[] = []
  const identityLabelFile = getArg('--identity-labels')
  const identityLabels = identityLabelFile ? parseLabelCsv(fs.readFileSync(identityLabelFile, 'utf-8')) : null
  // #3441 整套一致性的 κ 入口：key = `<runKey>|<ruleId>|<item>`，label = 0 / 1 / 2 / n/a（档位当名义标签，
  // 精确一致才算一致 —— 比有序加权 κ 更严，与身份尺共用同一份 cohensKappa；README 记了这条口径）。
  const setRubricLabelPairs: LabelPair[] = []
  const setRubricLabelFile = getArg('--set-rubric-labels')
  const setRubricLabels = setRubricLabelFile ? parseLabelCsv(fs.readFileSync(setRubricLabelFile, 'utf-8')) : null
  // #3442 P2 气质一档的 κ 入口：key = `<runKey>|<ruleId>|<slotId>`，档位当名义标签（同 set-rubric 口径）。
  // **只标气质档**：逐字腿是确定性的、任何人拿同一批产物都能复算，给它标注量不出人机一致性。
  const carryLabelPairs: LabelPair[] = []
  const carryLabelFile = getArg('--carry-labels')
  const carryLabels = carryLabelFile ? parseLabelCsv(fs.readFileSync(carryLabelFile, 'utf-8')) : null
  // #3443 设计师校准：键 `runKey|file|itemId`；按组出 Spearman ρ（有序档）与 κ（名义）
  const dqLabelPairs: Array<LabelPair & { group: DqGroup }> = []
  const dqLabelFile = getArg('--dq-labels')
  // 标注要跟模型的判定配对才算得出 κ；不跑 M3 时根本没有模型那一侧。
  // 不报错就是“收下一个不起作用的旋钮”—— 同 `vlm.ts` 模块头写的那种病。
  if (dqLabelFile !== undefined && !runDesignQuality) {
    throw new Error('--dq-labels 需要同时传 --dq：不跑 M3 就没有模型判定可与人工标注配对，κ / ρ 无从算起')
  }
  const dqLabels = dqLabelFile ? parseLabelCsv(fs.readFileSync(dqLabelFile, 'utf-8')) : null

  // 先把每个 run 的 spec 解析完、把身份 pair 数的账报完，再派发：spec 缺失在花一分钱之前就爆；
  // 知情披露（#3173：pair 数 = 双图调用次数 = 真金白银）按输入序一次性打完，不会被并发进度交错打散。
  const planned = runDirs.map((runDir) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8')) as RunExportManifest
    // #3176: revision 变体指向母题的 spec —— 判分口径只有一份，两个 track 因此可比。
    // 缺席（v9 及更早的包、以及全部创作 track 场景）时回落 scenarioId，行为一字不变。
    const benchTaskId = manifest.benchTaskId ?? manifest.scenarioId
    const specFile = evaluationCorpusPaths(manifest, tasksDir).taskFile
    if (!fs.existsSync(specFile)) {
      throw new Error(
        `${runDir}: no task spec at ${specFile} for benchTaskId "${benchTaskId}"`
        + (manifest.benchTaskId ? ` (declared by scenario "${manifest.scenarioId}")` : ''),
      )
    }
    const spec = loadTaskSpec(specFile)
    return { runDir, spec, specFile, assetBindings: prepareIdentityAssetBindings(manifest, spec) }
  })
  for (const { runDir, spec } of planned) {
    if (spec.requirementChecks) console.log(`  ${path.basename(runDir)} public requirements: ${spec.requirementChecks.length} checks; visual/content/deck checks may require multiple page calls; explicit manual checks do not auto-pass`)
    for (const rule of spec.identityConsistency ?? []) {
      console.log(`  ${path.basename(runDir)} identity "${rule.id}": up to ${maxIdentityPairs(spec, rule)} pairwise call(s) for this run`)
    }
    // #3434 写题提示：多件锚槽没显式选锚。与上面的账单同一处、同一口气 —— 花钱之前先看见。
    for (const hint of lintTaskSpec(spec)) console.log(`  ${path.basename(runDir)} spec hint: ${hint}`)
  }

  // #3418：题间并发、结果保序归位。共享数组（rows / labelPairs / identityLabelPairs）的写入
  // 全部在归位之后串行进行，行序与 κ 输入序因此与串行完全一致。per-run 的进度块在 evaluateOne
  // 里**同步一段打完**（中间没有 await），并发下也不会与其它 run 的输出交错。
  type RunOutcome = { runDir: string; evaluation: EvaluationOutput } | { runDir: string; error: Error }
  async function evaluateOne({ runDir, spec, specFile, assetBindings }: (typeof planned)[number]): Promise<RunOutcome> {
    try {
      const evaluation = await evaluateRun(runDir, spec, cacheDir, assetBindings, evidence, specFile, runDesignQuality)
      fs.writeFileSync(path.join(runDir, 'evaluation.json'), JSON.stringify(evaluation, null, 2), 'utf-8')
      if (evaluation.requirements) fs.writeFileSync(path.join(runDir, 'requirement-review-queue.json'), JSON.stringify(evaluation.requirements.pendingManual, null, 2), 'utf8')
      printRunSummary(evaluation)
      return { runDir, evaluation }
    } catch (error) {
      // 没有 --continue-on-error 时保持原语义：抛出即终止整队（main 的 catch → exit 1）。
      if (!continueOnError) throw error
      const failure = error instanceof Error ? error : new Error(String(error))
      console.error(`${path.basename(runDir)}: EVALUATION FAILED — ${failure.message}`)
      return { runDir, error: failure }
    }
  }
  const outcomes = await mapBounded(planned, concurrency, evaluateOne)

  const failed: Array<{ runDir: string; error: Error }> = []
  for (const outcome of outcomes) {
    if ('error' in outcome) {
      failed.push(outcome)
      continue
    }
    const { evaluation } = outcome
    const tally = tallyConsistency(evaluation)
    const causes = evaluation.diagnostics.unassignedCauses ?? tallyUnassignedCauses(evaluation.artifacts)
    rows.push(csvRow([
      evaluation.runKey, evaluation.taskId,
      evaluation.score.m1Success.verdict, evaluation.score.m1Success.reason,
      // #3542 距离通过差几个核心槽。`not-applicable` 留空而不是写 0 —— 那一格根本没判过，
      // 写 0 会让它在第三方复算的分布里冒充「槽全满」。pass 的 0 是真读数（确实一个不缺）。
      evaluation.score.m1Success.verdict === 'not-applicable' ? '' : evaluation.score.m1Success.failingSlots.length,
      // #3677 同一个总数的两列成因：没测出来的 / 真缺件的。两列之和恒等于上一列。
      // 旧包没有 `unmeasurableSlots`（本次升版之前判定层根本没分过成因），两列一起留空 ——
      // 写 0 会让那批读数冒充「全部差在真缺件」，正是这个 issue 要消除的那种混淆。
      ...m1CauseColumns(evaluation.score.m1Success),
      // #3804 并列的第二口径。`null` = 这道题一个槽都没标 stage（旧题没有这条刻度）→ 四列留空，
      // **不伪装成「全是最终成果」**；空与 `not-applicable` 由第一列自己分得开。
      ...m1FinalCoreColumns(evaluation.score.m1FinalCore),
      evaluation.score.deliverableCompletion.delivered, evaluation.score.deliverableCompletion.expected,
      evaluation.score.deliverableCompletion.rate.toFixed(4),
      evaluation.score.slotCoverage.covered, evaluation.score.slotCoverage.total, evaluation.score.slotCoverage.rate.toFixed(4),
      evaluation.score.constraintPassRate.passed, evaluation.score.constraintPassRate.applicable, evaluation.score.constraintPassRate.rate.toFixed(4),
      tally.setPassed, tally.setApplicable, tally.setDeclaredRules,
      tally.identityPassed, tally.identityApplicable, tally.identityDeclaredRules,
      tally.identityPairsSame, tally.identityPairsDifferent, tally.identityPairsUnjudgeable, tally.identityFailFromMissing,
      ...identityBandValues(tally.identityBands),
      tally.setRubricMean0to100 === null ? '' : tally.setRubricMean0to100.toFixed(1), tally.setRubricApplicableItems, tally.setRubricDeclaredRules, tally.setRubricJudgedRules, tally.setRubricDeckImages,
      evaluation.score.paletteConsistency.verdict,
      // 数值恒报，哪怕 verdict 是 not-applicable —— 校准已确认这一列不判 pass/fail，只作诊断
      evaluation.score.paletteConsistency.meanDeltaE === null
        ? '' : evaluation.score.paletteConsistency.meanDeltaE.toFixed(3),
      evaluation.score.paletteConsistency.pairs.length,
      // 三态原样进 CSV（measured / not-applicable / unavailable）；数值只在 measured 时有
      evaluation.score.styleConsistency.status,
      evaluation.score.styleConsistency.meanCosine === null
        ? '' : evaluation.score.styleConsistency.meanCosine.toFixed(4),
      evaluation.score.styleConsistency.pairs.length,
      tally.carryHits, tally.carryApplicable, tally.carryTemperamentMean0to100 === null ? '' : tally.carryTemperamentMean0to100.toFixed(1),
      tally.carryDeclaredRules, tally.carryJudgedRules, tally.carryRejectedTokens, tally.carryTemperamentApplicable,
      tally.dqStatus,
      ...DQ_GROUPS.map((group) => fixedOrBlank(tally.dq[group], 1, '')), tally.dqArtifactsScored, tally.dqArtifactsUnscored, tally.dqRendererProduced,
      evaluation.score.delivery.generated, evaluation.score.delivery.authored,
      evaluation.score.delivery.composed, evaluation.score.delivery.unknown,
      evaluation.score.delivery.notApplicable, evaluation.score.delivery.reusedInput,
      evaluation.score.delivery.absent,
      // 视频那一列在 CSV 里压成一格：主表读的是「有没有、各几件」，逐档展开在 evaluation.json 里
      `g${evaluation.score.videoDelivery.generated}/a${evaluation.score.videoDelivery.authored}`
        + `/c${evaluation.score.videoDelivery.composed}/u${evaluation.score.videoDelivery.unknown}`
        + `/absent${evaluation.score.videoDelivery.absent}`,
      String(evaluation.diagnostics.provenanceMissing),
      // #3895：`estimatedCostUsd` 列语义不动（orchestrator-only，旧 CSV 可对读），整格成本另起一列
      evaluation.generation.outputs, evaluation.generation.requests, evaluation.generation.estimatedCostUsd ?? '',
      evaluation.generation.cellCostUsd ?? '',
      evaluation.runVerdict?.verdict ?? '', evaluation.runVerdict?.errorClass ?? '',
      String(evaluation.measurement.valid), evaluation.measurement.reason ?? '',
      String(evaluation.score.hardGate.zeroDelivery), String(evaluation.diagnostics.claimedVsDelivered.mismatch),
      evaluation.score.falseCompletion.verdict, String(evaluation.score.falseCompletion.atCeiling),
      String(evaluation.score.silentUnderclaim), evaluation.score.falseCompletion.reason,
      evaluation.score.revisionSatisfied.verdict, evaluation.score.revisionSatisfied.reason,
      evaluation.score.nonRegression.verdict, evaluation.score.nonRegression.reason,
      evaluation.diagnostics.needsManualCheck.length,
      evaluation.diagnostics.redistribution?.rounds ?? 0, evaluation.diagnostics.redistribution?.moved.length ?? 0,
      // #3488 未归槽的成因分档：第一列是量尺的正式回答，后四列都是"没测到"。
      // 合成一个未归槽率会让交付格式差异读成能力差异，故只并列、不相加。
      causes.modelChoice, causes['classifier-unknown-slot'], causes['page-floor'],
      causes['classify-failed'], causes['transcription-failed'] ?? '', causes['content-type'],
      (evaluation.diagnostics.imageNormalizations ?? []).length,
      evaluation.requirements ? String(evaluation.requirements.allRequiredSatisfied) : '', evaluation.requirements ? String(evaluation.requirements.eligible) : '', evaluation.requirements?.counts.pass ?? '', evaluation.requirements?.counts.fail ?? '', evaluation.requirements?.counts.unjudgeable ?? '', evaluation.requirements?.counts['pending-manual'] ?? '',
      evaluation.evaluatorVersion, evaluation.rubricVersion, evaluation.classifierModel,
    ]))

    if (humanLabels) {
      for (const artifact of evaluation.artifacts) {
        const human = humanLabels.get(artifact.file)
        if (human) labelPairs.push({ file: artifact.file, human, classifier: labelComparisonSlot(artifact) })
      }
    }

    if (identityLabels) {
      for (const rule of evaluation.score.identityConsistency) {
        for (const pair of rule.pairs) {
          const key = `${pair.anchorFile}|${pair.subjectFile}`
          const human = identityLabels.get(key)
          if (human) identityLabelPairs.push({ file: key, human, classifier: pair.verdict })
        }
      }
    }
    if (setRubricLabels) {
      for (const rule of evaluation.score.setVlmRubric) {
        // 键用 1 起的条目序号而不是条目原文：条目措辞里常有逗号，而标注 CSV 按第一个逗号切键
        rule.items.forEach((item, index) => {
          const key = `${evaluation.runKey}|${rule.ruleId}|${index + 1}`
          const human = setRubricLabels.get(key)
          // 人工侧同样归一化（"N/A" / "2" 与判定侧的 'n/a' / 2 是同一个标签）；归一化不了的原样保留，让它计入不一致
          if (human) setRubricLabelPairs.push({ file: key, human: String(normalizeScore(human) ?? human), classifier: String(item.score) })
        })
      }
    }

    if (carryLabels) {
      for (const rule of evaluation.score.carryThrough ?? []) {
        for (const item of rule.temperament.verdicts) {
          const key = `${evaluation.runKey}|${rule.ruleId}|${item.slot}`
          const human = carryLabels.get(key)
          if (human) carryLabelPairs.push({ file: key, human: String(normalizeScore(human) ?? human), classifier: String(item.score) })
        }
      }
    }
    if (dqLabels && evaluation.score.designQuality?.verdict === 'scored') {
      for (const artifact of evaluation.score.designQuality.artifacts) {
        for (const item of artifact.items) {
          const key = `${evaluation.runKey}|${artifact.file}|${item.id}`
          const human = dqLabels.get(key)
          if (human) dqLabelPairs.push({ file: key, human: String(normalizeScore(human) ?? human), classifier: String(item.score), group: item.group })
        }
      }
    }
  }

  const csvPath = getArg('--out') ?? path.join(exportRoot, 'evaluation.csv')
  fs.writeFileSync(csvPath, rows.join('\n') + '\n', 'utf-8')
  console.log(`\nWrote ${outcomes.length - failed.length} evaluation.json + ${csvPath}`)

  if (humanLabels) {
    const result = cohensKappa(labelPairs)
    console.log(
      `\nClassifier vs human labels: n=${result.n}, agreement=${(result.agreementRate * 100).toFixed(1)}%`
      + `, kappa=${result.kappa === null ? 'undefined' : result.kappa.toFixed(3)}`,
    )
    for (const pair of result.disagreements) {
      console.log(`    ${pair.file}: human=${pair.human} classifier=${pair.classifier}`)
    }
  }

  if (identityLabels) {
    const result = cohensKappa(identityLabelPairs)
    console.log(
      `
Identity judge vs human labels: n=${result.n}, agreement=${(result.agreementRate * 100).toFixed(1)}%`
      + `, kappa=${result.kappa === null ? 'undefined' : result.kappa.toFixed(3)}`,
    )
    for (const pair of result.disagreements) {
      console.log(`    ${pair.file}: human=${pair.human} judge=${pair.classifier}`)
    }
  }
  if (setRubricLabels) {
    const result = cohensKappa(setRubricLabelPairs)
    console.log(
      `\nSet-rubric judge vs human labels (exact-match, nominal): n=${result.n}, agreement=${(result.agreementRate * 100).toFixed(1)}%`
      + `, kappa=${result.kappa === null ? 'undefined' : result.kappa.toFixed(3)}`,
    )
    for (const pair of result.disagreements) {
      console.log(`    ${pair.file}: human=${pair.human} judge=${pair.classifier}`)
    }
  }
  if (carryLabels) {
    const result = cohensKappa(carryLabelPairs)
    console.log(
      `\nCarry-through temperament judge vs human labels (exact-match, nominal): n=${result.n}, agreement=${(result.agreementRate * 100).toFixed(1)}%`
      + `, kappa=${result.kappa === null ? 'undefined' : result.kappa.toFixed(3)}`,
    )
    for (const pair of result.disagreements) {
      console.log(`    ${pair.file}: human=${pair.human} judge=${pair.classifier}`)
    }
  }
  if (dqLabels) {
    // 指南 §2.4 第 6 步：按组核对，ρ ≥ 0.6 且 κ ≥ 0.667 的组才可进主表。ρ 只算双方都给了数字档的对（n/a 不是一个档）。
    console.log('\nDesign-quality judge vs designer labels, per group (Spearman rho on 0/1/2 pairs; kappa exact-match incl. n/a):')
    for (const group of DQ_GROUPS) {
      const pairs = dqLabelPairs.filter((pair) => pair.group === group)
      const numeric = pairs.filter((pair) => /^[012]$/.test(pair.human) && /^[012]$/.test(pair.classifier))
      const rho = spearman(numeric.map((pair) => Number(pair.human)), numeric.map((pair) => Number(pair.classifier)))
      const kappa = cohensKappa(pairs)
      console.log(
        `    ${group}: n=${kappa.n} (numeric pairs ${rho.n}), rho=${rho.rho === null ? 'undefined' : rho.rho.toFixed(3)}`
        + `, agreement=${(kappa.agreementRate * 100).toFixed(1)}%, kappa=${kappa.kappa === null ? 'undefined' : kappa.kappa.toFixed(3)}`,
      )
    }
  }

  // 其余题的结果已全部落盘，这里才报失败清单并以 exit 1 收口 —— 「每个 run 都判完」才是 0。
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${outcomes.length} run(s) failed to evaluate (results for the rest were written): `
      + failed.map((f) => `${path.basename(f.runDir)} — ${f.error.message}`).join('; '),
    )
  }
}

// esbuild 的 cjs 输出把 `import.meta` 置空（构建期只有一条 warning），纯 URL 守卫恒假
// → main() 静默不执行、exit 0、stdout 全空，读起来和「跑成功了但没什么可输出」一模一样
// （#1729 / #2140 / #3285 是同一个坑的三次复发）。守卫形状由 scriptEntrypointGuard 棘轮兜住。
const isScriptEntrypoint = typeof require !== 'undefined' && typeof module !== 'undefined'
  ? require.main === module
  : import.meta.url === pathToFileURL(process.argv[1] ?? '').href

if (isScriptEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
