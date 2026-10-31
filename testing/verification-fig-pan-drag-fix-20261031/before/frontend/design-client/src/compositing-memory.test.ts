import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank } from './model'

test('real WASM accounts for the root framebuffer and resets per-frame memory statistics', () => {
  const engine = new VectorEngine()
  try {
    const doc = blank('Memory accounting')
    engine.load_document(JSON.stringify(doc))
    for (const [width, height] of [
      [3, 2],
      [1, 1],
      [3, 2],
    ]) {
      const bytes = engine.render_rgba(
        JSON.stringify({
          pageId: doc.pages[0].id,
          width,
          height,
          view: { x: 0, y: 0, zoom: 1 },
          transparent: true,
          rasterProfile: 'analytic',
        }),
      )
      expect([...bytes]).toEqual(Array(width * height * 4).fill(0))
      const stats = JSON.parse(engine.stats())
      expect(stats.allocatedLayerPixels).toBe(width * height)
      expect(stats.peakLayerPixels).toBe(width * height)
      expect(stats.peakCompositingBytes).toBe(width * height * 16)
    }
  } finally {
    engine.free()
  }
})
