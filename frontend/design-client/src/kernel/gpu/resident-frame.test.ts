import { expect, test } from 'vitest'
import { residentFrameMessage } from './resident-frame'
import type { ResidentFrame } from './resident-presenter'
test('camera messages cannot carry document trees, pixels, or raster diagnostics', () => {
  const tile = {
    key: 'tile',
    serial: 1,
    gpuTile: 42,
    x: 0,
    y: 0,
    width: 514,
    height: 514,
    zoom: 2,
    document: { nodes: { large: { image: 'private-document-image'.repeat(50000) } } },
    bytes: new Uint8Array(514 * 514 * 4),
    passTimings: [{ ms: 123 }],
  }
  const frame = {
    presentationId: 'scope:12',
    view: { x: 10, y: 20, zoom: 1 },
    width: 800,
    height: 600,
    dpr: 2,
    items: [{ tile, active: true, layer: 1, clip: { left: 0, top: 0, width: 800, height: 600 } }],
  } as ResidentFrame
  const wire = residentFrameMessage(frame),
    encoded = JSON.stringify(wire)
  expect(encoded.length).toBeLessThan(512)
  expect(wire.items[0].tile).not.toHaveProperty('document')
  expect(wire.items[0].tile).not.toHaveProperty('bytes')
  expect(wire.items[0].tile).not.toHaveProperty('passTimings')
  expect(wire.items[0].tile.gpuTile).toBe(42)
  expect(wire.presentationId).toBe('scope:12')
  expect(wire.items[0].clip).toEqual(frame.items[0].clip)
})
