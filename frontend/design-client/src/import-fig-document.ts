import type { DesignDocument, Effect, Paint, RulerGuide, Stroke } from './model'
import { defaultTextStyle } from './model'

type FigRecord = Record<string, any>
type Warnings = { add(message: string): unknown }

const STYLE_TYPES = new Set(['FILL', 'STROKE', 'TEXT', 'EFFECT', 'GRID', 'EXPORT'])

export function includeFigRecord(record: FigRecord | undefined, records?: Map<string, FigRecord>, guid?: (value: unknown) => string): boolean {
  if (!record) return false
  if (record.type === 'DOCUMENT') return false
  if (record.type === 'CANVAS') return true
  if (record.type === 'VARIABLE' || record.type === 'VARIABLE_SET') return false
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
  return record.guides.map((guide: FigRecord, index: number): RulerGuide => {
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
      const metadata = (system(doc).sketchContainers!.nodeMetadata ??= {}) as FigRecord
      const receipt = (metadata[node.id] ??= { format: 'fig', bindings: {} })
      receipt.bindings.figBoundVariables = JSON.stringify(record.boundVariables)
      warnings.add(`FIG ${node.name || node.id}: variable bindings retained as source metadata, not executable`)
    }
    if (typeof record.componentKey === 'string' && record.componentKey) {
      const metadata = (system(doc).sketchContainers!.nodeMetadata ??= {}) as FigRecord
      const receipt = (metadata[node.id] ??= { format: 'fig', bindings: {} })
      receipt.bindings.figComponentKey = record.componentKey
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

const guidText = (value: any): string =>
  typeof value === 'string' ? value : value && value.sessionID !== undefined ? `${value.sessionID}:${value.localID}` : ''

function variableColor(color: any): string | undefined {
  const channel = (key: string) => color?.[key]
  const [r, g, b] = ['r', 'g', 'b'].map(channel)
  if ([r, g, b].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return
  const a = typeof color?.a === 'number' && Number.isFinite(color.a) ? color.a : 1
  if (a < 0 || a > 1) return
  if (a === 1) return '#' + [r, g, b].map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')
  return `color(srgb ${r} ${g} ${b} / ${a})`
}

const VARIABLE_FIELDS: Record<string, string> = {
  WIDTH: 'width', HEIGHT: 'height', OPACITY: 'opacity', VISIBLE: 'visible',
  TEXT_DATA: 'text', CHARACTERS: 'text', FONT_SIZE: 'fontSize',
  STACK_SPACING: 'layout.gap', ITEM_SPACING: 'layout.gap',
  LINE_HEIGHT: 'textStyle.lineHeight', LETTER_SPACING: 'textStyle.letterSpacing',
  FONT_WEIGHT: 'textStyle.weight', PARAGRAPH_SPACING: 'layout.lineGap',
}

function variableKind(record: FigRecord) {
  const resolved = String(record.variableResolvedType || '')
  return resolved === 'COLOR' ? 'color' : resolved === 'BOOLEAN' ? 'boolean' : resolved === 'STRING' ? 'string' : 'number'
}

function aliasTarget(value: any, keyToId: Map<string, string>, known: Set<string>) {
  const alias = value?.alias || value?.variableAlias
  if (!alias || typeof alias !== 'object') return
  const key = alias.assetRef?.key
  if (typeof key === 'string' && keyToId.has(key)) return keyToId.get(key)
  const id = guidText(alias)
  return id && id !== '0:0' && known.has(id) ? id : undefined
}

function bindingKind(path: string) {
  return path === 'text' ? 'string' : path === 'visible' ? 'boolean' : path.endsWith('color') ? 'color' : 'number'
}

/** VARIABLE_SET / VARIABLE records are design-system data, not layers. */
export function importFigVariableNodes(doc: DesignDocument, records: Map<string, FigRecord>, ids?: Map<string, string>) {
  const modeNames = new Map<string, string>()
  const systemDoc = system(doc)
  for (const [id, record] of records) {
    if (record.type !== 'VARIABLE_SET') continue
    const collectionId = typeof record.key === 'string' && record.key ? record.key : id
    const modes: string[] = []
    for (const mode of record.variableSetModes || []) {
      const name = typeof mode?.name === 'string' && mode.name ? mode.name : 'Mode'
      const modeId = guidText(mode?.id)
      if (modeId) modeNames.set(modeId, name)
      if (!modes.includes(name)) modes.push(name)
    }
    if (!modes.length) modes.push('Default')
    if (modes.length > 32) continue
    systemDoc.collections[collectionId] = { name: record.name || 'Variables', modes, defaultMode: modes[0] }
    systemDoc.activeModes[collectionId] = modes[0]
  }
  const keyToId = new Map<string, string>()
  const drafts: Array<[string, FigRecord]> = []
  for (const [id, record] of records) {
    if (record.type !== 'VARIABLE') continue
    if (typeof record.key === 'string' && record.key) keyToId.set(record.key, id)
    drafts.push([id, record])
  }
  const known = new Set(drafts.map(([id]) => id))
  let unresolvedAliases = 0
  for (const [id, record] of drafts) {
    const collection = record.variableSetID?.assetRef?.key || guidText(record.variableSetID) || id
    if (!systemDoc.collections[collection]) {
      systemDoc.collections[collection] = { name: collection, modes: ['Default'], defaultMode: 'Default' }
      systemDoc.activeModes[collection] = 'Default'
    }
    const kind = variableKind(record)
    const values: Record<string, string | number | boolean | { alias: string }> = {}
    for (const entry of record.variableDataValues?.entries || []) {
      const mode = modeNames.get(guidText(entry?.modeID)) || 'Default'
      const data = entry?.variableData
      const raw = data?.value
      if (raw && (raw.alias || raw.variableAlias)) {
        const target = aliasTarget(raw, keyToId, known)
        const targetKind = target ? variableKind(records.get(target) || {}) : ''
        if (target && targetKind === kind) values[mode] = { alias: target }
        else unresolvedAliases += 1
        continue
      }
      if (kind === 'color') {
        const color = variableColor(raw?.colorValue)
        if (color) values[mode] = color
      } else if (kind === 'boolean' && typeof raw?.boolValue === 'boolean') values[mode] = raw.boolValue
      else if (kind === 'string' && typeof raw?.textValue?.characters === 'string') values[mode] = raw.textValue.characters
      else if (typeof raw?.floatValue === 'number' && Number.isFinite(raw.floatValue)) values[mode] = raw.floatValue
    }
    const modes = systemDoc.collections[collection].modes
    if (modes.length > 32) continue
    const fallback = kind === 'boolean' ? false : kind === 'number' ? 0 : kind === 'color' ? '#000000' : ''
    if (!Object.keys(values).length) values[modes[0]] = fallback
    for (const mode of modes) if (values[mode] === undefined) values[mode] = values[modes[0]] ?? fallback
    for (const key of Object.keys(values)) if (!modes.includes(key)) delete values[key]
    systemDoc.variables[id] = { name: String(record.name || 'Variable').slice(0, 512), collection, kind, values }
  }
  if (unresolvedAliases) {
    const receipt = (systemDoc.sketchContainers?.figDocument ?? { source: 'figma' }) as FigRecord
    const stored = Array.isArray(receipt.notes) ? receipt.notes : []
    stored.push(`${unresolvedAliases} variable aliases had no local target of the same type and kept the mode fallback`)
    receipt.notes = stored
    systemDoc.sketchContainers ??= {}
    systemDoc.sketchContainers.figDocument = receipt
  }
  let unsupportedField = false
  if (ids) {
    for (const [source, record] of records) {
      const node = doc.nodes[ids.get(source) || '']
      if (!node) continue
      const seen = new Set<string>()
      for (const entry of record.variableConsumptionMap?.entries || []) {
        const path = VARIABLE_FIELDS[String(entry?.variableField || '')]
        if (!path) {
          if (entry?.variableField) unsupportedField = true
          continue
        }
        if (seen.has(path)) continue
        seen.add(path)
        const target = aliasTarget(entry?.variableData?.value, keyToId, known)
        const variable = target ? systemDoc.variables[target] : undefined
        if (!target || !variable || variable.kind !== bindingKind(path)) {
          unsupportedField = true
          continue
        }
        node.bindings = { ...node.bindings, [path]: target }
      }
    }
  }
  if (unsupportedField) {
    const receipt = (systemDoc.sketchContainers?.figDocument ?? { source: 'figma' }) as FigRecord
    const stored = Array.isArray(receipt.notes) ? receipt.notes : []
    stored.push('FIG variable fields without an executable property are retained as figVariableConsumption')
    receipt.notes = stored
    systemDoc.sketchContainers ??= {}
    systemDoc.sketchContainers.figDocument = receipt
  }
  const knownIds = new Set(Object.keys(systemDoc.variables))
  const linked = (value: unknown, field = ''): Array<[string, string]> => {
    if (!value || typeof value !== 'object') return []
    if ('sessionID' in value && 'localID' in value) {
      const id = guidText(value)
      return field && knownIds.has(id) ? [[field, id]] : []
    }
    return Object.entries(value).flatMap(([key, child]) => linked(child, field || key))
  }
  for (const node of Object.values(doc.nodes)) {
    const metadata = systemDoc.sketchContainers?.nodeMetadata as FigRecord | undefined
    const raw = metadata?.[node.id]?.bindings?.figBoundVariables
    if (!raw) continue
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { continue }
    for (const [field, id] of linked(parsed)) node.bindings = { ...node.bindings, [field]: id }
  }
  normalizeFigOpacityBindings(doc)
}

function opacityBindingPath(path: string) {
  return path === 'opacity' || path.endsWith('.opacity')
}

function scaledFigOpacityVariable(
  system: NonNullable<DesignDocument['designSystem']>,
  id: string,
  memo: Map<string, string>,
  stack: Set<string>,
): string {
  const done = memo.get(id)
  if (done) return done
  if (stack.has(id)) return id
  const source = system.variables[id]
  if (!source || source.kind !== 'number') {
    memo.set(id, id)
    return id
  }
  stack.add(id)
  const values: typeof source.values = {}
  let scaled = false
  for (const [mode, value] of Object.entries(source.values)) {
    if (value && typeof value === 'object' && 'alias' in value) {
      const next = scaledFigOpacityVariable(system, value.alias, memo, stack)
      if (next !== value.alias) scaled = true
      values[mode] = { alias: next }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1 && value <= 100) {
        scaled = true
        values[mode] = value / 100
      } else values[mode] = value
    } else {
      stack.delete(id)
      memo.set(id, id)
      return id
    }
  }
  stack.delete(id)
  if (!scaled) {
    memo.set(id, id)
    return id
  }
  let nextId = `${id}#fig-opacity`
  let generation = 2
  while (system.variables[nextId]) {
    nextId = `${id}#fig-opacity-${generation}`
    generation += 1
    if (generation > 8) {
      memo.set(id, id)
      return id
    }
  }
  system.variables[nextId] = { name: source.name, collection: source.collection, kind: source.kind, values }
  memo.set(id, nextId)
  return nextId
}

function percentNumberVariable(variable: NonNullable<DesignDocument['designSystem']>['variables'][string]) {
  const values = Object.values(variable.values)
  return variable.kind === 'number'
    && values.some(value => typeof value === 'number' && value > 1 && value <= 100)
    && values.every(value => typeof value === 'number' && Number.isFinite(value))
}

/** FIG opacity numbers above 1 are percentages. A token used only for opacity
 * is scaled in place. A token also used as a length keeps its source number,
 * and only the opacity binding points at a 0–1 copy. */
export function normalizeFigOpacityBindings(doc: DesignDocument) {
  const system = doc.designSystem
  if (!system) return
  const uses = new Map<string, Set<string>>()
  const sites: Array<{ map: Record<string, string>; field: string }> = []
  const take = (map: Record<string, unknown> | undefined) => {
    if (!map) return
    for (const [field, id] of Object.entries(map)) {
      if (typeof id !== 'string') continue
      const fields = uses.get(id) ?? new Set<string>()
      fields.add(field)
      uses.set(id, fields)
      if (opacityBindingPath(field)) sites.push({ map: map as Record<string, string>, field })
    }
  }
  for (const node of Object.values(doc.nodes)) {
    take(node.bindings)
    for (const fields of Object.values(node.instance?.overrides || {})) {
      const bindings = fields.bindings
      if (bindings && typeof bindings === 'object' && !Array.isArray(bindings)) take(bindings as Record<string, unknown>)
    }
  }
  if (!sites.length) return
  const inplace = new Set<string>()
  for (const [id, fields] of uses) {
    const variable = system.variables[id]
    if (!variable || ![...fields].every(opacityBindingPath) || !percentNumberVariable(variable)) continue
    for (const [mode, value] of Object.entries(variable.values)) {
      if (typeof value === 'number' && value > 1 && value <= 100) variable.values[mode] = value / 100
    }
    inplace.add(id)
  }
  const memo = new Map<string, string>()
  const stack = new Set<string>()
  for (const site of sites) {
    const current = site.map[site.field]
    if (typeof current !== 'string' || inplace.has(current)) continue
    const next = scaledFigOpacityVariable(system, current, memo, stack)
    if (next !== current) site.map[site.field] = next
  }
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
