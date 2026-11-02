import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { gradient_sampling_grid, gradient_sampling_grid_region } from '../../generated/design-kernel/design_kernel'
import { gradientWindowSource } from './gradient-window-source'

test('gradient window addressing leaves the generated arithmetic body intact',()=>{
 const source=readFileSync(new URL('../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl',import.meta.url),'utf8')
 const extra='\n if(u(47).x>0.5){address=vec2<i32>(floor(p-u(0).xy-u(47).yz));}'
 const patched=gradientWindowSource(source)
 expect(patched.replace(extra,'')).toBe(source)
 expect(()=>gradientWindowSource('unrecognized shader')).toThrow('contract changed')
})

test.each(['linear','radial','angular','diamond'])('%s window fields preserve every original native parameter word',kind=>{
 const original={x:-55,y:18,w:128,h:96},region={x:-22,y:38,w:45,h:33}
 const matrix=new Float64Array([1,.3,-.2,.8,8.125,-16.25]),size=new Float64Array([77,55])
 const paint=JSON.stringify({kind,color:'#000',angle:23,stops:[{offset:0,color:'#000'},{offset:.37,color:'#fff'},{offset:1,color:'#000'}]})
 expect(gradient_sampling_grid_region(JSON.stringify(original),JSON.stringify({...original,w:0,h:0}),matrix,size,paint,0)).toHaveLength(0)
 for(let sample=0;sample<4;sample++){
  const full=gradient_sampling_grid(JSON.stringify(original),matrix,size,paint,sample)
  const local=gradient_sampling_grid_region(JSON.stringify(original),JSON.stringify(region),matrix,size,paint,sample)
  const expected=new Float32Array(region.w*region.h*4)
  for(let y=0;y<region.h;y++){
   const at=((region.y-original.y+y)*original.w+region.x-original.x)*4
   expected.set(full.subarray(at,at+region.w*4),y*region.w*4)
  }
  expect(new Uint32Array(local.buffer,local.byteOffset,local.length)).toEqual(new Uint32Array(expected.buffer))
 }
})
