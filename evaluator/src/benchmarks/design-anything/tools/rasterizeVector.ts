/**
 * 把**没有位图孪生**的矢量交付物栅格化成一张 PNG，让身份尺看得见它（#3406）。
 *
 * ## 为什么需要它
 *
 * 身份一致性尺只认位图 —— `evaluator/identity.ts` 的 `isIdentityJudgeable()` 判的是
 * `contentType.startsWith('image/')`。而导入器必须把 `.svg` 报成 `text/xml`
 * （见 `importExternalRun.ts` 的 `readabilityRank` 注释：按 `image/svg+xml` 报会让
 * 冻结评估器整轮退出）。两条都对，合在一起却产生了一个谁都没打算要的后果：
 * **矢量件交了、被完整记录了，身份尺却一对都判不上。**
 *
 * 于是外部两臂待遇不同：
 *
 * | 臂 | 矢量件 | 有没有位图孪生 | 进不进图对比较 |
 * |---|---|---|---|
 * | JarvisHub | `svg_artifacts/NN_*.svg` | 有，`pages/NN.png` | **进**（png 当正件，svg 降附件） |
 * | OpenDesign | `assets/massing-*.svg` | **没有** | **不进** |
 *
 * 实测代价：`opendesign--case-04--c1` 是那批里交得最完整的一次（6/6 槽、M1 通过），
 * 它的锚定件被选成 `assets__massing-d.svg`，整条身份规则直接 `not-applicable`，
 * **一对都没判**。而这道题的锚定槽恰好叫 `massing-family-board`（体量家族板）——
 * OpenDesign 的看家做法就是手写矢量而不生成图（见备忘录
 * `reference_opendesign_authors_vector_instead_of_generating`）。
 * 也就是说这个偏差**系统性地打在它最擅长的那件事上**。
 *
 * ## 这不是「替它做事」
 *
 * 与把 `*-deck.html` 渲染成逐页图（{@link ./renderDeckPages}）、把 `.pptx` 抽成文本
 * （{@link ./readDeckText}）是同一条原则：**必须按交付物本来的形态去读它**。
 * 一张 SVG 就是一张给人看的图，只是我们的评估器打不开这种容器。用浏览器把它画出来
 * 等于「看这张图」，不等于「替它画」。
 *
 * 栅格件仍然过同一个分类器、同一把身份尺 —— 画得不对照样判 `different`。
 * 这里改变的只有「尺子能不能看见它」。
 *
 * ## 只栅格化「没有位图孪生」的那些
 *
 * 已经有 `pages/NN.png` 的矢量页**不碰**：那一族由 `linkVectorPagesToBitmaps` 合并，
 * 位图早就是正件了。再造一张栅格件会凭空多出第三个载体，把件数口径搞乱。
 * 判据不是猜的 —— 就是「这一组里有没有一个 `image/*`」。
 *
 * ## 尺寸取自 SVG 自己声明的东西
 *
 * 宽高按 `width`/`height` 属性，缺了才退到 `viewBox` 的后两个数。两者都没有 →
 * **不栅格化，记盲区**。不给一个编出来的默认尺寸：那等于替对手决定它的画该多大。
 * 与导入器一贯的纪律一致（量得到才写，量不到记盲区，绝不造空壳）。
 *
 * @module benchmarks/design-anything/tools/rasterizeVector
 */

import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

/** 栅格化口径版本 —— 进 manifest，换了口径要能在读数里区分开。 */
export const VECTOR_RASTER_VERSION = 'svg-raster/v1'

/**
 * 视口长边上限。
 *
 * 只用来兜住「声明了一个荒谬尺寸」的 SVG，正常设计稿（实测 879×549 ~ 943×641）
 * 完全够用。元素截图仍按它自己的盒子出图，这个值只影响页面视口。
 */
export const RASTER_MAX_EDGE = 4096

/** 视口下限 —— 太小的视口会触发某些 SVG 里的响应式样式。 */
export const RASTER_MIN_EDGE = 320

/** Playwright 的 Browser/Page 只在运行期用到（`playwright-core` 是可选运行期依赖）。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyBrowser = any

export interface VectorRaster {
  /** 源 SVG 的相对路径 */
  source: string
  /** 栅格件的绝对路径 */
  file: string
  /** 实际出图的像素宽高 */
  width: number
  height: number
}

export interface VectorRasterFailure {
  source: string
  reason: string
}

/**
 * 读一份 SVG 自己声明的画布尺寸。
 *
 * 只看**根 `<svg>` 标签**的属性 —— 正文里 `stroke-width="1.2"` 这种也叫 width，
 * 全文正则会把它捞进来。两处来源都没有则返回 null（调用方据此记盲区）。
 */
export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const root = /<svg\b([^>]*)>/i.exec(svg)
  if (root === null) return null
  const attrs = root[1]
  const attr = (name: string): number | null => {
    const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
    if (m === null) return null
    // `width="879"` 与 `width="879px"` 都收；百分比不是绝对尺寸，按「没声明」处理。
    const value = Number.parseFloat(m[1])
    return Number.isFinite(value) && value > 0 && !m[1].includes('%') ? value : null
  }
  const width = attr('width')
  const height = attr('height')
  if (width !== null && height !== null) return { width, height }

  const box = /\bviewBox\s*=\s*"([^"]*)"/i.exec(attrs)
  if (box === null) return null
  const parts = box[1].trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return null
  const [, , boxWidth, boxHeight] = parts
  if (boxWidth <= 0 || boxHeight <= 0) return null
  return { width: boxWidth, height: boxHeight }
}

/** 视口尺寸：按 SVG 自己的声明，夹在上下限之间取整。 */
export function rasterViewport(size: { width: number; height: number }): { width: number; height: number } {
  const clamp = (n: number) => Math.max(RASTER_MIN_EDGE, Math.min(RASTER_MAX_EDGE, Math.round(n)))
  return { width: clamp(size.width), height: clamp(size.height) }
}

/**
 * 批量栅格化。**一次开一个浏览器**跑完整批 —— 每张开一个进程会让一次导入多花几十秒。
 *
 * 单张失败只记进 `failed`，不抛 —— 一张画不出来不该拖挂整次导入（同 #3389）。
 *
 * @param svgs   要栅格化的矢量件（调用方已筛掉有位图孪生的）
 * @param outDir 栅格件落盘目录
 * @param nameOf 由源相对路径给出栅格件的文件名
 */
export async function rasterizeSvgFiles(options: {
  svgs: readonly { relPath: string; absPath: string }[]
  outDir: string
  nameOf: (relPath: string) => string
  launch?: () => Promise<AnyBrowser>
}): Promise<{ rendered: VectorRaster[]; failed: VectorRasterFailure[] }> {
  const rendered: VectorRaster[] = []
  const failed: VectorRasterFailure[] = []
  if (options.svgs.length === 0) return { rendered, failed }

  const launch =
    options.launch ??
    (async () => {
      const { chromium } = (await import('playwright-core')) as { chromium: any }
      // channel: 'chrome' —— 用本机已装的 Chrome；playwright-core 不自带浏览器二进制。
      return chromium.launch({ channel: 'chrome', headless: true })
    })

  const browser = await launch()
  try {
    fs.mkdirSync(options.outDir, { recursive: true })
    for (const svg of options.svgs) {
      const size = svgIntrinsicSize(fs.readFileSync(svg.absPath, 'utf-8'))
      if (size === null) {
        failed.push({
          source: svg.relPath,
          reason: '这份 SVG 既没有 width/height 也没有可用的 viewBox —— 画多大只能靠猜，不栅格化',
        })
        continue
      }
      const page = await browser.newPage({ viewport: rasterViewport(size) })
      try {
        await page.goto(pathToFileURL(svg.absPath).href, { waitUntil: 'networkidle' })
        const box = await page.locator('svg').first().boundingBox().catch(() => null)
        if (box === null || box.width < 1 || box.height < 1) {
          // 与 deck 渲染那条同一纪律：画不出来是**这份产物自己**的事实，如实记，不猜。
          failed.push({
            source: svg.relPath,
            reason: `零面积（${box === null ? 'no box' : `${Math.round(box.width)}×${Math.round(box.height)}`}）—— 这张图在浏览器里也看不见`,
          })
          continue
        }
        const file = path.join(options.outDir, options.nameOf(svg.relPath))
        await page.locator('svg').first().screenshot({ path: file, timeout: 15_000 })
        rendered.push({
          source: svg.relPath,
          file,
          width: Math.round(box.width),
          height: Math.round(box.height),
        })
      } catch (error) {
        const [first] = String((error as Error).message).split(/\r?\n/)
        failed.push({ source: svg.relPath, reason: (first ?? '').slice(0, 120) })
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  return { rendered, failed }
}
