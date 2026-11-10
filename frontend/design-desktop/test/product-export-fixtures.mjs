import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const POLICY = "default-src 'none'; style-src 'self'; img-src 'self' data: https: http:; script-src 'none'; object-src 'none'; base-uri 'none'"
const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}
function crc32(bytes) {
  let value = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

export function makeFd(payload = 'design') {
  const body = Buffer.from(payload)
  const header = Buffer.alloc(14)
  header.write('FXDK')
  header.writeUInt16LE(2, 4)
  createHash('sha256').update(body).digest().copy(header, 6, 0, 8)
  return Buffer.concat([header, body])
}

export function productEntries({ asset = true, html, css, extra = [] } = {}) {
  const assets = asset ? [{ path: 'assets/image-1.png', emitted: true }] : []
  const entries = [
    ['index.html', Buffer.from(html ?? `<!doctype html>\n<html><head><meta http-equiv="Content-Security-Policy" content="${POLICY}"></head><body><main class="design-scene"></main></body></html>`)],
    ['styles.css', Buffer.from(css ?? '.design-scene{position:relative}\n')],
    ['design-manifest.json', Buffer.from(JSON.stringify({
      format: 'futureox.design-code.v1', language: 'html-css', fidelity: 'approximate',
      sourceDocumentId: 'doc-1', pageId: 'page-1', nodeIdMap: {}, assets, warnings: [],
    }))],
  ]
  if (asset) entries.push(['assets/image-1.png', PNG])
  return [...entries, ...extra]
}

export function makeZip(entries, { method = 8, flags = 0, declaredSize = new Map(), external = 0 } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, raw] of entries) {
    const nameBytes = Buffer.from(name)
    const data = Buffer.from(raw)
    const compressed = method === 0 ? data : deflateRawSync(data)
    const uncompressedSize = declaredSize.get(name) ?? data.length
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(uncompressedSize, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    nameBytes.copy(local, 30)
    compressed.copy(local, 30 + nameBytes.length)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(uncompressedSize, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(external, 38)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
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

export function productZip(options) {
  return makeZip(productEntries(options))
}
