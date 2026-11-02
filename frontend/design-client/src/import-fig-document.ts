import type { DesignDocument, Effect, Paint, Stroke } from './model'
import { defaultTextStyle } from './model'

type FigRecord = Record<string, any>
type Warnings = { add(message: string): unknown }

const STYLE_TYPES = new Set(['FILL', 'STROKE', 'TEXT', 'EFFECT', 'GRID', 'EXPORT'])

export function includeFigRecord(record: FigRecord | undefined, records?: Map<string, FigRecord>, guid?: (value: unknown) => string): boolean {
  if (!record) return false
  if (record.type === 'DOCUMENT') return false
  if (record.type === 'CANVAS') return true
  if (record.internalOnly === true) return false
  // Style definitions parented to the document, or to nothing, are library entries.
  if (STYLE_TYPES.has(record.styleType)) {
    const parent = guid?.(record.parentIndex?.guid)
    const parentRecord = parent ? records?.get(parent) : undefined
    if (!parentRecord || parentRecord.type === 'DOCUMENT' || STYLE_TYPES.has(parentRecord.styleType)) return false
  }
  return true
}

export function figGuides(record: FigRecord, pageId: string) {
  if (record.guides === undefined) return undefined
  if (!Array.isArray(record.guides)) throw new Error('FIG 页面参考线必须是数组；原文件未修改')
  if (record.guides.length > 1000) throw new Error('FIG 页面参考线超过 1000 条；原文件未修改')
  return record.guides.map((guide: FigRecord, index: number) => {
    const axis = guide?.axis === 'X' || guide?.axis === 'x' ? 'x' : guide?.axis === 'Y' || guide?.axis === 'y' ? 'y' : ''
    const position = guide?.offset ?? guide?.position
    if (!axis || typeof position !== 'number' || !Number.isFinite(position) || Math.abs(position) > 1e7)
      throw new Error('FIG 页面参考线的方向或位置无效；原文件未修改')
    const id = `${pageId}:g:${index}`
    if (id.length > 128) throw new Error('FIG 参考线标识过长；原文件未修改')
    return { id, axis, position }
  })
}

function variantMap(name: string): Record<string, string> | undefined {
  if (!name.includes('=')) return undefined
  const map: Record<string, string> = {}
  for (const part of name.split(',')) {
    const split = part.trim().split('=')
    if (split.length !== 2) return undefined
    const [key, value] = split.map(item => item.trim())
    if (!key || !value || key.length > 128 || value.length > 128 || Object.hasOwn(map, key) || /[\u0000-\u001f\u007f]/.test(key + value))
      return undefined
    map[key] = value
  }
  const count = Object.keys(map).length
  return count > 0 && count <= 16 ? map : undefined
}

function weightOf(style: unknown): number | undefined {
  const lower = String(style ?? '').toLowerCase().replace(/[\s-]/g, '').replace(/italic$/, '')
  return ({ thin: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 800, black: 900 } as Record<string, number>)[lower]
}

function textStyleOf(record: FigRecord) {
  const fontSize = record.fontSize || 16
  const style = {
    ...defaultTextStyle(),
    wrap: record.textAutoResize !== 'WIDTH_AND_HEIGHT',
    paragraphSpacing: record.paragraphSpacing || 0,
    paragraphIndent: record.paragraphIndent || 0,
    align: record.textAlignHorizontal === 'CENTER' ? 'center' as const
      : record.textAlignHorizontal === 'RIGHT' ? 'end' as const
        : record.textAlignHorizontal === 'JUSTIFIED' ? 'justify' as const
          : 'start' as const,
  }
  const weight = weightOf(record.fontName?.style)
  if (weight) style.weight = weight
  if (record.lineHeight?.units === 'PIXELS' && fontSize >= 1) style.lineHeight = record.lineHeight.value / fontSize
  if (record.lineHeight?.units === 'PERCENT') style.lineHeight = record.lineHeight.value / 100
  if (record.lineHeight?.units === 'RAW') style.lineHeight = record.lineHeight.value
  if (record.letterSpacing?.units === 'PIXELS') style.letterSpacing = record.letterSpacing.value
  if (record.letterSpacing?.units === 'PERCENT') style.letterSpacing = record.letterSpacing.value * fontSize / 100
  if (record.textCase === 'UPPER' || record.textCase === 'LOWER') style.textCase = record.textCase.toLowerCase() as 'upper' | 'lower'
  return style
}

function remember(notes: string[], note: string) {
  if (notes.length < 32 && !notes.includes(note)) notes.push(note)
}

function system(doc: DesignDocument) {
  doc.designSystem ??= { collections: {}, variables: {}, activeModes: {}, styles: {}, libraries: {} }
  doc.designSystem.sketchContainers ??= {}
  return doc.designSystem
}

export function applyFigDocumentSemantics(
  doc: DesignDocument,
  records: Map<string, FigRecord>,
  ids: Map<string, string>,
  guid: (value: unknown) => string,
  tools: {
    toPaint: (paint: FigRecord) => Paint
    effectsOf: (record: FigRecord) => Effect[]
    strokesOf: (record: FigRecord) => Stroke[]
    fallbackName: string
  },
  warnings: Warnings,
) {
  const notes: string[] = []
  const internalPages = doc.pages.filter(page => [...records].some(([key, record]) => ids.get(key) === page.id && record.internalOnly === true)).map(page => page.id)
  const document = [...records.values()].find(record => record.type === 'DOCUMENT')
  if (typeof document?.name === 'string' && document.name.trim() && document.name.length <= 200)
    doc.name = document.name
  else if (typeof document?.name === 'string' && document.name.trim())
    remember(notes, `document name exceeds 200 UTF-16 code units and was kept as ${tools.fallbackName}`)

  const styles = system(doc).styles
  for (const [key, record] of records) {
    if (!STYLE_TYPES.has(record.styleType)) continue
    const id = ids.get(key)!
    if (record.styleType === 'GRID' || record.styleType === 'EXPORT') {
      remember(notes, `shared style ${record.name || id} (${record.styleType}) is retained as source metadata, not an executable style`)
      const retained = (system(doc).sketchContainers!.figRetainedStyles as FigRecord[] | undefined) ?? []
      retained.push({ id, name: record.name || '', styleType: record.styleType })
      system(doc).sketchContainers!.figRetainedStyles = retained
      continue
    }
    const name = typeof record.name === 'string' && record.name.trim() ? record.name : 'Style'
    if (name.length > 512) throw new Error(`FIG 共享样式 ${name.slice(0, 32)} 的名称过长；原文件未修改`)
    if (record.styleType === 'FILL') styles[id] = { name, kind: 'paint', value: (record.fillPaints || []).map(tools.toPaint) }
    else if (record.styleType === 'STROKE') styles[id] = { name, kind: 'paint', value: [], strokes: tools.strokesOf(record) }
    else if (record.styleType === 'EFFECT') styles[id] = { name, kind: 'effect', value: tools.effectsOf(record) }
    else styles[id] = { name, kind: 'text', value: textStyleOf(record) }
    if (record.fontName?.family) remember(notes, `shared style ${name}: fontName.family=${record.fontName.family}`)
  }

  for (const [key, record] of records) {
    const node = doc.nodes[ids.get(key)!]
    if (!node) continue
    const use = (field: 'fills' | 'textStyle' | 'effects', source: string) => {
      const styleId = ids.get(guid(record[source]))
      if (!record[source] || typeof record[source] !== 'object') return
      if (styleId && styles[styleId]) node.styleRefs = { ...node.styleRefs, [field]: styleId }
      else warnings.add(`FIG ${node.name || node.id}: unresolved shared style ${source}`)
    }
    use('fills', 'inheritFillStyleID')
    use('textStyle', 'inheritTextStyleID')
    use('effects', 'inheritEffectStyleID')
    if (record.inheritFillStyleIDForStroke || record.inheritStrokeStyleID)
      warnings.add(`FIG ${node.name || node.id}: stroke style reference is preserved on the style, not applied to fills`)
    if (record.inheritGridStyleID) warnings.add(`FIG ${node.name || node.id}: grid style reference is not executable`)
    if (record.boundVariables) {
      node.bindings = { ...node.bindings, figBoundVariables: JSON.stringify(record.boundVariables) }
      warnings.add(`FIG ${node.name || node.id}: variable bindings retained as source metadata, not executable`)
    }
    if (typeof record.componentKey === 'string' && record.componentKey) {
      node.bindings = { ...node.bindings, figComponentKey: record.componentKey }
    }
  }

  for (const [key, record] of records) {
    const node = doc.nodes[ids.get(key)!]
    if (!node || !(record.type === 'COMPONENT_SET' || record.isStateGroup === true)) continue
    if (!node.children.length) {
      delete node.component
      node.componentSet = true
      continue
    }
    const parsed: Array<[string, Record<string, string>]> = []
    let promoted = true
    for (const child of node.children) {
      const variant = doc.nodes[child]
      if (!variant?.component) { promoted = false; break }
      const map = Object.keys(variant.component.variants).length ? variant.component.variants : variantMap(variant.name)
      if (!map) { promoted = false; break }
      parsed.push([child, map])
    }
    const axes = parsed[0] ? Object.keys(parsed[0][1]).sort().join('\0') : ''
    const seen = new Set<string>()
    const unique = promoted && parsed.every(([, map]) => {
      const signature = JSON.stringify(Object.keys(map).sort().map(name => [name, map[name]]))
      const sameAxes = Object.keys(map).sort().join('\0') === axes
      const fresh = !seen.has(signature)
      seen.add(signature)
      return sameAxes && fresh
    })
    if (!unique) {
      remember(notes, `component set ${node.name} was kept as a frame; variant names must be unique Key=Value pairs on main components`)
      continue
    }
    for (const [child, map] of parsed) doc.nodes[child].component!.variants = map
    delete node.component
    node.componentSet = true
  }

  const receipt: FigRecord = { source: 'figma', ...(document ? { documentId: guid(document.guid) } : {}), ...(internalPages.length ? { internalPages } : {}) }
  if (typeof document?.documentColorProfile === 'string') receipt.colorProfile = document.documentColorProfile
  else if (typeof document?.colorProfile === 'string') receipt.colorProfile = document.colorProfile
  if (notes.length) receipt.notes = notes
  system(doc).sketchContainers!.figDocument = receipt
  for (const note of notes) warnings.add(`FIG document: ${note}`)
}

export function storeFigVariables(doc: DesignDocument, tree: FigRecord) {
  const variables: FigRecord = {}
  for (const key of ['variables', 'variableCollections', 'variableSets', 'variableModes']) {
    if (tree[key] !== undefined) variables[key] = tree[key]
  }
  if (!Object.keys(variables).length) return
  const encoded = JSON.stringify(variables)
  const receipt = (doc.designSystem?.sketchContainers?.figDocument ?? {}) as FigRecord
  if (encoded.length > 256 * 1024) {
    receipt.variables = { omitted: true }
    const notes = Array.isArray(receipt.notes) ? receipt.notes : []
    notes.push('variable payload exceeds the 256 KiB inert metadata budget and was not copied')
    receipt.notes = notes
  } else receipt.variables = variables
  doc.designSystem ??= { collections: {}, variables: {}, activeModes: {}, styles: {}, libraries: {} }
  doc.designSystem.sketchContainers ??= {}
  doc.designSystem.sketchContainers.figDocument = receipt
}
