import { unzipSync, strFromU8, zipSync } from 'fflate'
import { PluginApiError } from './errors'
import { pluginLimits } from './limits'

export type PluginMenuItem = { name: string; command: string }
export type PluginManifest = {
  name: string
  id: string
  api: string
  main: string
  ui?: string
  editorType: string[]
  menu: PluginMenuItem[]
  networkAccess: { requested: string[]; granted: false }
  documentAccess?: string
}
export type PluginBundle = {
  manifest: PluginManifest
  code: string
  ui?: string
}

const idPattern = /^[A-Za-z0-9._:-]{1,80}$/

export function parsePluginManifest(source: string): PluginManifest {
  if (source.length > pluginLimits.manifestBytes) throw new PluginApiError('manifest', 'manifest.json is too large')
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new PluginApiError('manifest', 'manifest.json is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginApiError('manifest', 'manifest.json must be an object')
  const record = value as Record<string, unknown>
  const name = stringField(record, 'name', 120)
  const id = stringField(record, 'id', 80)
  if (!idPattern.test(id)) throw new PluginApiError('manifest', 'Plugin id must be 1–80 letters, digits, ".", "_", ":", or "-"')
  const api = typeof record.api === 'string' && record.api.trim() ? record.api.trim().slice(0, 32) : '1.0.0'
  const main = relativeFile(record.main, 'main')
  const ui = record.ui === undefined ? undefined : relativeFile(record.ui, 'ui')
  const editorType = record.editorType === undefined ? ['figma'] : stringList(record.editorType, 'editorType')
  if (!editorType.includes('figma')) throw new PluginApiError('manifest', 'This host runs Figma design plugins. FigJam-only manifests are refused.')
  const menu = record.menu === undefined ? [{ name: 'Run', command: 'run' }] : menuItems(record.menu)
  const requested = networkDomains(record.networkAccess)
  const documentAccess = typeof record.documentAccess === 'string' ? record.documentAccess.slice(0, 64) : undefined
  return { name, id, api, main, ui, editorType, menu, networkAccess: { requested, granted: false }, documentAccess }
}

export function bundleFromTextFiles(files: readonly { name: string; text: string }[]): PluginBundle {
  if (files.length > pluginLimits.packageFiles) throw new PluginApiError('package', 'Plugin packages are limited to 32 files')
  let total = 0
  const mapped = new Map<string, string>()
  for (const file of files) {
    const name = normalizePackagePath(file.name)
    total += file.text.length
    if (total > pluginLimits.packageBytes || file.text.length > pluginLimits.fileBytes) {
      throw new PluginApiError('package', 'Plugin packages are limited to 2 MiB, and each file to 1 MiB')
    }
    mapped.set(name, file.text)
  }
  const manifestPath = findManifest(mapped)
  const root = manifestPath.includes('/') ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1) : ''
  const manifest = parsePluginManifest(mapped.get(manifestPath) || '')
  const code = readPackageFile(mapped, root, manifest.main)
  const ui = manifest.ui ? readPackageFile(mapped, root, manifest.ui) : undefined
  return { manifest, code, ui }
}

export function bundleFromZip(bytes: Uint8Array): PluginBundle {
  if (bytes.byteLength > pluginLimits.packageBytes) throw new PluginApiError('package', 'Plugin zip files are limited to 2 MiB')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch {
    throw new PluginApiError('package', 'Plugin zip could not be read')
  }
  const files = Object.entries(entries)
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, data]) => ({ name, text: strFromU8(data) }))
  return bundleFromTextFiles(files)
}

export function zipPluginFiles(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, new TextEncoder().encode(text)])))
}

function stringField(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new PluginApiError('manifest', `manifest ${key} must be a non-empty string`)
  }
  return value.trim()
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8 || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new PluginApiError('manifest', `manifest ${key} must be a short list of strings`)
  }
  return value.map(item => String(item).trim())
}

function menuItems(value: unknown): PluginMenuItem[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new PluginApiError('manifest', 'manifest menu must be a short list')
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new PluginApiError('manifest', 'manifest menu items must be objects')
    const record = item as Record<string, unknown>
    const name = stringField(record, 'name', 80)
    const command = stringField(record, 'command', 64)
    if (!/^[A-Za-z0-9._:-]+$/.test(command)) throw new PluginApiError('manifest', 'menu command contains unsupported characters')
    return { name, command }
  })
}

function networkDomains(value: unknown): string[] {
  if (value === undefined) return []
  if (!value || typeof value !== 'object') return []
  const domains = (value as { allowedDomains?: unknown; devAllowedDomains?: unknown }).allowedDomains
  if (domains === undefined) return []
  if (!Array.isArray(domains) || domains.length > 32) return ['invalid']
  return domains.map(domain => typeof domain === 'string' ? domain.slice(0, 200) : 'invalid')
}

function relativeFile(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) throw new PluginApiError('manifest', `manifest ${key} must name a file inside the plugin`)
  return assertRelative(value.trim(), key)
}

export function normalizePackagePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.?\//, '')
}

function assertRelative(value: string, key: string): string {
  const name = normalizePackagePath(value)
  if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '..' || part === '.')) {
    throw new PluginApiError('manifest', `manifest ${key} must stay inside the plugin folder`)
  }
  return name
}

function findManifest(files: Map<string, string>): string {
  const matches = [...files.keys()].filter(name => name === 'manifest.json' || name.endsWith('/manifest.json'))
  if (!matches.length) throw new PluginApiError('package', 'Plugin package needs a manifest.json')
  matches.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  return matches[0]
}

function readPackageFile(files: Map<string, string>, root: string, name: string): string {
  const path = root + name
  const text = files.get(path)
  if (text === undefined) throw new PluginApiError('package', `Missing plugin file ${name}`)
  return text
}
