import {describe,it,expect,vi,afterEach} from 'vitest'
import {compactSourceAxes,readDenseSourceGrid,readDenseSourceGridBytes} from './source-bitmap-grid'
import {straight_srgb8_table} from '../../generated/design-kernel/design_kernel'
afterEach(()=>vi.unstubAllGlobals())
describe('file-backed image grid',()=>{
 it('preserves fractions and contain margins, mapping repeated and last texels to the same samples',()=>{
 const axes=new Float32Array([4,.125,1,-1,4,.75,1,-1,9,.5,1,-1,2,.25,1,-1,0,0,0,-1,0,0,0,0])
 const result=compactSourceAxes(axes,{x:70,y:-23,w:3,h:2},10,8)!
 expect(result).toEqual({xs:[4,5,9,9],ys:[2,3]});expect([axes[0],axes[4],axes[8]]).toEqual([0,0,2]);expect([axes[1],axes[5],axes[9],axes[13],axes[18]]).toEqual([.125,.75,.5,.25,0])
 })
})

it('dense byte transport preserves all original cells, f32 fractions and linearized texels across response bands',()=>{
 const b={x:0,y:0,w:300,h:60},iw=1200,ih=900,requests:Uint32Array[]=[]
 vi.stubGlobal('XMLHttpRequest',class{
  status=200;responseType='';response:ArrayBuffer=new ArrayBuffer(0)
  open(method:string,url:string,sync:boolean){expect(method).toBe('POST');expect(url).toContain('&pairs=1');expect(sync).toBe(false)}
  send(payload:Uint32Array){requests.push(payload.slice());const w=payload[0],h=payload[1],raw=new Uint8Array(w*h*16)
   for(let i=0;i<raw.length;i++)raw[i]=(i+payload[3]*17)%256
   this.response=raw.buffer
  }
 })
 const source=new Float32Array(b.w*b.h*4)
 for(let i=0;i<b.w*b.h;i++)source.set([i%iw,Math.floor(i/iw),.125,.875],i*4)
 source.set([-2,-2,0,0],0)
 const a=source.slice(),c=source.slice(),rawTable=straight_srgb8_table(),lut=new Float32Array(rawTable.buffer,rawTable.byteOffset,512)
 const original=readDenseSourceGrid('source?x=1',a,b,iw,ih,lut),originalRequests=requests.splice(0)
 const bytes=readDenseSourceGridBytes('source?x=1',c,b,iw,ih),decoded=new Float32Array(bytes.length)
 for(let i=0;i<bytes.length;i+=4){const alpha=lut[256+bytes[i+3]];decoded[i]=lut[bytes[i]]*alpha;decoded[i+1]=lut[bytes[i+1]]*alpha;decoded[i+2]=lut[bytes[i+2]]*alpha;decoded[i+3]=alpha}
 expect(requests).toEqual(originalRequests);expect(requests.length).toBeGreaterThan(1)
 expect(c[0]).toBe(-2);expect(c[2]).toBe(0)
 const sample=4
 expect(c[sample]).toBeCloseTo(a[sample]+.125,5)
 expect(c[sample+1]).toBeCloseTo(a[sample+1]+.875,5)
 expect(c[sample+2]).toBe(1);expect(c[sample+3]).toBe(0)
 expect(new Uint32Array(decoded.buffer)).toEqual(new Uint32Array(original.buffer))
 expect(bytes.byteLength*4).toBe(original.byteLength)
})
it.each(['cell','short','status'])('dense byte transport rejects %s without returning partial pixels',kind=>{
 vi.stubGlobal('XMLHttpRequest',class{status=kind==='status'?500:200;responseType='';response=new ArrayBuffer(kind==='short'?4:16);open(){}send(){}})
 const field=new Float32Array([kind==='cell'?100:0,0,.5,.5])
 expect(()=>readDenseSourceGridBytes('source?x=1',field,{x:0,y:0,w:1,h:1},2,2)).toThrow()
})
