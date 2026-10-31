import { blank,node,paint,effect } from '../../model'
import { KernelClient } from '../client'
import { renderRuntimeEvidence } from '../runtime-evidence'
const output=document.querySelector('#results')!
const filter=new URLSearchParams(location.search)
const report:{status:string;runtime?:unknown;cases:unknown[];error?:string}={status:'running',cases:[]}
const publish=()=>{output.textContent=JSON.stringify(report,null,2);void fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
const difference=(a:ArrayLike<number>,b:ArrayLike<number>)=>{
  if(a.length!==b.length)throw Error('Output dimensions differ')
  let changed=0,max=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d){changed++;max=Math.max(max,d)}}return{changed,max}
}
try{
  report.runtime=await renderRuntimeEvidence()
  report.cases.push({profile:'analytic',status:'unsupported',reason:'Existing managed-color contract requires fine coverage; not an admitted glass test input.'})
  for(const profile of ['figmaSubpixel','figma'] as const)for(const pose of ['fractional','scale','mirror','rotate'])for(const radius of [0,8]){
    if(filter.has('profile')&&filter.get('profile')!==profile||filter.has('pose')&&filter.get('pose')!==pose||filter.has('radius')&&Number(filter.get('radius'))!==radius)continue
    const doc=blank(),background=node('rectangle',0,0,400,320),lens=node('rectangle',39.375,37.125,320,240)
    doc.id='optical-reference';doc.pages[0].id='p';background.id='background';lens.id='lens'
    doc.schemaVersion=5;doc.rasterProfile='figma';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
    const gradient=paint('#223344','linear');gradient.id='gradient';gradient.angle=31
    gradient.stops=[{offset:0,color:'#cf1133'},{offset:.37,color:'#18a7d8'},{offset:1,color:'#ffd451'}]
    background.fills=[gradient];lens.radii=[16,16,16,16];lens.fills=[{...paint('#ccccff'),opacity:.23}];lens.blend='multiply'
    lens.fills[0].id='lens-fill'
    const glass=effect('glass');glass.id='glass';glass.radius=radius;glass.glass!.depth=1;lens.effects=[glass]
    if(pose==='scale')lens.transform=[1.125,0,0,.875,23.125,37.375]
    if(pose==='mirror')lens.transform=[-1,0,0,1,365.375,37.125]
    if(pose==='rotate')lens.transform=[.9915618937147881,.12963414261969486,-.12963414261969486,.9915618937147881,39.375,21.125]
    doc.nodes={[background.id]:background,[lens.id]:lens};doc.pages[0].children=[background.id,lens.id]
    for(const backend of ['webgpu','webgl2'] as const){
      if(filter.has('backend')&&filter.get('backend')!==backend)continue
      let client=new KernelClient()
      try{
        const options={pageId:doc.pages[0].id,width:400,height:320,view:{x:.125,y:.375,zoom:1},transparent:false,grid:false,rasterProfile:profile}
        const inputSha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({doc,options}))))).map(b=>b.toString(16).padStart(2,'0')).join('')
        const dense=await client.render(doc,options,false,backend,true,false,{disableSparseGlass:true})
        client.dispose();client=new KernelClient() // No material-field cache can hide an unexercised candidate.
        const sparse=await client.render(doc,options,false,backend,true,false,{disableSparseGlass:false})
        dense.bitmap?.close();sparse.bitmap?.close()
        if(dense.backend!==backend||sparse.backend!==backend)throw Error('Backend fallback does not validate requested driver')
        const rgba=difference(dense.bytes,sparse.bytes)
        if(!!dense.linear!==!!sparse.linear)throw Error('Float output contract changed')
        const floats=dense.linear&&sparse.linear?difference(new Uint32Array(dense.linear.buffer,dense.linear.byteOffset,dense.linear.length),new Uint32Array(sparse.linear.buffer,sparse.linear.byteOffset,sparse.linear.length)):undefined
        report.cases.push({profile,pose,radius,depth:glass.glass!.depth,backend,inputSha256,rgba,floats,
          denseFieldBytes:dense.materialFieldUploadBytes,sparseFieldBytes:sparse.materialFieldUploadBytes,
          denseFieldMs:dense.materialFieldBuildMs,sparseFieldMs:sparse.materialFieldBuildMs});publish()
        if(rgba.changed||floats?.changed){
          client.dispose();client=new KernelClient()
          const control=await client.render(doc,options,false,backend,true,false,{disableSparseGlass:true})
          control.bitmap?.close()
          report.cases.push({name:'fresh dense control after mismatch',profile,pose,radius,backend,inputSha256,
            versusFirstDense:difference(dense.bytes,control.bytes),versusCandidate:difference(sparse.bytes,control.bytes)})
          throw Error(`Optical field representation comparison failed: ${profile}/${pose}/${radius}/${backend}`)
        }
        if(pose==='fractional'&&!(sparse.materialFieldUploadBytes!<dense.materialFieldUploadBytes!))throw Error('Constant interior branch was not exercised')
      }finally{client.dispose()}
    }
  }
  if(report.cases.length<=1)throw Error('No optical comparison selected')
  report.status='passed';publish()
}catch(error){report.status='failed';report.error=String(error);publish()}
