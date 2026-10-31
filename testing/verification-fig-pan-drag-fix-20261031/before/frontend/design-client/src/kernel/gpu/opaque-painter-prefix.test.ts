import {expect,test} from 'vitest'
import {blank,node,paint,effect} from '../../model'
import {VectorEngine} from '../../generated/design-kernel/design_kernel'
import {decodeScenePacket} from './scene-packet'
import {opaquePainterStart} from './opaque-painter-prefix'
import type {GpuScene} from './types'
function fixture(){
 const doc=blank(),a=node('ellipse',-20,-20,100,100),b=node('rectangle',-40,-40,200,200)
 doc.schemaVersion=18
 a.effects=[effect('gaussian-blur')];a.effects[0].radius=12
 b.transform=[Math.cos(.01),Math.sin(.01),-Math.sin(.01),Math.cos(.01),-40,-40]
 b.fills=[paint('#ffffff','linear')]
 doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
 const engine=new VectorEngine();engine.load_document(JSON.stringify(doc))
 try{const scene=decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({pageId:doc.pages[0].id,width:32,height:32,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel',gpuViewport:{x:0,y:0,w:32,h:32},transparent:true,grid:false})))
  return {scene,ids:[a.id,b.id],region:scene.extent}
 }finally{engine.free()}
}
const proof={color:(_value:string)=>[.25,.5,.75,1],image:()=>false}
test('a full four-sample opaque gradient hides a finite isolated Gaussian prefix without changing the source scene',()=>{
 const f=fixture(),before=JSON.stringify(f.scene)
 expect(opaquePainterStart(f.scene,f.ids,f.region,proof)).toBe(1)
 expect(JSON.stringify(f.scene)).toBe(before)
})
test.each(['alpha','mask','clip','backdrop','blend','stroke','nan','hdr','negative-zero','partial','shared','unknown-image'] as const)('%s does not grant a painter overwrite proof',reason=>{
 const f=fixture(),nodes={...f.scene.nodes},a={...nodes[f.ids[0]]},b={...nodes[f.ids[1]]};nodes[a.id]=a;nodes[b.id]=b
 let scene:GpuScene={...f.scene,nodes},color=proof.color
 if(reason==='alpha')b.opacity=.5
 if(reason==='mask')a.mask=true
 if(reason==='clip')a.clip=true
 if(reason==='backdrop')a.effects=[{...a.effects[0],kind:'background-blur'}]
 if(reason==='blend')a.blend='multiply'
 if(reason==='stroke')a.strokes=[{path:a.fill,paint:{...a.fills[0],blend:'multiply'},align:'center'}]
 if(reason==='nan')color=()=>[NaN,0,0,1]
 if(reason==='hdr')color=()=>[2,0,0,1]
 if(reason==='negative-zero')color=()=>[-0,0,0,1]
 if(reason==='partial'){const curves=new Float32Array(scene.curves||[]);curves[b.fill.area!.first*4+5]=0;scene={...scene,curves}}
 if(reason==='shared'){const source=new Float32Array(scene.curves||[]),curves=new Float32Array(new SharedArrayBuffer(source.byteLength));curves.set(source);scene={...scene,curves:curves as unknown as Float32Array<ArrayBuffer>}}
 if(reason==='unknown-image'){a.effects=[];a.fills=[{...a.fills[0],kind:'image',image:'unavailable'}]}
 expect(opaquePainterStart(scene,f.ids,f.region,{...proof,color})).toBe(0)
})
test('a bounded image needs an independent upload witness before it may be hidden',()=>{
 const f=fixture(),a={...f.scene.nodes[f.ids[0]],effects:[]};a.fills=[{...a.fills[0],kind:'image',image:'image'}]
 const scene={...f.scene,nodes:{...f.scene.nodes,[a.id]:a}}
 expect(opaquePainterStart(scene,f.ids,f.region,proof)).toBe(0)
 expect(opaquePainterStart(scene,f.ids,f.region,{...proof,image:()=>true})).toBe(1)
})
test('an image Gaussian needs its own opt-in and an actual bounded upload before an opaque overwrite hides it',()=>{
 const f=fixture(),a={...f.scene.nodes[f.ids[0]]};a.fills=[{...a.fills[0],kind:'image',image:'image'}]
 const scene={...f.scene,nodes:{...f.scene.nodes,[a.id]:a}}
 expect(opaquePainterStart(scene,f.ids,f.region,{...proof,image:()=>true})).toBe(0)
 expect(opaquePainterStart(scene,f.ids,f.region,{...proof,imageFilters:true})).toBe(0)
 expect(opaquePainterStart(scene,f.ids,f.region,{...proof,imageFilters:true,image:()=>true})).toBe(1)
 for(const kind of ['background-blur','glass','motion-blur'] as const){
  const changed={...a,effects:[{...a.effects[0],kind}]}
  expect(opaquePainterStart({...scene,nodes:{...scene.nodes,[a.id]:changed}},f.ids,f.region,
    {...proof,imageFilters:true,image:()=>true})).toBe(0)
 }
})
test('normal bounded strokes retain the same finite prefix proof without granting opaque coverage themselves',()=>{
 const f=fixture(),a={...f.scene.nodes[f.ids[0]]}
 a.strokes=[{path:a.fill,paint:a.fills[0],align:'center'}]
 expect(opaquePainterStart({...f.scene,nodes:{...f.scene.nodes,[a.id]:a}},f.ids,f.region,proof)).toBe(1)
 const b={...f.scene.nodes[f.ids[1]],strokes:a.strokes}
 expect(opaquePainterStart({...f.scene,nodes:{...f.scene.nodes,[a.id]:a,[b.id]:b}},f.ids,f.region,proof)).toBe(0)
})
