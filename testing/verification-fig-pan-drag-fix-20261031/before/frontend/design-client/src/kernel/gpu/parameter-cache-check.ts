import { blank,node,paint } from '../../model'
import { KernelClient } from '../client'
import { initializePicking } from '../picking'
const output=document.querySelector('#results')!
const report:{status:string;cases:unknown[];error?:string}={status:'running',cases:[]}
const publish=()=>{output.textContent=JSON.stringify(report,null,2);void fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const different=(a:Uint8Array,b:Uint8Array)=>a.length!==b.length?Infinity:a.reduce((n,v,i)=>n+Number(v!==b[i]),0)
try{
  await initializePicking()
  const image=document.createElement('canvas');image.width=image.height=4
  const bytes=Uint8ClampedArray.from({length:64},(_,i)=>i%4===3?173:(i*47)%256)
  image.getContext('2d')!.putImageData(new ImageData(bytes,4,4),0,0)
  for(const managed of [false,true])for(const kind of ['image','linear','radial'] as const){
    const doc=blank(),shape=node('rectangle',12.25,9.5,80,64),fill=paint('#ffffff',kind)
    doc.schemaVersion=4;doc.rasterProfile=managed?'figma':'figmaSoftware'
    if(managed)doc.colorManagement={documentSpace:'display-p3',referenceWhiteNits:203,peakLuminanceNits:1000}
    fill.opacity=.73
    if(kind==='image'){fill.image=image.toDataURL();fill.fit='cover';fill.transform=[1,.12,.23,1,.2,-.1]}
    else{fill.angle=23;fill.stops=[{offset:0,color:'#ff8033'},{offset:.37,color:'#2c44ff'},{offset:1,color:'#10cc44'}]}
    shape.fills=[fill];doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id]
    const options={pageId:doc.pages[0].id,width:112,height:96,view:{x:.125,y:.375,zoom:1.1},transparent:true,grid:false}
    const client=new KernelClient()
    let first:Uint8Array,reused:Uint8Array,hits=0,uploads=0,builds=0
    try{
      const a=await client.render(doc,options,false,'webgpu',true)
      const b=await client.render(doc,options,false,'webgpu',true)
      first=a.bytes;builds=a.materialFieldBuilds||0;reused=b.bytes;hits=b.materialFieldHits||0;uploads=b.materialFieldUploadBytes||0
      a.bitmap?.close();b.bitmap?.close()
    }finally{client.dispose()}
    const fresh=new KernelClient()
    try{
      const c=await fresh.render(doc,options,false,'webgpu',true)
      const change=different(first!,reused!),freshChange=different(c.bytes,reused!)
      c.bitmap?.close()
      report.cases.push({managed,kind,builds,hits,uploads,differentBytes:change,freshDifferentBytes:freshChange});publish()
      if(change||freshChange||builds>0&&(!hits||uploads))throw Error('Cached field differs from a fresh GPU render or did not reuse its immutable upload')
    }finally{fresh.dispose()}
  }
  report.status='passed';publish()
}catch(error){report.status='failed';report.error=String(error);publish()}
