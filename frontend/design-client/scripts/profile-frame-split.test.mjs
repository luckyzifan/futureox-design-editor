import assert from 'node:assert/strict'
import test from 'node:test'
import { decodePacketResources, measurePointer, metadataSlice, pointerFrame } from './profile-frame-split.mjs'
import { decodeFrameValue } from '../src/kernel/gpu/frame-wire.ts'

test('pointer harness calls the production camera and keeps the zoom anchor', () => {
  const frame = pointerFrame()
  assert.ok(Math.hypot(frame.stayed.x - frame.world.x, frame.stayed.y - frame.world.y) < 1e-9)
  assert.notEqual(frame.panned.x, 12.25)
  assert.equal(frame.panned.zoom, 1.25)
  assert.notEqual(frame.pinched.zoom, 1.25)
  assert.equal(frame.projected.x, 480)
  assert.equal(frame.projected.y, 320)
  const measured = measurePointer(5, 1)
  assert.equal(measured.layer, 'typescript')
  assert.ok(measured.timings.p50Ms >= 0 && Number.isFinite(measured.timings.p50Ms))
  assert.ok(measured.anchorError < 1e-9)
  assert.ok(measured.zoomChanged)
})

test('metadata slice follows the production FGSC header into decodeFrameValue', () => {
  assert.throws(() => metadataSlice(new Uint8Array(8)), /truncated|FGSC/)
  const metadata = new Uint8Array(9)
  metadata[0] = 4
  new DataView(metadata.buffer).setFloat64(1, 1.5, true)
  const packet = new Uint8Array(36)
  const header = new DataView(packet.buffer)
  header.setUint32(0, 0x43534746, true)
  header.setUint32(4, 1, true)
  header.setUint32(8, metadata.length, true)
  packet.set(metadata, 24)
  const parts = metadataSlice(packet)
  assert.equal(parts.metadataBytes, 9)
  assert.equal(parts.geometry.byteLength, 0)
  assert.equal(decodeFrameValue(parts.metadata), 1.5)
  assert.equal(decodePacketResources(packet).length, 0)
})
