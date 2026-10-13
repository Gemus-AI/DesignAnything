/**
 * 一件产物属于哪一**层**：产物形态 × 产物成因（#3531）。
 *
 * ## 为什么需要分层
 *
 * 2026-09-08 实测：跨件色板一致性（ΔE00）的**汇总值**在三条臂之间给出的名次，与**任何一个
 * 可比子群**内的名次相反。汇总 Gemus 7.98（最差）/ OpenDesign 5.46（最好）；只比
 * 「整幅图 × 整幅图 × 两件都是模型生成」这一层时 Gemus 6.31（最好）/ OpenDesign 6.75。
 *
 * 名次翻转的原因在**配对构成**，不在判定。ΔE00 走的是全图颜色直方图：一页 deck 大半面积
 * 是模板底色，同一份 deck 的两页互相比读数天然趋零；整幅渲染图边到边都是设计内容，光照一变
 * 统计就变。三条臂在这两类配对上的占比差了一个数量级 —— 这是教科书式的辛普森悖论：
 * Gemus 在它参与的每一个子群里都最好，却因为完全没有「容易的那一群」而在汇总值上最差。
 *
 * 同一个陷阱在设计质量列上**方向相反**：模型生成件的均分 Gemus 90.6 / OpenDesign 93.8，
 * 而汇总值是 Gemus 93.5 / OpenDesign 86.5 —— 对方的汇总分被它自己 154 件 deck 页拖低。
 * **两个方向都要落地，不得只落地对本臂有利的那一半。**
 *
 * ## 判定是公平的，汇总不是
 *
 * 三条臂都判渲染出来的像素，这没有问题；问题是把性质不同的配对混进一个均值再跨臂排名。
 * 子群构成本身是三条产品的真实差异，消不掉。所以本模块**不改判定口径、不排除任何产物**，
 * 只给每件产物贴一个层标签，让报告能在层内比较。
 *
 * ## 两个维度都只用导出包已有的信息
 *
 * - **形态**：`deckPages.isDeckPageFile` —— 已有的 SSOT，三条臂同一条判据（#3532 起本臂
 *   的 deck 也出页，所以这一层在三条臂上都非空）。不新写一条 `page-\d+` 正则。
 * - **成因**：`provenance.tier` —— 导出/导入侧登记，评估器只读（#3444）。
 *
 * 不引入新概念是刻意的：分层若需要新的判据，它就会变成第三个可争论的口径。
 *
 * @module benchmarks/design-anything/tools/evaluator/stratum
 */
import type { DeliveryTier } from '../deliveryTier'
import type { ExportedFile } from '../exportRunArtifacts'
import { isDeckPageFile } from './deckPages'

/** 产物形态：渲染出来的文档页，还是独立的整幅件。 */
export type ArtifactForm = 'page' | 'standalone'

/**
 * 一件产物的层。
 *
 * `tier` 保留 `provenance.tier` 的原值（外加 `unknown`），不预先折成「生成 / 非生成」——
 * 折叠是报告那一层的事，落在 `evaluation.json` 里的应该是原始观测。
 */
export interface ArtifactStratum {
  form: ArtifactForm
  tier: DeliveryTier | 'unknown'
}

/**
 * 一对配对的层。两件同形/同因才落该档，一件是一件不是就是 `mixed`。
 *
 * `mixed` 是**一等档位**，不并进任何一边：一页 deck 与一张整幅图比出来的 ΔE 既不是
 * 「页之间」也不是「图之间」，把它塞进任一边都会污染那一层的读数。
 */
export interface PairStratum {
  form: ArtifactForm | 'mixed'
  /** `generated` = 两件都是模型生成；`other` = 两件都不是；`mixed` = 一件是一件不是 */
  tier: 'generated' | 'other' | 'mixed'
}

/** 一件产物的层。`provenance` 缺席 → `unknown`（缺席 ≠ generated，见 #3444）。 */
export function artifactStratum(file: Pick<ExportedFile, 'key' | 'provenance'>): ArtifactStratum {
  return {
    form: isDeckPageFile(file) ? 'page' : 'standalone',
    tier: file.provenance?.tier ?? 'unknown',
  }
}

/** `artifacts/` 下的文件名 → 它的层。判定侧按文件名索引产物，所以键取 `file` 而不是 `key`。 */
export function artifactStrata(files: readonly ExportedFile[]): Map<string, ArtifactStratum> {
  return new Map(files.map((file) => [file.file, artifactStratum(file)]))
}

/** 两件产物的层 → 这一对的层。 */
export function pairStratum(a: ArtifactStratum, b: ArtifactStratum): PairStratum {
  const bothGenerated = a.tier === 'generated' && b.tier === 'generated'
  const neitherGenerated = a.tier !== 'generated' && b.tier !== 'generated'
  return {
    form: a.form === b.form ? a.form : 'mixed',
    tier: bothGenerated ? 'generated' : neitherGenerated ? 'other' : 'mixed',
  }
}

/**
 * 层的稳定字符串标签，`form/tier` 形式。报表按它分组、CSV 按它落列。
 *
 * 单独一个函数而不是各处 `${form}/${tier}`：分组键与打印名必须是同一个东西，
 * 否则同一层在两处会读成两层。
 */
export function stratumLabel(stratum: ArtifactStratum | PairStratum): string {
  return `${stratum.form}/${stratum.tier}`
}
