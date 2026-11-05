import { expect, test } from 'vitest'
import { paintDamageIntersects, paintDamageRects, viewportDamage } from './paint-damage'

test('disjoint damage retains tiles in the union gap and invalidates both endpoints',()=>{
  const damage={full:false,bounds:[0,0,1100,100] as [number,number,number,number],rects:[[0,0,100,100],[1000,0,100,100]] as [number,number,number,number][]}
  expect(paintDamageIntersects(damage,[0,0,100,100])).toBe(true)
  expect(paintDamageIntersects(damage,[500,0,100,100])).toBe(false)
  expect(paintDamageIntersects(damage,[1050,0,100,100])).toBe(true)
  expect(paintDamageIntersects({...damage,full:true},[500,0,100,100])).toBe(true)
  expect(paintDamageIntersects({full:false,bounds:damage.bounds},[500,0,100,100])).toBe(true)
  expect(paintDamageRects({full:false,rects:[],bounds:damage.bounds})).toEqual([])
})

test('viewport repair bounds include both poses, fractional camera and the sampling neighbours', () => {
  const camera = { x: -.25, y: 1.125, zoom: 2 }
  expect(viewportDamage({full:false,rects:[[0,0,3,4],[8,6,2.25,7]]},camera,100,80))
    .toEqual({x:0,y:0,w:23,h:30})
  expect(viewportDamage({full:true,rects:[[0,0,1,1]]},camera,100,80)).toBeUndefined()
  expect(viewportDamage({full:false,rects:[[100,100,1,1]]},camera,100,80)).toBeUndefined()
  expect(viewportDamage({full:false,rects:[[0,0,100,100]]},camera,100,80)).toBeUndefined()
  expect(viewportDamage({full:false,rects:[[NaN,0,1,1]]},camera,100,80)).toBeUndefined()
})
