import { assertImportInputBytes } from './import-input-policy'
import { Inflate } from 'fflate'

const EXPANDED_LIMIT = 64 * 1024 * 1024
const ENTRY_LIMIT = 2048
const RATIO_LIMIT = 200
const SMALL_ENTRY = 4096
const fail = (reason: string): never => { throw new Error(`无效 FIG 归档：${reason}`) }
const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0)
  crcTable[n] = c >>> 0
}
function crcUpdate(crc: number, data: Uint8Array) {
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return crc
}
/** Streaming raw DEFLATE with an exact compressed endpoint and a caller-owned sink. */
export function inflateFigDeflate(bytes: Uint8Array, limit: number, onData: (chunk: Uint8Array) => void): void {
  if (!bytes.length || !Number.isSafeInteger(limit) || limit < 0 || limit > EXPANDED_LIMIT)
    fail('DEFLATE 数据或展开预算无效')
  let size = 0
  const stream = new Inflate(chunk => {
    size += chunk.length
    if (size > limit) fail('DEFLATE 实际展开长度超限')
    onData(chunk)
  })
  // Small input increments bound transient decoder output before our callback.
  for (let offset = 0; offset < bytes.length; offset += 1024)
    stream.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
  // fflate 0.8.3's public final flag only marks input completion, not BFINAL.
  // Its pinned streaming state retains one byte iff the endpoint is not byte-aligned.
  // Fail closed if that internal contract changes; never accept a truncated stream
  // or a valid DEFLATE stream followed by undeclared compressed payload.
  const state = stream as unknown as { s?: { f?: number; l?: unknown; p?: number; i?: number }; p?: Uint8Array }
  if (!state.s || state.s.f !== 1 || state.s.i !== 1 ||
      (state.s.l !== null && state.s.l !== undefined) || !Number.isInteger(state.s.p) ||
      state.s.p! < 0 || state.s.p! > 7 || !(state.p instanceof Uint8Array) ||
      state.p.length !== (state.s.p ? 1 : 0)) fail('DEFLATE 结束标记或压缩边界无效')
}
interface Entry {
  name: string
  rawName: Uint8Array
  directory: boolean
  flags: number
  method: number
  crc: number
  compressed: number
  expanded: number
  local: number
  start: number
}

/** Strict, bounded ZIP32 admission. Archive paths are data, never filesystem paths. */
export function figArchive(bytes: Uint8Array): Record<string, Uint8Array> {
  assertImportInputBytes(bytes.length)
  const files: Record<string, Uint8Array> = Object.create(null)
  if (bytes.length >= 8 && [102, 105, 103, 45, 107, 105, 119, 105].every((v, i) => bytes[i] === v)) {
    files['canvas.fig'] = bytes
    return files
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const bound = (at: number, length: number, end = bytes.length) => {
    if (at < 0 || length < 0 || at + length > end) fail('数据截断或范围无效')
  }
  const u16 = (at: number) => { bound(at, 2); return view.getUint16(at, true) }
  const u32 = (at: number) => { bound(at, 4); return view.getUint32(at, true) }
  // EOCD search is bounded by the ZIP32 comment-length field, not an unbounded scan.
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65535); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) {
      eocd = at
      break
    }
  }
  if (eocd < 0) fail('缺少 ZIP32 目录尾记录')
  const count = u16(eocd + 10), centralSize = u32(eocd + 12), central = u32(eocd + 16)
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count) fail('不支持多磁盘 ZIP')
  if (count === 0xffff || centralSize === 0xffffffff || central === 0xffffffff) fail('不支持 ZIP64')
  if (count > ENTRY_LIMIT) fail('文件数量超过 2048')
  if (central + centralSize !== eocd) fail('中央目录范围不一致')
  bound(central, centralSize, eocd)
  const extra = (at: number, length: number) => {
    const end = at + length
    bound(at, length)
    while (at < end) {
      bound(at, 4, end)
      const id = u16(at), size = u16(at + 2)
      at += 4
      bound(at, size, end)
      if (id === 1) fail('不支持 ZIP64 扩展')
      at += size
    }
  }
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const explicit = new Set<string>(), directories = new Set<string>(), regular = new Set<string>()
  const entries: Entry[] = []
  let at = central, declaredTotal = 0, nameBytes = 0
  for (let index = 0; index < count; index++) {
    bound(at, 46, eocd)
    if (u32(at) !== 0x02014b50) fail('中央目录签名无效')
    const flags = u16(at + 8), method = u16(at + 10)
    const crc = u32(at + 16), compressed = u32(at + 20), expanded = u32(at + 24)
    const nameLength = u16(at + 28), extraLength = u16(at + 30), commentLength = u16(at + 32)
    const local = u32(at + 42), attributes = u32(at + 38), kind = (attributes >>> 16) & 0xf000
    if (u16(at + 6) > 20 || u16(at + 34)) fail('不支持 ZIP 版本或磁盘')
    if (compressed === 0xffffffff || expanded === 0xffffffff || local === 0xffffffff) fail('不支持 ZIP64')
    if (method !== 0 && method !== 8) fail('不支持压缩方法')
    // Only the descriptor/UTF-8 bits and DEFLATE compression-level hints are supported.
    if (flags & ~(0x0808 | (method === 8 ? 6 : 0))) fail('不支持加密或 ZIP 标志')
    bound(at + 46, nameLength + extraLength + commentLength, eocd)
    // Bound path bookkeeping too: ancestor collision checks retain prefix strings.
    nameBytes += nameLength
    if (nameLength > 4096 || nameBytes > 1024 * 1024) fail('路径长度预算超限')
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength)
    let name = ''
    try { name = decoder.decode(rawName) } catch { fail('文件名不是有效 UTF-8') }
    if (!name || /[\\:\x00]/.test(name) || name.startsWith('/')) fail('不安全的路径')
    const directory = name.endsWith('/'), key = directory ? name.slice(0, -1) : name
    const parts = key.split('/')
    if (parts.length > 64) fail('路径层级超过 64')
    if (parts.some(part => !part || part === '.' || part === '..')) fail('不安全的路径段')
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) fail('不支持符号链接或特殊文件')
    if ((kind === 0x4000 || (attributes & 16)) && !directory) fail('目录属性与路径不符')
    if (kind === 0x8000 && directory) fail('文件属性与路径不符')
    if (explicit.has(key) || (directory ? regular.has(key) : directories.has(key))) fail('重复路径或文件目录冲突')
    explicit.add(key)
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('/')
      if (regular.has(ancestor)) fail('文件不能作为父目录')
      directories.add(ancestor)
    }
    if (directory) directories.add(key)
    else regular.add(key)
    if (directory && expanded !== 0) fail('目录包含文件内容')
    if (method === 0 && compressed !== expanded) fail('存储条目长度不一致')
    if (expanded > SMALL_ENTRY && expanded > compressed * RATIO_LIMIT) fail('展开比例超过 200')
    declaredTotal += expanded
    if (declaredTotal > EXPANDED_LIMIT) fail('展开超过 64 MiB')
    extra(at + 46 + nameLength, extraLength)
    entries.push({ name, rawName, directory, flags, method, crc, compressed, expanded, local, start: 0 })
    at += 46 + nameLength + extraLength + commentLength
  }
  if (at !== eocd) fail('中央目录条目数或长度不符')
  // Exact local-record coverage prevents aliasing, overlap, hidden records and truncation.
  entries.sort((a, b) => a.local - b.local)
  let end = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], local = entry.local, next = entries[i + 1]?.local ?? central
    if (local !== end) fail('本地记录存在空隙或重叠')
    bound(local, 30, next)
    if (u32(local) !== 0x04034b50 || u16(local + 4) > 20 || u16(local + 6) !== entry.flags || u16(local + 8) !== entry.method)
      fail('本地记录与中央目录不符')
    const nameLength = u16(local + 26), extraLength = u16(local + 28)
    bound(local + 30, nameLength + extraLength, next)
    if (nameLength !== entry.rawName.length || entry.rawName.some((v, n) => bytes[local + 30 + n] !== v)) fail('本地文件名不符')
    extra(local + 30 + nameLength, extraLength)
    entry.start = local + 30 + nameLength + extraLength
    bound(entry.start, entry.compressed, next)
    const payloadEnd = entry.start + entry.compressed
    const values = [entry.crc, entry.compressed, entry.expanded]
    for (let n = 0; n < values.length; n++) {
      const value = u32(local + 14 + n * 4)
      if (entry.flags & 8 ? value !== 0 && value !== values[n] : value !== values[n]) fail('本地 CRC 或长度不符')
    }
    end = payloadEnd
    if (entry.flags & 8) {
      // Match against the next record boundary, disambiguating CRC == signature.
      const signed = next - payloadEnd === 16
      if (!signed && next - payloadEnd !== 12) fail('数据描述符长度无效')
      bound(payloadEnd, signed ? 16 : 12, next)
      if (signed && u32(payloadEnd) !== 0x08074b50) fail('数据描述符签名无效')
      const descriptor = payloadEnd + (signed ? 4 : 0)
      for (let n = 0; n < values.length; n++) if (u32(descriptor + n * 4) !== values[n]) fail('数据描述符 CRC 或长度不符')
      end = next
    }
    if (end !== next) fail('压缩条目边界不一致')
  }
  if (end !== central) fail('本地记录与中央目录边界不符')
  let total = 0
  for (const entry of entries) {
    const retain = !entry.directory && (entry.name === 'canvas.fig' || entry.name.startsWith('images/'))
    const chunks: Uint8Array[] = []
    let size = 0, crc = 0xffffffff
    const consume = (chunk: Uint8Array) => {
      size += chunk.length
      total += chunk.length
      if (size > entry.expanded || total > EXPANDED_LIMIT) fail('实际展开长度超限')
      if (size > SMALL_ENTRY && size > entry.compressed * RATIO_LIMIT) fail('实际展开比例超过 200')
      crc = crcUpdate(crc, chunk)
      if (retain) chunks.push(chunk.slice())
    }
    const data = bytes.subarray(entry.start, entry.start + entry.compressed)
    if (entry.method === 0) consume(data)
    else inflateFigDeflate(data, entry.expanded, consume)
    if (size !== entry.expanded || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) fail('实际长度或 CRC 校验失败')
    if (retain) {
      const content = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.length }
      files[entry.name] = content
    }
  }
  if (!files['canvas.fig']) fail('缺少 canvas.fig')
  return files
}
