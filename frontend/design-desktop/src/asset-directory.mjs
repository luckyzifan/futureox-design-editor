// Controlled delivery for per-layer preset batches. The renderer cannot choose
// a directory or a zip path. Names stay single path segments, and the host
// rewrites the manifest from the files it actually stored.
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const ASSET_MANIFEST_NAME = 'asset-manifest.json'
export const ASSET_MANIFEST_FORMAT = 'futureox.asset-batch.v1'
export const ASSET_FILE_BYTE_LIMIT = 64 * 1024 * 1024
export const ASSET_BATCH_BYTE_LIMIT = 64_000_000 * 4
export const ASSET_TASK_LIMIT = 1000
const EXTENSIONS = new Set(['.png', '.svg', '.svgz', '.jpg', '.jpeg', '.webp', '.pdf'])

function reject(reason) {
  throw Object.assign(new Error(reason), { code: 'ASSET_EXPORT_REJECTED', reason })
}

function crc32(bytes) {
  if (!crc32.table) {
    const table = new Uint32Array(256)
    for (let index = 0; index < 256; index += 1) {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[index] = value >>> 0
    }
    crc32.table = table
  }
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) value = crc32.table[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export function validAssetFileName(name) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 200) return false
  if (name !== path.basename(name) || name === '.' || name === '..' || name === ASSET_MANIFEST_NAME) return false
  if (name.startsWith('.') || /[. ]$/.test(name) || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(name)) return false
  return EXTENSIONS.has(path.extname(name).toLowerCase())
}

function asBytes(value, limit) {
  const view = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : null
  if (!view || Array.isArray(value)) reject('bytes')
  const size = view.byteLength
  if (!Number.isSafeInteger(size) || size < 1 || size > limit) reject('size')
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

function textField(value, limit) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f]/.test(value)) reject('manifest')
  return value
}

function admitFiles(value) {
  if (!Array.isArray(value) || value.length > ASSET_TASK_LIMIT) reject('count')
  const files = []
  const names = new Set()
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => key !== 'name' && key !== 'bytes')) reject('file')
    if (!validAssetFileName(item.name) || names.has(item.name)) reject('name')
    const bytes = asBytes(item.bytes, ASSET_FILE_BYTE_LIMIT)
    total += bytes.length
    if (total > ASSET_BATCH_BYTE_LIMIT) reject('size')
    names.add(item.name)
    files.push({ name: item.name, bytes })
  }
  return files
}

function admitTask(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('manifest')
  const allowed = ['taskId', 'nodeId', 'settingId', 'revision', 'format', 'scale', 'suffix', 'path', 'status', 'byteLength', 'width', 'height', 'error']
  if (Object.keys(value).some(key => !allowed.includes(key))) reject('manifest')
  if (!['succeeded', 'failed', 'cancelled'].includes(value.status)) reject('manifest')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) reject('manifest')
  if (typeof value.scale !== 'number' || !Number.isFinite(value.scale)) reject('manifest')
  return {
    taskId: textField(value.taskId, 256),
    nodeId: textField(value.nodeId, 128),
    settingId: textField(value.settingId, 128),
    revision: value.revision,
    format: textField(value.format, 32),
    scale: value.scale,
    suffix: typeof value.suffix === 'string' && value.suffix.length <= 80 && !/[\u0000-\u001f]/.test(value.suffix) ? value.suffix : reject('manifest'),
    path: textField(value.path, 200),
    status: value.status,
    ...(typeof value.error === 'string' && value.error.length <= 400 ? { error: value.error } : {}),
    ...(Number.isSafeInteger(value.byteLength) && value.byteLength > 0 ? { byteLength: value.byteLength } : {}),
  }
}

function admitManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('manifest')
  const allowed = ['format', 'documentId', 'pageId', 'revision', 'complete', 'fileCount', 'tasks']
  if (Object.keys(value).some(key => !allowed.includes(key))) reject('manifest')
  if (value.format !== ASSET_MANIFEST_FORMAT) reject('manifest')
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) reject('manifest')
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0 || value.fileCount > ASSET_TASK_LIMIT) reject('count')
  if (typeof value.complete !== 'boolean' || !Array.isArray(value.tasks) || value.tasks.length > ASSET_TASK_LIMIT) reject('manifest')
  const tasks = value.tasks.map(admitTask)
  const succeeded = tasks.filter(task => task.status === 'succeeded')
  const complete = tasks.length > 0 && succeeded.length === tasks.length
  if (value.fileCount !== succeeded.length || value.complete !== complete) reject('complete')
  return {
    format: ASSET_MANIFEST_FORMAT,
    documentId: textField(value.documentId, 128),
    pageId: textField(value.pageId, 128),
    revision: value.revision,
    complete,
    fileCount: succeeded.length,
    tasks,
  }
}

export function admitAssetBatch(filesValue, manifestValue) {
  const files = admitFiles(filesValue)
  const manifest = admitManifest(manifestValue)
  const succeeded = manifest.tasks.filter(task => task.status === 'succeeded')
  const names = files.map(file => file.name)
  if (names.length !== succeeded.length || succeeded.some(task => !names.includes(task.path))) reject('count')
  if (JSON.stringify(manifest).length > 1024 * 1024) reject('manifest')
  return { files, manifest }
}

function settledManifest(batch, results) {
  const byName = new Map(results.map(item => [item.name, item]))
  const tasks = batch.manifest.tasks.map(task => {
    if (task.status !== 'succeeded') return task
    const result = byName.get(task.path)
    const bytes = batch.files.find(file => file.name === task.path)?.bytes
    if (result?.written && bytes) return { ...task, status: 'succeeded', byteLength: bytes.length }
    return { ...task, status: 'failed', error: result?.reason === 'exists' ? '目标位置已有同名文件' : '文件没有写入' }
  })
  const fileCount = tasks.filter(task => task.status === 'succeeded').length
  const complete = tasks.length > 0 && fileCount === tasks.length && tasks.every(task => task.status === 'succeeded')
  return {
    format: ASSET_MANIFEST_FORMAT,
    documentId: batch.manifest.documentId,
    pageId: batch.manifest.pageId,
    revision: batch.manifest.revision,
    complete,
    fileCount,
    tasks,
  }
}

async function writeNewFile(target, bytes) {
  const temporary = path.join(path.dirname(target), `.futureox-assets-${randomUUID()}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)
  const handle = await open(temporary, flags, 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  await handle.close()
  try { await rename(temporary, target) }
  catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function publishAssetDirectory(directory, batch) {
  if (typeof directory !== 'string' || !directory) reject('path')
  const root = await realpath(directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) reject('path')
  const results = []
  for (const file of batch.files) {
    const target = path.resolve(root, file.name)
    if (path.relative(root, target) !== file.name) {
      results.push({ name: file.name, written: false, reason: 'path' })
      continue
    }
    let existing = null
    try { existing = await lstat(target) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (existing) {
      results.push({ name: file.name, written: false, reason: existing.isFile() ? 'exists' : 'path' })
      continue
    }
    try {
      await writeNewFile(target, file.bytes)
      const written = await readFile(target)
      if (written.length !== file.bytes.length || !written.equals(file.bytes)) {
        await rm(target, { force: true }).catch(() => {})
        results.push({ name: file.name, written: false, reason: 'write' })
      } else results.push({ name: file.name, written: true })
    } catch {
      results.push({ name: file.name, written: false, reason: 'write' })
    }
  }
  const manifest = settledManifest(batch, results)
  const manifestPath = path.resolve(root, ASSET_MANIFEST_NAME)
  let manifestName
  if (path.relative(root, manifestPath) === ASSET_MANIFEST_NAME) {
    let existing = null
    try { existing = await lstat(manifestPath) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    if (!existing || existing.isFile()) {
      const body = Buffer.from(JSON.stringify(manifest))
      try {
        await writeNewFile(manifestPath, body)
        const written = await readFile(manifestPath)
        if (written.equals(body)) manifestName = ASSET_MANIFEST_NAME
        else await rm(manifestPath, { force: true }).catch(() => {})
      } catch { manifestName = undefined }
    }
  }
  const fileCount = results.filter(item => item.written).length
  const complete = manifest.complete && manifestName === ASSET_MANIFEST_NAME && fileCount === manifest.fileCount
  return {
    fileCount,
    complete,
    ...(manifestName ? { manifestName } : {}),
    results,
    manifest: { ...manifest, complete },
  }
}

export function storedZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    if (!entry?.name || entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) reject('name')
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.from(entry.bytes)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const chunk = Buffer.concat([local, name, data])
    locals.push(chunk)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, name]))
    offset += chunk.length
  }
  const directory = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(directory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, eocd])
}

export function readStoredZip(bytes) {
  const source = Buffer.from(bytes)
  if (source.length < 22 || source.readUInt32LE(source.length - 22) !== 0x06054b50) reject('zip')
  const eocd = source.length - 22
  const count = source.readUInt16LE(eocd + 8)
  const directorySize = source.readUInt32LE(eocd + 12)
  const directoryOffset = source.readUInt32LE(eocd + 16)
  if (directoryOffset + directorySize !== eocd) reject('zip')
  const files = new Map()
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (source.readUInt32LE(cursor) !== 0x02014b50) reject('zip')
    const method = source.readUInt16LE(cursor + 10)
    const compressed = source.readUInt32LE(cursor + 20)
    const size = source.readUInt32LE(cursor + 24)
    const nameLength = source.readUInt16LE(cursor + 28)
    const localOffset = source.readUInt32LE(cursor + 42)
    if (method !== 0 || compressed !== size) reject('zip')
    const name = source.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength
    if (source.readUInt32LE(localOffset) !== 0x04034b50) reject('zip')
    const localName = source.readUInt16LE(localOffset + 26)
    const dataStart = localOffset + 30 + localName
    files.set(name, source.subarray(dataStart, dataStart + size))
  }
  return files
}

export function assetZipDialogName(filename) {
  if (typeof filename !== 'string') return 'assets.zip'
  const base = path.basename(filename)
  if (base !== filename || base.length > 80 || !base.toLowerCase().endsWith('.zip')) return 'assets.zip'
  if (/[\u0000-\u001f\u007f\\/:*?"<>|]/.test(base) || base === '.zip') return 'assets.zip'
  return base
}

export function normalizeAssetZipChoice(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) reject('path')
  let selected = filePath
  let appended = false
  if (!path.extname(selected)) {
    selected += '.zip'
    appended = true
  }
  const extension = path.extname(selected).toLowerCase()
  if (extension !== '.zip') reject('extension')
  const basename = path.basename(selected)
  if (!basename || basename === '.' || basename === '..' || basename.length > 200 || /[\u0000-\u001f\u007f\\/]/.test(basename)) reject('name')
  return { directory: path.dirname(selected), basename, appended }
}

export async function publishAssetZip(choice, batch) {
  const manifest = settledManifest(batch, batch.files.map(file => ({ name: file.name, written: true })))
  if (manifest.fileCount !== batch.files.length || manifest.complete !== batch.manifest.complete) reject('complete')
  const entries = [
    ...batch.files.map(file => ({ name: file.name, bytes: file.bytes })),
    { name: ASSET_MANIFEST_NAME, bytes: Buffer.from(JSON.stringify(manifest)) },
  ]
  const zip = storedZip(entries)
  if (zip.length > ASSET_BATCH_BYTE_LIMIT) reject('size')
  const read = readStoredZip(zip)
  if (read.size !== entries.length) reject('zip')
  for (const entry of entries) {
    const got = read.get(entry.name)
    if (!got || got.length !== entry.bytes.length || !got.equals(Buffer.from(entry.bytes))) reject('zip')
  }
  const root = await realpath(choice.directory)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory()) reject('path')
  const target = path.resolve(root, choice.basename)
  if (path.relative(root, target) !== choice.basename) reject('path')
  let existing = null
  try { existing = await lstat(target) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (existing && (!existing.isFile() || choice.appended)) reject(existing.isFile() ? 'exists' : 'path')
  await writeNewFile(target, zip)
  const written = await readFile(target)
  if (!written.equals(zip)) {
    await rm(target, { force: true }).catch(() => {})
    reject('write')
  }
  return { fileCount: manifest.fileCount, complete: manifest.complete, manifest }
}
