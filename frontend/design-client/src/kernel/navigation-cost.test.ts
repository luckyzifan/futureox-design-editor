import { expect, test } from 'vitest'
import { NavigationCost } from './navigation-cost'
import type { RasterTile, TileFillPriority } from './tile-cache'
test('measured cost orders equal coverage tiers and ages expensive work without crossing scope',()=>{
  const model=new NavigationCost(),tiles=['slow','fast','hole'].map(key=>({key,x:0,y:0,width:514,height:514,zoom:1} satisfies RasterTile))
  const priorities=new Map(tiles.map(tile=>[tile,1 as TileFillPriority]))
  model.reset('a');model.record('a','slow',100);model.record('a','fast',5)
  expect(model.choose(tiles.slice(0,2),priorities)).toBe(tiles[1])
  for(let i=0;i<3;i++)expect(model.choose(tiles.slice(0,2),priorities)).toBe(tiles[1])
  expect(model.choose(tiles.slice(0,2),priorities)).toBe(tiles[0])
  priorities.set(tiles[2],0);expect(model.choose(tiles,priorities)).toBe(tiles[2])
  model.reset('b');model.record('a','slow',1000)
  expect(model.choose(tiles.slice(0,2),priorities)).toBe(tiles[0])
})
