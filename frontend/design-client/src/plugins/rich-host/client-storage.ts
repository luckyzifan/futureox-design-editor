import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

export type PluginStorage = {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

const PREFIX = 'futureox.plugin.clientStorage.v1:'
const memory = new Map<string, string>()

export function clientStorageKey(pluginId: string) {
  return PREFIX + encodeURIComponent(pluginId)
}

export function memoryPluginStorage(): PluginStorage {
  const values = new Map<string, string>()
  return {
    get: key => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value) },
    remove: key => { values.delete(key) },
  }
}

/** localStorage when the page has it. Otherwise a process map so a plugin can still round-trip in this session. */
export function defaultPluginStorage(): PluginStorage {
  const local = typeof localStorage === 'undefined' ? null : localStorage
  if (!local) {
    return {
      get: key => memory.get(key) ?? null,
      set: (key, value) => { memory.set(key, value) },
      remove: key => { memory.delete(key) },
    }
  }
  return {
    get(key) {
      try { return local.getItem(key) } catch { return null }
    },
    set(key, value) {
      try { local.setItem(key, value) }
      catch { throw new PluginApiError('storage_failed', 'clientStorage could not be saved in this browser profile') }
    },
    remove(key) {
      try { local.removeItem(key) } catch { /* A failed delete leaves the previous value. The caller still reports it. */ }
    },
  }
}

type JsonEntry = { t: 'j'; v: unknown }
type UndefinedEntry = { t: 'u' }
type BytesEntry = { t: 'b'; n: number; parts: string[] }
type Entry = JsonEntry | UndefinedEntry | BytesEntry
type Stored = { __v: 2; items: Record<string, Entry> }
export type ClientStorageWrite =
  | { kind: 'undefined' }
  | { kind: 'bytes'; part: number; parts: number; rawBytes: number; base64: string }

const BYTE_PARTS = 48
const BYTE_PART_CHARS = 200_000
type PendingBytes = { parts: string[]; lengths: number[]; rawBytes: number; expected: number; next: number }
const pendingBytes = new Map<string, PendingBytes>()

function storageKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > PLUGIN_LIMITS.clientStorageKeyChars || /[\u0000-\u001f]/.test(value))
    throw new PluginApiError('invalid_value', `clientStorage key must be 1–${PLUGIN_LIMITS.clientStorageKeyChars} characters`)
  if (value === '__proto__' || value === 'constructor' || value === 'prototype')
    throw new PluginApiError('invalid_value', 'clientStorage key is not allowed')
  return value
}

function pendingId(pluginId: string, key: string) {
  return `${pluginId}\0${key}`
}

function readItems(storage: PluginStorage, pluginId: string): Record<string, Entry> {
  const raw = storage.get(clientStorageKey(pluginId))
  if (!raw) return {}
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new PluginApiError('storage_failed', 'clientStorage for this plugin is not valid JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Stored & Record<string, unknown>
  if (record.__v === 2 && record.items && typeof record.items === 'object' && !Array.isArray(record.items)) return record.items
  const items: Record<string, Entry> = {}
  for (const [key, value] of Object.entries(record)) items[key] = { t: 'j', v: value }
  return items
}

function entryBytes(key: string, entry: Entry) {
  const keyBytes = new TextEncoder().encode(key).byteLength
  if (entry.t === 'u') return keyBytes
  if (entry.t === 'b') return keyBytes + entry.n
  return keyBytes + new TextEncoder().encode(JSON.stringify(entry.v)).byteLength
}

function writeItems(storage: PluginStorage, pluginId: string, items: Record<string, Entry>) {
  const keys = Object.keys(items)
  if (keys.length > PLUGIN_LIMITS.clientStorageKeys)
    throw new PluginApiError('plugin_limit', `clientStorage accepts at most ${PLUGIN_LIMITS.clientStorageKeys} keys`)
  let total = 0
  for (const key of keys) total += entryBytes(key, items[key])
  if (total > PLUGIN_LIMITS.clientStorageBytes)
    throw new PluginApiError('plugin_limit', `clientStorage is limited to ${PLUGIN_LIMITS.clientStorageBytes} bytes per plugin`)
  const stored = clientStorageKey(pluginId)
  if (!keys.length) storage.remove(stored)
  else storage.set(stored, JSON.stringify({ __v: 2, items } satisfies Stored))
}

function decodedLength(base64: string) {
  if (base64.length > BYTE_PART_CHARS || base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64))
    throw new PluginApiError('invalid_value', 'clientStorage bytes are not valid base64')
  return atob(base64).length
}

export function clientStorageGet(storage: PluginStorage, pluginId: string, key: unknown): { found: boolean; kind?: 'json' | 'undefined' | 'bytes'; value: unknown; parts?: string[] } {
  const items = readItems(storage, pluginId)
  const name = storageKey(key)
  if (!Object.prototype.hasOwnProperty.call(items, name)) return { found: false, value: null }
  const entry = items[name]
  if (entry.t === 'u') return { found: true, kind: 'undefined', value: null }
  if (entry.t === 'b') return { found: true, kind: 'bytes', value: null, parts: entry.parts }
  return { found: true, kind: 'json', value: entry.v }
}

export function clientStorageKeys(storage: PluginStorage, pluginId: string): string[] {
  return Object.keys(readItems(storage, pluginId))
}

export function clientStorageSet(storage: PluginStorage, pluginId: string, key: unknown, write: string | ClientStorageWrite) {
  const name = storageKey(key)
  const id = pendingId(pluginId, name)
  const items = readItems(storage, pluginId)
  if (typeof write === 'string' || write.kind === 'undefined') {
    pendingBytes.delete(id)
    if (typeof write === 'string') {
      let value: unknown
      try { value = JSON.parse(write) } catch { throw new PluginApiError('invalid_value', 'clientStorage value must be JSON') }
      items[name] = { t: 'j', v: value }
    } else items[name] = { t: 'u' }
    writeItems(storage, pluginId, items)
    return
  }
  if (!Number.isInteger(write.part) || !Number.isInteger(write.parts) || !Number.isInteger(write.rawBytes))
    throw new PluginApiError('invalid_value', 'clientStorage bytes are incomplete')
  if (write.parts < 1 || write.parts > BYTE_PARTS || write.rawBytes < 0 || write.rawBytes > PLUGIN_LIMITS.clientStorageBytes)
    throw new PluginApiError('plugin_limit', `clientStorage is limited to ${PLUGIN_LIMITS.clientStorageBytes} bytes per plugin`)
  if (write.part === 0) pendingBytes.set(id, { parts: [], lengths: [], rawBytes: write.rawBytes, expected: write.parts, next: 0 })
  const pending = pendingBytes.get(id)
  if (!pending || write.part !== pending.next || write.parts !== pending.expected || write.rawBytes !== pending.rawBytes)
    throw new PluginApiError('invalid_value', 'clientStorage byte upload is out of order')
  pending.lengths.push(decodedLength(write.base64))
  pending.parts.push(write.base64)
  pending.next += 1
  if (pending.next < pending.expected) return
  pendingBytes.delete(id)
  const total = pending.lengths.reduce((sum, length) => sum + length, 0)
  if (total !== pending.rawBytes) throw new PluginApiError('invalid_value', 'clientStorage bytes do not match the declared length')
  items[name] = { t: 'b', n: pending.rawBytes, parts: pending.parts }
  writeItems(storage, pluginId, items)
}

export function clientStorageDelete(storage: PluginStorage, pluginId: string, key: unknown) {
  const name = storageKey(key)
  pendingBytes.delete(pendingId(pluginId, name))
  const items = readItems(storage, pluginId)
  delete items[name]
  writeItems(storage, pluginId, items)
}
