import { expect, test, vi } from 'vitest'
import { GpuRenderer } from './renderer'
import { rect, type Driver, type Texture } from './types'

test('completed coordinate retirement detaches only its aliases and preserves other sample phases',()=>{
  const destroy=vi.fn(),renderer=new GpuRenderer({managed:true,destroy} as unknown as Driver) as any
  const texture={width:2,height:2,bytes:64,resource:{}} as Texture,other={...texture,resource:{}} as Texture
  const surface={texture,rect:rect(0,0,2,2)},paint={kind:'linear'},otherPaint={kind:'image'}
  renderer.bytes=128;renderer.coordinateMaps.add(texture);renderer.coordinateMaps.add(other)
  renderer.setImageGrid(paint,0,surface);renderer.setImageGrid(paint,1,{...surface,texture:other})
  renderer.setImageGrid(otherPaint,0,surface)
  renderer.gradientLookups.set(paint,surface);renderer.textureLookups.set('alias',surface)
  renderer.textureMath=surface;renderer.replayParameters=texture
  for(let i=0;i<5000;i++){
    const p={kind:'linear',id:i},s={...surface,texture:other}
    renderer.setImageGrid(p,0,s);renderer.gradientLookups.set(p,s);renderer.textureLookups.set('foreign-'+i,s)
  }
  const scans=[renderer.imageGrids,renderer.gradientLookups,renderer.textureLookups].map(cache=>
    vi.spyOn(cache,Symbol.iterator).mockImplementation(()=>{throw Error('Global coordinate alias scan')}))
  try{renderer.forgetCoordinateTexture(texture)}finally{scans.forEach(scan=>scan.mockRestore())}
  expect(renderer.imageGrids.get(paint).get(0)).toBeUndefined()
  expect(renderer.imageGrids.get(paint).get(1).texture).toBe(other)
  expect(renderer.imageGrids.has(otherPaint)).toBe(false)
  expect(renderer.gradientLookups.has(paint)).toBe(false);expect(renderer.textureLookups.has('alias')).toBe(false)
  expect(renderer.imageGrids.keysFor(other).size).toBe(5001)
  expect(renderer.coordinateMaps.has(texture)).toBe(false);expect(renderer.coordinateMaps.has(other)).toBe(true)
  expect(renderer.textureMath).toBeUndefined();expect(renderer.replayParameters).toBeUndefined()
  expect(renderer.bytes).toBe(64);expect(destroy).toHaveBeenCalledExactlyOnceWith(texture)
})
