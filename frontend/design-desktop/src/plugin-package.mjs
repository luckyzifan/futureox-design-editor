import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const PLUGIN_MANIFEST_BYTES = 64 * 1024
export const PLUGIN_FILE_BYTES = 1024 * 1024
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
  let grant = null
  return {
    async take(root) {
      const id = randomUUID()
      const rootReal = await realpath(root)
      const manifestText = await readPluginFile(rootReal, 'manifest.json')
      grant = { id, root: rootReal }
      return { grant: id, manifestText, displayName: path.basename(rootReal) }
    },
    async read(id, paths) {
      if (!grant || grant.id !== id) throw Object.assign(new Error('Plugin folder is no longer authorized'), { code: 'PLUGIN_GRANT' })
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2) throw new Error('Invalid plugin read')
      const files = {}
      for (const relative of paths) files[relative] = await readPluginFile(grant.root, relative)
      return { files }
    },
    clear() { grant = null },
  }
}
