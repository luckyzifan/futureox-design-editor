import { strFromU8, unzipSync } from 'fflate'
import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginSource, missingPluginSource, parsePluginManifest, pluginBundleFromSources, pluginUiPaths, type PluginBundle } from './manifest'

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

type CompileTypeScript = (source: string) => Promise<string>

/** Read one Figma plugin folder from a .zip or .figma archive the user picked.
 * Other files in the archive are ignored. Paths that leave the folder reject. */
export function pluginBundleFromZip(bytes: Uint8Array): PluginBundle
export function pluginBundleFromZip(bytes: Uint8Array, compile: CompileTypeScript): Promise<PluginBundle>
export function pluginBundleFromZip(bytes: Uint8Array, compile?: CompileTypeScript): PluginBundle | Promise<PluginBundle> {
  return compile ? Promise.resolve().then(() => decodeArchive(bytes, compile)) : decodeArchive(bytes)
}

function decodeArchive(bytes: Uint8Array, compile?: CompileTypeScript): PluginBundle | Promise<PluginBundle> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new PluginApiError('invalid_plugin', 'Choose a .zip or .figma plugin archive')
  if (bytes.byteLength < 22)
    throw new PluginApiError('invalid_plugin', 'Plugin archive is not a valid zip')
  if (bytes.byteLength > PLUGIN_LIMITS.zipBytes)
    throw new PluginApiError('plugin_too_large', 'Plugin archive is too large')
  let entries: Record<string, Uint8Array>
  const admitted = new Set<string>()
  let plannedBytes = 0
  try {
    entries = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        if (name.endsWith('/')) return false
        const path = safeZipPath(name)
        if (!path || path === '__proto__' || admitted.has(path))
          throw new PluginApiError('invalid_plugin', 'Plugin archive contains an unsafe or duplicate path')
        admitted.add(path)
        if (admitted.size > PLUGIN_LIMITS.zipEntries)
          throw new PluginApiError('invalid_plugin', 'Plugin archive has too many files')
        if (!Number.isSafeInteger(originalSize) || originalSize < 0) throw new PluginApiError('invalid_plugin', 'Plugin archive contains an invalid file size')
        plannedBytes += originalSize
        if (plannedBytes > PLUGIN_LIMITS.zipUncompressedBytes)
          throw new PluginApiError('plugin_too_large', 'Plugin archive expands too far')
        return true
      },
    })
  } catch (error) {
    if (error instanceof PluginApiError) throw error
    throw new PluginApiError('invalid_plugin', 'Plugin archive is not a valid zip')
  }
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
    if (!data) throw missingPluginSource(manifest, relative)
    if (data.byteLength > limit) throw new PluginApiError('plugin_too_large', `${relative} is too large`)
    return textFile(data, relative)
  }
  let manifest: ReturnType<typeof parsePluginManifest>
  try { manifest = parsePluginManifest(JSON.parse(textFile(manifestBytes, 'manifest.json'))) }
  catch (error) {
    if (error instanceof PluginApiError) throw error
    throw new PluginApiError('invalid_manifest', 'manifest.json is not valid JSON')
  }
  const typedPath = manifest.main.slice(0, -3) + '.ts'
  const built = files.has(root + manifest.main)
  const typeSource = !built && compile && files.has(root + typedPath)
  const main = typeSource ? read(typedPath, PLUGIN_LIMITS.typeSourceBytes) : read(manifest.main, PLUGIN_LIMITS.mainBytes)
  const sources = new Map<string, string>()
  let remaining = PLUGIN_LIMITS.uiBytes
  for (const path of pluginUiPaths(manifest)) {
    const source = read(path, remaining)
    remaining -= assertPluginSource(source, path, remaining)
    sources.set(path, source)
  }
  const finish = (script: string) => {
    sources.set(manifest.main, script)
    return pluginBundleFromSources(manifest, sources)
  }
  return typeSource && compile ? compile(main).then(finish) : finish(main)
}
