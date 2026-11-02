import { strFromU8, unzipSync } from 'fflate'
import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginBundle, parsePluginManifest, type PluginBundle } from './manifest'

function safeZipPath(name: string): string | null {
  const path = name.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!path || path.startsWith('/') || path.includes('\0')) return null
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..')) return null
  return parts.join('/')
}

function textFile(data: Uint8Array, label: string) {
  if (data.byteLength > PLUGIN_LIMITS.mainBytes && label.endsWith('.js'))
    throw new PluginApiError('plugin_too_large', `${label} is too large`)
  if (data.includes(0)) throw new PluginApiError('invalid_plugin', `${label} must be text`)
  return strFromU8(data)
}

/** Read one Figma plugin folder from a .zip or .figma archive the user picked.
 * Other files in the archive are ignored. Paths that leave the folder reject. */
export function pluginBundleFromZip(bytes: Uint8Array): PluginBundle {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new PluginApiError('invalid_plugin', 'Choose a .zip or .figma plugin archive')
  if (bytes.byteLength > PLUGIN_LIMITS.zipBytes)
    throw new PluginApiError('plugin_too_large', 'Plugin archive is too large')
  let entries: Record<string, Uint8Array>
  try { entries = unzipSync(bytes) }
  catch { throw new PluginApiError('invalid_plugin', 'Plugin archive is not a valid zip') }
  const files = new Map<string, Uint8Array>()
  let total = 0
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue
    const path = safeZipPath(name)
    if (!path) throw new PluginApiError('invalid_plugin', 'Plugin archive contains a path outside the folder')
    total += data.byteLength
    if (total > PLUGIN_LIMITS.zipUncompressedBytes)
      throw new PluginApiError('plugin_too_large', 'Plugin archive expands too far')
    files.set(path, data)
    if (files.size > PLUGIN_LIMITS.zipEntries)
      throw new PluginApiError('invalid_plugin', 'Plugin archive has too many files')
  }
  const manifests = [...files.keys()].filter(path => path === 'manifest.json' || path.endsWith('/manifest.json'))
  if (manifests.length !== 1)
    throw new PluginApiError('invalid_manifest', 'The archive must contain one manifest.json')
  const manifestPath = manifests[0]
  const manifestBytes = files.get(manifestPath)!
  if (manifestBytes.byteLength > PLUGIN_LIMITS.manifestBytes)
    throw new PluginApiError('plugin_too_large', 'manifest.json is too large')
  const root = manifestPath.slice(0, -'manifest.json'.length)
  const read = (relative: string, limit: number) => {
    const data = files.get(`${root}${relative}`)
    if (!data) throw new PluginApiError('invalid_plugin', `Missing ${relative}`)
    if (data.byteLength > limit) throw new PluginApiError('plugin_too_large', `${relative} is too large`)
    return textFile(data, relative)
  }
  let manifest: ReturnType<typeof parsePluginManifest>
  try { manifest = parsePluginManifest(JSON.parse(textFile(manifestBytes, 'manifest.json'))) }
  catch (error) {
    if (error instanceof PluginApiError) throw error
    throw new PluginApiError('invalid_manifest', 'manifest.json is not valid JSON')
  }
  const bundle: PluginBundle = {
    manifest,
    main: read(manifest.main, PLUGIN_LIMITS.mainBytes),
    ui: manifest.ui ? read(manifest.ui, PLUGIN_LIMITS.uiBytes) : null,
  }
  assertPluginBundle(bundle)
  return bundle
}
