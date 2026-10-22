// Private desktop stdio transport. The per-frame boundary remains independent
// from the admitted complete request; no MCP transport uses these envelopes.
export const DOCUMENT_CHUNK_BYTES = 1024 * 1024
export function *documentFrames(bytes, transferId, frameLimit) {
  if (bytes.length <= frameLimit) { yield Buffer.concat([bytes, Buffer.from('\n')]); return }
  for (let offset = 0; offset < bytes.length; offset += DOCUMENT_CHUNK_BYTES) {
    yield Buffer.from(JSON.stringify({ desktopChunk: { version: 1, id: transferId, total: bytes.length, offset,
      data: bytes.subarray(offset, offset + DOCUMENT_CHUNK_BYTES).toString('base64') } }) + '\n')
  }
}
export class DocumentFrameAssembler {
  constructor(limit) { this.limit = limit; this.active = undefined }
  clear() { this.active = undefined }
  accept(line) {
    // Normal JSON is parsed only by the caller. Small reserved envelopes are
    // detected before attempting to create a document-sized JS object.
    if (!line.subarray(0, 17).toString().startsWith('{"desktopChunk":')) {
      if (this.active) throw Error('Interrupted desktop document transfer')
      return line
    }
    const envelope = JSON.parse(line.toString('utf8'))
    const chunk = envelope.desktopChunk
    if (Object.keys(envelope).length !== 1 || !chunk || Object.keys(chunk).sort().join() !== 'data,id,offset,total,version' ||
      chunk.version !== 1 || typeof chunk.id !== 'string' || !chunk.id || chunk.id.length > 128 ||
      !Number.isSafeInteger(chunk.total) || chunk.total < 1 || chunk.total > this.limit ||
      !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || typeof chunk.data !== 'string' ||
      chunk.data.length > Math.ceil(DOCUMENT_CHUNK_BYTES / 3) * 4) throw Error('Invalid desktop document chunk')
    const bytes = Buffer.from(chunk.data, 'base64')
    if (!bytes.length || bytes.length > DOCUMENT_CHUNK_BYTES || bytes.toString('base64') !== chunk.data)
      throw Error('Invalid desktop document chunk encoding')
    if (!this.active) {
      if (chunk.offset !== 0) throw Error('Desktop document chunk sequence mismatch')
      this.active = { id: chunk.id, total: chunk.total, received: 0, parts: [] }
    }
    const active = this.active
    if (chunk.id !== active.id || chunk.total !== active.total || chunk.offset !== active.received || bytes.length > active.total - active.received)
      throw Error('Desktop document chunk sequence mismatch')
    active.parts.push(bytes); active.received += bytes.length
    if (active.received !== active.total) return undefined
    this.active = undefined
    return Buffer.concat(active.parts, active.total)
  }
}
