import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const PLUGIN_MANIFEST_BYTES = 64 * 1024
export const PLUGIN_FILE_BYTES = 1024 * 1024
export const PLUGIN_UI_BYTES = 512 * 1024
export const LOCAL_PLUGIN_SCAN_LIMIT = 64
export const LOCAL_PLUGIN_ENABLE_LIMIT = 32
const LOCAL_PLUGIN_WATCH_LIMIT = 128
const suffixes = new Set(['js', 'mjs', 'html', 'json', 'css', 'svg'])
const NAMED_UI_LIMIT = 16
const LOCAL_FOLDER_ID_PREFIX = 'futureox.local.folder:'

export function pluginRelativeParts(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) throw new Error('Invalid plugin file')
  if (value.includes('\\') || value.includes('\0') || path.isAbsolute(value)) throw new Error('Invalid plugin file')
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) throw new Error('Invalid plugin file')
  const suffix = parts.at(-1).split('.').pop().toLowerCase()
  if (!suffixes.has(suffix)) throw new Error('Invalid plugin file')
  return parts
}

export function pluginFolderName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 64 && !name.startsWith('.') &&
    !name.includes('/') && !name.includes('\\') && !name.includes('\0') && !/[\u0000-\u001f\u007f]/.test(name)
}

function requiredText(value, max) {
  if (typeof value !== 'string') throw new Error('Invalid plugin manifest')
  const text = value.trim()
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('Invalid plugin manifest')
  return text
}

function uiPath(value) {
  const file = pluginRelativeParts(value).join('/')
  if (!file.endsWith('.html')) throw new Error('Invalid plugin UI file')
  return file
}

function namedUiFiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length === 0 || entries.length > NAMED_UI_LIMIT) throw new Error('Invalid plugin UI file count')
  return Object.fromEntries(entries.map(([name, file]) => {
    if (requiredText(name, 80) !== name) throw new Error('Invalid plugin UI name')
    return [name, uiPath(file)]
  }))
}

/** Same declaration rules as the client manifest parser. A valid manifest enables a plugin; it does not run it. */
export function parseDeclaredPluginManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > PLUGIN_MANIFEST_BYTES) throw new Error('Invalid plugin manifest')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('Invalid plugin manifest') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin manifest')
  const name = requiredText(value.name, 64)
  const id = typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0
    ? String(value.id) : requiredText(value.id, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('Invalid plugin manifest')
  requiredText(value.api, 32)
  const main = pluginRelativeParts(value.main).join('/')
  const uiFiles = namedUiFiles(value.ui)
  const ui = uiFiles ? uiFiles.main : value.ui === undefined ? undefined : uiPath(value.ui)
  const editorType = value.editorType === undefined ? ['figma'] : value.editorType
  if (!Array.isArray(editorType) || editorType.some(item => typeof item !== 'string') || !editorType.includes('figma')) {
    throw new Error('Invalid plugin manifest')
  }
  return { id, name, main, ui, ...(uiFiles ? { uiFiles } : {}) }
}

async function readLocalPluginManifest(root) {
  const text = await readPluginFile(root, 'manifest.json')
  let manifest
  try { manifest = JSON.parse(text) } catch { return text }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return text
  if (typeof manifest.id === 'string' && manifest.id.trim().startsWith(LOCAL_FOLDER_ID_PREFIX)) throw new Error('Reserved local plugin id')
  if (Object.hasOwn(manifest, 'id')) return text
  const id = LOCAL_FOLDER_ID_PREFIX + createHash('sha256').update(root).digest('hex')
  return JSON.stringify({ ...manifest, id })
}

function limitOption(value, max) {
  if (value === undefined) return max
  if (!Number.isInteger(value) || value < 1 || value > max) throw new TypeError('Invalid plugin scan limit')
  return value
}

/**
 * Scan one plugins directory. Each real child folder with a valid manifest and
 * its declared main/ui files is enabled. Symlinks, hidden folders, FigJam-only
 * manifests, and files that leave the folder are not enabled. Nothing is executed.
 */
export async function scanDeclaredPlugins(root, options = {}) {
  const scanLimit = limitOption(options.scanLimit, LOCAL_PLUGIN_SCAN_LIMIT)
  const enableLimit = limitOption(options.enableLimit, LOCAL_PLUGIN_ENABLE_LIMIT)
  const empty = { plugins: [], skipped: 0, truncated: false }
  if (typeof root !== 'string' || root.length < 1) return empty
  let rootReal
  try { rootReal = await realpath(root) } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR' || error?.code === 'ELOOP') return empty
    throw error
  }
  const rootStat = await lstat(rootReal)
  if (!rootStat.isDirectory()) return empty
  options.watchFolders?.add(rootReal)
  const entries = await readdir(rootReal, { withFileTypes: true })
  const names = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && pluginFolderName(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const plugins = []
  let skipped = 0
  const seen = new Set()
  for (const name of names.slice(0, scanLimit)) {
    try {
      const listed = path.join(rootReal, name)
      const stat = await lstat(listed)
      if (!stat.isDirectory() || stat.isSymbolicLink()) { skipped += 1; continue }
      const folderReal = await realpath(listed)
      const rel = path.relative(rootReal, folderReal)
      if (rel !== name || path.isAbsolute(rel)) { skipped += 1; continue }
      options.watchFolders?.add(folderReal)
      if (plugins.length >= enableLimit) { skipped += 1; continue }
      const manifestText = await readLocalPluginManifest(folderReal)
      const manifest = parseDeclaredPluginManifest(manifestText)
      if (seen.has(manifest.id)) { skipped += 1; continue }
      if (options.watchFolders) {
        for (const file of [manifest.main, ...Object.values(manifest.uiFiles ?? (manifest.ui ? { main: manifest.ui } : {}))]) {
          await watchSourceParent(folderReal, file, options.watchFolders)
        }
      }
      await readPluginFile(folderReal, manifest.main)
      const uiFiles = manifest.uiFiles ? Object.values(manifest.uiFiles) : manifest.ui ? [manifest.ui] : []
      let remaining = PLUGIN_UI_BYTES
      for (const ui of uiFiles) {
        remaining -= Buffer.byteLength(await readPluginFile(folderReal, ui), 'utf8')
        if (remaining < 0) throw new Error('Plugin UI is too large')
      }
      seen.add(manifest.id)
      plugins.push({ id: manifest.id, name: manifest.name, manifestText, root: folderReal })
    } catch { skipped += 1 }
  }
  return { plugins, skipped, truncated: names.length > scanLimit }
}

async function watchSourceParent(folder, relative, folders) {
  if (folders.size >= LOCAL_PLUGIN_WATCH_LIMIT) return
  let parent = path.dirname(path.resolve(folder, ...pluginRelativeParts(relative)))
  while (parent !== folder) {
    try {
      const stat = await lstat(parent)
      if (stat.isDirectory() && !stat.isSymbolicLink() && await realpath(parent) === parent) folders.add(parent)
      return
    } catch (error) {
      if (error?.code !== 'ENOENT') return
    }
    parent = path.dirname(parent)
  }
}

/** Reconcile live directory watches from the same bounded catalog scan. */
export function createPluginCatalogWatcher(profile, refresh) {
  const watchers = new Map()
  let timer
  let closed = false
  function changed() {
    if (closed) return
    clearTimeout(timer)
    timer = setTimeout(() => { if (!closed) void refresh() }, 125)
    timer.unref?.()
  }
  return {
    update(folders) {
      if (closed) return
      // The profile watch sees creation/removal of the plugins directory itself.
      const ordered = [...folders].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length)
      const next = new Set([profile, ...ordered.slice(0, LOCAL_PLUGIN_WATCH_LIMIT)])
      for (const [folder, watcher] of watchers) {
        if (!next.has(folder)) { watcher.close(); watchers.delete(folder) }
      }
      for (const folder of next) {
        if (watchers.has(folder)) continue
        try {
          const watcher = watch(folder, { persistent: false }, (event, name) => {
            if (folder !== profile && event === 'rename' && (name == null || String(name) === path.basename(folder))) {
              watchers.delete(folder)
              watcher.close()
            }
            if (folder !== profile || name == null || String(name) === 'plugins') changed()
          })
          watchers.set(folder, watcher)
          watcher.on('error', () => {
            if (watchers.get(folder) !== watcher) return
            watchers.delete(folder)
            watcher.close()
          })
        } catch { /* The catalog can still refresh when the panel opens. */ }
      }
    },
    close() {
      closed = true
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    },
  }
}

export async function readPluginFile(root, relative) {
  const rootReal = await realpath(root)
  const rootStat = await lstat(rootReal)
  if (!rootStat.isDirectory()) throw new Error('Plugin folder is not a directory')
  const candidate = path.resolve(rootReal, ...pluginRelativeParts(relative))
  let fileReal
  try { fileReal = await realpath(candidate) }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    const compiled = /\.m?js$/i.test(relative)
    throw Object.assign(new Error(compiled
      ? `Missing built plugin entry ${relative}. Build the plugin to generate the JavaScript named by main.`
      : `Missing plugin file ${relative}`), { code: 'PLUGIN_FILE_MISSING' })
  }
  const rel = path.relative(rootReal, fileReal)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Plugin file escapes its folder')
  const stat = await lstat(fileReal)
  if (!stat.isFile()) throw new Error('Plugin file is not a file')
  const limit = relative === 'manifest.json' ? PLUGIN_MANIFEST_BYTES : relative.endsWith('.html') ? PLUGIN_UI_BYTES : PLUGIN_FILE_BYTES
  if (stat.size > limit) throw new Error('Plugin file is too large')
  return readFile(fileReal, 'utf8')
}

export function createPluginDirectoryHost() {
  const grants = new Map()
  let declared = new Map()
  let picked = null
  return {
    async take(root) {
      const id = randomUUID()
      const rootReal = await realpath(root)
      const manifestText = await readLocalPluginManifest(rootReal)
      if (picked) grants.delete(picked)
      picked = id
      grants.set(id, { root: rootReal, manifestText })
      return { grant: id, manifestText, displayName: path.basename(rootReal) }
    },
    /** Refresh declarations and retain grants for unchanged packages and the picked folder. */
    enableDeclared(plugins) {
      const enabled = []
      const next = new Map()
      for (const plugin of Array.isArray(plugins) ? plugins : []) {
        if (enabled.length >= LOCAL_PLUGIN_ENABLE_LIMIT) break
        if (!plugin || typeof plugin.root !== 'string' || typeof plugin.id !== 'string' || typeof plugin.name !== 'string' || typeof plugin.manifestText !== 'string') continue
        if (next.has(plugin.id)) continue
        const previous = declared.get(plugin.id)
        const unchanged = previous?.root === plugin.root && previous.manifestText === plugin.manifestText
        const grant = unchanged ? previous.grant : randomUUID()
        if (!unchanged) grants.set(grant, { root: plugin.root, manifestText: plugin.manifestText })
        next.set(plugin.id, { grant, root: plugin.root, manifestText: plugin.manifestText })
        enabled.push({ grant, id: plugin.id, name: plugin.name, displayName: plugin.name, manifestText: plugin.manifestText })
      }
      for (const [id, entry] of declared) {
        if (next.get(id)?.grant !== entry.grant) grants.delete(entry.grant)
      }
      declared = next
      return enabled
    },
    async read(id, paths) {
      const entry = grants.get(id)
      if (!entry) throw Object.assign(new Error('Plugin folder is no longer authorized'), { code: 'PLUGIN_GRANT' })
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2) throw new Error('Invalid plugin read')
      const files = {}
      for (const relative of paths) files[relative] = await readPluginFile(entry.root, relative)
      if (grants.get(id) !== entry) throw Object.assign(new Error('Plugin folder is no longer authorized'), { code: 'PLUGIN_GRANT' })
      return { files }
    },
    storageScope(id) {
      const entry = grants.get(id)
      if (!entry) throw Object.assign(new Error('Plugin folder is no longer authorized'), { code: 'PLUGIN_GRANT' })
      const plugin = parseDeclaredPluginManifest(entry.manifestText)
      return createHash('sha256').update('folder-plugin\0').update(entry.root).update('\0').update(plugin.id).digest('hex')
    },
    clear() {
      if (!picked) return
      grants.delete(picked)
      picked = null
    },
  }
}
