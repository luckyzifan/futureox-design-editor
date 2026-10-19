import { expect, test } from 'vitest'
import { planTiles } from './tile-cache'

test('finite input overflow and non-progressing integer addresses reject before enumeration', () => {
  expect(() => planTiles({ x: 2 ** 62, y: 0, width: 1024, height: 512 }, 1)).toThrow('coordinate range')
  expect(() => planTiles({ x: Number.MAX_VALUE, y: 0, width: 512, height: 512 }, 32)).toThrow('coordinate range')
  expect(() => planTiles({ x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 0 }, 1)).toThrow('coordinate range')
  expect(() => planTiles({ x: 0, y: -(2 ** 62), width: 512, height: 1024 }, 1)).toThrow('coordinate range')
})

test('invalid limits cannot disable the bounded tile enumeration', () => {
  for (const limit of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => planTiles({ x: 0, y: 0, width: 512, height: 512 }, 1, limit)).toThrow('bounds')
  expect(() => planTiles({ x: 0, y: 0, width: 512 * 257, height: 512 * 256 }, 1, Number.MAX_SAFE_INTEGER)).toThrow('budget')
})

test('ordinary 32x visible viewports preserve exact density, gutters and fractional phase', () => {
  const bounds = { x: -10.25, y: -20.125, width: 1920 / 32, height: 1080 / 32 }
  const tiles = planTiles(bounds, 32, 256, { x: .25, y: .75 })
  expect(tiles.length).toBeGreaterThan(0)
  expect(tiles.length).toBeLessThanOrEqual(20)
  for (const tile of tiles) {
    expect(tile.zoom).toBe(32); expect(tile.width).toBe(514); expect(tile.height).toBe(514)
    expect(tile.phaseX).toBe(.25); expect(tile.phaseY).toBe(.75)
    expect(Number.isSafeInteger(tile.x)).toBe(true)
  }
})
