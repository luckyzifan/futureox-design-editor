import { expect, test } from 'vitest'
import { compositeDrawPlan, compositeRasterQuad } from './composite-draw-plan'
import type { CompositeItem } from './tile-compositor'
const view = { x: 0, y: 0, zoom: 1 }
const item = (
  serial: number,
  placement: { left: number; top: number; width: number; height: number },
  layer = 0,
  blend = false,
): CompositeItem => ({
  tile: {
    serial,
    key: String(serial),
    bytes: new Uint8Array(),
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zoom: 1,
  },
  active: true,
  gutter: 0,
  layer,
  blend,
  placement,
})
test('higher-detail opaque tiles remove covered low-resolution work, retaining holes', () => {
  const old = item(1, { left: 0, top: 0, width: 100, height: 100 }),
    fine = item(2, { left: 25, top: 25, width: 50, height: 50 }, 3)
  const draws = compositeDrawPlan([old, fine], view, 100, 100)
  const area = draws.reduce(
    (sum, d) => sum + (d.clip.right - d.clip.left) * (d.clip.bottom - d.clip.top),
    0,
  )
  expect(area).toBe(10000)
  expect(draws.filter((d) => d.item === old)).toHaveLength(4)
  expect(draws.at(-1)!.item).toBe(fine)
})
test('transparent moving layers retain their backdrop and paint ordering', () => {
  const back = item(1, { left: 0, top: 0, width: 100, height: 100 }),
    front = item(2, { left: 0, top: 0, width: 100, height: 100 }, 1, true)
  expect(compositeDrawPlan([back, front], view, 100, 100).map((d) => d.item.tile.serial)).toEqual([
    1, 2,
  ])
})
test('many complete old zoom levels produce only the top visible draw', () => {
  const items = Array.from({ length: 100 }, (_, i) =>
    item(i, { left: 0, top: 0, width: 100, height: 100 }, i),
  )
  expect(compositeDrawPlan(items, view, 100, 100).map((d) => d.item.tile.serial)).toEqual([99])
})

test.each([1, 1.25, 2])('fractional shared edges assign each physical pixel exactly once at DPR %s', dpr => {
  for (const left of [152.25, 152.2501, 152.2499, 152.75, 152.7501]) {
    const tiles = [item(1, { left: 0, top: 0, width: left, height: 80 }),
      item(2, { left, top: 0, width: 703 - left, height: 80 })]
    const quads = compositeDrawPlan(tiles, view, 703, 80).map(row =>
      compositeRasterQuad(row.placement, row.clip, 703, 80, dpr)!)
    const ownership = new Uint8Array(Math.ceil(703 * dpr))
    for (const q of quads) for (let x = q.x; x < q.x + q.width; x++) ownership[x]++
    expect(ownership.every(count => count === 1)).toBe(true)
    for (const q of quads) expect(q.box[0] * Math.ceil(703 * dpr) / 703).toBeCloseTo(q.x, 10)
  }
})

test('snapped display geometry retains the original texture sampling transform', () => {
  const p = { left: 151.7501, top: -.5, width: 257, height: 257 }
  const q = compositeRasterQuad(p, { left: 152.2501, top: 0, right: 408.2501, bottom: 80 }, 703, 80, 2)!
  for (const t of [.1, .5, .9]) {
    const x = q.box[0] + q.box[2] * t
    expect(q.uv[0] + q.uv[2] * t).toBeCloseTo((x - p.left) / p.width, 12)
  }
})
