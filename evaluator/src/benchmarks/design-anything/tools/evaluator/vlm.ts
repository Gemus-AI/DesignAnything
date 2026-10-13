/**
 * 冻结评估器的模型通道（#3109）—— **量尺，不是被测物**。
 *
 * ## 为什么不复用 `getRoleModelsForProvider()`
 *
 * 那张表是**被测系统**的角色分配（`evaluator` 角色 = agent 跑的时候用来看图的 subagent），
 * 它跟着产品演进。量尺跟着被测物漂移就不是量尺了：同一份产物在产品换了 vision 模型之后
 * 会得到不同的分数，而报告上看不出任何差别。所以这里是一个**独立钉死**的常量。
 *
 * ## 为什么是 `openai/gpt-5.6-luna` 而不是计划原写的 `gemini-3-flash-preview`
 *
 * 1. 首跑那次实测的槽位分类一致性（κ=0.944）跑在这一档模型上；换模型 κ 作废，须用同一份
 *    27 张图重测（见 `prompts.ts` 的诚实声明）。
 * 2. `gemini-3-flash-preview` 对本机出口 IP 返 `400 User location is not supported`，
 *    尺子在本地根本跑不起来 —— 而 60 runs 的评估要在本地反复重跑。
 *
 * **这是一次预注册值变更**（ICLR 计划文档 §9.5 写的是 gemini），须在计划文档记日期与理由。
 *
 * ## 结构化输出为什么不用 `generateObject`
 *
 * apimart 的 OpenAI 兼容层对 tool/JSON-schema 模式的支持面未经验证，而这条通道的失败
 * 会以"整批评估跑不动"的形式出现。这里用 `generateText` + 严格 JSON 指令 + 容错解析：
 * 少一层依赖，且模型真的答歪时报的是**这一张图**的错，不是整批。
 *
 * @module benchmarks/design-anything/tools/evaluator/vlm
 */

import 'dotenv/config'

import fs from 'fs'
import { createHash } from 'crypto'
import path from 'path'

import { generateText } from 'ai'
import sharp from 'sharp'

import { createOpenAI } from '@ai-sdk/openai'

import { resolveModel } from '@/lib/ai/llm'

import { sha256Buffer, sha256File, writeCacheAtomically } from './cacheFs'

// [JUDGE-SWITCH 探针，未入库] 判官模型可用环境变量切换；缺省仍为 luna。
// DeepSeek 默认开思考且 reasoning 计进同一个 max_tokens（4096 会被吃光，正文 0 字），
// 需下发 thinking:{type:'disabled'}；@ai-sdk/openai 不转发未知字段，故用注入 fetch 改请求体。
const probeFetch: typeof fetch = async (input, init) => {
  if (process.env.BENCH_JUDGE_THINKING === 'off' && init?.body && typeof init.body === 'string') {
    const body = JSON.parse(init.body) as Record<string, unknown>
    body.thinking = { type: 'disabled' }
    init = { ...init, body: JSON.stringify(body) }
  }
  return fetch(input, init)
}
const probeDeepseek = createOpenAI({
  baseURL: process.env.BENCH_JUDGE_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  fetch: probeFetch,
})
function resolveJudgeModel(modelId: string) {
  return process.env.BENCH_JUDGE_VIA_OPENAI_COMPAT ? probeDeepseek.chat(modelId) : resolveModel(modelId)
}

/** 冻结的量尺模型。改它 = 之前所有 evaluation.json 不可比，故它进每一份输出。 */
export const EVALUATOR_MODEL_ID = process.env.BENCH_EVALUATOR_MODEL_ID || 'openai/gpt-5.6-luna'

/**
 * M3 设计质量的评审模型（#3443，指南 §2.4 第 2 步）：**不得与任何被测系统的生成模型同家族**。
 * `EVALUATOR_MODEL_ID` 是 OpenAI 家族，而 Gemus 的主力生图之一是 `gpt-image-2`（同家族偏好是有据可查的
 * 失效模式，披露不能消偏），所以 M3 单独用 Anthropic 家族 —— 它没有生图模型，对三条臂都不同族。
 *
 * 家族是约束，传输通道不是：裸 `claude-opus-4.8` 走 apimart 中转（与 `EVALUATOR_MODEL_ID` 同一通道、
 * 同一个余额池），`anthropic/claude-opus-4.8` 走官方直连。2026-09-06 实测本机 `ANTHROPIC_API_KEY` 无效
 * （"API key is invalid"），直连一次也判不了，故取中转 id；两者都是 Anthropic 家族，换 id 只是换缓存键。
 * 分类 / 转写 / 身份 / 再分配 / 整套一致性继续用 `EVALUATOR_MODEL_ID`，其 κ 不受影响。
 * 它进缓存键（换评审模型旧缓存自动作废）与 `evaluation.json` 的 `dqJudgeModel`（可比性键）。
 */
export const DQ_JUDGE_MODEL_ID = 'claude-opus-4.8'
export const DQ_JUDGE_MODEL_FAMILY = 'anthropic'

/**
 * 采样控制的**如实记录**，进每一份 evaluation.json。
 *
 * 实测（2026-08-23，apimart）：`gpt-5.6-luna` 是 reasoning 模型，AI SDK 回
 * `The feature "temperature" is not supported`，参数被上游丢弃。**因此这里不发它** ——
 * 发一个被忽略的旋钮、再在输出里写 `temperature: 0`，就是拿一句没有效力的声明冒充控制
 * （和 modelPin 模块头说的"钉死写进 DB 却毫无效力"是同一种病）。
 *
 * 可复现性由**磁盘缓存**承担而不是由采样温度承担：一批评估的每次视觉判定都落盘，
 * 同一批次重跑是字节级重放。跨批次的稳定性是已知限制，须在论文 Limitations 披露。
 */
export const EVALUATOR_SAMPLING = 'model-managed (temperature unsupported by this model)'

/**
 * 评估器实现版本。判据逻辑变了就要升，让旧 evaluation.json 一眼可辨。
 *
 * `v0.3`（#3407）：分槽从「逐件独立判」升级为「第一段逐件判 + 第二段超配槽集合内再分配」
 * （`redistribute.ts`）。分类结果会变，v0.2 与 v0.3 的读数不可同图；已跑批次需整批重评估。
 *
 * `v0.4`（#3438）：代表件与交付集先排除第二段声明为替代件的件（`alternateOf`），再套「最后一件」
 * 顺序契约（`scoreSlots`）。件数与完成度不变，代表件与约束/身份取证会变。重评估的分类与转写全部
 * 命中缓存，但代表件换了会让身份一致性规则的锚（anchorSlot 的代表件）换掉，图对变了就是新问题 ——
 * 实测 20 题约 40 次双图调用，不是零。
 *
 * `v0.5`（#3441）：新增 M2 第二层 `setVlmRubric` 的整套视觉一致性判定（`setRubric.ts`，
 * `SET_RUBRIC_PROMPT_SHA` 进评估器身份与可比性键）。既有各列逐字不变；新增的是一个此前
 * 只解析不判的维度，v0.4 文件没有 `score.setVlmRubric`，混表会把「未判」读成「判了」，故升版本。
 *
 * `v0.6`（#3443）：新增 M3 设计质量判定（`designQuality.ts`）：`dq-v1` 清单冻结（`DQ_CHECKLIST_SHA`）、
 * 另一家族的评审模型（`DQ_JUDGE_MODEL_ID`）逐件逐条打 0/1/2/N-A、两级聚合。既有各列逐字不变；
 * `score.designQuality` 与 `dqRubric` 从 `declaredButUnjudged` 移出，v0.5 文件没有该段，故升版本。
 *
 * `v0.7`（#3488）：归槽的**判定结果本身会变**，这是这串版本里第一次。三处：
 * ① 分类器回 `unassigned` 不再记成「未知槽名」（prompt 明写它合法，那是读数不是故障）；
 * ② 槽名不认识 / 页数不达标时**换个问法重问一次**，仍不成立才落 unassigned 并记成因；
 * ③ 单图超过评审模型上限时先等比缩再发，此前是整题评估失败。
 * 于是同一份导出包在 v0.6 与 v0.7 下的完成度**可以不同** —— 混表比较无效，必须整批重跑。
 *
 * `v1.0`（#3541）：**归槽从「逐件分类 + 事后局部修补」换成一次带容量约束的整体指派**
 * （`assignment.ts`）。图像归属面的分类器改为对每个候选槽各回一个分数
 * （`CLASSIFY_SCORES_PROMPT_TEMPLATE`，进评估器身份与可比性键），求解在「每槽不超过席位数、
 * 每件至多一个席位、`unassigned` 容量无限」下最大化总分。这是这串版本里改得最深的一次：
 * **图像归属面的每一格都可能变**，第一段的 prompt sha 也变了，图像分类的既有缓存整体作废。
 * 与 v0.9 的读数不可同图，三条臂必须整批重评估。
 *
 * `v1.1`（#3552）：**集合细则的条目有了职责边界。** `setVlmRubric` 是全套判据里唯一
 * 「让评审模型看着图回答是非题」的口子，于是凡是确定性判据够不着的要求 —— 面积、尺寸、
 * 街道名、CSV 数值、菜单顺序 —— 全都塞了进来；后果不只是这一层变难，还有同一个缺陷被
 * M1 和 M2 各扣一次，而两次的权重从没定义过（指南 §2.10 不合成总分，正是要求层与层不重叠）。
 * 条目现在必须声明 `kind`：`consistency`（产物之间互相比对）进 M2，`compliance`
 * （产物与简报给定的事实比对）单列报、不进 M2。
 *
 * **判定本身逐字不变**：`kind` 不进 prompt，条目原文一字未动，缓存键因此不变 —— 同一批
 * 判定换一种记账。升版本是因为 `score.setVlmRubric[].byKind` 是新的 score 字段，
 * 且 M2 那一列的口径从「全部条目」改成了「只算一致性条目」，两版数值不可同图。
 *
 * `v1.2`（#3518）：**判据按真值来源分档，M2 不再重复计 M1 已经查过的那一件。** 三处变化都动读数：
 *
 * 1. `setConsistency` 的作用面**减去同一个 token 上 `text-verbatim` 已覆盖的件**。v0.5 实测
 *    41 条里 35 条与某条 `text-verbatim` 是同一个字符串，代表件上拼错时两边各扣一次。
 *    减完之后这一列是对 M1 的**纯增量**：「M1 没看的那些件上，拼法一不一致」。
 * 2. **配色从身份尺退役**：`subject: 'palette'` 且锚在本次运行的规则一律 `not-applicable`，
 *    配色只由确定性的色板 ΔE00 一列承担。素材锚的那条保留 —— ΔE00 是套内两两对称比、
 *    刻意不与锚比，答不了「是不是客户给的那个釉色」。
 * 3. 身份判定带上 `band`（`assets` / `run` / `lineage`），报表分三档报。分档不改任何一条判定，
 *    但 v1.2 之前的 evaluation.json 没有这个字段，报表只能报未分档的旧口径。
 *
 * **判定本身逐字不变**：三处都不进 prompt，缓存键不变；退役的配色规则连调用都不再发。
 *
 * `v1.3`（#3555 / #3557）：**M2 少了一档、多回来一条腿。**
 *
 * ① 身份的**血脉链档退役**（`anchorSlot` + `anchorSelect: 'any'`）。两条理由：双图判定问的是
 * 「是不是同一个」，而血脉链正确的答案常常是「不是同一个，但是从它来的」；更要紧的是它想问的
 * 那件事整套细则已经问了、且问得更准（`any` 是「对上任一件就算」，整套条目写的是「每一件对上
 * 它自己的那一件」）。退役走与配色同一条打分期通道，记 `not-applicable`，题包不动。
 *
 * ② `carryThrough` 的**两条腿各按能力自过滤**。逐字腿此前会去读渲染图的转写文本，等于要求图上
 * 印着 `#3B2417`；v1.1 的修法是把图像槽从作用面里剔掉，结果气质腿（必须看像素）一起没了对象 ——
 * 三条臂实测零可判。现在作用面恢复成作者的原意（这条决定要传播到哪些交付物），
 * **逐字腿跳过位图、气质腿跳过文档**，判据按交上来的**那一件**定，不按槽声明了什么。
 *
 * 两条都改变已有读数：身份的分母少了血脉链那一档，carryThrough 多了气质腿的分数。
 * 与 v1.2 的读数不可同图，三条臂必须整批重评。
 *
 * `v1.4`（#3566）：**血脉链档的作用面收窄，v0.1 上 5 条判据回来。**
 *
 * v1.3 用一个句法标记判血脉链：`anchorSelect: 'any'`。而「锚槽里有多件、对上任一件就算」这个
 * 形状同时对应两种意思，只有前一种是血脉关系：
 *
 * - **N 个互斥的备选**（三个方向稿里选一个发展下去）—— 定稿与另外两个本来就不是同一个东西；
 * - **N 个并存的成员**（story-01 的两个主角、furniture-01 的三个模块）—— 一张只画了 Pip 的场景图
 *   本来就只该与 Pip 的设定页对上，「对上任一件」正是**正确**的聚合。
 *
 * 分界改用题包**已有**的 `stage`（`process` = 过程成果、`final` = 最终成果）与 `anchorSelect` 的
 * **合取**。题包一个字都不用改。v0.1 实测恢复 5 条：craft/jewelry `same-pieces`、fashion `garments`、
 * furniture `same-modules`、story `same-characters` —— story-01 此前**没有任何判据在问「是不是同一个人」**。
 *
 * 同时，#3557 逐条核过的三条（craft / jewelry / fashion）改为**由覆盖它的整套细则条目原文派生**：
 * 那句话在这份 spec 里才退役。它只在 v0.2 起的题包里，所以 v0.1 上这三条也活着。
 *
 * v0.5 一条都没变 —— 那一版的作者已经用另一条路修好了同一件事（`same-characters` 拆成
 * `same-mara` / `same-pip` 两条单锚规则）。**改动只影响 v0.1 / v0.1.1 的读数**，那两版必须整批重评。
 */
// v0.8：v2 规范来源进入集合评分；旧规则的模板和聚合口径不变，新判据不可与旧读数混表。
// v0.9：#3529 归槽残留错配的不可判出口。
//
// v1.5：五处「没测到」被记成「测了没有」的修复，读数会变，**既有批次必须整批重新打分**。
//   - #3587 一件读不出来的产物只让它自己退出观测面，不再作废同一条判据里的其余件；
//     `delivery` 移到那道闸之前（此前交了片子判不了、不交片子反而判得了）。
//   - #3590 没有转写这一步的载体（视频 / 音频 / 结构判据面）退出逐字约束的分母，
//     不再记一次未命中把整条约束拉成 fail。
//   - #3589 原件自己不带页数时，`pageCount` 取导出清单里由真实内容数出的 `pages`。
//   - #3586 定稿引用改用与逐字约束同一套 `normalizeForMatch` 比对，跨行拼接不再整条作废。
//   - #3525 deck 的逐页来源归属改由题面显式声明（`pageSourceReuse`），缺省仍是历史行为。
//   - #3607 自包含校验不再拿 box 词表当门：未知 box 解得开就下降、解不开才当叶子。
//     实测 13 支真实视频从「一支都读不出」变成「13 支全读得出」，时长判据第一次有读数。
//   - #3607 后续：视频不再抽帧（帧没有任何计分用途），改标 `contentUnreadable`。声明了
//     视频来源的判据不再整条 pending-manual —— 那是 #3587 换个门进来的同一个坑。
//
// #3592（身份判定的比较作用面）**不在这一版的读数影响里**：不写作用面的规则渲染出的 prompt
// 逐字节不变，`IDENTITY_PROMPT_TEMPLATE` 本身也没改。
//
// v1.6：身份模板补一条归属规则（#3615）。此前模板只说了什么算同、什么算不同，**没说
//   「看得见但分辨不出」该往哪边倒**，于是模型把「我没找到矛盾」填进了 same ——
//   #3519 标定实测：30 处人机分歧里 16 处是「人说不同、机器说同一个」，机器给的理由
//   高频出现 `can belong to` / `no clear conflicting product identity` / `another area
//   within the same space`。新模板把这一档明确导向 unjudgeable，并把确认层级压到被设计的
//   物件本身（同一场地、同一品类不算同一个物件）。
//   **这是换尺子**：`IDENTITY_PROMPT_SHA` 变了，全部身份图对缓存未命中、三条臂必须整批重评；
//   #3519 那轮 κ 只背书旧模板，这一版在新一轮标定出来之前**没有 κ**。
// v1.7：M1 增加 `unmeasurable` 第三态（#3677）。此前「差的槽全都只差在量尺没读出来」与
//   「系统确实少交了几件」写进同一个 `fail`，于是一次 11/11 全交、关键约束全过、设计质量
//   87.9 的运行与一次演示文档从没被碰过的运行在头条读数上是同一个字。判据不是新造的 ——
//   `requirementChecks` 的 R-delivery 早就把两者分成 `pending-manual` / `fail`，判定层
//   此前没有去读它；这一版让两处共用 `scoring.slotIsUnmeasurable` 同一份原语。
//   **这是换尺子**：`score.m1Success.verdict` 的值域变了，同一批读数必须在同一把尺子下
//   重新打分，不能一半题用旧尺子、一半用新尺子。
//   同版并入 #3680：`.docx` 此前一条载体分支都不匹配，落到按 Content-Type 的确定性归属，
//   而那条只认 PDF 是文档 —— 于是记成因 `content-type`（量尺的正式回答：没有槽收这种载体），
//   对应核心槽判真缺件。一份内容正确的 docx 在读数上等同于什么都没交。现在它走文档分类
//   通道、正文进分类器；页数仍不可知（docx 不记录渲染后的页数），于是落
//   `page-floor` / `unknown-page-count`，读作「没测出来」而不是「没交」。
//   （那一档自 v1.11 起不再存在 —— 页数下限不再决定归属，见下。）
// v1.8：证据完整性按通道拆分（#3703）。此前 `limitations` 是一个扁平数组，`textComplete`
//   由「数组空不空」决定 —— 任意通道的任意瑕疵一票否决其余所有通道。实测形态：一份 deck
//   内嵌 6–16 MB 的视频，`goto(waitUntil:'load')` 按契约不等媒体流式请求，那支**存在且完好**
//   的 mp4 被登记成 `missing or blocked`，整份文档于是判「文字没读全」。b4 的 42 份 deck 里
//   含视频的 7 份全灭（不含视频的 35 份全过；b3 那份 1.09 MB 的视频过）。
//   后果不在完成度上（`requirementChecks` 的交付归类走 `textComplete || pageCount`，页数正常），
//   而在判官拿不到文字转写：挂在这些 deck 上的内容判据全部落 `pending-manual`，
//   `constraintPassRate` 的分母因此缩水，11 格里 7 格受影响。
//   **这是换尺子**：`textComplete` 的取值规则变了，同一份 deck 在新旧两版下进的是不同判据
//   通道，跨该合并点的批次不可同表比较（同 #3439 的处置）。
// v1.9：**M3 设计质量变成可开关，且缺省不跑**（#3765）。单图设计质量改由上游
//   Qwen-Image-Bench 单独出（指南 §2.4 的方案 B，操作见 docs/operations/qjudger-gpu-runbook.md），
//   本评估器这一把只在 `bench:evaluate --dq` 时跑。**判定逻辑一字未改** —— 开着跑出来的
//   四组分与 v1.8 逐字节相同（`dq-v1` 清单、提示词、评审模型、两级聚合都没动）。
//   变的是两件事：① `score.designQuality` 多了第四态 `not-run`（`null` 已经被「这道题没声明
//   dqRubric」占了，两件事写成同一个值就再也分不开）；② `evaluation.csv` 多一列 `dqStatus`，
//   它让旁边那 7 列数值**空得有理由** —— 空列本身读不出是哪一种空。
//   **开与关的包不可同表**，而这一点不靠人记得：关着时 `dqSha` / `dqChecklistSha` / `dqJudgeModel`
//   三个字段一律不写，`evaluatorIdentity` 算出的键因此不同，可比性闸当场拒混表。
// v1.10：**交付形态的结论不再传导到判内容的尺子**（#3795）。被页数下限挡下的件进
//   `SlotVerdict.formatBlocked`，`contentRepresentative()` 让 `carryThrough`（来源侧与目标侧）
//   与 `setRubric`（来源侧）读得到它 —— 那些 markdown 转写完整，挡下它们的是「至少八页」
//   这条交付形态判据，不是「读不出内容」。完成度与 M1 一格未动（形态确实不达标，那一笔照扣）。
//   同批还有两处同源修复：定稿标记只能在一个槽的多件之间取舍、**不能把槽清空**
//   （`scoreSlots` 与 `validateFinalSelection` 两处兜底）；定稿选择的证据超长改为**按件裁正文**
//   而不是整步弃权（`buildSelectionPayload`，文件名与槽名一个字不裁）。
//   **这是换尺子**：M2 的 `carryThrough` / `setVlmRubric` 会多出大量此前判 `not-applicable`
//   的规则实例（实测 v0.6 n24 a 变体 19 题上 70 条），跨该合并点的批次不可同表比较。
//   **受益方向要声明**：只有交出「内容可读、形态不达标」文档的臂会变（实测 GM 有、OD / JH 为 0），
//   所以这不是中性修复，重打分后三条臂都要在同一版尺子上重出读数才能比。
// v1.11：**页数下限不再是归槽的门**（#3803）。一件文档只要分类器判它属于某个槽就归进去，
//   页数够不够改在交付集上单独判（`scoring.scorePageFloors`）。这是上一版的上游：v1.10 修的是
//   「形态被拒的件，判内容的尺子看不见它」，这一版修的是「它为什么会被拒到看不见」。
//   三处连带变化：
//   ① **完成度只答「交了没有」**。此前它一个数回答了两个问题（做了没有 / 形式对不对），
//      两者失败时给出同一个数字。新增并排的一列 `score.formatCompliance` 答第二个问题。
//   ② **最终汇报槽的页数下限改从 M1 的合取上走**（`m1Success.failingPageFloors`）：一页的
//      「汇报」照样不通过，但判词说得出「交了、只有 1 页」，而归槽的门只会说「没交」。
//      页数读不出来的汇报槽落 `unmeasuredPageFloors` 并让整条判 `unmeasurable` —— 那是
//      交付形态差异，不是系统没做到，两者刻意不合成一个数。
//   ③ v1.10 的 `SlotVerdict.formatBlocked` 与 `contentRepresentative()` **退役**：件不再被删，
//      那两个字段的职责随之消失，判内容的尺子重新读 `representative` / `delivered`。
//      `unassignedCause: 'page-floor'` 与 `ScoredArtifact.pageFloorRejection` 同理不再产生。
//   **这是换尺子**：`deliverableCompletion` / `m1Success` 两列的值都会动，跨该合并点的批次
//   不可同表比较。**受益方向要声明**：实测被页数下限挡下的件 GM 23 / OD 6 / JH 8，
//   **收益最大的是我们自己**，所以这不是中性修复，重打分后三条臂必须在同一版尺子上重出读数。
//
// v1.12（#3811）—— 整套细则「没测出来」拆成因，来源文本预算按判官上下文重定：
//   ① **来源槽真空记 0 分进分母**（`SetVlmRubricVerdict.verdict: 'unmet'`）。题目要系统先写下
//      选型 / 材料 / 功能的决定，再让其余产物遵守它。一件都没写，等于交出一组彼此没有共同依据
//      的产物 —— 那就是「不成一套」，不是「这次没测成」。此前它退出分母，于是**不写文档 = 免测
//      一致性**。与 #3806 运行内锚那一档同一条理由。
//   ② **来源文本预算 24_000 → 120_000 字**。那个数不是判官的限制（判官是 gpt-5.6-luna，
//      实测最长一条来源 66_957 字 ≈ 1.7 万 token），实测把 12 条规则挡在门外，而**挡掉的
//      恰好是写得最长的那一臂**。超限仍然不截断、仍判不可判 —— 改的是阈值，不是那条纪律。
//   ③ `unavailableCause` 逐条记成因，报表的「规则损耗」据此拆成「系统 / 尺子」两半。
//   **这是换尺子**：`setVlmRubric` 一列的值会动，跨该合并点的批次不可同表比较。
//   **受益方向要声明**：①对我们有利（实测来源槽真空 GM 0 / OD 12 / JH 7），
//   ②对我们不利（超预算被挡的 GM 5 / OD 5 / JH 2，放开后 GM 那 5 条要真判）。
//   两条方向相反、同一次落地，不得只做其中一条。
//
// v1.13（#3819 + #3816 + #3817）—— 三条一起落地，**只重打一次分**：
//   ① **#3819 作用面槽零交付的关键约束改判 fail**（`scoring.scoreConstraints`）。
//      这是同一条选择效应的**第六处**（前五处 #3806 / #3803 / #3811 / #3813 / #3817）：
//      作用面的槽一件没交，这条约束此前判 `not-applicable` 退出分母 —— 交得越少分母越小，
//      分子不变时读数越好看。#3109 当初判 not-applicable 的理由是「槽位覆盖率已经扣过一次」，
//      而 #3816 之后槽位覆盖率**不在跨臂主表上**了，关键约束在，那个理由随之失效。
//      「没交」与「交了但没写那个词」靠新增的 `ConstraintVerdict.failCause` 分开
//      （`scope-empty` / `text-absent`），**不靠退出分母**。
//      作用面的件全都转写失败那一档**刻意没动**：件交了、是量尺读不出它。
//      **这是换尺子**：`constraintPassRate` 的分母会变大，`m1Success` 的合取也会随之变严，
//      跨该合并点的批次不可同表比较。
//      **受益方向要声明：这一条对我们有利**（实测 v0.6 a 变体九题 GM 0 条 / OD 0 条 / JH 2 条 ——
//      fashion 的 `inside-label-brand` / `inside-label-phrase`，JH 从 21/27 = 77.8% 变成
//      21/29 = 72.4%）。所以它不是中性修复，重打分后三条臂必须在同一版尺子上重出读数。
//   ② **#3817 requirementCheck 的「判不掉」拆成因**（`RequirementCheckVerdict.undecidedCause`）。
//      纯诊断字段，**一个既有读数都没动** —— 报表并排多报一个端点，不替换任何判定量。
//      单独落地本不必升版（同 #3782 的先例），跟着 ① 一起走只是为了不重打两次分。
//   ③ **#3816 跨臂主表重排**。纯呈现，json / csv 一个字段都没动，同样不必升版。
//
// **为什么三条并一次**：② 与 ③ 都是零判官调用（纯诊断 / 纯呈现，重打分全部命中缓存），
// ① 是确定性判据、同样零判官调用。分开落地要重打两轮、给出两套数，没有必要。
//
// v1.14（#3828）—— requirementCheck 的文本预算按判官的上下文重定：
//   `REQUIREMENT_MAX_TEXT_CHARS` 48_000 → 120_000，与 `setRubric` 的来源文本预算
//   （#3811 已定的同一个数）对齐。同一个判官、同一轮评估里此前有两个差 2.5 倍的预算，
//   后者只是先写下来的那个，没有依据。**「超限不截断」这条纪律一个字未改** —— 改的是阈值。
//   实测代价：两批 × 三臂共 **569 条观察**因为那个数字从未发出过判官调用。
//   **这一条会产生真实的新调用**，与本轮其它几条「零判官调用」的改动不同。
//   **受益方向要声明**：退出分母此前对交得少的臂有利（待人工检查数 GM 145 / OD 69 / JH 43，
//   一条检查只有走到「有东西可看」才会撞上预算门），所以放开的方向大概率对我们有利。
//   `REQUIREMENT_MAX_IMAGES` **刻意没跟着动**：图不是文本，多图判定的准确度会随图数下降，
//   那是模型的真实限制、需要证据，先做 20 条的标定实验再决定（#3828 §4 二）。
//
// v1.15（#3838）与 v1.16（#3946）**截至本条写下时只在打分分支上**（`bench/scoring-v115-ds-judge`
//   / `bench/scoring-v116-ds-judge`），未进 master；master 从 v1.14 直接跳到 v1.17。#3838 进 master
//   之前，master 的 v1.17 与打分分支的 v1.17 不是同一把尺子（后者多 #3838 与判官切换探针）。
//   #3946（有页数下限的槽优先选可量页的件）被本条取代，它的选件补丁不进 master。
//
// v1.17（#3948，#3782 P1）—— 文档通道并进归槽求解：
//   ① v3 的文档件（html / pdf / pptx / docx / text/*）改成**打分式**分类，与图像件同一个模板、
//      同一次求解；证据前加结构头（页数、逐页标题、首页文字）。**换了文档面的 prompt 与缓存键**，
//      五个评分集的文档件都要真打一遍判官。
//   ② 席位统一按槽的 `expected`，视频与旧题面单槽回复也进求解；删掉求解前按通道手工扣减席位。
//   ③ 席位容差是载体属性（`carrierKind.CARRIER_SEAT_TOLERANCE`）：文档 10、图像不设上限。
//      文档件不做大分差挪位 —— 否则一份汇报 deck 会去顶空着的排期表席位。图像件一个读数不动。
//   ④ 有页数下限的文档槽上，页数读得出的件在门后加分（最多 10），交付件以求解器分到席位的件为准。
//   ⑤ 截图文件夹：结构规则提候选，判官按同一条相对门决定是不是一份文档（每组多一次调用）。
//   ⑥ deck 页例外改读源文件的判官首选（求解前的占位槽读不出它属不属于某个槽）。
//   ⑦ 本题没有文档槽时，v3 的 html / pdf 不再记 `classify-failed`（那不是测量失败）。
//   **这是换尺子**，`delivered`、完成度、M1、formatCompliance 都会变，跨该点不可同表比较。
//   **受益方向要声明**：挂错槽 / 没挂上的 deck 证据来自 GM 臂（gm-sol n14 取证 12 份），截图文件夹
//   与没有配套文档的逐页系列来自外部臂（Codex / OD / JH），两边都会受益；方向要以五个评分集的重打分为准。
//
// v1.18（#3952）—— 读取通道对称化：「读不到」只能记不可判，不能记成「没交」或 0 分。
//   ① 没有分页容器的 HTML 按它自己的打印样式分页（浏览器打印成 PDF 再按 PDF 读），`pageCountSource: 'print'`。
//      此前只收 body 文字并记「没读全」，OD 3144 份、Codex 86 份的正文因此作废；GM 导出器自带分页容器，0 份受影响。
//   ② 有容器的 HTML 断图只降视觉通道，那一页的文字照收。导入器同时把压平后的相对引用改写到压平名
//      （`importExternalRun.rewriteLocalRefs`），只对新导入的包生效。
//   ③ PPTX 有 LibreOffice 时渲染成 PDF 同等读取（`BENCHMARK_SOFFICE_PATH`）；没有时保持旧读法并记明原因。
//   ④ 纯图 PDF 的逐页识别按页收，全部页都读不出才整份放弃；有一页没读全时 `transcriptionFailed` 仍为真。
//   ⑤ 整套一致性的来源槽空 / 读不出改为退出分母，不再记 0（撤回 v1.12 ①，与指南 §2.3 对齐）。
//   ⑥ `deliverableCompletion` 增加 `rateMeasurable` / `unmeasurableExpected`，`rate` 不变。
//   ①② 换了证据缓存版本（`artifact-evidence/v4`），文档件会真打一遍判官。
//   **这是换尺子**：完成度、M1、形态达标、整套一致性都会变，跨该点不可同表比较。
//   **受益方向要声明：①–⑤ 都主要对外部臂有利**（审计：读不出正文的文档 GM 0 / OD 3482 / JH 0 / Codex 231；
//   来源槽空记 0 的规则 JH 226 条、OD / Codex 少量、GM 0），所以它不是中性修复，四系统必须在 v1.18 上重出读数。
export const EVALUATOR_VERSION = 'v1.18'

/**
 * 判据口径（维度定义）的版本。与实现版本分开：实现修 bug 不该让读数不可比。
 *
 * `.2`（2026-08-23 阶段①试跑后）：完成度主判定量由二值槽位覆盖率改为分数式
 * `Σ min(matched, expected) / Σ expected`。变更理由与日期已回写 ICLR 计划文档 ——
 * 它只增加分辨率、不移动任何阈值，且是在**单臂**数据上发现的（那时不存在三臂对照表，
 * 结构上不可能朝着某个结果调）。
 */
export const RUBRIC_VERSION = 'deterministic-2026-08-23.2'

/**
 * 输出 token 上限。**显式给**而不是靠 provider 默认：默认值不在我们的记录里，
 * 换个 provider 就换了尺子的行为边界。80 行转写 + JSON 包装远在 4096 之内。
 */
export const EVALUATOR_MAX_OUTPUT_TOKENS = Number(process.env.BENCH_JUDGE_MAX_OUTPUT) || 4096

/**
 * 视觉调用最终失败（重试之后仍拿不到可解析的回复）。
 *
 * 单独一个类型是因为**调用方必须能区分它和"读出来是空的"**：读不出来时把这一件
 * 当成"什么字都没有"，会让挂在它身上的逐字约束判 fail —— 那是把**仪器故障伪装成被测对象的缺陷**，
 * 是本项目反复踩的同一个坑。
 */
export class VlmUnreadableError extends Error {
  constructor(public readonly imagePath: string, cause: string) {
    super(`Evaluator could not read ${imagePath}: ${cause}`)
    this.name = 'VlmUnreadableError'
  }
}

/**
 * 视觉端点**真的解得了**的位图 content-type（#3389）。
 *
 * `image/` 这个前缀不等于"视觉端点认得"：`image/svg+xml` 命中前缀，而 OpenAI 兼容的视觉端点
 * 根本不解 SVG。2026-09-04 有一次两小时的错误归因就出在这里 —— 一件 SVG 让整批评估退出码 1，
 * 而上游把拒绝包成 503「请稍后重试」，读起来完全像限流或宕机。
 *
 * 这份集合与 `importExternalRun` 的载体守卫是同一份口径，故由这里导出、那边引用：
 * 两处各写一份的话，它们的分歧不会有任何测试看见。
 *
 * **不升 `EVALUATOR_VERSION`，也不用重评任何批次**：名单外的载体在此之前是「整轮退出码 1」，
 * 没有任何一份既有 evaluation.json 里存在由这类载体产生的读数，所以没有读数会因为这条规则而改变。
 */
export const VLM_READABLE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** content-type 可能带参数（`image/png; charset=binary`），只看类型本身。 */
export function isVlmReadableImageType(contentType: string): boolean {
  return VLM_READABLE_IMAGE_TYPES.has(contentType.split(';')[0]!.trim().toLowerCase())
}

/**
 * 解不了的载体**一次网络都不发**，直接记成这一件读不出来。
 *
 * 抛 {@link VlmUnreadableError} 而不是别的错，是因为所有调用方都已经把它当成"这一件不可判"处理
 * （分类退成 `unassigned`、转写记 `transcriptionFailed`），其余部分照常出读数。这是确定性判断，
 * 不是把瞬时故障吞掉：格式解不了这件事重试一万次也一样。
 */
function assertReadableCarrier(subject: string, contentType: string): void {
  if (isVlmReadableImageType(contentType)) return
  throw new VlmUnreadableError(
    subject,
    `content-type "${contentType}" is not a bitmap the vision endpoint decodes `
    + `(readable: ${[...VLM_READABLE_IMAGE_TYPES].join(', ')}) — no call was made`,
  )
}

/**
 * 视觉/文本调用在**传输层**失败（上游拒绝、限流、超时、回了非 JSON 的东西），重试之后仍拿不到回复。
 *
 * 它是 {@link VlmUnreadableError} 的一种（#3593）：调用方把它当"这一件此刻判不了"处理 ——
 * 退成不可判、其余照常出读数。#3389 时它刻意**不是**，理由是「仪器坏了，继续跑只会产出一整批
 * 看起来像读数的空壳」；2026-09-11 v0.6 第三轮实测的却是另一种形态：上百次调用里**一次**上游
 * 抖动，让一道题 63 条判据一条都不写，而且带缓存重跑照样撞上。爆炸半径必须收到「这一件」。
 *
 * 两条守住 #3389 的顾虑：每次失败记进 {@link readEvaluatorTransportFailures} 的账本，
 * 评估器写进该题的 `diagnostics` —— 「没判」与「判了不过」不能长得一样；
 * **连续** {@link EVALUATOR_TRANSPORT_TRIP} 次失败仍视为仪器坏了，抛 {@link EvaluatorDownError}
 * 整轮停下 —— 那不是抖动，是宕机。
 *
 * 错误信息（#3389）：上游常把拒绝包成一句「请稍后重试」，只透传那一句就分不清是宕机还是这一件的
 * 格式问题。这里把**哪个文件、什么 content-type、走哪个模型**一并写进消息，原始错误挂在 `cause` 上。
 */
export class EvaluatorTransportError extends VlmUnreadableError {
  constructor(
    public readonly subject: string,
    public readonly carriers: readonly string[],
    public readonly modelId: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      subject,
      `transport failure [carriers: ${carriers.length > 0 ? carriers.join(', ') : 'text'}; model: ${modelId}]: ${detail}`,
    )
    this.name = 'EvaluatorTransportError'
    this.cause = cause
  }
}

/** 一次传输层失败的留痕 —— 逐件记，进该题的 `diagnostics.evaluatorTransportFailures`。 */
export interface EvaluatorTransportFailure {
  /** 出错信息里指认的主体（文件路径；双图/多图调用是路径拼接） */
  subject: string
  carriers: readonly string[]
  modelId: string
  message: string
}

/**
 * 连续多少次传输层失败算「仪器坏了」。一次是抖动，三次连着来就不是了 ——
 * 此时继续跑只会烧钱产出一整批没判的空壳（#3389 的原话）。成功一次即清零。
 */
export const EVALUATOR_TRANSPORT_TRIP = 3

/** 仪器坏了：连续 {@link EVALUATOR_TRANSPORT_TRIP} 次传输层失败。照旧往上抛、整轮停下。 */
export class EvaluatorDownError extends Error {
  constructor(public readonly failures: readonly EvaluatorTransportFailure[]) {
    super(
      `Evaluator transport failed ${failures.length} time(s) in a row — treating the instrument as down. `
      + `Last: ${failures[failures.length - 1]?.message ?? '(none)'}`,
    )
    this.name = 'EvaluatorDownError'
  }
}

/**
 * 本进程的传输层失败账本。进程作用域而不是穿参：调用点散在十几个评估器里（分类、身份、
 * 集合细则、设计质量……），而「这题哪几件没判」只在 `evaluateRun` 收尾时才要，中间隔着整条工具链。
 * 题间并发时按主体路径归属 —— 产物路径都在各自的导出目录之下。
 */
const transportFailures: EvaluatorTransportFailure[] = []
let consecutiveTransportFailures = 0

/** 某个导出目录（一题）下发生过的传输层失败；`within` 为空时返回全部。 */
export function readEvaluatorTransportFailures(within?: string): readonly EvaluatorTransportFailure[] {
  if (within === undefined) return transportFailures
  const root = path.resolve(within)
  return transportFailures.filter((failure) => failure.subject.includes(root))
}

/** 测试用：清空账本与连续计数。 */
export function resetEvaluatorTransportFailuresForTest(): void {
  transportFailures.length = 0
  consecutiveTransportFailures = 0
}

/**
 * 单张图发出去之前的**字节上限**（#3488）。超过它就等比缩到上限之下再发，格式不变。
 *
 * ## 为什么是 2.5 MB 而不是评审模型写的 5 MB
 *
 * 评审模型的硬上限是「base64 之后 5 MiB」。2026-09-06 三臂批次实测：一张 3,893,482 字节的
 * PNG 被上游记成 6,963,420 字节 —— 是原始字节的 1.79 倍，而 base64 本身只放大 1.33 倍。
 * 传输链上还有一层我们看不见的封装，所以**不能拿 5 MB 反推一个刚好卡住的阈值**。
 * 2.5 MB 原始字节按实测倍率约合 4.5 MB，留得下余量。
 *
 * ## 为什么这条规则必须在评估器里、对三条臂一视同仁
 *
 * 不做归一化时，这条上限实际在惩罚「图出得大」：本批 GM 的 211 张图 0 张超限（生图钉死
 * 1K/low 档，天然小），OD 与 JH 各有十几张超限，并且**各让一整道题的评估直接失败**
 * （报 `image exceeds 5 MB maximum`）。那是仪器的容量边界，不是被测系统的能力差异，
 * 而它结构上打不到我们自己 —— 一条只打外部臂的规则不能留在量尺里。
 */
export const EVALUATOR_IMAGE_MAX_BYTES = 2_500_000

/** 归一化的迭代上限。等比缩一次通常就够，留三次是给「缩了但压缩率没跟上」的图。 */
const NORMALIZE_MAX_PASSES = 3

/** 一次实际发生的归一化，进 `evaluation.json` 的 diagnostics —— 缩过的事必须看得见。 */
export interface ImageNormalization {
  /** 被缩的文件（相对路径由调用方给，这里原样回传） */
  file: string
  originalBytes: number
  bytes: number
  width: number
  height: number
  /** 线性缩放比（宽高各乘它） */
  scale: number
}

/**
 * 把一张图归一到 {@link EVALUATOR_IMAGE_MAX_BYTES} 以内。**缩尺寸、保格式**，不改编码参数：
 * 换格式（PNG→JPEG）会引入压缩伪影，而伪影正是逐字转写与像素采样这两条判据读的东西。
 *
 * 已经在上限之内的图**原样返回、不重编码** —— 重编码会改变字节，而缓存键取的就是
 * 「实际发出去的字节」，白白让既有缓存全部失效。
 */
export async function normalizeEvaluatorImage(
  filePath: string,
  reportName: string = filePath,
): Promise<{ image: Uint8Array; normalization: ImageNormalization | null }> {
  const original = fs.readFileSync(filePath)
  if (original.byteLength <= EVALUATOR_IMAGE_MAX_BYTES) return { image: original, normalization: null }

  const meta = await sharp(original).metadata()
  const width0 = meta.width
  const height0 = meta.height
  // 读不出尺寸就缩不了。原样发出去、如实回 null：调用方会看到上游的报错，
  // 那比在这里悄悄换一张图诚实。
  if (width0 === undefined || height0 === undefined) return { image: original, normalization: null }

  let current: Uint8Array = original
  let scale = 1
  for (let pass = 1; pass <= NORMALIZE_MAX_PASSES && current.byteLength > EVALUATOR_IMAGE_MAX_BYTES; pass += 1) {
    // 面积与字节近似成正比，故线性比取 sqrt；0.92 是留给「缩完压缩率变差」的余量。
    scale *= Math.sqrt(EVALUATOR_IMAGE_MAX_BYTES / current.byteLength) * 0.92
    const width = Math.max(1, Math.round(width0 * scale))
    const height = Math.max(1, Math.round(height0 * scale))
    // 不给 `toFormat`：sharp 缺省沿用输入格式，正是"保格式"要的行为
    current = await sharp(original).resize(width, height, { fit: 'fill' }).toBuffer()
  }
  const final = await sharp(current).metadata()
  return {
    image: current,
    normalization: {
      file: reportName,
      originalBytes: original.byteLength,
      bytes: current.byteLength,
      width: final.width ?? 0,
      height: final.height ?? 0,
      scale,
    },
  }
}

export interface VlmCallOptions {
  /** 图片文件绝对路径 */
  imagePath: string
  /** manifest 里记录的 Content-Type（S3 权威） */
  contentType: string
  /** 已渲染完成的完整 prompt */
  prompt: string
  /** 这条 prompt 的模板 sha —— 进缓存 key，改 prompt 自动作废旧缓存 */
  promptSha: string
  /** 缓存目录；不传则不缓存 */
  cacheDir?: string
  /**
   * 换一个模型判这一次（#3443 的 M3 评审模型）。缺省 `EVALUATOR_MODEL_ID`。
   * 进缓存键：同图同 prompt 换模型是另一次提问。
   */
  modelId?: string
  /**
   * 这一张图在发出去之前被等比缩过时的回调（#3488）。**只报告，不改变判定** ——
   * 调用方据此把归一化写进 `evaluation.json` 的 diagnostics。缩过的事必须看得见：
   * 量尺看到的不再是原图，读表的人有权知道。
   */
  onNormalized?: (normalization: ImageNormalization) => void
}

/**
 * 磁盘缓存的 key：**文件字节 + prompt + 模型**三者的哈希。
 *
 * 用文件字节而不是文件名：同一件产物在两次导出里文件名可能带序号后缀（`out-2.png`），
 * 按名缓存会漏命中；而不同的产物绝无可能有相同字节。图像与文本两条通道共用同一口径。
 * `modelId` 缺省时与 #3443 之前的键逐字节相同 —— 既有缓存不作废。
 */
export function cacheKey(fileSha: string, promptSha: string, modelId: string = EVALUATOR_MODEL_ID): string {
  return createHash('sha256')
    .update(`${modelId}\n${EVALUATOR_SAMPLING}\n${promptSha}\n${fileSha}`)
    .digest('hex')
}

/**
 * 容错 JSON 解析 —— 只剥 code fence 与首尾散文，不做任何语义修补。
 *
 * 解析失败**抛错**而不是回退到某个默认值：一张图判不出来是这一张的问题，
 * 静默给它一个 `unassigned` 会把模型故障伪装成"系统没交付这一件"。
 */
export function parseJsonReply<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Evaluator reply is not JSON: ${raw.slice(0, 200)}`)
  }
  return JSON.parse(body.slice(start, end + 1)) as T
}

/** {@link askTextEvaluator} 的入参。与 `VlmCallOptions` 平行，只是主体是文本文件。 */
export interface TextCallOptions {
  /** 文本文件绝对路径 */
  textPath: string
  /** 已渲染完成的完整 prompt */
  prompt: string
  /** 这条 prompt 的模板 sha —— 进缓存 key，改 prompt 自动作废旧缓存 */
  promptSha: string
  /** 缓存目录；不传则不缓存 */
  cacheDir?: string
}

/** AI SDK 的 user content 部件 —— 图像与文本两条通道的唯一差别就是它。 */
type EvaluatorContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; image: Uint8Array; mediaType: string }
>

/**
 * 评估器单次调用的公共部分：缓存 → 重试一次 → 解析 → 回写缓存。
 *
 * 抽出来是因为 #3128 加了文本通道，而**重试次数、缓存 key 口径、解析失败即抛**这三条
 * 判据必须两条通道逐字一致 —— 复制一遍就会有两份，且它们的分歧不会有任何测试看见。
 */
async function runEvaluatorCall<T>(call: {
  /** 出错信息里指认的主体（文件路径） */
  subject: string
  fileSha: string
  promptSha: string
  cacheDir?: string | undefined
  content: EvaluatorContent
  /** 缺省 `EVALUATOR_MODEL_ID`；进缓存键 */
  modelId?: string | undefined
  /** 这次调用发出去的载体 content-type，按内容部件顺序。只进错误信息，不进缓存键 */
  carriers?: readonly string[] | undefined
}): Promise<T> {
  const modelId = call.modelId ?? EVALUATOR_MODEL_ID
  const cacheFile = call.cacheDir
    ? path.join(call.cacheDir, `${cacheKey(call.fileSha, call.promptSha, modelId)}.json`)
    : null

  if (cacheFile && fs.existsSync(cacheFile)) {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as T
  }

  // 重试一次：截断/答歪是采样偶发（模型自管采样，见 EVALUATOR_SAMPLING），一次重掷通常就好。
  // 不重试更多次 —— 反复失败说明是这一件本身的问题，那要让调用方知道，不是靠次数硬扛。
  let parsed: T | null = null
  let lastError = ''
  for (let attempt = 1; attempt <= 2 && parsed === null; attempt += 1) {
    // 传输层失败**不在这里重试**（AI SDK 自己已经重试过），也不吞掉：换成一个指认了文件与载体的
    // 错误抛出去，这一件退成不可判并记账；连续失败到阈值才整轮停下 —— 见 EvaluatorTransportError 的说明。
    let result: Awaited<ReturnType<typeof generateText>>
    const probeStartedAt = Date.now()
    try {
      result = await generateText({
        model: resolveJudgeModel(modelId),
        // temperature 刻意不传 —— 见 EVALUATOR_SAMPLING
        maxOutputTokens: EVALUATOR_MAX_OUTPUT_TOKENS,
        messages: [{ role: 'user', content: call.content }],
      })
      if (process.env.BENCH_JUDGE_TELEMETRY) {
        const usage = (result as { usage?: Record<string, unknown> }).usage ?? {}
        fs.appendFileSync(process.env.BENCH_JUDGE_TELEMETRY, `${JSON.stringify({
          modelId, ms: Date.now() - probeStartedAt, subject: call.subject,
          images: call.content.filter((part) => part.type === 'image').length, attempt, usage,
        })}
`, 'utf-8')
      }
    } catch (error) {
      if (process.env.BENCH_JUDGE_TELEMETRY) {
        fs.appendFileSync(process.env.BENCH_JUDGE_TELEMETRY, `${JSON.stringify({
          modelId, ms: Date.now() - probeStartedAt, attempt, error: String(error).slice(0, 300),
        })}
`, 'utf-8')
      }
      const failure = new EvaluatorTransportError(call.subject, call.carriers ?? [], modelId, error)
      transportFailures.push({ subject: failure.subject, carriers: failure.carriers, modelId, message: failure.message })
      consecutiveTransportFailures += 1
      if (consecutiveTransportFailures >= EVALUATOR_TRANSPORT_TRIP) {
        throw new EvaluatorDownError(transportFailures.slice(-consecutiveTransportFailures))
      }
      throw failure
    }
    consecutiveTransportFailures = 0
    try {
      parsed = parseJsonReply<T>(result.text)
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (parsed === null) throw new VlmUnreadableError(call.subject, lastError)

  if (cacheFile) writeCacheAtomically(cacheFile, JSON.stringify(parsed, null, 2))
  return parsed
}

/** 单次视觉调用。命中缓存则零网络往返（60 runs × 9 图 × 2 次调用，重跑不该重复烧钱）。 */
export async function askVlm<T>(options: VlmCallOptions): Promise<T> {
  assertReadableCarrier(options.imagePath, options.contentType)
  const { image, normalization } = await normalizeEvaluatorImage(options.imagePath)
  if (normalization !== null) options.onNormalized?.(normalization)
  return runEvaluatorCall<T>({
    subject: options.imagePath,
    // 缓存键取**实际发出去的字节**而不是文件字节：没缩过的图两者逐字节相同（既有缓存全部
    // 继续命中），缩过的图则天然拿到一个新键 —— 归一化参数变了不会静默复用旧答案。
    fileSha: sha256Buffer(image),
    promptSha: options.promptSha,
    cacheDir: options.cacheDir,
    modelId: options.modelId,
    carriers: [options.contentType],
    content: [
      { type: 'text', text: options.prompt },
      { type: 'image', image, mediaType: options.contentType },
    ],
  })
}

/**
 * 单次**双图**判定调用（#3173 身份一致性）。
 *
 * 与 `askVlm` 的唯一差别是内容部件有两张图，**顺序进契约**：第一张恒为 anchor（参考件），
 * 第二张是被查件。prompt 里就这么写的，换序等于换了问题。
 *
 * 缓存键取两张图 sha 的有序拼接 —— 有序而不是排序后拼：`(A,B)` 与 `(B,A)` 在这条判据上
 * 不是同一次提问（虽然「是不是同一个」在语义上对称，但模型的回答未必对称，而缓存必须
 * 忠实记录「我们问过的那一次」，不能替模型断言对称性）。
 */
export async function askPairVlm<T>(options: {
  /** 参考件（anchor），恒为第一张 */
  anchorPath: string
  anchorContentType: string
  /** 被查件，恒为第二张 */
  subjectPath: string
  subjectContentType: string
  prompt: string
  promptSha: string
  cacheDir?: string | undefined
}): Promise<T> {
  assertReadableCarrier(options.anchorPath, options.anchorContentType)
  assertReadableCarrier(options.subjectPath, options.subjectContentType)
  const anchor = await normalizeEvaluatorImage(options.anchorPath)
  const subject = await normalizeEvaluatorImage(options.subjectPath)
  return runEvaluatorCall<T>({
    subject: `${options.anchorPath} vs ${options.subjectPath}`,
    fileSha: createHash('sha256').update(`${sha256Buffer(anchor.image)}\n${sha256Buffer(subject.image)}`).digest('hex'),
    promptSha: options.promptSha,
    cacheDir: options.cacheDir,
    carriers: [options.anchorContentType, options.subjectContentType],
    content: [
      { type: 'text', text: options.prompt },
      { type: 'image', image: anchor.image, mediaType: options.anchorContentType },
      { type: 'image', image: subject.image, mediaType: options.subjectContentType },
    ],
  })
}

/**
 * 单次**多图**判定调用（#3407 第二段分类）。
 *
 * 与 `askPairVlm` 同一纪律：图在 `content[]` 里的顺序就是提示词里的编号 1..N，**顺序进契约**；
 * 缓存键取全部图 sha 的**有序**拼接 —— 同一组图换个序是另一个问题。候选集里任何一件变了整组失效，
 * 刻意如此：集合判断的答案依赖全部输入。
 */
export async function askSetVlm<T>(options: {
  /** 按提示词编号顺序排列的图 */
  images: ReadonlyArray<{ path: string; contentType: string }>
  prompt: string
  promptSha: string
  cacheDir?: string | undefined
}): Promise<T> {
  // 一组里有一件解不了就整组不可判：集合判断的答案依赖全部输入，少一张答的是另一个问题。
  for (const image of options.images) assertReadableCarrier(image.path, image.contentType)
  const normalized = await Promise.all(options.images.map(async (image) => ({
    contentType: image.contentType,
    buffer: (await normalizeEvaluatorImage(image.path)).image,
  })))
  return runEvaluatorCall<T>({
    subject: options.images.map((image) => image.path).join(' + '),
    fileSha: createHash('sha256').update(normalized.map((image) => sha256Buffer(image.buffer)).join('\n')).digest('hex'),
    promptSha: options.promptSha,
    cacheDir: options.cacheDir,
    carriers: options.images.map((image) => image.contentType),
    content: [
      { type: 'text', text: options.prompt },
      ...normalized.map((image) => ({ type: 'image' as const, image: image.buffer, mediaType: image.contentType })),
    ],
  })
}

/**
 * 单次**文本**判定调用（#3128）。
 *
 * 文字交付物不该过视觉模型 —— 把 markdown 渲染成图再让 VLM 认，量到的是渲染质量不是内容。
 * 与 `askVlm` 共用同一模型、同一缓存口径，只换内容部件。
 *
 * 转写在这条通道上是**恒等的**：文本自己就是转写结果，所以调用方只需分类一次，
 * 省掉整整一半的评估器往返。
 */
/**
 * 单次**行内文本**判定调用（#3163 结构判据）。
 *
 * 与 `askTextEvaluator` 的唯一差别是证据不落盘 —— 结构判据喂的是"这件产物由哪个节点、
 * 用什么提示词产出的"，那是从图里现拼的，没有对应文件。缓存键取该文本自身的 sha，
 * 与文件通道同口径：证据一样就命中，不会因为换了一次跑而重烧一遍。
 */
export async function askInlineTextEvaluator<T>(options: {
  /** 出错信息与缓存里指认的主体（此处是节点 id，不是文件路径） */
  subject: string
  text: string
  prompt: string
  promptSha: string
  cacheDir?: string | undefined
}): Promise<T> {
  return runEvaluatorCall<T>({
    subject: options.subject,
    fileSha: createHash('sha256').update(options.text, 'utf-8').digest('hex'),
    promptSha: options.promptSha,
    cacheDir: options.cacheDir,
    content: [
      { type: 'text', text: options.prompt },
      { type: 'text', text: options.text },
    ],
  })
}

export async function askTextEvaluator<T>(options: TextCallOptions): Promise<T> {
  return runEvaluatorCall<T>({
    subject: options.textPath,
    fileSha: sha256File(options.textPath),
    promptSha: options.promptSha,
    cacheDir: options.cacheDir,
    content: [
      { type: 'text', text: options.prompt },
      { type: 'text', text: fs.readFileSync(options.textPath, 'utf-8') },
    ],
  })
}
