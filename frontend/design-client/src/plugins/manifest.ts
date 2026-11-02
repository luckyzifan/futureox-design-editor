import { PluginApiError } from './errors'

export type PluginManifest = {
  name: string
  id: string
  api: string
  main: string
  ui?: string
  editorType: string[]
}

const fileSuffixes = new Set(['js', 'mjs', 'html', 'json', 'css', 'svg'])

function requiredText(value: unknown, max: number, api: string) {
  if (typeof value !== 'string') throw new PluginApiError(api, 'invalid')
  const text = value.trim()
  if (!text || text.length > max) throw new PluginApiError(api, 'invalid')
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PluginApiError(api, 'invalid')
  return text
}

/** Relative file inside the plugin folder. No absolute paths, empty segments, or parent segments. */
export function pluginRelativeFile(value: unknown, api: string) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new PluginApiError(api, 'invalid')
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) throw new PluginApiError(api, 'invalid')
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new PluginApiError(api, 'invalid')
  const suffix = parts.at(-1)?.split('.').pop()?.toLowerCase()
  if (!suffix || !fileSuffixes.has(suffix)) throw new PluginApiError(api, 'invalid')
  return value
}

export function parsePluginManifest(text: string): { manifest: PluginManifest; warnings: string[] } {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 64 * 1024) throw new PluginApiError('manifest.json', 'invalid')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new PluginApiError('manifest.json', 'invalid') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PluginApiError('manifest.json', 'invalid')
  const record = value as Record<string, unknown>
  const name = requiredText(record.name, 64, 'manifest.name')
  const id = requiredText(record.id, 128, 'manifest.id')
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new PluginApiError('manifest.id', 'invalid')
  const api = requiredText(record.api, 32, 'manifest.api')
  const main = pluginRelativeFile(record.main, 'manifest.main')
  const ui = record.ui === undefined ? undefined : pluginRelativeFile(record.ui, 'manifest.ui')
  const editorType = record.editorType === undefined ? ['figma'] : record.editorType
  if (!Array.isArray(editorType) || editorType.some(item => typeof item !== 'string') || !editorType.includes('figma')) {
    throw new PluginApiError('manifest.editorType', 'unsupported')
  }
  const warnings: string[] = []
  if (record.networkAccess) warnings.push('networkAccess is ignored. Plugins cannot use the network.')
  if (record.permissions) warnings.push('permissions are ignored. Plugins cannot grant capabilities.')
  if (record.documentAccess) warnings.push('documentAccess is ignored. The plugin sees one snapshot of the open document.')
  return {
    manifest: { name, id, api, main, ui, editorType: editorType.filter((item): item is string => typeof item === 'string') },
    warnings,
  }
}
