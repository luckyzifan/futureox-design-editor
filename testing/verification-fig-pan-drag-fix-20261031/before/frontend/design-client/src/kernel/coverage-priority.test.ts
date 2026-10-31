import { expect, test } from 'vitest'
import { prioritizeUncoveredTiles } from './coverage-priority'
import { planTiles } from './tile-cache'

test('uncovered viewport tiles precede covered centre refinement at native density', () => {
  const viewport = { x: 0, y: 0, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 1)
  const centre = planTiles({ x: 512, y: 0, width: 512, height: 512 }, 1)[0]
  const ordered = prioritizeUncoveredTiles(tiles, [centre], viewport)
  expect(ordered.at(-1)?.key).toBe(centre.key)
  expect(ordered.slice(0, -1)).toEqual(tiles.filter(tile => tile.key !== centre.key))
  expect(ordered.every(tile => tile.zoom === 1)).toBe(true)
})

test('a full lower-density layer preserves normal distance priority', () => {
  const viewport = { x: -10, y: -20, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 2)
  expect(prioritizeUncoveredTiles(tiles, planTiles(viewport, .25), viewport)).toBe(tiles)
  expect(prioritizeUncoveredTiles(tiles, [], viewport)).toBe(tiles)
})

test('coarse-only edges precede centre pixels already supplied at native density', () => {
  const viewport = { x: 0, y: 0, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 1)
  const left = tiles.find(tile => tile.x < 0)!, centre = tiles.find(tile => tile.x === 511)!, right = tiles.find(tile => tile.x > 511)!
  const overview = planTiles(viewport, 1 / 32)
  // Simulate centre-first camera planning with a differently keyed old sharp
  // centre, and very coarse coverage everywhere else.
  const oldCentre = { ...centre, key: 'old-sharp-centre' }
  expect(prioritizeUncoveredTiles([centre, left, right], [...overview, oldCentre], viewport))
    .toEqual([left, right, centre])
})

test('true holes still precede coarse-only coverage and adequate-density refinement', () => {
  const viewport = { x: 0, y: 0, width: 1536, height: 512 }
  const tiles = planTiles(viewport, 1)
  const [left, centre, right] = [tiles.find(tile => tile.x < 0)!, tiles.find(tile => tile.x === 511)!, tiles.find(tile => tile.x > 511)!]
  const coarseRight = { key: 'coarse-right', x: 32, y: 0, width: 16, height: 16, zoom: 1 / 32, gutter: 0 }
  expect(prioritizeUncoveredTiles([centre, right, left], [{ ...centre, key: 'old-centre' }, coarseRight], viewport))
    .toEqual([left, right, centre])
})

test('submit hints preserve tile identity and report the exact existing coverage tiers', () => {
  const viewport={x:0,y:0,width:1536,height:512},tiles=planTiles(viewport,1)
  const [left,centre,right]=[tiles.find(t=>t.x<0)!,tiles.find(t=>t.x===511)!,tiles.find(t=>t.x>511)!]
  const coarseRight={key:'coarse',x:32,y:0,width:16,height:16,zoom:1/32,gutter:0}
  const priorities=new Map<import('./tile-cache').RasterTile,import('./tile-cache').TileFillPriority>()
  const ordered=prioritizeUncoveredTiles([centre,right,left],[{...centre,key:'old-centre'},coarseRight],viewport,priorities)
  expect(ordered).toEqual([left,right,centre]);expect(ordered.map(t=>priorities.get(t))).toEqual([0,1,2])
  expect(ordered[0]).toBe(left);expect(Object.hasOwn(left,'priority')).toBe(false)
  priorities.clear();expect(prioritizeUncoveredTiles(tiles,[],viewport,priorities)).toBe(tiles)
  expect(tiles.map(t=>priorities.get(t))).toEqual([0,0,0])
  priorities.clear();expect(prioritizeUncoveredTiles(tiles,planTiles(viewport,.25),viewport,priorities)).toBe(tiles)
  expect(tiles.map(t=>priorities.get(t))).toEqual([1,1,1])
})
