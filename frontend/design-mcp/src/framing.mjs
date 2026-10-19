/** Bounded, newline-delimited UTF-8 framing. Does not implement an HTTP transport. */
export class JsonLineReader {
  constructor({ onLine, onError, maxBytes = 8 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new TypeError('Invalid frame limit')
    this.onLine = onLine
    this.onError = onError
    this.maxBytes = maxBytes
    this.buffer = Buffer.allocUnsafe(Math.min(65536, maxBytes))
    this.length = 0
    this.discarding = false
    this.decoder = new TextDecoder('utf-8', { fatal: true })
  }

  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline < 0 ? bytes.length : newline
      const part = bytes.subarray(offset, end)
      if (!this.discarding) {
        const needed = this.length + part.length
        if (needed > this.maxBytes) {
          this.length = 0
          this.discarding = true
          this.onError(new Error('Message exceeds the byte limit'), 'size')
        } else {
          if (needed > this.buffer.length) {
            const next = Buffer.allocUnsafe(Math.min(this.maxBytes, Math.max(needed, this.buffer.length * 2)))
            this.buffer.copy(next, 0, 0, this.length)
            this.buffer = next
          }
          part.copy(this.buffer, this.length)
          this.length = needed
        }
      }
      if (newline >= 0) {
        if (!this.discarding) {
          let line
          try { line = this.decoder.decode(this.buffer.subarray(0, this.length)) }
          catch { this.onError(new Error('Message is not valid UTF-8'), 'parse') }
          this.length = 0
          if (line !== undefined) this.onLine(line)
        }
        this.discarding = false
      }
      offset = end + 1
    }
  }

  end() {
    if (this.length) this.onError(new Error('Unterminated message at end of input'), 'parse')
    this.length = 0
    this.discarding = false
  }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
export const isRequestId = value => (typeof value === 'string' && value.length <= 256) || (typeof value === 'number' && Number.isSafeInteger(value))
