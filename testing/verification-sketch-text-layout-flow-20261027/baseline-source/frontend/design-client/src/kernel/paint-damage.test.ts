import { expect, test } from 'vitest'
import { paintDamageIntersects, paintDamageRects } from './paint-damage'

test('disjoint damage retains tiles in the union gap and invalidates both endpoints',()=>{
  const damage={full:false,bounds:[0,0,1100,100] as [number,number,number,number],rects:[[0,0,100,100],[1000,0,100,100]] as [number,number,number,number][]}
  expect(paintDamageIntersects(damage,[0,0,100,100])).toBe(true)
  expect(paintDamageIntersects(damage,[500,0,100,100])).toBe(false)
  expect(paintDamageIntersects(damage,[1050,0,100,100])).toBe(true)
  expect(paintDamageIntersects({...damage,full:true},[500,0,100,100])).toBe(true)
  expect(paintDamageIntersects({full:false,bounds:damage.bounds},[500,0,100,100])).toBe(true)
  expect(paintDamageRects({full:false,rects:[],bounds:damage.bounds})).toEqual([])
})
