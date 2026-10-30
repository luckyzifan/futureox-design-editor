import { expect, test } from 'vitest'
import { preflightFigZstd } from './import-fig-zstd'
const frame = (...rest: number[]) => Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, ...rest)
const raw = frame(0x20, 3, 25, 0, 0, 1, 2, 3)
test('ordinary bounded single frame passes structural preflight', () => {
  expect(preflightFigZstd(raw, 1024)).toBe(3)
  expect(preflightFigZstd(frame(0, 0, 1, 0, 0), 1024)).toBeUndefined()
})
test.each([
  frame(0x24, 0, 1, 0, 0), // checksum unsupported
  frame(0x28, 0, 1, 0, 0), // reserved bit
  frame(0x30, 0, 1, 0, 0), // unused bit
  frame(0x21, 1, 0, 1, 0, 0), // external dictionary
  frame(0, 255, 1, 0, 0), // huge window, rejected before allocating it
  frame(0xe0, 255, 255, 255, 255, 255, 255, 255, 255, 1, 0, 0),
  frame(0x20, 0, 7, 0, 0), // reserved block
  frame(0x20, 1, 17, 0, 0, 0, 0), // block exceeds window
  raw.subarray(0, raw.length - 1),
  new Uint8Array([...raw, ...raw]),
  new Uint8Array([...raw, 0]),
  Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 0, 0, 0, 0),
])('rejects unsupported or malformed structure without a decoder allocation', bytes => {
  expect(() => preflightFigZstd(bytes, 1024)).toThrow()
})
test('all truncated frame prefixes reject', () => {
  for (let i = 0; i < raw.length; i++) expect(() => preflightFigZstd(raw.subarray(0, i), 1024)).toThrow()
})
test('RLE block has one payload byte, while decoded length remains bounded', () => {
  expect(preflightFigZstd(frame(0x20, 3, 27, 0, 0, 7), 1024)).toBe(3)
})
