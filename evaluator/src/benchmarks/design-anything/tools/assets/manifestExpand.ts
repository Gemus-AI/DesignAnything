/**
 * DesignAnything-Bench 素材清单的共享读取与展开 —— 生成脚本与登记脚本共用，展开规则只此一处。
 *
 * - `{k}` 按物体编号 1..count 展开（同一物体多角度时与 `conditionOn` 里的 `{k}` 同步替换）
 * - `{i}` 按张数从 `indexFrom`（缺省 1）起展开
 *
 * @module benchmarks/design-anything/tools/assets/manifestExpand
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { assertCorpusNotFrozen } from '../corpusFreeze'
import {
  assertWritableBenchmarkVersion,
  DESIGN_ANYTHING_BENCH_VERSION_ENV,
  designAnythingCorpusPaths,
  LEGACY_DESIGN_ANYTHING_ASSETS_REL,
  parseDesignAnythingBenchVersion,
  type DesignAnythingBenchVersion,
} from '../../../../src/lib/agent/eval/corpusPaths'

import type { IdentityConsistencyRule } from '../evaluator/taskSpec'
import type { AssetLicense } from './provenance'
import { assertEvalAssetBytes, evalAssetMimeForPath, isWaveBytes } from '../../../../src/lib/agent/eval/evalAssetContract'

/** 身份判定的主体类型，与 `evaluator/taskSpec.ts` 的 `IDENTITY_SUBJECTS` 同源。 */
export type IdentitySubject = IdentityConsistencyRule['subject']

export const MODEL = 'gpt-image-2'
export const BENCH_VERSION = parseDesignAnythingBenchVersion(process.env[DESIGN_ANYTHING_BENCH_VERSION_ENV])
const corpus = designAnythingCorpusPaths(BENCH_VERSION)
export const MANIFEST_PATH = path.join(process.cwd(), corpus.manifest)
/** 素材文件根：与 scenarioSchema / materializeReferenceAssets 的 eval 资产根一致（SSRF 安全边界） */
export const BENCH_ASSETS_ROOT = path.join(process.cwd(), corpus.assets)
export const BENCH_SCENARIOS_ROOT = path.join(process.cwd(), corpus.scenarios)
/** 写进 scenario.referenceAssets 的仓库相对路径前缀 */
export const BENCH_ASSETS_REL = BENCH_VERSION === 'v0.1' ? LEGACY_DESIGN_ANYTHING_ASSETS_REL : corpus.assets

/** 写入入口共用冻结门，默认环境下不会改掉已出分的 v0.1。 */
export function assertMutableCorpus(): void {
  assertWritableBenchmarkVersion(BENCH_VERSION)
  assertCorpusNotFrozen(path.join(process.cwd(), corpus.root))
}

export interface ManifestAsset {
  file: string
  kind: 'image' | 'document' | 'audio'
  /** 这件素材从哪来。外部图源必须填可核对的 URL 或馆藏号（见 `provenance.ts` 的判据）。 */
  source: string
  /**
   * 分发授权（#3428）。题库随论文公开分发，所以**授权是第一约束**，取值是封闭词表 ——
   * 见 `provenance.ts` 的 `ASSET_LICENSES` 与指南「素材来源政策」。
   */
  license: AssetLicense
  /** 署名。`CC-BY` 必填（署名义务随分发走），其余授权按需。 */
  credit?: string
  /** public-domain 必填：原作公版判断与实际数字版本使用依据，须由作者核验。 */
  rightsBasis?: string
  count?: number
  indexFrom?: number
  prompt?: string
  conditionOn?: string
  /**
   * `conditionOn` 到底在主张什么（#3428）。**有 `conditionOn` 就必须填** ——
   * 同一个字段此前混着两种完全不同的主张，而它们的可核对性是相反的：
   *
   * - `same-object`：这两张画的是**同一个**物件/同一处空间（换角度、换视图）。
   *   身份判定器可以核实它，`checkSetConsistency.ts` 会逐对去核。
   * - `same-family`：只主张**同一条血脉**（同品牌、同系列、同风格、同一款釉、同一场活动），
   *   物件本身刻意不同（电商题四个瓶子只换颜色、时装题同一模特换套装）。
   *   拿身份判定器去核它必然判「不同」——**那是判据用错了，不是素材坏了**。
   *
   * 缺省不设默认值是刻意的：默认成 family 会让"忘了想这件事"变成静默不检查，
   * 默认成 same-object 会造出一批必然的假警报。两种默认都比报红差。
   */
  setAssertion?: 'same-object' | 'same-family'
  /**
   * 成套性自检时问「这两张是不是同一个**什么**」。取值是身份判定器的主体词表
   * （`evaluator/taskSpec.ts` 的 `IDENTITY_SUBJECTS`，两处同源）。
   * `setAssertion: 'same-object'` 时**必填** —— 主体缺省会让判定 prompt 拼出
   * "is the the depicted object ... THE SAME the depicted object" 这种坏句子；
   * 2026-09-06 实测：logo 那一对因此直接判成 `unjudgeable`。
   */
  setSubject?: IdentitySubject
  /** 可选画幅，缺省 1:1（apimart `size` 接受比例字串） */
  aspect?: string
  note?: string
}
export interface ManifestTask {
  taskId: string
  assets: ManifestAsset[]
  /** 作者侧记录以题目资产目录为根；被测系统只接收 assets 中的附件。 */
  authoring?: { record: string; sha256: string }
}
export interface Manifest { version: number; tasks: ManifestTask[] }

/** 展开后的一件素材（图、文档或原始音频）。 */
export interface ExpandedAsset {
  taskId: string
  file: string
  kind: ManifestAsset['kind']
  source: string
  /** 生成图才有 */
  prompt?: string
  conditionOn?: string
  /** 见 {@link ManifestAsset.setAssertion} —— 随 `conditionOn` 一起展开 */
  setAssertion?: 'same-object' | 'same-family'
  /** 见 {@link ManifestAsset.setSubject} */
  setSubject?: IdentitySubject
  aspect: string
  note?: string
}

/**
 * 读某个版本的素材清单，缺省是进程启动时选定的那个版本。
 *
 * 显式传版本是给**跨版本核对**用的：出处与授权是逐个题包各自成立的契约，
 * 而进程级的 `BENCH_VERSION` 一次只能指一个。守卫若只跑默认版本，
 * 当前候选题包就没有任何检查（2026-09-09 之前 v0.4 / v0.5 正是这个状态）。
 */
export function readManifest(version: DesignAnythingBenchVersion = BENCH_VERSION): Manifest {
  return JSON.parse(readFileSync(path.join(process.cwd(), designAnythingCorpusPaths(version).manifest), 'utf-8')) as Manifest
}

export function expandAsset(taskId: string, asset: ManifestAsset): ExpandedAsset[] {
  const count = asset.count ?? 1
  const aspect = asset.aspect ?? '1:1'
  const base = { taskId, kind: asset.kind, source: asset.source, aspect, ...(asset.note ? { note: asset.note } : {}), ...(asset.setAssertion ? { setAssertion: asset.setAssertion } : {}), ...(asset.setSubject ? { setSubject: asset.setSubject } : {}) }
  const sub = (s: string, n: number, key: '{k}' | '{i}') => s.split(key).join(String(n))
  const one = (n: number, key: '{k}' | '{i}'): ExpandedAsset => ({
    ...base,
    file: sub(asset.file, n, key),
    ...(asset.prompt ? { prompt: sub(asset.prompt, n, key) } : {}),
    ...(asset.conditionOn ? { conditionOn: sub(asset.conditionOn, n, key) } : {}),
  })
  if (asset.file.includes('{k}')) return Array.from({ length: count }, (_, idx) => one(idx + 1, '{k}'))
  if (asset.file.includes('{i}')) {
    const from = asset.indexFrom ?? 1
    return Array.from({ length: count }, (_, idx) => one(from + idx, '{i}'))
  }
  return [{ ...base, file: asset.file, ...(asset.prompt ? { prompt: asset.prompt } : {}), ...(asset.conditionOn ? { conditionOn: asset.conditionOn } : {}) }]
}

/** 只要生成图的那一部分（生成脚本用）。 */
export function isGeneratedImage(asset: ExpandedAsset): asset is ExpandedAsset & { prompt: string } {
  return asset.kind === 'image' && asset.source === `${MODEL}@apimart` && typeof asset.prompt === 'string'
}

/**
 * 手写文档进 scenario 前的换行归一化（#3497）—— **纯函数**。
 *
 * 这段文本会原样成为发给被测系统的题面的一部分，而 M2 有逐字核对的判据，
 * 换行属于逐字内容。文档文件在 Windows 工作区里是 CRLF（autocrlf 的正常结果），
 * 直接塞进 scenario 就把平台差异固化进题面：同一份素材、同一条命令，Windows 与 Linux
 * 产出不同的 JSON，谁最后跑过登记就按谁的换行。而跨臂读数的前提是三家系统拿到
 * **逐字一致**的输入。
 *
 * 挡在脚本边界而不是靠 .gitattributes 管工作区：工作区本就该按平台呈现。
 */
export function normalizeDocumentNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export const mimeForFile = evalAssetMimeForPath

/** 文档仍作为原文本绑定；WAV 无论改扩展名还是改 kind，都不能走文本或图像通路。 */
export function assertManifestAssetBytes(asset: Pick<ManifestAsset, 'file' | 'kind'>, bytes: Uint8Array): void {
  if (asset.kind === 'document') {
    if (path.extname(asset.file).toLowerCase() === '.wav' || isWaveBytes(bytes)) throw new Error(`WAV must be declared as audio: ${asset.file}`)
    return
  }
  const mimeType = mimeForFile(asset.file)
  if ((asset.kind === 'audio' && mimeType !== 'audio/wav') || (asset.kind === 'image' && !mimeType.startsWith('image/'))) {
    throw new Error(`Manifest kind/MIME mismatch: ${asset.file}`)
  }
  assertEvalAssetBytes(bytes, mimeType, asset.file)
}
