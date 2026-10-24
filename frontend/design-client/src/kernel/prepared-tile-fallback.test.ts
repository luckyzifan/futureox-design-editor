import { expect, test, vi } from 'vitest'
import { preparedTileCanFill, preparedTileContinuation } from './prepared-tile-fallback'
import type { ResidentFrame, ResidentItem } from './gpu/resident-presenter'
import type { RasterTile } from './tile-cache'
const tile: RasterTile = { key: 'compiled', x: -513, y: -1, width: 514, height: 514, zoom: 1, phaseX: .375, phaseY: .125 }
const frame: ResidentFrame = { view: { x: 400, y: .25, zoom: .75 }, width: 800, height: 600, dpr: 2, items: [] }
const item = (zoom = 1): ResidentItem => ({ active: true, layer: 2, tile: { ...tile, key: 'resident', zoom, serial: 1, gpuTile: 1 } })

test('already-prepared neighbouring density can fill a visible gap, including negative coordinates and phase', () => {
  expect(preparedTileCanFill(tile, frame)).toBe(true)
  expect(preparedTileCanFill({ ...tile, x: 3000 }, frame)).toBe(false)
  expect(preparedTileCanFill({ ...tile, zoom: .1 }, frame)).toBe(false)
  expect(preparedTileCanFill({ ...tile, zoom: 8 }, frame)).toBe(false)
  expect(preparedTileCanFill(tile, { ...frame, interaction: true })).toBe(false)
  expect(preparedTileCanFill(tile, undefined)).toBe(false)
})

test('complete equal-or-sharper coverage skips work; coarse or clipped residents leave real holes', () => {
  expect(preparedTileCanFill(tile, { ...frame, items: [item()] })).toBe(false)
  expect(preparedTileCanFill(tile, { ...frame, items: [{ ...item(), clip: { left: 100, top: 100, width: 30, height: 30 } }] })).toBe(true)
  expect(preparedTileCanFill(tile, { ...frame, items: [{ ...item(), active: false }] })).toBe(true)
  expect(preparedTileCanFill(tile, { ...frame, items: [{ ...item(), blend: true }] })).toBe(true)
  expect(preparedTileCanFill(tile, { ...frame, items: [item(.8)] })).toBe(true)
})

test('several finer residents collectively cover the prepared crop with exact shared edges', () => {
  const current = { ...frame, view: { x: 0, y: 0, zoom: 1 }, dpr: 1 }
  const prepared = { ...tile, x: -1, phaseX: 0, phaseY: 0 }
  const halves = [0, 256].map((left, i) => ({ ...item(2), gutter: 0,
    tile: { ...item(2).tile, serial: i, width: 512, height: 1024 },
    placement: { left, top: 0, width: 256, height: 512 } }))
  expect(preparedTileCanFill(prepared, { ...current, items: halves })).toBe(false)
  expect(preparedTileCanFill(prepared, { ...current, items: [halves[0]] })).toBe(true)
})

test('a stale prepared tile continues only while the latest camera still has its visible gap', () => {
  let latest = frame, current = false
  const continuing = preparedTileContinuation(tile, () => current, true, () => latest)
  expect(continuing()).toBe(true)
  latest = { ...frame, view: { ...frame.view, x: 5000 } }
  expect(continuing()).toBe(false)
  latest = { ...frame, view: { ...frame.view, x: 420 } }
  expect(continuing()).toBe(true)
  latest = { ...frame, items: [item()] }
  expect(continuing()).toBe(false)
  current = true
  expect(continuing()).toBe(true)
  current = false; latest = frame
  expect(preparedTileContinuation(tile, () => current, false, () => latest)()).toBe(false)
})
test('private coverage versions reuse one gap proof while cancellation and changed coverage are rechecked', () => {
  let latest: ResidentFrame = { ...frame, items: [] }, version = {}, current = false
  const read = vi.fn(() => latest), live = vi.fn(() => current)
  const continuing = preparedTileContinuation(tile, live, true, read, () => version)
  for (let i = 0; i < 100; i++) expect(continuing()).toBe(true)
  expect(read).toHaveBeenCalledTimes(1); expect(live).toHaveBeenCalledTimes(100)
  latest = { ...frame, items: [item()] }; version = {}
  expect(continuing()).toBe(false); expect(read).toHaveBeenCalledTimes(2)
  current = true; expect(continuing()).toBe(true)
  current = false; expect(continuing()).toBe(false)
  latest = { ...frame, interaction: true }; version = {}
  expect(continuing()).toBe(false)
})
test('callers without a private version still observe mutations of the same frame object', () => {
  const mutable = { ...frame, items: [] as ResidentItem[] }
  const continuing = preparedTileContinuation(tile, () => false, true, () => mutable)
  expect(continuing()).toBe(true)
  mutable.items.push(item()); expect(continuing()).toBe(false)
})
