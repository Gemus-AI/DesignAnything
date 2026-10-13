/**
 * 有界并发、保序返回（#3418）。
 *
 * 第 i 个结果永远对应第 i 个输入，与并发度、完成顺序无关 —— 评估 CSV 的行序与 κ 校准的
 * 输入序因此在并发 1 与并发 N 下逐字节相同。派发形状与 `eval/scenario/batchDispatch.ts`
 * 同款（共享游标的 worker 池），不引入新依赖。
 *
 * 任一 `fn` 抛出即整体 reject（与 `Promise.all` 同语义）；要隔离单项失败，调用方在 `fn`
 * 里自己把错误折成返回值。
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`)
  }
  const results = new Array<R>(items.length)
  let next = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
