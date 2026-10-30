import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { tileWorldRect } from './ProgressiveSurface'

test('low-zoom dirty pixels in a resident gutter require eviction even outside its inner ownership box', async () => {
  const { initializeKernelModule } = await import('./module')
  await initializeKernelModule(new Uint8Array(await readFile(new URL('../../public/kernel/design_kernel_bg.wasm', import.meta.url))))
  const { VectorEngine } = await import('../generated/design-kernel/design_kernel')
  const engine = new VectorEngine()
  try {
    const shape = { id: 'a', kind: 'rectangle', width: 1, height: 4,
      transform: [1, 0, 0, 1, 2051, 0], fills: [{ kind: 'solid', color: '#ff0000' }] }
    engine.load_document(JSON.stringify({ schemaVersion: 5, id: 'gutter', name: 'gutter',
      pages: [{ id: 'p', name: 'p', children: ['a'], background: '#ffffff' }], nodes: { a: shape } }))
    const options = JSON.stringify({ pageId: 'p', width: 514, height: 1,
      view: { x: 0, y: 0, zoom: .25 }, rasterProfile: 'analytic', transparent: false, grid: false })
    const before = engine.render_rgba(options)
    const damage = JSON.parse(engine.apply_document_patch_with_damage(JSON.stringify({
      nodes: { a: { ...shape, transform: [1, 0, 0, 1, 2053, 0] } }, fields: {},
    })))
    const after = engine.render_rgba(options)
    // Global device pixel 512 is the right-hand gutter of world tile zero.
    expect([...before.slice(512 * 4, 513 * 4)]).toEqual([255, 191, 191, 255])
    expect([...after.slice(512 * 4, 513 * 4)]).toEqual([255, 255, 255, 255])
    expect(damage.full).toBe(false)
    const tile = { key: '0.25:0:0:0:0', x: -1, y: -1, width: 514, height: 514, zoom: .25 }
    const bounds = tileWorldRect(tile)
    expect((tile.x + tile.width - 1) / tile.zoom).toBeLessThanOrEqual(damage.bounds[0])
    expect(bounds.x + bounds.width).toBeGreaterThan(damage.bounds[0])
    expect(bounds.x).toBeLessThan(damage.bounds[0] + damage.bounds[2])
    expect(bounds.y + bounds.height).toBeGreaterThan(damage.bounds[1])
    expect(bounds.y).toBeLessThan(damage.bounds[1] + damage.bounds[3])
  } finally { engine.free() }
})
