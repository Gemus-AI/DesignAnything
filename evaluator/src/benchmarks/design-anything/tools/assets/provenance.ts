/**
 * 素材出处与授权清单（#3428）—— 指南「素材来源政策」的可执行部分。
 *
 * ## 它补的是哪个空缺
 *
 * 题库要随论文公开分发，所以**授权是第一约束**。而在此之前，`manifest.json` 的每件素材
 * 只声明了 `source`（`gpt-image-2@apimart` / `authored`），**没有任何地方记录授权**：
 * 一件素材能不能随题库发出去，全靠"我们知道它是自己产的"这条口头共识。换一个人、
 * 换一个图源（比如从博物馆开放数据取图），这条共识立刻失效且无人察觉。
 *
 * 本模块把三件事变成可执行判据：
 *
 * 1. **授权取值是封闭词表**，不是自由文本。词表外的值即违规 —— 这样"忘了想授权"
 *    会变成一次红色，而不是一个空字段。
 * 2. **带署名义务的许可必须带署名与可核对的出处**。署名义务是随分发走的，漏了就是违约。
 * 3. **磁盘上的每个文件都必须被声明**。没被声明的文件 = 没有出处的文件 ——
 *    它照样会被打包发出去，所以"漏声明"必须是红色，而不是沉默。
 *
 * ## 不做的事
 *
 * 它**不**判断素材好不好、成不成套。成套性是另一件事，由 `checkSetConsistency.ts`
 * 用双图判定回答；本模块只管"这件东西能不能合法地发出去、出处写清楚了没有"。
 *
 * @module benchmarks/design-anything/tools/assets/provenance
 */

import fs from 'node:fs'
import path from 'node:path'

import { IDENTITY_SUBJECTS } from '../evaluator/taskSpec'
import { BENCH_ASSETS_ROOT, expandAsset, readManifest, type Manifest, type ManifestAsset } from './manifestExpand'

/**
 * 授权取值的**封闭词表**。新增取值必须同时在指南「素材来源政策」里写清它的分发含义 ——
 * 这里多一个字符串，等于多一类可以随论文发出去的素材。
 *
 * - `generated-output`：生成模型产出。不是第三方版权素材，但**自带真值缺失**这个已知代价
 *   （见指南：锚是生成的，"有没有编造产品细节"在源头就没有可比对的真实样子）。
 * - `authored-in-repo`：本仓库自制（写题人手写的文档、`author-drawings.ts` 从几何数据渲染的图纸）。
 * - `CC0`：明确采用 CC0 的开放数据（博物馆开放数据等）。仍需记 `source`。
 * - `public-domain`：作者已核验的公版素材，须记可核对 `source` 与原作/数字版本 `rightsBasis`；不以类型本身要求署名。
 * - `CC-BY`：署名许可。**必须**同时有 `credit` 与可核对的 `source`。
 * - `CC-BY-SA`：署名、相同方式共享许可；必须记录 `credit`、许可链接与可核对的 `source`。
 * - `OGL-Toronto-1.0`：多伦多开放数据许可；必须记录 `credit`、许可链接与可核对的 `source`。
 * - `self-shot`：自摄实物/实地照片。成套性最干净，成本最高。
 *
 * 刻意**没有**的取值：`NonCommercial`（题库要公开分发）、`unknown`（不知道就是不能用）、
 * 商业图库（标准授权通常禁止再分发）。
 */
export const ASSET_LICENSES = [
  'generated-output',
  'authored-in-repo',
  'CC0',
  'public-domain',
  'CC-BY',
  'CC-BY-SA',
  'OGL-Toronto-1.0',
  'self-shot',
] as const

export type AssetLicense = (typeof ASSET_LICENSES)[number]

/** 需要署名才能分发的授权 —— 缺 `credit` 即违约，不是风格问题。 */
const CREDIT_REQUIRED: ReadonlySet<string> = new Set<AssetLicense>(['CC-BY', 'CC-BY-SA', 'OGL-Toronto-1.0'])

/** 出处必须能被第三方核对（URL 或馆藏号）的授权。自产素材的出处是脚本本身，不适用。 */
const VERIFIABLE_SOURCE_REQUIRED: ReadonlySet<string> = new Set<AssetLicense>(['CC0', 'public-domain', 'CC-BY', 'CC-BY-SA', 'OGL-Toronto-1.0'])

export interface ProvenanceViolation {
  taskId: string
  file: string
  reason: string
}

/** 出处看起来可被第三方核对：URL，或"馆藏:编号"这类带冒号的登记号。 */
function looksVerifiable(source: unknown): boolean {
  return typeof source === 'string' && (/^https?:\/\//.test(source) || /^[a-z-]+:[^\s]/i.test(source))
}

/**
 * 逐件核 `manifest.json` 的授权声明。**纯函数** —— 不读磁盘，可在测试里喂任意清单。
 */
export function validateManifestProvenance(manifest: Manifest): ProvenanceViolation[] {
  const violations: ProvenanceViolation[] = []
  for (const task of manifest.tasks) {
    for (const asset of task.assets) {
      const license = (asset as ManifestAsset & { license?: unknown }).license
      const credit = (asset as ManifestAsset & { credit?: unknown }).credit
      const rightsBasis = (asset as ManifestAsset & { rightsBasis?: unknown }).rightsBasis
      const at = { taskId: task.taskId, file: asset.file }

      if (typeof license !== 'string' || !(ASSET_LICENSES as readonly string[]).includes(license)) {
        violations.push({ ...at, reason: `license 缺失或不在词表内：${JSON.stringify(license)}。词表 = ${ASSET_LICENSES.join(' | ')}` })
        continue
      }
      if (CREDIT_REQUIRED.has(license) && (typeof credit !== 'string' || credit.trim() === '')) {
        violations.push({ ...at, reason: `${license} 带署名义务，必须填 credit` })
      }
      if (VERIFIABLE_SOURCE_REQUIRED.has(license) && !looksVerifiable(asset.source)) {
        violations.push({ ...at, reason: `${license} 的 source 必须可被第三方核对（URL 或馆藏号），现为 ${JSON.stringify(asset.source)}` })
      }
      // 这里只核声明完整性；历史原作与数字版本的实际权利状态仍需作者审查。
      if (license === 'public-domain' && (typeof rightsBasis !== 'string' || rightsBasis.trim() === '')) {
        violations.push({ ...at, reason: 'public-domain 必须填非空 rightsBasis，说明原作公版判断与实际数字版本使用依据' })
      }
      // 成套性主张必须显式 —— 见 ManifestAsset.setAssertion：两种默认都比报红差
      if (asset.conditionOn !== undefined && asset.setAssertion === undefined) {
        violations.push({ ...at, reason: `有 conditionOn 就必须写 setAssertion（same-object | same-family）—— 缺省会让成套性自检要么静默跳过、要么造出必然的假警报` })
      }
      // 要核就得说清核的是"同一个什么"：主体缺省会让判定 prompt 拼出坏句子，
      // 2026-09-06 实测让 logo 那一对直接判成 unjudgeable
      if (asset.setAssertion === 'same-object'
        && !(IDENTITY_SUBJECTS as readonly string[]).includes(String(asset.setSubject))) {
        violations.push({ ...at, reason: `same-object 必须写 setSubject，取值 ${IDENTITY_SUBJECTS.join(' | ')}，现为 ${JSON.stringify(asset.setSubject)}` })
      }
    }
  }
  return violations
}

/**
 * 图纸的两个同名旁生文件 —— `author-drawings.ts` 出 `<name>.png` 时一并写出
 * `<name>.svg`（源）与 `<name>.geometry.json`（真值）。清单只声明进 scenario 的那张 PNG，
 * 这两个跟着它走，出处与授权同源。
 *
 * 这是**白名单，不是通配**：只有当同目录下存在被声明的 `<name>.png` 时才算被覆盖。
 * 一个孤零零的 `.svg` 仍然是"没有出处的文件"，照样报红。
 */
const DRAWING_SIDECAR_SUFFIXES = ['.svg', '.geometry.json'] as const

function sidecarOwner(file: string): string | null {
  for (const suffix of DRAWING_SIDECAR_SUFFIXES) {
    if (file.endsWith(suffix)) return `${file.slice(0, -suffix.length)}.png`
  }
  return null
}

export interface FileReconciliation {
  /** 磁盘上有、清单里没有 —— 会被打包发出去却没有出处 */
  undeclared: string[]
  /** 清单里有、磁盘上没有 —— 题目引用得到一个不存在的文件 */
  missing: string[]
}

/**
 * 对账"清单声明的"与"磁盘上有的"。**纯函数**，两侧都由调用方给出。
 *
 * 两个方向都要报：漏声明 = 无出处素材被分发；漏文件 = 题目引用空气。
 */
export function reconcileAssetFiles(input: {
  declared: readonly string[]
  onDisk: readonly string[]
}): FileReconciliation {
  const declared = new Set(input.declared)
  const undeclared: string[] = []
  for (const file of input.onDisk) {
    if (declared.has(file)) continue
    const owner = sidecarOwner(file)
    // 旁生文件只在"它的 PNG 被声明了"时才算有出处
    if (owner !== null && declared.has(owner)) continue
    undeclared.push(file)
  }
  const onDisk = new Set(input.onDisk)
  return {
    undeclared: undeclared.sort(),
    missing: input.declared.filter((file) => !onDisk.has(file)).sort(),
  }
}

/** 清单展开后声明的全部文件（`<taskId>/<file>`）。 */
export function declaredAssetFiles(manifest: Manifest): string[] {
  return manifest.tasks
    .flatMap((task) => task.assets.flatMap((asset) => expandAsset(task.taskId, asset)))
    .map((asset) => `${asset.taskId}/${asset.file}`)
    .sort()
}

/** 素材根目录下实际存在的全部文件（`lock.json` 是生成记录，不是素材）。 */
export function assetFilesOnDisk(root: string = BENCH_ASSETS_ROOT): string[] {
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  for (const taskId of fs.readdirSync(root).sort()) {
    const dir = path.join(root, taskId)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir).sort()) {
      if (file === 'lock.json') continue
      files.push(`${taskId}/${file}`)
    }
  }
  return files
}

function main(): void {
  const manifest = readManifest()
  const violations = validateManifestProvenance(manifest)
  const reconciliation = reconcileAssetFiles({
    declared: declaredAssetFiles(manifest),
    onDisk: assetFilesOnDisk(),
  })

  for (const violation of violations) {
    console.error(`✗ ${violation.taskId}/${violation.file}：${violation.reason}`)
  }
  for (const file of reconciliation.undeclared) {
    console.error(`✗ ${file}：磁盘上有但清单未声明 —— 无出处素材不得随题库分发`)
  }
  for (const file of reconciliation.missing) {
    console.error(`✗ ${file}：清单声明了但文件不存在`)
  }

  const failed = violations.length + reconciliation.undeclared.length + reconciliation.missing.length
  if (failed > 0) {
    console.error(`\n${failed} 项不合规。`)
    process.exit(1)
  }
  console.log(`✓ ${declaredAssetFiles(manifest).length} 件素材：授权取值合法、署名齐备、与磁盘逐一对得上。`)
}

if (require.main === module) main()
