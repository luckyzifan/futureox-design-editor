import { describe, expect, it } from 'vitest'
import { deflateSync, strToU8 } from 'fflate'
import { figArchive, inflateFigDeflate } from './import-fig-archive'

// Source-only regression cases. Running this suite requires the separate CPU gate.
const text = (s: string) => strToU8(s)
const canvas = text('fig-kiwi fixture')
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return result
}
function put16(bytes: Uint8Array, at: number, value: number) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(at, value, true) }
function put32(bytes: Uint8Array, at: number, value: number) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value, true) }
interface Input { name: string; data?: Uint8Array; method?: number; descriptor?: 'signed' | 'unsigned'; flags?: number; compressed?: Uint8Array; extra?: Uint8Array }
function archive(inputs: Input[] = [{ name: 'canvas.fig', data: canvas }]) {
  const locals: Uint8Array[] = [], centrals: Uint8Array[] = []
  const offsets: number[] = [], centralOffsets: number[] = []
  let localAt = 0, centralAt = 0
  for (const input of inputs) {
    const name = text(input.name), data = input.data ?? new Uint8Array(), method = input.method ?? 0
    const compressed = input.compressed ?? (method === 8 ? deflateSync(data) : data)
    const extra = input.extra ?? new Uint8Array(), crc = crc32(data)
    const flags = (input.flags ?? 0x800) | (input.descriptor ? 8 : 0)
    const local = new Uint8Array(30 + name.length + extra.length)
    put32(local, 0, 0x04034b50); put16(local, 4, 20); put16(local, 6, flags); put16(local, 8, method)
    if (!input.descriptor) { put32(local, 14, crc); put32(local, 18, compressed.length); put32(local, 22, data.length) }
    put16(local, 26, name.length); put16(local, 28, extra.length); local.set(name, 30); local.set(extra, 30 + name.length)
    const descriptor = new Uint8Array(input.descriptor ? input.descriptor === 'signed' ? 16 : 12 : 0)
    if (input.descriptor) {
      const start = input.descriptor === 'signed' ? 4 : 0
      if (start) put32(descriptor, 0, 0x08074b50)
      put32(descriptor, start, crc); put32(descriptor, start + 4, compressed.length); put32(descriptor, start + 8, data.length)
    }
    const central = new Uint8Array(46 + name.length + extra.length)
    put32(central, 0, 0x02014b50); put16(central, 4, 20); put16(central, 6, 20)
    put16(central, 8, flags); put16(central, 10, method); put32(central, 16, crc)
    put32(central, 20, compressed.length); put32(central, 24, data.length)
    put16(central, 28, name.length); put16(central, 30, extra.length); put32(central, 42, localAt)
    if (input.name.endsWith('/')) put32(central, 38, 16)
    central.set(name, 46); central.set(extra, 46 + name.length)
    offsets.push(localAt); centralOffsets.push(centralAt)
    locals.push(local, compressed, descriptor); centrals.push(central)
    localAt += local.length + compressed.length + descriptor.length; centralAt += central.length
  }
  const eocd = new Uint8Array(22)
  put32(eocd, 0, 0x06054b50); put16(eocd, 8, inputs.length); put16(eocd, 10, inputs.length)
  put32(eocd, 12, centralAt); put32(eocd, 16, localAt)
  return { bytes: concat(...locals, ...centrals, eocd), locals: offsets, centrals: centralOffsets.map(at => at + localAt), central: localAt, eocd: localAt + centralAt }
}
const base: Input = { name: 'canvas.fig', data: canvas }

describe('FIG ZIP32 admission', () => {
  it('passes raw fig-kiwi through without copying', () => expect(figArchive(canvas)['canvas.fig']).toBe(canvas))
  it.each(['signed', 'unsigned'] as const)('accepts %s bit-3 descriptors, UTF-8, and an explicit images directory', descriptor => {
    const a = archive([base, { name: 'images/' }, { name: 'images/图像.png', data: text('image pixels'), method: 8, descriptor }])
    expect(figArchive(a.bytes)).toEqual({ 'canvas.fig': canvas, 'images/图像.png': text('image pixels') })
  })
  it('accepts stored descriptors and small highly compressible entries', () => {
    const a = archive([{ ...base, descriptor: 'unsigned' }, { name: 'metadata', data: new Uint8Array(4096), method: 8 }])
    expect(figArchive(a.bytes)['canvas.fig']).toEqual(canvas)
  })
  it('validates ignored metadata CRC', () => {
    const a = archive([base, { name: 'metadata', data: text('ignored') }])
    a.bytes[a.locals[1] + 30 + 'metadata'.length] ^= 1
    expect(() => figArchive(a.bytes)).toThrow(/CRC/)
  })
  it('validates ignored metadata actual expanded length', () => {
    const a = archive([base, { name: 'metadata', data: text('ignored'), method: 8 }])
    put32(a.bytes, a.locals[1] + 22, 1); put32(a.bytes, a.centrals[1] + 24, 1)
    expect(() => figArchive(a.bytes)).toThrow(/长度/)
  })
  it.each([6, 8, 14, 18, 22, 30])('rejects a local/central mismatch at local field %i', offset => {
    const a = archive(); a.bytes[offset] ^= 1
    expect(() => figArchive(a.bytes)).toThrow()
  })
  it.each(['signed', 'unsigned'] as const)('rejects mismatched %s descriptor', descriptor => {
    const a = archive([{ ...base, method: 8, descriptor }]); a.bytes[a.central - 1] ^= 1
    expect(() => figArchive(a.bytes)).toThrow(/描述符/)
  })
  it.each(['/root', 'a\\b', 'C:drive', 'nul\0x', 'a//b', '.', '..', 'a/../b', './a'])('rejects unsafe path %j', name => {
    expect(() => figArchive(archive([base, { name }]).bytes)).toThrow(/路径/)
  })
  it.each([
    ['canvas.fig', 'canvas.fig'], ['images', 'images/x'], ['images/x', 'images'],
    ['images/', 'images'], ['images', 'images/'], ['images/', 'images/'],
  ])('rejects duplicate or file-directory collision %s and %s', (a, b) => {
    expect(() => figArchive(archive([{ name: a }, { name: b }]).bytes)).toThrow()
  })
  it('accepts an explicit directory after its implicit ancestor was seen', () => {
    expect(figArchive(archive([base, { name: 'images/x' }, { name: 'images/' }]).bytes)['images/x']).toEqual(new Uint8Array())
  })
  it('rejects symlinks', () => {
    const a = archive(); put32(a.bytes, a.centrals[0] + 38, 0xa1ff0000)
    expect(() => figArchive(a.bytes)).toThrow(/符号链接/)
  })
  it.each([1, 64, 8192])('rejects encryption/unsupported flag %i', flags => {
    expect(() => figArchive(archive([{ ...base, flags }]).bytes)).toThrow(/标志/)
  })
  it('rejects unsupported compression methods', () => expect(() => figArchive(archive([{ ...base, method: 99 }]).bytes)).toThrow(/压缩方法/))
  it('rejects ZIP64 extra fields', () => expect(() => figArchive(archive([{ ...base, extra: new Uint8Array([1, 0, 0, 0]) }]).bytes)).toThrow(/ZIP64/))
  it.each([20, 24, 42])('rejects ZIP64 central sentinel %i', offset => {
    const a = archive(); put32(a.bytes, a.centrals[0] + offset, 0xffffffff)
    expect(() => figArchive(a.bytes)).toThrow(/ZIP64/)
  })
  it('rejects overlap', () => {
    const a = archive([base, { name: 'images/a' }]); put32(a.bytes, a.centrals[1] + 42, 0)
    expect(() => figArchive(a.bytes)).toThrow()
  })
  it('rejects a truncated archive and trailing garbage', () => {
    const a = archive().bytes
    expect(() => figArchive(a.subarray(0, a.length - 1))).toThrow()
    expect(() => figArchive(concat(a, new Uint8Array([0])))).toThrow()
  })
  it('rejects single-disk and central count/size inconsistencies', () => {
    for (const offset of [4, 8, 12, 16]) {
      const a = archive(); a.bytes[a.eocd + offset] ^= 1
      expect(() => figArchive(a.bytes)).toThrow()
    }
  })
  it('rejects more than 2048 entries', () => {
    const a = archive(); put16(a.bytes, a.eocd + 8, 2049); put16(a.bytes, a.eocd + 10, 2049)
    expect(() => figArchive(a.bytes)).toThrow(/2048/)
  })
  it('applies the 1 GiB encoded input cap before accessing archive bytes', () => {
    const bytes = { length: 1024 ** 3 + 1 } as Uint8Array
    expect(() => figArchive(bytes)).toThrow(/1 GiB/)
  })
  it('rejects declared total expansion above 64 MiB before decoding', () => {
    const a = archive([base, { name: 'metadata', method: 8, data: text('ignored') }])
    // Keep each declaration within its ratio while avoiding allocating the expansion.
    put16(a.bytes, a.centrals[0] + 10, 8)
    for (const central of a.centrals) { put32(a.bytes, central + 20, 200000); put32(a.bytes, central + 24, 34 * 1024 * 1024) }
    expect(() => figArchive(a.bytes)).toThrow(/64 MiB/)
  })
  it('rejects expansion ratio above 200 outside the 4 KiB exception', () => {
    const a = archive([base, { name: 'metadata', method: 8, data: new Uint8Array(32768) }])
    expect(() => figArchive(a.bytes)).toThrow(/比例/)
  })
  it('rejects directory content and a missing canvas', () => {
    expect(() => figArchive(archive([{ name: 'images/', data: text('bad') }]).bytes)).toThrow()
    expect(() => figArchive(archive([{ name: 'metadata' }]).bytes)).toThrow(/canvas.fig/)
  })
})

describe('strict streaming FIG DEFLATE', () => {
  it('streams valid data, including empty output', () => {
    for (const data of [canvas, new Uint8Array()]) {
      const chunks: Uint8Array[] = []
      inflateFigDeflate(deflateSync(data), data.length, c => chunks.push(c))
      expect(concat(...chunks)).toEqual(data)
    }
  })
  it('rejects trailing compressed bytes even when CRC and expanded size would match', () => {
    const compressed = concat(deflateSync(canvas), new Uint8Array([0, 1]))
    expect(() => inflateFigDeflate(compressed, canvas.length, () => {})).toThrow(/边界/)
    expect(() => figArchive(archive([{ ...base, method: 8, compressed }]).bytes)).toThrow(/边界/)
  })
  const noise = (length: number) => {
    const data = new Uint8Array(length)
    let state = 0x6d2b79f5
    for (let i = 0; i < data.length; i++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5
      data[i] = state & 255
    }
    return data
  }
  const decode = (compressed: Uint8Array, expected: Uint8Array) => {
    const chunks: Uint8Array[] = []
    inflateFigDeflate(compressed, expected.length, chunk => chunks.push(chunk))
    expect(concat(...chunks)).toEqual(expected)
  }
  it.each([0, 6, 9] as const)('crosses input chunks with deterministic incompressible data at level %i', level => {
    const data = noise(8193), compressed = deflateSync(data, { level })
    expect(compressed.length).toBeGreaterThan(2 * 1024)
    decode(compressed, data)
    expect(() => inflateFigDeflate(concat(compressed, new Uint8Array([0])), data.length, () => {})).toThrow(/边界/)
    expect(() => inflateFigDeflate(compressed.subarray(0, compressed.length - 1), data.length, () => {})).toThrow()
  })
  it('exercises a verified dynamic-Huffman first block with a skewed deterministic alphabet', () => {
    const data = noise(16384)
    // Independent skewed draws retain entropy while making short dynamic codes useful.
    // The BTYPE assertion is intentional: compressor heuristics must not silently turn
    // this into another stored/fixed-block test. This source fixture is not yet run.
    for (let i = 0; i < data.length; i++) {
      const draw = data[i]
      data[i] = draw < 128 ? 65 : draw < 192 ? 66 : 67 + (draw & 31)
    }
    const compressed = deflateSync(data, { level: 6 })
    expect((compressed[0] >>> 1) & 3).toBe(2)
    expect(compressed.length).toBeGreaterThan(1024)
    decode(compressed, data)
    expect(() => inflateFigDeflate(concat(compressed, new Uint8Array([0])), data.length, () => {})).toThrow(/边界/)
    expect(() => inflateFigDeflate(compressed.subarray(0, compressed.length - 1), data.length, () => {})).toThrow()
  })
  it.each([1, 2, 3, 4])('accepts exact fixed-Huffman endpoints for %i empty blocks', blocks => {
    // Each empty fixed-Huffman block is 3 header bits plus the 7-bit EOB code.
    // Four fixtures exercise residual bit positions 2, 4, 6 and exact byte alignment.
    const compressed = new Uint8Array(Math.ceil(blocks * 10 / 8))
    for (let block = 0; block < blocks; block++) {
      const bit = block * 10, header = block === blocks - 1 ? 3 : 2
      compressed[bit >>> 3] |= header << (bit & 7)
      if ((bit & 7) > 5) compressed[(bit >>> 3) + 1] |= header >>> (8 - (bit & 7))
    }
    decode(compressed, new Uint8Array())
    expect(() => inflateFigDeflate(concat(compressed, new Uint8Array([0])), 0, () => {})).toThrow(/边界/)
  })
  it.each([1023, 1024, 1025, 2048])('handles a byte-aligned stored block ending at compressed byte %i', compressedLength => {
    // Explicit DEFLATE stored-block wire bytes avoid depending on compressor block choices.
    const data = noise(compressedLength - 5), compressed = new Uint8Array(compressedLength)
    compressed[0] = 1 // BFINAL=1, BTYPE=00, then padding to the byte boundary.
    put16(compressed, 1, data.length); put16(compressed, 3, data.length ^ 0xffff)
    compressed.set(data, 5)
    decode(compressed, data)
    // At 1024/2048 bytes, the trailing byte is presented in a separate push.
    expect(() => inflateFigDeflate(concat(compressed, new Uint8Array([0])), data.length, () => {})).toThrow(/边界/)
    expect(() => inflateFigDeflate(compressed.subarray(0, compressed.length - 1), data.length, () => {})).toThrow()
  })
  it('rejects truncation and sink budget overrun', () => {
    const compressed = deflateSync(canvas)
    expect(() => inflateFigDeflate(compressed.subarray(0, compressed.length - 1), canvas.length, () => {})).toThrow()
    expect(() => inflateFigDeflate(compressed, 1, () => {})).toThrow(/超限/)
  })
})
