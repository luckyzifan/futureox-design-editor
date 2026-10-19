import { expect, test } from 'vitest'
import { interactionCaptureTiles, recoverableInteractionBudget } from './interaction-capture-tiles'

test('exact capture tiles partition the pixel lattice once, including negative origins and partial edges', () => {
  const tiles=interactionCaptureTiles(-7,-13,1025,513,1.2)
  expect(tiles).toHaveLength(6)
  const visited=new Uint8Array(1025*513)
  for(const tile of tiles){
    expect(tile.zoom).toBe(1.2);expect(tile.gutter).toBe(1)
    expect(Math.max(tile.width,tile.height)).toBeLessThanOrEqual(514)
    for(let y=tile.y+1;y<tile.y+tile.height-1;y++)for(let x=tile.x+1;x<tile.x+tile.width-1;x++)
      visited[(y+13)*1025+x+7]++
  }
  expect(visited.every(value=>value===1)).toBe(true)
  expect(()=>interactionCaptureTiles(0,0,8193,8193,1)).toThrow(/budget/)
  expect(()=>interactionCaptureTiles(.1,0,100,100,1)).toThrow(/extent/)
  expect(()=>interactionCaptureTiles(0,0,100,100,NaN)).toThrow(/extent/)
})
test('working capture limits permit a tiled retry; device loss and display residency errors do not', () => {
  expect(recoverableInteractionBudget(Error('GPU 表面内存预算超限'))).toBe(true)
  expect(recoverableInteractionBudget(Error('GPU analytic interval program budget exceeded'))).toBe(true)
  expect(recoverableInteractionBudget(Error('GPU display resident budget exceeded'))).toBe(false)
  expect(recoverableInteractionBudget(Error('WebGPU device lost'))).toBe(false)
})
