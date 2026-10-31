import {expect,test,vi} from 'vitest'
import {writeLinearImageRows} from './linear-image-rows'
import {WebGpuDriver} from './webgpu'
import {certifyExactImageRange} from './exact-image-x-table'
const row=(y:number,height=1)=>({y,height,pixels:new Float32Array(2*height*4).fill(.25)})
test('row upload preserves every f32 word and destination coordinate',()=>{
 const source=[row(0,2),row(2)],write=vi.fn()
 source[0].pixels[0]=-0;source[1].pixels[2]=1e-30
 writeLinearImageRows(2,3,source,write)
 expect(write.mock.calls).toEqual([[0,2,source[0].pixels],[2,1,source[1].pixels]])
 expect(Object.is(write.mock.calls[0][2][0],-0)).toBe(true)
})
test.each(['gap','overlap','early-end','overflow','nan','oversized-band'])("invalid %s stream rejects",kind=>{
 const source=[row(0),row(1)],write=vi.fn()
 if(kind==='gap')source[1].y=2
 if(kind==='overlap')source[1].y=0
 if(kind==='early-end')source.pop()
 if(kind==='overflow')source[1]=row(1,2)
 if(kind==='nan')source[1].pixels[0]=NaN
 if(kind==='oversized-band')source[1]=row(1,131073)
 expect(()=>writeLinearImageRows(2,2,source,write)).toThrow()
})
test.each(['success','decode-error','late-decode-error','write-error','incomplete'])("GPU %s releases stream and certifies only complete pixels",outcome=>{
 const texture:any={width:2,height:2,bytes:64,resource:{}}
 const freed=vi.fn(),driver:any={managed:true,createFormat:vi.fn(()=>texture),destroy:vi.fn(),uploadAtlasLinear:vi.fn(()=>{
  expect(texture.finitePixels).toBeUndefined()
  if(outcome==='write-error')throw Error('device rejected upload')
 }),imageRanges:new WeakMap(),displayImageUploads:new WeakMap()}
 function* source(){try{yield row(0);if(outcome==='decode-error')throw Error('corrupt image');if(outcome!=='incomplete')yield row(1);if(outcome==='late-decode-error')throw Error('late CRC failure')}finally{freed()}}
 const run=()=>WebGpuDriver.prototype.uploadLinearRows.call(driver,2,2,source())
 if(outcome==='success'){expect(run()).toBe(texture);expect(texture.finitePixels).toBe(true);expect(driver.imageRanges.get(texture).unitAlpha).toBe(true);expect(driver.destroy).not.toHaveBeenCalled()}
 else{expect(run).toThrow();expect(driver.destroy).toHaveBeenCalledWith(texture);expect(texture.finitePixels).toBeUndefined();expect(driver.imageRanges.get(texture)).toBeUndefined()}
 expect(freed).toHaveBeenCalledOnce()
})
test('bounded row ranges equal one complete scan, including zero-only bands and signed channels',()=>{
 const rows=[row(0),row(1),row(2)];rows[0].pixels.fill(0);rows[1].pixels.set([-1,0,1e-30,-0]);rows[2].pixels.set([1.5,.5,.25,1])
 const pixels=new Float32Array(rows.flatMap(r=>[...r.pixels])),write=vi.fn()
 expect(writeLinearImageRows(2,3,rows,write,true)).toEqual(certifyExactImageRange(pixels))
 expect(write).toHaveBeenCalledTimes(3)
})
test('bad dimensions are rejected before allocating a GPU resource',()=>{
 const driver:any={managed:true,createFormat:vi.fn()}
 expect(()=>WebGpuDriver.prototype.uploadLinearRows.call(driver,8193,1,[])).toThrow()
 expect(driver.createFormat).not.toHaveBeenCalled()
})
