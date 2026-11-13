// Explicit desktop writes for exports that must not use the
// generic blob allowlist. The renderer cannot choose a directory, an extension,
// or a network URL. FD bytes must be a version-2 checksum container. ZIP bytes
// carry a validated HTML/CSS manifest or a verified preset asset manifest.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

export const FD_EXPORT_BYTE_LIMIT = 64 * 1024 * 1024
export const HTML_ZIP_BYTE_LIMIT = 8 * 1024 * 1024
export const ASSET_ZIP_BYTE_LIMIT = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 503
const ZIP_LOCAL = 0x04034b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_EOCD = 0x06054b50
const REQUIRED = ['index.html', 'styles.css', 'design-manifest.json']
const ASSET_NAME = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpg|webp|gif|avif)$/
const CODE_POLICY = "default-src 'none'; style-src 'self'; img-src 'self' data: https: http:; script-src 'none'; object-src 'none'; base-uri 'none'"
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function reject(reason, extra = {}) {
  throw Object.assign(new Error(reason), { code: 'PRODUCT_EXPORT_REJECTED', reason, ...extra })
}

function crc32(bytes) {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export function coerceExportBytes(value, limit) {
  const view = Buffer.isBuffer(value) || value instanceof Uint8Array ? value : null
  if (!view || Array.isArray(value)) reject('bytes')
  const size = view.byteLength
  if (!Number.isSafeInteger(size) || size < 1 || size > limit) reject('size')
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

function validateFd(bytes) {
  if (bytes.length < 15) reject('size')
  if (bytes[0] !== 0x46 || bytes[1] !== 0x58 || bytes[2] !== 0x44 || bytes[3] !== 0x4b) reject('magic')
  if (bytes.readUInt16LE(4) !== 2) reject('version')
  const actual = bytes.subarray(6, 14)
  const expected = createHash('sha256').update(bytes.subarray(14)).digest().subarray(0, 8)
  if (!timingSafeEqual(actual, expected)) reject('checksum')
  return bytes
}

function need(bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) reject('truncated')
}

function decodeName(raw) {
  let name
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(raw) }
  catch { reject('name') }
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith('/')) reject('name')
  const parts = name.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) reject('name')
  return name
}

function imageBytes(name, bytes) {
  const extension = name.slice(name.lastIndexOf('.') + 1)
  if (extension === 'png') return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  if (extension === 'jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (extension === 'gif') return bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')
  if (extension === 'webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (extension === 'avif') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp'
  return false
}

function text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { reject('bundle') }
}

function assertBundle(files) {
  for (const name of REQUIRED) if (!files.has(name)) reject('bundle')
  const assets = []
  for (const name of files.keys()) {
    if (REQUIRED.includes(name)) continue
    if (!ASSET_NAME.test(name)) reject('entries')
    assets.push(name)
  }
  const html = text(files.get('index.html'))
  const css = text(files.get('styles.css'))
  if (!html.toLowerCase().startsWith('<!doctype html>') || !html.includes(CODE_POLICY) || !html.includes('<main class="design-scene">') || /<(?:script|iframe|object|embed|base|form|svg|math)\b/i.test(html)) reject('bundle')
  if (!css.includes('.design-scene{') || /@import/i.test(css)) reject('bundle')
  let manifest
  try { manifest = JSON.parse(text(files.get('design-manifest.json'))) }
  catch { reject('bundle') }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) reject('bundle')
  if (manifest.format !== 'futureox.design-code.v1' || manifest.language !== 'html-css' || manifest.fidelity !== 'approximate') reject('bundle')
  if (Object.hasOwn(manifest, 'html') || Object.hasOwn(manifest, 'css')) reject('bundle')
  for (const key of ['sourceDocumentId', 'pageId']) {
    const value = manifest[key]
    if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u001f]/.test(value)) reject('bundle')
  }
  if (!manifest.nodeIdMap || typeof manifest.nodeIdMap !== 'object' || Array.isArray(manifest.nodeIdMap) || !Array.isArray(manifest.assets) || !Array.isArray(manifest.warnings)) reject('bundle')
  const emitted = new Set()
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) || Object.hasOwn(asset, 'dataUrl')) reject('bundle')
    if (asset.emitted === true && typeof asset.path === 'string') emitted.add(asset.path)
  }
  for (const name of assets) {
    if (!emitted.has(name) || !imageBytes(name, files.get(name))) reject('bundle')
  }
}

const ASSET_EXPORT_EXTENSIONS = { png: 'png', jpeg: 'jpg', jpg: 'jpg', webp: 'webp', svg: 'svg', pdf: 'pdf', 'pdf-vector': 'pdf', tiff: 'tiff' }

function assertAssetBundle(files) {
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) reject('bundle')
  let manifest
  try { manifest = JSON.parse(text(manifestBytes)) }
  catch { reject('bundle') }
  if (manifest?.kind !== 'futureox-all-assets' || manifest.version !== 1 ||
      !Array.isArray(manifest.items) || manifest.items.length > MAX_ZIP_ENTRIES - 1) reject('bundle')
  const names = new Set()
  for (const item of manifest.items) {
    if (!item || typeof item.path !== 'string') reject('bundle')
    if (item.status !== 'delivered') continue
    const name = item.path.normalize('NFC').toLowerCase()
    if (name === 'manifest.json' || item.path.includes('/') || names.has(name)) reject('entries')
    const extension = Object.hasOwn(ASSET_EXPORT_EXTENSIONS, item.format) ? ASSET_EXPORT_EXTENSIONS[item.format] : null
    const data = files.get(item.path)
    if (!extension || !item.path.endsWith('.' + extension) || !data?.length || data.length !== item.bytes ||
        createHash('sha256').update(data).digest('hex') !== item.sha256) reject('bundle')
    names.add(name)
  }
  if (!names.size || names.size !== files.size - 1) reject('entries')
}
function productLimit(kind) {
  if (kind === 'fd') return FD_EXPORT_BYTE_LIMIT
  if (kind === 'html-zip') return HTML_ZIP_BYTE_LIMIT
  if (kind === 'assets-zip') return ASSET_ZIP_BYTE_LIMIT
  reject('kind')
}

function validateZip(bytes, limit, validateBundle, minEntries) {
  if (bytes.length < 22 || bytes.readUInt32LE(bytes.length - 22) !== ZIP_EOCD) reject('eocd')
  const eocd = bytes.length - 22
  if (bytes.readUInt16LE(eocd + 4) !== 0 || bytes.readUInt16LE(eocd + 6) !== 0) reject('disk')
  const count = bytes.readUInt16LE(eocd + 8)
  if (count !== bytes.readUInt16LE(eocd + 10) || count < minEntries || count > MAX_ZIP_ENTRIES) reject('entries')
  const directorySize = bytes.readUInt32LE(eocd + 12)
  const directoryOffset = bytes.readUInt32LE(eocd + 16)
  if (bytes.readUInt16LE(eocd + 20) !== 0 || directoryOffset >= eocd || directoryOffset + directorySize !== eocd) reject('layout')
  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    need(bytes, cursor, 46)
    if (bytes.readUInt32LE(cursor) !== ZIP_CENTRAL) reject('central')
    const flags = bytes.readUInt16LE(cursor + 8)
    const method = bytes.readUInt16LE(cursor + 10)
    const crc = bytes.readUInt32LE(cursor + 16)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    if ((flags & ~0x800) !== 0 || (method !== 0 && method !== 8)) reject(method === 0 || method === 8 ? 'flags' : 'method')
    if (bytes.readUInt16LE(cursor + 30) !== 0 || bytes.readUInt16LE(cursor + 32) !== 0 || bytes.readUInt16LE(cursor + 34) !== 0) reject('extra')
    if (bytes.readUInt16LE(cursor + 36) !== 0 || bytes.readUInt32LE(cursor + 38) !== 0) reject('attributes')
    const localOffset = bytes.readUInt32LE(cursor + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) reject('zip64')
    need(bytes, cursor + 46, nameLength)
    const name = decodeName(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    cursor += 46 + nameLength
    entries.push({ flags, method, crc, compressedSize, uncompressedSize, localOffset, name })
  }
  if (cursor !== eocd) reject('layout')
  const occupied = []
  const occupy = (start, end) => {
    if (end > directoryOffset) reject('layout')
    for (const [left, right] of occupied) if (start < right && left < end) reject('overlap')
    occupied.push([start, end])
  }
  const files = new Map()
  let uncompressedTotal = 0
  let firstOffset = Infinity
  for (const entry of entries) {
    if (files.has(entry.name)) reject('entries')
    if (entry.localOffset >= directoryOffset) reject('layout')
    need(bytes, entry.localOffset, 30)
    if (bytes.readUInt32LE(entry.localOffset) !== ZIP_LOCAL) reject('local')
    const flags = bytes.readUInt16LE(entry.localOffset + 6)
    const method = bytes.readUInt16LE(entry.localOffset + 8)
    const crc = bytes.readUInt32LE(entry.localOffset + 14)
    const compressedSize = bytes.readUInt32LE(entry.localOffset + 18)
    const uncompressedSize = bytes.readUInt32LE(entry.localOffset + 22)
    const nameLength = bytes.readUInt16LE(entry.localOffset + 26)
    const extraLength = bytes.readUInt16LE(entry.localOffset + 28)
    if (flags !== entry.flags || method !== entry.method || crc !== entry.crc || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize || extraLength !== 0) reject('local')
    need(bytes, entry.localOffset + 30, nameLength)
    if (decodeName(bytes.subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength)) !== entry.name) reject('local')
    const dataStart = entry.localOffset + 30 + nameLength
    const dataEnd = dataStart + compressedSize
    need(bytes, dataStart, compressedSize)
    occupy(entry.localOffset, dataEnd)
    if (uncompressedSize > limit || uncompressedTotal + uncompressedSize > limit) reject('size')
    uncompressedTotal += uncompressedSize
    const compressed = bytes.subarray(dataStart, dataEnd)
    let inflated
    if (method === 0) {
      if (compressedSize !== uncompressedSize) reject('method')
      inflated = Buffer.from(compressed)
    } else {
      try { inflated = inflateRawSync(compressed, { maxOutputLength: uncompressedSize }) }
      catch { reject('inflate') }
      if (inflated.length !== uncompressedSize) reject('inflate')
    }
    if (crc32(inflated) !== entry.crc) reject('crc')
    files.set(entry.name, inflated)
    if (entry.localOffset < firstOffset) firstOffset = entry.localOffset
  }
  occupied.sort((left, right) => left[0] - right[0])
  let packed = 0
  for (const [start, end] of occupied) {
    if (start !== packed) reject('layout')
    packed = end
  }
  if (firstOffset !== 0 || packed !== directoryOffset) reject('layout')
  validateBundle(files)
  return bytes
}

export function validateProductExport(kind, value, limit = productLimit(kind)) {
  if (!Number.isSafeInteger(limit) || limit < 1) reject('size')
  const bounded = Math.min(limit, productLimit(kind))
  const bytes = coerceExportBytes(value, bounded)
  if (kind === 'fd') return validateFd(bytes)
  return kind === 'html-zip' ? validateZip(bytes, bounded, assertBundle, REQUIRED.length)
    : validateZip(bytes, bounded, assertAssetBundle, 2)
}

export function exportDialogName(kind, filename) {
  const fallback = kind === 'fd' ? 'design.fd' : kind === 'assets-zip' ? 'design-assets.zip' : 'design-html.zip'
  const expected = kind === 'fd' ? '.fd' : '.zip'
  if ((kind !== 'fd' && kind !== 'html-zip' && kind !== 'assets-zip') || typeof filename !== 'string') return fallback
  if (filename.length > 80 || filename.length < expected.length + 1 || path.basename(filename) !== filename) return fallback
  if (/[\u0000-\u001f\u007f\\/]/.test(filename) || filename === '.' || filename === '..') return fallback
  if (path.extname(filename).toLowerCase() !== expected) return fallback
  return filename
}

export function normalizeExportChoice(kind, filePath) {
  const expected = kind === 'fd' ? '.fd' : kind === 'html-zip' || kind === 'assets-zip' ? '.zip' : ''
  if (!expected) reject('kind')
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0') || !path.isAbsolute(filePath)) reject('path', { actual: '' })
  let selected = filePath
  let appended = false
  if (!path.extname(selected)) {
    selected += expected
    appended = true
  }
  const actual = path.extname(selected).toLowerCase()
  if (actual !== expected) reject('extension', { actual })
  const basename = path.basename(selected)
  if (!basename || basename === '.' || basename === '..' || basename.length > 200 || /[\u0000-\u001f\u007f\\/]/.test(basename)) reject('name', { actual })
  return { directory: path.dirname(selected), basename, appended }
}

async function writeProductExportFile(target, bytes) {
  const payload = Buffer.from(bytes)
  const temporary = path.join(path.dirname(target), `.futureox-export-${randomUUID()}.tmp`)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0)
  const handle = await open(temporary, flags, 0o644)
  try {
    await handle.writeFile(payload)
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
  const directory = await open(path.dirname(target), constants.O_RDONLY | (constants.O_DIRECTORY || 0))
  try { await directory.sync() } catch { /* Directory fsync is best-effort after the rename. */ } finally { await directory.close() }
  const written = await readFile(target)
  if (written.length !== payload.length || !written.equals(payload)) {
    await rm(target, { force: true }).catch(() => {})
    reject('write')
  }
}

export async function publishProductExport(choice, bytes) {
  const directory = await realpath(choice.directory)
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory()) reject('path')
  const target = path.resolve(directory, choice.basename)
  if (path.relative(directory, target) !== choice.basename) reject('path')
  let existing = null
  try { existing = await lstat(target) }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (existing && !existing.isFile()) reject('path')
  if (existing && choice.appended) reject('exists')
  await writeProductExportFile(target, bytes)
  return target
}
