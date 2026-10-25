import { expect,test } from 'vitest'
import { backgroundPaintRects,bindContentOwner,pageBackgroundProof,pageBackgroundSource } from './page-background'
import { physicalCoverageGaps } from './physical-coverage'
import type { GpuScene } from './types'

test('background certificates require private ownership, finite native bounds and a uniform output texel',()=>{
  const scene={view:{x:0,y:0,zoom:2},pagePaintRects:[[2,2,6,6]]} as GpuScene
  expect(pageBackgroundSource(scene)).toBeUndefined()
  bindContentOwner(scene,{})
  const source=pageBackgroundSource(scene)!
  expect(pageBackgroundProof(source,{x:0,y:0,w:8,h:8},8,8).pixel).toEqual([.5/8,.5/8])
  expect(pageBackgroundProof(source,{x:2,y:2,w:2,h:2},2,2).pixel).toBeUndefined()
  for(const field of ['transparent','checkerboard','grid','softwareRaster','resolve','presentation'])
    expect(pageBackgroundSource({...scene,[field]:true})).toBeUndefined()
  expect(pageBackgroundSource({...scene,pagePaintRects:[[0,0,Infinity,1]]})).toBeUndefined()
  const proof={...source,pixel:[.5/8,.5/8] as [number,number]}
  expect(backgroundPaintRects(proof,{x:2,y:-1,zoom:1},2,8,8)).toEqual([{x:6,y:0,width:2,height:4}])
  expect(backgroundPaintRects(proof,{x:2.1,y:0,zoom:1},2,8,8)).toEqual([{x:6,y:2,width:2,height:4}])
  expect(backgroundPaintRects(proof,{x:2,y:0,zoom:1.1},2,8,8)).toBeUndefined()
})

test('coverage gaps include single physical pixels, ignore blend overlays and clip outside rectangles',()=>{
  expect(physicalCoverageGaps([{x:-2,y:0,width:5,height:8},{x:4,y:0,width:8,height:8},{x:3,y:0,width:1,height:8,blend:true}],8,8))
    .toEqual([{x:3,y:0,width:1,height:8}])
  expect(physicalCoverageGaps([{x:0,y:0,width:8,height:4},{x:0,y:3,width:8,height:5}],8,8)).toEqual([])
})
