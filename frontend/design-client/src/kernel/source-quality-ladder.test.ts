import {expect,test} from 'vitest'
import {SourceQualityLadder} from './source-quality-ladder'
import {backingCoversSettledSource,coveredSourceDetail,improvesSourceZoom,retainedZoomOut,sourceTileBringsDetail,visibleSourceDensity} from './source-viewport-plan'
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
