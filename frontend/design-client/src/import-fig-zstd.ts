/** Preflight the supported single-frame Zstd subset before fzstd allocates a window.
 * fzstd accepts concatenated/skippable frames and does not verify checksums, so
 * neither feature is admitted here. This scans structure, not compressed data.
 */
export function preflightFigZstd(bytes: Uint8Array, limit: number): number | undefined {
  const fail = (why: string): never => { throw new Error(`FIG Zstd ${why}`) }
  let at = 0
  const take = (length: number) => {
    if (at + length > bytes.length) fail('帧不完整')
    const start = at; at += length; return start
  }
  take(5)
  if (bytes[0] !== 0x28 || bytes[1] !== 0xb5 || bytes[2] !== 0x2f || bytes[3] !== 0xfd)
    fail('只支持单个普通帧')
  const flags = bytes[4]
  if (flags & 0x18) fail('保留位无效')
  if (flags & 4) fail('暂不支持内容校验和')
  const single = !!(flags & 32), sizeFlag = flags >>> 6
  let window = 0
  if (!single) {
    const descriptor = bytes[take(1)], base = 2 ** (10 + (descriptor >>> 3))
    window = base + (base / 8) * (descriptor & 7)
    if (window > limit) fail('历史窗口超限')
  }
  const dictionaryLength = [0, 1, 2, 4][flags & 3]
  const dictionaryAt = take(dictionaryLength)
  for (let i = 0; i < dictionaryLength; i++) if (bytes[dictionaryAt + i]) fail('不支持外部字典')
  const sizeLength = sizeFlag ? [0, 2, 4, 8][sizeFlag] : single ? 1 : 0
  const sizeAt = take(sizeLength)
  let size = 0n
  for (let i = 0; i < sizeLength; i++) size |= BigInt(bytes[sizeAt + i]) << BigInt(i * 8)
  if (sizeLength === 2) size += 256n
  if (size > BigInt(limit)) fail('内容长度超限')
  const declared = sizeLength ? Number(size) : undefined
  if (single) window = declared!
  let last = false
  while (!last) {
    const blockAt = take(3)
    const header = bytes[blockAt] | (bytes[blockAt + 1] << 8) | (bytes[blockAt + 2] << 16)
    last = !!(header & 1)
    const type = (header >>> 1) & 3, length = header >>> 3
    if (type === 3) fail('保留块类型无效')
    if (length > Math.min(window, 128 * 1024)) fail('块长度超过窗口')
    take(type === 1 ? 1 : length)
  }
  if (at !== bytes.length) fail('不支持拼接帧、跳过帧或尾随数据')
  return declared
}
