/**
 * Python 侧车的**进程层** —— 起子进程、读回那一行状态 JSON、把并发压成串行。
 *
 * 自 `csdSidecar.ts` 迁出（#3469）。迁出的理由是第二个侧车（`dinoSidecar.ts`，主体检测）要用同一套东西：
 * 同样的 stdin JSON / stdout 一行状态协议、同样的 `PYTHONUTF8=1`、同样的 `execFile` 回调形态、
 * 同样「一次只许有一个侧车进程」的队列。复制一遍等于让两处各自漂移。
 *
 * 这一层**只管进程**：不知道权重是什么、不做缓存、不解释输出文件。那些留在各自的桥里。
 *
 * ## 队列是跨侧车共享的，这是刻意的
 *
 * 队列在模块级，两个桥 import 的是同一个。一个侧车 = 一份大权重 + 一整个 torch 运行时
 * （CSD 2.4 GB、Grounding DINO 0.7 GB），`evaluate --concurrency 4` 会同时评 4 道题。
 * 让 CSD 与 DINO 并行只会让两个都变慢，还可能把内存撑爆。
 *
 * ## 隔离铁律
 *
 * 与 `setSimilarity.ts` / `identity.ts` 同款：运行时机制（#3177 runtime auditor）**禁止**复用本模块。
 * 守卫见 `__tests__/setSimilarity.test.ts`。
 *
 * @module benchmarks/design-anything/tools/evaluator/sidecarProcess
 */

import { execFile as execFileCb } from 'child_process'

/** 侧车 stdout 那一行状态 JSON。`ok` 之外的字段各侧车自己加。 */
export interface SidecarStatus {
  ok: boolean
  reason?: string
  /** 自检模式才有 */
  worstMaxAbsDelta?: number
  /** 自检模式才有：黄金框与人工标注真值的最小 IoU */
  worstIou?: number
}

/**
 * 解释器。缺省 `BENCH_PYTHON` 或 `python`。
 *
 * **不取 `python3`**：Windows 上那是应用商店空壳（退出码 49、无输出），而语料与开发都在 Windows。
 */
export function resolvePython(explicit: string | undefined): string {
  return explicit ?? process.env.BENCH_PYTHON ?? 'python'
}

/**
 * 取 stdout 的最后一行状态 JSON —— torch / PIL / transformers 的 warning 不会因此打断协议。
 *
 * 不是状态行（不以 `{` 开头、解析失败、没有布尔 `ok`）→ null，由调用方翻成理由。
 */
export function parseStatus(stdout: string): SidecarStatus | null {
  const line = stdout.trim().split(/\r?\n/).pop() ?? ''
  if (!line.startsWith('{')) return null
  try {
    const parsed = JSON.parse(line) as SidecarStatus
    return typeof parsed.ok === 'boolean' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 起子进程并等它结束，回 stdout 里那一行状态 JSON。**不抛** —— 任何失败都翻成 `{ok:false, reason}`。
 *
 * 不走 `util.promisify(execFile)`：那条路只有真 `execFile` 带 `promisify.custom` 时才暴露 `.child`，
 * 而测试注入的假 execFile 拿不到 stdin。所以直接用回调形式，child 是返回值。
 *
 * `PYTHONUTF8=1`：Windows 上 Python 的管道 stdin/stdout 缺省是 GBK，而语料里有上千条非 ASCII 路径。
 */
export function runPython(
  execFile: typeof execFileCb,
  python: string,
  args: string[],
  stdin?: string,
): Promise<SidecarStatus> {
  return new Promise((resolve) => {
    const child = execFile(python, args, {
      env: { ...process.env, PYTHONUTF8: '1' },
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      // 非零退出时侧车仍会在 stdout 留一行 `{ok:false, reason}`；解析得到就用它
      const parsed = parseStatus(String(stdout))
      if (parsed !== null) return resolve(parsed)
      if (error === null) return resolve({ ok: false, reason: `sidecar stdout is not a status JSON line: ${String(stdout).slice(0, 200)}` })
      const failed = error as Error & { code?: number | string }
      resolve({
        ok: false,
        reason: failed.code === 'ENOENT'
          ? `interpreter not found: ${python} (set BENCH_PYTHON; on Windows use \`python\`, not the Store stub \`python3\`)`
          : `${failed.message}${stderr ? ` — stderr: ${String(stderr).slice(-400)}` : ''}`,
      })
    })
    if (stdin !== undefined) child.stdin?.end(stdin, 'utf-8')
  })
}

// 模块级串行队列：任一时刻至多一个侧车子进程，**跨侧车共享**（见模块头）。
let sidecarQueue: Promise<unknown> = Promise.resolve()

/** 把一件异步工作排进侧车队列。队列尾永不 reject（下面接了 catch），故只需 fulfilled 分支。 */
export function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = sidecarQueue.then(task)
  sidecarQueue = next.catch(() => undefined)
  return next
}
