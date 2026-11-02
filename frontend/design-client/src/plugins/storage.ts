import { PluginApiError } from './errors'
import { pluginLimits } from './limits'

export type PluginStorage = {
  get(pluginId: string, key: string): unknown
  set(pluginId: string, key: string, value: unknown): void
  delete(pluginId: string, key: string): void
  keys(pluginId: string): string[]
}

export function createMemoryPluginStorage(initial: Record<string, Record<string, unknown>> = {}): PluginStorage {
  const data = new Map<string, Map<string, unknown>>()
  for (const [pluginId, values] of Object.entries(initial)) data.set(pluginId, new Map(Object.entries(values)))
  return storageFromMap(data)
}

export function createBrowserPluginStorage(): PluginStorage {
  const memory = new Map<string, Map<string, unknown>>()
  return {
    get(pluginId, key) {
      checkKey(key)
      const values = readBucket(pluginId, memory)
      return values.has(key) ? values.get(key) : undefined
    },
    set(pluginId, key, value) {
      checkKey(key)
      const encoded = encodeValue(value)
      const values = readBucket(pluginId, memory)
      values.set(key, JSON.parse(encoded) as unknown)
      if (values.size > pluginLimits.storageKeys) throw new PluginApiError('storage', 'clientStorage is limited to 200 keys')
      persist(pluginId, values)
    },
    delete(pluginId, key) {
      checkKey(key)
      const values = readBucket(pluginId, memory)
      values.delete(key)
      persist(pluginId, values)
    },
    keys(pluginId) {
      return [...readBucket(pluginId, memory).keys()]
    },
  }
}

function storageFromMap(data: Map<string, Map<string, unknown>>): PluginStorage {
  return {
    get(pluginId, key) {
      checkKey(key)
      return data.get(pluginId)?.get(key)
    },
    set(pluginId, key, value) {
      checkKey(key)
      const encoded = encodeValue(value)
      const values = data.get(pluginId) ?? new Map<string, unknown>()
      values.set(key, JSON.parse(encoded) as unknown)
      if (values.size > pluginLimits.storageKeys || totalBytes(values) > pluginLimits.storageTotalBytes) {
        throw new PluginApiError('storage', 'clientStorage is limited to 200 keys and 1 MiB')
      }
      data.set(pluginId, values)
    },
    delete(pluginId, key) {
      checkKey(key)
      data.get(pluginId)?.delete(key)
    },
    keys(pluginId) {
      return [...(data.get(pluginId)?.keys() ?? [])]
    },
  }
}

function bucketKey(pluginId: string): string {
  return `futureox.plugin.clientStorage.${pluginId}`
}

function readBucket(pluginId: string, memory: Map<string, Map<string, unknown>>): Map<string, unknown> {
  const cached = memory.get(pluginId)
  if (cached) return cached
  const values = new Map<string, unknown>()
  try {
    const raw = globalThis.localStorage?.getItem(bucketKey(pluginId))
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) values.set(key, value)
      }
    }
  } catch {
    values.clear()
  }
  memory.set(pluginId, values)
  return values
}

function persist(pluginId: string, values: Map<string, unknown>): void {
  if (totalBytes(values) > pluginLimits.storageTotalBytes) throw new PluginApiError('storage', 'clientStorage is limited to 1 MiB')
  const record = Object.fromEntries(values)
  globalThis.localStorage?.setItem(bucketKey(pluginId), JSON.stringify(record))
}

function encodeValue(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || encoded.length > pluginLimits.storageValueBytes) {
    throw new PluginApiError('storage', 'clientStorage values must be JSON and at most 100 KiB')
  }
  return encoded
}

function totalBytes(values: Map<string, unknown>): number {
  let total = 0
  for (const [key, value] of values) total += key.length + JSON.stringify(value).length
  return total
}

function checkKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !key || key.length > 128 || [...key].some(char => char.charCodeAt(0) < 32)) {
    throw new PluginApiError('storage', 'clientStorage keys must be 1–128 characters without control characters')
  }
}
