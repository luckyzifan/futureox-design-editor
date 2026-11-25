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
export type PluginStoredValue =
  | { kind: 'undefined' }
  | { kind: 'json'; json: string }
  | { kind: 'bytes'; rawBytes: number; parts: string[] }
export type PluginStorageOperation =
  | { kind: 'get' | 'delete'; key: string }
  | { kind: 'keys' }
  | { kind: 'set'; key: string; value: PluginStoredValue }
export type PluginStorageRequest = (operation: PluginStorageOperation) => Promise<unknown>

const BYTE_PARTS = 48
const BYTE_PART_CHARS = 200_000
type PendingBytes = { parts: string[]; length: number; rawBytes: number; expected: number }
const writers = new WeakMap<PluginStorage, ReturnType<typeof createClientStorageWriter>>()

export function storageKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > PLUGIN_LIMITS.clientStorageKeyChars || /[\u0000-\u001f]/.test(value))
    throw new PluginApiError('invalid_value', `clientStorage key must be 1–${PLUGIN_LIMITS.clientStorageKeyChars} characters`)
  if (value === '__proto__' || value === 'constructor' || value === 'prototype')
    throw new PluginApiError('invalid_value', 'clientStorage key is not allowed')
  return value
}

export function encodedStorageKey(key: string) {
  let result = ''
  for (let index = 0; index < key.length; index++) result += key.charCodeAt(index).toString(16).padStart(4, '0')
  return result
}

function decodedStorageKey(key: string) {
  let result = ''
  for (let index = 0; index < key.length; index += 4) result += String.fromCharCode(Number.parseInt(key.slice(index, index + 4), 16))
  return result
}

export function pluginStorageResult(operation: PluginStorageOperation, result: unknown) {
  if (operation.kind === 'keys') return (result as string[]).map(decodedStorageKey)
  if (operation.kind !== 'get') return null
  const entry = result as PluginStoredValue | null
  if (!entry) return { found: false, value: null }
  if (entry.kind === 'json') return { found: true, kind: 'json', value: JSON.parse(entry.json) }
  if (entry.kind === 'bytes') return { found: true, kind: 'bytes', parts: entry.parts, value: null }
  return { found: true, kind: 'undefined', value: null }
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
  const value = storageWriter(storage).prepare(`${pluginId}\0${name}`, write)
  if (!value) return
  const items = readItems(storage, pluginId)
  if (value.kind === 'json') items[name] = { t: 'j', v: JSON.parse(value.json) }
  else if (value.kind === 'undefined') items[name] = { t: 'u' }
  else items[name] = { t: 'b', n: value.rawBytes, parts: value.parts }
  writeItems(storage, pluginId, items)
}

export function clientStorageDelete(storage: PluginStorage, pluginId: string, key: unknown) {
  const name = storageKey(key)
  storageWriter(storage).cancel(`${pluginId}\0${name}`)
  const items = readItems(storage, pluginId)
  delete items[name]
  writeItems(storage, pluginId, items)
}

function storageWriter(storage: PluginStorage) {
  let writer = writers.get(storage)
  if (!writer) { writer = createClientStorageWriter(); writers.set(storage, writer) }
  return writer
}

export function createClientStorageWriter() {
  const uploads = new Map<string, PendingBytes>()
  return {
    clear: () => uploads.clear(),
    cancel: (key: string) => uploads.delete(key),
    prepare(key: string, write: string | ClientStorageWrite): PluginStoredValue | undefined {
      if (typeof write === 'string') {
        uploads.delete(key)
        try { JSON.parse(write) } catch { throw new PluginApiError('invalid_value', 'clientStorage value must be JSON') }
        return { kind: 'json', json: write }
      }
      if (write.kind === 'undefined') { uploads.delete(key); return write }
      if (!Number.isInteger(write.part) || !Number.isInteger(write.parts) || !Number.isInteger(write.rawBytes))
        throw new PluginApiError('invalid_value', 'clientStorage bytes are incomplete')
      if (write.parts < 1 || write.parts > BYTE_PARTS || write.rawBytes < 0 || write.rawBytes > PLUGIN_LIMITS.clientStorageBytes)
        throw new PluginApiError('plugin_limit', `clientStorage is limited to ${PLUGIN_LIMITS.clientStorageBytes} bytes per plugin`)
      if (write.part === 0) {
        uploads.delete(key)
        let reserved = write.rawBytes
        for (const upload of uploads.values()) reserved += upload.rawBytes
        if (reserved > PLUGIN_LIMITS.clientStorageBytes || uploads.size >= BYTE_PARTS)
          throw new PluginApiError('plugin_limit', 'Too many pending clientStorage uploads')
        uploads.set(key, { parts: [], length: 0, rawBytes: write.rawBytes, expected: write.parts })
      }
      const pending = uploads.get(key)
      if (!pending || write.part !== pending.parts.length || write.parts !== pending.expected || write.rawBytes !== pending.rawBytes)
        throw new PluginApiError('invalid_value', 'clientStorage byte upload is out of order')
      try {
        pending.length += decodedLength(write.base64)
        pending.parts.push(write.base64)
        if (pending.length > pending.rawBytes ||
            pending.parts.length === pending.expected && pending.length !== pending.rawBytes)
          throw new PluginApiError('invalid_value', 'clientStorage bytes do not match the declared length')
        if (pending.parts.length < pending.expected) return
        uploads.delete(key)
        return { kind: 'bytes', rawBytes: pending.rawBytes, parts: pending.parts }
      } catch (error) {
        uploads.delete(key)
        throw error
      }
    },
  }
}
