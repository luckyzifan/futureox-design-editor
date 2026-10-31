import { blank, node, paint, effect } from '../../model'
import { KernelClient } from '../client'
const output=document.querySelector('#results')!
const query=new URLSearchParams(location.search)
const backend=query.get('backend')==='webgl2'?'webgl2':'webgpu'
const hdr=query.has('hdr'), preview=query.has('preview')
const report:{status:string;backend:string;cases:unknown[];error?:string}={status:'running',backend,cases:[]}
const publish=()=>{output.textContent=JSON.stringify(report,null,2)}
const cpu=new KernelClient(),gpu=new KernelClient()
try {
  for (const managed of (hdr||preview ? [true] : [false,true])) for (const [kind,angle] of [['gaussian-blur',0],['motion-blur',0],['motion-blur',37.5],['motion-blur',90]] as const) {
    const doc=blank(),b=node('rectangle',24.25,20.5,12,16)
    doc.schemaVersion=18;doc.rasterProfile='figma'
    if(managed)doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
    b.fills=[paint(hdr?'color(srgb 2 -0.25 0.5 / 0.5)':'#3366b3')]
    if(hdr&&!query.has('axis'))b.transform=[0.8,0.6,-0.3,0.4,24.25,20.5]
    const fx=effect(kind);fx.radius=3.25;if(kind==='motion-blur')fx.motionAngle=angle;b.effects=[fx]
    doc.nodes={[b.id]:b};doc.pages[0].children=[b.id]
    const options={pageId:doc.pages[0].id,width:97,height:73,view:{x:0,y:0,zoom:1},transparent:true,grid:false,rasterProfile:'figma' as const,...(preview?{renderIntent:'preview' as const,livePreview:true}:{})}
    const expected=await cpu.render(doc,options,false,'cpu',true)
    const actual=await gpu.render(doc,options,false,backend,!preview)
    expected.bitmap?.close();actual.bitmap?.close()
    if(actual.backend!==backend)throw Error(`Requested ${backend}, got ${actual.backend}`)
    if(actual.bytes.length!==expected.bytes.length)throw Error('Output size changed')
    let changed=0,max=0
    for(let i=0;i<actual.bytes.length;i++) {const delta=Math.abs(actual.bytes[i]-expected.bytes[i]);if(delta)changed++;max=Math.max(max,delta)}
    let floatChanged=0,floatMax=0,floatIndex=-1
    if(actual.linear&&expected.linear)for(let i=0;i<actual.linear.length;i++) {
      const delta=Math.abs(actual.linear[i]-expected.linear[i]);if(delta)floatChanged++;if(delta>floatMax){floatMax=delta;floatIndex=i}
    }
    const unfiltered=structuredClone(doc);unfiltered.nodes[b.id].effects=[]
    const baseline=await cpu.render(unfiltered,options,false,'cpu',true);baseline.bitmap?.close()
    const changedVsUnfiltered=actual.bytes.reduce((count,value,index)=>count+Number(value!==baseline.bytes[index]),0)
    if(!changedVsUnfiltered)throw Error('The spatial filter did not change visible pixels')
    let unfilteredFloatMax: number|undefined
    if(hdr){const nativeBaseline=await gpu.render(unfiltered,options,false,backend,true);nativeBaseline.bitmap?.close()
      unfilteredFloatMax=nativeBaseline.linear&&baseline.linear?nativeBaseline.linear.reduce((m,v,i)=>Math.max(m,Math.abs(v-baseline.linear![i])),0):undefined}
    report.cases.push({unfilteredFloatMax,kind,angle,managed,hdr,preview,backend:actual.backend,changedVsUnfiltered,rgba:{changed,max},floatDiagnostic:{available:!!(actual.linear&&expected.linear),changed:floatChanged,max:floatMax,index:floatIndex,cpuAtMax:expected.linear?.[floatIndex],gpuAtMax:actual.linear?.[floatIndex],cpuPixel:Array.from(expected.linear?.slice(floatIndex,floatIndex+4)??[]),gpuPixel:Array.from(actual.linear?.slice(floatIndex,floatIndex+4)??[]),min:actual.linear?Math.min(...actual.linear):null,maxValue:actual.linear?Math.max(...actual.linear):null}});publish()
    if(changed)throw Error('Final RGBA differs from CPU')
    if(managed&&(!actual.linear||!expected.linear||floatChanged))throw Error('Linear float differs from CPU or is unavailable')
    if(hdr&&actual.linear&&!(Math.min(...actual.linear)<0&&Math.max(...actual.linear)>1))throw Error('HDR or negative values were lost')
  }
  report.status='passed';publish()
} catch(error) {report.status='failed';report.error=String(error);publish()}
finally {cpu.dispose();gpu.dispose()}
