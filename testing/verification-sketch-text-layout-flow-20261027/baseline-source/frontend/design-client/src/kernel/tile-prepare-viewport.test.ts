import { expect, test } from 'vitest'
import { tilePrepareViewport, tileBatchPrepareViewport } from './tile-prepare-viewport'
import type { RasterTile } from './tile-cache'
test('bounded chunks keep the whole plan guard with the exact camera phase', () => {
  const tiles = [0, 512, 1024].map(x => ({ key: String(x), x, y: -1, width: 514, height: 514, zoom: 2 }) as RasterTile)
  const view = { x: -3.25, y: 5.75 }, guard = tilePrepareViewport(tiles, view)!
  expect(guard).toEqual({ x: -4, y: 4, w: 1538, h: 514 })
  for (const tile of tiles) expect(tilePrepareViewport([tile], view, guard)).toBe(guard)
  expect(() => tilePrepareViewport(tiles, view, tilePrepareViewport([tiles[0]], view))).toThrow('cover every')
  expect(() => tilePrepareViewport(tiles, view, { ...guard, w: Infinity })).toThrow()
})

test('visible preparation excludes idle rim, while every dispatched crop remains covered', () => {
  const tile = (x: number, prefetch = false) => ({ key: String(x), x, y: 0, width: 514, height: 514, zoom: 2, prefetch }) as RasterTile
  const visible = [tile(0), tile(512)], rim = [tile(-1024, true), tile(1536, true)]
  const view = { x: .25, y: -.25 }
  const first = tileBatchPrepareViewport(visible, rim, [visible[0]], view)!
  expect(first).toEqual({ x: 0, y: -1, w: 1026, h: 514 })
  const later = tileBatchPrepareViewport(visible, rim, [rim[0]], view)!
  expect(later).toEqual({ x: -1024, y: -1, w: 3074, h: 514 })
  for (const batch of [[visible[0]], [rim[0]], [visible[1], rim[1]]]) {
    const guard = tileBatchPrepareViewport(visible, rim, batch, view)!
    expect(tilePrepareViewport(batch, view, guard)).toBe(guard)
  }
})
