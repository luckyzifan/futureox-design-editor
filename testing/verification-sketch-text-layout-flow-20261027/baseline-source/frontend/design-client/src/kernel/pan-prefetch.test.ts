import { expect, test } from 'vitest'
import { panPrefetch } from './pan-prefetch'
import type { RasterTile } from './tile-cache'
const tiles: RasterTile[] = Array.from({ length: 9 }, (_, i) => {
  const x = i % 3 - 1, y = Math.floor(i / 3) - 1
  return { key: `${x}/${y}`, x: x * 512 - 1, y: y * 512 - 1, width: 514, height: 514, zoom: 1, prefetch: true as const }
}).filter(t => t.key !== '0/0')
const box = { x: 0, y: 0, width: 512, height: 512 }, view = { x: 0, y: 0, zoom: 1 }
test('pan direction warms the newly exposed edge, not the trailing edge', () => {
  expect(panPrefetch(tiles, { ...view, x: -1 }, view, box).map(t => t.key)).toEqual(['-1/0'])
  expect(panPrefetch(tiles, { ...view, x: 1 }, view, box).map(t => t.key)).toEqual(['1/0'])
  expect(panPrefetch(tiles, { ...view, y: -1 }, view, box).map(t => t.key)).toEqual(['0/-1'])
})
test('diagonal pans include the exposed corner; a zoom or idle frame has no directional guess', () => {
  expect(panPrefetch(tiles, { ...view, x: -1, y: -1 }, view, box).map(t => t.key).sort()).toEqual(['-1/-1', '-1/0', '0/-1'])
  expect(panPrefetch(tiles, { ...view, zoom: 2 }, view, box)).toEqual([])
  expect(panPrefetch(tiles, view, view, box)).toEqual([])
})

test('prediction changes only offscreen work priority and obeys count and byte caps',()=>{
  const previous={...view,x:-300,y:-40},snapshot=JSON.stringify({tiles,previous,view,box})
  const selected=panPrefetch(tiles,previous,view,box,{tiles:8,bytes:514*514*4})
  expect(selected).toHaveLength(1);expect(selected[0].prefetch).toBe(true)
  expect(panPrefetch(tiles,previous,view,box,{tiles:0,bytes:99999999})).toEqual([])
  expect(JSON.stringify({tiles,previous,view,box})).toBe(snapshot)
})
