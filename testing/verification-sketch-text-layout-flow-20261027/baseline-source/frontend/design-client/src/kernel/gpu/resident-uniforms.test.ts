import { expect,test } from 'vitest'
import { ResidentUniforms } from './resident-uniforms'
test('persistent transform slots preserve old f32 packing and update only changed rows',()=>{
  const cache=new ResidentUniforms(4),a=[-0,.25,120,90,0,0,1,1,800,600,0,0],b=[3.1,7.2,80,50,0,0,1,1,800,600,0,0]
  cache.begin();cache.set(0,a);cache.set(1,b)
  const legacy=new Float32Array(128);legacy.set(Float32Array.from(a));legacy.set(Float32Array.from(b),64)
  expect(new Uint8Array(cache.changed()!.data.buffer,0,512)).toEqual(new Uint8Array(legacy.buffer))
  cache.begin();cache.set(0,a);cache.set(1,b);expect(cache.changed()).toBeUndefined()
  cache.begin();cache.set(0,a);cache.set(1,[...b.slice(0,1),8.25,...b.slice(2)])
  expect(cache.changed()!.offset).toBe(256);expect(cache.changed()!.data.byteLength).toBe(256)
  cache.begin();cache.set(0,[0,...a.slice(1)]);expect(cache.changed()!.offset).toBe(0)
  expect(()=>cache.set(4,a)).toThrow('slot')
})
