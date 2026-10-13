/**
 * 评估器磁盘缓存的两个文件系统原语 —— **零依赖**（自 `vlm.ts` 迁出，#3374）。
 *
 * 迁出的理由：`vlm.ts` 顶部 import 了 `dotenv/config`、`ai` 与 `@/lib/ai/llm`。CSD 侧车桥与
 * 「零模型、零联网」的校准脚本只需要这两个函数，从 `vlm.ts` 导出会把整条模型栈拖进离线路径。
 *
 * @module benchmarks/design-anything/tools/evaluator/cacheFs
 */

import { createHash, randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'

/**
 * 缓存落盘走「临时文件 + rename」（#3418）。`writeFileSync` 不是原子的：题间并发后另一路的
 * `readFileSync` + `JSON.parse` 可能读到半截文件。rename 在同一文件系统内原子，读侧因此只可能
 * 看到完整文件或不存在，无需加锁。缓存是内容寻址的，同 key 并发写内容相同：Windows 上目标
 * 正被另一路读着时 rename 会报 EPERM/EBUSY，此时对方已经写好了同一份内容，丢弃自己的即可。
 */
export function writeCacheAtomically(cacheFile: string, content: string): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
  const tmpFile = `${cacheFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmpFile, content, 'utf-8')
  try {
    fs.renameSync(tmpFile, cacheFile)
  } catch (error) {
    if (!fs.existsSync(cacheFile)) throw error
    fs.rmSync(tmpFile, { force: true })
  }
}

/** 整文件 sha256。缓存 key 用文件字节而不是文件名：同一件产物在两次导出里文件名可能带序号后缀。 */
export function sha256File(file: string): string {
  return sha256Buffer(fs.readFileSync(file))
}

/**
 * 缓存键取的是**实际发出去的字节**（#3488）。图像通道在发送前可能等比缩过
 * （见 `vlm.ts` 的 `normalizeEvaluatorImage`），那时文件字节不再等于请求字节 ——
 * 按文件字节做键会让两组不同的输入共用一条缓存。
 */
export function sha256Buffer(buffer: Uint8Array): string {
  return createHash('sha256').update(buffer).digest('hex')
}
