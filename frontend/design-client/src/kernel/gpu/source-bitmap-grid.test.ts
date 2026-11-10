import {describe,it,expect,vi,afterEach} from 'vitest'
import {compactSourceAxes,hostedDenseByteFrame,noteHostedStraightImage,readDenseSourceGrid,readDenseSourceGridBytes,sampleHostedByteImage,straightImageUploadRows} from './source-bitmap-grid'
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
 expect(Array.from(c)).toEqual(Array.from(a))
 expect(c[0]).toBe(-2);expect(c[6]).toBeCloseTo(.125,5);expect(c[7]).toBeCloseTo(.875,5)
 expect(new Uint32Array(decoded.buffer)).toEqual(new Uint32Array(original.buffer))
 expect(bytes.byteLength*4).toBe(original.byteLength)
 const width=b.w*2,at=4,ix=c[at],iy=c[at+1]
 const byteSpace=sampleHostedByteImage(bytes,width,b.h*2,ix+c[at+2],iy+c[at+3])
 const corner=(iy*width+ix)*4
 let nonlinear=false
 for(let i=0;i<bytes.length;i+=4){
  if(!bytes[i+3])continue
  if(Math.abs(bytes[i]/255-lut[bytes[i]])>1e-4){nonlinear=true;break}
 }
 expect(nonlinear).toBe(true)
 expect(byteSpace.some((v,i)=>Math.abs(v-decoded[corner+i])>1e-3)).toBe(true)
})
it('exact frames stay off the straight grid and image paint does not enable byte-space sampling',()=>{
 expect(hostedDenseByteFrame({present:true,readback:false})).toBe(true)
 for(const frame of [
  {present:true,readback:true},{present:false,readback:false},
  {present:true,readback:false,resolve:true},{present:true,readback:false,presentation:true},
  {present:true,readback:false,softwareRaster:true},
 ])expect(hostedDenseByteFrame(frame)).toBe(false)
 const u=new Float32Array(256);u[16]=2;u[28]=3;u[187]=0
 noteHostedStraightImage(u,true,false,false)
 expect([u[187],u[206],u[207]]).toEqual([0,0,1])
 noteHostedStraightImage(u,true,true,false)
 expect([u[187],u[206],u[207]]).toEqual([0,1,1])
 u[16]=22;u[207]=7
 noteHostedStraightImage(u,false,true,true)
 expect(u[207]).toBe(7)
})
it('straight uploads pad only the WebGPU row stride and keep every logical texel',()=>{
 const aligned=new Uint8Array(256*2*4);aligned[4]=9;aligned[256*4+7]=3
 const same=straightImageUploadRows(aligned,256,2)
 expect(same.bytesPerRow).toBe(1024);expect(same.bytes).toBe(aligned)
 const width=272,height=3,bytes=new Uint8Array(width*height*4)
 bytes[0]=11;bytes[width*4-1]=22;bytes[(height-1)*width*4+5]=33
 const padded=straightImageUploadRows(bytes,width,height)
 expect(padded.bytesPerRow).toBe(1280);expect(padded.bytesPerRow%256).toBe(0)
 expect(padded.bytes).not.toBe(bytes);expect(padded.bytes.length).toBe(1280*height)
 expect(padded.bytes[0]).toBe(11);expect(padded.bytes[width*4-1]).toBe(22);expect(padded.bytes[1280*2+5]).toBe(33)
 expect(padded.bytes[width*4]).toBe(0)
 expect(()=>straightImageUploadRows(bytes,width,height-1)).toThrow('Invalid straight sRGB source')
})
it.each(['cell','short','status'])('dense byte transport rejects %s without returning partial pixels',kind=>{
 vi.stubGlobal('XMLHttpRequest',class{status=kind==='status'?500:200;responseType='';response=new ArrayBuffer(kind==='short'?4:16);open(){}send(){}})
 const field=new Float32Array([kind==='cell'?100:0,0,.5,.5])
 expect(()=>readDenseSourceGridBytes('source?x=1',field,{x:0,y:0,w:1,h:1},2,2)).toThrow()
})
