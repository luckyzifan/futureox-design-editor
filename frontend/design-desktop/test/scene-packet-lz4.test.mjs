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
