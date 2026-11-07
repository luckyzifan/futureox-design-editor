import {describe,expect,test} from 'vitest'
import {SourceQualityLadder} from './source-quality-ladder'
import {backingCoversSettledSource,coveredSourceDetail,improvesSourceZoom,retainedZoomOut,retainedSourceReturn,sourceTileBringsDetail,visibleSourceDensity} from './source-viewport-plan'
import type {ResidentAcknowledgement} from './resident-presentation'
test('settled source priority requires full acknowledged coverage at the current device density',()=>{
 const backing={view:{x:0,y:0,zoom:4},width:100,height:80,dpr:2,ids:[1],interaction:false} as ResidentAcknowledgement
 const target={width:100,height:80,view:{x:-20,y:-16,zoom:16}}
 expect(backingCoversSettledSource(backing,target,2)).toBe(true)
 expect(backingCoversSettledSource({...backing,preview:true},target,2)).toBe(false)
 expect(backingCoversSettledSource({...backing,previewGaps:[{x:0,y:0,width:1,height:1}]},target,2)).toBe(false)
 expect(backingCoversSettledSource(backing,target,1)).toBe(false)
 expect(backingCoversSettledSource(backing,{...target,view:{...target.view,x:1}},2)).toBe(false)
 expect(backingCoversSettledSource(backing,{...target,width:101},2)).toBe(false)
})
test('fallback resolution advances on covered presentations and bounds retries at a failed camera',()=>{
 const q=new SourceQualityLadder()
 expect(q.rejected(64,'GPU surface budget exceeded')).toBe(true)
 expect(q.scale).toBe(32);expect(q.presented(16)).toBe(false)
 expect(q.presented(32)).toBe(true);expect(q.scale).toBeGreaterThan(32)
 for(let i=0;i<6&&!q.limited;i++)q.rejected(q.scale!,'WebGPU 纹理尺寸超限')
 expect(q.limited).toBe(true);expect(q.scale).toBe(32)
 q.reset();expect(q.scale).toBeUndefined();expect(q.rejected(64,'Invalid resource owner')).toBe(false)
})
test('a finer in-flight tile may replace a projection only with real surviving coverage',()=>{
 const tile={key:'detail',x:-1,y:-1,width:18,height:18,gutter:1,zoom:2,gpuTile:12}
 const old={...tile,key:'old',zoom:1,gpuTile:8}
 const ack=(zoom:number,ids:number[]):ResidentAcknowledgement=>({width:8,height:8,dpr:1,view:{x:0,y:0,zoom},ids,interaction:false})
 const a=ack(1,[8]),b=ack(2,[8,12]),target={view:b.view,width:8,height:8}
 expect(improvesSourceZoom(a,b,target,[old,tile])).toBe(true)
 expect(improvesSourceZoom(a,{...b,ids:[12]},target,[old,tile])).toBe(true)
 const narrow={...tile,width:4}
 expect(improvesSourceZoom(a,{...b,ids:[12]},target,[old,narrow])).toBe(false)
 expect(improvesSourceZoom(a,b,{...target,view:{x:0,y:0,zoom:2.3}},[old,tile])).toBe(true)
 expect(improvesSourceZoom(a,b,{...target,view:{x:12,y:0,zoom:2.3}},[old,tile])).toBe(false)
 expect(improvesSourceZoom(a,{...b,preview:true},target,[old,tile])).toBe(false)
 const projected=ack(4,[8]),zoomed=ack(5,[8,12])
 expect(improvesSourceZoom(projected,zoomed,{...target,view:zoomed.view},[old,tile],[old])).toBe(true)
 expect(improvesSourceZoom(projected,zoomed,{...target,view:zoomed.view},[old,{...tile,zoom:old.zoom}],[old])).toBe(false)
 expect(sourceTileBringsDetail(tile,b.view,target,[old])).toBe(true)
 expect(sourceTileBringsDetail(tile,b.view,target,[tile])).toBe(false)
})

test('geometry from the displayed frame remains sufficient after GPU cache eviction',()=>{
 const camera=(zoom:number,ids:number[]):ResidentAcknowledgement=>({view:{x:0,y:0,zoom},width:8,height:8,dpr:1,ids,interaction:false})
 const old={key:'old',gpuTile:1,x:-1,y:-1,width:10,height:10,zoom:1}
 const outside={...old,key:'outside',gpuTile:2,x:90}
 const left={...old,key:'left',gpuTile:3,width:6,zoom:2}
 const right={...left,key:'right',x:3}
 const a=camera(1,[1,2]),b=camera(2,[3]),target={view:b.view,width:8,height:8}
 expect(improvesSourceZoom(a,b,target,[left,right],[old,outside])).toBe(true)
 expect(improvesSourceZoom(a,b,target,[left],[old,outside])).toBe(false)
 expect(visibleSourceDensity([old,{...left,zoom:8}],a.view,target,{x:0,y:0,width:8,height:8})).toBe(1)
})

test('an intermediate wheel mosaic must cover the viewport and add detail without losing a sharper region',()=>{
 const view={x:0,y:0,zoom:2},target={view,width:8,height:8}
 const tile=(key:string,zoom:number,width:number,id:number)=>({key,x:-1,y:-1,width:width+2,height:8*zoom+2,gutter:1,zoom,gpuTile:id,used:id})
 const coarse=tile('base',1,4,1),detail=tile('focus',2,4,2),gap=tile('partial',1,2,3)
 expect(coveredSourceDetail([detail],target,[coarse])).toBeUndefined()
 expect(coveredSourceDetail([gap,detail],target,[coarse])).toBeUndefined()
 expect(coveredSourceDetail([coarse],target,[coarse])).toBeUndefined()
 expect(coveredSourceDetail([detail,coarse],target,[coarse])).toEqual([coarse,detail])
 const right={...detail,key:'right',gpuTile:4,x:3}
 expect(coveredSourceDetail([coarse,right,detail],target,[coarse])).toEqual([right,detail])
 const old={presentationId:'x:1',view,width:8,height:8,dpr:1,interaction:false,ids:[1]}
 const next={...old,presentationId:'x:2',ids:[1,2]}
 expect(improvesSourceZoom(old,next,target,[coarse,detail],[coarse])).toBe(true)
 expect(improvesSourceZoom(old,{...next,view:{...view,x:2}},target,[coarse,detail],[coarse])).toBe(false)
 expect(improvesSourceZoom(old,{...next,preview:true},target,[coarse,detail],[coarse])).toBe(false)
})

test('zooming out reuses only resident pixels covering the full viewport at device density',()=>{
 const view={x:0,y:0,zoom:1},size={width:8,height:4}
 const left={key:'left',x:-1,y:-1,width:10,height:10,gutter:1,zoom:2,used:3}
 const right={...left,key:'right',x:15,width:18,height:18,zoom:4,used:1}
 expect(retainedZoomOut([right,left],view,size,2)).toEqual([left,right])
 expect(retainedZoomOut([left],view,size,2)).toBeUndefined()
 expect(retainedZoomOut([left,{...right,x:16}],view,size,2)).toBeUndefined()
 expect(retainedZoomOut([left,right],view,size,3)).toBeUndefined()
 expect(retainedZoomOut([left,right],{...view,x:-1},size,2)).toBeUndefined()
})

test('a scroll roundtrip can show its retained viewport while remaining ineligible for native readiness',()=>{
 const view={x:0,y:0,zoom:1.0000001922},size={width:855,height:928}
 const tile={key:'return',x:-1,y:-1,width:2048,height:2048,gutter:1,zoom:2.000000041,used:1}
 expect(retainedSourceReturn([tile],view,size,2)).toEqual([tile])
 expect(retainedZoomOut([tile],view,size,2)).toBeUndefined()
 expect(retainedSourceReturn([{...tile,zoom:1.99}],view,size,2)).toBeUndefined()
 expect(retainedSourceReturn([{...tile,width:500}],view,size,2)).toBeUndefined()
 expect(retainedSourceReturn([tile],view,{...size,width:Infinity},2)).toBeUndefined()
})

test('a pan reuses a full-density mosaic only after its newly exposed edge is covered',()=>{
 const view={x:-2.25,y:0,zoom:1},size={width:8,height:4}
 const held={key:'held',x:-1,y:-1,width:18,height:10,gutter:1,zoom:2,used:1}
 const edge={...held,key:'edge',x:15,width:8,used:2}
 expect(retainedSourceReturn([held],view,size,2)).toBeUndefined()
 expect(retainedSourceReturn([held,edge],view,size,2)).toEqual([held,edge])
 expect(retainedSourceReturn([held,{...edge,x:15.25}],view,size,2)).toBeUndefined()
 expect(retainedSourceReturn([held,{...edge,zoom:1.5}],view,size,2)).toBeUndefined()
})

describe('proactive outward seed', () => {
  test('a successful proactive preview returns to native density without manufacturing a resource limit', () => {
    const ladder = new SourceQualityLadder()
    ladder.seed(1, 4)
    expect(ladder.presented(1)).toBe(true)
    expect(ladder.scale).toBeUndefined()
    expect(ladder.limited).toBe(false)
  })
  test('a quiet gesture drops a speculative floor but retains a real resource failure', () => {
    const ladder = new SourceQualityLadder()
    ladder.seed(0.6, 2.4)
    expect(ladder.scale).toBe(0.6)
    ladder.settle()
    expect(ladder.scale).toBeUndefined()
    ladder.seed(.6,2.4)
    ladder.rejected(.6,Error('GPU surface budget exceeded'))
    const reduced=ladder.scale
    ladder.settle()
    expect(ladder.scale).toBe(reduced)
    expect(ladder.reason).toContain('GPU surface budget exceeded')
  })
  test('a rejected seeded tier halves further instead of resetting to full', () => {
    const ladder = new SourceQualityLadder()
    ladder.seed(0.6, 2.4)
    expect(ladder.rejected(0.6, new Error('GPU surface budget exceeded'))).toBe(true)
    expect(ladder.scale!).toBeLessThan(0.6)
    expect(ladder.scale!).toBeGreaterThanOrEqual(0.001)
  })
  test('seeds above the original are ignored', () => {
    const ladder = new SourceQualityLadder()
    ladder.seed(3, 2)
    expect(ladder.scale).toBeUndefined()
  })
})
