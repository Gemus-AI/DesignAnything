/**
 * 把「幻灯片结构的 HTML 交付物」渲染成逐页位图，让所有臂按同一个标准被评。
 *
 * ## 为什么需要它
 *
 * 三条臂交出来的 deck 都是「可以一页页看的东西」，但载体不同：
 *
 * | 臂 | deck 载体 | 不渲染的话被判成 |
 * |---|---|---|
 * | JarvisHub | 自带 `pages/NN.png` 逐页渲染 | 图片 ✅ |
 * | 我们 | 结构化 deck 对象，导出时渲染（`renderGemusDeck.ts`，#3532） | 只剩文本 ❌ |
 * | OpenDesign | 手写 `*-deck.html`，**不自带渲染** | 只剩文本 ❌ |
 *
 * ⚠️ 上表「我们」那一行在 #3532 之前写的是「HTML 渲染成图 ✅」，那是**错的**：本臂的 deck
 * 从来没有以画面进过导出包。这个错误的自述让「三条臂的 PPT 判定不对等」这件事在文档层
 * 也看不出来。本臂走的是另一条链（结构化 deck 对象 → 产品自己的幻灯片渲染器），不走本模块。
 *
 * 也就是说，不渲染的话 OpenDesign 的 deck 是被「读源码」判的，另外两家是被「看页面」判的
 * —— 同一件东西两种标准。渲染不是给它加戏：那份 HTML 本来就是**拿浏览器打开来看**的成品
 * （自带 `.slide` 翻页），渲染等于「看」，不等于「替它做」。
 *
 * ## 必须从**源目录**渲染，不能从导出包渲染
 *
 * 导出包会把产物拍平进一个目录并改名（见 `flattenArtifactName`），HTML 里的相对图片引用
 * 因此全部失效。实测：从导出包渲染 → 封面的主视觉变成裂图占位；从源目录渲染 →
 * `requestfailed` 0 次、`naturalWidth===0` 的 `<img>` 0 个。
 * **渲染出来的东西没图，比不渲染更糟** —— 它会把「交了主视觉」读成「交了一张灰底图」。
 *
 * ## 逐页的取法：用 deck 自己的翻页机制，不要强行全部显示
 *
 * 第一版实现给所有 `.slide` 加了 `display:block !important`，16 页截出来 **16 张字节完全
 * 相同的图** —— 这些 deck 的 slide 是叠在同一处的，强行全显示只会把最上面那张截 16 遍。
 * 正确做法是逐页把 `active` 挪过去（deck 自己的 CSS 就是这么切页的），截完再挪下一页。
 *
 * 所以本模块**自带一条去重断言**：渲染结果若出现「页数 > 1 但所有页字节相同」，直接判渲染
 * 失败并抛出。这条断言就是上面那个 bug 的化石 —— 没有它，一次坏渲染会安静地变成 N 张
 * 一模一样的图喂进评估器。
 *
 * @module benchmarks/design-anything/tools/renderDeckPages
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

import { normalizeRasterRefs } from './deliveryTier'

/** 渲染器版本 —— 进 manifest，换了渲染口径要能在读数里区分开。 */
export const DECK_RENDER_VERSION = 'deck-html-raster/v1'

/** 判定「这是一份幻灯片」的候选选择器，按优先级。第一个命中 `>= MIN_SLIDES` 的胜出。 */
export const SLIDE_SELECTORS: readonly string[] = ['.slide', '[data-slide]', 'section.page']

/**
 * 少于这个页数不当 deck 处理。
 *
 * 取 3 的理由：实测 OpenDesign 语料里，真 deck 是 13–21 页，而非 deck 的
 * `index.html` / `configurator.html` / `manual.html` 的 `.slide` 命中数是 **0**，
 * 中间没有 1–2 页的模糊地带。定在 3 既排除了「碰巧有个 .slide 类名」的页面，
 * 也不会误伤真 deck。
 */
export const MIN_SLIDES = 3

/** 渲染视口 —— 与这些 deck 自己声明的 `width: 1920px` 对齐，避免触发响应式断点。 */
export const RENDER_VIEWPORT = { width: 1920, height: 1080 } as const

export interface RenderedDeck {
  /** 命中的选择器 */
  selector: string
  /** 逐页 png 的绝对路径，按页序 */
  pages: string[]
  /** 加载期失败的资源（渲染保真度的证据，进 manifest） */
  failedRequests: string[]
  /** 渲染后仍然裂掉的 `<img>` 的 src */
  brokenImages: string[]
  /** 截不出来的页（页号 → 原因）。整份 deck 都截不出来时，`pages` 为空。 */
  failedPages: { page: number; reason: string }[]
  /**
   * 逐页的位图引用（#3444 v2）：页文件绝对路径 → 这一页的 DOM 里引用到的位图。
   *
   * **必须逐页量，不能按整份文件量。** OpenDesign 的 deck 是一份 103 KB 的 HTML，
   * 16 页里只有 2 个 `<img>`；按整份文件判会把 14 页干净的手画页一起记成「内嵌了生成图」。
   *
   * 在浏览器里量而不是正则扫源码，是因为 CSS 背景图只有算完样式才知道 ——
   * 而 deck 恰恰爱用 `background-image` 铺主视觉。
   */
  rasterRefsByPage: Record<string, string[]>
}

/** Playwright 的 Page/Browser 只在运行期用到，这里不引入类型依赖（`playwright-core` 是可选运行期依赖）。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyPage = any
type AnyBrowser = any

/**
 * 在已打开的页面上找出幻灯片选择器。找不到返回 null（该 HTML 不是 deck，按原样走文本通道）。
 */
export async function detectSlideSelector(page: AnyPage): Promise<{ selector: string; count: number } | null> {
  for (const selector of SLIDE_SELECTORS) {
    const count: number = await page.evaluate((sel: string) => document.querySelectorAll(sel).length, selector)
    if (count >= MIN_SLIDES) return { selector, count }
  }
  return null
}

/** 取错误消息的第一行 —— Playwright 的报错正文很长，进 manifest 只留首行。 */
function firstLine(message: string): string {
  const [first] = message.split(/\r?\n/)
  return (first ?? message).slice(0, 120)
}

/**
 * 量「第 idx 页里引用到哪些图片」（#3444 v2）。
 *
 * 三种引用形式都要收：`<img src>`、SVG 的 `<image href>`、以及算完样式后的
 * `background-image`。最后一种是在浏览器里量的唯一理由 —— 正则扫源码看不见它。
 *
 * 返回的是**原始引用**，「什么算位图」由 `deliveryTier.normalizeRasterRefs` 一处判定。
 */
async function collectImageRefs(page: AnyPage, selector: string, idx: number): Promise<string[]> {
  return page.evaluate(
    ({ sel, i }: { sel: string; i: number }) => {
      const root = document.querySelectorAll(sel)[i]
      if (!root) return [] as string[]
      const refs: string[] = []
      root.querySelectorAll('img').forEach((img) => refs.push(img.getAttribute('src') ?? ''))
      root.querySelectorAll('image').forEach((img) =>
        refs.push(img.getAttribute('href') ?? img.getAttribute('xlink:href') ?? ''))
      for (const node of [root, ...root.querySelectorAll('*')]) {
        const background = window.getComputedStyle(node).backgroundImage
        if (!background || background === 'none') continue
        for (const match of background.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) refs.push(match[1] ?? '')
      }
      return refs
    },
    { sel: selector, i: idx },
  )
}

/**
 * 渲染结果的去重断言。见模块头「逐页的取法」。
 *
 * 多于一页却张张相同 = 翻页没生效，这不是「这份 deck 每页长得一样」，是渲染坏了。
 */
export function assertPagesDistinct(pageFiles: string[]): void {
  if (pageFiles.length <= 1) return
  const digests = new Set(
    pageFiles.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')),
  )
  if (digests.size === 1) {
    throw new Error(
      `deck 渲染失败：${pageFiles.length} 页截出来字节完全相同，说明翻页没生效（多半是所有 slide 叠在同一处）。` +
        `不要把这 ${pageFiles.length} 张一样的图当成 ${pageFiles.length} 页交付。`,
    )
  }
}

/**
 * 渲染一份 HTML deck 的每一页。
 *
 * @param htmlPath **源目录里**的 HTML 路径（不是导出包里的拍平副本，见模块头）
 * @param outDir   逐页 png 的落盘目录
 * @param stem     输出文件名前缀
 */
export async function renderDeckPages(options: {
  htmlPath: string
  outDir: string
  stem: string
  launch?: () => Promise<AnyBrowser>
}): Promise<RenderedDeck | null> {
  const launch =
    options.launch ??
    (async () => {
      const { chromium } = (await import('playwright-core')) as { chromium: any }
      // channel: 'chrome' —— 用本机已装的 Chrome；playwright-core 不自带浏览器二进制。
      return chromium.launch({ channel: 'chrome', headless: true })
    })

  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { ...RENDER_VIEWPORT } })
    const failedRequests: string[] = []
    page.on('requestfailed', (req: any) => failedRequests.push(String(req.url())))

    await page.goto(pathToFileURL(options.htmlPath).href, { waitUntil: 'networkidle' })

    const found = await detectSlideSelector(page)
    if (found === null) return null

    const brokenImages: string[] = await page.evaluate(() =>
      [...document.images]
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.getAttribute('src') ?? ''),
    )

    // deck 是否用 `.active` 单页切换 —— 用它自己的机制翻页，不强行全部显示。
    const usesActive: boolean = await page.evaluate(
      (sel: string) => document.querySelector(`${sel}.active`) !== null,
      found.selector,
    )

    fs.mkdirSync(options.outDir, { recursive: true })
    const pages: string[] = []
    const failedPages: { page: number; reason: string }[] = []
    const rasterRefsByPage: Record<string, string[]> = {}
    for (let i = 0; i < found.count; i += 1) {
      if (usesActive) {
        await page.evaluate(
          ({ sel, idx }: { sel: string; idx: number }) => {
            document.querySelectorAll(sel).forEach((el, j) => el.classList.toggle('active', j === idx))
            window.scrollTo(0, 0)
          },
          { sel: found.selector, idx: i },
        )
        await page.waitForTimeout(150)
      }

      // 先量一下这一页有没有面积。零高度的页截不出来，而且 Playwright 会在那里重试到超时 ——
      // 实测 OpenDesign case-34 的 deck 每一页都是 0 高（它用 `:where(.slide.active)` 提升
      // display，而 `:where()` 特异度为 0，压不过 `.slide { display:none }`），
      // 在浏览器里打开就是一张白纸。**这是那份产物自己的问题，不是渲染器的**，
      // 所以如实记成「这一页截不出来」，不要让它把整次导入拖挂。
      const box = await page.locator(found.selector).nth(i).boundingBox().catch(() => null)
      if (box === null || box.width < 1 || box.height < 1) {
        failedPages.push({
          page: i + 1,
          reason: `零面积（${box === null ? 'no box' : `${Math.round(box.width)}×${Math.round(box.height)}`}）—— 这一页在浏览器里也看不见`,
        })
        continue
      }

      const file = path.join(options.outDir, `${options.stem}__page-${String(i + 1).padStart(2, '0')}.png`)
      try {
        await page.locator(found.selector).nth(i).screenshot({ path: file, timeout: 15_000 })
        pages.push(file)
        rasterRefsByPage[file] = normalizeRasterRefs(await collectImageRefs(page, found.selector, i))
      } catch (error) {
        failedPages.push({ page: i + 1, reason: firstLine(String((error as Error).message)) })
      }
    }

    assertPagesDistinct(pages)
    return { selector: found.selector, pages, failedRequests, brokenImages, failedPages, rasterRefsByPage }
  } finally {
    await browser.close()
  }
}
