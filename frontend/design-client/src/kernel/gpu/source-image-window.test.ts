import {expect,test} from 'vitest'
import {copySourceWindow,sourceImageWindow} from './source-image-window'
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
