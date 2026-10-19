// Isolated FRB1 candidate; not a production implementation until reviewed.
export const MAX_METADATA_BYTES = 64 * 1024
export const MAX_RGBA_BYTES = 48 * 1024 * 1024
const MAX_PARTS = 65536
function copy(parts, start, target) {
  let position = 0, written = 0
  for (const part of parts) {
    const from = Math.max(0, start - position)
    const to = Math.min(part.length, start + target.length - position)
    if (from < to) { target.set(part.subarray(from, to), written); written += to - from }
    if (written === target.length) return
    position += part.length
  }
  if (written !== target.length) throw Error('Incomplete native render frame')
}
function range(parts, start, size) {
  let position = 0
  for (const part of parts) {
    if (start >= position && start + size <= position + part.length) return part.subarray(start - position, start - position + size)
    position += part.length
  }
  const result = Buffer.alloc(size)
  copy(parts, start, result)
  return result
}
export class NativeRenderFrame {
  constructor() { this.parts = []; this.received = 0; this.expected = undefined }
  append(chunk) {
    if (!chunk.length) return false
    this.received += chunk.length
    if (this.received > 12 + MAX_METADATA_BYTES + MAX_RGBA_BYTES || this.parts.length >= MAX_PARTS) throw Error('Native render frame exceeds limit')
    this.parts.push(chunk)
    if (!this.expected && this.received >= 12) {
      const header = range(this.parts, 0, 12)
      if (header.toString('ascii', 0, 4) !== 'FRB1') throw Error('Invalid native render protocol')
      const metadata = header.readUInt32LE(4), binary = header.readUInt32LE(8)
      if (!metadata || metadata > MAX_METADATA_BYTES || binary > MAX_RGBA_BYTES) throw Error('Native render payload exceeds limit')
      this.expected = { metadata, binary, total: 12 + metadata + binary }
    }
    if (!this.expected || this.received < this.expected.total) return false
    if (this.received !== this.expected.total) throw Error('Unexpected native render bytes')
    return true
  }
  decode({ session, id, kind }) {
    if (!this.expected || this.received !== this.expected.total) throw Error('Incomplete native render frame')
    const result = JSON.parse(range(this.parts, 12, this.expected.metadata).toString('utf8'))
    if (!result || result.session !== session || result.id !== id) throw Error('Native render sequence mismatch')
    if (result.type !== kind && result.type !== 'error') throw Error('Unexpected native render response')
    if (result.type === 'frame') {
      if (result.encoding !== 'rgba8' || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height * 4 !== this.expected.binary) throw Error('Invalid native render pixels')
      const rgba = new Uint8Array(this.expected.binary)
      copy(this.parts, 12 + this.expected.metadata, rgba)
      result.rgba = rgba
    } else if (this.expected.binary || result.encoding !== undefined || result.rgba !== undefined) throw Error('Unexpected native render payload')
    return result
  }
}
export function encodeCandidate(metadata, rgba = new Uint8Array()) {
  const json = Buffer.from(JSON.stringify(metadata))
  const header = Buffer.alloc(12)
  header.write('FRB1'); header.writeUInt32LE(json.length, 4); header.writeUInt32LE(rgba.length, 8)
  return [header, json, rgba]
}
