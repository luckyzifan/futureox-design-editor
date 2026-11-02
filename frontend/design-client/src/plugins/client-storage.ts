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

type Bag = Record<string, unknown>

function storageKey(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > PLUGIN_LIMITS.clientStorageKeyChars || /[\u0000-\u001f]/.test(value))
    throw new PluginApiError('invalid_value', `clientStorage key must be 1–${PLUGIN_LIMITS.clientStorageKeyChars} characters`)
  if (value === '__proto__' || value === 'constructor' || value === 'prototype')
    throw new PluginApiError('invalid_value', 'clientStorage key is not allowed')
  return value
}

function readBag(storage: PluginStorage, pluginId: string): Bag {
  const raw = storage.get(clientStorageKey(pluginId))
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Bag
  } catch {
    throw new PluginApiError('storage_failed', 'clientStorage for this plugin is not valid JSON')
  }
}

function writeBag(storage: PluginStorage, pluginId: string, bag: Bag) {
  const keys = Object.keys(bag)
  if (keys.length > PLUGIN_LIMITS.clientStorageKeys)
    throw new PluginApiError('plugin_limit', `clientStorage accepts at most ${PLUGIN_LIMITS.clientStorageKeys} keys`)
  const json = JSON.stringify(bag)
  if (new TextEncoder().encode(json).byteLength > PLUGIN_LIMITS.clientStorageBytes)
    throw new PluginApiError('plugin_limit', `clientStorage is limited to ${PLUGIN_LIMITS.clientStorageBytes} bytes per plugin`)
  const key = clientStorageKey(pluginId)
  if (!keys.length) storage.remove(key)
  else storage.set(key, json)
}

export function clientStorageGet(storage: PluginStorage, pluginId: string, key: unknown): { found: boolean; value: unknown } {
  const bag = readBag(storage, pluginId)
  const name = storageKey(key)
  if (!Object.prototype.hasOwnProperty.call(bag, name)) return { found: false, value: null }
  return { found: true, value: bag[name] }
}

export function clientStorageKeys(storage: PluginStorage, pluginId: string): string[] {
  return Object.keys(readBag(storage, pluginId))
}

export function clientStorageSet(storage: PluginStorage, pluginId: string, key: unknown, json: unknown) {
  if (typeof json !== 'string') throw new PluginApiError('invalid_value', 'clientStorage value must be JSON')
  let value: unknown
  try { value = JSON.parse(json) } catch { throw new PluginApiError('invalid_value', 'clientStorage value must be JSON') }
  const bag = readBag(storage, pluginId)
  bag[storageKey(key)] = value
  writeBag(storage, pluginId, bag)
}

export function clientStorageDelete(storage: PluginStorage, pluginId: string, key: unknown) {
  const bag = readBag(storage, pluginId)
  delete bag[storageKey(key)]
  writeBag(storage, pluginId, bag)
}
