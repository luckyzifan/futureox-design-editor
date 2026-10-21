import { prepareBooleanCreate, applyBooleanCreate, type BooleanCreateOptions } from '../commands/boolean-command'
import { applyDuplication, prepareDuplication, duplicationIntent } from '../commands/duplication-command'
import { prepareLayoutAdd, applyLayoutAdd, prepareLayoutRemove, applyLayoutRemove, type LayoutAddOptions } from '../commands/layout-command'
import { displayProperties } from './display-properties'
import { prepareSelectionScale, SelectionScaleError } from '../selection-scale'
import { SelectionCommandError, prepareSelectionArrangement, prepareSelectionWrap, configureSelectionWrapper,
  applySelectionWrap, prepareSelectionUnwrap, applySelectionUnwrap } from '../commands/selection-command'
import { planChildReparent, reparentedTransform } from '../commands/structure-plan'
import { applyChildListPlan, applyTransformPlan } from '../commands/apply-plan'
import { CORE_SELECTION_PROFILE } from '../commands/profiles'
import { releaseSlotRoot } from '../component-slots'
import { layoutSuggestionExtensions } from './layout-suggestions'
import { NODE_FIELDS, OPTIONAL_NODE_FIELDS, nodePatchSchema as patchSchema } from './node-input-descriptors'
import { bulkExtensions } from './bulk'
/** Authored-document automation. This module owns no renderer or second history.
 * Every successful batch enters the existing Editor.change boundary exactly once. */
import type { Editor, CommittedEditReceipt } from '../engine'
import { LocalAutomationPermissions, type AutomationPermissionPolicy } from './permissions'
import { hasPendingEdits } from '../pending-edits'
import { detachMissing } from '../components'
import { granularExtensions, PREFLIGHT_METHODS } from './granular'
import { CHANGE_SUMMARY_LIMITS, summarizeChanges } from './change-summary'
import {
  container, defaultLayout, defaultSizing, defaultTextStyle, node, uid,
  validateStructure,
  type DesignDocument, type DesignNode, type Kind, type Matrix, type Page,
} from '../model'
import { allParents, inverse, multiply, worldMatrix, bounds, boxPoints, apply } from '../geometry'
import { duplicateGraph, type GraphCopy } from '../duplicate-graph'
import { equalValue } from '../document-patch'
import { AutomationError, type AutomationCapabilities, type AutomationContext, type AutomationExtension,
  type AutomationMethod, type AutomationRequest, type AutomationResponse, type AutomationMutationCompletion } from './types'

const RECEIPT_LIMIT = 128, RECEIPT_BYTES = 32 * 1024 * 1024
const MAX_BATCH = 500, MAX_BYTES = 32 * 1024 * 1024, DEFAULT_MAX_BYTES = 8 * 1024 * 1024, MAX_RESULTS = 1000
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])
const KINDS: Kind[] = ['slice', 'frame', 'section', 'group', 'rectangle', 'ellipse', 'polygon', 'star', 'line', 'vector', 'text']
const stringSchema = { type: 'string', minLength: 1, maxLength: 128 }
const idsSchema = { type: 'array', items: stringSchema, minItems: 1, maxItems: MAX_RESULTS, uniqueItems: true }
const indexSchema = { type: 'integer', minimum: 0, maximum: 20000 }
const objectSchema = { type: 'object' }
const numberSchema = { type: 'number', minimum: -1e7, maximum: 1e7 }
function schema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}
function fail(code: string, message: string, details?: unknown): never { throw new AutomationError(code, message, details) }
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_params', `${label} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || FORBIDDEN.has(value))
    fail('invalid_params', `${label} must be a nonempty string of at most ${max} characters`)
  return value as string
}
function number(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e7) fail('invalid_params', `${label} must be finite and within ±10000000`)
  return value as number
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_RESULTS) fail('invalid_params', `ids must contain 1–${MAX_RESULTS} identifiers`)
  const result = value.map(id => text(id, 'node id'))
  if (new Set(result).size !== result.length) fail('invalid_params', 'ids must not contain duplicates')
  return result
}
function jsonAdmission(value: unknown, depth = 0, budget = { entries: 0 }): void {
  if (++budget.entries > 1_000_000 || depth > 128) fail('request_budget', 'Request exceeds the structural budget')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).some(key => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) fail('invalid_request', 'Only plain JSON arrays are accepted')
    if (value.length > 1_000_000) fail('request_budget', 'Array exceeds the structural budget')
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
      if (!descriptor || !('value' in descriptor)) fail('invalid_request', 'Sparse arrays and accessors are not accepted')
      jsonAdmission(descriptor.value, depth + 1, budget)
    }
    return
  }
  if (!value || typeof value !== 'object') fail('invalid_request', 'Only JSON values are accepted')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('invalid_request', 'Only plain JSON objects are accepted')
  if (Object.getOwnPropertySymbols(value).length) fail('invalid_request', 'Symbol properties are not accepted')
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key.length > 1024) fail('invalid_request', 'Property keys must not exceed 1024 characters')
    // `prototype` is also the legitimate authored prototype graph. It is safe
    // as plain data when constructor and __proto__ paths are rejected.
    if (key === '__proto__' || key === 'constructor') fail('invalid_request', `Unsafe property key: ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid_request', 'Accessors and non-enumerable properties are not accepted')
    jsonAdmission(descriptor.value, depth + 1, budget)
  }
}
/** JSON Schema length counts Unicode code points, not UTF-16 code units.
 * Native authored limits (for example document names) remain separate. */
function codePointLength(value: string): number {
  let length = 0
  for (let index = 0; index < value.length; length++) index += value.codePointAt(index)! > 0xffff ? 2 : 1
  return length
}
/** Check the common schema vocabulary published by the operation registry.
 * Model validators remain authoritative for authored nested values. */
function checkSchema(value: unknown, spec: Record<string, unknown>, path = 'params'): void {
  if (Array.isArray(spec.anyOf)) {
    if (!spec.anyOf.some(s => { try { checkSchema(value, record(s, 'schema'), path); return true } catch { return false } })) fail('invalid_params', `${path} has an invalid value`)
  }
  if (Array.isArray(spec.enum) && !spec.enum.some(v => equalValue(v, value))) fail('invalid_params', `${path} is not an allowed value`)
  const type = spec.type
  if (type === 'object') {
    const obj = record(value, path), properties = (spec.properties || {}) as Record<string, Record<string, unknown>>
    if (typeof spec.minProperties === 'number' && Object.keys(obj).length < spec.minProperties || typeof spec.maxProperties === 'number' && Object.keys(obj).length > spec.maxProperties) fail('invalid_params', `${path} has an invalid number of fields`)
    for (const required of (spec.required || []) as string[]) if (!Object.hasOwn(obj, required)) fail('invalid_params', `${path}.${required} is required`)
    for (const [key, item] of Object.entries(obj)) {
      if (Object.hasOwn(properties, key)) checkSchema(item, properties[key], `${path}.${key}`)
      else if (spec.additionalProperties === false) fail('invalid_params', `${path}.${key} is not supported`)
      else if (spec.additionalProperties && typeof spec.additionalProperties === 'object') checkSchema(item, spec.additionalProperties as Record<string, unknown>, `${path}.${key}`)
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) fail('invalid_params', `${path} must be an array`)
    const values = value as unknown[]
    if (typeof spec.minItems === 'number' && values.length < spec.minItems || typeof spec.maxItems === 'number' && values.length > spec.maxItems) fail('invalid_params', `${path} has an invalid length`)
    if (spec.uniqueItems === true && new Set(values.map(v => JSON.stringify(v))).size !== values.length) fail('invalid_params', `${path} must contain unique values`)
    if (spec.items) values.forEach(v => checkSchema(v, spec.items as Record<string, unknown>, `${path}[]`))
  } else if (type === 'string') {
    if (typeof value !== 'string') fail('invalid_params', `${path} must be a string`)
    const length = codePointLength(value as string)
    if (typeof spec.minLength === 'number' && length < spec.minLength || typeof spec.maxLength === 'number' && length > spec.maxLength) fail('invalid_params', `${path} has an invalid length`)
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || type === 'integer' && !Number.isSafeInteger(value)) fail('invalid_params', `${path} must be a finite ${type}`)
    const n = value as number
    if (typeof spec.minimum === 'number' && n < spec.minimum || typeof spec.maximum === 'number' && n > spec.maximum) fail('invalid_params', `${path} is outside its allowed range`)
  } else if (type === 'boolean' && typeof value !== 'boolean') fail('invalid_params', `${path} must be boolean`)
  else if (type === 'null' && value !== null) fail('invalid_params', `${path} must be null`)
}
function getNode(doc: DesignDocument, id: unknown): DesignNode {
  const key = text(id, 'node id'), n = Object.hasOwn(doc.nodes, key) ? doc.nodes[key] : undefined
  if (!n) fail('not_found', `Node ${key} does not exist`)
  return n
}
function getPage(doc: DesignDocument, id: unknown): Page {
  const key = text(id, 'page id'), p = doc.pages.find(p => p.id === key)
  if (!p) fail('not_found', `Page ${key} does not exist`)
  return p
}
function assertUnlocked(doc: DesignDocument, id: string, allowOwnUnlock = false): void {
  const parents = allParents(doc)
  let current: string | undefined = id
  while (current && doc.nodes[current]) {
    if (doc.nodes[current].locked && !(current === id && allowOwnUnlock)) fail('locked_node', `Node ${current} is locked`)
    current = parents.get(current)
  }
}
function childList(doc: DesignDocument, parent: string, write = true): string[] {
  const page = doc.pages.find(p => p.id === parent)
  if (page) return page.children
  const n = getNode(doc, parent)
  if (!container(n)) fail('invalid_parent', `Node ${parent} cannot contain children`)
  if (write) {
    assertUnlocked(doc, parent)
    if (n.instance || n.instanceOrigin) fail('instance_structure', 'Detach the instance before editing its child structure')
  }
  return n.children
}
function insertionIndex(value: unknown, length: number): number {
  if (value === undefined) return length
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > length) fail('invalid_params', `index must be between 0 and ${length}`)
  return value as number
}
function uniqueId(doc: DesignDocument, requested?: unknown): string {
  const id = requested === undefined ? uid() : text(requested, 'id')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) fail('invalid_params', 'Node and page identifiers must be UUIDs')
  if (Object.hasOwn(doc.nodes, id) || doc.pages.some(p => p.id === id)) fail('duplicate_id', `Identifier ${id} already exists`)
  return id
}
function roots(doc: DesignDocument, selected: string[]): string[] {
  selected.forEach(id => getNode(doc, id))
  const parents = allParents(doc), chosen = new Set(selected)
  return selected.filter(id => { let parent = parents.get(id); while (parent) { if (chosen.has(parent)) return false; parent = parents.get(parent) }; return true })
}
function subtree(doc: DesignDocument, selected: string[]): string[] {
  const found: string[] = []
  const visit = (id: string) => { found.push(id); getNode(doc, id).children.forEach(visit) }
  roots(doc, selected).forEach(visit)
  return found
}
function patchNode(doc: DesignDocument, n: DesignNode, value: unknown): void {
  const patch = record(value, 'patch')
  assertUnlocked(doc, n.id, Object.keys(patch).length === 1 && patch.locked === false)
  for (const key of Object.keys(patch)) if (!NODE_FIELDS.has(key)) fail('invalid_params', `Node property ${key} cannot be updated; use a structural or design-system operation`)
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && OPTIONAL_NODE_FIELDS.has(key)) delete (n as unknown as Record<string, unknown>)[key]
    else (n as unknown as Record<string, unknown>)[key] = structuredClone(value)
  }
}
function removeNodes(doc: DesignDocument, selected: string[]): string[] {
  const top = roots(doc, selected), removed = subtree(doc, top), parents = allParents(doc)
  removed.forEach(id => assertUnlocked(doc, id))
  for (const id of top) {
    const parent = parents.get(id)
    if (!parent) fail('invalid_structure', `Node ${id} has no parent`)
    const list = childList(doc, parent, !releaseSlotRoot(doc, id))
    list.splice(list.indexOf(id), 1)
  }
  for (const id of removed) delete doc.nodes[id]
  return removed
}
function moveNodes(doc: DesignDocument, selected: string[], parent: string, index?: unknown, preserveWorld = true): string[] {
  const top = roots(doc, selected), moving = new Set(subtree(doc, top)), parents = allParents(doc)
  if (moving.has(parent)) fail('cyclic_parent', 'A node cannot be moved into its own subtree')
  childList(doc, parent)
  const transforms = new Map<string, Matrix>()
  for (const id of top) {
    assertUnlocked(doc, id)
    const previous = parents.get(id)
    if (!previous) fail('invalid_structure', `Node ${id} has no parent`)
    childList(doc, previous)
    if (preserveWorld) transforms.set(id, reparentedTransform(worldMatrix(doc, parent), worldMatrix(doc, id)))
  }
  const lists = [...new Set([...top.map(id => parents.get(id)!), parent])].map(parent => ({ parent, children: childList(doc, parent) }))
  const remaining = childList(doc, parent).length - top.filter(id => parents.get(id) === parent).length
  const at = insertionIndex(index, remaining)
  applyChildListPlan(doc, planChildReparent(CORE_SELECTION_PROFILE, top.map(id => ({ id, parent: parents.get(id)! })), lists, parent, at))
  applyTransformPlan(doc, [...transforms].map(([id, transform]) => ({ id, transform })))
  return top
}
function copyGraph(doc: DesignDocument, selected: string[]): GraphCopy {
  const source = structuredClone(doc), top = roots(source, selected)
  return { document: source, roots: top, nodes: Object.fromEntries(subtree(source, top).map(id => [id, source.nodes[id]])) }
}
function summary(doc: DesignDocument, id: string) {
  const n = getNode(doc, id), parents = allParents(doc), matrix = worldMatrix(doc, id, parents)
  let pageId = id
  while (parents.has(pageId)) pageId = parents.get(pageId)!
  return { id, name: n.name, kind: n.kind, parentId: parents.get(id), pageId, visible: n.visible, locked: n.locked,
    childCount: n.children.length, width: n.width, height: n.height, transform: n.transform,
    worldBounds: bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map(p => apply(matrix, p))) }
}
function operation(name: string, description: string, inputSchema: Record<string, unknown>, mutates: boolean,
  execute: AutomationExtension['execute']): AutomationExtension { return { name, description, inputSchema, mutates, execute } }
const querySchema = schema({ pageId: stringSchema, rootId: stringSchema, name: { type: 'string', maxLength: 200 },
  exactName: { type: 'boolean' }, kind: { type: 'string', enum: KINDS }, text: { type: 'string', maxLength: 10000 },
  visible: { type: 'boolean' }, locked: { type: 'boolean' }, allPages: { type: 'boolean' },
  limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS }, cursor: { type: 'string', maxLength: 128 } })
const coreExtensions: AutomationExtension[] = [
  operation('document.get', 'Read document metadata; opt in to full authored nodes and embedded fonts.', schema({ includeNodes: { type: 'boolean' }, includeFonts: { type: 'boolean' } }), false, (doc, p) => {
    const { nodes, fonts, ...metadata } = doc
    return { ...metadata, nodeCount: Object.keys(nodes).length, ...(p.includeNodes ? { nodes } : {}),
      fonts: p.includeFonts ? fonts || {} : Object.fromEntries(Object.entries(fonts || {}).map(([id, f]) => [id, { family: f.family, index: f.index, postscript: f.postscript }])) }
  }),
  operation('document.rename', 'Rename the current authored document.', schema({ name: { type: 'string', minLength: 1, maxLength: 200, description: 'Native document names additionally require non-whitespace, well-formed text of at most 200 UTF-16 code units. This authored limit is independent of JSON Schema code-point length.' } }, ['name']), true,
    (doc, p) => { doc.name = text(p.name, 'name', 200); return { name: doc.name } }),
  operation('page.list', 'List the document pages in authored order.', schema(), false, doc => ({ pages: doc.pages })),
  operation('page.get', 'Read one page and its ordered root node identifiers.', schema({ id: stringSchema }, ['id']), false, (doc, p) => getPage(doc, p.id)),
  operation('node.get', 'Read a full authored node, parent, page and world bounds. Optionally include read-only effective Inspector properties; authored fields remain local units.', schema({ id: stringSchema, includeDisplayProperties: { type: 'boolean' } }, ['id']), false,
    (doc, p) => ({ node: getNode(doc, p.id), ...summary(doc, text(p.id, 'id')), ...(p.includeDisplayProperties === true ? { displayProperties: displayProperties(doc, text(p.id, 'id')) } : {}) })),
  operation('node.find', 'Find nodes with bounded, revision-bound pagination. Matches are sorted by identifier.', querySchema, false, (doc, p, ctx) => {
    let eligible: Set<string> | undefined
    if (p.rootId !== undefined) eligible = new Set(subtree(doc, [text(p.rootId, 'rootId')]))
    else if (!p.allPages || p.pageId !== undefined) eligible = new Set(subtree(doc, getPage(doc, p.pageId ?? ctx.pageId).children))
    const matches = Object.values(doc.nodes).filter(n => (!eligible || eligible.has(n.id)) &&
      (p.name === undefined || (p.exactName ? n.name === p.name : n.name.toLocaleLowerCase().includes((p.name as string).toLocaleLowerCase()))) &&
      (p.kind === undefined || n.kind === p.kind) && (p.text === undefined || n.text.includes(p.text as string)) &&
      (p.visible === undefined || n.visible === p.visible) && (p.locked === undefined || n.locked === p.locked)).sort((a, b) => a.id.localeCompare(b.id))
    let offset = 0
    if (p.cursor !== undefined) {
      const cursor = text(p.cursor, 'cursor'), parts = cursor.split(':')
      if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) fail('invalid_params', 'Invalid query cursor')
      if (Number(parts[0]) !== (ctx.revision ?? 0)) fail('stale_cursor', 'The document changed; restart the query')
      offset = Number(parts[1])
      if (!Number.isSafeInteger(offset) || offset > matches.length) fail('invalid_params', 'Query cursor is out of range')
    }
    const limit = p.limit === undefined ? 100 : p.limit as number
    return { nodes: matches.slice(offset, offset + limit).map(n => summary(doc, n.id)), total: matches.length,
      nextCursor: offset + limit < matches.length ? `${ctx.revision ?? 0}:${offset + limit}` : null }
  }),
  operation('selection.get', 'Read the active page and selected node identifiers.', schema(), false, (_doc, _p, ctx) => ({ pageId: ctx.pageId, ids: ctx.selection })),
  operation('page.create', 'Create an empty page. Optionally supply a UUID for later batch operations.', schema({ id: stringSchema, name: { type: 'string', minLength: 1, maxLength: 200 }, background: { type: 'string' }, index: indexSchema, makeCurrent: { type: 'boolean' } }), true, (doc, p, ctx) => {
    const page: Page = { id: uniqueId(doc, p.id), name: p.name === undefined ? `Page ${doc.pages.length + 1}` : text(p.name, 'name', 200),
      background: p.background === undefined ? '#eeeff3' : text(p.background, 'background', 200), children: [] }
    doc.pages.splice(insertionIndex(p.index, doc.pages.length), 0, page)
    ctx.createdIds.push(page.id)
    if (p.makeCurrent) { ctx.pageId = page.id; ctx.selection = [] }
    return { id: page.id }
  }),
  operation('page.update', 'Update page name, background and ruler guides.', schema({ id: stringSchema,
    patch: schema({ name: { type: 'string', minLength: 1, maxLength: 200 }, background: { type: 'string' }, guides: { type: 'array', maxItems: 1000 } }) }, ['id', 'patch']), true,
    (doc, p) => { const page = getPage(doc, p.id); Object.assign(page, structuredClone(record(p.patch, 'patch'))); return { id: page.id } }),
  operation('page.delete', 'Delete a page and its descendants. At least one page must remain.', schema({ id: stringSchema }, ['id']), true, (doc, p, ctx) => {
    const page = getPage(doc, p.id)
    if (doc.pages.length === 1) fail('last_page', 'At least one page must remain')
    const removedIds = page.children.length ? removeNodes(doc, [...page.children]) : []
    doc.pages.splice(doc.pages.indexOf(page), 1)
    if (ctx.pageId === page.id) { ctx.pageId = doc.pages[0].id; ctx.selection = [] }
    return { id: page.id, removedIds }
  }),
  operation('page.reorder', 'Move a page to its final zero-based index.', schema({ id: stringSchema, index: indexSchema }, ['id', 'index']), true, (doc, p) => {
    const page = getPage(doc, p.id); doc.pages.splice(doc.pages.indexOf(page), 1)
    doc.pages.splice(insertionIndex(p.index, doc.pages.length), 0, page); return { id: page.id, index: p.index }
  }),
  operation('page.duplicate', 'Duplicate a page with remapped native component, interaction and animation references.', schema({ id: stringSchema, name: { type: 'string', minLength: 1, maxLength: 200 } }, ['id']), true, (doc, p, ctx) => {
    const page = getPage(doc, p.id), content = copyGraph(doc, page.children), copy = { ...structuredClone(page), id: uniqueId(doc),
      name: p.name === undefined ? `${page.name} copy`.slice(0, 200) : text(p.name, 'name', 200), children: [] as string[] }
    doc.pages.splice(doc.pages.indexOf(page) + 1, 0, copy)
    const result = duplicateGraph(doc, content, { page: copy.id })
    ctx.createdIds.push(copy.id, ...result.ids.values())
    return { id: copy.id, roots: result.roots, idMap: Object.fromEntries(result.ids) }
  }),
  operation('node.create', 'Create a native layer. Coordinates and transform are local to parent. Supply a UUID id to reference it later in a batch.', schema({
    id: stringSchema, kind: { type: 'string', enum: KINDS }, parentId: stringSchema, index: indexSchema,
    x: numberSchema, y: numberSchema, width: { type: 'number', minimum: 0.01, maximum: 1e7 }, height: { type: 'number', minimum: 0.01, maximum: 1e7 }, patch: patchSchema,
  }, ['kind']), true, (doc, p, ctx) => {
    const parent = p.parentId === undefined ? ctx.pageId : text(p.parentId, 'parentId'), list = childList(doc, parent)
    const n = node(p.kind as Kind, number(p.x, 0, 'x'), number(p.y, 0, 'y'), number(p.width, 160, 'width'), number(p.height, 120, 'height'))
    n.id = uniqueId(doc, p.id)
    if (p.patch !== undefined) patchNode(doc, n, p.patch)
    doc.nodes[n.id] = n; list.splice(insertionIndex(p.index, list.length), 0, n.id)
    ctx.createdIds.push(n.id); return { id: n.id }
  }),
  operation('node.update', 'Set authored properties on explicit nodes; identity and child structure use dedicated operations. Null clears optional properties.', schema({ ids: idsSchema, patch: patchSchema }, ['ids', 'patch']), true,
    (doc, p) => { const selected = ids(p.ids); selected.forEach(id => patchNode(doc, getNode(doc, id), p.patch)); return { ids: selected } }),
  operation('node.delete', 'Delete explicit node subtrees, respecting locked nodes and ancestors.', schema({ ids: idsSchema }, ['ids']), true,
    (doc, p) => ({ removedIds: removeNodes(doc, ids(p.ids)) })),
  operation('node.move', 'Reparent nodes in one atomic operation. index is the final insertion position after removal; world transforms are preserved by default.', schema({ ids: idsSchema, parentId: stringSchema, index: indexSchema, preserveWorld: { type: 'boolean' } }, ['ids', 'parentId']), true,
    (doc, p) => ({ ids: moveNodes(doc, ids(p.ids), text(p.parentId, 'parentId'), p.index, p.preserveWorld !== false) })),
  operation('node.duplicate', 'Duplicate with shared editor placement: ordinary nodes in place, top-level frames to the right (Core gap 24), and trusted single-step translation/rotation repeat. Explicit offsetX or offsetY selects world-offset placement; an omitted other axis remains 24. Selects the new roots. Main components retain native linked-instance behavior.', schema({ ids: idsSchema, parentId: stringSchema, index: indexSchema, offsetX: numberSchema, offsetY: numberSchema }, ['ids']), true, (doc, p, ctx) => {
    if (p.index !== undefined && p.parentId === undefined) fail('invalid_params', 'index requires parentId')
    if (p.parentId !== undefined) childList(doc, text(p.parentId, 'parentId'))
    const intent = duplicationIntent(p.offsetX as number | undefined, p.offsetY as number | undefined)
    const plan = prepareDuplication(doc, ids(p.ids), intent, { fresh: ctx.selectionGeometryFresh === true,
      singleStep: ctx.duplicationSingleStep === true, mutable: true, repeat: ctx.duplicationRepeat, destination: p.parentId as string | undefined })
    const before = new Set(Object.keys(doc.nodes)), result = applyDuplication(doc, plan)
    if (p.parentId !== undefined) {
      moveNodes(doc, result.roots, text(p.parentId, 'parentId'), p.index)
      // Only these new copies change coordinate owners. Match native reparent
      // semantics without altering node.move or the original authored roots.
      for (const id of result.roots) if (doc.nodes[id].constraints)
        doc.nodes[id].constraints = { ...doc.nodes[id].constraints!, referenceWidth: null, referenceHeight: null }
    }
    for (const id of Object.keys(doc.nodes)) if (!before.has(id)) ctx.createdIds.push(id)
    ctx.pageId = (() => { const parents = allParents(doc); let at = result.roots[0]; while (parents.has(at)) at = parents.get(at)!; return at })()
    ctx.selection = [...result.roots]
    if (ctx.duplicationSingleStep) ctx.duplicationResult = result
    return { ids: result.roots, idMap: Object.fromEntries(result.ids) }
  }),
  operation('layout.add', 'Add horizontal/vertical auto layout with Core defaults (gap 12, padding 16). Ordinary selections wrap and reflow; one frame/group updates in place. Wrapper order defaults to axis; existing containers default to scene. Hidden/absolute slots remain fixed. UI inference is a separate strategy.', schema({ ids: idsSchema,
    mode: { enum: ['horizontal', 'vertical'] }, gap: { type: 'number', minimum: 0, maximum: 1e5 },
    padding: schema({ top: { type: 'number', minimum: 0, maximum: 1e5 }, right: { type: 'number', minimum: 0, maximum: 1e5 }, bottom: { type: 'number', minimum: 0, maximum: 1e5 }, left: { type: 'number', minimum: 0, maximum: 1e5 } }, ['top', 'right', 'bottom', 'left']),
    order: { enum: ['scene', 'axis'] }, id: stringSchema, name: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['ids', 'mode']), true, (doc, p, ctx) => {
    const plan = prepareLayoutAdd(doc, ids(p.ids), p as unknown as LayoutAddOptions, { fresh: ctx.selectionGeometryFresh === true })
    applyLayoutAdd(doc, plan)
    if (plan.wrapper) ctx.createdIds.push(plan.target)
    ctx.pageId = plan.pageId; ctx.selection = [plan.target]
    return { ids: [plan.target], childOrder: plan.childOrder, reflow: plan.changed, created: !!plan.wrapper }
  }),
  operation('layout.remove', 'Remove layout from explicit ordinary frames, preserving current normalized geometry and child order. Retire fill sizing and reset direct-child constraint references. Does not remove nested layout recursively. Later batch operations requiring derived geometry reject.', schema({ ids: idsSchema }, ['ids']), true, (doc, p, ctx) => {
    const plan = prepareLayoutRemove(doc, ids(p.ids), { fresh: ctx.selectionGeometryFresh === true })
    applyLayoutRemove(doc, plan); ctx.pageId = plan.pageId; ctx.selection = plan.ids
    return { ids: plan.ids, changedIds: plan.changedIds, childOrders: Object.fromEntries(plan.ids.map(id => [id, [...doc.nodes[id].children]])) }
  }),
  operation('layout.set', 'Set auto layout, child sizing, constraints and layout grids using the native layout model. Null removes an optional layout facet.', schema({ ids: idsSchema,
    layout: {}, sizing: {}, constraints: {}, layoutGrid: {} }, ['ids']), true, (doc, p) => {
    const selected = ids(p.ids), patch: Record<string, unknown> = {}
    for (const key of ['layout', 'sizing', 'constraints', 'layoutGrid']) if (Object.hasOwn(p, key)) patch[key] = p[key]
    if (!Object.keys(patch).length) fail('invalid_params', 'Supply at least one layout property')
    for (const id of selected) {
      const n = getNode(doc, id), merged = { ...patch }
      if (patch.layout != null) merged.layout = { ...defaultLayout(), ...n.layout, ...record(patch.layout, 'layout') }
      if (patch.sizing != null) merged.sizing = { ...defaultSizing(), ...n.sizing, ...record(patch.sizing, 'sizing') }
      patchNode(doc, n, merged)
    }
    return { ids: selected }
  }),
  operation('text.set', 'Set text, font size, text style and rich-text runs on text nodes; provided styles merge with existing style.', schema({ ids: idsSchema,
    text: { type: 'string', maxLength: 100_000 }, fontSize: { type: 'number', minimum: 1, maximum: 4096 }, textStyle: objectSchema, textRuns: { type: 'array', maxItems: 4096 } }, ['ids']), true, (doc, p) => {
    const selected = ids(p.ids)
    if (!['text', 'fontSize', 'textStyle', 'textRuns'].some(key => Object.hasOwn(p, key))) fail('invalid_params', 'Supply at least one text property')
    for (const id of selected) {
      const n = getNode(doc, id)
      if (n.kind !== 'text') fail('invalid_kind', `Node ${id} is not text`)
      const patch: Record<string, unknown> = {}
      for (const key of ['text', 'fontSize', 'textRuns']) if (Object.hasOwn(p, key)) patch[key] = p[key]
      // Changing characters invalidates old run ranges unless new runs are supplied.
      if (p.text !== undefined && p.textRuns === undefined && p.text !== n.text) patch.textRuns = []
      if (p.textStyle !== undefined) patch.textStyle = { ...defaultTextStyle(), ...n.textStyle, ...record(p.textStyle, 'textStyle') }
      patchNode(doc, n, patch)
    }
    return { ids: selected }
  }),
  operation('style.set', 'Set node paint, stroke, effect, opacity, blend and corner properties. This is authored style data, not shared-style publication.', schema({ ids: idsSchema,
    fills: { type: 'array', maxItems: 16 }, strokes: { type: 'array', maxItems: 16 }, effects: { type: 'array', maxItems: 16 }, opacity: { type: 'number', minimum: 0, maximum: 1 }, blend: { type: 'string' }, radii: { type: 'array', minItems: 4, maxItems: 4, items: numberSchema }, smoothing: { type: 'number', minimum: 0, maximum: 1 } }, ['ids']), true,
    (doc, p) => { const selected = ids(p.ids), { ids: _ids, ...patch } = p; if (!Object.keys(patch).length) fail('invalid_params', 'Supply a style property'); selected.forEach(id => patchNode(doc, getNode(doc, id), patch)); return { ids: selected } }),
  operation('effects.set', 'Replace authored effect stacks on explicit nodes.', schema({ ids: idsSchema, effects: { type: 'array', maxItems: 16 } }, ['ids', 'effects']), true,
    (doc, p) => { const selected = ids(p.ids); selected.forEach(id => patchNode(doc, getNode(doc, id), { effects: p.effects })); return { ids: selected } }),
]
coreExtensions.push(
  operation('selection.scale', 'Proportionally scale explicit active-page roots using the UI scale command, not resize. Factor 0.01–10000; anchor 0–8 is row-major, default center (4).', schema({ ids: idsSchema, factor: { type: 'number', minimum: .01, maximum: 1e4 }, anchor: { type: 'integer', minimum: 0, maximum: 8 } }, ['ids', 'factor']), true, (doc, p, ctx) => {
    const plan = prepareSelectionScale(doc, ctx.pageId, ids(p.ids), p.factor as number, p.anchor === undefined ? 4 : p.anchor as number, { fresh: ctx.selectionGeometryFresh === true })
    for (const [id, transform] of Object.entries(plan.transforms)) doc.nodes[id].transform = transform
    return { ids: plan.ids }
  }),
  operation('selection.set', 'Select explicit nodes on one page. An empty array clears selection.', schema({ ids: { type: 'array', items: stringSchema, maxItems: MAX_RESULTS, uniqueItems: true }, pageId: stringSchema }, ['ids']), true, (doc, p, ctx) => {
    const page = getPage(doc, p.pageId ?? ctx.pageId), allowed = new Set(subtree(doc, page.children))
    const selected = (p.ids as unknown[]).map(id => text(id, 'id'))
    for (const id of selected) if (!allowed.has(id)) fail('invalid_selection', `Node ${id} is not on page ${page.id}`)
    ctx.pageId = page.id; ctx.selection = selected
    return { pageId: page.id, ids: selected }
  }),
  operation('page.setCurrent', 'Navigate to a page and clear selection without editing document history.', schema({ id: stringSchema }, ['id']), true, (doc, p, ctx) => {
    ctx.pageId = getPage(doc, p.id).id; ctx.selection = []; return { id: ctx.pageId }
  }),
)

coreExtensions.push(
  operation('vector.boolean.create', 'Create a non-destructive live boolean with editable operands. verified-fill: 2–64 same-parent closed fill shapes/vectors/nested booleans; scene bottom-to-top order, bottom minus upper for subtract. Other operations inherit topmost paint/effects; subtract inherits bottommost. Text, frames, Symbols, visible strokes and dependent geometry reject. Not full Figma/Sketch parity; geometry is resolved by native Core.', schema({
    ids: { ...idsSchema, minItems: 2, maxItems: 64 }, operation: { enum: ['union', 'subtract', 'intersect', 'exclude'] }, id: stringSchema,
    name: { type: 'string', minLength: 1, maxLength: 200, description: 'Native boolean names additionally require non-whitespace text of at most 200 UTF-16 code units. This authored limit is independent of JSON Schema code-point length.' },
  }, ['ids', 'operation']), true, (doc, p, ctx) => {
    const plan = prepareBooleanCreate(doc, ids(p.ids), p as unknown as BooleanCreateOptions, { fresh: ctx.selectionGeometryFresh === true }, 'verified-fill')
    applyBooleanCreate(doc, plan)
    ctx.createdIds.push(plan.wrapper.id); ctx.selection = [plan.wrapper.id]
    return { id: plan.wrapper.id, childIds: plan.wrap.ids, operation: plan.wrapper.booleanOperation, styleSourceId: plan.styleSourceId }
  }),
  operation('node.group', 'Wrap same-parent selection using shared exact geometry; group and selection-frame are transparent and unclipped. Auto-layout topology is unsupported.', schema({
    ids: idsSchema, id: stringSchema, kind: { enum: ['group', 'frame'] }, name: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['ids']), true, (doc, p, ctx) => {
    const plan = prepareSelectionWrap(doc, ids(p.ids), { fresh: ctx.selectionGeometryFresh === true })
    const group = node((p.kind ?? 'group') as 'group' | 'frame', 0, 0, plan.width, plan.height)
    group.id = uniqueId(doc, p.id); configureSelectionWrapper(group, plan)
    if (p.name !== undefined) group.name = text(p.name, 'name', 200)
    applySelectionWrap(doc, plan, group)
    ctx.createdIds.push(group.id); ctx.selection = [group.id]
    return { id: group.id, childIds: plan.ids }
  }),
  operation('node.ungroup', 'Unwrap ordinary group/frame/section/boolean containers one level, retaining child world transforms/styles and releasing direct mask scope. Instances/components, auto-layout topology and unproven derived batch geometry reject.', schema({ ids: idsSchema }, ['ids']), true, (doc, p, ctx) => {
    const plan = prepareSelectionUnwrap(doc, ids(p.ids), { fresh: ctx.selectionGeometryFresh === true }), revealed = applySelectionUnwrap(doc, plan)
    ctx.selection = revealed; return { removedIds: plan.ids, ids: revealed }
  }),
  operation('node.align', 'Align shared exact selection geometry in world coordinates, or one node in parent-local coordinates. Auto-layout flow children and unproven derived batch geometry reject.', schema({ ids: idsSchema, axis: { enum: ['x', 'y'] }, mode: { enum: ['start', 'center', 'end'] } }, ['ids', 'axis', 'mode']), true,
    (doc, p, ctx) => alignNodes(doc, ids(p.ids), p.axis as 'x' | 'y', p.mode as 'start' | 'center' | 'end', ctx)),
  operation('node.distribute', 'Equalize non-overlapping world-space geometry edge gaps with outer objects fixed; two nodes are unchanged. Overlap/containment and unproven derived batch geometry reject.', schema({ ids: idsSchema, axis: { enum: ['x', 'y'] } }, ['ids', 'axis']), true,
    (doc, p, ctx) => alignNodes(doc, ids(p.ids), p.axis as 'x' | 'y', 'distribute', ctx)),
)
function alignNodes(doc: DesignDocument, selected: string[], axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute', ctx: AutomationContext) {
  const plan = prepareSelectionArrangement(doc, selected, axis, mode, { fresh: ctx.selectionGeometryFresh === true })
  applyTransformPlan(doc, plan.patches); return { ids: plan.ids }
}

const operationsSchema = { type: 'array', minItems: 1, maxItems: MAX_BATCH,
  items: schema({ method: { type: 'string', minLength: 1, maxLength: 128 }, params: objectSchema }, ['method']) }
const mutationIdSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$' }
const specialMethods: AutomationMethod[] = [
  { name: 'api.capabilities', description: 'Discover implemented operation schemas, limits and explicit unsupported capabilities.', mutates: false, inputSchema: schema() },
  { name: 'history.undo', description: 'Undo one native editor history entry, including a complete automation batch.', mutates: true, inputSchema: schema() },
  { name: 'history.redo', description: 'Redo one native editor history entry.', mutates: true, inputSchema: schema() },
  { name: 'batch.apply', description: 'Apply up to 500 operations atomically as one native undo entry. No partial state is published on failure. Optional mutationId returns a session-local idempotency receipt for exact retries, including after a lost response. Successful receipts are never silently evicted.', mutates: true,
    inputSchema: schema({ operations: operationsSchema, label: { type: 'string', minLength: 1, maxLength: 200 }, mutationId: mutationIdSchema }, ['operations']) },
  { name: 'batch.preflight', description: 'Read-only authored-change staging for node.patch, layout.patch, paint.patch, text.styleRange, text.replaceRange, their registered bulk wrappers, and variable.bind/unbind only. Checks schemas, structural/resource constraints and expected leaves; returns a bounded authored diff. Derived layout, component overrides, kernel validation and final history commit are deferred. This is not a pixel preview or a guarantee that commit will succeed. Does not consume mutation receipts.', mutates: false,
    inputSchema: schema({ operations: operationsSchema }, ['operations']) },
]
function safeUrls(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) { value.forEach(safeUrls); return }
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string' && v) {
      if (['url', 'href', 'link'].includes(key) && (!/^(https?:\/\/|mailto:|tel:)/i.test(v) || /[\u0000-\u0020\u007f]/.test(v)))
        fail('unsafe_url', `${key} must use an explicit safe URL scheme`)
      if (key === 'image' && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v))
        fail('unsafe_asset', 'Image paints must use embedded PNG, JPEG or WebP data; automation does not fetch URLs or local files')
    }
    safeUrls(v)
  }
}
function knownIds(doc: DesignDocument): Set<string> {
  return new Set([...Object.keys(doc.nodes), ...doc.pages.map(p => p.id),
    ...Object.keys(doc.fonts || {}), ...Object.keys(doc.designSystem?.collections || {}), ...Object.keys(doc.designSystem?.variables || {}),
    ...Object.keys(doc.designSystem?.styles || {}), ...Object.keys(doc.designSystem?.libraries || {}),
    ...(doc.animations || []).map(clip => clip.id), ...(doc.reviews || []).map(review => review.id)])
}
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
/** Bound the complete historic result before the authoritative commit. Resource
 * IDs use their actual serialized lengths; only kernel-generated node IDs use
 * the native 20,000-node / UUID contract. No receipt can fail after commit. */
function receiptResultBound(before: DesignDocument, candidate: DesignDocument, ctx: AutomationContext, results: unknown) {
  const previousIds = knownIds(before)
  const stagedCreated = [...knownIds(candidate)].filter(id => !previousIds.has(id))
  const changedIds = [...new Set([...Object.keys(before.nodes), ...Object.keys(candidate.nodes)])]
  // A derived node can be present in both changedIds and createdIds. JSON UUID
  // plus quotes and comma is 39 bytes. Allow the full native limit in each list.
  const materializedIds = 2 * 20000 * 39
  return jsonBytes(results) + jsonBytes(changedIds) + jsonBytes(stagedCreated) + jsonBytes(ctx.selection) +
    jsonBytes(candidate.pages.map(page => page.id)) + materializedIds + CHANGE_SUMMARY_LIMITS.maxBytes + 4096
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
type MutationIdentity = Pick<CommittedEditReceipt, 'documentId' | 'session' | 'revision'>
type MutationExecution = { result: Record<string, unknown>; identity: MutationIdentity }
const receiptIdentity = ({ documentId, session, revision }: MutationIdentity): MutationIdentity => ({ documentId, revision, session })

export class DesignAutomationApi {
  private readonly registry = new Map<string, AutomationExtension>()
  private readonly descriptors = new Map<string, AutomationMethod>()
  private readonly permissions?: LocalAutomationPermissions
  private disposed = false
  private receiptOwner = ''
  private receiptBytes = 0
  private readonly receipts = new Map<string, { fingerprint: string; result: Record<string, unknown> }>()
  constructor(readonly editor: Editor, extensions: AutomationExtension[] = [],
    private readonly validators: ((document: DesignDocument) => void)[] = [], permissions?: AutomationPermissionPolicy) {
    this.permissions = permissions === undefined ? undefined : new LocalAutomationPermissions(permissions)
    for (const entry of [...coreExtensions, ...granularExtensions, ...layoutSuggestionExtensions, ...extensions]) {
      if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(entry.name)) throw new Error(`Invalid automation method name: ${entry.name}`)
      if (this.registry.has(entry.name) || specialMethods.some(m => m.name === entry.name)) throw new Error(`Duplicate automation method: ${entry.name}`)
      this.registry.set(entry.name, entry)
      const { execute: _execute, expand: _expand, ...descriptor } = entry
      this.descriptors.set(entry.name, descriptor)
    }
    for (const descriptor of specialMethods) this.descriptors.set(descriptor.name, descriptor)
  }
  dispose(): void { this.disposed = true; this.receipts.clear(); this.receiptBytes = 0 }
  private allowed(method: AutomationMethod | undefined): boolean {
    return !!method && (!this.permissions || this.permissions.allows(method, {
      documentId: this.editor.state.doc.id, session: this.editor.sessionGeneration,
    }))
  }
  private authorize(method: string): void {
    if (!this.descriptors.has(method)) fail('unsupported_method', `Unsupported automation method: ${method}`)
    if (!this.allowed(this.descriptors.get(method))) fail('permission_denied', `Operation is not granted for this document session: ${method}`)
  }
  methods(): AutomationMethod[] { return structuredClone([...this.descriptors.values()].filter(method => this.allowed(method)).sort((a, b) => a.name.localeCompare(b.name))) }
  private preflightMethods(): string[] {
    return [...PREFLIGHT_METHODS, ...bulkExtensions.filter(entry => this.registry.get(entry.name) === entry).map(entry => entry.name)]
      .filter(name => this.allowed(this.descriptors.get(name)))
  }
  capabilities(): AutomationCapabilities {
    return { version: 1, methods: this.methods(), limits: { maxBatchOperations: MAX_BATCH, maxRequestBytes: MAX_BYTES, defaultMaxRequestBytes: DEFAULT_MAX_BYTES, maxQueryResults: MAX_RESULTS },
      editing: { bulk: bulkExtensions.filter(entry => this.registry.get(entry.name) === entry && this.allowed(entry)).map(entry => entry.name), maxExpandedOperations: 500, granular: granularExtensions.filter(method => this.allowed(method)).map(method => method.name), preflight: { validation: 'authored-only', derivedResolution: 'deferred', authoritativeCommitValidationRequired: true, methods: this.preflightMethods() }, changeSummary: CHANGE_SUMMARY_LIMITS, idempotency: { method: 'batch.apply', scope: 'document-session', maxReceipts: 128, maxSerializedBytes: RECEIPT_BYTES } },
      unsupported: ['Arbitrary JavaScript/eval or plugin execution', 'Remote Figma file/account/publishing APIs',
        'Host filesystem or network access from operation arguments', 'Renderer or GPU reconfiguration',
        'Font downloading or operating-system font installation', 'Cross-document atomic transactions',
        'Selection wrap/unwrap of auto-layout topology or component/instance structure',
        'Distribution of overlapping/contained intervals', 'Selection geometry with unproven freshness after derived batch edits'] }
  }
  private context(): AutomationContext {
    return { pageId: this.editor.state.page, selection: [...this.editor.state.selection], createdIds: [],
      revision: this.editor.state.version, session: this.editor.sessionGeneration }
  }
  private requireFence(request: AutomationRequest, mutation: boolean): void {
    if (mutation && (request.expectedRevision === undefined || request.documentId === undefined || request.session === undefined))
      fail('missing_revision', 'Mutations require expectedRevision, documentId and session from a fresh read response')
    if (request.documentId !== undefined && request.documentId !== this.editor.state.doc.id) fail('document_mismatch', 'The active document changed; read it again before editing')
    if (request.session !== undefined && request.session !== this.editor.sessionGeneration) fail('session_mismatch', 'The editor session changed; read it again before editing')
    if (request.expectedRevision !== undefined && request.expectedRevision !== this.editor.state.version) fail('stale_revision', 'The document changed; read it again before editing', { expected: request.expectedRevision, actual: this.editor.state.version })
    if (mutation) {
      if (this.editor.interactionActive) fail('interaction_active', 'Finish or cancel the current editor gesture before automation edits')
      if (hasPendingEdits(this.editor)) fail('pending_edits', 'Finish the current text or property input before automation edits; the input has been preserved')
      if (this.editor.state.busy) fail('editor_busy', 'The editor has an operation in progress')
    }
  }
  private entry(method: string): AutomationExtension {
    const entry = this.registry.get(method)
    if (!entry) fail('unsupported_method', `Unsupported automation method: ${method}`)
    return entry
  }
  private publishContext(ctx: AutomationContext, owner: CommittedEditReceipt): { applied: boolean; pageId: string; selection: string[] } {
    const doc = owner.document
    const pageId = doc.pages.some(p => p.id === ctx.pageId) ? ctx.pageId : doc.pages[0].id
    const allowed = new Set(subtree(doc, getPage(doc, pageId).children))
    const selection = ctx.selection.filter(id => allowed.has(id))
    const current = () => !this.disposed && this.editor.sessionGeneration === owner.session &&
      this.editor.state.doc === doc && this.editor.state.version === owner.revision
    let expectedPage = owner.pageId, expectedSelection = [...owner.selection]
    const ownsNavigation = () => current() && this.editor.state.page === expectedPage && equalValue(this.editor.state.selection, expectedSelection)
    const interrupted = () => ({ applied: false, pageId: owner.pageId, selection: [...owner.selection] })
    // A state/audit subscriber can synchronously load a same-ID document, edit
    // again or navigate. Never carry the earlier context into that newer state.
    if (!ownsNavigation()) return interrupted()
    if (expectedPage !== pageId) {
      if (!this.editor.switchPage(pageId)) return interrupted()
      expectedPage = pageId; expectedSelection = []
      if (!ownsNavigation()) return interrupted()
    }
    if (!equalValue(expectedSelection, selection)) {
      this.editor.select(selection)
      expectedSelection = selection
      if (!ownsNavigation()) return interrupted()
    }
    return { applied: true, pageId, selection }
  }
  private expandOperations(operations: { method: string; params?: Record<string, unknown> }[], preflight: boolean) {
    const expanded: { method: string; params?: Record<string, unknown> }[] = []
    for (const item of operations) {
      this.authorize(item.method)
      const entry = this.entry(item.method)
      if (!entry.mutates) fail('invalid_operation', 'Read operations are not accepted inside a mutation batch')
      checkSchema(item.params || {}, entry.inputSchema)
      if (preflight && !PREFLIGHT_METHODS.has(item.method) && !bulkExtensions.includes(entry))
        fail('unsupported_preflight_operation', `Authored-only preflight does not support ${item.method}`)
      const leaves = entry.expand ? entry.expand(structuredClone(item.params || {})) : [item]
      if (!Array.isArray(leaves) || !leaves.length || expanded.length + leaves.length > 500)
        fail('invalid_params', 'A request must contain 1–500 expanded mutation operations')
      for (const leaf of leaves) {
        this.authorize(leaf.method)
        const target = this.entry(leaf.method)
        if (target.expand) fail('invalid_operation', 'Recursive operation expansion is not supported')
        if (!target.mutates) fail('invalid_operation', 'Expanded operations must be mutations')
        checkSchema(leaf.params || {}, target.inputSchema)
        if (preflight && !PREFLIGHT_METHODS.has(leaf.method))
          fail('unsupported_preflight_operation', `Authored-only preflight does not support ${leaf.method}`)
        expanded.push(leaf)
      }
    }
    return expanded
  }
  private stage(operations: { method: string; params?: Record<string, unknown> }[], preflight = false) {
    const before = this.editor.authoredDocument, candidate = structuredClone(before), ctx = this.context()
    ctx.duplicationSingleStep = operations.length === 1
    ctx.duplicationRepeat = this.editor.duplicationRepeat()
    const results: { method: string; result: unknown }[] = []
    let resultBytes = 0
    for (let index = 0; index < operations.length; index++) {
      const item = operations[index]
      // Internal staging fact, never an accepted request field or authority.
      ctx.selectionGeometryFresh = index === 0
      try {
        if (preflight && !PREFLIGHT_METHODS.has(item.method)) fail('unsupported_preflight_operation', `Authored-only preflight does not support ${item.method}`)
        const entry = this.entry(item.method)
        if (!entry.mutates) fail('invalid_operation', 'Read operations are not accepted inside a mutation batch')
        const params = item.params || {}
        checkSchema(params, entry.inputSchema)
        const result = entry.execute(candidate, params, ctx)
        if (result && typeof result === 'object' && 'then' in result) fail('unsupported_async', 'Asynchronous operations must use an explicitly scoped host flow')
        validateStructure(candidate)
        if (result !== undefined) {
          const serialized = JSON.stringify(result)
          JSON.parse(serialized)
          resultBytes += new TextEncoder().encode(serialized).byteLength
          if (resultBytes > DEFAULT_MAX_BYTES) fail('result_budget', 'Mutation results exceed 8 MiB; split the batch into smaller operations')
        }
        results.push({ method: item.method, result: result ?? null })
      } catch (error) {
        if (error instanceof SelectionScaleError) throw new AutomationError(error.code, error.message, { operationIndex: index, method: item.method })
        if (error instanceof SelectionCommandError) throw new AutomationError(error.code, error.message, { operationIndex: index, method: item.method })
        if (error instanceof AutomationError) throw new AutomationError(error.code, error.message, { operationIndex: index, method: item.method, cause: error.details })
        throw new AutomationError('invalid_operation', error instanceof Error ? error.message : String(error), { operationIndex: index, method: item.method })
      }
    }
    validateStructure(candidate)
    // Native deletion preserves materialized instances whose main disappears.
    // A fresh same-batch empty instance has no resolved appearance to preserve.
    for (const n of Object.values(candidate.nodes)) if (n.instance && !before.nodes[n.id] && !candidate.nodes[n.instance.componentId]?.component)
      fail('unmaterialized_instance', 'Commit a new instance before deleting its main component')
    if (!preflight && Object.values(before.nodes).some(n => n.component || n.instance || n.instanceOrigin || n.componentSet)) detachMissing(before, candidate)
    validateStructure(candidate)
    safeUrls(candidate)
    for (const validate of this.validators) validate(candidate)
    return { before, candidate, ctx, results }
  }
  private preflight(operations: { method: string; params?: Record<string, unknown> }[]) {
    const { before, candidate, ctx, results } = this.stage(operations, true)
    return { operations: results, ...summarizeChanges(before, candidate),
      changedIds: Object.keys(candidate.nodes).filter(id => !equalValue(before.nodes[id], candidate.nodes[id])),
      validation: 'authored-only', derivedResolution: 'deferred', authoritativeCommitValidationRequired: true,
      noAuthoredChange: equalValue(before, candidate), pageId: ctx.pageId, selection: ctx.selection,
      supportedMethods: this.preflightMethods(), receiptConsumed: false }
  }
  private mutate(request: AutomationRequest, operations: { method: string; params?: Record<string, unknown> }[], label: string, fingerprintBytes: number | undefined, originalOperations: { method: string }[], observeCommit: (receipt: CommittedEditReceipt) => void): MutationExecution {
    const { before, candidate, ctx, results } = this.stage(operations)
    const version = this.editor.state.version
    if (fingerprintBytes !== undefined && this.receiptBytes + fingerprintBytes + receiptResultBound(before, candidate, ctx, results) > RECEIPT_BYTES)
      fail('receipt_limit', 'The complete mutation receipt cannot fit the document-session budget; no edit was committed')
    // Synchronous staging may invoke trusted extensions; re-check ownership and
    // pending input immediately before the one authoritative commit boundary.
    this.requireFence(request, true)
    this.authorize(request.method)
    for (const operation of [...originalOperations, ...operations]) this.authorize(operation.method)
    let owner: CommittedEditReceipt = { document: before, documentId: before.id, session: this.editor.sessionGeneration,
      revision: version, pageId: this.editor.state.page, selection: [...this.editor.state.selection],
      canUndo: this.editor.canUndo, canRedo: this.editor.canRedo }
    let committed = false, committedResult: unknown
    if (!equalValue(before, candidate)) {
      const changeResult = this.editor.change(label, draft => {
        if (draft.id !== candidate.id) fail('document_mismatch', 'Cannot replace the document identity')
        for (const key of Object.keys(draft)) if (!Object.hasOwn(candidate, key)) delete (draft as unknown as Record<string, unknown>)[key]
        Object.assign(draft, candidate)
      }, undefined, undefined, 'automation')
      if (changeResult?.status === 'rejected') fail('commit_failed', changeResult.message || this.editor.state.message)
      if (changeResult?.status === 'committed') {
        const receipt = this.editor.committedEditReceipt(changeResult)
        if (!receipt) fail('commit_receipt_unavailable', 'The edit committed but its trusted result receipt is unavailable; read state before another operation',
          { committed: true, retry: 'do-not-retry', ...receiptIdentity({ ...owner, revision: changeResult.revision }) })
        owner = receipt; committed = true; committedResult = changeResult; observeCommit(receipt)
      } else if (changeResult?.status !== 'unchanged') fail('commit_failed', 'The editor did not commit the automation edit')
    }
    const publication = this.publishContext(ctx, owner), after = owner.document
    if (publication.applied && committed && ctx.duplicationResult)
      this.editor.rememberDuplication(committedResult, ctx.duplicationResult.roots, ctx.duplicationResult.reference, publication.pageId)
    const changedIds = [...new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])].filter(id => !equalValue(before.nodes[id], after.nodes[id]))
    const previousIds = knownIds(before), currentIds = knownIds(after)
    const createdIds = [...currentIds].filter(id => !previousIds.has(id))
    const completion: AutomationMutationCompletion | undefined = publication.applied ? undefined : {
      ...receiptIdentity(owner), superseded: true, contextApplied: false,
      ...(committed ? { status: 'committed', retry: 'do-not-retry' } as const : { status: 'unchanged', retry: 'read-current-state' } as const),
    }
    return { identity: receiptIdentity(owner), result: { operations: results, changedIds, createdIds, ...summarizeChanges(before, after), noChange: !committed,
      pageId: publication.pageId, selection: publication.selection, canUndo: owner.canUndo, canRedo: owner.canRedo,
      ...(completion ? { completion } : {}) } }
  }
  execute(input: unknown): AutomationResponse {
    let request: AutomationRequest | undefined, resultIdentity: MutationIdentity | undefined, committedReceipt: CommittedEditReceipt | undefined
    const observeCommit = (receipt: CommittedEditReceipt) => { committedReceipt = receipt; resultIdentity = receiptIdentity(receipt) }
    const response = () => ({ ...(request?.id === undefined ? {} : { id: request.id }), method: request?.method || '',
      ...(resultIdentity ?? { documentId: this.editor.state.doc.id, revision: this.editor.state.version, session: this.editor.sessionGeneration }) })
    try {
      if (this.disposed) fail('disposed', 'The automation session has been closed')
      jsonAdmission(input)
      const requestBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength
      if (requestBytes > MAX_BYTES) fail('request_budget', 'Request exceeds 32 MiB')
      const raw = record(input, 'request')
      for (const key of Object.keys(raw)) if (!['id', 'method', 'params', 'expectedRevision', 'documentId', 'session'].includes(key)) fail('invalid_request', `Unsupported request field: ${key}`)
      if (raw.id !== undefined && typeof raw.id !== 'string' && typeof raw.id !== 'number') fail('invalid_request', 'id must be a string or number')
      if (typeof raw.id === 'string' && raw.id.length > 200) fail('invalid_request', 'id must not exceed 200 characters')
      for (const key of ['expectedRevision', 'session']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0)) fail('invalid_request', `${key} must be a nonnegative safe integer`)
      request = { ...raw, method: text(raw.method, 'method') } as unknown as AutomationRequest
      if (raw.documentId !== undefined) text(raw.documentId, 'documentId')
      const params = raw.params === undefined ? {} : record(raw.params, 'params')
      const largeImport = (method: unknown) => method === 'font.import' || method === 'document.import' || method === 'sketch.import' || method === 'clipboard.paste' || method === 'clipboard.pasteProperties'
      const largeRequest = largeImport(request.method) || request.method === 'batch.apply' && Array.isArray(params.operations) && params.operations.some(item => item && typeof item === 'object' && largeImport((item as { method?: unknown }).method))
      if (!largeRequest && requestBytes > DEFAULT_MAX_BYTES) fail('request_budget', 'Request exceeds the default 8 MiB budget; only font.import/document.import/sketch.import/clipboard.paste/clipboard.pasteProperties and batches containing them allow up to 32 MiB')
      const descriptor = this.descriptors.get(request.method)
      if (!descriptor) fail('unsupported_method', `Unsupported automation method: ${request.method}`)
      checkSchema(params, descriptor.inputSchema)
      // Authorization precedes receipt replay, history, reads and draft execution.
      // Preauthorize the entire batch so even trusted extension callbacks cannot
      // run when a later operation is denied. Staging still owns atomic commit.
      this.authorize(request.method)
      if (request.method === 'batch.apply' || request.method === 'batch.preflight') {
        for (const item of params.operations as { method: string }[]) this.authorize(item.method)
      }
      const isBatch = request.method === 'batch.apply' || request.method === 'batch.preflight'
      const originalOperations = isBatch ? params.operations as { method: string; params?: Record<string, unknown> }[]
        : descriptor.mutates && !request.method.startsWith('history.') ? [{ method: request.method, params }] : undefined
      const operations = originalOperations ? this.expandOperations(originalOperations, request.method === 'batch.preflight') : undefined
      const owner = `${this.editor.state.doc.id}:${this.editor.sessionGeneration}`
      if (owner !== this.receiptOwner) { this.receipts.clear(); this.receiptBytes = 0; this.receiptOwner = owner }
      let fingerprint: string | undefined, mutationId: string | undefined
      if (request.method === 'batch.apply' && params.mutationId !== undefined) {
        mutationId = params.mutationId as string
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(mutationId)) fail('invalid_params', 'mutationId must contain 1–128 ASCII letters, digits, underscores or hyphens')
        if (request.expectedRevision === undefined || request.documentId === undefined || request.session === undefined) fail('missing_revision', 'Mutations require expectedRevision, documentId and session from a fresh read response')
        // An exact successful retry may have a stale revision, but never a foreign document/session.
        this.requireFence({ ...request, expectedRevision: undefined }, false)
        fingerprint = canonicalJson({ method: request.method, params, documentId: request.documentId, session: request.session, expectedRevision: request.expectedRevision })
        const receipt = this.receipts.get(mutationId)
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) fail('mutation_conflict', 'mutationId was already committed with different arguments or fences')
          const result = structuredClone(receipt.result)
          result.receipt = { ...result.receipt as Record<string, unknown>, replayed: true }
          return { ...response(), ok: true, result }
        }
        if (this.receipts.size >= RECEIPT_LIMIT || this.receiptBytes + new TextEncoder().encode(fingerprint).byteLength > RECEIPT_BYTES)
          fail('receipt_limit', 'The document-session receipt budget is full; read state and start a new document session before submitting another receipted mutation')
      }
      this.requireFence(request, descriptor.mutates || request.method === 'clipboard.export')
      let result: unknown
      if (request.method === 'api.capabilities') result = this.capabilities()
      else if (request.method === 'history.undo' || request.method === 'history.redo') {
        const initial: CommittedEditReceipt = { document: this.editor.state.doc, documentId: this.editor.state.doc.id,
          session: this.editor.sessionGeneration, revision: this.editor.state.version, pageId: this.editor.state.page,
          selection: [...this.editor.state.selection], canUndo: this.editor.canUndo, canRedo: this.editor.canRedo }
        const possible = request.method === 'history.undo' ? initial.canUndo : initial.canRedo
        const historyResult = request.method === 'history.undo' ? this.editor.undo('automation') : this.editor.redo('automation')
        const receipt = this.editor.committedEditReceipt(historyResult)
        const owner = receipt ?? initial
        resultIdentity = receiptIdentity(owner)
        if (receipt) observeCommit(receipt)
        const superseded = this.editor.state.doc !== owner.document || this.editor.sessionGeneration !== owner.session ||
          this.editor.state.version !== owner.revision || this.editor.state.page !== owner.pageId || !equalValue(this.editor.state.selection, owner.selection)
        if (historyResult?.status === 'committed' && !receipt) fail('commit_receipt_unavailable', 'History committed but its trusted result receipt is unavailable; read state before another operation',
          { committed: true, retry: 'do-not-retry', ...receiptIdentity({ ...initial, revision: historyResult.revision }) })
        if (possible && !receipt) fail('commit_failed', 'The editor did not commit the history operation',
          { committed: false, superseded, retry: 'read-current-state', ...receiptIdentity(initial) })
        const completion: AutomationMutationCompletion | undefined = superseded ? {
          ...receiptIdentity(owner), superseded: true, contextApplied: false,
          ...(receipt ? { status: 'committed', retry: 'do-not-retry' } as const : { status: 'unchanged', retry: 'read-current-state' } as const),
        } : undefined
        result = { noChange: !receipt, canUndo: owner.canUndo, canRedo: owner.canRedo,
          pageId: owner.pageId, selection: [...owner.selection], ...(completion ? { completion } : {}) }
      } else if (request.method === 'batch.preflight') result = this.preflight(operations!)
      else if (request.method === 'batch.apply') {
        const execution = this.mutate(request, operations!, params.label === undefined ? 'AI design batch' : text(params.label, 'label', 200), fingerprint === undefined ? undefined : new TextEncoder().encode(fingerprint).byteLength, originalOperations!, observeCommit)
        result = execution.result; resultIdentity = execution.identity
      } else if (descriptor.mutates) {
        const execution = this.mutate(request, operations!, `AI: ${request.method}`, undefined, originalOperations!, observeCommit)
        result = execution.result; resultIdentity = execution.identity
      }
      else {
        const snapshot = structuredClone(this.editor.authoredDocument)
        result = this.entry(request.method).execute(snapshot, params, this.context())
        if (result && typeof result === 'object' && 'then' in result) fail('unsupported_async', 'This operation requires an explicitly scoped asynchronous host flow')
      }
      if (mutationId && fingerprint) {
        result = { ...result as Record<string, unknown>, receipt: { mutationId, revision: resultIdentity?.revision ?? this.editor.state.version, replayed: false } }
        const saved = structuredClone(result as Record<string, unknown>)
        const bytes = new TextEncoder().encode(fingerprint).byteLength + new TextEncoder().encode(JSON.stringify(saved)).byteLength
        // Reentrant subscribers may have opened another owner or stored another
        // receipt. Never roll that cache back or exceed the precommit budgets.
        if (!this.disposed && this.receiptOwner === owner && `${this.editor.state.doc.id}:${this.editor.sessionGeneration}` === owner &&
          !this.receipts.has(mutationId) && this.receipts.size < RECEIPT_LIMIT && this.receiptBytes + bytes <= RECEIPT_BYTES) {
          this.receipts.set(mutationId, { fingerprint, result: saved }); this.receiptBytes += bytes
        } else (result as Record<string, unknown>).receipt = { ...(result as Record<string, unknown>).receipt as object, replayAvailable: false }
      }
      return { ...response(), ok: true, result: structuredClone(result ?? null) }
    } catch (error) {
      const failure = error instanceof AutomationError ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
        : { code: 'invalid_operation', message: error instanceof Error ? error.message : String(error) }
      if (committedReceipt) failure.details = { ...(failure.details && typeof failure.details === 'object' ? failure.details : {}),
        committed: true, retry: 'do-not-retry', ...receiptIdentity(committedReceipt) }
      failure.message = failure.message.slice(0, 4096)
      return { ...response(), ok: false, error: failure }
    }
  }
}
export function createDesignAutomation(editor: Editor, extensions: AutomationExtension[] = [], validators: ((document: DesignDocument) => void)[] = [], permissions?: AutomationPermissionPolicy): DesignAutomationApi {
  return new DesignAutomationApi(editor, extensions, validators, permissions)
}
