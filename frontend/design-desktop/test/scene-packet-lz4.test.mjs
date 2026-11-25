import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inflateScenePacket } from '../../design-client/src/kernel/gpu/lz4-block.mjs'

const raw = readFileSync(new URL('../../design-client/src/kernel/gpu/testdata/pose-raw.bin', import.meta.url))
const compressed = readFileSync(new URL('../../design-client/src/kernel/gpu/testdata/pose-lz4.bin', import.meta.url))

test('FGSZ pose packets inflate to the original FGSC bytes', () => {
  const out = inflateScenePacket(new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength))
  assert.equal(Buffer.compare(Buffer.from(out.buffer, out.byteOffset, out.byteLength), raw), 0)
  assert.equal(out[0], 0x46)
  assert.equal(out[1], 0x47)
  assert.equal(out[2], 0x53)
  assert.equal(out[3], 0x43)
  const broken = Uint8Array.from(compressed)
  broken[Math.min(24, broken.length - 1)] ^= 0xff
  assert.throws(() => inflateScenePacket(broken), /GPU scene packet/)
  const plain = inflateScenePacket(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
  assert.equal(plain[0], 0x46)
})

test('FGSZ bulk copies preserve overlapping and independent matches at the decoder boundary', () => {
  const pattern = Array.from({ length: 32 }, (_, index) => index + 20)
  const block = [
    0x1f, 7, 1, 0, 13,
    0x2f, 10, 11, 2, 0, 12,
    0x2f, 12, 13, 2, 0, 13,
    0xff, 17, ...pattern, 32, 0, 13,
    0x50, 90, 91, 92, 93, 94,
  ]
  const expected = [
    ...Array(33).fill(7),
    ...Array.from({ length: 33 }, (_, index) => 10 + index % 2),
    ...Array.from({ length: 34 }, (_, index) => 12 + index % 2),
    ...pattern, ...pattern, 90, 91, 92, 93, 94,
  ]
  const header = Buffer.alloc(12)
  header.write('FGSZ')
  header.writeUInt32LE(1, 4)
  header.writeUInt32LE(expected.length, 8)
  const packet = Buffer.concat([header, Buffer.from(block)])
  assert.deepEqual(inflateScenePacket(packet), Uint8Array.from(expected))
  const badOffset = Buffer.from(packet)
  badOffset[14] = 2
  assert.throws(() => inflateScenePacket(badOffset), /Invalid GPU scene packet length/)
  const badMatch = Buffer.from(packet)
  badMatch[16] = 0xfe
  assert.throws(() => inflateScenePacket(badMatch), /Invalid GPU scene packet length/)
})
