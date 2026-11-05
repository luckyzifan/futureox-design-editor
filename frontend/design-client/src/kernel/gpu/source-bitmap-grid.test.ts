import {describe,it,expect} from 'vitest'
import {compactSourceAxes} from './source-bitmap-grid'
describe('file-backed image grid',()=>{
 it('preserves fractions and contain margins, mapping repeated and last texels to the same samples',()=>{
 const axes=new Float32Array([4,.125,1,-1,4,.75,1,-1,9,.5,1,-1,2,.25,1,-1,0,0,0,-1,0,0,0,0])
 const result=compactSourceAxes(axes,{x:70,y:-23,w:3,h:2},10,8)!
 expect(result).toEqual({xs:[4,5,9,9],ys:[2,3]});expect([axes[0],axes[4],axes[8]]).toEqual([0,0,2]);expect([axes[1],axes[5],axes[9],axes[13],axes[18]]).toEqual([.125,.75,.5,.25,0])
 })
})
