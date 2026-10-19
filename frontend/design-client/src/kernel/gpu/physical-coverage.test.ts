import { expect, test } from 'vitest'
import { physicalCoverage } from './physical-coverage'
test('a one-pixel hole cannot pass the full physical coverage gate',()=>{
  const rows=[{x:0,y:0,width:511,height:1024,native:true},{x:512,y:0,width:512,height:1024,native:true}]
  expect(physicalCoverage(rows,1024,1024)).toEqual({pixelCoverageComplete:false,nativeCoverageComplete:false})
  rows.push({x:511,y:0,width:1,height:1024,native:false})
  expect(physicalCoverage(rows,1024,1024)).toEqual({pixelCoverageComplete:true,nativeCoverageComplete:false})
  rows[2].native=true
  expect(physicalCoverage(rows,1024,1024)).toEqual({pixelCoverageComplete:true,nativeCoverageComplete:true})
})
test('transparent overlays cannot certify their coarse backdrop as native',()=>{
  expect(physicalCoverage([{x:0,y:0,width:100,height:100,native:false},
    {x:0,y:0,width:100,height:100,native:true,blend:true}],100,100).nativeCoverageComplete).toBe(false)
})
