import { crc32, deflateSync } from 'node:zlib'
import { expect, test } from 'vitest'
import { transcode_export_png } from './generated/design-kernel/design_kernel'

function chunk(tag: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(tag), data])
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body) >>> 0, 8 + data.length)
  return out
}

function rgbaPng(width: number, height: number, pixels: Buffer) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function be16(bytes: Uint8Array, at: number) {
  return (bytes[at] << 8) | bytes[at + 1]
}
function be32(bytes: Uint8Array, at: number) {
  return (be16(bytes, at) * 65536) + be16(bytes, at + 2)
}

function tiffValue(bytes: Uint8Array, kind: number, count: number, raw: Uint8Array) {
  const unit = kind === 3 ? 2 : kind === 4 ? 4 : kind === 5 ? 8 : kind === 7 ? 1 : 0
  const length = unit * count
  if (length <= 4) return raw.subarray(0, length)
  const offset = be32(raw, 0)
  return bytes.subarray(offset, offset + length)
}

test('the WASM export entry writes a real TIFF and a real HEIC', () => {
  const width = 120
  const height = 90
  const pixels = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = index % 251
    pixels[index * 4 + 1] = Math.floor(index / 3) % 251
    pixels[index * 4 + 2] = Math.floor(index / 7) % 251
    pixels[index * 4 + 3] = index % 11 === 0 ? 0 : 200
  }
  const png = rgbaPng(width, height, pixels)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect(() => transcode_export_png(png, 'eps', 1)).toThrow(/Unsupported export encoder/)
  const heic = transcode_export_png(png, 'heic', 1)
  expect(Buffer.from(heic.subarray(4, 12)).toString('ascii')).toBe('ftypheic')
  expect(heic[0]).not.toBe(0x89)
  expect(Buffer.from(heic).includes(Buffer.from('hvcC'))).toBe(true)
  expect(Buffer.from(heic).includes(Buffer.from('auxl'))).toBe(true)
  expect(Buffer.from(heic).includes(Buffer.from('ftypheic'))).toBe(true)
  const tiff = transcode_export_png(png, 'tiff', 1)
  expect([...tiff.subarray(0, 4)]).toEqual([0x4d, 0x4d, 0x00, 0x2a])
  expect(tiff[0]).not.toBe(0x89)
  const ifd = be32(tiff, 4)
  const count = be16(tiff, ifd)
  const tags = new Map<number, { kind: number; count: number; raw: Uint8Array }>()
  for (let index = 0; index < count; index++) {
    const at = ifd + 2 + index * 12
    tags.set(be16(tiff, at), { kind: be16(tiff, at + 2), count: be32(tiff, at + 4), raw: tiff.subarray(at + 8, at + 12) })
  }
  const value = (tag: number) => {
    const entry = tags.get(tag)
    expect(entry).toBeDefined()
    return tiffValue(tiff, entry!.kind, entry!.count, entry!.raw)
  }
  expect(be32(value(256), 0)).toBe(width)
  expect(be32(value(257), 0)).toBe(height)
  expect(be16(value(259), 0)).toBe(1)
  expect(be16(value(262), 0)).toBe(2)
  expect(be16(value(277), 0)).toBe(4)
  expect(be16(value(338), 0)).toBe(2)
  expect([...value(34675).subarray(16, 20)].map(byte => String.fromCharCode(byte)).join('')).toBe('RGB ')
  expect([...value(34675).subarray(36, 40)].map(byte => String.fromCharCode(byte)).join('')).toBe('acsp')
  const strip = be32(value(273), 0)
  expect(Buffer.from(tiff.subarray(strip, strip + pixels.length))).toEqual(pixels)
})
