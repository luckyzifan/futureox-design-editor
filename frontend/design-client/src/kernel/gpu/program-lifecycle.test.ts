import {expect,test,vi} from 'vitest'
import {WebGpuDriver} from './webgpu'
import {ResidentPrograms} from './resident-programs'

test('GPU arena growth copies before destruction and survives shrink, reset and legacy packets',()=>{
  const usage={STORAGE:128,COPY_SRC:4,COPY_DST:8,VERTEX:32}
  vi.stubGlobal('GPUBufferUsage',usage)
  // Buffer lifecycle unit: no canvas context or pixel result is simulated.
  vi.stubGlobal('OffscreenCanvas',class { constructor(readonly width:number,readonly height:number){} })
  type Buffer={size:number;usage:number;data:Uint8Array;destroyed:boolean;destroy():void}
  let copies=0
  const device={
    createBuffer({size,usage}:{size:number;usage:number}):Buffer{return {size,usage,data:new Uint8Array(size),destroyed:false,destroy(){this.destroyed=true}}},
    createCommandEncoder(){const commands:(()=>void)[]=[];return {
      copyBufferToBuffer(a:Buffer,from:number,b:Buffer,to:number,bytes:number){
        expect(a.usage&usage.COPY_SRC).not.toBe(0);expect(b.usage&usage.COPY_DST).not.toBe(0)
        commands.push(()=>{expect(a.destroyed||b.destroyed).toBe(false);b.data.set(a.data.subarray(from,from+bytes),to);copies++})
      },finish(){return commands}}},
    queue:{submit(commands:(()=>void)[][]){for(const list of commands)for(const c of list)c()},
      writeBuffer(buffer:Buffer,offset:number,words:Uint32Array){expect(buffer.destroyed).toBe(false);expect(buffer.usage&usage.COPY_DST).not.toBe(0);buffer.data.set(new Uint8Array(words.buffer,words.byteOffset,words.byteLength),offset)}},
    pushErrorScope(){},
  }
  try {
    const driver=Object.assign(new WebGpuDriver(true),{device,programArena:new ResidentPrograms(32768,64),areaPipeline:{}}) as any
    const fixed=Float32Array.from({length:4096},(_,i)=>i+.25)
    const verify=(frame:number,legacy=false)=>{
      const source=new Float32Array(8192);source.set(fixed);source.set(Float32Array.from({length:4096},(_,i)=>frame*4096+i+.5),4096)
      const paths=[{first:0,count:1024,fingerprint:[1,0]},{first:1024,count:1024,fingerprint:[frame+2,0]}]
      driver.scenePrograms=legacy?undefined:paths;driver.begin(new Float32Array(0),source)
      const actual=new Uint32Array(driver.curves.data.buffer),expected=new Uint32Array(source.buffer)
      for(const path of paths){const at=legacy?path.first:driver.programOffsets.get(path.first);expect(actual.subarray(at*4,at*4+4096)).toEqual(expected.subarray(path.first*4,path.first*4+4096))}
    }
    for(let i=0;i<14;i++)verify(i)
    expect(copies).toBeGreaterThan(0)
    driver.curveShrink={frames:60,maxDemand:16};driver.shrinkCapacities();verify(14)
    verify(15,true);verify(16)
  } finally {vi.unstubAllGlobals()}
})
