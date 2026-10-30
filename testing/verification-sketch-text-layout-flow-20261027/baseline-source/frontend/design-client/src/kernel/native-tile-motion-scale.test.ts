import { expect, test } from 'vitest'
import { nativeTileMotionScale } from './canvas-raster-plan'
import { displayTileBudget } from './tile-cache'

test('adjacent inputs share an upward lattice within the same viewport allowance', () => {
  for (const zoom of [1.01, 1.04, 1.1, 1.18]) {
    const scale = nativeTileMotionScale({ x: 0, y: 0, zoom }, 2, 855, 836)
    expect(scale).toBe(2 ** 1.25)
    expect(scale).toBeGreaterThanOrEqual(zoom * 2)
    expect(displayTileBudget(855, 836, scale / zoom, false)).toBe(displayTileBudget(855, 836, 2, false))
  }
})
test('never grows admission or undersamples at a clamped ladder boundary', () => {
  for (const width of [855, 1920, 2560, 4096]) for (const zoom of [.0001, .1, 1.01, 31, 64, 100]) {
    const scale = nativeTileMotionScale({ x: 0, y: 0, zoom }, 2, width, 1440)
    expect(scale).toBeGreaterThanOrEqual(zoom * 2)
    expect(displayTileBudget(width, 1440, scale / zoom, false)).toBe(displayTileBudget(width, 1440, 2, false))
  }
})
