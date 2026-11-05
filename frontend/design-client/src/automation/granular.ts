/** Small authored edits. No renderer, kernel session, network or second history.
 * Nested objects are merged only at explicit schema-approved leaves. */
import { blendModes, type DesignDocument, type DesignNode, type TextRun } from '../model'
import { allParents } from '../geometry'
import { equalValue } from '../document-patch'
import { replaceTextRange, styleTextRange } from '../text'
import { AutomationError, type AutomationExtension } from './types'

type Obj = Record<string, unknown>
const number = (minimum = -1e7, maximum = 1e7) => ({ type: 'number', minimum, maximum })
const bool = { type: 'boolean' }, id = { type: 'string', minLength: 1, maxLength: 128 }
const enumeration = (...values: string[]) => ({ enum: values })
const object = (properties: Obj, required: string[] = [], nonempty = false) => ({ type: 'object', properties, required, additionalProperties: false, ...(nonempty ? { minProperties: 1 } : {}) })
const partial = (properties: Obj) => object(properties, [], true)
const transformKeys = ['a', 'b', 'c', 'd', 'x', 'y']
const cornerKeys = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']
const sideKeys = ['top', 'right', 'bottom', 'left']
const transform = partial(Object.fromEntries(transformKeys.map(key => [key, number()])))
const corners = partial(Object.fromEntries(cornerKeys.map(key => [key, number(0)])))
const sides = partial(Object.fromEntries(sideKeys.map(key => [key, number(0, 1e5)])))
const alignment = enumeration('start', 'center', 'end', 'stretch')
const layout = partial({ mode: enumeration('none', 'horizontal', 'vertical', 'grid'), gap: number(0, 1e5), lineGap: number(0, 1e5), padding: sides,
  wrap: bool, justify: enumeration('start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly', 'unsafe-center', 'unsafe-end'), align: enumeration('start','center','end','stretch','unsafe-center','unsafe-end'),
  columns: { type: 'integer', minimum: 1, maximum: 64 }, fillRows: bool })
const sizing = partial({ width: enumeration('fixed', 'hug', 'fill'), height: enumeration('fixed', 'hug', 'fill'),
  minWidth: number(.01), minHeight: number(.01), maxWidth: number(.01), maxHeight: number(.01), absolute: bool,
  alignSelf: { anyOf: [alignment, { type: 'null' }] }, columnSpan: { type: 'integer', minimum: 1, maximum: 64 }, rowSpan: { type: 'integer', minimum: 1, maximum: 64 } })
const anchor = enumeration('start', 'center', 'end', 'stretch', 'scale')
const constraints = partial({ horizontal: anchor, vertical: anchor, referenceWidth: { anyOf: [number(0), { type: 'null' }] }, referenceHeight: { anyOf: [number(0), { type: 'null' }] } })
const textStyle = partial({ fontId: id, weight: number(1, 1000), lineHeight: number(0, 100), letterSpacing: number(), wrap: bool,
  align: enumeration('start', 'center', 'end', 'justify'), direction: enumeration('auto', 'ltr', 'rtl'), textCase: enumeration('original', 'upper', 'lower'),
  paragraphSpacing: number(0), paragraphIndent: number(), writingMode: enumeration('horizontal', 'vertical') })
export const nodePatchSchema = partial({ name: { type: 'string', maxLength: 200 }, width: number(.01), height: number(.01),
  visible: bool, locked: bool, opacity: number(0, 1), blend: enumeration(...blendModes, 'pass-through'), clip: bool, mask: bool,
  maskType: enumeration('alpha', 'luminance', 'outline', 'shape'), smoothing: number(0, 1), cornerRadius: number(0), constrainProportions: bool,
  points: { type: 'integer', minimum: 3, maximum: 128 }, innerRadius: number(.01, 1), fontSize: number(1, 4096),
  transform, radii: corners, layout, sizing, constraints, textStyle })
const layoutPatch = partial({ layout, sizing, constraints })
const ids = { type: 'array', items: id, minItems: 1, maxItems: 1000, uniqueItems: true }
const paintPatch = partial({ color: { type: 'string', minLength: 1, maxLength: 512 }, opacity: number(0, 1), visible: bool,
  angle: number(), blend: enumeration(...blendModes), fit: enumeration('cover', 'contain', 'stretch'), transform })
const rangePatch = partial({ fontId: id, fontSize: number(1, 4096), weight: number(1, 1000), color: { type: 'string', minLength: 1, maxLength: 512 },
  underline: bool, strikethrough: bool, link: { type: 'string', maxLength: 4096 }, textCase: enumeration('original', 'upper', 'lower') })
const err = (code: string, message: string, details?: unknown): never => { throw new AutomationError(code, message, details) }
function requiredNode(doc: DesignDocument, id: unknown): DesignNode {
  if (typeof id !== 'string' || !Object.hasOwn(doc.nodes, id)) return err('not_found', `Node ${String(id)} does not exist`)
  return doc.nodes[id]
}
function unlocked(doc: DesignDocument, n: DesignNode, ownUnlock = false) {
  const parents = allParents(doc)
  let id: string | undefined = n.id
  while (id && doc.nodes[id]) {
    if (doc.nodes[id].locked && !(id === n.id && ownUnlock)) err('locked_node', `Node ${id} is locked`)
    id = parents.get(id)
  }
}
/** Named tuple leaves keep both array order and all unspecified coordinates. */
function tupleKeys(path: string): string[] | undefined {
  return path === 'transform' ? transformKeys : path === 'radii' ? cornerKeys : path === 'layout.padding' ? sideKeys : undefined
}
function leafEntries(value: Obj, prefix = ''): [string, unknown][] {
  return Object.entries(value).flatMap(([key, value]): [string, unknown][] => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === 'object' && !Array.isArray(value) ? leafEntries(value as Obj, path) : [[path, value]]
  })
}
function valueAt(target: Obj, path: string): unknown {
  const keys = path.split('.'); let current: unknown = target, prefix = ''
  for (const key of keys) {
    const names = tupleKeys(prefix), index = names?.indexOf(key)
    current = current && typeof current === 'object' ? (current as Obj)[index === undefined ? key : String(index)] : undefined
    prefix = prefix ? `${prefix}.${key}` : key
  }
  return current
}
function expectLeaves(target: Obj, expected?: Obj) {
  for (const [path, wanted] of leafEntries(expected || {})) if (!equalValue(valueAt(target, path), wanted))
    err('value_conflict', `Expected value no longer matches ${path}`, { path })
}
function mergeLeaves(target: Obj, patch: Obj, prefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const names = tupleKeys(path)
      if (names) {
        if (!Array.isArray(target[key]) || (target[key] as unknown[]).length !== names.length) err('missing_facet', `${path} must exist before a partial edit`)
        const copy = [...target[key] as unknown[]]
        for (const [name, entry] of Object.entries(value as Obj)) copy[names.indexOf(name)] = entry
        target[key] = copy
      } else {
        if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) err('missing_facet', `${path} must exist before a partial edit; initialize it with the dedicated set operation`)
        mergeLeaves(target[key] as Obj, value as Obj, path)
      }
    } else target[key] = value
  }
}
function unbound(doc: DesignDocument, n: DesignNode, paths: string[]) {
  const fillStyle = n.styleRefs?.fills ? doc.designSystem?.styles[n.styleRefs.fills] : undefined
  for (const path of paths) {
    if (Object.keys(n.bindings || {}).some(binding => binding === path || binding.startsWith(`${path}.`) || path.startsWith(`${binding}.`)))
      err('bound_property', `${path} is variable-bound; unbind it explicitly before editing its authored value`)
    if (Object.keys(n.styleRefs || {}).some(field => field === path || path.startsWith(`${field}.`)) ||
      fillStyle?.kind === 'paint' && !!fillStyle.strokes?.length && path.startsWith('strokes.'))
      err('shared_style_property', `${path} is controlled by a shared style; unapply that style explicitly first`)
  }
}
/** Caller schemas are checked by the shared registry before this trusted helper. */
function patchNode(doc: DesignDocument, n: DesignNode, patch: Obj, expected?: Obj) {
  unlocked(doc, n, Object.keys(patch).length === 1 && patch.locked === false)
  expectLeaves(n as unknown as Obj, expected)
  unbound(doc, n, leafEntries(patch).map(([path]) => path))
  if ('points' in patch && !['polygon', 'star'].includes(n.kind)) err('invalid_kind', 'points requires a polygon or star')
  if ('innerRadius' in patch && n.kind !== 'star') err('invalid_kind', 'innerRadius requires a star; ellipse arcs use their dedicated model')
  if ('cornerRadius' in patch && (!['polygon', 'star'].includes(n.kind) || n.network)) err('invalid_kind', 'cornerRadius requires a polygon or star without an authored network')
  if (('textStyle' in patch || 'fontSize' in patch) && n.kind !== 'text') err('invalid_kind', 'Typography edits require a text node')
  if ('transform' in patch && Object.keys(patch.transform as Obj).some(key => key === 'x' || key === 'y')) {
    const parent = doc.nodes[allParents(doc).get(n.id) || '']
    if (parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute) err('auto_layout_position', 'Change flow spacing or child sizing instead of a layout-controlled position')
  }
  mergeLeaves(n as unknown as Obj, patch)
}
function op(name: string, description: string, properties: Obj, required: string[], execute: AutomationExtension['execute']): AutomationExtension {
  return { name, description, inputSchema: object(properties, required), mutates: true, execute }
}
const editNodes: AutomationExtension['execute'] = (doc, p) => {
  for (const id of p.ids as string[]) patchNode(doc, requiredNode(doc, id), p.patch as Obj, p.expected as Obj | undefined)
  return { ids: p.ids }
}
export const granularExtensions: AutomationExtension[] = [
  op('node.patch', 'Patch only named scalar or nested leaves on explicit nodes, preserving all omitted values. Transform uses a/b/c/d/x/y; radii uses topLeft/topRight/bottomRight/bottomLeft. Existing layout/sizing/constraints/textStyle facets are required. Native instance override capture applies. Optional expected leaves reject conflicting values.',
    { ids, patch: nodePatchSchema, expected: nodePatchSchema }, ['ids', 'patch'], editNodes),
  op('layout.patch', 'Patch existing layout, sizing or constraints without replacing their other values. Padding uses top/right/bottom/left. Derived layout is resolved by the real editor on commit.',
    { ids, patch: layoutPatch, expected: layoutPatch }, ['ids', 'patch'], editNodes),
  op('paint.patch', 'Patch one existing fill or stroke paint by stable paint ID. Leaves every other paint, gradient stop, image byte and stroke setting unchanged. Does not change paint kind or ID. fit requires image; angle requires gradient; transform requires non-solid. Color is authored data and may not affect pixels for every paint kind. An existing transform is required to patch its coordinates.',
    { ids, target: enumeration('fill', 'stroke'), paintId: id, patch: paintPatch, expected: paintPatch }, ['ids', 'target', 'paintId', 'patch'], (doc, p) => {
      for (const id of p.ids as string[]) {
        const n = requiredNode(doc, id); unlocked(doc, n)
        const stack = p.target === 'fill' ? n.fills : n.strokes.map(stroke => stroke.paint)
        const matches = stack.filter(paint => paint.id === p.paintId)
        if (matches.length !== 1) err('not_found', 'paintId must identify exactly one paint on each target node')
        const paint = matches[0], patch = p.patch as Obj
        if ('fit' in patch && paint.kind !== 'image') err('invalid_kind', 'fit requires an image paint')
        if ('transform' in patch && paint.kind === 'solid') err('invalid_kind', 'Paint transforms require an image or gradient paint')
        if ('angle' in patch && !['linear', 'radial', 'angular', 'diamond'].includes(paint.kind)) err('invalid_kind', 'angle requires a gradient paint')
        const index = stack.indexOf(paint), prefix = p.target === 'fill' ? `fills.${index}` : `strokes.${index}.paint`
        unbound(doc, n, leafEntries(p.patch as Obj).map(([path]) => `${prefix}.${path}`))
        expectLeaves(paint as unknown as Obj, p.expected as Obj | undefined)
        mergeLeaves(paint as unknown as Obj, p.patch as Obj)
      }
      return { ids: p.ids, target: p.target, paintId: p.paintId }
    }),
  op('text.styleRange', 'Style a half-open UTF-16 range [start,end) using the editor rich-text helper. Both offsets must be complete grapheme boundaries. Preserves characters and styles outside the range. expectedText, when provided, must match exactly the selected substring. Supported run attributes only; no paragraph formatting.',
    { nodeId: id, start: { type: 'integer', minimum: 0, maximum: 100000 }, end: { type: 'integer', minimum: 1, maximum: 100000 }, patch: rangePatch,
      expectedText: { type: 'string', maxLength: 100000 } }, ['nodeId', 'start', 'end', 'patch'], (doc, p) => {
      const n = requiredNode(doc, p.nodeId); unlocked(doc, n)
      if (n.kind !== 'text') err('invalid_kind', 'Range styling requires a text node')
      const start = p.start as number, end = p.end as number
      if (p.expectedText !== undefined && n.text.slice(start, end) !== p.expectedText) err('value_conflict', 'Expected range text no longer matches')
      try { styleTextRange(n, start, end, p.patch as Partial<Omit<TextRun, 'start' | 'end'>>) }
      catch (error) { err('invalid_text_range', error instanceof Error ? error.message : String(error)) }
      return { id: n.id, start, end }
    }),
  op('text.replaceRange', 'Replace the exact half-open UTF-16 range [start,end), including empty-range insertion or empty-text deletion. expectedText is required and must match the selected substring. Both old endpoints and new edit edges must be complete grapheme boundaries; cross-edge grapheme joins are rejected. Inserted text inherits the run at start (right-biased at a boundary), or the immediately preceding run only at end-of-text; gaps inherit layer defaults. Preserves outside characters and rich styles. Identical replacement is a no-op. Maximum resulting text length: 100000 UTF-16 units.',
    { nodeId: id, start: { type: 'integer', minimum: 0, maximum: 100000 }, end: { type: 'integer', minimum: 0, maximum: 100000 },
      text: { type: 'string', maxLength: 100000 }, expectedText: { type: 'string', maxLength: 100000 } }, ['nodeId', 'start', 'end', 'text', 'expectedText'], (doc, p) => {
      const n = requiredNode(doc, p.nodeId); unlocked(doc, n)
      if (n.kind !== 'text') err('invalid_kind', 'Range replacement requires a text node')
      unbound(doc, n, ['text'])
      const start = p.start as number, end = p.end as number, text = p.text as string
      if (n.text.slice(start, end) !== p.expectedText) err('value_conflict', 'Expected selected substring no longer matches')
      try { replaceTextRange(n, start, end, text) }
      catch (error) { err('invalid_text_range', error instanceof Error ? error.message : String(error)) }
      return { id: n.id, start, end, insertedEnd: start + text.length }
    }),
]
/** Only these draft-only operations are admitted for side-effect-free staging.
 * Other trusted extensions can invoke kernel/font/import helpers. */
export const PREFLIGHT_METHODS = new Set([...granularExtensions.map(entry => entry.name), 'variable.bind', 'variable.unbind'])
