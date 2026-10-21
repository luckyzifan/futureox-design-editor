import { expect, test } from 'vitest'
import { compositeDrawPlan } from './gpu/composite-draw-plan'
import { touchCompositeContributors, visibleCompositeContributors, type CompositeCacheFrame, type CompositeCacheOwner, type CompositeCacheTile } from './composite-cache-use'
const document = {}, client = {}, deviceKey = 'worker/device/owner'
const owner: CompositeCacheOwner = { document, client, deviceKey, revision: 7, pageId: 'p', epoch: 2,
  backend: 'webgpu', resident: true, visible: true, view: { x: -25, y: 0, zoom: 1 }, width: 100, height: 100, dpr: 2 }
let serial = 0
function tile(key: string, zoom: number, x = 0, width = 200): CompositeCacheTile {
  return { key, serial: ++serial, gpuTile: serial, document, revision: 7, residentDevice: { client, key: deviceKey },
    x: x * zoom, y: 0, width: width * zoom, height: 100 * zoom, zoom, gutter: 0, bytes: new Uint8Array() }
}
function frame(tiles: CompositeCacheTile[]): CompositeCacheFrame<CompositeCacheTile> {
  return { ...owner, view: { ...owner.view }, items: tiles.map(tile => ({ tile, active: true, layer: 2, gutter: 0 })) }
}
function pressure(map: Map<string, CompositeCacheTile>, protectedTiles: Set<CompositeCacheTile>, limit: number) {
  const next = touchCompositeContributors(map, protectedTiles)
  for (const [key, value] of next) { if (next.size <= limit) break; if (!protectedTiles.has(value)) next.delete(key) }
  if (next.size > limit) throw Error('bounded cache cannot admit this protected set')
  return next
}

test('partial pan and multiple densities retain actual hole coverage under pressure, not occluded history', () => {
  const sharp = tile('sharp-cache', 4, 0, 75), hidden = tile('occluded-history', 2, 0, 75),
    base = tile('base-hole', 1), offscreen = tile('offscreen', 64, 500), incoming = tile('incoming-not-ready', 8, 0, 75)
  const all = [sharp, hidden, base, offscreen, incoming], live = new Map(all.map(tile => [tile.key, tile]))
  const ready = new Set([sharp.key, hidden.key, base.key, offscreen.key])
  const used = visibleCompositeContributors(frame(all), owner, live, ready)
  expect(used).toEqual(new Set([base, sharp]))
  // Incoming work keeps its existing planner pin; it is not yet an occluder.
  const kept = pressure(live, new Set([...used, incoming]), 3)
  expect([...kept.values()]).toEqual([sharp, base, incoming])
  const draws = compositeDrawPlan(frame([...kept.values()]).items.filter(item => ready.has(item.tile.key)), owner.view, 100, 100)
  expect(draws.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(10_000)
  expect(kept.has(hidden.key)).toBe(false); expect(kept.has(offscreen.key)).toBe(false)
  expect(kept.size).toBe(3) // No budget expansion or all-history pin.
})

test('a ready current-device replacement releases only the coverage it actually replaces', () => {
  const old = tile('old-sharp', 4, 0, 75), base = tile('base', 1), next = tile('next-sharp', 8, 0, 75)
  const all = [old, base, next], live = new Map(all.map(tile => [tile.key, tile])), ready = new Set(all.map(tile => tile.key))
  next.residentDevice = undefined
  expect(visibleCompositeContributors(frame(all), owner, live, ready)).toEqual(new Set([base, old]))
  next.residentDevice = { client, key: deviceKey }
  const used = visibleCompositeContributors(frame(all), owner, live, ready)
  expect(used).toEqual(new Set([base, next]))
  expect([...pressure(live, used, 2).values()]).toEqual([base, next])
  expect(() => pressure(live, used, 1)).toThrow('bounded cache')
})

test('ownership, exact frame camera and object/serial fences reject stale cache-use evidence', () => {
  const value = tile('live', 2), live = new Map([[value.key, value]]), ready = new Set([value.key]), captured = frame([value])
  for (const patch of [{ document: {} }, { client: {} }, { revision: 8 }, { pageId: 'other' }, { epoch: 3 },
    { deviceKey: 'new-device' }, { backend: 'webgl2' }, { width: 101 }, { dpr: 1 }, { visible: false }, { view: { ...owner.view, x: -24 } }])
    expect(visibleCompositeContributors(captured, { ...owner, ...patch }, live, ready).size).toBe(0)
  expect(visibleCompositeContributors(captured, owner, new Map([[value.key, { ...value, serial: 99 }]]), ready).size).toBe(0)
  expect(visibleCompositeContributors(captured, owner, live, new Set()).size).toBe(0)
  value.residentDevice = { client: {}, key: deviceKey }
  expect(visibleCompositeContributors(captured, owner, live, ready).size).toBe(0)
})

test('blended fragments retain backdrop and LRU touch preserves equal-density draw order', () => {
  const a = tile('a', 2), b = tile('b', 2), hidden = tile('hidden', 1)
  const captured = frame([hidden, a, b]); captured.items[2].blend = true
  const live = new Map([hidden, a, b].map(tile => [tile.key, tile])), ready = new Set(live.keys())
  const used = visibleCompositeContributors(captured, owner, live, ready)
  expect(used).toEqual(new Set([a, b]))
  expect([...touchCompositeContributors(live, used).keys()]).toEqual(['hidden', 'a', 'b'])
  expect([...live.keys()]).toEqual(['hidden', 'a', 'b'])
})
