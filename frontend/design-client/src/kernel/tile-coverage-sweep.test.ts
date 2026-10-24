import { expect, test, vi } from 'vitest'
import { tilesCoverBounds, type RasterTile } from './tile-cache'

test('rectangular coverage agrees with an independent integer-cell oracle', () => {
  let seed = 17321
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
  for (let trial = 0; trial < 300; trial++) {
    const bounds = { x: -8, y: -6, width: 16, height: 12 }
    const tiles: RasterTile[] = Array.from({ length: random(35) }, (_, i) => ({ key: String(i),
      x: random(40) - 20, y: random(32) - 16, width: random(25) + 1, height: random(21) + 1, zoom: 1, gutter: 0 }))
    let oracle = true
    for (let y = bounds.y; y < bounds.y + bounds.height; y++) for (let x = bounds.x; x < bounds.x + bounds.width; x++)
      oracle &&= tiles.some(t => t.x <= x && t.x + t.width >= x + 1 && t.y <= y && t.y + t.height >= y + 1)
    expect(tilesCoverBounds(tiles, bounds)).toBe(oracle)
  }
})
test('many shared-X fragments sort once, preserving fractional phases and the existing edge tolerance', () => {
  const bounds = { x: -.375, y: -.125, width: 512, height: 512 }
  const tiles: RasterTile[] = [{ key: 'full', x: -1, y: -1, width: 514, height: 514, zoom: 1, phaseX: .375, phaseY: .125 },
    ...Array.from({ length: 1000 }, (_, i) => ({ key: String(i), x: i / 2, y: i % 31, width: 20, height: 20, zoom: 1, gutter: 0 }))]
  const sort = vi.spyOn(Array.prototype, 'sort')
  try { expect(tilesCoverBounds(tiles, bounds)).toBe(true); expect(sort.mock.calls.length).toBeLessThanOrEqual(2) }
  finally { sort.mockRestore() }
  const rows = (gap: number): RasterTile[] => [{ key: 'a', x: 0, y: 0, width: 10, height: 5, zoom: 1, gutter: 0 },
    { key: 'b', x: 0, y: 5 + gap, width: 10, height: 5, zoom: 1, gutter: 0 }]
  expect(tilesCoverBounds(rows(5e-8), { x: 0, y: 0, width: 10, height: 10 })).toBe(true)
  expect(tilesCoverBounds(rows(2e-7), { x: 0, y: 0, width: 10, height: 10 })).toBe(false)
})
