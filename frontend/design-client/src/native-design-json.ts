const MISSING = '原生文件响应缺少设计内容'

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function looksLikeDocument(value: Record<string, unknown>) {
  return typeof value.schemaVersion === 'number' || Array.isArray(value.pages) || (!!value.nodes && typeof value.nodes === 'object' && !Array.isArray(value.nodes))
}

function documentRecord(value: unknown): Record<string, unknown> | undefined {
  if (!plain(value)) return
  if (looksLikeDocument(value)) return value
  if (plain(value.document) && looksLikeDocument(value.document)) return value.document
  return
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value) && !(value instanceof DataView))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (!plain(value) || value.type !== 'Buffer' || !Array.isArray(value.data)) return
  if (value.data.length > 512 * 1024 * 1024) throw new Error('原生文件响应超过可读取的设计内容大小')
  const bytes = new Uint8Array(value.data.length)
  for (let i = 0; i < value.data.length; i++) {
    const byte = value.data[i]
    if (!Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255)
      throw new Error('原生文件响应不是有效的设计内容字节')
    bytes[i] = byte as number
  }
  return bytes
}

/** Native open/recovery/scene payloads are a JSON string, a parsed document, or UTF-8 bytes. */
export function nativeDesignJson(value: unknown): string {
  if (typeof value === 'string') {
    if (!value) throw new Error(MISSING)
    return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
  }
  const bytes = bytesOf(value)
  if (bytes) {
    if (!bytes.byteLength) throw new Error(MISSING)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new Error('原生文件响应不是有效的 UTF-8 设计内容') }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (!text) throw new Error(MISSING)
    return text
  }
  const document = documentRecord(value)
  if (!document) throw new Error(MISSING)
  try { return JSON.stringify(document) }
  catch (error) { throw new Error(`原生文件响应无法写成设计内容：${error instanceof Error ? error.message : String(error)}`) }
}
