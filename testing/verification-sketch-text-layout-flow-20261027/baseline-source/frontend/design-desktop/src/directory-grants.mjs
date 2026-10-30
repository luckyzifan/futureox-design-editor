import path from 'node:path'
import { open, lstat, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'

const invalid = () => Object.assign(new Error('Select the directory again'), { code: 'DIRECTORY_RESELECT' })
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs

/** Session-only authority. Persisted catalog rows are never capabilities. */
export class DirectoryGrants {
  constructor({ limit = 16 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new TypeError('Invalid directory grant limit')
    this.limit = limit
    this.entries = new Map()
  }
  async create(selected, protectedHandle) {
    if (!path.isAbsolute(selected)) throw invalid()
    const canonical = await realpath(selected)
    const before = await lstat(canonical, { bigint: true })
    if (!before.isDirectory() || before.isSymbolicLink()) throw invalid()
    const fd = await open(canonical, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0))
    try {
      const pinned = await fd.stat({ bigint: true })
      if (!identity(before, pinned)) throw invalid()
      const handle = randomUUID()
      const entry = { handle, path: canonical, fd, pinned, files: new Map() }
      await this.verify(entry)
      if (this.entries.size >= this.limit) {
        const evictable = [...this.entries.keys()].find((key) => key !== protectedHandle)
        if (!evictable) throw Object.assign(new Error('Directory grant capacity reached'), { code: 'DIRECTORY_LIMIT' })
        await this.revoke(evictable)
      }
      this.entries.set(handle, entry)
      return entry
    } catch (error) { await fd.close(); throw error }
  }
  async verify(entry) {
    try {
      const current = await lstat(entry.path, { bigint: true })
      if (!current.isDirectory() || current.isSymbolicLink() ||
          !identity(current, entry.pinned) || await realpath(entry.path) !== entry.path) throw invalid()
      return entry
    } catch { throw invalid() }
  }
  async lookup(handle) {
    const entry = this.entries.get(handle)
    if (!entry) throw invalid()
    try { return await this.verify(entry) }
    catch (error) { await this.revoke(handle); throw error }
  }
  async file(handle, fileId) {
    const entry = await this.lookup(handle)
    const name = entry.files.get(fileId)
    if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
        /[/\\\0:]/.test(name) || path.extname(name).toLowerCase() !== '.fd') throw invalid()
    const filename = path.join(entry.path, name)
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(filename) !== filename) throw invalid()
    return { entry, path: filename }
  }
  async revoke(handle) {
    const entry = this.entries.get(handle)
    this.entries.delete(handle)
    if (entry) await entry.fd.close()
  }
  async clear() { await Promise.all([...this.entries.keys()].map((handle) => this.revoke(handle))) }
}
