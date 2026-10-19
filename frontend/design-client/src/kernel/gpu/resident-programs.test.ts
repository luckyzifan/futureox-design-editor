import {expect,test} from 'vitest'
import {ResidentPrograms} from './resident-programs'
import type {PathMesh} from './types'
const area=(first:number,count:number,hash:number):NonNullable<PathMesh['area']>=>({first,count,fingerprint:[hash,0]})
test('program offsets survive packet repacking, camera variants, and exact hash collisions',()=>{
  const arena=new ResidentPrograms(4096),device=new Uint32Array(4096)
  const run=(words:number[],paths:NonNullable<PathMesh['area']>[])=>{
    const source=new Uint32Array(words),plan=arena.plan(new Float32Array(source.buffer),paths)!
    if(plan.upload)device.set(plan.upload.data,plan.upload.offset/4)
    for(const p of paths){const at=plan.offsets.get(p.first)!*4;expect(device.subarray(at,at+p.count*4)).toEqual(source.subarray(p.first*4,(p.first+p.count)*4))}
    return plan
  }
  const a=[0x80000000,0x7fc00001,3,4],b=[5,6,7,8],c=[9,10,11,12]
  expect(run([...a,...b],[area(0,1,7),area(1,1,7)]).hits).toBe(0)
  const next=run([...b,...c,...a],[area(0,1,7),area(1,1,8),area(2,1,7)])
  expect(next.hits).toBe(2);expect(next.upload?.data.byteLength).toBe(16)
  expect(next.offsets.get(0)).toBe(1);expect(next.offsets.get(2)).toBe(0)
  expect(run([...a,...b],[area(0,1,7),area(1,1,7)]).upload).toBeUndefined()
  arena.reset();expect(run(a,[area(0,1,7)]).hits).toBe(0)
})
test('capacity rollover fully replaces aliases and unsupported packets fall back',()=>{
  const arena=new ResidentPrograms(16,3),device=new Uint32Array(16)
  for(let i=0;i<30;i++){
    const source=Float32Array.from({length:12},(_,j)=>i*16+j),paths=[area(0,1,i),area(1,2,i+1)]
    const p=arena.plan(source,paths)!;if(p.upload)device.set(p.upload.data,p.upload.offset/4)
    expect(arena.bytes).toBeLessThanOrEqual(64)
    for(const path of paths){const first=p.offsets.get(path.first)!;expect(device.subarray(first*4,(first+path.count)*4)).toEqual(new Uint32Array(source.buffer,path.first*16,path.count*4))}
  }
  expect(arena.plan(new Float32Array(4),[{first:0,count:1}])).toBeUndefined()
  expect(arena.plan(new Float32Array(4),[area(1,1,2)])).toBeUndefined()
  expect(arena.plan(new Float32Array(20),[area(0,5,2)])).toBeUndefined()
})
