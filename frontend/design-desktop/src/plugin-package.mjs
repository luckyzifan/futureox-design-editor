import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const PLUGIN_MANIFEST_BYTES = 64 * 1024
export const PLUGIN_FILE_BYTES = 1024 * 1024
export const LOCAL_PLUGIN_SCAN_LIMIT = 64
export const LOCAL_PLUGIN_ENABLE_LIMIT = 32
const suffixes = new Set(['js', 'mjs', 'html', 'json', 'css', 'svg'])

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

/** Same declaration rules as the client manifest parser. A valid manifest enables a plugin; it does not run it. */
export function parseDeclaredPluginManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > PLUGIN_MANIFEST_BYTES) throw new Error('Invalid plugin manifest')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('Invalid plugin manifest') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin manifest')
  const name = requiredText(value.name, 64)
  const id = requiredText(value.id, 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new Error('Invalid plugin manifest')
  requiredText(value.api, 32)
  const main = pluginRelativeParts(value.main).join('/')
  const ui = value.ui === undefined ? undefined : pluginRelativeParts(value.ui).join('/')
  const editorType = value.editorType === undefined ? ['figma'] : value.editorType
  if (!Array.isArray(editorType) || editorType.some(item => typeof item !== 'string') || !editorType.includes('figma')) {
    throw new Error('Invalid plugin manifest')
  }
  return { id, name, main, ui }
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
  const entries = await readdir(rootReal, { withFileTypes: true })
  const names = entries
    .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && pluginFolderName(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
  const plugins = []
  let skipped = 0
  const seen = new Set()
  for (const name of names.slice(0, scanLimit)) {
    if (plugins.length >= enableLimit) { skipped += 1; continue }
    try {
      const listed = path.join(rootReal, name)
      const stat = await lstat(listed)
      if (!stat.isDirectory() || stat.isSymbolicLink()) { skipped += 1; continue }
      const folderReal = await realpath(listed)
      const rel = path.relative(rootReal, folderReal)
      if (rel !== name || path.isAbsolute(rel)) { skipped += 1; continue }
      const manifestText = await readPluginFile(folderReal, 'manifest.json')
      const manifest = parseDeclaredPluginManifest(manifestText)
      if (seen.has(manifest.id)) { skipped += 1; continue }
      await readPluginFile(folderReal, manifest.main)
      if (manifest.ui) await readPluginFile(folderReal, manifest.ui)
      seen.add(manifest.id)
      plugins.push({ id: manifest.id, name: manifest.name, manifestText, root: folderReal })
    } catch { skipped += 1 }
  }
  return { plugins, skipped, truncated: names.length > scanLimit }
}

export async function readPluginFile(root, relative) {
  const rootReal = await realpath(root)
  const rootStat = await lstat(rootReal)
  if (!rootStat.isDirectory()) throw new Error('Plugin folder is not a directory')
  const candidate = path.resolve(rootReal, ...pluginRelativeParts(relative))
  const fileReal = await realpath(candidate)
  const rel = path.relative(rootReal, fileReal)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Plugin file escapes its folder')
  const stat = await lstat(fileReal)
  if (!stat.isFile()) throw new Error('Plugin file is not a file')
  if (stat.size > (relative === 'manifest.json' ? PLUGIN_MANIFEST_BYTES : PLUGIN_FILE_BYTES)) throw new Error('Plugin file is too large')
  return readFile(fileReal, 'utf8')
}

export function createPluginDirectoryHost() {
  const grants = new Map()
  let picked = null
  return {
    async take(root) {
      const id = randomUUID()
      const rootReal = await realpath(root)
      const manifestText = await readPluginFile(rootReal, 'manifest.json')
      if (picked) grants.delete(picked)
      picked = id
      grants.set(id, { root: rootReal, declared: false })
      return { grant: id, manifestText, displayName: path.basename(rootReal) }
    },
    /** Session grants for plugins declared at startup. Replaces earlier declared grants and keeps a picked folder. */
    enableDeclared(plugins) {
      for (const [id, entry] of [...grants]) if (entry.declared) grants.delete(id)
      const enabled = []
      const seen = new Set()
      if (!Array.isArray(plugins)) return enabled
      for (const plugin of plugins) {
        if (enabled.length >= LOCAL_PLUGIN_ENABLE_LIMIT) break
        if (!plugin || typeof plugin.root !== 'string' || typeof plugin.id !== 'string' || typeof plugin.name !== 'string' || typeof plugin.manifestText !== 'string') continue
        if (seen.has(plugin.id)) continue
        seen.add(plugin.id)
        const grant = randomUUID()
        grants.set(grant, { root: plugin.root, declared: true })
        enabled.push({ grant, id: plugin.id, name: plugin.name, displayName: plugin.name, manifestText: plugin.manifestText })
      }
      return enabled
    },
    async read(id, paths) {
      const entry = grants.get(id)
      if (!entry) throw Object.assign(new Error('Plugin folder is no longer authorized'), { code: 'PLUGIN_GRANT' })
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2) throw new Error('Invalid plugin read')
      const files = {}
      for (const relative of paths) files[relative] = await readPluginFile(entry.root, relative)
      return { files }
    },
    clear() {
      if (!picked) return
      grants.delete(picked)
      picked = null
    },
  }
}
