import { expect, test } from 'vitest'
import { presentationQuality } from './presentation-quality'
import type { CompositeItem } from './tile-compositor'
const tile: CompositeItem = { active: true, layer: 1, gutter: 0,
  tile: { serial: 1, key: 'native', x: 0, y: 0, width: 200, height: 200, zoom: 64, bytes: new Uint8Array() } }

test('native density alone does not certify the fractional pan sampling phase', () => {
  const quality = presentationQuality([tile], { x: .25, y: 0, zoom: 32 }, 100, 100, 2)
  expect(quality.coverage).toBe(1)
  expect(quality.sharpCoverage).toBe(1)
  expect(quality.nativePhaseCoverage).toBe(0)
})
test('phase-aligned native camera tiles restore one-to-one device sampling', () => {
  expect(presentationQuality([{ ...tile, tile: { ...tile.tile, phaseX: .5 } }],
    { x: .25, y: 0, zoom: 32 }, 100, 100, 2).nativePhaseCoverage).toBe(1)
})
test('supersampled residents remain density-sharp without claiming one-to-one native phase', () => {
  const high = { ...tile, tile: { ...tile.tile, width: 400, height: 400, zoom: 128 } }
  const quality = presentationQuality([high], { x: 0, y: 0, zoom: 32 }, 100, 100, 2)
  expect(quality.sharpCoverage).toBe(1)
  expect(quality.nativePhaseCoverage).toBe(0)
})
