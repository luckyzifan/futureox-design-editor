import { blank,node,paint } from '../../model'
import { KernelClient, type TileResult } from '../client'
import type { ResidentFrame } from './resident-presenter'
import { residentFrameMessage } from './resident-frame'
const report:{status:string;checks:unknown[];error?:string}={status:'running',checks:[]}
const output=document.querySelector('#results')!,canvas=document.querySelector<HTMLCanvasElement>('#canvas')!,client=new KernelClient()
const stats:Record<string,any>={}
client.onPresentation=value=>Object.assign(stats,value)
const wait=async(check:()=>boolean)=>{const start=performance.now();while(!check()){if(stats.error)throw Error(stats.error);if(performance.now()-start>30000)throw Error('Display order check timed out');await new Promise(requestAnimationFrame)}}
try{
  client.attachPresentation(canvas.transferControlToOffscreen())
  const doc=blank(),shape=node('rectangle',0,0,24,24);shape.fills=[paint('#3399ff')]
  doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id]
  const result=await client.render(doc,{pageId:doc.pages[0].id,width:64,height:64,view:{x:0,y:0,zoom:1},grid:false,transparent:false,livePreview:true,renderIntent:'canvas'},false,'webgpu')
  if(!result.gpuTile)throw Error('Expected a resident texture')
  const frame=(x:number):ResidentFrame=>({view:{x,y:0,zoom:1},width:96,height:64,dpr:1,items:[{active:true,layer:1,tile:{key:'retained',serial:1,gpuTile:result.gpuTile!,x:0,y:0,width:64,height:64,zoom:1}}]})
  client.present(frame(10));client.present(frame(20))
  await wait(()=>stats.presented?.view.x===20)
  // Development-only fault injection: deliver an older display command after
  // the newer one. The public API normally sends these in FIFO order.
  ;(client as unknown as {worker:Worker}).worker.postMessage({command:'display-frame',sequence:1,frame:residentFrameMessage(frame(10))})
  await wait(()=>stats.displayCommandsDropped===1)
  if(stats.presented?.view.x!==20)throw Error('Old display command rolled the camera back')
  const captures=stats.compositorCaptures
  client.present(frame(30));await wait(()=>stats.presented?.view.x===30)
  if(stats.missingTextureCount||stats.compositorCaptures!==captures)throw Error('Discarding a command lost reusable tile content')
  report.checks.push({name:'stale camera rejected, original texture reused',dropped:stats.displayCommandsDropped,captures,view:stats.presented.view})
  const frames=stats.compositorFrames
  client.present(frame(30));await wait(()=>stats.compositorFrames>frames)
  if(stats.compositorTransformUploadBytes!==0)throw Error('Unchanged transforms were uploaded again')
  report.checks.push({name:'unchanged resident transforms',uploadBytes:stats.compositorTransformUploadBytes})
  const pixels=async()=>{
    const captured=await client.captureContentBitmap(),probe=document.createElement('canvas')
    probe.width=captured.bitmap.width;probe.height=captured.bitmap.height
    const context=probe.getContext('2d')!;context.drawImage(captured.bitmap,0,0);captured.bitmap.close()
    return context.getImageData(0,0,probe.width,probe.height).data
  }
  const before=await pixels(),delivered:TileResult[]=[]
  const recovered=await client.render(doc,{pageId:doc.pages[0].id,width:128,height:128,
    view:{x:0,y:0,zoom:1},grid:false,transparent:false,livePreview:true,renderIntent:'canvas',
    tileViewport:[{key:'budget-retry',x:0,y:0,width:128,height:128,zoom:1,gutter:0}]},
    false,'webgpu',false,false,{forceFirstTileBudgetFailure:true},tile=>delivered.push(tile))
  if(recovered.injectedBudgetFailures!==1||recovered.bitmapLeaves!==2||!delivered[0]?.gpuTile)
    throw Error('Budget retry was not exercised')
  const previousFrames=stats.compositorFrames
  client.present(frame(30));await wait(()=>stats.compositorFrames>previousFrames)
  if(stats.missingTextureCount)throw Error('Budget retry destroyed the previous displayed texture')
  const after=await pixels()
  if(before.length!==after.length||before.some((value,index)=>value!==after[index]))throw Error('Budget retry changed retained pixels')
  report.checks.push({name:'working-budget split preserves the display device and old pixels',
    injected:1,bitmapLeaves:recovered.bitmapLeaves,changedBytes:0,oldTexture:result.gpuTile,newTexture:delivered[0].gpuTile})
  client.releasePresented(delivered.flatMap(tile=>tile.gpuTile?[tile.gpuTile]:[]))
  report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
finally{client.dispose();output.textContent=JSON.stringify(report,null,2);void fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
