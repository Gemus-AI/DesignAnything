/**
 * 整套产物的**确定性**一致性（#3374，指南 §2.3 第一层）—— 色板 ΔE 与 CSD 风格自相似两列。
 *
 * ## 这一列存在的全部理由：它不依赖任何模型判断
 *
 * M2（一致性）现在的承重全压在「项目名字符串匹配」和视觉模型的双图判定上。
 * 而身份尺**实测不是确定性的**：同一对逐字节相同的图两次能判出 `different` / `unjudgeable`
 * （见 `docs/lessons.md` 与 #3372 批次）。一个会被审稿人指着问「你怎么知道你的评委没有
 * 偏向你」的指标，必须有一列是拿同一批产物就能复算的。
 *
 * 本模块因此**不调任何 LLM、不联网、不读画布**。同一批产物跑两次，分数逐位相同 ——
 * 这是它存在的全部意义，也是它唯一的验收标准。
 *
 * ## ⚠️ 隔离铁律（不可违反）
 *
 * 本判据属于**冻结 benchmark evaluator**。将来的 runtime auditor（#3177）**禁止**复用
 * 本模块。运行时机制与量尺共享偏差 = 自证循环：系统用同一把尺子既指导自己修复、
 * 又证明自己修好了。守卫见 `__tests__/setSimilarity.test.ts` 的「隔离铁律」用例
 * （它扫 `src/` 有没有 import 本模块，故意加一条 import 时必须变红）。
 * 同 `identity.ts` 的 `IDENTITY_PROMPT_SHA` 一条纪律。
 *
 * ## 两列，两种「不依赖模型判断」
 *
 * - **色板 ΔE**：纯数学 + `sharp` 解像素，同一份图两次**逐位相同**。
 * - **CSD 风格自相似**：整图过 CSD 风格编码器（CLIP ViT-L/14 + 风格投影，权重按 sha 钉死，
 *   见 `../sidecar/csd/`），整套产物两两余弦取均值。它不调 LLM、不联网，但它是一个神经网络：
 *   浮点归约顺序跨机器不保证逐位，所以它声称的是「可复现到 1e-4 余弦」，读数里带 `runtime`。
 *   向量由 `csdSidecar.ts` 经 Python 子进程算出；本模块只做余弦与判定，拿缓存的向量就能复算。
 *
 * **两列都只报数、不判 pass/fail。** 色板那列 2026-09-06 校准裁定不设阈值（信噪比 0.10）；
 * 风格这列连阈值字段都没有 —— 进不进主表由 `calibrateSetSimilarity.ts` 的判别力检验说话，
 * 其中还包含一个「风格投影 vs backbone 内容向量」的对照：风格的判别力不优于内容，就不得称
 * 「测到风格」。
 *
 * CIDS / OCCM 不在本模块：指南 v3 §2.3 已把它们降级为「只能作附录对照方法」。
 *
 * ## 三层分开报，不合成
 *
 * 指南 §2.3 结尾明确要求。本模块只产出一个连续读数与它的证据，**不与任何其它维度合成**。
 *
 * @module benchmarks/design-anything/tools/evaluator/setSimilarity
 */

import sharp from 'sharp'
import { pairStratum, type ArtifactStratum, type PairStratum } from './stratum'

/**
 * 色板提取策略 —— **写死并记录**，不因看到数据而改。
 *
 * 每一步都是整数运算或确定性排序，故同一份图跑两次逐位相同：
 *
 * 1. 最近邻缩到 64×64。`nearest` 是刻意的，与既有 `PIXEL_STRATEGY` 同一条理由：
 *    双线性会把相邻像素平均出原图里不存在的颜色，那等于给色板注入伪色。
 * 2. 按 RGB 各通道高 2 位分桶（4×4×4 = 64 格）。
 * 3. 取件数最多的前 5 格；打平时按桶序号升序，**不留给扫描顺序决定**。
 * 4. 每格的代表色 = 该格内像素的整数均值（截断，不四舍五入 —— 四舍五入在 .5 上有平台差异）。
 */
export const PALETTE_STRATEGY =
  'nearest-resize-64x64, 4x4x4 RGB bins, top-5 bins by count (ties by bin index asc), bin mean truncated to integer'

/** 本判据的规则版本。改提取策略或距离定义必须 bump —— 跨版本的 ΔE 数值不可同图。 */
export const PALETTE_RULE_VERSION = 'palette-deltaE2000/v1'

/** 取前几格。5 是「主色板」的常规规模，写死在这里而不是做成参数 —— 它是判据的一部分。 */
const PALETTE_SIZE = 5

/** CIELAB 三元组。 */
export type Lab = readonly [number, number, number]

/** 一格主色：它的 Lab 值与它在这张图里占的像素比例。 */
export interface PaletteSwatch {
  lab: Lab
  /** 该格像素数 / 采样总像素数，落在 (0, 1] */
  weight: number
}

export type Palette = readonly PaletteSwatch[]

// ---------------------------------------------------------------------------
// 色彩空间
// ---------------------------------------------------------------------------

/** sRGB 分量（0-255）→ 线性化。标准 sRGB 传递函数，不是 gamma 2.2 的近似。 */
function linearize(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** CIE XYZ → Lab 的立方根段（含线性段，避免原点附近导数发散）。 */
function labF(t: number): number {
  return t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29
}

/**
 * sRGB（0-255）→ CIELAB，D65 白点、2° 观察者。
 *
 * 必须先转到 Lab 再比距离：RGB 空间里的欧氏距离与人眼看到的差异不成比例，
 * 而这一列要回答的是「这套产物看起来像不像同一套配色」。
 */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const [lr, lg, lb] = [linearize(r), linearize(g), linearize(b)]
  // sRGB → XYZ（D65），再除以 D65 白点
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.0721750 * lb) / 1.0
  const z = (0.0193339 * lr + 0.1191920 * lg + 0.9503041 * lb) / 1.08883
  const [fx, fy, fz] = [labF(x), labF(y), labF(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const DEG = Math.PI / 180

/**
 * CIEDE2000 色差。
 *
 * 用 ΔE00 而不是 Lab 欧氏距离（ΔE76），是因为后者在蓝色区与低彩度区与人眼感知偏差很大 ——
 * 而设计产物的主色恰恰常落在这两处。实现按 Sharma / Wu / Dalal (2005) 的公式，
 * 并用他们那份 34 对的标准测试数据逐条校验（见测试文件）：这段数学有好几处容易写错的
 * 象限判断，不拿标准数据钉住就只是「看起来像对的」。
 *
 * `kL = kC = kH = 1`（图形艺术标准观察条件）。
 */
export function deltaE2000(a: Lab, b: Lab): number {
  const [l1, a1, b1] = a
  const [l2, a2, b2] = b

  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))

  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)

  // atan2 回 (-π, π]，色相角要归一到 [0, 360)；c' 为 0 时色相无定义，按标准取 0
  const hue = (ap: number, bp: number, cp: number): number => {
    if (cp === 0) return 0
    const deg = Math.atan2(bp, ap) / DEG
    return deg >= 0 ? deg : deg + 360
  }
  const h1p = hue(a1p, b1, c1p)
  const h2p = hue(a2p, b2, c2p)

  const dLp = l2 - l1
  const dCp = c2p - c1p

  // Δh' 的三分支：跨 0/360 边界时必须绕近路，否则一对相近的红会被算成差 350°
  let dhp: number
  if (c1p * c2p === 0) dhp = 0
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p
  else if (h2p - h1p > 180) dhp = h2p - h1p - 360
  else dhp = h2p - h1p + 360
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin((dhp / 2) * DEG)

  const lBarP = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2

  // 平均色相同样要处理边界；一侧彩度为 0 时取另一侧，而不是取平均
  let hBarP: number
  if (c1p * c2p === 0) hBarP = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2
  else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2
  else hBarP = (h1p + h2p - 360) / 2

  const t = 1
    - 0.17 * Math.cos((hBarP - 30) * DEG)
    + 0.24 * Math.cos(2 * hBarP * DEG)
    + 0.32 * Math.cos((3 * hBarP + 6) * DEG)
    - 0.20 * Math.cos((4 * hBarP - 63) * DEG)

  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rc = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2)
  const sc = 1 + 0.045 * cBarP
  const sh = 1 + 0.015 * cBarP * t
  const rt = -Math.sin(2 * dTheta * DEG) * rc

  return Math.sqrt(
    (dLp / sl) ** 2
    + (dCp / sc) ** 2
    + (dHp / sh) ** 2
    + rt * (dCp / sc) * (dHp / sh),
  )
}

// ---------------------------------------------------------------------------
// 色板
// ---------------------------------------------------------------------------

/**
 * 从原始像素抽主色板 —— **纯函数**，见 {@link PALETTE_STRATEGY}。
 *
 * `channels` 是每像素的字节数（`sharp` 的 `info.channels`）。只读前三个通道；
 * alpha 不进色板：一张带透明背景的 logo 的「主色」不该是它的透明区。
 */
export function extractPalette(pixels: Uint8Array, channels: number): Palette {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  for (let i = 0; i + 2 < pixels.length; i += channels) {
    const [r, g, b] = [pixels[i], pixels[i + 1], pixels[i + 2]]
    // 各通道取高 2 位 → 4×4×4 = 64 格
    const bin = (r >> 6) * 16 + (g >> 6) * 4 + (b >> 6)
    const cell = counts.get(bin)
    if (cell === undefined) counts.set(bin, { n: 1, r, g, b })
    else {
      cell.n += 1
      cell.r += r
      cell.g += g
      cell.b += b
    }
    total += 1
  }
  if (total === 0) return []

  return [...counts.entries()]
    // 件数降序；打平按桶序号升序 —— 不留给 Map 的插入顺序决定
    .sort(([binA, a], [binB, b]) => (b.n !== a.n ? b.n - a.n : binA - binB))
    .slice(0, PALETTE_SIZE)
    .map(([, cell]) => ({
      // 截断而不是四舍五入：.5 的舍入在不同平台上可以不同，而这一列要逐位可复算
      lab: srgbToLab(Math.trunc(cell.r / cell.n), Math.trunc(cell.g / cell.n), Math.trunc(cell.b / cell.n)),
      weight: cell.n / total,
    }))
}

/**
 * 两个色板之间的距离（ΔE00 单位）。
 *
 * 定义：对 A 里的每一格，取它到 B 中最近一格的 ΔE00，按 A 的权重加权平均；
 * 再对调 A/B 算一遍，取两者的均值。
 *
 * **对称化是必须的**：只算单向的话，「A 的主色在 B 里都能找到」会读成一致，
 * 而 B 里多出来的一整片色完全不受惩罚 —— 于是一张五颜六色的图与一张单色图可以判成一致。
 *
 * 空色板（读不出像素）→ `null`：这是仪器读不到，不是「色板差异为 0」。
 */
export function paletteDistance(a: Palette, b: Palette): number | null {
  if (a.length === 0 || b.length === 0) return null
  const oneWay = (from: Palette, to: Palette): number => {
    let sum = 0
    let weight = 0
    for (const swatch of from) {
      const nearest = Math.min(...to.map((other) => deltaE2000(swatch.lab, other.lab)))
      sum += nearest * swatch.weight
      weight += swatch.weight
    }
    return weight === 0 ? 0 : sum / weight
  }
  return (oneWay(a, b) + oneWay(b, a)) / 2
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** 一对产物之间的色板距离。 */
export interface PalettePair {
  a: string
  b: string
  deltaE: number
  /**
   * 这一对属于哪一层（#3531）——**纯诊断字段，不参与任何计算**。
   *
   * 它存在的理由是这一列的汇总值跨臂不可比：三条臂在「deck 页 × deck 页」与
   * 「整幅图 × 整幅图」上的占比差一个数量级，混进一个均值再排名读到的是构成差异。
   * 落到逐对上，事后不重跑就能复算分层。
   *
   * `undefined` = 该包评估于本字段存在之前，**不等于**「没有层」。
   */
  stratum?: PairStratum
}

/**
 * 色板一致性读数。
 *
 * ## 为什么 `verdict` 默认是 `not-applicable` 而 `meanDeltaE` 照样有值
 *
 * 「多大的 ΔE 算不一致」在**有真实数据之前是没有答案的**。指南 §2.3 与 §4.7 要求阈值
 * 跑前写死并进预注册清单 —— 那个数字必须由一次校准跑批产生（Issue #3374 的 P0 第二条：
 * 拿既有批次跑一遍，看「有 hero 链 / 无链」是否分开），不是我在这里凭推理拍一个。
 *
 * 所以本版把它做成**连续诊断读数**：数值恒报，判定只在 spec 显式声明阈值时才发生。
 * 一列在没有校准的情况下就进主表当 pass/fail，比没有这一列更糟 —— 它会让那些格子
 * 看起来有内容，实际是噪声。
 */
export interface PaletteConsistencyVerdict {
  verdict: 'pass' | 'fail' | 'not-applicable'
  reason: string
  /** 两两配对的加权平均 ΔE00 —— **主读数**。`null` = 可判的对数为 0 */
  meanDeltaE: number | null
  /** 最不一致的一对 —— 一个高读数必须能被反推到具体两件产物 */
  worstPair: PalettePair | null
  /** 全部可判对（原序），供离线复算 */
  pairs: PalettePair[]
  /** 参与配对的产物（读得出色板的那些） */
  judgedFiles: string[]
  /** 声明的阈值；`null` = spec 没声明，本轮只报数不判 */
  threshold: number | null
  /** 提取策略与规则版本，随读数一起走 */
  strategy: string
  ruleVersion: string
}

/**
 * 色板一致性判定 —— **纯函数**（色板喂进来）。
 *
 * 结构与 `identity.ts` 同源：真正读像素的 {@link readPalette} 单独一层，判定这一层
 * 拿缓存的色板就能重跑。一批读数出了争议时，复核不需要重新解一次图。
 *
 * 判据：
 * ```
 * not-applicable = 可判对数 < 1（少于两件读得出色板的产物 —— 一件东西与自己没有一致性可言）
 *                  或 spec 未声明阈值
 * pass           = meanDeltaE <= threshold
 * fail           = meanDeltaE >  threshold
 * ```
 */
export function scorePaletteConsistency(input: {
  /** 文件名 → 它的色板。读不出的件**不要放进来**（放进来会被当成一格空色板） */
  palettes: ReadonlyMap<string, Palette>
  /** spec 声明的阈值；缺省 = 只报数不判 */
  threshold?: number | undefined
  /**
   * 文件名 → 它的层（#3531，`stratum.artifactStrata` 的产物）。缺省 = 逐对不落层字段。
   *
   * 是**诊断输入**：给不给它，`meanDeltaE` / `verdict` 一个字节都不会变。
   */
  strata?: ReadonlyMap<string, ArtifactStratum> | undefined
}): PaletteConsistencyVerdict {
  const base = {
    threshold: input.threshold ?? null,
    strategy: PALETTE_STRATEGY,
    ruleVersion: PALETTE_RULE_VERSION,
  }
  // 文件名排序：配对顺序不能取决于上游 Map 的插入顺序，否则同一批产物两次跑出的
  // `pairs` 数组顺序不同 —— 数值一样，但「逐位相同」这条验收就守不住了
  const files = [...input.palettes.keys()].sort()

  const pairs: PalettePair[] = []
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const distance = paletteDistance(
        input.palettes.get(files[i]) ?? [],
        input.palettes.get(files[j]) ?? [],
      )
      if (distance === null) continue
      const strata = input.strata
      const left = strata?.get(files[i])
      const right = strata?.get(files[j])
      pairs.push({
        a: files[i],
        b: files[j],
        deltaE: distance,
        ...(left !== undefined && right !== undefined ? { stratum: pairStratum(left, right) } : {}),
      })
    }
  }

  if (pairs.length === 0) {
    return {
      ...base,
      verdict: 'not-applicable',
      reason: files.length < 2
        ? `only ${files.length} artifact(s) had a readable palette — a set of one has no internal consistency to measure`
        : 'no pair could be compared — every palette was empty',
      meanDeltaE: null,
      worstPair: null,
      pairs,
      judgedFiles: files,
    }
  }

  const meanDeltaE = pairs.reduce((sum, pair) => sum + pair.deltaE, 0) / pairs.length
  const worstPair = pairs.reduce((worst, pair) => (pair.deltaE > worst.deltaE ? pair : worst), pairs[0])
  const readout = `mean ΔE00 ${meanDeltaE.toFixed(2)} over ${pairs.length} pair(s); `
    + `worst ${worstPair.a} ↔ ${worstPair.b} at ${worstPair.deltaE.toFixed(2)}`

  if (input.threshold === undefined) {
    return {
      ...base,
      verdict: 'not-applicable',
      // 「没有阈值」与「阈值判过了」在结果文件里必须长得不一样
      reason: `${readout} — reported as a continuous reading only: this task declares no palette threshold, `
        + 'and a pass/fail line has not been calibrated against real batches yet (#3374 P0)',
      meanDeltaE,
      worstPair,
      pairs,
      judgedFiles: files,
    }
  }

  return {
    ...base,
    verdict: meanDeltaE <= input.threshold ? 'pass' : 'fail',
    reason: `${readout}; declared threshold ${input.threshold}`,
    meanDeltaE,
    worstPair,
    pairs,
    judgedFiles: files,
  }
}

/**
 * 读一张图的主色板。**本模块唯一碰 I/O 的地方。**
 *
 * 读不出（损坏、不是位图、`sharp` 不认）→ `null`。调用方据此把这一件排除在配对之外，
 * 而不是塞一个空色板进去 —— 后者会让「读不出」变成一次真实的读数。
 */
export async function readPalette(filePath: string): Promise<Palette | null> {
  try {
    const { data, info } = await sharp(filePath)
      .resize(64, 64, { fit: 'inside', kernel: 'nearest' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const palette = extractPalette(data, info.channels)
    return palette.length === 0 ? null : palette
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// CSD 风格自相似
// ---------------------------------------------------------------------------

/**
 * 风格判据的规则版本。它覆盖两件事：侧车的预处理串（`csd_embed.py` 的 `PREPROCESS`）与这里的
 * 距离定义。改任一处必须 bump —— 跨版本的余弦不可同图，且缓存 key 含它，bump 即作废旧缓存。
 */
export const STYLE_RULE_VERSION = 'csd-style-cosine/v1'

/** 侧车模型标识；与 `sidecar/csd/weights.lock.json` 的 `model` 字段一致。 */
export const STYLE_MODEL_ID = 'csd-vit-l'

/** 产出向量的运行时 —— 随读数持久化。命中缓存时从缓存条目读，不从本次请求读。 */
export interface StyleRuntime {
  python: string
  torch: string
  torchvision: string
  device: string
  threads: number
}

/** 一件产物的风格向量（侧车输出的 L2 归一化 768 维）。 */
export type StyleEmbedding = readonly number[]

/** 一对产物之间的风格余弦。 */
export interface StylePair {
  a: string
  b: string
  cosine: number
}

/**
 * 风格自相似读数。
 *
 * **三态必须分得开**：`unavailable`（仪器缺席 —— 侧车没跑成）≠ `not-applicable`（东西不够 ——
 * 可判件少于两件）≠ 低分（真不像）。下游把任何两态合并都是在说谎。
 *
 * **刻意没有 `threshold` / `pass|fail`**：色板那列为阈值预留了字段，结果校准裁定不设；这一列在
 * 校准给出资格之前不给旋钮，避免一个「看起来能判」的字段被误用。
 */
export interface StyleConsistencyVerdict {
  status: 'measured' | 'not-applicable' | 'unavailable'
  reason: string
  /** 两两余弦均值 —— 主读数，越大越像同一套风格。非 measured 时 null */
  meanCosine: number | null
  /** 最不像的一对（余弦最小）—— 一个低读数必须能被反推到具体两件产物 */
  worstPair: StylePair | null
  /** 全部可判对（按文件名排序后的配对序），供离线复算 */
  pairs: StylePair[]
  /** 参与配对的产物 */
  judgedFiles: string[]
  ruleVersion: string
  model: string
  /** 实际用的权重 sha；unavailable 时 null */
  weightsSha256: string | null
  runtime: StyleRuntime | null
}

/**
 * 余弦相似度。侧车输出已 L2 归一化，所以这等于点积；这里仍除以范数，
 * 让一份被截断或改写过的向量不会静默给出错误的数。
 */
export function cosineSimilarity(a: StyleEmbedding, b: StyleEmbedding): number {
  if (a.length !== b.length || a.length === 0) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) throw new Error('cosineSimilarity: zero-norm vector')
  return dot / Math.sqrt(na * nb)
}

/**
 * 风格自相似判定 —— **纯函数**（向量喂进来）。
 *
 * 判据：
 * ```
 * unavailable    = 调用方声明侧车没跑成（`unavailable` 非空）
 * not-applicable = 可判件 < 2（一件东西与自己没有一致性可言）
 * measured       = 其余；meanCosine = 全部两两余弦的均值
 * ```
 */
export function scoreStyleConsistency(input: {
  /** 文件名 → 风格向量。侧车没算出来的件**不要放进来** */
  embeddings: ReadonlyMap<string, StyleEmbedding>
  /** 侧车没跑成时的理由；给了就整列 unavailable */
  unavailable?: string | undefined
  /** 侧车产出这批向量的 provenance；unavailable 时可缺省 */
  provenance?: { weightsSha256: string; runtime: StyleRuntime } | undefined
  /** 侧车对单张图报的失败数，进 reason 让「measured 但少件」可见 */
  failedFiles?: number | undefined
}): StyleConsistencyVerdict {
  const base = {
    ruleVersion: STYLE_RULE_VERSION,
    model: STYLE_MODEL_ID,
    weightsSha256: input.provenance?.weightsSha256 ?? null,
    runtime: input.provenance?.runtime ?? null,
  }
  if (input.unavailable !== undefined) {
    return {
      ...base,
      status: 'unavailable',
      reason: `style sidecar unavailable — ${input.unavailable}`,
      meanCosine: null,
      worstPair: null,
      pairs: [],
      judgedFiles: [],
    }
  }
  // 文件名排序：配对顺序不能取决于上游 Map 的插入顺序（与色板列同一条纪律）
  const files = [...input.embeddings.keys()].sort()
  const failedNote = input.failedFiles !== undefined && input.failedFiles > 0
    ? `; ${input.failedFiles} file(s) failed to embed` : ''
  if (files.length < 2) {
    return {
      ...base,
      status: 'not-applicable',
      reason: `only ${files.length} artifact(s) had a style embedding — a set of one has no internal consistency to measure${failedNote}`,
      meanCosine: null,
      worstPair: null,
      pairs: [],
      judgedFiles: files,
    }
  }
  const pairs: StylePair[] = []
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const a = input.embeddings.get(files[i])
      const b = input.embeddings.get(files[j])
      if (a === undefined || b === undefined) continue
      pairs.push({ a: files[i], b: files[j], cosine: cosineSimilarity(a, b) })
    }
  }
  const meanCosine = pairs.reduce((sum, pair) => sum + pair.cosine, 0) / pairs.length
  const worstPair = pairs.reduce((worst, pair) => (pair.cosine < worst.cosine ? pair : worst), pairs[0])
  return {
    ...base,
    status: 'measured',
    reason: `mean cosine ${meanCosine.toFixed(4)} over ${pairs.length} pair(s); `
      + `least similar ${worstPair.a} ↔ ${worstPair.b} at ${worstPair.cosine.toFixed(4)}${failedNote}`
      + ' — reported as a continuous diagnostic reading only (no threshold, see calibrateSetSimilarity.ts)',
    meanCosine,
    worstPair,
    pairs,
    judgedFiles: files,
  }
}
