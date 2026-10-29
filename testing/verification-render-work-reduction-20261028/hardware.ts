import {initializeKernelModule} from '../../frontend/design-client/src/kernel/module'
import {VectorEngine} from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import {blank,node,paint,effect,type DesignDocument,type Paint} from '../../frontend/design-client/src/model'
import {WebGpuDriver} from '../../frontend/design-client/src/kernel/gpu/webgpu'
import {GpuRenderer} from '../../frontend/design-client/src/kernel/gpu/renderer'
import {setGpuDiagnosticSink} from '../../frontend/design-desktop/src/render-terminal-diagnostics.mjs'
import {managedSceneImageLoader} from '../../frontend/design-client/src/kernel/scene-image-hydration'
import {DecodedImageCache,createDecodedImageOwner,decodedImageScope} from '../../frontend/design-client/src/kernel/decoded-image-cache'
const report:any={status:'running',scope:'production Rust/WASM -> hardware WebGPU; original control paths versus independent work reductions',constantCoverageCandidate:import.meta.env.VITE_DESIGN_CONSTANT_COVERAGE==='1',cases:[]}
const publish=async()=>{document.querySelector('#results')!.textContent=JSON.stringify(report,null,2);await fetch('/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)})}
const real=new URL(location.href).searchParams.get('real')==='1'
const width=real?512:256,height=real?512:192
const add=(doc:DesignDocument,n:ReturnType<typeof node>,parent?:ReturnType<typeof node>)=>{n.id='33333333-3333-4333-8333-'+Object.keys(doc.nodes).length.toString(16).padStart(12,'0');doc.nodes[n.id]=n;(parent?parent.children:doc.pages[0].children).push(n.id);return n}
function fixture(kind:string){
 const doc=blank();doc.schemaVersion=20;doc.rasterProfile='figmaSubpixel';doc.colorManagement={documentSpace:'srgb',referenceWhiteNits:203,peakLuminanceNits:1000}
 doc.id='11111111-1111-4111-8111-111111111111';doc.pages[0].id='22222222-2222-4222-8222-222222222222'
 const root=add(doc,node('group',0,0,width,height));root.fills=[];root.clip=false;root.blend='normal'
 if(kind==='mixed'||kind==='mixed-effect'){
  for(let i=0;i<65;i++){
   const shape=add(doc,node(i%3===0?'ellipse':'rectangle',6+(i%13)*16.25,5+Math.floor(i/13)*24.5,29.75,28.25),root)
   shape.fills=[paint(i<32?'#3482bc':'#f27820')]
   if(i===32){shape.fills=[paint('#000000','linear')];shape.fills[0].stops=[{offset:0,color:'#11aabb'},{offset:1,color:'#ef2468'}]}
   if(i===17&&kind==='mixed-effect')shape.effects=[{...effect('shadow'),radius:3,x:1.25,y:-.5}]
  }
 }else if(kind==='constant'){
  for(let i=0;i<12;i++){const shape=add(doc,node('rectangle',-10,-10,300,220),root);shape.fills=[paint('#2874ac')];shape.opacity=.8}
 }else{
  const gradientKind=(['linear','radial','angular','diamond'].includes(kind)?kind:'linear') as Paint['kind']
  for(let i=0;i<20;i++){
   const shape=add(doc,node(i%2?'ellipse':'rectangle',3+(i%5)*47.25,3+Math.floor(i/5)*43.75,39.5,35.25),root)
   const fill=paint('#102030',gradientKind);fill.opacity=.63;fill.angle=37
   fill.stops=[{offset:0,color:'color(srgb 0.8 0.1 0.3 / 0.15)'},{offset:.41,color:'#31cf9b'},{offset:1,color:'color(srgb 0.1 0.2 0.9 / 0.7)'}]
   if(kind==='stops64')fill.stops=Array.from({length:64},(_,j)=>({offset:j/63,color:j%2?'#e07a24':'#1247ac'}))
   if(kind==='wide-color')fill.stops[1].color='color(srgb-linear 2 -0.2 0.5 / 0.8)'
   shape.fills=[fill]
  }
  if(kind==='clipped'){root.clip=true;root.kind='frame';root.width=190;root.height=140}
 }
 return doc
}
function scene(raw:string){const s=JSON.parse(raw);s.vertices=new Float32Array(s.vertices);s.curves=new Float32Array(s.curves);return s}
const median=(a:number[])=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]
try{
 await initializeKernelModule();setGpuDiagnosticSink(()=>{})
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware adapter required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter}
 let activeKernel:VectorEngine,owner=createDecodedImageOwner(),settings=''
 const font=real?new Uint8Array(await(await fetch('/fonts/NotoSansSC.ttf')).arrayBuffer()):undefined
 const realDocs:Record<string,DesignDocument>={}
 if(real){
  report.sources=await(await fetch('/real-inputs/manifest.json')).json()
  for(const name of ['fig','117']){
   const raw=await(await fetch('/real-inputs/'+name+'.json')).text()
   const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(v=>v.toString(16).padStart(2,'0')).join('')
   if(hash!==report.sources.find((s:any)=>s.name===name)?.documentSha256)throw Error('Real document digest mismatch')
   realDocs[name]=JSON.parse(raw)
  }
 }
 const pair:any[]=[]
 const createPair=async(linear:boolean)=>{for(const candidate of [false,true]){
  const loader=managedSceneImageLoader(new DecodedImageCache(),()=>({kernel:activeKernel,scope:decodedImageScope(owner,settings),settings,current:()=>true,ownerCurrent:()=>true,resourceOwner:owner}),{key:async()=>undefined,read:async()=>undefined,write:()=>{}})
  const driver=await WebGpuDriver.create(true,false,linear,true,false),renderer=new GpuRenderer(driver,true,false,loader) as any
  if(!candidate){renderer.constantCoverageEnabled=false;renderer.mixedSolidRunsEnabled=false;Object.defineProperty(driver,'exactGradientPaintOver',{value:false})}
  pair.push({driver,renderer})
 }}
 await createPair(true)
 try{
 for(const name of real?['fig-cards','fig-charts','117-overview','117-detail']:['constant','linear','radial','angular','diamond','stops64','clipped','wide-color','mixed','mixed-effect']){
  report.current=name;await publish()
  const doc=real?realDocs![name.startsWith('fig')?'fig':'117'] as DesignDocument:fixture(name),engine=new VectorEngine()
  if(real&&pair[0].driver.linearLight!==!!doc.colorManagement){for(const {renderer}of pair)renderer.dispose();pair.length=0;await createPair(!!doc.colorManagement)}
  if(font)engine.load_font(font);engine.load_document(JSON.stringify(doc));activeKernel=engine;owner=createDecodedImageOwner();settings=engine.color_settings()
  let view={x:name==='constant'?0:-.125,y:name==='constant'?0:.375,zoom:1},pageId=doc.pages[0].id
  if(real){
   const board=doc.pages.flatMap(p=>p.children.map(id=>doc.nodes[id])).find(n=>n?.name===(name.startsWith('fig')?'01_Dashboard':'117')&&n.kind==='frame')!
   if(!board)throw Error('Missing intended real board')
   pageId=doc.pages.find(p=>p.children.includes(board.id))!.id
   const zoom=name==='117-overview'?.25:1,offset=name==='fig-cards'?[240,50]:name==='fig-charts'?[250,1120]:name==='117-detail'?[600,100]:[0,0]
   view={x:-(board.transform[4]+offset[0])*zoom,y:-(board.transform[5]+offset[1])*zoom,zoom}
  }
  const options={pageId,width,height,view,rasterProfile:real&&name.startsWith('fig')?(doc.rasterProfile||'analytic'):'figmaSubpixel',transparent:true}
  const raw=engine.compile_gpu(JSON.stringify(options))
  const runs:any[][]=[[],[]],outputs:Float32Array[]=[],cold:any[]=[]
  // Cold/warm results are kept separately; performance is alternating A/B.
  for(let warm=0;warm<2;warm++)for(let side=0;side<2;side++){
   const start=performance.now(),result=await pair[side].renderer.render(scene(raw),true,false)
   if(!result.linear)throw Error('Missing raw float result')
   if(warm===0)cold[side]={wallMs:performance.now()-start,draws:result.drawCalls,pixels:result.passPixels,peakBytes:result.peakTextureBytes,work:result.drawWork}
   if(warm===1)outputs[side]=result.linear
   if(side===1&&result.straightRgba){const canvas=document.querySelector<HTMLCanvasElement>('#preview')!;canvas.width=width;canvas.height=height;canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(result.straightRgba),width,height),0,0)}
  }
  const a=new Uint32Array(outputs[0].buffer,outputs[0].byteOffset,outputs[0].length),b=new Uint32Array(outputs[1].buffer,outputs[1].byteOffset,outputs[1].length)
  let differences=0,first=-1;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){differences++;if(first<0)first=i}
  const row:any={name,options,cold,words:a.length,differences,firstDifference:first,packetNodes:Object.keys(JSON.parse(raw).nodes).length};report.cases.push(row);await publish()
  if(differences)throw Error('Raw float mismatch: '+name)
  for(let repetition=0;repetition<3;repetition++)for(const side of repetition%2?[1,0]:[0,1]){
   const start=performance.now(),result=await pair[side].renderer.render(scene(raw),true,false)
   runs[side].push({wallMs:performance.now()-start,draws:result.drawCalls,pixels:result.passPixels,peakBytes:result.peakTextureBytes,work:result.drawWork})
  }
  row.runs=runs;row.controlMs=median(runs[0].map(r=>r.wallMs));row.candidateMs=median(runs[1].map(r=>r.wallMs));row.improvement=1-row.candidateMs/row.controlMs
  const work=runs[1][0].work||{}
  if(name==='constant'&&report.constantCoverageCandidate&&!work.fastCoverageConstant)throw Error('Constant coverage not exercised')
  if(['linear','radial','angular','diamond','stops64'].includes(name)&&!work.fastGradientFused)throw Error('Gradient fusion not exercised: '+name)
  if(name==='mixed'&&!work.fastSolidBatches)throw Error('Mixed batches not exercised')
  row.workReduced=runs[1][0].draws<runs[0][0].draws||runs[1][0].pixels<runs[0][0].pixels
  row.coldWorkReduced=cold[1].draws<cold[0].draws||cold[1].pixels<cold[0].pixels
  engine.free()
  await publish()
 }
 report.status='passed'
 }finally{for(const {renderer}of pair)renderer.dispose()}
}catch(error){report.status='failed';report.error=String(error);report.stack=error instanceof Error?error.stack:undefined}
await publish()
