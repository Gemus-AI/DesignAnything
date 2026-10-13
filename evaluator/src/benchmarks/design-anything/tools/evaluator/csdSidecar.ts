/**
 * CSD 侧车的进程桥（#3374）—— **I/O 层**，不做数学。
 *
 * 职责只有四件：找到解释器与权重、按文件字节 sha 缓存向量、**串行**调 Python 子进程、把任何失败翻成一个
 * 带理由的 `unavailable`。余弦与判定在 `setSimilarity.ts`（纯函数），拿这里返回的向量就能复算。
 *
 * 两个决定在代码里看不出理由：
 *
 * - **权重 sha 只在 Python 侧算**（流式）。TS 侧不 hash 那 2.4 GB —— `sha256File` 是整文件 `readFileSync`，
 *   每个 evaluate 进程各读一次 2.4 GB 只为重复 Python 已做的检查。TS 只查文件存不存在，好在不起子进程时
 *   就给出「缺权重，从哪下、怎么核」的理由。sha 本身只有一处写入点：`weights.lock.json`。
 * - **嵌入走输出文件，不走 stdout**。Node `execFile` 的 stdout 缓冲缺省 1 MiB，一条 768 维向量约 14 KB ——
 *   几十张图就超，而超了会被翻成 `unavailable`，看起来像「侧车不可用」。写文件也顺带杜绝 stdout 被
 *   torch / PIL 的 warning 污染。
 *
 * ## 隔离铁律
 *
 * 与 `setSimilarity.ts` / `identity.ts` 同款：运行时机制（#3177 runtime auditor）**禁止**复用本模块
 * 与这份权重 sha。守卫见 `__tests__/setSimilarity.test.ts`。
 *
 * @module benchmarks/design-anything/tools/evaluator/csdSidecar
 */

import { execFile as execFileCb } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { sha256File, writeCacheAtomically } from './cacheFs'
import { STYLE_RULE_VERSION, type StyleEmbedding, type StyleRuntime } from './setSimilarity'
import { resolvePython, runPython, serialized, type SidecarStatus } from './sidecarProcess'

const SIDECAR_DIR = path.resolve(process.cwd(), 'benchmarks', 'design-anything', 'tools', 'sidecar', 'csd')
const SIDECAR_SCRIPT = path.join(SIDECAR_DIR, 'csd_embed.py')
const LOCK_FILE = path.join(SIDECAR_DIR, 'weights.lock.json')
/** 权重缺省位置（仓库相对、`tmp/` 已 gitignore）。本机权重在别处时用 `BENCH_CSD_WEIGHTS` 指过去。 */
const DEFAULT_WEIGHTS = path.join('tmp', 'bench-weights', 'csd-vit-l', 'pytorch_model.bin')

/** `weights.lock.json` 里 TS 侧会读的字段。sha 与模型标识的唯一来源。 */
export interface WeightsLock {
  model: string
  sha256: string
  source: string
}

export function readWeightsLock(): WeightsLock {
  return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as WeightsLock
}

/** 侧车输出文件里 TS 会读的部分。`style` / `content` / `failures` 按输入下标键控。 */
interface SidecarOutput {
  weightsSha256: string
  runtime: StyleRuntime
  style: Record<string, number[]>
  content: Record<string, number[]>
  failures: Record<string, string>
}

/**
 * 嵌入结果。**可辨识联合**：`unavailable` 只在失败分支上存在，调用方不必对一个「按约定同步变化」的
 * 可空字段写防御性兜底。
 */
export type StyleEmbeddingResult =
  | {
    status: 'ok'
    /** 文件 → 风格向量。只含算出来的件，key 是**传入的原字符串** */
    style: Map<string, StyleEmbedding>
    /** 文件 → backbone 内容向量（校准对照用；评估器不持久化）。侧车没给就不放 */
    content: Map<string, StyleEmbedding>
    /** 文件 → 单张失败理由 */
    failures: Map<string, string>
    /** 产出这批向量的 provenance；空输入集时为 null */
    provenance: { weightsSha256: string; runtime: StyleRuntime } | null
  }
  | { status: 'unavailable'; unavailable: string }

export interface EmbedStyleOptions {
  /** 缓存目录；不传则不缓存 */
  cacheDir?: string | undefined
  /** 解释器；缺省 `BENCH_PYTHON` 或 `python`（Windows 上 `python3` 是商店空壳，故不取它） */
  python?: string | undefined
  /** 权重路径；缺省 `BENCH_CSD_WEIGHTS` 或仓库相对的 `tmp/bench-weights/...` */
  weights?: string | undefined
  /** 缺省 cpu。`cuda` 只给校准脚本用 */
  device?: 'cpu' | 'cuda' | undefined
  /** 测试注入点；缺省 `child_process.execFile` */
  execFile?: typeof execFileCb | undefined
}

function resolveWeights(explicit: string | undefined): string {
  return explicit ?? process.env.BENCH_CSD_WEIGHTS ?? DEFAULT_WEIGHTS
}

/**
 * 缓存 key：模型权重 sha + device + 规则版本 + 文件字节 sha。
 *
 * 用文件字节而不是文件名：同一件产物在两次导出里文件名可能带序号后缀（`out-2.png`），按名缓存会漏命中。
 * torch 版本与线程数**进不了 key** —— 跑之前不知道，由侧车报回；它们的一致性由 {@link embedStyle} 在
 * 拿到 provenance 之后统一核对。
 */
export function styleCacheKey(fileSha: string, weightsSha: string, device: string): string {
  return createHash('sha256').update(`${weightsSha}\n${device}\n${STYLE_RULE_VERSION}\n${fileSha}`).digest('hex')
}

interface CacheEntry {
  weightsSha256: string
  runtime: StyleRuntime
  ruleVersion: string
  style: number[]
  content?: number[]
}

function cacheFileFor(cacheDir: string, fileSha: string, weightsSha: string, device: string): string {
  return path.join(cacheDir, 'csd', `${styleCacheKey(fileSha, weightsSha, device)}.json`)
}

function readCache(cacheDir: string, file: string): CacheEntry | null {
  if (!fs.existsSync(file)) return null
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf-8')) as CacheEntry
    return entry.ruleVersion === STYLE_RULE_VERSION ? entry : null
  } catch {
    return null
  }
}

function sameRuntime(a: StyleRuntime, b: StyleRuntime): boolean {
  return a.python === b.python && a.torch === b.torch && a.torchvision === b.torchvision
    && a.device === b.device && a.threads === b.threads
}

/**
 * 给一批图算风格向量。任何整体失败 → `status: 'unavailable'` + 理由，**不抛**：一列诊断读数不能把
 * 整轮评估打死。
 *
 * `files` 是绝对路径或相对 cwd 的路径；返回的 Map 以传入的原字符串为 key。
 */
export async function embedStyle(files: readonly string[], options: EmbedStyleOptions = {}): Promise<StyleEmbeddingResult> {
  const device = options.device ?? 'cpu'
  const execFile = options.execFile ?? execFileCb
  const python = resolvePython(options.python)
  const weights = resolveWeights(options.weights)

  let lock: WeightsLock
  try {
    lock = readWeightsLock()
  } catch (error) {
    return { status: 'unavailable', unavailable: `cannot read ${LOCK_FILE}: ${(error as Error).message}` }
  }
  if (files.length > 0 && !fs.existsSync(weights)) {
    return {
      status: 'unavailable',
      unavailable: `weights not found at ${weights} — download ${lock.source} (sha256 ${lock.sha256}) and point BENCH_CSD_WEIGHTS at it`,
    }
  }

  const fileShas = new Map(files.map((file) => [file, sha256File(file)]))
  const entries = new Map<string, CacheEntry>()
  const failures = new Map<string, string>()

  /** 跑一次侧车，把结果写进 `entries` / `failures`（并落缓存）。整体失败回理由。 */
  const embed = async (batch: readonly string[]): Promise<string | null> => {
    if (batch.length === 0) return null
    const out = path.join(os.tmpdir(), `csd-embed-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    const status = await serialized(() => runPython(execFile, python, [SIDECAR_SCRIPT], JSON.stringify({
      weights: path.resolve(weights), expectSha256: lock.sha256, device, images: batch.map((file) => path.resolve(file)), out,
    })))
    if (!status.ok) {
      fs.rmSync(out, { force: true })
      return status.reason ?? 'sidecar failed'
    }
    let output: SidecarOutput
    try {
      output = JSON.parse(fs.readFileSync(out, 'utf-8')) as SidecarOutput
    } catch (error) {
      return `sidecar reported ok but its output file is unreadable: ${(error as Error).message}`
    } finally {
      fs.rmSync(out, { force: true })
    }
    batch.forEach((file, index) => {
      const key = String(index)
      const style = output.style[key]
      if (style === undefined) {
        failures.set(file, output.failures[key] ?? 'no embedding returned')
        return
      }
      const content = output.content[key]
      const entry: CacheEntry = {
        weightsSha256: output.weightsSha256,
        runtime: output.runtime,
        ruleVersion: STYLE_RULE_VERSION,
        style,
        // 长度为 0 的向量算不出余弦；宁可不存也不存一个会让下游抛错的空数组
        ...(content !== undefined && content.length > 0 ? { content } : {}),
      }
      entries.set(file, entry)
      failures.delete(file)
      if (options.cacheDir !== undefined) {
        writeCacheAtomically(cacheFileFor(options.cacheDir, fileShas.get(file) ?? '', lock.sha256, device), JSON.stringify(entry))
      }
    })
    return null
  }

  const missing: string[] = []
  for (const file of files) {
    const cached = options.cacheDir === undefined
      ? null
      : readCache(options.cacheDir, cacheFileFor(options.cacheDir, fileShas.get(file) ?? '', lock.sha256, device))
    if (cached === null) missing.push(file)
    else entries.set(file, cached)
  }

  const firstFailure = await embed(missing)
  if (firstFailure !== null) return { status: 'unavailable', unavailable: firstFailure }

  // 一批向量必须出自同一个 runtime，否则读数里的 provenance 是一句谎话。缓存 key 进不了 torch 版本与
  // 线程数（跑之前不知道），所以核对放在这里 —— 而且必须是**全量**核对：只在「这次恰好起了侧车」时才查，
  // 会让同一批输入的判定取决于「同一次调用里有没有别的文件恰好没命中缓存」。发现不一致就整批重算，
  // 一次多余的侧车调用换一个不依赖缓存状态的结论。
  const runtimes = [...entries.values()].map((entry) => entry.runtime)
  if (runtimes.length > 1 && !runtimes.every((runtime) => sameRuntime(runtime, runtimes[0]))) {
    entries.clear()
    failures.clear()
    const retryFailure = await embed(files)
    if (retryFailure !== null) return { status: 'unavailable', unavailable: retryFailure }
  }

  const style = new Map<string, StyleEmbedding>()
  const content = new Map<string, StyleEmbedding>()
  let provenance: { weightsSha256: string; runtime: StyleRuntime } | null = null
  for (const [file, entry] of entries) {
    style.set(file, entry.style)
    if (entry.content !== undefined) content.set(file, entry.content)
    provenance ??= { weightsSha256: entry.weightsSha256, runtime: entry.runtime }
  }
  return { status: 'ok', style, content, failures, provenance }
}

/** 侧车自检（黄金向量）。校准脚本开跑前调它。 */
export async function selfTest(options: Pick<EmbedStyleOptions, 'python' | 'weights' | 'device'> = {}): Promise<SidecarStatus> {
  return runPython(execFileCb, resolvePython(options.python), [
    SIDECAR_SCRIPT, '--self-test',
    '--weights', path.resolve(resolveWeights(options.weights)),
    '--device', options.device ?? 'cpu',
  ])
}
