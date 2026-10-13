/**
 * PDF 页数读取 —— 服务 `slots[].minPages`（DesignAnything-Bench M1，指南 §2.2 / §3）。
 *
 * 读失败（加密、损坏、非 PDF、超时）返回 `undefined`，交给 `evaluate.ts` 按 #3126 处理：
 * 页数不可知 = 不满足任何页数下限（如实的"证明不了"）。这里不猜数。
 * 用 `unpdf`（仓库既有依赖，纯 Node、无 DOM 要求）。
 *
 * 两条防护，都是实测逼出来的：
 * - unpdf 内置的 pdf.js 依赖 `Promise.try`，Node 22 没有它 —— 缺失时不是抛错而是**未处理拒绝 + 挂起**，
 *   try/catch 接不到，整批评估会停在这一件上。故加载前补一个最小 polyfill。
 * - 再加硬超时：解析卡住时放弃这一件（返回 undefined），不让一份怪 PDF 拖死整批。
 *
 * @module benchmarks/design-anything/tools/evaluator/pdfPages
 */

import fs from 'fs'

const PARSE_TIMEOUT_MS = 15_000

type PromiseTry = (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>

function ensurePromiseTry(): void {
  const p = Promise as unknown as { try?: PromiseTry }
  if (typeof p.try === 'function') return
  // 最小语义：同步抛错 → reject；返回值（含 thenable）→ resolve 展开。只给 pdf.js 内部用
  p.try = (fn, ...args) => new Promise((resolve, reject) => {
    try { resolve(fn(...args)) } catch (error) { reject(error) }
  })
}

export async function readPdfPageCount(filePath: string): Promise<number | undefined> {
  try {
    ensurePromiseTry()
    const { getDocumentProxy } = await import('unpdf')
    const bytes = new Uint8Array(fs.readFileSync(filePath))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), PARSE_TIMEOUT_MS) })
    const parsed = getDocumentProxy(bytes).then((pdf) => pdf.numPages, () => undefined)
    const result = await Promise.race([parsed, timeout])
    if (timer !== undefined) clearTimeout(timer)
    return result
  } catch {
    return undefined
  }
}
