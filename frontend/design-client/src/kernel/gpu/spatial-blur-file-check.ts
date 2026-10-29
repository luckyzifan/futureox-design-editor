import fixture from '../../../../../testing/verification-sketch-effects-20261026/canvas-spatial-blur.sketch?url'
import init, {import_sketch_json} from '../../generated/design-kernel/design_kernel'
import {KernelClient} from '../client'
import type {DesignDocument} from '../../model'
const output=document.querySelector('#results')!,cpu=new KernelClient(),gpu=new KernelClient()
const report:{status:string;cases:unknown[];error?:string}={status:'running',cases:[]}
const publish=()=>{output.textContent=JSON.stringify(report,null,2)}
try {
  await init()
  const doc=JSON.parse(import_sketch_json(new Uint8Array(await(await fetch(fixture)).arrayBuffer()))).document as DesignDocument
  const frame=Object.values(doc.nodes).find(n=>n.name==='t0-r5-a0-box')!
  for(const zoom of [1,2]) {
    const options={pageId:doc.pages[0].id,width:256*zoom,height:192*zoom,view:{x:-frame.transform[4]*zoom,y:-frame.transform[5]*zoom,zoom},transparent:true,grid:false,renderIntent:'preview' as const,livePreview:true}
    const expected=await cpu.render(doc,options,false,'cpu',true),actual=await gpu.render(doc,options,false,'webgpu',false)
    expected.bitmap?.close();actual.bitmap?.close()
    if(actual.backend!=='webgpu'||actual.bytes.length!==expected.bytes.length)throw Error('Production preview did not return the expected WebGPU image')
    let changed=0,max=0
    for(let i=0;i<actual.bytes.length;i++){const d=Math.abs(actual.bytes[i]-expected.bytes[i]);if(d)changed++;max=Math.max(max,d)}
    report.cases.push({zoom,backend:actual.backend,rgba:{changed,max}});publish()
    if(changed)throw Error('Imported bitmap preview differs from CPU')
  }
  report.status='passed';publish()
}catch(error){report.status='failed';report.error=String(error);publish()}
finally{cpu.dispose();gpu.dispose()}
