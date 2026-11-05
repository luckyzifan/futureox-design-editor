import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

export type PluginCommand = { name: string; command: string }

export type PluginManifest = {
  name: string
  id: string
  api: '1.0.0'
  main: string
  ui: string | null
  editorType: string[]
  commands: PluginCommand[]
  /** True when the manifest asked for domains other than none. Fetch is limited to these origins. */
  networkIgnored: boolean
  networkDomains: string[]
  /** Declared permissions are recorded and not granted. */
  permissionsIgnored: string[]
}

export type PluginBundle = {
  manifest: PluginManifest
  main: string
  ui: string | null
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new PluginApiError('invalid_manifest', `${label} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f]/.test(trimmed))
    throw new PluginApiError('invalid_manifest', `${label} must be 1–${max} characters without control characters`)
  return trimmed
}

/** Relative file inside the plugin folder. `..`, absolute paths, and empty segments reject. */
export function pluginRelativePath(value: unknown, extension: string): string {
  const path = text(value, 'path', 180)
  if (path.includes('\\') || path.startsWith('/') || path.includes(':'))
    throw new PluginApiError('invalid_manifest', 'Plugin files must be relative paths inside the plugin folder')
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..'))
    throw new PluginApiError('invalid_manifest', 'Plugin files cannot climb out of the plugin folder')
  if (!path.endsWith(extension))
    throw new PluginApiError('invalid_manifest', `Plugin file must end with ${extension}`)
  return path
}

function domainList(value: unknown, label: string): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length > 200))
    throw new PluginApiError('invalid_manifest', `${label} must be an array of strings`)
  return value.filter(item => item !== 'none')
}

function menuCommands(value: unknown, into: PluginCommand[], depth: number) {
  if (value === undefined) return
  if (!Array.isArray(value) || depth > 3)
    throw new PluginApiError('invalid_manifest', 'menu must be an array')
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PluginApiError('invalid_manifest', 'menu items must be objects')
    const entry = item as Record<string, unknown>
    if (entry.separator === true) continue
    if (entry.menu !== undefined) menuCommands(entry.menu, into, depth + 1)
    if (entry.command !== undefined || (entry.name !== undefined && entry.menu === undefined)) {
      if (entry.command === undefined) continue
      into.push({ name: text(entry.name, 'menu name', 80), command: text(entry.command, 'command', 80) })
    }
    if (into.length > 40) throw new PluginApiError('invalid_manifest', 'menu can list at most 40 commands')
  }
}

/** Parse a Figma-style manifest. Network and permissions are not granted; the plugin can still load. */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginApiError('invalid_manifest', 'manifest.json must be an object')
  const record = value as Record<string, unknown>
  const name = text(record.name, 'name', 80)
  const id = text(String(record.id ?? ''), 'id', 128)
  if (record.api !== '1.0.0') throw new PluginApiError('invalid_manifest', 'api must be "1.0.0"')
  const main = pluginRelativePath(record.main, '.js')
  const uiValue = record.ui && typeof record.ui === 'object' && !Array.isArray(record.ui)
    ? (record.ui as Record<string, unknown>).main
    : record.ui
  const ui = uiValue === undefined ? null : pluginRelativePath(uiValue, '.html')
  let editorType = ['figma']
  if (record.editorType !== undefined) {
    if (!Array.isArray(record.editorType) || record.editorType.some(item => typeof item !== 'string'))
      throw new PluginApiError('invalid_manifest', 'editorType must be an array of strings')
    editorType = record.editorType
    if (!editorType.includes('figma'))
      throw new PluginApiError('invalid_manifest', 'Only editorType "figma" can run in Futureox Design')
  }
  if (record.documentAccess !== undefined && typeof record.documentAccess !== 'string')
    throw new PluginApiError('invalid_manifest', 'documentAccess must be a string. The open document is already local.')
  let networkDomains: string[] = []
  const network = record.networkAccess
  if (network != null) {
    if (typeof network !== 'object' || Array.isArray(network))
      throw new PluginApiError('invalid_manifest', 'networkAccess must be an object')
    const access = network as Record<string, unknown>
    networkDomains = [...domainList(access.allowedDomains, 'allowedDomains'), ...domainList(access.devAllowedDomains, 'devAllowedDomains')]
    if (networkDomains.length > 40) throw new PluginApiError('invalid_manifest', 'networkAccess lists too many domains')
    if (access.reasoning !== undefined && typeof access.reasoning !== 'string')
      throw new PluginApiError('invalid_manifest', 'networkAccess.reasoning must be a string')
  }
  const networkIgnored = networkDomains.length > 0
  let permissionsIgnored: string[] = []
  if (record.permissions !== undefined) {
    if (!Array.isArray(record.permissions) || record.permissions.some(item => typeof item !== 'string'))
      throw new PluginApiError('invalid_manifest', 'permissions must be an array of strings')
    permissionsIgnored = record.permissions
  }
  const commands: PluginCommand[] = []
  menuCommands(record.menu, commands, 0)
  return { name, id, api: '1.0.0', main, ui, editorType, commands, networkIgnored, networkDomains, permissionsIgnored }
}

export function assertPluginSource(source: string, label: string, maxBytes: number) {
  if (typeof source !== 'string') throw new PluginApiError('invalid_plugin', `${label} must be text`)
  const bytes = new TextEncoder().encode(source).byteLength
  if (bytes > maxBytes) throw new PluginApiError('plugin_too_large', `${label} is ${bytes} bytes; the limit is ${maxBytes}`)
}

export function assertPluginBundle(bundle: PluginBundle) {
  assertPluginSource(bundle.main, bundle.manifest.main, PLUGIN_LIMITS.mainBytes)
  if (bundle.ui != null) assertPluginSource(bundle.ui, bundle.manifest.ui || 'ui.html', PLUGIN_LIMITS.uiBytes)
}
