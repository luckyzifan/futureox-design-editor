import { PluginApiError } from './errors'
import { PLUGIN_LIMITS } from './limits'
import { assertPluginBundle, parsePluginManifest, type PluginBundle } from './manifest'

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

/** Read manifest.json plus the main and optional UI file from a folder the user picked. Other files are ignored. */
export async function pluginBundleFromFiles(files: Iterable<PluginFile>): Promise<PluginBundle> {
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
    if (!file) throw new PluginApiError('invalid_plugin', `Missing ${path}`)
    if (file.size > limit) throw new PluginApiError('plugin_too_large', `${path} is too large`)
    return file.text()
  }
  const bundle: PluginBundle = {
    manifest,
    main: await read(manifest.main, PLUGIN_LIMITS.mainBytes),
    ui: manifest.ui ? await read(manifest.ui, PLUGIN_LIMITS.uiBytes) : null,
  }
  assertPluginBundle(bundle)
  return bundle
}
