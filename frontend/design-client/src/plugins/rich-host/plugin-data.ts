import type { DesignDocument } from '../../model'
import { validateFdCompatibility } from '../../fd-extensions'
import type { AutomationExtension } from '../../automation'
import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

/** Inert FD extension. Plugin strings ride the document and undo with the edit that wrote them. */
export const PLUGIN_DATA_NAMESPACE = 'design.futureox/plugin-data'

type Bucket = Record<string, string>
type ByPlugin = Record<string, Bucket>
type ByTarget = Record<string, ByPlugin>
type SharedGroup = { nodes?: Record<string, Bucket>; pages?: Record<string, Bucket>; root?: Bucket }

export type PluginDataStore = {
  nodes?: ByTarget
  pages?: ByTarget
  root?: ByPlugin
  shared?: Record<string, SharedGroup>
}

export type PluginDataScope = 'node' | 'page' | 'root'

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

function dataKey(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > PLUGIN_LIMITS.pluginDataKeyChars || /[\u0000-\u001f]/.test(value) || UNSAFE.has(value))
    throw new PluginApiError('invalid_value', `${label} must be 1–${PLUGIN_LIMITS.pluginDataKeyChars} characters`)
  return value
}

function namespaceKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > PLUGIN_LIMITS.pluginDataKeyChars || /[\u0000-\u001f]/.test(value) || UNSAFE.has(value))
    throw new PluginApiError('invalid_value', 'shared plugin data namespace must be 1–100 characters')
  return value
}

export function readPluginData(document: DesignDocument): PluginDataStore {
  const raw = document.fdCompatibility?.extensions?.[PLUGIN_DATA_NAMESPACE]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return structuredClone(raw) as PluginDataStore
}

function bucket(store: PluginDataStore, scope: PluginDataScope, id: string, pluginId: string): Bucket {
  if (scope === 'root') return store.root?.[pluginId] ?? {}
  const table = scope === 'page' ? store.pages : store.nodes
  return table?.[id]?.[pluginId] ?? {}
}

function sharedBucket(store: PluginDataStore, scope: PluginDataScope, id: string, namespace: string): Bucket {
  const group = store.shared?.[namespace]
  if (!group) return {}
  if (scope === 'root') return group.root ?? {}
  return (scope === 'page' ? group.pages : group.nodes)?.[id] ?? {}
}

export function pluginDataGet(store: PluginDataStore, scope: PluginDataScope, id: string, pluginId: string, key: unknown): string {
  return bucket(store, scope, id, pluginId)[dataKey(key, 'plugin data key')] ?? ''
}

export function pluginDataKeys(store: PluginDataStore, scope: PluginDataScope, id: string, pluginId: string): string[] {
  return Object.keys(bucket(store, scope, id, pluginId))
}

export function sharedPluginDataGet(store: PluginDataStore, scope: PluginDataScope, id: string, namespace: unknown, key: unknown): string {
  return sharedBucket(store, scope, id, namespaceKey(namespace))[dataKey(key, 'shared plugin data key')] ?? ''
}

export function sharedPluginDataKeys(store: PluginDataStore, scope: PluginDataScope, id: string, namespace: unknown): string[] {
  return Object.keys(sharedBucket(store, scope, id, namespaceKey(namespace)))
}

function writeBucket(current: Bucket, key: string, value: string): Bucket | undefined {
  const next = { ...current }
  if (value === '') delete next[key]
  else {
    if (!Object.prototype.hasOwnProperty.call(next, key) && Object.keys(next).length >= PLUGIN_LIMITS.pluginDataKeys)
      throw new PluginApiError('plugin_limit', `A node accepts at most ${PLUGIN_LIMITS.pluginDataKeys} plugin data keys`)
    if (value.length > PLUGIN_LIMITS.pluginDataValueChars)
      throw new PluginApiError('invalid_value', `Plugin data values must be at most ${PLUGIN_LIMITS.pluginDataValueChars} characters`)
    next[key] = value
  }
  return Object.keys(next).length ? next : undefined
}

function putPlugin(table: ByTarget, id: string, pluginId: string, key: string, value: string): ByTarget {
  const next = { ...table, [id]: { ...table[id] } }
  const written = writeBucket(next[id][pluginId] ?? {}, key, value)
  if (written) next[id][pluginId] = written
  else delete next[id][pluginId]
  if (!Object.keys(next[id]).length) delete next[id]
  return next
}

export function pluginDataSet(store: PluginDataStore, scope: PluginDataScope, id: string, pluginId: string, key: unknown, value: unknown) {
  if (typeof value !== 'string') throw new PluginApiError('invalid_value', 'Plugin data values must be strings')
  const name = dataKey(key, 'plugin data key')
  if (!pluginId || pluginId.length > 128 || /[\u0000-\u001f]/.test(pluginId) || UNSAFE.has(pluginId))
    throw new PluginApiError('invalid_value', 'plugin id must be 1–128 characters')
  const plugin = pluginId
  if (scope === 'root') {
    const root = { ...store.root }
    const written = writeBucket(root[plugin] ?? {}, name, value)
    if (written) root[plugin] = written
    else delete root[plugin]
    store.root = Object.keys(root).length ? root : undefined
    return
  }
  const field = scope === 'page' ? 'pages' : 'nodes'
  const table = putPlugin(store[field] ?? {}, id, plugin, name, value)
  store[field] = Object.keys(table).length ? table : undefined
}

export function sharedPluginDataSet(store: PluginDataStore, scope: PluginDataScope, id: string, namespace: unknown, key: unknown, value: unknown) {
  if (typeof value !== 'string') throw new PluginApiError('invalid_value', 'Plugin data values must be strings')
  const space = namespaceKey(namespace)
  const name = dataKey(key, 'shared plugin data key')
  const shared = { ...store.shared }
  const group: SharedGroup = { ...shared[space] }
  if (scope === 'root') {
    const written = writeBucket(group.root ?? {}, name, value)
    if (written) group.root = written
    else delete group.root
  } else {
    const field = scope === 'page' ? 'pages' : 'nodes'
    const table = { ...group[field] }
    const written = writeBucket(table[id] ?? {}, name, value)
    if (written) table[id] = written
    else delete table[id]
    if (Object.keys(table).length) group[field] = table
    else delete group[field]
  }
  if (group.nodes || group.pages || group.root) shared[space] = group
  else delete shared[space]
  store.shared = Object.keys(shared).length ? shared : undefined
}

export function pluginDataEmpty(store: PluginDataStore) {
  return !store.nodes && !store.pages && !store.root && !store.shared
}

function dropMissing(document: DesignDocument, store: PluginDataStore): PluginDataStore {
  const pages = new Set(document.pages.map(page => page.id))
  const next: PluginDataStore = {}
  if (store.nodes) {
    const nodes = Object.fromEntries(Object.entries(store.nodes).filter(([id]) => document.nodes[id]))
    if (Object.keys(nodes).length) next.nodes = nodes
  }
  if (store.pages) {
    const kept = Object.fromEntries(Object.entries(store.pages).filter(([id]) => pages.has(id)))
    if (Object.keys(kept).length) next.pages = kept
  }
  if (store.root && Object.keys(store.root).length) next.root = store.root
  if (store.shared) {
    const shared: NonNullable<PluginDataStore['shared']> = {}
    for (const [space, group] of Object.entries(store.shared)) {
      const kept: SharedGroup = {}
      if (group.nodes) {
        const nodes = Object.fromEntries(Object.entries(group.nodes).filter(([id]) => document.nodes[id]))
        if (Object.keys(nodes).length) kept.nodes = nodes
      }
      if (group.pages) {
        const pageBuckets = Object.fromEntries(Object.entries(group.pages).filter(([id]) => pages.has(id)))
        if (Object.keys(pageBuckets).length) kept.pages = pageBuckets
      }
      if (group.root && Object.keys(group.root).length) kept.root = group.root
      if (kept.nodes || kept.pages || kept.root) shared[space] = kept
    }
    if (Object.keys(shared).length) next.shared = shared
  }
  return next
}

export const pluginDataExtension: AutomationExtension = {
  name: 'plugin.data.replace',
  description: 'Replace the design.futureox/plugin-data document extension. Used by the local plugin host inside one Editor.change. Not an MCP Figma alias.',
  mutates: true,
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['json'],
    properties: { json: { type: 'string', minLength: 2, maxLength: 900_000 } },
  },
  execute(document, params) {
    let parsed: PluginDataStore
    try { parsed = JSON.parse(String(params.json)) as PluginDataStore }
    catch { throw new PluginApiError('invalid_value', 'Plugin data payload is not JSON') }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new PluginApiError('invalid_value', 'Plugin data payload must be an object')
    const store = dropMissing(document, parsed)
    const current = document.fdCompatibility
      ? structuredClone(document.fdCompatibility)
      : { contractVersion: 1 as const, requiredCapabilities: [] as string[], extensions: {} as Record<string, unknown> }
    if (pluginDataEmpty(store)) delete current.extensions[PLUGIN_DATA_NAMESPACE]
    else current.extensions[PLUGIN_DATA_NAMESPACE] = store
    document.fdCompatibility = current.requiredCapabilities.length || Object.keys(current.extensions).length ? current : null
    validateFdCompatibility(document.fdCompatibility)
    return { namespace: PLUGIN_DATA_NAMESPACE }
  },
}
