/** 公开要求的检查契约；只声明可执行证据，不从作者 notes 推导隐藏标准。 */
export type RequirementMethod = 'delivery' | 'final-selection' | 'artifact-property' | 'visual' | 'content' | 'text' | 'deck-reuse' | 'manual' | 'diagnostic'

export interface RequirementProperty {
  name: 'width' | 'height' | 'aspectRatio' | 'format' | 'contentType' | 'colorSpace' | 'hasAlpha' | 'durationSeconds' | 'pageCount' | 'pageWidthPt' | 'pageHeightPt' | 'pageShortSidePt' | 'pageLongSidePt' | 'filename'
  op: 'eq' | 'min' | 'max' | 'one-of' | 'matches'
  value: string | number | boolean | string[]
  tolerance?: number
  aggregate?: 'sum'
}

export interface RequirementCheck {
  id: string
  requirementId: string
  method: RequirementMethod
  criteria: string
  targetSlots: string[] | '*'
  sourceSlots?: string[]
  inputFiles?: string[]
  visualScope?: 'per-artifact' | 'per-page' | 'set'
  properties?: RequirementProperty[]
  manualReason?: string
  sourceCoverage?: 'all' | 'at-least-one' | 'each-slot'
  /**
   * 「每一张**设计页**都必须来自本判据声明的来源集合」这条义务开不开（#3525）。
   *
   * 它与 {@link sourceCoverage} 是**两条不同的公开义务**，此前混在一起：
   * `sourceCoverage` 管的是整册看下来有没有覆盖到来源，这一条管的是单页能不能出现
   * 来源集合以外的设计。题面只写「汇报里每个指定类别至少复用一件已交作品」时，
   * 另有一张合法的设计页不属于本判据的来源集合并不违规，而旧实现会判它 fail。
   *
   * 缺省 `'required'` = 历史行为，逐字不变 —— 已出分的版本照旧可复算。
   * 只有题面确实不要求逐页归属时，作者才显式写 `'whole-deck-only'`。
   */
  pageSourceReuse?: 'required' | 'whole-deck-only'
  firstPageOnlySlots?: string[]
}

const METHODS = new Set<RequirementMethod>(['delivery', 'final-selection', 'artifact-property', 'visual', 'content', 'text', 'deck-reuse', 'manual', 'diagnostic'])
const NAMES = new Set<RequirementProperty['name']>(['width', 'height', 'aspectRatio', 'format', 'contentType', 'colorSpace', 'hasAlpha', 'durationSeconds', 'pageCount', 'pageWidthPt', 'pageHeightPt', 'pageShortSidePt', 'pageLongSidePt', 'filename'])
const NUMERIC = new Set<RequirementProperty['name']>(['width', 'height', 'aspectRatio', 'durationSeconds', 'pageCount', 'pageWidthPt', 'pageHeightPt', 'pageShortSidePt', 'pageLongSidePt'])
const fail = (message: string): never => { throw new Error(`requirementChecks: ${message}`) }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim().length > 0) && new Set(value).size === value.length

/** 加载期拒绝失效范围和不能执行的属性，不让类型断言把错误 JSON 变成绿灯。 */
export function validateRequirementChecks(raw: unknown, slots: ReadonlyArray<{ id: string }>): RequirementCheck[] {
  if (!Array.isArray(raw) || raw.length === 0) return fail('must be a nonempty array')
  const ids = new Set<string>()
  const slotIds = new Set(slots.map((slot) => slot.id))
  for (const item of raw) {
    if (!object(item)) return fail('entry must be an object')
    for (const key of ['id', 'requirementId', 'criteria'] as const) {
      if (typeof item[key] !== 'string' || !item[key].trim()) return fail(`${key} must be nonempty`)
    }
    if (ids.has(item.id as string)) return fail(`duplicate id ${item.id}`)
    ids.add(item.id as string)
    if (!METHODS.has(item.method as RequirementMethod)) return fail(`unknown method ${item.method}`)
    if (item.targetSlots !== '*' && (!strings(item.targetSlots) || item.targetSlots.some((id) => !slotIds.has(id)))) return fail(`${item.id}: invalid targetSlots`)
    if (item.sourceSlots !== undefined && (!strings(item.sourceSlots) || item.sourceSlots.some((id) => !slotIds.has(id)))) return fail(`${item.id}: invalid sourceSlots`)
    if (item.inputFiles !== undefined && (!strings(item.inputFiles) || item.inputFiles.some((file) => file.includes('..') || file.startsWith('/') || /^[A-Za-z]:/.test(file)))) return fail(`${item.id}: invalid inputFiles`)
    if (item.method === 'visual' && item.visualScope !== 'per-artifact' && item.visualScope !== 'per-page' && item.visualScope !== 'set') return fail(`${item.id}: visualScope required`)
    if (item.method === 'content' && item.visualScope !== undefined && item.visualScope !== 'per-artifact' && item.visualScope !== 'set') return fail(`${item.id}: content scope must be per-artifact or set`)
    if (item.method === 'deck-reuse' && !strings(item.sourceSlots)) return fail(`${item.id}: deck-reuse needs sourceSlots`)
    if (item.method === 'deck-reuse' && (item.targetSlots === '*' || (item.sourceSlots as string[]).some((id) => (item.targetSlots as string[]).includes(id)))) return fail(`${item.id}: deck sources and targets must be disjoint`)
    if (item.sourceCoverage !== undefined && (item.method !== 'deck-reuse' || !['all', 'at-least-one', 'each-slot'].includes(item.sourceCoverage as string))) return fail(`${item.id}: invalid sourceCoverage`)
    if (item.pageSourceReuse !== undefined && (item.method !== 'deck-reuse' || !['required', 'whole-deck-only'].includes(item.pageSourceReuse as string))) return fail(`${item.id}: invalid pageSourceReuse`)
    if (item.firstPageOnlySlots !== undefined && (item.method !== 'visual' || !strings(item.firstPageOnlySlots) || item.firstPageOnlySlots.some((id) => !slotIds.has(id) || (item.targetSlots !== '*' && !(item.targetSlots as string[]).includes(id))))) return fail(`${item.id}: invalid firstPageOnlySlots`)
    if (item.method === 'manual' && (typeof item.manualReason !== 'string' || !item.manualReason.trim())) return fail(`${item.id}: manualReason required`)
    if (item.method !== 'artifact-property' && item.properties !== undefined) return fail(`${item.id}: properties are only valid for artifact-property`)
    if (item.method === 'artifact-property') {
      if (!Array.isArray(item.properties) || item.properties.length === 0) return fail(`${item.id}: properties required`)
      for (const property of item.properties) {
        if (!object(property) || !NAMES.has(property.name as RequirementProperty['name'])) return fail(`${item.id}: unknown property`)
        if (!['eq', 'min', 'max', 'one-of', 'matches'].includes(property.op as string)) return fail(`${item.id}: unknown property operator`)
        if (property.tolerance !== undefined && (typeof property.tolerance !== 'number' || !Number.isFinite(property.tolerance) || property.tolerance < 0)) return fail(`${item.id}: invalid tolerance`)
        if (property.aggregate !== undefined && (property.aggregate !== 'sum' || property.name !== 'pageCount')) return fail(`${item.id}: aggregate sum is only valid for pageCount`)
        if (NUMERIC.has(property.name as RequirementProperty['name'])) {
          if (!['eq', 'min', 'max'].includes(property.op as string) || typeof property.value !== 'number' || !Number.isFinite(property.value)) return fail(`${item.id}: numeric property needs numeric comparison`)
        } else if (property.name === 'hasAlpha') {
          if (property.op !== 'eq' || typeof property.value !== 'boolean') return fail(`${item.id}: hasAlpha needs boolean equality`)
        } else if (property.op === 'one-of') {
          if (!strings(property.value)) return fail(`${item.id}: one-of needs nonempty strings`)
        } else {
          if (!['eq', 'matches'].includes(property.op as string) || typeof property.value !== 'string' || !property.value) return fail(`${item.id}: string property needs string comparison`)
          if (property.op === 'matches') {
            try { new RegExp(property.value, 'u') } catch { return fail(`${item.id}: invalid regular expression`) }
          }
        }
      }
    }
  }
  return raw as RequirementCheck[]
}
