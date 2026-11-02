import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'

export type PluginManifest = {
  name: string
  id: string
  api: '1.0.0'
  main: string
  ui: string | null
  editorType: string[]
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

function noNetwork(value: unknown) {
  if (value == null) return
  if (!Array.isArray(value)) throw new PluginApiError('invalid_manifest', 'networkAccess domains must be an array')
  const allowed = value.length === 0 || (value.length === 1 && value[0] === 'none')
  if (!allowed)
    throw new PluginApiError('network_denied', 'This host does not grant plugin network access. allowedDomains must be omitted, empty, or ["none"].')
}

/** Parse a Figma-style manifest. Network, permissions, and non-figma editors reject. */
export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PluginApiError('invalid_manifest', 'manifest.json must be an object')
  const record = value as Record<string, unknown>
  const name = text(record.name, 'name', 80)
  const id = text(String(record.id ?? ''), 'id', 128)
  if (record.api !== '1.0.0') throw new PluginApiError('invalid_manifest', 'api must be "1.0.0"')
  const main = pluginRelativePath(record.main, '.js')
  const ui = record.ui === undefined ? null : pluginRelativePath(record.ui, '.html')
  let editorType = ['figma']
  if (record.editorType !== undefined) {
    if (!Array.isArray(record.editorType) || record.editorType.some(item => typeof item !== 'string'))
      throw new PluginApiError('invalid_manifest', 'editorType must be an array of strings')
    editorType = record.editorType
    if (!editorType.includes('figma'))
      throw new PluginApiError('invalid_manifest', 'Only editorType "figma" can run in Futureox Design')
  }
  if (record.documentAccess !== undefined && record.documentAccess !== 'dynamic-page')
    throw new PluginApiError('invalid_manifest', 'documentAccess must be "dynamic-page". Plugins only see the open document.')
  const network = record.networkAccess
  if (network != null) {
    if (typeof network !== 'object' || Array.isArray(network))
      throw new PluginApiError('invalid_manifest', 'networkAccess must be an object')
    const access = network as Record<string, unknown>
    noNetwork(access.allowedDomains)
    noNetwork(access.devAllowedDomains)
  }
  if (record.permissions !== undefined) {
    if (!Array.isArray(record.permissions) || record.permissions.length > 0)
      throw new PluginApiError('invalid_manifest', 'Plugin permissions are not granted. Omit permissions or use [].')
  }
  return { name, id, api: '1.0.0', main, ui, editorType }
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
