import { initializePicking } from '../../frontend/design-client/src/kernel/picking'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { blank,node,paint,effect } from '../../frontend/design-client/src/model'
import { defaultColorSettings } from '../../frontend/design-client/src/color'
import { createGpu } from '../../frontend/design-client/src/kernel/gpu/factory'
import { decodeScenePacket } from '../../frontend/design-client/src/kernel/gpu/scene-packet'
import { bindContentOwner } from '../../frontend/design-client/src/kernel/gpu/page-background'
import { renderRuntimeEvidence } from '../../frontend/design-client/src/kernel/runtime-evidence'
const report:any={status:'running',scope:'hardware background extension: existing compositor content must stay byte-exact; previously uncovered pixels must match complete native rerender. Full fresh-frame difference recorded separately; not timing/scanout.',cases:[]}
const publish=()=>{(window as any).__backgroundReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error})}
const compare=(a:Uint8ClampedArray,b:Uint8ClampedArray)=>{if(a.length!==b.length)throw Error('Extent mismatch');let differences=0;for(let i=0;i<a.length;i++)differences+=Number(a[i]!==b[i]);return differences}
try{
  await initializePicking();report.runtime=await renderRuntimeEvidence()
  const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
  report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,fallback:adapter.info.isFallbackAdapter}
  for(const profile of ['analytic','figmaSubpixel'] as const)for(const managed of [false,true]){
    const doc=blank(),shape=node('rectangle',38.125,40.25,26.5,22.75),child=node('ellipse',3,4,12,10)
    shape.kind='frame';shape.clip=false;shape.children=[child.id];shape.fills=[paint('#ea4080')];shape.effects=[{...effect('shadow'),radius:2.5,x:3,y:2}]
    const outside=node('rectangle',-80,80,20,20);outside.fills=[paint('#ffcc33')]
    child.fills=[paint('#38b7a4')];doc.nodes[shape.id]=shape;doc.nodes[child.id]=child;doc.nodes[outside.id]=outside;doc.pages[0].children=[shape.id,outside.id];doc.pages[0].background='#274b6e'
    if(managed){doc.schemaVersion=3;doc.rasterProfile='figma';doc.colorManagement=defaultColorSettings()}
    const kernel=new VectorEngine(),owner={};kernel.load_document(JSON.stringify(doc))
    const gpu=await createGpu('webgpu',true,true,doc.colorManagement,undefined,false,!!doc.colorManagement||profile==='analytic')
    const events:any[]=[],width=128,height=128,driver=gpu.driver
    driver.captureDisplay=true;driver.attachPresenter!(new OffscreenCanvas(width,height),event=>events.push(event))
    const capture=async(x:number,y:number)=>{
      const scene=decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({pageId:doc.pages[0].id,width,height,
        view:{x,y,zoom:1},transparent:false,grid:false,rasterProfile:profile,gpuPageBackground:true})))
      bindContentOwner(scene,owner)
      if(!scene.pagePaintRects?.length)throw Error('Missing native page support')
      const result=await gpu.render(scene,false,true);if(!result.gpuTile)throw Error('Missing native resident capture')
      return {id:result.gpuTile,scene}
    }
    const show=(id:number,x=0,y=0,background=false,allowEmpty=false)=>driver.presentFrame!({view:{x,y,zoom:1},width,height,dpr:1,allowBackground:background,allowEmpty,
      items:[{active:true,gutter:0,layer:0,tile:{gpuTile:id,serial:id,key:String(id),x:0,y:0,width,height,zoom:1}}]})
    const read=async()=>{const {bitmap}=await driver.captureContentBitmap!();try{const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d')!;context.drawImage(bitmap,0,0);return context.getImageData(0,0,width,height).data}finally{bitmap.close()}}
    try{
      const first=await capture(0,0);show(first.id)
      for(const [x,y] of [[12,8],[-16,-10],[18,-8],[3+1e-13,2-1e-13]]){
        // Explicit old clear/reproject control: only this diagnostic admits an
        // incomplete target. Product admission remains complete-coverage only.
        show(first.id,x,y,false,true);const existing=await read()
        show(first.id,x,y,true);const candidate=await read(),extended=events.at(-1)?.backgroundCoverage===1
        const exact=await capture(x,y);show(exact.id);const reference=await read()
        const oracle=reference.slice();let contentPixels=0,backgroundPixels=0
        for(let i=0;i<oracle.length;i+=4){if(existing[i+3]===255){oracle.set(existing.subarray(i,i+4),i);contentPixels++}else if(existing[i+3]===0)backgroundPixels++;else throw Error('Unexpected partially covered control pixel')}
        const differences=compare(candidate,oracle),freshFrameDifferences=compare(candidate,reference),alphaMinimum=Math.min(...candidate.filter((_v,i)=>i%4===3))
        report.cases.push({profile,managed,x,y,extended,differences,freshFrameDifferences,contentPixels,backgroundPixels,alphaMinimum,bytes:candidate.length})
        if(!extended||differences||alphaMinimum!==255)throw Error('Background extension changed content or filled gaps incorrectly')
        if(Number.isInteger(x)&&Number.isInteger(y)&&freshFrameDifferences)throw Error('Integer pan changed exact fresh-frame pixels')
        driver.releasePresented!([exact.id])
      }
      show(first.id);const before=await read(),submits=events.filter(e=>e.presented).length
      show(first.id,88,0,true)
      if(events.filter(e=>e.presented).length!==submits||compare(before,await read()))throw Error('Unseen paint replaced complete frame')
      report.cases.push({profile,managed,unseenPaintDeferred:true})
      driver.releasePresented!([first.id])
    }finally{gpu.dispose();kernel.free()}
  }
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
publish()
