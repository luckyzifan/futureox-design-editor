import { describe, expect, it } from 'vitest'
import { patternCameraPeriod, snapPatternAxis, tileComputationKey, tileComputationDependsOnCamera } from './tile-computation-key'
import type { RasterTile } from './tile-cache'

const tile = (x: number, y: number): RasterTile => ({
  key: `1:0:0:${x}:${y}`, x, y, width: 514, height: 514, zoom: 1,
})

describe('pattern camera periods', () => {
  it('screen checkerboard remains camera-dependent on managed documents', () => {
    expect(tileComputationDependsOnCamera({checkerboard:true}, true)).toBe(true)
    expect(patternCameraPeriod(0.1, {checkerboard:true,cameraDependent:true})).toBe(32)
  })
  it('keeps pixel preview and camera-free paths unquantized', () => {
    expect(patternCameraPeriod(1, { pixelPreview: 1, grid: true, cameraDependent: true })).toBe(0)
    expect(patternCameraPeriod(1, { cameraDependent: false })).toBe(0)
  })
  it('uses the grid period at integer scales and 512 otherwise', () => {
    expect(patternCameraPeriod(1, { grid: true, cameraDependent: true })).toBe(32)
    expect(patternCameraPeriod(2, { grid: true, cameraDependent: true })).toBe(64)
    expect(patternCameraPeriod(0.5, { grid: true, cameraDependent: true })).toBe(16)
    expect(patternCameraPeriod(0.1, { grid: true, cameraDependent: true })).toBe(512)
  })
  it('quantizes dither-only paths to the power-of-two tile side', () => {
    expect(patternCameraPeriod(1, { cameraDependent: true })).toBe(512)
  })
  it('snaps camera axes onto whole periods', () => {
    expect(snapPatternAxis(137, 32)).toBe(128)
    expect(snapPatternAxis(137, 0)).toBe(137)
    expect(snapPatternAxis(-137, 32)).toBe(-128)
  })
  it('pans inside one period share one computation key', () => {
    const key = (x: number) =>
      tileComputationKey(tile(1, 0), { x: snapPatternAxis(x, 32), y: 0, zoom: 1 }, true)
    expect(key(128)).toBe(key(130))
    expect(key(128)).not.toBe(key(160))
  })
})
