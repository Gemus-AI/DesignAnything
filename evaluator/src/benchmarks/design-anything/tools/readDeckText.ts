/**
 * 把外部臂的 deck 读成「逐页文本 + 页数」，让它交的真 PPT 不再被记成没交（#3397）。
 *
 * ## 为什么需要它
 *
 * 冻结评估器只认三种非文本载体：`image/*`、`video/*`、`application/pdf`
 * （`evaluator/scoring.ts` 的 `mediaKindOf()`）。`.pptx` 落到 `null`，
 * 直接判 `unassigned`。而带 `minPages` 的文档槽还要求 `ExportedFile.pages`。
 *
 * 于是 `bench-arch-04` 的 `institution-deck` 槽出现了这个局面：
 *
 * | 臂 | 实际交付 | 判定 |
 * |---|---|---|
 * | 我们 | `*_deck.md`，`pages = 12` | ✅ |
 * | OpenDesign | `*-deck.html`，**真 16 页** | ❌ 未覆盖 |
 * | JarvisHub | `*.pptx` + 逐页矢量稿，**真 10 页** | ❌ 未覆盖 |
 *
 * **两边都交了 deck，只有一边被看见。** 槽位覆盖率是完成度主指标，
 * 所以这个缺口让每一个跨臂完成度读数都系统性偏向我们。
 *
 * ## 这不是「替它做事」
 *
 * 跟把 OpenDesign 的 `*-deck.html` 用浏览器渲染成图（见 {@link ./renderDeckPages}）
 * 是同一条原则：**必须按交付物本来的形态去读它**。`.pptx` 是一份带文字的文档，
 * 只是我们的评估器打不开 zip。抽出正文等于「打开这个文件」，不等于「替它写内容」。
 *
 * 抽出来的文本仍然过同一个分类器 —— 内容空洞的 deck 照样判不进槽。这里改变的只有
 * 「评估器能不能读到它」，不是「它够不够好」。
 *
 * ## 正文优先取逐页矢量稿，`.pptx` 只是退路
 *
 * 第一版只读 pptx，读出 JarvisHub 的 deck「每页一个字都没有」，据此记了盲区 ——
 * **那个结论是错的**。JarvisHub 服务端的 PPT 导出被两个环境缺口卡死，
 * 那份 pptx 是 `~/Desktop/JarvisHub/bench/export_pptx.py` 在**导出侧重新组装**的，
 * 形式刻意是「每页一张满幅视觉 + 文字进演讲者备注」。slide 本体没有 `<a:t>`
 * 是我们自己造成的，不是对手的交付特征。
 *
 * 它真正的页面文字在 `svg_artifacts/NN_*.svg` 的 `<text>` 里 —— 那是对手画布上的真页面。
 * 所以顺序固定为：① 逐页 SVG ② 同目录 pptx（且要读 `notesSlides`，正文可能全在备注里）。
 *
 * ## 页数取自容器自己的结构
 *
 * 页数 = 矢量页个数，或 `ppt/slides/slideN.xml` 的个数。后者是 OOXML 规范定义的容器结构，
 * 不是在对手的标记语言上编的启发式 —— 那正是导入器一直拒绝做的事。
 * 母版（`slideMasters/`）、布局（`slideLayouts/`）、备注（`notesSlides/`）都不是页。
 *
 * @module benchmarks/design-anything/tools/readDeckText
 */

import fs from 'fs'

import JSZip from 'jszip'

/** 抽取口径版本 —— 进 manifest，换了口径要能在读数里区分开。 */
export const DECK_TEXT_VERSION = 'deck-text/v2'

/** pptx 里只有这个形状算一页。见模块头「页数取自容器自己的结构」。 */
const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/

/** 演讲者备注 —— 与幻灯片同号。见模块头「正文可能全在备注里」。 */
const NOTES_PATH = (index: number) => `ppt/notesSlides/notesSlide${index}.xml`

/** 一份 deck 的可判文本形态 —— 逐页矢量稿与 pptx 归一到同一个结构。 */
export interface DeckText {
  /** 页数 */
  pages: number
  /** 逐页正文，按页序 */
  slides: string[]
}

/**
 * 从 zip 条目名里挑出幻灯片并**按数字**排序。
 *
 * 字典序会把 `slide10` 排在 `slide2` 前面 —— 10 页以上的 deck 必踩。
 */
export function slideOrder(names: readonly string[]): string[] {
  return names
    .map((name) => ({ name, index: Number(SLIDE_PATH.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.name)
}

/** `&amp;` 放最后解，否则 `&amp;lt;` 会被连解两次。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

/**
 * 取一页的正文：`<a:p>` 是段落，`<a:t>` 是段落里的文字 run。
 *
 * 只读 `<a:t>` 是刻意的 —— 标签属性、字段占位（`<a:fld>`）、备注都不是这一页的正文，
 * 把它们捞进来会让分类器读到 deck 里根本看不见的字。
 */
export function extractSlideText(xml: string): string {
  const paragraphs: string[] = []
  for (const match of xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
    const runs = [...match[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((run) => run[1])
    const line = decodeEntities(runs.join('')).trim()
    if (line !== '') paragraphs.push(line)
  }
  return paragraphs.join('\n')
}

/**
 * 逐页文本拼成一份可读文档。
 *
 * 页标记用 `## N.` —— 与我们自己导出的 `deck.md` **同一种形状**。
 * 这不是模仿，正是本次修复的目的：让两条臂的 deck 以同一种形态到达分类器，
 * 差异只剩内容本身。
 */
export function renderDeckText(deck: DeckText): string {
  return deck.slides
    .map((text, i) => (text === '' ? `## ${i + 1}.` : `## ${i + 1}.\n\n${text}`))
    .join('\n\n')
}

/** 读一份 pptx 的字节。不是 zip、或 zip 里没有幻灯片，一律返回 null（不抛）。 */
export async function readPptxDeckFromBuffer(buffer: Buffer): Promise<DeckText | null> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    // 一整批导入不能被一个坏文件掐死 —— 读不了就当它不是 deck，原样按 pptx 载体记。
    return null
  }
  const slides = slideOrder(Object.keys(zip.files))
  if (slides.length === 0) return null
  const texts: string[] = []
  for (const [i, name] of slides.entries()) {
    const xml = await zip.files[name].async('string')
    let text = extractSlideText(xml)
    // 满幅图 + 文字进备注的组装方式下，slide 本体一个 `<a:t>` 都没有，正文全在
    // notesSlide 里。不读备注就会把这种 deck 误判成「一个字都没有」。
    if (text === '') {
      const notes = zip.files[NOTES_PATH(Number(SLIDE_PATH.exec(name)?.[1] ?? i + 1))]
      if (notes !== undefined) text = extractSlideText(await notes.async('string'))
    }
    texts.push(text)
  }
  return { pages: texts.length, slides: texts }
}

/**
 * 取一页矢量稿的正文：SVG 里 `<text>`（含其中的 `<tspan>`）就是页面上看得见的字。
 *
 * 一个 `<text>` 算一行；它内部的 `<tspan>` 是同一行的分段，拼回去而不是断开。
 */
export function extractSvgText(svg: string): string {
  const lines: string[] = []
  for (const match of svg.matchAll(/<text(?:\s[^>]*)?>([\s\S]*?)<\/text>/g)) {
    const line = decodeEntities(match[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (line !== '') lines.push(line)
  }
  return lines.join('\n')
}

/**
 * 逐页 SVG（按页序）拼成一份多页文档。
 *
 * 一个字都抽不出来时返回 null —— 与 pptx 那条同一纪律：**不造空壳**。
 */
export function readSvgDeck(svgs: readonly string[]): DeckText | null {
  if (svgs.length === 0) return null
  const slides = svgs.map(extractSvgText)
  if (!slides.some((text) => text !== '')) return null
  return { pages: slides.length, slides }
}

/** {@link readPptxDeckFromBuffer} 的文件版。 */
export async function readPptxDeck(absPath: string): Promise<DeckText | null> {
  return readPptxDeckFromBuffer(fs.readFileSync(absPath))
}
