import { blank, node, paint, effect, type ColorControls } from '../../model'
import { KernelClient } from '../client'
const output=document.querySelector('#results')!
const backend=new URLSearchParams(location.search).get('backend')==='webgl2'?'webgl2':'webgpu'
const report:{status:string;backend:string;cases:unknown[];error?:string}={status:'running',backend,cases:[]}
const publish=()=>{output.textContent=JSON.stringify(report,null,2)}
const cpu=new KernelClient(),gpu=new KernelClient()
try {
  for(const space of [undefined,'srgb','display-p3'] as const)for(const background of [false,true]) {
    const doc=blank(),a=node('rectangle',8,8,70,60),b=node('rectangle',14.25,15.5,37.5,31.75)
    doc.schemaVersion=17;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
    a.fills=[paint('#3366b3')];b.fills=background?[]:[paint('color(srgb 1 0 0 / 0.5)')]
    const controls:ColorControls={brightness:.2,contrast:1.4,saturation:.8,hue:.7,...(space?{space}:{})}
    const fx=effect(background?'background-blur':'color-controls');fx.radius=0;fx.colorControls=controls;b.effects=[fx]
    doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
    const options={pageId:doc.pages[0].id,width:97,height:73,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'figma' as const}
    const expected=await cpu.render(doc,options,false,'cpu',true)
    const actual=await gpu.render(doc,options,false,backend,true)
    expected.bitmap?.close();actual.bitmap?.close()
    if(actual.backend!==backend)throw Error(`Requested ${backend}, got ${actual.backend}`)
    if(actual.bytes.length!==expected.bytes.length)throw Error('Output size changed')
    let changed=0,max=0
    for(let i=0;i<actual.bytes.length;i++) {const delta=Math.abs(actual.bytes[i]-expected.bytes[i]);if(delta)changed++;max=Math.max(max,delta)}
    let floatChanged=0,floatMax=0
    if(actual.linear&&expected.linear)for(let i=0;i<actual.linear.length;i++) {
      const delta=Math.abs(actual.linear[i]-expected.linear[i]);if(delta)floatChanged++;floatMax=Math.max(floatMax,delta)
    }
    const unfiltered=structuredClone(doc);unfiltered.nodes[b.id].effects=[]
    const baseline=await cpu.render(unfiltered,options,false,'cpu',true);baseline.bitmap?.close()
    const changedVsUnfiltered=actual.bytes.reduce((count,value,index)=>count+Number(value!==baseline.bytes[index]),0)
    if(!changedVsUnfiltered)throw Error('The color controls did not change visible pixels')
    report.cases.push({space:space??'working',background,backend:actual.backend,changedVsUnfiltered,rgba:{changed,max},floatDiagnostic:{changed:floatChanged,max:floatMax}});publish()
    if(changed)throw Error('Final RGBA differs from CPU')
  }
  report.status='passed';publish()
} catch(error) {report.status='failed';report.error=String(error);publish()}
finally {cpu.dispose();gpu.dispose()}
