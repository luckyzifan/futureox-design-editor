import {expect,test} from 'vitest'
import {SourceQualityLadder} from './source-quality-ladder'
import {improvesSourceZoom,sourceTileBringsDetail,visibleSourceDensity} from './source-viewport-plan'
import type {ResidentAcknowledgement} from './resident-presentation'
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
