import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {blank,node,paint,effect} from '../../frontend/design-client/src/model'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
import {setGpuDiagnosticSink} from '../../frontend/design-desktop/src/render-terminal-diagnostics.mjs'
const report:any={status:'running',scope:'Production Rust/WASM and hardware WebGPU; field-retirement index control/candidate; render and readback timing excludes comparison/hash. Not GUI latency.',flags:{dynamicUniforms:import.meta.env.VITE_DESIGN_DYNAMIC_UNIFORMS==='1',kernelCache:import.meta.env.VITE_DESIGN_KERNEL_CACHE==='1'},cases:[]}
async function publish(){document.querySelector('#result')!.textContent=JSON.stringify(report,null,2);await fetch('/report',{method:'POST',body:JSON.stringify(report)})}
function fixture(kind:string){
 const doc=blank();doc.schemaVersion=20;doc.rasterProfile='figmaSubpixel';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
 const root=node('group',0,0,768,768);root.id='root';root.opacity=.9;root.fills=[];root.clip=false;root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
 for(let i=0;i<900;i++){
  const n=node(i%2?'ellipse':'rectangle',3+(i%30)*24.75,3+Math.floor(i/30)*24.75,23.5,22.75);n.id=`n${i}`
  const fill=paint('#123456','linear');fill.angle=i%180;fill.stops=[{offset:0,color:'#ff8800'},{offset:.4,color:'#4488dd'},{offset:1,color:'color(srgb 0.2 0.8 0.4 / 0.6)'}]
  n.fills=[fill];if(kind==='shadow'&&i%90===0)n.effects=[{...effect('shadow'),radius:3,x:1.25,y:-.5}]
  if(kind==='hdr'&&i%80===0)fill.stops[1].color='color(srgb-linear 2 -0.1 0.5 / 0.8)'
  root.children.push(n.id);doc.nodes[n.id]=n
 }
 if(kind==='clip'){root.kind='frame';root.clip=true;root.width=650.5;root.height=670.25}
 return doc
}
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[Math.floor(v.length/2)]
try{
 await initializeKernelModule();setGpuDiagnosticSink(()=>{})
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};await publish()
 for(const kind of ['gradient','clip','shadow','hdr']){
  const doc=fixture(kind),kernel=new VectorEngine();kernel.load_document(JSON.stringify(doc))
  const raw=kernel.compile_gpu(JSON.stringify({pageId:doc.pages[0].id,width:768,height:768,view:{x:-.125,y:.375,zoom:1},rasterProfile:'figmaSubpixel',transparent:true}))
  const pair:any[]=[]
  for(const enabled of [false,true]){
   const driver=await WebGpuDriver.create(true,kind==='hdr',true,true,false)
   const renderer=new GpuRenderer(driver,true,false,undefined,undefined,undefined,256) as any
   renderer.fieldRetirementIndexEnabled=enabled;pair.push(renderer)
  }
  const row:any={kind,runs:[[],[]],differences:0};report.cases.push(row)
  try{
   let reference:Uint32Array|undefined
   for(let pass=0;pass<4;pass++)for(const side of pass%2?[1,0]:[0,1]){
    const scene=JSON.parse(raw);scene.vertices=new Float32Array(scene.vertices);scene.curves=new Float32Array(scene.curves)
    const before=performance.now(),result=await pair[side].render(scene,true,false)
    const wallMs=performance.now()-before
    if(!result.linear)throw Error('Missing float readback')
    const bits=new Uint32Array(result.linear.buffer,result.linear.byteOffset,result.linear.length)
    if(!reference)reference=bits.slice();else for(let i=0;i<bits.length;i++)if(bits[i]!==reference[i])row.differences++
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(result.linear.buffer,result.linear.byteOffset,result.linear.byteLength).slice()))].map(v=>v.toString(16).padStart(2,'0')).join('')
    const data={wallMs,hash,drawCalls:result.drawCalls,passPixels:result.passPixels,peakBytes:result.peakTextureBytes,policy:pair[side].memoryPolicy()}
    if(pass===0)(row.cold??=[])[side]=data;else row.runs[side].push(data)
    row.words=bits.length
   }
   if(row.differences)throw Error('Float bits differ: '+kind)
   row.controlMs=median(row.runs[0].map((r:any)=>r.wallMs));row.candidateMs=median(row.runs[1].map((r:any)=>r.wallMs));row.improvement=1-row.candidateMs/row.controlMs
   row.indexHits=pair[1].memoryPolicy().fieldRetirementIndexSkips
   await publish()
  }finally{for(const r of pair)r.dispose();kernel.free()}
 }
 if(!report.cases.some((c:any)=>c.indexHits>0))throw Error('Production index path was not exercised')
 report.status='passed'
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
