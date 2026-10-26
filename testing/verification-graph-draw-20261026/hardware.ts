import {initializeKernelModule} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/kernel/module.ts'
import {VectorEngine} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/generated/design-kernel/design_kernel.js'
import {WebGpuDriver} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/kernel/gpu/webgpu.ts'
import {createGpu} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/kernel/gpu/factory.ts'
import {decodeScenePacket} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/kernel/gpu/scene-packet.ts'
import {parameters} from '/@fs/Users/Apple/.codex/worktrees/graph-draw-reduction/design-kernel/frontend/design-client/src/kernel/gpu/types.ts'
const report:any={status:'running',scope:'actual hardware target RGBA32F word comparison, not GUI or physical scanout',cases:[]}
const publish=()=>{(window as any).__report=report;document.querySelector('#results')!.textContent=JSON.stringify(report)}
function compare(a:Float32Array,b:Float32Array){if(a.length!==b.length)throw Error('size');const x=new Uint32Array(a.buffer,a.byteOffset,a.length),y=new Uint32Array(b.buffer,b.byteOffset,b.length);let different=0;for(let i=0;i<x.length;i++)if(x[i]!==y[i])different++;return {words:x.length,different}}
try{
 await initializeKernelModule();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('No hardware adapter')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};publish()
 const color={documentSpace:'srgb' as const,referenceWhiteNits:203,peakLuminanceNits:1000},engine=new VectorEngine()
 const doc:any={schemaVersion:3,id:'d',name:'d',colorManagement:color,pages:[{id:'p',name:'p',background:'#ffffff',children:['a']}],nodes:{a:{id:'a',kind:'rectangle',width:8,height:7,fills:[{kind:'solid',color:'#123456'}]}}}
 engine.load_document(JSON.stringify(doc));const scene=decodeScenePacket(engine.compile_gpu_packet(JSON.stringify({pageId:'p',width:8,height:7,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'})))
 const driver:any=await WebGpuDriver.create(true,false,true,true,false)
 try{
  await driver.prepareScene(scene);driver.begin(new Float32Array())
  const width=8,height=7,origin={x:-128,y:1024,w:width,h:height}
  for(const layout of [{x:1,y:1,w:3,h:3},{x:5,y:4,w:3,h:3},{x:7,y:6,w:1,h:1}])for(const mode of [3,47])for(let special=-1;special<10;special++){
    const values=Float32Array.from({length:width*height*4},(_,i)=>i%4===3?.75:Math.fround(((i*17)%31-15)/3)),bits=new Uint32Array(values.buffer)
    bits[0]=0x80000000;bits[1]=1;bits[2]=0x7f000000
    if(special>=0){const k=special===9?4:special,at=((layout.y+Math.floor(k/3))%height*width+(layout.x+k%3)%width)*4;bits[at]=0x7fc00011+k;bits[at+1]=0xff800000;bits[at+2]=0x80000000;if(special===9){bits[at-4]=0xffc00077;bits[at+4]=0x7fc00033}}
    const foreground=Float32Array.from({length:values.length},(_,i)=>i%4===3?.5:Math.fround((i%9-3)*.25))
    const textures:any[]=[]
    const upload=(data:Float32Array,w=width,h=height)=>{const t=driver.create(w,h);textures.push(t);driver.device.queue.writeTexture({texture:t.resource},data,{bytesPerRow:w*16},[w,h]);return t}
    const background=upload(values),front=upload(foreground),mask=upload(new Float32Array(values.length).fill(.75)),outputs:Float32Array[]=[]
    const logical={x:origin.x+layout.x,y:origin.y+layout.y,w:layout.w,h:layout.h}
    for(const candidate of [false,true]){
      const w=candidate?Math.min(layout.w+1,width-layout.x):layout.w,h=candidate?Math.min(layout.h+1,height-layout.y):layout.h
      const before=driver.create(w,h);textures.push(before)
      if(candidate){if(!driver.copyBackdropRegion(before,background,{x:layout.x,y:layout.y,w,h},logical))throw Error('raw snapshot not exercised')}
      else{const u=parameters(logical,origin);u[16]=0;driver.pass(before,u,[background])}
      const output=upload(values),u=mode===3?parameters(origin,origin,logical,origin):parameters(origin,logical,origin,origin)
      u.set([mode,0,1,1],16)
      if(mode===47){u.set([0,.25,-2,8],28);u[32]=.6;u[241]=.7;u.set([origin.x,origin.y,width,height],52)}
      driver.pass(output,u,mode===3?[front,before,mask]:[before,mask,mask],{...layout})
      outputs.push(await driver.readSurface(output))
    }
    const diff=compare(outputs[0],outputs[1]);report.cases.push({kind:'primitive',mode,layout,special,...diff});publish()
    if(diff.different)throw Error('Copied backdrop changed exact words')
    for(const texture of textures)driver.destroy(texture)
  }
 }finally{driver.dispose();engine.free()}
 // Production renderer path with all four phases, gradients, strokes, group
 // opacity, clipping and effects. The old sampler remains a cold reference.
 for(const phase of [0,.125,.5]){
  const nodes:any={group:{id:'group',kind:'group',width:128,height:96,opacity:.8,children:[]}}
  for(let i=0;i<32;i++){const id='n'+i;nodes.group.children.push(id);nodes[id]={id,kind:i%2?'ellipse':'rectangle',width:18,height:15,
    transform:[1,0,0,1,3+(i%8)*13,4+Math.floor(i/8)*19],fills:[i%3?{kind:'solid',color:'#3366cc',opacity:.7}:{kind:'linear',color:'#000000',stops:[{offset:0,color:'#ee22aa'},{offset:1,color:'#113366'}]}],
    strokes:i%4?[]:[{paint:{kind:'solid',color:'#aa5500'},width:1.25,align:'center'}],effects:i===7?[{kind:'shadow',radius:2,x:1.25,y:.5,color:'#112233',opacity:.6}]:[]}}
  const e=new VectorEngine();e.load_document(JSON.stringify({...doc,nodes,pages:[{...doc.pages[0],children:['group']}]}))
  const scene=decodeScenePacket(e.compile_gpu_packet(JSON.stringify({pageId:'p',width:128,height:96,view:{x:phase,y:-phase,zoom:1},rasterProfile:'figmaSubpixel'}))),results:Float32Array[]=[],draws:number[]=[]
  for(const enabled of [false,true]){
    const renderer:any=await createGpu('webgpu',true,false,color,undefined,false,true)
    renderer.driver.copiedBackdropEnabled=enabled
    try{const result=await renderer.render(scene,true,false);results.push(result.linear);draws.push(result.drawCalls)}finally{renderer.dispose()}
  }
  e.free();const diff=compare(results[0],results[1]);report.cases.push({kind:'production-four-phase',phase,draws,...diff});publish()
  if(diff.different||draws[1]>=draws[0])throw Error('Production pixels changed or optimization missed')
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}publish()
