import type { DesignDocument } from '../model'
import { AutomationError } from './types'

export type AppValue = string | number | boolean | null
export type AppFieldType = 'string' | 'number' | 'boolean'
export type AppCollection = { id: string; fields: { name: string; type: AppFieldType }[]; records?: ({ id: string } & Record<string, AppValue>)[] }
export type AppStep = { kind: 'navigate'; to: string } | { kind: 'state.set'; key: string; value: AppValue } | { kind: 'state.toggle'; key: string } | { kind: 'form.reset'; form: string }
export type AppFormField = { nodeId: string; name: string; label: string; type: 'text' | 'email' | 'number' | 'checkbox'; required?: boolean; minLength?: number; maxLength?: number; min?: number; max?: number }
export type AppForm = { id: string; nodeId: string; collection: string; submitNodeId: string; submitLabel: string; fields: AppFormField[]; successRoute?: string }
export type AppDefinition = {
  id: string
  routes: { path: string; nodeId: string; title: string; pageId?: string }[]
  initialRoute: string
  state: Record<string, AppValue>
  actions: { nodeId: string; label: string; steps: AppStep[] }[]
  collections: AppCollection[]
  forms: AppForm[]
  lists: { nodeId: string; collection: string; label: string; columns: { field: string; label: string }[]; editForm?: string; editRoute?: string; allowDelete?: boolean; emptyText?: string }[]
  textBindings: { nodeId: string; state?: string; collectionCount?: string; prefix?: string }[]
}
export const APP_LIMITS = Object.freeze({ configBytes: 256 * 1024, routes: 16, actions: 128, forms: 32, lists: 32, collections: 16, fields: 24, records: 500, string: 4096, storageBytes: 2 * 1024 * 1024 })
const bad = (message: string): never => { throw new AutomationError('invalid_params', `app.export: ${message}`) }
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
function json(value: unknown, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 30000 || depth > 20) bad('configuration exceeds structural limits')
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (!value || typeof value !== 'object') bad('configuration must contain plain JSON values')
  const proto = Object.getPrototypeOf(value)
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) bad('configuration must contain plain JSON objects')
  if (Array.isArray(value)) {
    if (value.length > 30000 || Object.getOwnPropertyNames(value).some(k => k !== 'length' && !/^(0|[1-9][0-9]*)$/.test(k))) bad('configuration arrays exceed the plain JSON budget')
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) bad('configuration arrays must be dense plain JSON arrays')
  }
  if (Object.getOwnPropertySymbols(value).length) bad('symbol keys are unsupported')
  for (const key of Object.getOwnPropertyNames(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const property = Object.getOwnPropertyDescriptor(value, key)!
    if (forbidden.has(key) || !('value' in property) || !property.enumerable) bad(`unsafe configuration key ${key}`)
    json(property.value, depth + 1, budget)
  }
}
function object(value: unknown, keys: string[], label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${label} must be an object`)
  for (const key of Object.keys(value as object)) if (!keys.includes(key)) bad(`${label}.${key} is unsupported`)
  return value as Record<string, any>
}
function text(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad(`${label} must contain 1–${max} characters`)
  return value as string
}
function key(value: unknown, label: string): string {
  const s = text(value, label, 64)
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(s) || forbidden.has(s) || /password|secret|credential|api[_-]?key|access[_-]?token|authorization/i.test(s)) bad(`${label} must be a safe, non-secret identifier`)
  return s
}
function array(value: unknown, max: number, label: string): any[] {
  if (!Array.isArray(value) || value.length > max) bad(`${label} must be an array with at most ${max} entries`)
  return value as any[]
}
function unique(values: string[], label: string) { if (new Set(values).size !== values.length) bad(`duplicate ${label}`) }
function scalar(value: unknown): value is AppValue { return value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= APP_LIMITS.string || typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12 }
function typeMatches(value: AppValue, type: AppFieldType) { return value === null || typeof value === type }

/** Closed, versioned behavior language. No scripts, URLs, expressions, secrets,
 * service credentials, or inferred production backend are accepted. */
export function validateAppDefinition(document: DesignDocument, pageId: string, input: unknown): AppDefinition {
  json(input)
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > APP_LIMITS.configBytes) bad('configuration exceeds 256 KiB')
  const raw = object(input, ['id', 'routes', 'initialRoute', 'state', 'actions', 'collections', 'forms', 'lists', 'textBindings'], 'app')
  const page = document.pages.find(p => p.id === pageId)
  if (!page) bad('page does not exist')
  const app = { ...raw, initialRoute: raw.initialRoute ?? raw.routes?.[0]?.path, state: raw.state ?? {}, actions: raw.actions ?? [], collections: raw.collections ?? [], forms: raw.forms ?? [], lists: raw.lists ?? [], textBindings: raw.textBindings ?? [] } as AppDefinition
  key(app.id, 'app.id')
  const descendants = new Set<string>(), parent = new Map<string, string>()
  for (const route of array(app.routes, APP_LIMITS.routes, 'routes')) {
    object(route, ['path', 'nodeId', 'title', 'pageId'], 'route')
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(text(route.path, 'route.path', 128))) bad('routes must be local slash paths without query, fragment, or protocol')
    text(route.title, 'route.title'); text(route.nodeId, 'route.nodeId', 128)
    const routePage = route.pageId === undefined ? page : document.pages.find(p => p.id === route.pageId)
    const n = document.nodes[route.nodeId]
    if (!routePage || !Object.hasOwn(document.nodes, route.nodeId) || !routePage.children.includes(route.nodeId) || !['frame', 'section', 'group'].includes(n.kind)) bad('route.nodeId must identify a real authored page-root container on its pageId')
    if (!n.visible) bad('route container must be visible')
    const pending = [route.nodeId]
    while (pending.length) {
      const id = pending.pop()!
      if (descendants.has(id)) bad('routes must be distinct, non-overlapping trees')
      descendants.add(id)
      const node = document.nodes[id]
      if (!node) bad('route tree contains a missing node')
      for (const child of node.children) { parent.set(child, id); pending.push(child) }
    }
  }
  if (!app.routes.length) bad('at least one route is required')
  unique(app.routes.map(r => r.path), 'route path')
  const routePaths = new Set(app.routes.map(r => r.path)), routeNodes = new Set(app.routes.map(r => r.nodeId))
  const checkRoute = (path: string) => { if (!routePaths.has(path)) bad(`unknown route ${path}`) }
  checkRoute(app.initialRoute)
  const roles = new Map<string, string>()
  const claim = (id: unknown, role: string, leaf = false) => {
    text(id, `${role}.nodeId`, 128)
    const nodeId = id as string
    if (!descendants.has(nodeId) || !Object.hasOwn(document.nodes, nodeId)) bad(`${role} references a node outside the authored route trees`)
    let ancestor: string | undefined = nodeId
    while (ancestor) { if (!document.nodes[ancestor].visible || document.nodes[ancestor].kind === 'slice') bad(`${role} must be visible through its authored ancestors`); ancestor = parent.get(ancestor) }
    if (roles.has(nodeId) || routeNodes.has(nodeId)) bad(`node ${nodeId} has incompatible semantic roles`)
    if (leaf && document.nodes[nodeId].children.length) bad(`${role} must reference a leaf node`)
    roles.set(nodeId, role)
  }
  const isWithin = (id: string, ancestor: string) => { let next: string | undefined = id; while (next) { if (next === ancestor) return true; next = parent.get(next) } return false }
  object(app.state, Object.keys(app.state), 'state')
  if (Object.keys(app.state).length > 64) bad('state exceeds 64 keys')
  for (const [name, value] of Object.entries(app.state)) { key(name, 'state key'); if (!scalar(value) || value === null) bad('state values must be bounded strings, booleans or numbers') }
  for (const c of array(app.collections, APP_LIMITS.collections, 'collections')) {
    object(c, ['id', 'fields', 'records'], 'collection'); key(c.id, 'collection.id')
    for (const f of array(c.fields, APP_LIMITS.fields, 'collection.fields')) { object(f, ['name', 'type'], 'collection field'); key(f.name, 'field.name'); if (f.name === 'id' || !['string', 'number', 'boolean'].includes(f.type)) bad('collection fields require a non-id name and string/number/boolean type') }
    if (!c.fields.length) bad('collection requires fields')
    unique(c.fields.map((f: { name: string }) => f.name), 'collection field')
    for (const record of array(c.records ?? [], APP_LIMITS.records, 'records')) {
      object(record, ['id', ...c.fields.map((f: { name: string }) => f.name)], 'record'); key(record.id, 'record.id')
      for (const f of c.fields) if (!Object.hasOwn(record, f.name) || !scalar(record[f.name]) || !typeMatches(record[f.name], f.type)) bad(`invalid record field ${f.name}`)
    }
    unique((c.records ?? []).map((r: { id: string }) => r.id), 'record id')
  }
  unique(app.collections.map(c => c.id), 'collection id')
  const collections = new Map(app.collections.map(c => [c.id, c]))
  for (const f of array(app.forms, APP_LIMITS.forms, 'forms')) {
    object(f, ['id', 'nodeId', 'collection', 'submitNodeId', 'submitLabel', 'fields', 'successRoute'], 'form')
    key(f.id, 'form.id'); claim(f.nodeId, 'form'); claim(f.submitNodeId, 'submit')
    if (!['frame', 'section', 'group'].includes(document.nodes[f.nodeId].kind)) bad('form must reference an authored container')
    if (!isWithin(f.submitNodeId, f.nodeId)) bad('submit node must be inside its form')
    text(f.submitLabel, 'submitLabel')
    const c = collections.get(f.collection); if (!c) bad('form references an unknown collection')
    for (const field of array(f.fields, APP_LIMITS.fields, 'form.fields')) {
      object(field, ['nodeId', 'name', 'label', 'type', 'required', 'minLength', 'maxLength', 'min', 'max'], 'form field'); claim(field.nodeId, 'input', true)
      if (!isWithin(field.nodeId, f.nodeId)) bad('field node must be inside its form')
      text(field.label, 'field.label'); key(field.name, 'field.name')
      if (!['text', 'email', 'number', 'checkbox'].includes(field.type)) bad('unsupported input type')
      const type = field.type === 'number' ? 'number' : field.type === 'checkbox' ? 'boolean' : 'string'
      if (c!.fields.find(item => item.name === field.name)?.type !== type) bad('form field type must match its collection')
      if (field.required !== undefined && typeof field.required !== 'boolean') bad('required must be boolean')
      for (const p of ['minLength', 'maxLength']) if (field[p] !== undefined && (!['text', 'email'].includes(field.type) || !Number.isInteger(field[p]) || field[p] < 0 || field[p] > APP_LIMITS.string)) bad(`${p} must be an integer in 0–4096 on a text field`)
      for (const p of ['min', 'max']) if (field[p] !== undefined && (field.type !== 'number' || typeof field[p] !== 'number' || !Number.isFinite(field[p]) || Math.abs(field[p]) > 1e12)) bad(`${p} must be a finite bound on a number field`)
      if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength || field.min !== undefined && field.max !== undefined && field.min > field.max) bad('field bounds are reversed')
    }
    unique(f.fields.map((item: AppFormField) => item.name), 'form field')
    if (f.fields.length !== c!.fields.length) bad('form must cover every collection field exactly once')
    if (f.successRoute !== undefined) checkRoute(f.successRoute)
  }
  unique(app.forms.map(f => f.id), 'form id')
  for (const f of app.forms) for (const other of app.forms) if (f !== other && isWithin(f.nodeId, other.nodeId)) bad('nested forms are unsupported')
  const forms = new Map(app.forms.map(f => [f.id, f]))
  for (const a of array(app.actions, APP_LIMITS.actions, 'actions')) {
    object(a, ['nodeId', 'label', 'steps'], 'action'); claim(a.nodeId, 'button'); text(a.label, 'action.label')
    if (!array(a.steps, 8, 'action.steps').length) bad('action requires at least one step')
    for (const step of a.steps) {
      if (step?.kind === 'navigate') { object(step, ['kind', 'to'], 'navigate'); checkRoute(step.to) }
      else if (step?.kind === 'form.reset') { object(step, ['kind', 'form'], 'form.reset'); if (!forms.has(step.form)) bad('reset references an unknown form') }
      else if (step?.kind === 'state.set' || step?.kind === 'state.toggle') {
        object(step, step.kind === 'state.set' ? ['kind', 'key', 'value'] : ['kind', 'key'], step.kind)
        if (!Object.hasOwn(app.state, step.key)) bad('state action references an unknown state key')
        if (step.kind === 'state.toggle' ? typeof app.state[step.key] !== 'boolean' : !scalar(step.value) || typeof app.state[step.key] !== typeof step.value) bad('state action has an incompatible value type')
      } else bad('unsupported action kind; arbitrary JavaScript and network actions are unavailable')
    }
  }
  for (const list of array(app.lists, APP_LIMITS.lists, 'lists')) {
    object(list, ['nodeId', 'collection', 'label', 'columns', 'editForm', 'editRoute', 'allowDelete', 'emptyText'], 'list'); claim(list.nodeId, 'list', true); text(list.label, 'list.label')
    const c = collections.get(list.collection); if (!c) bad('list references an unknown collection')
    if (!array(list.columns, APP_LIMITS.fields, 'columns').length) bad('list requires columns')
    for (const column of list.columns) { object(column, ['field', 'label'], 'column'); text(column.label, 'column.label'); if (!c!.fields.some(f => f.name === column.field)) bad('list column references an unknown collection field') }
    unique(list.columns.map((column: { field: string }) => column.field), 'list column')
    if (list.allowDelete !== undefined && typeof list.allowDelete !== 'boolean') bad('allowDelete must be boolean')
    if (list.emptyText !== undefined) text(list.emptyText, 'emptyText')
    if (list.editForm !== undefined) {
      const form = forms.get(list.editForm); if (!form || form.collection !== list.collection) bad('list editForm must target the same collection')
      if (!list.editRoute) bad('editable lists require editRoute')
      checkRoute(list.editRoute)
      if (!isWithin(form!.nodeId, app.routes.find(r => r.path === list.editRoute)!.nodeId)) bad('editForm must be visible on editRoute')
    } else if (list.editRoute !== undefined) bad('editRoute requires editForm')
  }
  for (const b of array(app.textBindings, 128, 'textBindings')) {
    object(b, ['nodeId', 'state', 'collectionCount', 'prefix'], 'textBinding'); claim(b.nodeId, 'text binding', true)
    if ((b.state === undefined) === (b.collectionCount === undefined)) bad('textBinding requires exactly one state or collectionCount source')
    if (b.state !== undefined && !Object.hasOwn(app.state, b.state) || b.collectionCount !== undefined && !collections.has(b.collectionCount)) bad('textBinding references an unknown source')
    if (b.prefix !== undefined && (typeof b.prefix !== 'string' || b.prefix.length > 160)) bad('text prefix exceeds 160 characters')
  }
  // Native buttons must not contain another interactive/form/list/binding node.
  for (const [id, role] of roles) if (role === 'button' || role === 'submit') for (const other of roles.keys()) if (id !== other && isWithin(other, id)) bad('interactive buttons cannot contain other semantic bindings')
  return structuredClone(app)
}
