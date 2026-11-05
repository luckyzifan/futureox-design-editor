import {expect,test} from 'vitest'
import {copySourceWindow,linearSrgbWindow,magnifiedImageWindow,sourceImageWindow} from './source-image-window'
test('a sampling window includes every bilinear neighbour and preserves oriented premultiplied float words',()=>{
 const rect={x:-9,y:5,w:4,h:3},axes=new Float32Array(32)
 for(let i=0;i<4;i++)axes.set([254+i,.375,1,-1],4*i)
 for(let i=0;i<3;i++)axes.set([510+i,.125,1,-1],16+4*i)
 const win=sourceImageWindow(axes,rect,2048,1536)!
 expect(win).toEqual({x:0,y:256,w:512,h:512})
 const image={width:7,height:5,pixels:Float32Array.from({length:140},(_,i)=>i-.25)}
 const w={x:2,y:1,w:3,h:2},cut=copySourceWindow(image,w)
 const rows=function*(){for(let i=0;i<5;i++)yield {y:i,height:1,pixels:image.pixels.subarray(28*i,28*(i+1))}}
 expect([...cut]).toEqual([...image.pixels.slice(36,48),...image.pixels.slice(64,76)])
 expect(copySourceWindow({...image,linearRows:rows},w)).toEqual(cut)
 axes[0]=NaN;expect(sourceImageWindow(axes,rect,2048,1536)).toBeUndefined()
})

test('magnified bilinear windows include the neighbours of all four native phases',()=>{
 const size=64,target={x:70000,y:70000,w:size,h:size}
 const planes=[0,1,2,3].map(phase=>{
   const field=new Float32Array(size*8)
   for(let axis=0;axis<2;axis++)for(let i=0;i<size;i++){
     const base=axis===0?-1:29
     field.set([base+phase,.25,1,-1],(axis*size+i)*4)
   }
   return field
 })
 expect(magnifiedImageWindow(planes,target,40,32)).toBeUndefined()
 // The last valid y cell is 31. Its out-of-image neighbour must stay transparent.
 planes[3].forEach((_,i,a)=>{if(i>=4*size && i%4===0)a[i]=31})
 expect(magnifiedImageWindow(planes,target,40,32)).toEqual({x:0,y:29,w:4,h:3})
 expect(magnifiedImageWindow(planes.slice(1),target,40,32)).toBeUndefined()
})

test('straight texel crop uses both transfer rows and preserves transparent edges',()=>{
 const bytes=Uint8Array.of(9,8,7,255, 30,31,32,0, 29,73,254,128,
                            1,2,3,255, 0,127,255,255, 255,0,33,1)
 const lut=Float32Array.from({length:512},(_,i)=>i<256?(i/255)**2:(i-256)/255)
 const pixels=linearSrgbWindow(bytes,3,2,{x:1,y:0,w:2,h:2},lut)
 expect(pixels).toEqual(Float32Array.of(0,0,0,0,lut[29]*lut[384],lut[73]*lut[384],lut[254]*lut[384],lut[384],
   lut[0],lut[127],lut[255],1,lut[255]*lut[257],0,lut[33]*lut[257],lut[257]))
 expect(linearSrgbWindow(bytes,3,2,{x:1,y:0,w:1,h:1},lut)).toBeNull()
 expect(()=>linearSrgbWindow(bytes,3,2,{x:2,y:0,w:2,h:1},lut)).toThrow()
})
