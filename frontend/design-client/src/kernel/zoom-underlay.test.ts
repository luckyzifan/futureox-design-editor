import { expect, test } from 'vitest'
import { sharperCoverageFrame } from './coverage-stack'
import type { RasterTile } from './tile-cache'
import { retainedPreviewUnderlay, zoomInFocusAhead, zoomInFocusCore, zoomInFocusTile, zoomInPartialTiles, zoomUnderlayImproves } from './zoom-underlay'

const view = { x: 0, y: 0, zoom: 8 }
const size = { width: 800, height: 600, dpr: 2 }

function tile(key: string, zoom: number, x: number, y: number, span: number): RasterTile {
  return { key, x, y, width: span, height: span, zoom, gutter: 1 }
}

test('the underlay uv is the new viewport inside the retained device texture', () => {
  // Same numbers as the kernel underlay_uv fixture.
  const uv = retainedPreviewUnderlay({
    view: { x: 0, y: 0, zoom: 1 }, width: 128, height: 128, dpr: 2, textureWidth: 256, textureHeight: 256,
  }, {
    view: { x: -192, y: -192, zoom: 4 }, width: 128, height: 128, dpr: 2,
  })
  expect(uv).toEqual({ u0: 0.375, v0: 0.375, u1: 0.625, v1: 0.625 })
  expect(retainedPreviewUnderlay({
    view: { x: 0, y: 0, zoom: 4 }, width: 128, height: 128, dpr: 2, textureWidth: 256, textureHeight: 256,
  }, {
    view: { x: 0, y: 0, zoom: 1 }, width: 128, height: 128, dpr: 2,
  })).toBeUndefined()
})

test('a ready finer tile is shown even when the retained texture is no longer in the cache', () => {
  const backing = tile('backing', 1, 0, 0, 800)
  const ready = tile('ready', 4, 0, 0, 200)
  expect(sharperCoverageFrame([ready], [backing], view, size)).toBeUndefined()
  expect(zoomInPartialTiles([ready], [backing], view, size)?.map(item => item.key)).toEqual(['ready'])
  expect(zoomInPartialTiles([backing], [backing], view, size)).toBeUndefined()
  expect(zoomInPartialTiles([ready], [], view, size)).toBeUndefined()
})

test('the focus cell is the 160 grid under the wheel and goes ahead of a 512 tile', () => {
  expect(zoomInFocusCore(0, 0, 800, 600, 400, 300)).toEqual({ x: 320, y: 160, width: 160, height: 160 })
  expect(zoomInFocusCore(0, 0, 800, 600, -1, 10)).toBeUndefined()
  const ahead = zoomInFocusAhead(
    [{ key: 'big', x: -1, y: -1, width: 514, height: 514, zoom: 4, gutter: 1 }],
    0, 0, 800, 600, 400, 300, 4, { x: 0, y: 0 },
  )
  expect(ahead).toMatchObject({ x: 319, y: 159, width: 162, height: 162, zoom: 4, gutter: 1 })
  expect(zoomInFocusAhead(
    [{ key: 'small', x: 319, y: 159, width: 162, height: 162, zoom: 4, gutter: 1 }],
    0, 0, 800, 600, 400, 300, 4, { x: 0, y: 0 },
  )).toBeUndefined()
  const parent = { key: 'parent', x: -1, y: -1, width: 514, height: 514, zoom: 4, gutter: 1 }
  const cell = zoomInFocusTile(parent, { x: 100, y: 75 })
  expect(cell).toMatchObject({ x: 319, y: 159, width: 162, height: 162 })
  expect(cell?.key).toBe('parent/zoom-focus/320:160')
  expect(zoomInFocusTile({ ...parent, width: 162, height: 162 }, { x: 20, y: 20 })).toBeUndefined()
})

test('a partial finer tile improves the underlay and a same-density tile does not', () => {
  const previous = { view: { x: 0, y: 0, zoom: 1 }, dpr: 1 }
  const target = { x: 0, y: 0, zoom: 2 }
  const size = { width: 8, height: 8 }
  const old = tile('old', 1, -1, -1, 18)
  const narrow = tile('detail', 2, -1, -1, 4)
  expect(zoomUnderlayImproves(previous, [narrow], target, size, [old])).toBe(true)
  expect(zoomUnderlayImproves(previous, [{ ...narrow, zoom: 1 }], target, size, [old])).toBe(false)
  expect(zoomUnderlayImproves(previous, [], target, size, [old])).toBe(false)
})
