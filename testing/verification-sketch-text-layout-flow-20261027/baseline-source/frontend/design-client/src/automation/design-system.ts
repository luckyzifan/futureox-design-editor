import * as ComponentSlots from '../component-slots'
/** Local document design-system automation. No network, renderer, or editor state. */
import * as Components from '../components'
import {
  emptySystem, setEffectiveNodeVariableMode, setVariableMode, variableValue,
  type DesignSystem, type VariableValue,
} from '../design-system'
import {
  container, defaultTextStyle, node, uid, validateDocument,
  type ComponentProperty, type DesignDocument, type DesignNode,
} from '../model'
import { validColor } from '../color'
import { prototypeVariableModeReferences, remapVariableModeReferences } from '../variable-editing'
import { allParents } from '../geometry'
import { unmatchedSourceFonts } from '../font-matching'
import { applyWholeTextStyle } from '../text'
import { font_faces_json } from '../generated/design-kernel/design_kernel'
import { AutomationError, type AutomationContext, type AutomationExtension } from './types'

type Params = Record<string, unknown>
type Variable = DesignSystem['variables'][string]
type Style = DesignSystem['styles'][string]
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
const copy = <T>(value: T): T => structuredClone(value)
function object(value: unknown, label: string): Params {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  for (const key of Object.keys(value)) if (forbidden.has(key)) throw new Error(`Unsafe key: ${key}`)
  return value as Params
}
function key(value: unknown, label = 'id', max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || forbidden.has(value) || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`Invalid ${label}`)
  return value
}
function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error(`Invalid ${label}`)
  return value
}
function record(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value, label)).map(([k, v]) => [key(k, label), key(v, label)]))
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 20000) throw new Error(`Invalid ${label}`)
  const result = value.map(v => key(v, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicate IDs`)
  return result
}
function requiredNode(d: DesignDocument, value: unknown): DesignNode {
  const id = key(value, 'nodeId'), n = Object.hasOwn(d.nodes, id) && d.nodes[id]
  if (!n) throw new Error(`Unknown node: ${id}`)
  return n
}
function component(d: DesignDocument, value: unknown): DesignNode {
  const n = requiredNode(d, value)
  if (!n.component) throw new Error(`Node is not a main component: ${n.id}`)
  return n
}
function instance(d: DesignDocument, value: unknown): DesignNode {
  const n = requiredNode(d, value)
  if (!n.instance) throw new Error(`Node is not an instance: ${n.id}`)
  return n
}
/** Structural edits follow core node-edit locks. Explicit property-panel edits
 * (overrides, properties, typography, bindings) retain their existing semantics. */
function assertStructureUnlocked(d: DesignDocument, id: string) {
  const parents = allParents(d), seen = new Set<string>()
  let current: string | undefined = id
  while (current && d.nodes[current]) {
    if (seen.has(current)) throw new Error('Cyclic layer ancestry')
    seen.add(current)
    if (d.nodes[current].locked) throw new AutomationError('locked_node', `Node ${current} is locked`)
    current = parents.get(current)
  }
}
function prototypeUsesVariable(d: DesignDocument, id: string) {
  return Object.values(d.prototype?.interactions || {}).some(events => events.some(event =>
    event.condition?.variable === id || event.actions.some(a =>
      [a.targetVariable, a.targetVariableData?.id, a.transitionDurationVar, a.transitionEasingVar, a.kind === 'set-variable' ? a.target : undefined].includes(id)),
  ))
}
function prototypeUsesMode(d: DesignDocument, collectionId: string, mode: string) {
  return prototypeVariableModeReferences(d, collectionId, mode).length > 0
}

function system(d: DesignDocument): DesignSystem {
  d.schemaVersion = Math.max(4, d.schemaVersion) as DesignDocument['schemaVersion']
  return d.designSystem ??= emptySystem()
}
function resource<T>(resources: Record<string, T> | undefined, value: unknown, label: string): T {
  const id = key(value, `${label}Id`)
  if (!resources || !Object.hasOwn(resources, id)) throw new Error(`Unknown ${label}: ${id}`)
  return resources[id]
}
function newId(resources: object, value?: unknown): string {
  const id = value === undefined ? uid() : key(value)
  if (Object.hasOwn(resources, id)) throw new Error(`ID already exists: ${id}`)
  return id
}
function page(d: DesignDocument, p: Params, context: AutomationContext): string {
  const id = key(p.pageId ?? context.pageId, 'pageId')
  if (!d.pages.some(page => page.id === id)) throw new Error(`Unknown page: ${id}`)
  return id
}
function pageOf(d: DesignDocument, id: string): string {
  const parents = allParents(d)
  while (parents.has(id)) id = parents.get(id)!
  if (!d.pages.some(p => p.id === id)) throw new Error('Node does not belong to a page')
  return id
}
function created(context: AutomationContext, id: string) { context.createdIds.push(id); return { id } }
function propertyValue(d: DesignDocument, property: ComponentProperty, value: unknown): string | boolean {
  if (property.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('Boolean component property requires a boolean')
  } else if (property.kind === 'text') {
    if (typeof value !== 'string' || value.length > 100000) throw new Error('Text component property requires a string')
  } else if (property.kind === 'instance-swap') component(d, value)
  else throw new Error('Unknown component property kind')
  return value as string | boolean
}
function bindings(n: DesignNode) {
  return [n, ...Object.values(n.instance?.overrides || {})] as Array<{
    bindings?: Record<string, string>; styleRefs?: Record<string, string>; variableModes?: Record<string, string>
  }>
}
function variableKindForPath(path: string): Variable['kind'] {
  if (/^fills\.(?:[0-9]|1[0-5])\.color$/.test(path)) return 'color'
  if (path === 'text') return 'string'
  if (path === 'visible') return 'boolean'
  if (['width', 'height', 'opacity', 'fontSize', 'layout.gap', 'layout.lineGap', 'textStyle.weight', 'textStyle.lineHeight', 'textStyle.letterSpacing'].includes(path) || /^fills\.(?:[0-9]|1[0-5])\.opacity$/.test(path)) return 'number'
  throw new Error(`Unsupported variable binding path: ${path}`)
}
const styleFields = { fills: 'paint', textStyle: 'text', effects: 'effect' } as const
function styleField(value: unknown): keyof typeof styleFields {
  const field = key(value, 'field')
  if (!Object.hasOwn(styleFields, field)) throw new Error(`Unsupported style field: ${field}`)
  return field as keyof typeof styleFields
}
function nodeReferences(d: DesignDocument, n: DesignNode) {
  for (const refs of bindings(n)) {
    for (const [path, id] of Object.entries(refs.bindings || {})) {
      const v = resource(d.designSystem?.variables, id, 'variable')
      if (v.kind !== variableKindForPath(path)) throw new Error(`Variable/property type mismatch: ${path}`)
    }
    for (const [field, id] of Object.entries(refs.styleRefs || {})) {
      const s = resource(d.designSystem?.styles, id, 'style')
      if (styleFields[styleField(field)] !== s.kind) throw new Error(`Style/property type mismatch: ${field}`)
    }
    for (const [id, mode] of Object.entries(refs.variableModes || {})) {
      const c = resource(d.designSystem?.collections, id, 'collection')
      if (!c.modes.includes(mode)) throw new Error(`Unknown variable mode: ${mode}`)
    }
  }
}
function validateVariableValue(d: DesignDocument, v: Variable, value: unknown): asserts value is VariableValue {
  if (value && typeof value === 'object') {
    const alias = object(value, 'alias')
    if (Object.keys(alias).length !== 1 || !Object.hasOwn(alias, 'alias')) throw new Error('Alias must contain only alias')
    const target = resource(d.designSystem?.variables, alias.alias, 'variable')
    if (target.kind !== v.kind) throw new Error('Variable alias type mismatch')
    return
  }
  const valid = v.kind === 'color' ? validColor(value, !!d.colorManagement)
    : v.kind === 'number' ? typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e7
    : v.kind === 'boolean' ? typeof value === 'boolean'
    : v.kind === 'string' && typeof value === 'string' && value.length <= 100000
  if (!valid) throw new Error(`Invalid ${v.kind} variable value`)
}
function validateStyle(d: DesignDocument, s: Style) {
  key(s.name, 'style name', 512)
  if (!['paint', 'text', 'effect'].includes(s.kind)) throw new Error('Unknown style kind')
  if (s.kind !== 'paint' && (s.strokes !== undefined || s.effects !== undefined)) throw new Error('Only paint styles carry strokes/effects')
  const sample = node(s.kind === 'text' ? 'text' : 'rectangle')
  if (s.kind === 'paint') {
    sample.fills = copy(s.value) as DesignNode['fills']
    sample.strokes = copy(s.strokes || [])
    sample.effects = copy(s.effects || [])
  } else if (s.kind === 'effect') sample.effects = copy(s.value) as DesignNode['effects']
  else sample.textStyle = { ...defaultTextStyle(), ...object(s.value, 'text style') } as DesignNode['textStyle']
  validateSample(d, sample)
}
function validateSample(d: DesignDocument, sample: DesignNode) {
  // Validate authored values with existing transport admission, without involving rendering.
  const n = { ...sample, children: [] }
  delete n.component; delete n.componentSet; delete n.instance; delete n.instanceOrigin
  delete n.variableModes; delete n.bindings; delete n.styleRefs
  validateDocument({
    id: d.id, name: d.name, schemaVersion: Math.max(15,d.schemaVersion) as DesignDocument['schemaVersion'], fonts: d.fonts, colorManagement: d.colorManagement,
    rasterProfile: d.rasterProfile,
    pages: [{ ...d.pages[0], children: [n.id], guides: undefined }], nodes: { [n.id]: n },
  })
}
function template(d: DesignDocument, root: string): Map<string, string> {
  const result = new Map<string, string>(), seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    if (depth > 64 || seen.has(id)) throw new Error('Component template cycle or depth exceeded')
    seen.add(id)
    const n = requiredNode(d, id), k = id === root ? '$root' : key(n.componentKey || id, 'template key')
    if ((id !== root && (n.component || n.componentSet || k === '$root')) || result.has(k)) throw new Error('Nested component or duplicate template key')
    result.set(k, id)
    if (!n.instance) n.children.forEach(child => walk(child, depth + 1))
  }
  walk(root, 0)
  return result
}
/** Includes authored descendants of nested instances, even before kernel materialization. */
function overrideTarget(d: DesignDocument, owner: DesignNode, path: string): DesignNode {
  if (path === '$root') return owner
  // Resolve against authored definitions instead of possibly stale materialized
  // children: a prior operation in this batch may have swapped a nested instance.
  const visit = (componentId: string, prefix: string, values: Params, depth: number): DesignNode | undefined => {
    if (depth > 32) throw new Error('Component dependency depth exceeded')
    const properties = component(d, componentId).component!.properties
    for (const [k, id] of template(d, componentId)) {
      if (k === '$root') continue
      const full = prefix ? `${prefix}/${k}` : k, n = d.nodes[id]
      let target = n.instance?.componentId
      if (target) {
        for (const [propertyId, property] of Object.entries(properties)) if (property.kind === 'instance-swap' && property.targetKey === k)
          target = String(values[propertyId] ?? property.defaultValue)
        const swap = owner.instance!.overrides[full]?.swapComponent
        if (typeof swap === 'string') target = swap
      }
      if (full === path) return target ? { ...n, instance: { ...n.instance!, componentId: target } } : n
      if (target && path.startsWith(full + '/')) {
        const nested = { ...n.instance!.propertyValues, ...owner.instance!.overrides[full]?.propertyValues as Params }
        const found = visit(target, full, nested, depth + 1)
        if (found) return found
      }
    }
  }
  const target = visit(owner.instance!.componentId, '', { ...owner.instance!.propertyValues, ...owner.instance!.overrides.$root?.propertyValues as Params }, 0)
  if (!target) throw new Error(`Unknown override target: ${path}`)
  return target
}
function validateOverride(d: DesignDocument, owner: DesignNode, path: string, values: Params) {
  const target = overrideTarget(d, owner, path)
  if (Object.keys(values).length > 32) throw new Error('Too many override fields')
  for (const field of Object.keys(values)) {
    if (!(Components.overrideFields as readonly string[]).includes(field) && !['swapComponent', 'propertyValues'].includes(field))
      throw new Error(`Structural or unsupported override: ${field}`)
  }
  if (values.swapComponent !== undefined) {
    if (!target.instance || path === '$root') throw new Error('Use component.swap for the root instance')
    component(d, values.swapComponent)
  }
  if (values.propertyValues !== undefined) {
    const props = object(values.propertyValues, 'propertyValues')
    const source = component(d, values.swapComponent ?? target.instance?.componentId)
    for (const [id, value] of Object.entries(props)) propertyValue(d, resource(source.component!.properties, id, 'property'), value)
  }
  const sample = { ...copy(target), ...copy(values) } as DesignNode
  validateSample(d, sample)
  nodeReferences(d, sample)
}
/** Extra admission absent from model.validateDocument: resource integrity and dependency graphs. */
export function validateDesignSystemDocument(d: DesignDocument): void {
  const s = d.designSystem
  if (s) {
    if (Object.keys(s.collections).length > 128 || Object.keys(s.variables).length > 4096 || Object.keys(s.styles).length > 4096) throw new Error('Design-system resource budget exceeded')
    for (const [id, c] of Object.entries(s.collections)) {
      key(id); key(c.name, 'collection name', 512)
      const modes = strings(c.modes, 'modes')
      if (modes.length > 32 || !modes.includes(c.defaultMode)) throw new Error('Invalid collection default mode')
    }
    for (const [id, mode] of Object.entries(s.activeModes)) if (!resource(s.collections, id, 'collection').modes.includes(mode)) throw new Error('Unknown active variable mode')
    for (const [id, v] of Object.entries(s.variables)) {
      key(id); key(v.name, 'variable name', 512)
      const c = resource(s.collections, v.collection, 'collection')
      if (!['color', 'number', 'boolean', 'string'].includes(v.kind)) throw new Error('Unknown variable kind')
      if (Object.keys(object(v.values, 'values')).length !== c.modes.length || c.modes.some(m => !Object.hasOwn(v.values, m))) throw new Error('Variable requires exactly one value for every collection mode')
      Object.values(v.values).forEach(value => validateVariableValue(d, v, value))
    }
    // Check all possible inherited selections. Reusing a collection fixes its mode:
    // aliases in mutually exclusive modes must not be mistaken for a real cycle.
    const done = new Set<string>()
    let visits = 0
    const visit = (id: string, modes: Map<string, string>, stack: Set<string>) => {
      if (stack.has(id) || stack.size >= 64) throw new Error('Variable alias cycle or depth exceeded')
      const cacheKey = `${id}:${JSON.stringify([...modes].sort(([a], [b]) => a.localeCompare(b)))}`
      if (done.has(cacheKey)) return
      if (++visits > 2_000_000) throw new Error('Variable alias validation complexity exceeded')
      const next = new Set(stack).add(id)
      const v = s.variables[id], c = s.collections[v.collection]
      for (const mode of modes.has(v.collection) ? [modes.get(v.collection)!] : c.modes) {
        const value = v.values[mode]
        if (typeof value === 'object') visit(value.alias, new Map(modes).set(v.collection, mode), next)
      }
      done.add(cacheKey)
    }
    Object.keys(s.variables).forEach(id => visit(id, new Map(), new Set()))
    Object.values(s.styles).forEach(style => validateStyle(d, style))
  }
  const parents = allParents(d), dependencies = new Map<string, Set<string>>()
  for (const n of Object.values(d.nodes)) {
    nodeReferences(d, n)
    if (n.component || n.componentSet) {
      let parent = parents.get(n.id)
      while (parent && d.nodes[parent]) {
        if (d.nodes[parent].component || d.nodes[parent].instance) throw new Error('Main components cannot be nested; insert an instance')
        parent = parents.get(parent)
      }
    }
    if (n.component) {
      const keys = template(d, n.id), names = new Set<string>(), targets = new Set<string>(), refs = new Set<string>()
      const variants = record(n.component.variants, 'variants')
      if (Object.keys(variants).length > 16 || Object.keys(n.component.properties).length > 128) throw new Error('Component property budget exceeded')
      for (const [axis, value] of Object.entries(variants)) { key(axis, 'variant axis', 128); key(value, 'variant value', 128) }
      for (const [id, property] of Object.entries(n.component.properties)) {
        key(id); key(property.name, 'property name', 128)
        const target = d.nodes[keys.get(property.targetKey) || ''], binding = `${property.targetKey}:${property.kind}`
        if (!target || property.targetKey === '$root' || names.has(property.name) || targets.has(binding)) throw new Error('Invalid or duplicate component property target')
        names.add(property.name); targets.add(binding)
        if ((property.kind === 'text' && target.kind !== 'text') || (property.kind === 'instance-swap' && !target.instance)) throw new Error('Component property does not match target layer')
        propertyValue(d, property, property.defaultValue)
        if (property.kind === 'instance-swap') refs.add(String(property.defaultValue))
      }
      for (const id of keys.values()) Components.instanceReferences(d, d.nodes[id]).forEach(ref => refs.add(ref))
      dependencies.set(n.id, refs)
    }
    if (n.componentSet) {
      let axes: string | undefined
      const combinations = new Set<string>()
      for (const id of n.children) {
        const variants = component(d, id).component!.variants, keys = Object.keys(variants).sort(), shape = JSON.stringify(keys)
        const combination = JSON.stringify(keys.map(k => [k, variants[k]]))
        if (!keys.length || (axes !== undefined && axes !== shape) || combinations.has(combination)) throw new Error('Variants must have matching axes and unique combinations')
        axes = shape; combinations.add(combination)
      }
    }
    if (n.instance) {
      const source = component(d, n.instance.componentId)
      if (Object.keys(n.instance.overrides).length > 2048 || Object.keys(n.instance.propertyValues).length > 256) throw new Error('Instance override budget exceeded')
      for (const [id, value] of Object.entries(n.instance.propertyValues)) {
        // Kernel retains unmatched properties across swaps for later restoration.
        const property = source.component!.properties[id]
        if (property) propertyValue(d, property, value)
      }
      for (const [path, fields] of Object.entries(n.instance.overrides)) {
        key(path, 'override path')
        object(fields, 'override fields')
        for (const field of Object.keys(fields)) if (!(Components.overrideFields as readonly string[]).includes(field) && !['swapComponent', 'propertyValues'].includes(field)) throw new Error(`Structural or unsupported override: ${field}`)
        if (fields.swapComponent !== undefined) component(d, fields.swapComponent)
      }
    }
  }
  const done = new Set<string>()
  const visit = (id: string, stack: Set<string>) => {
    if (stack.has(id) || stack.size >= 32) throw new Error('Cyclic component dependency or depth exceeded')
    if (done.has(id)) return
    const next = new Set(stack).add(id)
    for (const ref of dependencies.get(id) || []) visit(ref, next)
    done.add(id)
  }
  for (const id of dependencies.keys()) visit(id, new Set())
}

const str = { type: 'string', minLength: 1 }
const nullableStr = { anyOf: [str, { type: 'null' }] }
const obj = { type: 'object' }
const ids = { type: 'array', items: str, minItems: 1, uniqueItems: true }
const schema = (properties: Params, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
function extension(name: string, description: string, properties: Params, required: string[], mutates: boolean, run: AutomationExtension['execute']): AutomationExtension {
  return { name, description, inputSchema: schema(properties, required), mutates, execute(d, p, context) {
    object(p, 'parameters')
    for (const field of Object.keys(p)) if (!Object.hasOwn(properties, field)) throw new Error(`Unknown parameter: ${field}`)
    for (const field of required) if (!Object.hasOwn(p, field)) throw new Error(`Missing parameter: ${field}`)
    const result = run(d, p, context)
    if (mutates) validateDesignSystemDocument(d)
    return copy(result)
  } }
}
const list = <T>(items: Record<string, T> | undefined) => Object.entries(items || {}).map(([id, value]) => ({ id, ...value }))

/** Document resources and authoring usage only; never enumerates OS fonts or exposes bytes. */
export function listDocumentFonts(d: DesignDocument) {
  const usage = new Map<string, { usedWeights: Set<number>; nodeIds: Set<string>; styleIds: Set<string> }>()
  const use = (id: string, weight: number, nodeId?: string, styleId?: string) => {
    const entry = usage.get(id) ?? { usedWeights: new Set<number>(), nodeIds: new Set<string>(), styleIds: new Set<string>() }
    entry.usedWeights.add(weight)
    if (nodeId) entry.nodeIds.add(nodeId)
    if (styleId) entry.styleIds.add(styleId)
    usage.set(id, entry)
  }
  const textUsage = (n: DesignNode, nodeId: string) => {
    const shared = n.styleRefs?.textStyle && d.designSystem?.styles[n.styleRefs.textStyle]
    const style = { ...defaultTextStyle(), ...n.textStyle, ...(shared && shared.kind === 'text' ? shared.value as object : {}) }
    use(style.fontId, style.weight, nodeId)
    for (const id of style.fallbacks || []) use(id, style.weight, nodeId)
    for (const run of n.textRuns || []) use(run.fontId ?? style.fontId, run.weight ?? style.weight, nodeId)
  }
  for (const n of Object.values(d.nodes)) {
    if (n.kind === 'text') textUsage(n, n.id)
    for (const fields of Object.values(n.instance?.overrides || {})) {
      if (fields.textStyle || fields.textRuns || (fields.styleRefs as Params | undefined)?.textStyle)
        textUsage({ ...n, ...fields } as DesignNode, n.id)
    }
  }
  for (const [id, s] of Object.entries(d.designSystem?.styles || {})) if (s.kind === 'text') {
    const style = { ...defaultTextStyle(), ...s.value as object }
    use(style.fontId, style.weight, undefined, id)
    for (const fallback of style.fallbacks || []) use(fallback, style.weight, undefined, id)
  }
  const all = new Set(['default', ...Object.keys(d.fonts || {}), ...usage.keys()])
  const fonts = [...all].sort().map(id => {
    const resource = d.fonts?.[id], used = usage.get(id)
    return {
      id, family: resource?.family ?? (id === 'default' ? 'Built-in default' : null),
      ...(resource?.index === undefined ? {} : { index: resource.index }),
      ...(resource?.postscript === undefined ? {} : { postscript: resource.postscript }),
      source: id === 'default' ? 'built-in' : resource ? 'embedded' : 'missing',
      usedWeights: [...(used?.usedWeights || [])].sort((a, b) => a - b),
      nodeIds: [...(used?.nodeIds || [])], styleIds: [...(used?.styleIds || [])],
    }
  })
  return {
    scope: 'document', fonts,
    limits: { maxInlineBytes: 20 * 1024 * 1024, maxFontBytes: 20 * 1024 * 1024, maxDocumentFontBytes: 24 * 1024 * 1024, maxFonts: 32 },
    missingReferences: fonts.filter(f => f.source === 'missing'),
    unresolvedSources: Object.values(d.nodes).filter(n => n.kind === 'text').flatMap(n => {
      const sourceNames = unmatchedSourceFonts(d, n)
      return sourceNames.length ? [{ nodeId: n.id, sourceNames, fallbackFontId: 'default' }] : []
    }),
    notes: ['Used weights are authored requests, not a list of supported font faces.', 'Operating-system fonts and embedding permissions are not inspected.', 'Inline imports use the bounded 32 MiB font-import transport envelope; decoded font bytes remain limited to 20 MiB.'],
  }
}

type FontFace = { index: number; family: string; style: string; postscript: string }
const FONT_BYTES = 20 * 1024 * 1024
const INLINE_FONT_BYTES = FONT_BYTES
const DOCUMENT_FONT_BYTES = 24 * 1024 * 1024
function decodeFont(data: unknown): Uint8Array {
  if (typeof data !== 'string' || !data.length || data.length > Math.ceil(FONT_BYTES / 3) * 4 || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid base64 font or font exceeds 20 MiB')
  const binary = atob(data)
  if (binary.length > FONT_BYTES) throw new Error('Font exceeds 20 MiB')
  return Uint8Array.from(binary, c => c.charCodeAt(0))
}
function inspectFont(data: unknown, indexValue: unknown = 0) {
  const bytes = decodeFont(data)
  if (!Number.isSafeInteger(indexValue) || Number(indexValue) < 0 || Number(indexValue) >= 256) throw new Error('Invalid font face index')
  const index = Number(indexValue), faces = JSON.parse(font_faces_json(bytes)) as FontFace[]
  const face = faces.find(f => f.index === index)
  if (!face) throw new Error('Font face index does not exist')
  // OS/2 fsType is at byte 8 of the selected face's OS/2 table. The existing
  // parser verifies the font itself; this bounded read only checks embedding flags.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (at: number) => { if (at < 0 || at + 2 > bytes.length) throw new Error('Truncated font table'); return view.getUint16(at) }
  const u32 = (at: number) => { if (at < 0 || at + 4 > bytes.length) throw new Error('Truncated font table'); return view.getUint32(at) }
  const offset = u32(0) === 0x74746366 ? u32(12 + index * 4) : 0
  const count = u16(offset + 4)
  let embeddingFlags: number | null = null
  if (count > 4096) throw new Error('Font table budget exceeded')
  for (let i = 0; i < count; i++) {
    const at = offset + 12 + i * 16
    if (u32(at) !== 0x4f532f32) continue
    const table = u32(at + 8), length = u32(at + 12)
    if (length < 10 || table + length > bytes.length) throw new Error('Invalid OS/2 embedding table')
    embeddingFlags = u16(table + 8)
  }
  const restricted = embeddingFlags !== null && ((embeddingFlags & 0x0002) !== 0 || (embeddingFlags & 0x0200) !== 0 || ((embeddingFlags & 0x0004) !== 0 && (embeddingFlags & 0x0008) === 0))
  return { face, faces, decodedBytes: bytes.length, embeddingFlags, restricted }
}

export const designSystemExtensions: AutomationExtension[] = [
  extension('font.list', 'List embedded and used document font metadata, requested weights, and unresolved source-font diagnostics without font bytes or OS font access.', {}, [], false, d => listDocumentFonts(d)),
  extension('font.import', 'Register caller-provided TTF/OTF/TTC bytes up to 20 MiB after exact-face parsing and embedding checks. Requires explicit embedding rights and the bounded 32 MiB transport envelope. Never reads system fonts or fetches URLs.', {
    id: str, data: { type: 'string', minLength: 1, maxLength: Math.ceil(INLINE_FONT_BYTES / 3) * 4 }, faceIndex: { type: 'integer', minimum: 0, maximum: 255 }, embeddingAllowed: { type: 'boolean', enum: [true] },
  }, ['data', 'embeddingAllowed'], true, (d, p) => {
    if (p.embeddingAllowed !== true) throw new Error('Explicit permission to embed these caller-provided font bytes is required')
    if (typeof p.data !== 'string' || p.data.length > Math.ceil(INLINE_FONT_BYTES / 3) * 4) throw new Error('Inline font import exceeds 20 MiB')
    const id = newId(d.fonts || {}, p.id)
    if (id === 'default' || new TextEncoder().encode(id).length > 128) throw new Error('Invalid font resource ID')
    if (Object.keys(d.fonts || {}).length >= 32) throw new Error('Document exceeds 32 fonts')
    const parsed = inspectFont(p.data, p.faceIndex ?? 0)
    if (parsed.decodedBytes > INLINE_FONT_BYTES) throw new Error('Inline font import exceeds 20 MiB')
    if (parsed.restricted) throw new Error('Font embedding flags prohibit editable outline embedding')
    const total = parsed.decodedBytes + Object.values(d.fonts || {}).reduce((n, f) => n + decodeFont(f.data).length, 0)
    if (total > DOCUMENT_FONT_BYTES) throw new Error('Document font resources exceed 24 MiB')
    const family = `${parsed.face.family} ${parsed.face.style}`.trim().slice(0, 200)
    if (!family) throw new Error('Font is missing a usable family identity')
    d.fonts = { ...d.fonts, [id]: { family, data: p.data as string, index: parsed.face.index, ...(parsed.face.postscript ? { postscript: parsed.face.postscript } : {}) } }
    return { id, family, index: parsed.face.index, postscript: parsed.face.postscript, decodedBytes: parsed.decodedBytes, embeddingFlags: parsed.embeddingFlags }
  }),
  extension('font.validate', 'Validate document font bytes, selected faces, and references without returning binary data. Unknown source names are reported separately from broken references.', { fontId: str }, [], false, (d, p) => {
    const selected = p.fontId === undefined ? Object.entries(d.fonts || {}) : [[key(p.fontId), resource(d.fonts, p.fontId, 'font')]] as Array<[string, NonNullable<DesignDocument['fonts']>[string]]>
    let total = 0
    const fonts = selected.map(([id, font]) => {
      try { const parsed = inspectFont(font.data, font.index ?? 0); total += parsed.decodedBytes; return { id, valid: true, ...parsed } }
      catch (error) { return { id, valid: false, error: error instanceof Error ? error.message : String(error) } }
    })
    const usage = listDocumentFonts(d)
    return { valid: fonts.every(f => f.valid) && !usage.missingReferences.length && total <= DOCUMENT_FONT_BYTES, fonts,
      decodedBytes: total, exceedsDocumentBudget: total > DOCUMENT_FONT_BYTES,
      missingReferences: usage.missingReferences, unresolvedSources: usage.unresolvedSources }
  }),
  extension('font.apply', 'Apply a document font and optional weight/spacing/direction to text layers. Mixed-run overrides are retained unless preserveRuns is false.', {
    nodeIds: ids, fontId: str, weight: { type: 'number', minimum: 1, maximum: 1000 }, letterSpacing: { type: 'number', minimum: -1000, maximum: 1000 },
    lineHeight: { type: 'number', minimum: 0.1, maximum: 10 }, direction: { enum: ['auto', 'ltr', 'rtl'] }, preserveRuns: { type: 'boolean' },
  }, ['nodeIds', 'fontId'], true, (d, p) => {
    const id = key(p.fontId, 'fontId'), selected = strings(p.nodeIds, 'nodeIds')
    if (id !== 'default') resource(d.fonts, id, 'font')
    if (p.preserveRuns !== undefined && typeof p.preserveRuns !== 'boolean') throw new Error('preserveRuns must be boolean')
    const patch: NonNullable<DesignNode['textStyle']> = { ...defaultTextStyle(), fontId: id }
    const fields: Partial<NonNullable<DesignNode['textStyle']>> = { fontId: id }
    for (const field of ['weight', 'letterSpacing', 'lineHeight'] as const) if (p[field] !== undefined) fields[field] = number(p[field], field)
    if (p.direction !== undefined) {
      if (!['auto', 'ltr', 'rtl'].includes(String(p.direction))) throw new Error('Invalid text direction')
      fields.direction = p.direction as 'auto' | 'ltr' | 'rtl'
    }
    for (const nodeId of selected) {
      const n = requiredNode(d, nodeId)
      if (n.kind !== 'text') throw new Error('Font application requires text layers')
      if (p.preserveRuns === false) applyWholeTextStyle(n, fields)
      else n.textStyle = { ...patch, ...n.textStyle, ...fields }
      // An explicit edit replaces a shared typography reference, as the inspector does.
      delete n.styleRefs?.textStyle
      validateSample(d, n)
    }
    return { nodeIds: selected, fontId: id }
  }),
  extension('component.declareSlot', 'Declare a named free-content slot on a main component container; its current children remain fallback.', { nodeId: str, name: str, slotId: str }, ['nodeId', 'name'], true, (d, p) => ComponentSlots.declareSlot(d, key(p.nodeId), key(p.name, 'name', 128), p.slotId === undefined ? undefined : key(p.slotId))),
  extension('component.removeSlot', 'Remove a slot declaration only after assigned instances are reset or detached.', { componentId: str, slotId: str }, ['componentId', 'slotId'], true, (d, p) => ComponentSlots.removeSlot(d, key(p.componentId), key(p.slotId))),
  extension('component.assignSlot', 'Move authored subtree roots into an instance slot; [] empties it, null restores fallback. Replaced content is retained on its page.', { nodeId: str, slotId: str, nodeIds: { anyOf: [{ type: 'array', items: str }, { type: 'null' }] } }, ['nodeId', 'slotId', 'nodeIds'], true, (d, p) => {
    if (p.nodeIds !== null && !Array.isArray(p.nodeIds)) throw new Error('nodeIds must be an array or null')
    return ComponentSlots.assignSlot(d, key(p.nodeId), key(p.slotId), p.nodeIds === null ? null : (p.nodeIds as unknown[]).map(id => key(id)))
  }),
  extension('component.list', 'List local main components and component sets.', {}, [], false, d => Object.values(d.nodes).filter(n => n.component || n.componentSet).map(n => ({ id: n.id, name: n.name, componentSet: !!n.componentSet, variants: n.component?.variants, properties: n.component?.properties, slots: n.component?.slots }))),
  extension('component.get', 'Read a main component, its template keys, and instance IDs.', { componentId: str }, ['componentId'], false, (d, p) => {
    const n = component(d, p.componentId)
    return { ...n, template: Object.fromEntries(template(d, n.id)), instanceIds: Object.values(d.nodes).filter(i => i.instance?.componentId === n.id).map(i => i.id) }
  }),
  extension('component.create', 'Convert sibling layers into a main component.', { nodeIds: ids, pageId: str, name: str }, ['nodeIds'], true, (d, p, c) => {
    const selected = strings(p.nodeIds, 'nodeIds'), pageId = page(d, p, c)
    for (const id of selected) { requiredNode(d, id); assertStructureUnlocked(d, id); if (pageOf(d, id) !== pageId) throw new Error('Selected node is on another page') }
    const id = Components.createMain(d, selected, pageId)
    if (p.name !== undefined) d.nodes[id].name = key(p.name, 'name', 200)
    return created(c, id)
  }),
  extension('component.instantiate', 'Insert a local component instance at a document-space position.', { componentId: str, pageId: str, parentId: str, x: { type: 'number' }, y: { type: 'number' } }, ['componentId'], true, (d, p, c) => {
    const source = component(d, p.componentId), pageId = page(d, p, c)
    const parent = p.parentId === undefined ? undefined : requiredNode(d, p.parentId)
    if (parent && (!container(parent) || parent.componentSet || Components.instanceOwner(d, parent.id) || pageOf(d, parent.id) !== pageId)) throw new Error('Invalid instance parent')
    if (parent) assertStructureUnlocked(d, parent.id)
    return created(c, Components.insertInstance(d, source.id, pageId, { x: number(p.x ?? 0, 'x'), y: number(p.y ?? 0, 'y') }, parent?.id))
  }),
  extension('component.detach', 'Detach a resolved outer instance while preserving its appearance.', { nodeId: str }, ['nodeId'], true, (d, p) => {
    const n = instance(d, p.nodeId), source = component(d, n.instance!.componentId)
    assertStructureUnlocked(d, n.id)
    if (source.children.length && !n.children.length) throw new Error('Instance must be resolved before detach; commit its creation first')
    Components.detach(d, n.id)
    return { id: n.id }
  }),
  extension('component.swap', 'Swap an instance using existing semantic override/property remapping.', { nodeId: str, componentId: str }, ['nodeId', 'componentId'], true, (d, p) => {
    const n = instance(d, p.nodeId), target = component(d, p.componentId)
    assertStructureUnlocked(d, n.id)
    Components.swapInstance(d, n.id, target.id); return { id: n.id, componentId: target.id }
  }),
  extension('component.reset', 'Reset an instance or generated descendant to its component defaults.', { nodeId: str }, ['nodeId'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId)
    if (!Components.instanceOwner(d, n.id)) throw new Error('Node does not belong to an instance')
    Components.resetInstance(d, n.id); return { id: n.id }
  }),
  extension('component.setOverride', 'Set validated nonstructural fields for an instance template key.', { nodeId: str, targetKey: str, values: obj }, ['nodeId', 'targetKey', 'values'], true, (d, p) => {
    const n = instance(d, p.nodeId), path = key(p.targetKey, 'targetKey'), values = object(p.values, 'values')
    if (n.instanceOrigin) throw new Error('Set overrides on the outer owning instance')
    validateOverride(d, n, path, values)
    Components.setOverride(d, n.id, path, values); return { id: n.id, targetKey: path }
  }),
  extension('component.clearOverride', 'Remove selected fields or all overrides for a template key.', { nodeId: str, targetKey: str, fields: ids }, ['nodeId', 'targetKey'], true, (d, p) => {
    const n = instance(d, p.nodeId), path = key(p.targetKey, 'targetKey')
    if (n.instanceOrigin) throw new Error('Clear overrides on the outer owning instance')
    overrideTarget(d, n, path)
    if (p.fields === undefined) delete n.instance!.overrides[path]
    else for (const field of strings(p.fields, 'fields')) {
      if (!(Components.overrideFields as readonly string[]).includes(field) && !['swapComponent', 'propertyValues'].includes(field)) throw new Error('Unsupported override field')
      delete n.instance!.overrides[path]?.[field]
    }
    return { id: n.id, targetKey: path }
  }),
  extension('component.defineProperty', 'Expose a text, boolean, or instance-swap property on a main component child.', { nodeId: str, kind: { enum: ['text', 'boolean', 'instance-swap'] }, name: str }, ['nodeId', 'kind', 'name'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), owner = Components.definitionOwner(d, n.id)
    if (!owner || !['text', 'boolean', 'instance-swap'].includes(String(p.kind))) throw new Error('Invalid component property target or kind')
    if (p.kind === 'text' && n.kind !== 'text') throw new Error('Text properties require a text layer')
    const before = new Set(Object.keys(d.nodes[owner].component!.properties))
    Components.defineProperty(d, n.id, p.kind as ComponentProperty['kind'], key(p.name, 'name', 128))
    return { componentId: owner, propertyId: Object.keys(d.nodes[owner].component!.properties).find(id => !before.has(id)) }
  }),
  extension('component.updateProperty', 'Rename a property or change its validated default value.', { componentId: str, propertyId: str, name: str, defaultValue: {} }, ['componentId', 'propertyId'], true, (d, p) => {
    const n = component(d, p.componentId), property = resource(n.component!.properties, p.propertyId, 'property')
    if (p.name !== undefined) property.name = key(p.name, 'name', 128)
    if (Object.hasOwn(p, 'defaultValue')) property.defaultValue = propertyValue(d, property, p.defaultValue)
    return { componentId: n.id, propertyId: p.propertyId }
  }),
  extension('component.setProperty', 'Set a typed instance property, including nested-instance property overrides.', { nodeId: str, propertyId: str, value: {} }, ['nodeId', 'propertyId', 'value'], true, (d, p) => {
    const n = instance(d, p.nodeId), source = component(d, n.instance!.componentId), id = key(p.propertyId, 'propertyId')
    const property = resource(source.component!.properties, id, 'property')
    Components.setProperty(d, n.id, id, propertyValue(d, property, p.value)); return { id: n.id, propertyId: id }
  }),
  extension('component.combineVariants', 'Combine sibling main components into a variant set.', { componentIds: ids, pageId: str, name: str }, ['componentIds'], true, (d, p, c) => {
    const selected = strings(p.componentIds, 'componentIds'), pageId = page(d, p, c)
    for (const id of selected) { component(d, id); assertStructureUnlocked(d, id); if (pageOf(d, id) !== pageId) throw new Error('Component is on another page') }
    const id = Components.variantSet(d, selected, pageId)
    if (p.name !== undefined) d.nodes[id].name = key(p.name, 'name', 200)
    return created(c, id)
  }),
  extension('component.addVariant', 'Clone a main component into a new unique variant.', { componentId: str }, ['componentId'], true, (d, p, c) => {
    const n = component(d, p.componentId)
    assertStructureUnlocked(d, n.id)
    return created(c, Components.addVariant(d, n.id, pageOf(d, n.id)))
  }),
  extension('component.setVariants', 'Set variant axis values; component-set combinations must remain unique.', { componentId: str, variants: obj }, ['componentId', 'variants'], true, (d, p) => {
    const n = component(d, p.componentId); n.component!.variants = record(p.variants, 'variants'); return { id: n.id }
  }),
  extension('component.addVariantAxis', 'Add a variant axis to every member of a component set.', { setId: str, name: str, defaultValue: str }, ['setId', 'name'], true, (d, p) => {
    const set = requiredNode(d, p.setId), name = key(p.name, 'axis name', 128), value = key(p.defaultValue ?? 'Default', 'axis value', 128)
    if (!set.componentSet) throw new Error('Node is not a component set')
    assertStructureUnlocked(d, set.id)
    for (const id of set.children) assertStructureUnlocked(d, id)
    for (const id of set.children) {
      const variants = component(d, id).component!.variants
      if (Object.hasOwn(variants, name)) throw new Error('Variant axis already exists')
      variants[name] = value
    }
    return { id: set.id, axis: name }
  }),
  extension('component.switchVariant', 'Choose an instance variant while preserving matching other axes and overrides.', { nodeId: str, axis: str, value: str }, ['nodeId', 'axis', 'value'], true, (d, p) => {
    const n = instance(d, p.nodeId)
    assertStructureUnlocked(d, n.id)
    Components.switchVariant(d, n.id, key(p.axis, 'axis', 128), key(p.value, 'value', 128)); return { id: n.id }
  }),
  extension('collection.list', 'List local variable collections and active modes.', {}, [], false, d => list(d.designSystem?.collections).map(c => ({ ...c, activeMode: d.designSystem?.activeModes[c.id] ?? c.defaultMode }))),
  extension('collection.create', 'Create a variable collection with unique named modes.', { id: str, name: str, modes: ids, defaultMode: str }, ['name'], true, (d, p) => {
    const s = system(d), id = newId(s.collections, p.id), modes = strings(p.modes ?? ['Default'], 'modes'), defaultMode = key(p.defaultMode ?? modes[0], 'defaultMode')
    s.collections[id] = { name: key(p.name, 'name', 512), modes, defaultMode }; s.activeModes[id] = defaultMode
    return { id }
  }),
  extension('collection.update', 'Rename a variable collection or change its default mode.', { collectionId: str, name: str, defaultMode: str }, ['collectionId'], true, (d, p) => {
    const c = resource(d.designSystem?.collections, p.collectionId, 'collection')
    if (p.name !== undefined) c.name = key(p.name, 'name', 512)
    if (p.defaultMode !== undefined) c.defaultMode = key(p.defaultMode, 'defaultMode')
    return { id: p.collectionId }
  }),
  extension('collection.delete', 'Delete an empty, unreferenced variable collection.', { collectionId: str }, ['collectionId'], true, (d, p) => {
    const id = key(p.collectionId, 'collectionId'), s = d.designSystem!
    resource(s?.collections, id, 'collection')
    if (Object.values(s.variables).some(v => v.collection === id) || Object.values(d.nodes).some(n => bindings(n).some(r => Object.hasOwn(r.variableModes || {}, id)))) throw new Error('Collection is still referenced')
    delete s.collections[id]; delete s.activeModes[id]; return { id }
  }),
  extension('collection.addMode', 'Add a mode, copying each variable value from an existing mode.', { collectionId: str, mode: str, copyFrom: str }, ['collectionId', 'mode'], true, (d, p) => {
    const id = key(p.collectionId), c = resource(d.designSystem?.collections, id, 'collection'), mode = key(p.mode, 'mode'), from = key(p.copyFrom ?? c.defaultMode, 'copyFrom')
    if (c.modes.includes(mode) || !c.modes.includes(from)) throw new Error('Duplicate mode or unknown source mode')
    c.modes.push(mode)
    for (const v of Object.values(d.designSystem!.variables)) if (v.collection === id) v.values[mode] = copy(v.values[from])
    return { collectionId: id, mode }
  }),
  extension('collection.renameMode', 'Rename a mode and all variable, active, instance-local, and prototype-action references.', { collectionId: str, mode: str, name: str }, ['collectionId', 'mode', 'name'], true, (d, p) => {
    const id = key(p.collectionId), c = resource(d.designSystem?.collections, id, 'collection'), mode = key(p.mode, 'mode'), name = key(p.name, 'name')
    if (!c.modes.includes(mode) || c.modes.includes(name)) throw new Error('Unknown source mode or duplicate destination mode')
    c.modes = c.modes.map(m => m === mode ? name : m)
    if (c.defaultMode === mode) c.defaultMode = name
    if (d.designSystem!.activeModes[id] === mode) d.designSystem!.activeModes[id] = name
    for (const v of Object.values(d.designSystem!.variables)) if (v.collection === id) { v.values[name] = v.values[mode]; delete v.values[mode] }
    remapVariableModeReferences(d, id, mode, name)
    return { collectionId: id, mode: name }
  }),
  extension('collection.deleteMode', 'Delete a nondefault mode; active and local references must first be changed.', { collectionId: str, mode: str }, ['collectionId', 'mode'], true, (d, p) => {
    const id = key(p.collectionId), c = resource(d.designSystem?.collections, id, 'collection'), mode = key(p.mode, 'mode')
    if (!c.modes.includes(mode)) throw new Error('Unknown mode')
    if (prototypeUsesMode(d, id, mode)) throw new Error('Mode is referenced by a prototype action; update or remove that action first')
    if (c.defaultMode === mode || d.designSystem!.activeModes[id] === mode || Object.values(d.nodes).some(n => bindings(n).some(r => r.variableModes?.[id] === mode))) throw new Error('Mode is still referenced or is the default')
    c.modes = c.modes.filter(m => m !== mode)
    for (const v of Object.values(d.designSystem!.variables)) if (v.collection === id) delete v.values[mode]
    return { collectionId: id, mode }
  }),
  extension('collection.setActiveMode', 'Set the document-wide active variable mode.', { collectionId: str, mode: str }, ['collectionId', 'mode'], true, (d, p) => {
    const id = key(p.collectionId), mode = key(p.mode, 'mode'); setVariableMode(d, id, mode); return { collectionId: id, mode }
  }),
  extension('collection.setNodeMode', 'Set an effective local mode, or null to inherit, including replacing root overrides.', { nodeId: str, collectionId: str, mode: nullableStr }, ['nodeId', 'collectionId', 'mode'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), id = key(p.collectionId); resource(d.designSystem?.collections, id, 'collection')
    setEffectiveNodeVariableMode(d, n.id, id, p.mode === null ? undefined : key(p.mode, 'mode')); return { id: n.id }
  }),
  extension('variable.list', 'List local variables, optionally within one collection.', { collectionId: str }, [], false, (d, p) => {
    if (p.collectionId !== undefined) resource(d.designSystem?.collections, p.collectionId, 'collection')
    return list(d.designSystem?.variables).filter(v => p.collectionId === undefined || v.collection === p.collectionId)
  }),
  extension('variable.get', 'Read a local variable and its mode values.', { variableId: str }, ['variableId'], false, (d, p) => ({ id: p.variableId, ...resource(d.designSystem?.variables, p.variableId, 'variable') })),
  extension('variable.create', 'Create a typed variable with a value for every collection mode.', { id: str, name: str, collectionId: str, kind: { enum: ['color', 'number', 'boolean', 'string'] }, values: obj }, ['name', 'collectionId', 'kind', 'values'], true, (d, p) => {
    const s = system(d), id = newId(s.variables, p.id), collectionId = key(p.collectionId); resource(s.collections, collectionId, 'collection')
    s.variables[id] = { name: key(p.name, 'name', 512), collection: collectionId, kind: p.kind as Variable['kind'], values: copy(object(p.values, 'values')) as Variable['values'] }
    return { id }
  }),
  extension('variable.update', 'Rename a local variable without changing its identity or kind.', { variableId: str, name: str }, ['variableId', 'name'], true, (d, p) => {
    resource(d.designSystem?.variables, p.variableId, 'variable').name = key(p.name, 'name', 512); return { id: p.variableId }
  }),
  extension('variable.setValue', 'Set one typed mode value or a compatible alias; cycles are rejected.', { variableId: str, mode: str, value: {} }, ['variableId', 'mode', 'value'], true, (d, p) => {
    const v = resource(d.designSystem?.variables, p.variableId, 'variable'), mode = key(p.mode, 'mode'), c = resource(d.designSystem?.collections, v.collection, 'collection')
    if (!c.modes.includes(mode)) throw new Error('Unknown variable mode')
    validateVariableValue(d, v, p.value); v.values[mode] = copy(p.value); return { id: p.variableId, mode }
  }),
  extension('variable.delete', 'Delete an unbound variable with no alias references.', { variableId: str }, ['variableId'], true, (d, p) => {
    const id = key(p.variableId); resource(d.designSystem?.variables, id, 'variable')
    if (prototypeUsesVariable(d, id)) throw new Error('Variable is referenced by a prototype action or condition; update or remove it first')
    if (Object.values(d.designSystem!.variables).some(v => Object.values(v.values).some(value => typeof value === 'object' && value.alias === id)) || Object.values(d.nodes).some(n => bindings(n).some(r => Object.values(r.bindings || {}).includes(id)))) throw new Error('Variable is still referenced')
    delete d.designSystem!.variables[id]; return { id }
  }),
  extension('variable.bind', 'Bind a supported node property to a compatible local variable.', { nodeId: str, path: str, variableId: str }, ['nodeId', 'path', 'variableId'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), path = key(p.path, 'path'), id = key(p.variableId), v = resource(d.designSystem?.variables, id, 'variable')
    if (v.kind !== variableKindForPath(path)) throw new Error('Variable/property type mismatch')
    if (path.startsWith('layout.') && !n.layout) throw new Error('Binding requires an existing layout')
    if (path.startsWith('textStyle.') && n.kind !== 'text') throw new Error('Text-style binding requires a text node')
    if (path.startsWith('textStyle.') && !n.textStyle) n.textStyle = defaultTextStyle()
    if (path.startsWith('fills.')) {
      const index = Number(path.split('.')[1]), style = n.styleRefs?.fills ? resource(d.designSystem?.styles, n.styleRefs.fills, 'style') : undefined
      const fills = style?.kind === 'paint' ? style.value : n.fills
      if (!Array.isArray(fills) || !fills[index]) throw new Error('Binding fill index does not exist')
    }
    n.bindings = { ...n.bindings, [path]: id }; return { id: n.id, path, variableId: id }
  }),
  extension('variable.unbind', 'Remove one supported node variable binding.', { nodeId: str, path: str }, ['nodeId', 'path'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), path = key(p.path, 'path'); variableKindForPath(path)
    delete n.bindings?.[path]; return { id: n.id, path }
  }),
  extension('variable.resolve', 'Resolve a variable using document modes, inherited node modes, or explicit modes.', { variableId: str, nodeId: str, modes: obj }, ['variableId'], false, (d, p) => {
    const id = key(p.variableId); resource(d.designSystem?.variables, id, 'variable')
    const modes = { ...d.designSystem!.activeModes }
    if (p.nodeId !== undefined) {
      const n = requiredNode(d, p.nodeId), parents = allParents(d), chain: DesignNode[] = [n]
      let at = parents.get(n.id)
      while (at && d.nodes[at]) { chain.unshift(d.nodes[at]); at = parents.get(at) }
      for (const n of chain) {
        const replacing = n.instance && !n.instanceOrigin && Object.hasOwn(n.instance.overrides.$root || {}, 'variableModes')
        if (replacing) Object.assign(modes, n.instance!.overrides.$root.variableModes)
        else {
          if (n.instance && !n.instanceOrigin) Object.assign(modes, d.nodes[n.instance.componentId]?.variableModes)
          Object.assign(modes, n.variableModes)
        }
      }
    }
    if (p.modes !== undefined) Object.assign(modes, record(p.modes, 'modes'))
    for (const [collectionId, mode] of Object.entries(modes)) if (!resource(d.designSystem?.collections, collectionId, 'collection').modes.includes(mode)) throw new Error('Unknown resolution mode')
    return { id, value: variableValue(d.designSystem!, id, modes), modes }
  }),
  extension('style.list', 'List local shared paint, text, and effect styles.', { kind: { enum: ['paint', 'text', 'effect'] } }, [], false, (d, p) => {
    if (p.kind !== undefined && !['paint', 'text', 'effect'].includes(String(p.kind))) throw new Error('Unknown style kind')
    return list(d.designSystem?.styles).filter(s => p.kind === undefined || s.kind === p.kind)
  }),
  extension('style.get', 'Read a local shared style.', { styleId: str }, ['styleId'], false, (d, p) => ({ id: p.styleId, ...resource(d.designSystem?.styles, p.styleId, 'style') })),
  extension('style.create', 'Create a local paint, text, or effect style; this does not publish a cloud library.', { id: str, name: str, kind: { enum: ['paint', 'text', 'effect'] }, value: {}, strokes: { type: 'array' }, effects: { type: 'array' } }, ['name', 'kind', 'value'], true, (d, p) => {
    const s = system(d), id = newId(s.styles, p.id), style = { name: key(p.name, 'name', 512), kind: p.kind, value: copy(p.value) } as Style
    if (p.strokes !== undefined) style.strokes = copy(p.strokes) as Style['strokes']
    if (p.effects !== undefined) style.effects = copy(p.effects) as Style['effects']
    if (style.strokes?.length || style.effects?.length) d.schemaVersion = Math.max(d.schemaVersion, 12) as DesignDocument['schemaVersion']
    s.styles[id] = style; return { id }
  }),
  extension('style.update', 'Update a local shared style while preserving its kind and references.', { styleId: str, name: str, value: {}, strokes: { type: 'array' }, effects: { type: 'array' } }, ['styleId'], true, (d, p) => {
    const s = resource(d.designSystem?.styles, p.styleId, 'style')
    if (p.name !== undefined) s.name = key(p.name, 'name', 512)
    if (Object.hasOwn(p, 'value')) s.value = copy(p.value)
    if (p.strokes !== undefined) s.strokes = copy(p.strokes) as Style['strokes']
    if (p.effects !== undefined) s.effects = copy(p.effects) as Style['effects']
    if (s.strokes?.length || s.effects?.length) d.schemaVersion = Math.max(d.schemaVersion, 12) as DesignDocument['schemaVersion']
    return { id: p.styleId }
  }),
  extension('style.delete', 'Delete a style only after every node and override reference has been removed.', { styleId: str }, ['styleId'], true, (d, p) => {
    const id = key(p.styleId); resource(d.designSystem?.styles, id, 'style')
    if (Object.values(d.nodes).some(n => bindings(n).some(r => Object.values(r.styleRefs || {}).includes(id)))) throw new Error('Style is still referenced')
    delete d.designSystem!.styles[id]; return { id }
  }),
  extension('style.apply', 'Apply a compatible shared style to a node.', { nodeId: str, field: { enum: ['fills', 'textStyle', 'effects'] }, styleId: str }, ['nodeId', 'field', 'styleId'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), field = styleField(p.field), id = key(p.styleId), s = resource(d.designSystem?.styles, id, 'style')
    if (s.kind !== styleFields[field] || (field === 'textStyle' && n.kind !== 'text')) throw new Error('Style/property type mismatch')
    n.styleRefs = { ...n.styleRefs, [field]: id }; return { id: n.id, field, styleId: id }
  }),
  extension('style.unapply', 'Remove a shared style reference while retaining currently resolved node values.', { nodeId: str, field: { enum: ['fills', 'textStyle', 'effects'] } }, ['nodeId', 'field'], true, (d, p) => {
    const n = requiredNode(d, p.nodeId), field = styleField(p.field); delete n.styleRefs?.[field]; return { id: n.id, field }
  }),
]

/** Standalone immutable helper. Shared API uses the same extension on its atomic draft. */
export function applyDesignSystemOperation(document: DesignDocument, operation: string, params: Params, context?: Partial<AutomationContext>) {
  const extension = designSystemExtensions.find(e => e.name === operation)
  if (!extension) throw new Error(`Unknown design-system operation: ${operation}`)
  const next = copy(document), c: AutomationContext = { pageId: context?.pageId ?? next.pages[0].id, selection: [...(context?.selection || [])], createdIds: [] }
  const result = extension.execute(next, copy(params), c)
  if (extension.mutates) {
    validateDocument(next)
    validateDesignSystemDocument(next)
  }
  return { document: next, result, createdIds: c.createdIds }
}
