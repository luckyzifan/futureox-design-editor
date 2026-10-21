import { expect, test } from 'vitest'
import { decodeFig } from './import-fig'
function raw(parts: number[][]) {
  const out = new Uint8Array(12 + parts.reduce((n, part) => n + 4 + part.length, 0))
  out.set(new TextEncoder().encode('fig-kiwi'))
  const view = new DataView(out.buffer)
  view.setUint32(8, 106, true)
  let at = 12
  for (const part of parts) { view.setUint32(at, part.length, true); out.set(part, at + 4); at += 4 + part.length }
  return out
}
test('raw FIG rejects extra segments before attempting decompression', () => {
  expect(() => decodeFig(raw([[255], [255], [255]]))).toThrow('尾随数据')
})
test('raw FIG rejects incomplete second segment before attempting decompression', () => {
  const bytes = raw([[255], [255]])
  expect(() => decodeFig(bytes.subarray(0, bytes.length - 1))).toThrow('分段长度无效')
})
test('raw FIG rejects empty segment', () => {
  expect(() => decodeFig(raw([[], [255]]))).toThrow('分段长度无效')
})

// Exercise the actual decoder, not merely structural preflight. No generated JS.
import { deflateSync } from 'fflate'
import { encodeBinarySchema, parseSchema } from 'kiwi-schema'
const schema = () => Array.from(deflateSync(encodeBinarySchema(parseSchema('message Message {}'))))
const zstdMessage = (declared = 1) => [0x28, 0xb5, 0x2f, 0xfd, 0x20, declared, 9, 0, 0, 0]
test('raw FIG uses interpreted schema and one bounded Zstd frame', () => {
  expect(decodeFig(raw([schema(), zstdMessage()])).data).toEqual({})
})
test('Zstd actual length must equal declared content length', () => {
  expect(() => decodeFig(raw([schema(), zstdMessage(2)]))).toThrow('内容长度不符')
})
test('raw FIG rejects trailing bytes inside deflated schema segment', () => {
  expect(() => decodeFig(raw([[...schema(), 0], zstdMessage()]))).toThrow('压缩边界')
})


test('raw FIG applies actual 200:1 ratio limit to each DEFLATE segment', () => {
  expect(() => decodeFig(raw([schema(), Array.from(deflateSync(new Uint8Array(10000)))]))).toThrow('展开比例超过 200')
})
test('raw FIG rejects excessive declared Zstd ratio before decompression', () => {
  const rle = [0x28, 0xb5, 0x2f, 0xfd, 0x60, 1, 15, 11, 128, 0, 0]
  expect(() => decodeFig(raw([schema(), rle]))).toThrow('声明展开比例超过 200')
})
