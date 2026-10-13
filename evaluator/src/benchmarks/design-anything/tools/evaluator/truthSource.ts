/**
 * 判据的**真值来源**（#3518）—— 「这条约束的正确答案在哪里」。
 *
 * ## 这个字段回答的是维度划分问题，不是实现问题
 *
 * M1 与 M2 此前是按**实现手段**编组的：确定性规则一层、视觉模型一层、派生约束一层。
 * 手段不是被测性质，于是同一个性质散落在两个维度里，同一条证据被各消费一次。
 * v0.5 实测：41 条 `setConsistency` 里 35 条与 M1 的 `text-verbatim` 约束是同一个字符串，
 * 而代表件上拼错时两边同时 fail —— 最重的那次失败被扣了两次。
 *
 * 分界只需要一个问题：
 *
 * - **答案在题面或素材包里** → 测的是「做对了没有」，归 **M1**。
 *   brief 写死品牌名叫 `EMBER GRAIN`；素材包给了客户的 logo 源文件。
 * - **答案只存在于这次运行的产物里** → 测的是「自己说的话算不算数」，归 **M2**。
 *   策略稿说主色是 `#1F6FEB`，而这个颜色是系统自己选的，题面从没规定过。
 *
 * 这条分界让 M2 的定义与论文的主张对齐：审计层让前期决定约束后期产物。
 *
 * ## 为什么是**派生**而不是**声明**
 *
 * 真值来源不是写题人的自由选择 —— 它由规则自身的锚唯一决定：锚是素材包附件就是 `assets`，
 * 锚是本次运行的槽就是 `run`，题面写死的 token 就是 `brief`。让写题人再声明一遍，
 * 只会引入「声明与锚不符」这一类新错误，并且要求 252 份 spec 全部返工。
 *
 * 所以本模块**默认派生**，`truthSource` 字段只是可选的**冗余声明**：写了就必须与派生值一致
 * （加载期拒绝），不写就按锚推。既有 spec 一个字都不用改。
 *
 * ## ⚠️ 隔离铁律
 *
 * 本模块属于**冻结 benchmark evaluator**。运行时 auditor 禁止复用 —— 运行时机制与量尺
 * 共享偏差 = 自证循环。同 `identity.ts` / `setSimilarity.ts` 一条纪律。
 *
 * @module benchmarks/design-anything/tools/evaluator/truthSource
 */

import type { CarryThroughRule, Constraint, IdentityConsistencyRule, SetConsistencyRule, SlotStage, TaskSpec } from './taskSpec'

/**
 * 一条判据的正确答案在哪里。
 *
 * - `brief`：在题面里（brief 逐字写明的名字、数值、口号）
 * - `assets`：在素材包里（客户给的产品照片、logo 源文件、釉色样片）
 * - `run`：只在这次运行的产物里（系统自己选的主色、自己起的名字、自己定的方向）
 */
export type TruthSource = 'brief' | 'assets' | 'run'

export const TRUTH_SOURCES: readonly TruthSource[] = ['brief', 'assets', 'run']

/**
 * 报表分组用的维度归属。`brief` 与 `assets` 都测「做对了没有」，同归 M1 侧；
 * 只有 `run` 是「自己说的话算不算数」，进 M2 主表。
 *
 * 两者仍要**分列报**而不是合并：`assets` 那一列是全库唯一能判「有没有编造产品细节」的地方
 * （指南 §2.3 已知限制），把它折进 `brief` 会让这个读数消失。
 */
export function dimensionOf(source: TruthSource): 'M1' | 'M2' {
  return source === 'run' ? 'M2' : 'M1'
}

/**
 * 身份规则的真值来源，由锚唯一决定。
 *
 * - `anchorAssets` → `assets`：锚是客户给的附件，答案在素材包里
 * - `anchorSlot` → `run`：锚是本次运行某个槽的交付件，答案只在这次运行里
 *
 * 加载期已保证两者恰好写一个（`assertTaskSpec`），故这里不做二选一校验。
 */
export function identityTruthSource(rule: Pick<IdentityConsistencyRule, 'anchorAssets'>): TruthSource {
  return rule.anchorAssets !== undefined ? 'assets' : 'run'
}

/**
 * 逐字约束恒为 `brief`：`text-verbatim` 的文本与 `pixel-color` 的色值都是写题时从 brief 抄下来的。
 * 素材包里的事实要进判据，走 `identityConsistency.anchorAssets`，不走 `constraints`。
 */
export function constraintTruthSource(_constraint: Constraint): TruthSource {
  return 'brief'
}

/**
 * `setConsistency` 的 token 也来自题面 —— 它判的是「题面给定的这个词，在提到它的件上拼法一不一致」。
 *
 * **这是本 issue 要消掉的双扣的来源**：同一个 token 同时是 M1 的 `text-verbatim` 约束时，
 * 代表件上拼错会让两边同时 fail。去重发生在打分层（`scoreSetConsistency` 的作用面减法），
 * 不在这里 —— 本模块只回答「它属于哪一侧」。
 */
export function setConsistencyTruthSource(_rule: SetConsistencyRule): TruthSource {
  return 'brief'
}

/** `carryThrough` 恒为 `run`：它提取的决定是系统运行时自己写下的，题面里没有。 */
export function carryThroughTruthSource(_rule: CarryThroughRule): TruthSource {
  return 'run'
}

/**
 * 冗余声明与派生值不一致时的报错文本。
 *
 * 单独抽出来是为了让两处调用（identity / carryThrough）的措辞逐字相同 ——
 * 加载期错误信息是写题人唯一会读的文档。
 */
export function truthSourceMismatch(where: string, kind: string, ruleId: string, declared: string, derived: TruthSource): string {
  return `${where}: ${kind} "${ruleId}" declares truthSource "${declared}" but its anchor makes it "${derived}" — `
    + 'the field is a redundant assertion, not a choice: an asset anchor is always "assets", a slot anchor always "run". '
    + 'Fix the anchor or drop the field.'
}

/**
 * 校验一条规则的冗余声明。未声明即通过（派生值就是答案）。
 *
 * @throws 声明值不是合法取值，或与派生值不符
 */
export function assertDeclaredTruthSource(
  where: string,
  kind: string,
  ruleId: string,
  declared: unknown,
  derived: TruthSource,
): void {
  if (declared === undefined) return
  if (typeof declared !== 'string' || !TRUTH_SOURCES.includes(declared as TruthSource)) {
    throw new Error(`${where}: ${kind} "${ruleId}" truthSource must be one of ${TRUTH_SOURCES.join(', ')}, got ${JSON.stringify(declared)}`)
  }
  if (declared !== derived) throw new Error(truthSourceMismatch(where, kind, ruleId, declared, derived))
}

// ---------------------------------------------------------------------------
// 配色：从身份尺退役
// ---------------------------------------------------------------------------

/**
 * ## 配色为什么从身份尺退役
 *
 * 配色一致性有一列**纯确定性**的读数（`setSimilarity.ts` 的色板 ΔE00，同一批图跑两次逐位相同），
 * 而 `subject: palette` 走的是视觉模型二值判定、进主表。同一个性质，可复算的那列被降级、
 * 不可复算的那列定胜负 —— 这站不住，且 ViStoryBench 的 CIDS 与 DreamBench++ 的概念保持
 * 判的都是主体身份，没有一篇支持拿身份判据判配色。
 *
 * ## 退役发生在**打分期**，不在加载期
 *
 * 两个理由，都是「不要让这个改动溢出到它不该碰的地方」：
 *
 * 1. **加载期拒绝会打破向后兼容。** v0.1–v0.4 分别有 13 / 13 / 13 / 12 条这样的规则，
 *    而 `assertTaskSpec` 对不合法的 subject 是抛错。真在加载期拒了，这四个版本的历史导出包
 *    再也加载不进来，**重评这条路直接断掉** —— 而 09-07 的 OD/JH 两臂 80 格跑的正是 v0.1。
 * 2. **从 v0.5 里删掉这些规则不是一个自足的改动。** 题包的 SHA 绑定台账（`batches/first20/batch.json`、
 *    `v0.5/closure/requirements.json`、`v0.5/visual-revision.json`）会随之失效，那是 87+ 条绑定、
 *    没有重生成脚本、且由题包维护者拥有的完整性机制。评估器的改动不该顺手改它。
 *
 * 所以本模块只做一件事：**打分期一律记 `not-applicable`**（见 {@link PALETTE_RETIRED_REASON}）。
 * 效果与删除一致 —— 那些规则不再贡献任何读数 —— 而所有版本的题包照常加载、历史批次照常重评。
 * 题包里那些已经不产生读数的死规则，由题包维护者在下一次 v0.6 编题时一并清掉。
 */

/** 打分期给退役的配色身份规则写的理由。措辞固定，报表按它识别这一类。 */
export const PALETTE_RETIRED_REASON =
  'palette consistency is measured by the deterministic ΔE00 column (setSimilarity), not by the identity judge — '
  + 'this rule is retired and contributes no reading (#3518)'

/**
 * 这条身份规则是不是已退役的配色规则。
 *
 * ## 只退役**槽锚**的那些，素材锚的留着
 *
 * 初稿写的是「删掉全部 `subject: palette`」。落地时逐条看 v0.5 的 12 条，发现 craft-01 的
 * `glaze-from-tiles` 锚的是素材包里的釉色样片（`anchorAssets`），它问的是
 * **「烧出来的釉色是不是客户给的那个釉色」**。
 *
 * **ΔE00 那一列答不了这个问题**：它是整套产物**两两对称比**、刻意**不与锚定件比**
 * （指南 §2.3：锚定件在多数题里是另一类产物，跨类主色本就该不同）。所以它度量的是
 * 「这套东西自己内部配色散不散」，而不是「配色对不对得上客户给的样片」。两个不同的主张。
 *
 * 判据正好落在真值来源上：
 *
 * - `truthSource === 'run'`（槽锚）→ 主张是「套内自洽」→ **ΔE00 覆盖它** → 退役
 * - `truthSource === 'assets'`（素材锚）→ 主张是「有没有编造」→ ΔE00 覆盖不了 → **保留**
 *
 * 素材锚那一档本来就按 #3518 归 M1 侧单列报，是全库唯一能判「有没有编造产品细节」的地方
 * （指南 §2.3 已知限制）。把它一起删掉会静默丢掉这个读数。
 *
 * v0.5 的 12 条里 11 条是槽锚（退役），1 条是素材锚（保留）。
 */
export function isRetiredPaletteRule(rule: Pick<IdentityConsistencyRule, 'subject' | 'anchorAssets'>): boolean {
  return rule.subject === 'palette' && identityTruthSource(rule) === 'run'
}

// ---------------------------------------------------------------------------
// 身份一致性：三种主张分档
// ---------------------------------------------------------------------------

/**
 * 身份规则的三档（#3518）。分档依据是**这条规则在主张什么**，不是它用什么工具判。
 *
 * - `assets`：锚是素材包附件。主张是**「有没有编造」** —— 交出来的产品长得是不是客户给的那个。
 *   真值来源 `assets`，归 M1 侧。这是全库唯一能问这个问题的地方。
 * - `run`：锚是本次运行某个槽的代表件。主张是**「同一个物件」** —— 主图里的杯子和详情图里的
 *   是不是同一只。真值来源 `run`，归 M2 侧。
 * - `lineage`：锚是**过程阶段**某个槽里的任一件（`stage: 'process'` + `anchorSelect: 'any'`）。
 *   主张是**「血脉关系」** —— 定稿是不是从那三个方向里的某一个发展来的。这**不是**同一个物件：
 *   方向稿到定稿之间本来就该变。
 *
 * ## 为什么必须分开报
 *
 * 三档合成一个通过率之后，读者看不出赢在哪。更要紧的是第三档**用错了尺子**：双图判定问的是
 * 「是不是同一个」，而血脉链正确的答案常常是「不是同一个，但是从它来的」—— 拿身份尺核血脉链
 * 必然朝 `different` 偏。合成之后这个系统性偏差被摊进总数里，看不见。
 *
 * ## v1 用 `anchorSelect: 'any'` 单独判档，扫错了一批（#3566）
 *
 * 「锚槽里有多件、对上任一件就算」这个形状同时对应两种意思，而只有前一种是血脉关系：
 *
 * - **N 个互斥的备选** —— 三个方向稿里选一个发展下去。定稿与另外两个本来就不是同一个东西。
 * - **N 个并存的成员** —— 一部书里的两个主角、一套家具的三个模块、一系列首饰的六件设计图。
 *   一张只画了 Pip 的场景图本来就只该与 Pip 的角色设定页对上，「对上任一件」正是**正确**的聚合。
 *
 * v0.1 实测：16 条 `any` 规则里 11 条是前者、5 条是后者。按 `any` 一刀切退役，把 story-01 的
 * `same-characters`（brief 原文 "Mara and Pip look the same on the cover, in every scene and in
 * every storyboard panel"）也扫掉了 —— 而那道题**没有第二条身份规则**，整套细则问的是场景光线
 * 和分镜顺序，于是**全库最典型的角色一致性判据所在的那道题，没有任何判据再问「是不是同一个人」**。
 *
 * 分界改用题包**已有**的 `stage` 字段（`SlotSpec.stage`，指南 §2.2/§3）：`process` = 为推进项目
 * 而交的过程成果，`final` = 客户真正拿去用的最终成果。备选方向天然是 `process`，阵容成员天然是
 * `final`。**题包一个字都不用改**，历史题包逐字节不动。
 *
 * 两个条件是**合取**：`stage: 'process'` 单独不够（规范页、材质板也是 process，它们是单件锚，
 * 不是备选关系），`anchorSelect: 'any'` 单独也不够（就是 v1 扫错的那一批）。
 *
 * v0.5 实测：`anchorAssets` 6 条、`anchorSlot` 代表件 17 条、`anchorSlot + anchorSelect: 'any'` 6 条。
 */
export type IdentityBand = 'assets' | 'run' | 'lineage'

export const IDENTITY_BANDS: readonly IdentityBand[] = ['assets', 'run', 'lineage']

/**
 * 规则 → 档。纯函数，由锚的形状与锚槽的阶段唯一决定，与判定结果无关。
 *
 * 与 {@link identityTruthSource} 的关系：`assets` 档 ⟺ 真值来源是 `assets`；另外两档的真值来源
 * 都是 `run`，分档是在 M2 侧内部再切一刀（同一物件 vs 血脉关系）。
 *
 * `anchorStage` 是**锚槽**的 `stage`（不是规则的属性，故由调用方从 spec 取）。取不到时按 `run`
 * 处理：退役是不可逆地丢掉一条读数，证据不足时不该做这件事 —— 多留一条读数看得见，
 * 少一条读数没人会发现（#3566 就是这么发生的）。
 */
export function identityBand(
  rule: Pick<IdentityConsistencyRule, 'anchorAssets' | 'anchorSelect'>,
  anchorStage?: SlotStage,
): IdentityBand {
  if (identityTruthSource(rule) === 'assets') return 'assets'
  return rule.anchorSelect === 'any' && anchorStage === 'process' ? 'lineage' : 'run'
}

// ---------------------------------------------------------------------------
// 血脉链：从身份尺退役
// ---------------------------------------------------------------------------

/**
 * ## 血脉链档为什么退役（#3557）
 *
 * 两条理由，第二条才是决定性的。
 *
 * **一、它用的是问错了的那句话。** 双图判定问「是不是同一个」，而血脉链正确的答案常常是
 * 「不是同一个，但是从它来的」—— 方向稿到定稿之间本来就该变（材质深化、比例调整）。
 * 这一档因此系统性朝 `different` 偏。
 *
 * **二、它想问的那件事，整套细则已经问了，而且问得更准。** `anchorSelect: 'any'` 的语义是
 * 「与锚槽里**任一件**对上就算同一」，而这些规则真正要问的是「**每一件**对上**它自己对应的
 * 那一件**」。两者不等价且方向相反：`any` 会把「五件里只有一件对上」判成通过。实测三道题里
 * 同一句话被问了两遍，而整套细则那一遍显式排除了这个陷阱：
 *
 * - `craft-01`：身份 `same-pieces`（锚 `three-view`，any）vs 整套条目
 *   「each piece … matches its corresponding three-view … **one matching piece does not
 *   establish agreement for the whole set**」
 * - `jewelry-01`：身份 `same-pieces`（锚 `pieces`，any）vs 整套条目
 *   「Every jewellery design … matches **its own** design drawing, rather than merely
 *   matching one other item in the series」
 * - `fashion-01`：身份 `garments`（锚 `flats`，any）vs 整套条目
 *   「Every garment … matches **its own** technical flat … a match to one garment does not
 *   establish the others」
 *
 * **题包作者已经知道这个陷阱并在整套细则里绕开了，而同一道题的身份规则仍然踩着它。**
 * 保留一把已知问错、且被另一把问对的尺子覆盖了的仪器，只会往读数里掺噪音。
 *
 * ## 退役发生在打分期，理由同配色（见 {@link isRetiredPaletteRule}）
 *
 * 加载期拒绝会打破向后兼容 —— 历史导出包再也重评不了。打分期记 `not-applicable`，
 * 效果与删除一致，而所有版本的题包照常加载。题包里的死规则由维护者在下一次编题时清掉。
 */
export const LINEAGE_RETIRED_REASON =
  'the lineage band is retired: the pairwise judge asks "is this the same object" while a lineage claim is '
  + '"not the same object, but developed from it", and the claim it actually tests is already covered — more '
  + 'precisely — by the set rubric (#3557)'

/** 这条身份规则是不是已退役的血脉链规则。 */
export function isRetiredLineageRule(
  rule: Pick<IdentityConsistencyRule, 'anchorAssets' | 'anchorSelect'>,
  anchorStage?: SlotStage,
): boolean {
  return identityBand(rule, anchorStage) === 'lineage'
}

// ---------------------------------------------------------------------------
// 逐条退役：这条规则问的事，同一道题的整套细则问得更准
// ---------------------------------------------------------------------------

/**
 * #3557 逐条核过、确认被整套细则更准覆盖的身份规则。
 *
 * 与血脉链退役是**两件不同的事**，所以不共用一个开关：血脉链退役的理由是「锚是备选、问错了
 * 问题」，是规则形状的性质；这三条的理由是「同一道题里另一把尺子把同一句话问得更准」，
 * 是逐条的编辑判断。#3566 之前它们搭了 `anchorSelect: 'any'` 的便车 —— 便车一撤，
 * 理由必须自己站住，所以逐条列出并附出处。
 *
 * 三条的共同陷阱：`anchorSelect: 'any'` 的语义是「对上锚槽里**任一件**就算同一」，而这些规则
 * 真正要问的是「**每一件**对上**它自己对应的那一件**」。`any` 会把「五件里只有一件对上」判成通过，
 * 而同一道题的整套细则显式排除了这个陷阱。**注意这不适用于阵容型的锚槽**（story-01 的两个主角、
 * furniture-01 的三个模块）：那里「对上任一件」就是对的聚合。
 *
 * 每条都记下覆盖它的整套细则条目原文片段，而退役**由那句话在不在同一份 spec 里派生**，
 * 不是由这张表断言。**覆盖没了，退役就自动失效** —— 这张表因此不会变成一张没人敢动的例外表。
 *
 * 这一条不是洁癖：#3557 引的是 v0.5 的条目原文，而 v0.1 的 craft-01 整套细则写的是
 * 「the five pieces share one form language and glaze」（共享风格），**根本没问逐件身份**。
 * 按表退役会让 v0.1 上这条读数凭空消失且无人替补 —— 与 story-01 是同一个病。
 */
export const IDENTITY_RULES_COVERED_BY_SET_RUBRIC: readonly {
  taskId: string
  ruleId: string
  /** 覆盖它的整套细则条目里的一段原文 */
  coveringItem: string
}[] = [
  {
    taskId: 'bench-da-craft-01',
    ruleId: 'same-pieces',
    coveringItem: 'one matching piece does not establish agreement for the whole set',
  },
  {
    taskId: 'bench-da-jewelry-01',
    ruleId: 'same-pieces',
    coveringItem: 'rather than merely matching one other item in the series',
  },
  {
    taskId: 'bench-da-fashion-01',
    ruleId: 'garments',
    coveringItem: 'a match to one garment does not establish the others',
  },
]

export const COVERED_BY_SET_RUBRIC_REASON =
  'this identity rule is retired: the set rubric of the same task asks the same question more precisely — '
  + '"every item matches its own reference" rather than "matches any one of them" (#3557, scoped by #3566)'

/**
 * 这条身份规则是不是被**同一份 spec 里**的整套细则更准地覆盖了。
 *
 * `setRubricItems` 是这道题整套细则的全部条目原文。传空数组 = 拿不到细则 → 一律不退役：
 * 没看见证据时保留读数，与 {@link identityBand} 对 `anchorStage` 缺失时的处置同一条纪律。
 */
export function isCoveredBySetRubric(
  taskId: string, ruleId: string, setRubricItems: readonly string[],
): boolean {
  const entry = IDENTITY_RULES_COVERED_BY_SET_RUBRIC
    .find((candidate) => candidate.taskId === taskId && candidate.ruleId === ruleId)
  if (entry === undefined) return false
  return setRubricItems.some((item) => item.includes(entry.coveringItem))
}

/**
 * 这条身份规则退役了吗；退役了给出写进读数的理由，没退役给 `null`。
 *
 * 两条退役规则合并成一个出口，是为了让 `identity.ts` 的调用处只有一个分支 ——
 * 退役理由是写进 `evaluation.json` 的**读数**，措辞必须与判据一一对应，不能在调用处拼。
 */
/**
 * 从一份 spec 里取 {@link retiredIdentityReason} 要的上下文（#3609）。
 *
 * 退役判断自 #3566 起要看锚槽的阶段与整套细则的原文，两者都写在 spec 上不写在规则上。
 * 出题侧的写法门、逐要求接线与仪器清单要做同一个判断，派生只写这一处 —— 各处自己抄一遍
 * `slots.find(...)`，就是 `sampleForCalibration.ts` 模块头记的那类错。
 */
export function identityRuleContext(
  spec: Pick<TaskSpec, 'taskId' | 'slots' | 'setVlmRubric'>,
  rule: Pick<IdentityConsistencyRule, 'anchorSlot'>,
): { taskId: string; anchorStage?: SlotStage; setRubricItems: readonly string[] } {
  const anchorStage = rule.anchorSlot === undefined ? undefined : spec.slots.find((slot) => slot.id === rule.anchorSlot)?.stage
  return {
    taskId: spec.taskId,
    ...(anchorStage === undefined ? {} : { anchorStage }),
    setRubricItems: (spec.setVlmRubric ?? []).flatMap((rubric) => rubric.items.map((item) => (typeof item === 'string' ? item : item.item))),
  }
}

export function retiredIdentityReason(
  rule: Pick<IdentityConsistencyRule, 'id' | 'subject' | 'anchorAssets' | 'anchorSelect'>,
  context: { taskId: string; anchorStage?: SlotStage; setRubricItems?: readonly string[] },
): string | null {
  if (isRetiredPaletteRule(rule)) return PALETTE_RETIRED_REASON
  if (isRetiredLineageRule(rule, context.anchorStage)) return LINEAGE_RETIRED_REASON
  if (isCoveredBySetRubric(context.taskId, rule.id, context.setRubricItems ?? [])) return COVERED_BY_SET_RUBRIC_REASON
  return null
}
