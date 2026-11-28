import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'
import {
  assertPluginSource, missingPluginSource, parsePluginManifest, pluginBundleFromSources, pluginEntryFlavor,
  pluginEntrySourcePaths, pluginSourceUnsupported, pluginUiPaths, pluginUiSourcePaths, type PluginBundle,
} from './manifest'

export type PluginFile = {
  name: string
  webkitRelativePath?: string
  size: number
  text(): Promise<string>
}

function relativePath(file: PluginFile): string {
  const path = file.webkitRelativePath || file.name
  return path.replaceAll('\\', '/')
}

type CompileTypeScript = (source: string) => Promise<string>

/** Read only the manifest, entry point, and declared UI files from a user-picked folder.
 * A missing built entry may resolve to a bounded TypeScript/JavaScript source sibling. */
export async function pluginBundleFromFiles(files: Iterable<PluginFile>, compile?: CompileTypeScript): Promise<PluginBundle> {
  const list = [...files]
  if (!list.length) throw new PluginApiError('invalid_plugin', 'Choose a plugin folder')
  if (list.length > 200) throw new PluginApiError('invalid_plugin', 'A plugin folder can contain at most 200 files')
  const manifests = list.filter(file => relativePath(file).split('/').pop() === 'manifest.json')
  if (manifests.length !== 1) throw new PluginApiError('invalid_manifest', 'The folder must contain one manifest.json')
  const manifestFile = manifests[0]
  if (manifestFile.size > PLUGIN_LIMITS.manifestBytes)
    throw new PluginApiError('plugin_too_large', 'manifest.json is too large')
  const manifest = parsePluginManifest(JSON.parse(await manifestFile.text()))
  const root = relativePath(manifestFile).slice(0, -'manifest.json'.length)
  const read = async (path: string, limit: number) => {
    const full = `${root}${path}`
    const file = list.find(item => relativePath(item) === full)
    if (!file) throw missingPluginSource(manifest, path)
    if (file.size > limit) throw new PluginApiError('plugin_too_large', `${path} is too large`)
    return file.text()
  }
  const has = (path: string) => list.some(item => relativePath(item) === `${root}${path}`)
  const entryPath = has(manifest.main) ? manifest.main : pluginEntrySourcePaths(manifest.main).find(has)
  if (!entryPath) throw missingPluginSource(manifest, manifest.main)
  const flavor = pluginEntryFlavor(entryPath)
  if (flavor === 'tsx') throw pluginSourceUnsupported(entryPath, 'tsx')
  if (flavor === 'typescript' && !compile) throw pluginSourceUnsupported(entryPath, 'compiler')
  let main = await read(entryPath, flavor === 'javascript' ? PLUGIN_LIMITS.mainBytes : PLUGIN_LIMITS.typeSourceBytes)
  if (flavor === 'typescript') main = await compile!(main)
  const sources = new Map([[manifest.main, main]])
  let remaining = PLUGIN_LIMITS.uiBytes
  for (const path of pluginUiPaths(manifest)) {
    const uiPath = pluginUiSourcePaths(path).find(has)
    if (!uiPath) throw missingPluginSource(manifest, path)
    const source = await read(uiPath, remaining)
    remaining -= assertPluginSource(source, uiPath, remaining)
    sources.set(path, source)
  }
  return pluginBundleFromSources(manifest, sources)
}
