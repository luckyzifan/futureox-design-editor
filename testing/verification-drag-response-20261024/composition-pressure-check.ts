import {initializePicking} from '../../frontend/design-client/src/kernel/picking'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {defaultColorSettings} from '../../frontend/design-client/src/color'
import {blank,node,paint} from '../../frontend/design-client/src/model'
import {createGpu} from '../../frontend/design-client/src/kernel/gpu/factory'
// @ts-expect-error isolated previous compiled renderer source
import {createGpu as previous} from '../../frontend/design-client/src/kernel/gpu/factory.ts?reference'
const report:any={status:'running',scope:'synthetic masked groups; previous real renderer rejects 256 MiB, previous default 1 GiB is pixel oracle; candidate 256 MiB must reclaim only completed pool storage',runs:[]}
const publish=async()=>{(window as any).__tileReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error});await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
try{
 await initializePicking();const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 const doc=blank('Masked composition admission');doc.schemaVersion=16;doc.colorManagement=defaultColorSettings();doc.rasterProfile='figmaSubpixel'
 for(let i=0;i<48;i++){
  const w=600+i*5,h=180+i%11*3,g=node('group',i%5*90,Math.floor(i/5)*50,w,h),m=node('rectangle',0,0,w,h),leaf=node('rectangle',0,0,w,h)
  g.blend='pass-through';g.opacity=.5;g.fills=[];g.children=[m.id,leaf.id]
  m.mask=true;m.maskType='alpha';m.radii=[7.25,7.25,7.25,7.25];m.fills=[paint('#000000')]
  leaf.fills=[paint(i%2?'#20bca8':'#ac2865')]
  for(const n of [g,m,leaf])doc.nodes[n.id]=n;doc.pages[0].children.push(g.id)
 }
 report.nodeCount=Object.keys(doc.nodes).length;const kernel=new VectorEngine();let scene:any
 try{kernel.load_document(JSON.stringify(doc));scene=JSON.parse(kernel.compile_gpu(JSON.stringify({pageId:doc.pages[0].id,width:512,height:512,view:{x:0,y:0,zoom:1},rasterProfile:'figmaSubpixel'})))}finally{kernel.free()}
 let oracle:Uint32Array|undefined
 for(const {variant,budget}of [{variant:'previous-low',budget:256},{variant:'previous-default',budget:1024},{variant:'candidate-low',budget:256}]){
  const factory=variant==='candidate-low'?createGpu:previous
  const gpu=await factory('webgpu',true,true,scene.colorManagement,undefined,false,true,false,false,false,budget)
  const driver=gpu.driver as any,checkpoint=driver.checkpoint.bind(driver);let waits=0
  driver.checkpoint=async(...args:any[])=>{waits++;return checkpoint(...args)}
  const run:any={variant,budget};report.runs.push(run);const budgetError=(gpu as any).budgetError.bind(gpu);(gpu as any).budgetError=(...args:any[])=>{run.failureSnapshot=(gpu as any).surfaceFailureSnapshot();run.allocation=args;return budgetError(...args)}
  try{
   const result=await gpu.render(scene,true,false);if(!result.linear)throw Error('Missing float readback')
   const bits=new Uint32Array(result.linear.buffer,result.linear.byteOffset,result.linear.length)
   if(variant==='previous-low')throw Error('Fixture did not reproduce the old admission failure')
   if(variant==='previous-default')oracle=bits.slice()
   else {if(!oracle)throw Error('Missing oracle');let mismatches=0;for(let i=0;i<bits.length;i++)mismatches+=Number(bits[i]!==oracle[i]);run.mismatches=mismatches;if(mismatches)throw Error('Pressure changed pixels')}
   Object.assign(run,{status:'passed',words:bits.length,checkpoints:waits,workingBytes:result.workingTextureBytes})
  }catch(error){run.error=String(error);run.checkpoints=waits;if(variant==='previous-low'&&/预算|budget/i.test(String(error)))run.status='expected-budget-rejection';else throw error}
  finally{driver.checkpoint=checkpoint;gpu.dispose();await publish()}
 }
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}
await publish()
