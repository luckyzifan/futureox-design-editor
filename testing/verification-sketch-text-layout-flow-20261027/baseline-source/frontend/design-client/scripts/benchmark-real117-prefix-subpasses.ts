/** Actual production prefix pass recording/replay. No synthetic math.
 * Each split pass runs on real GPU objects, in original order. Wall waits
 * include submission roundtrip and deliberately destroy normal pass overlap. */
import { readFile } from 'node:fs/promises'
import { runProof, sha256 } from './exact-prefix-proof-utils'
const scenePath=process.env.DESIGN_117_SCENE||'/tmp/futureox-fusion-117-scene.json'
const documentPath=process.env.DESIGN_117_DOCUMENT||'/tmp/futureox-fusion-117-document.json'
const repeats=Number(process.env.DESIGN_PREFIX_STAGE_REPEATS||2)
if(!Number.isSafeInteger(repeats)||repeats<1||repeats>5)throw Error('Repeats must be 1..5')
if(process.env.VITE_DESIGN_GPU_TIMINGS==='1')throw Error('Do not enable Apple timestamp queries')
await runProof('futureox-real117-prefix-subpasses',[scenePath,documentPath],async proof=>{
 const sceneBytes=await readFile(scenePath),documentBytes=await readFile(documentPath),scene=JSON.parse(sceneBytes.toString()),document=JSON.parse(documentBytes.toString())
 const prepared={sceneSha256:sha256(sceneBytes),documentSha256:sha256(documentBytes),repeats,rows:[0,1713,3426],height:58,
  scope:'Actual H prefix on real117 source. Recorded real GPU pipelines/bindings; original full production batch is independent pixel reference.',
  limitation:'Only three H strips are sampled. Split submit-completion waits include host/driver roundtrip, load/store boundaries and lost overlap; totals are not hardware-exclusive time or whole-editor latency. Empty-submit observations are reported, never subtracted. Source generation, upload, readback/hash and counter mapping are outside measured passes.'}
 await proof.write('fixture-summary.json',prepared)
 if(proof.prepareOnly)return prepared
 const result=await proof.browser(async page=>{
  let progress=0
  await page.exposeFunction('prefixStageProgress',async(value:unknown)=>proof.write(`progress-${++progress}.json`,value))
  return page.evaluate(async({scene,document,repeats})=>{
   const {initializeKernelModule}=await import('/src/kernel/module.ts')
   const {VectorEngine}=await import('/src/generated/design-kernel/design_kernel.js')
   const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
   const {GpuRenderer}=await import('/src/kernel/gpu/renderer.ts')
   await initializeKernelModule();const engine=new VectorEngine();engine.load_document(JSON.stringify(document))
   const decoded=new Map<string,any>(),loader=(uri:string,byte=false,level=0)=>{
    if(byte||level)throw Error('Expected original managed level-zero image')
    let value=decoded.get(uri);if(!value){const [width,height]=JSON.parse(engine.image_info(uri));value={width,height,pixels:engine.image_linear(uri)};decoded.set(uri,value)}return value
   }
   const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any,renderer=new GpuRenderer(driver,true,false,loader,false,false) as any
   const node=scene.nodes['1AB99304-455A-4A9E-9473-8923A1330FA4'],input={x:-1228,y:-1228,w:3484,h:3484},radius=1224.3035888671875
   type Region={x:number;y:number;w:number;h:number}
   type Surface={texture:any;rect:Region}
   type Operation={name:string;args:any[]}
   type RecordPass={kind:'compute'|'render';descriptor:any;operations:Operation[];stage?:'scan'|'solve'|'resolve'}
   const results:any[]=[],timings:any[]=[],emptySubmits:number[]=[];let active:any
   const hash=async(a:Float32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Float32Array(a).buffer))).map(v=>v.toString(16).padStart(2,'0')).join('')
   const compare=(a:Uint32Array,b:Uint32Array)=>{let different=0;const examples=[];if(a.length!==b.length)throw Error('component count');for(let i=0;i<a.length;i++)if(a[i]!==b[i]){different++;if(examples.length<8)examples.push({component:i,reference:a[i],actual:b[i]})}return {different,examples}}
   const replay=(encoder:GPUCommandEncoder,record:RecordPass)=>{
    const pass=record.kind==='compute'?encoder.beginComputePass(record.descriptor):encoder.beginRenderPass(record.descriptor)
    for(const op of record.operations)(pass as any)[op.name](...op.args)
    pass.end()
   }
   const sourceFour=(region:Region):Surface=>{let value:Surface|undefined;for(let sample=0;sample<4;sample++){
    const next=renderer.resolveFilterImageSample(node,region,sample,value);if(!next)throw Error('Real source gate rejected');renderer.release(value);value=next}
    renderer.sampleIndex=undefined;return value!}
   try{
    if(raw.timingQueries)throw Error('Timestamp query unexpectedly enabled')
    renderer.scene=scene;renderer.activeNode=node.id
    await driver.prepareScene(scene);await driver.prepareFilters(true)
    const vertices=new Float32Array(scene.vertices),curves=new Float32Array(scene.curves)
    renderer.meshBits=new Uint32Array(vertices.buffer);renderer.curveBits=new Uint32Array(curves.buffer)
    driver.begin(vertices,curves);renderer.filterImageFields={rect:input,fields:new Map(),pinned:new Set()}
    for(const row of [0,1713,3426]){
     const sourceRect={x:input.x,y:input.y+row,w:3484,h:58},output={x:-2,y:sourceRect.y,w:1032,h:58}
     const source=sourceFour(sourceRect),sourcePixels=await driver.readSurface(source.texture),sourceBits=new Uint32Array(sourcePixels.buffer)
     for(let i=3;i<sourceBits.length;i+=4)if(sourceBits[i]!==0x3f800000)throw Error('Actual source alpha is not +1')
     // Same source bytes as table resolve; certificate is attached only after
     // verifying the entire physical GPU output, never from authored opacity.
     source.texture.opaqueAlpha=true
     const referenceSurface=renderer.exactTentAxis(source,radius,0,output) as Surface
     const reference=await driver.readSurface(referenceSurface.texture),referenceBits=new Uint32Array(reference.buffer).slice()
     const referenceHash=await hash(reference);renderer.release(referenceSurface)
     const prefix=raw.prefix,passes:RecordPass[]=[],attempts:any[]=[]
     if(!prefix?.scratchBytes)throw Error('Production prefix path unavailable')
     const capturePass=(kind:'compute'|'render',descriptor:any)=>{
      if(descriptor?.timestampWrites)throw Error('Captured timestamp query')
      const record:RecordPass={kind,descriptor,operations:[]};passes.push(record);let ended=false
      return new Proxy({}, {get(_target,name){
       if(name==='end')return()=>{ended=true}
       const supported=kind==='compute'?['setPipeline','setBindGroup','dispatchWorkgroups']:['setPipeline','setBindGroup','setScissorRect','draw']
       if(typeof name!=='string'||!supported.includes(name))throw Error(`Unhandled recorded pass operation ${String(name)}`)
       return(...args:any[])=>{if(ended)throw Error('Operation after pass.end');record.operations.push({name,args:args.map(a=>ArrayBuffer.isView(a)?Array.from(a as any):a)})}
      }})
     }
     const recorder=new Proxy({}, {get(_target,name){
      if(name==='beginComputePass')return(descriptor:any)=>capturePass('compute',descriptor)
      if(name==='beginRenderPass')return(descriptor:any)=>capturePass('render',descriptor)
      throw Error(`Unhandled encoder operation ${String(name)}`)
     }}) as GPUCommandEncoder
     const originalEncode=prefix.encode,beforeSubmissions=driver.commandSubmissions
     let target:Surface
     try{
      prefix.encode=function(...args:any[]){const before=passes.length;const accepted=originalEncode.call(this,recorder,...args.slice(1));attempts.push({channels:args[7]??15,opaqueAlpha:args[9]===true,accepted,passes:passes.length-before});return accepted}
      target=renderer.exactTentAxis(source,radius,0,output)
     }finally{prefix.encode=originalEncode}
     if(driver.commandSubmissions!==beforeSubmissions||!passes.length)throw Error('Capture escaped into a live submission or did not encode prefix')
     for(const pass of passes){const pipeline=pass.operations.find(op=>op.name==='setPipeline')?.args[0]
      pass.stage=pipeline===prefix.scan?'scan':pipeline===prefix.solve?'solve':prefix.resolve.includes(pipeline)?'resolve':undefined
      if(!pass.stage)throw Error('Captured unknown production pipeline')}
     if(passes.some((pass,i)=>pass.stage!==(['scan','solve','resolve'] as const)[i%3]))throw Error('Production prefix pass order changed')
     raw.uploadUniforms();await raw.device.queue.onSubmittedWorkDone()
     active={row,sourceSha256:await hash(sourcePixels),referenceSha256:referenceHash,attempts,
      passes:passes.map(p=>({stage:p.stage,kind:p.kind,loadOp:p.descriptor.colorAttachments?.[0]?.loadOp,
       storeOp:p.descriptor.colorAttachments?.[0]?.storeOp,operations:p.operations.filter(o=>!['setPipeline','setBindGroup'].includes(o.name))})),checks:[]}
     for(let i=0;i<3;i++){const encoder=raw.device.createCommandEncoder(),at=performance.now();raw.device.queue.submit([encoder.finish()]);await raw.device.queue.onSubmittedWorkDone();emptySubmits.push(performance.now()-at)}
     // One normal recorded batch is a replay control against the independent
     // production call above. Split replay then uses the identical objects.
     for(const split of [false,true])for(let repeat=-1;repeat<repeats;repeat++){
      driver.clear(target!.texture);prefix.resetCounters(raw.encoder);await driver.checkpoint('checkpoint')
      const measured:any[]=[]
      if(!split){const encoder=raw.device.createCommandEncoder();for(const pass of passes)replay(encoder,pass)
       const at=performance.now();raw.device.queue.submit([encoder.finish()]);await raw.device.queue.onSubmittedWorkDone()
       measured.push({stage:'whole-batch',ms:performance.now()-at})
      }else for(const [index,pass] of passes.entries()){
       const encoder=raw.device.createCommandEncoder();replay(encoder,pass)
       const at=performance.now();raw.device.queue.submit([encoder.finish()]);await raw.device.queue.onSubmittedWorkDone()
       measured.push({stage:pass.stage,index,ms:performance.now()-at})
      }
      const actual=await driver.readSurface(target!.texture),equality=compare(referenceBits,new Uint32Array(actual.buffer))
      prefix.encodeCountersReadback(raw.encoder);await driver.checkpoint('checkpoint');const counters=await prefix.readCounters()
      const record={row,split,repeat,warmup:repeat<0,measured,counters,...equality,sha256:await hash(actual)}
      timings.push(record);active.checks.push(record)
      if(equality.different)throw Error('Split/replayed prefix differs from the original production batch')
     }
     results.push(active);await (globalThis as any).prefixStageProgress({completed:row,results,emptySubmits})
     renderer.release(source,target!)
    }
    const dummy=renderer.acquire({x:0,y:0,w:1,h:1});driver.clear(dummy.texture)
    await driver.finish(dummy.texture,dummy.rect,1,1,false,undefined,false)
    const summaries=['scan','solve','resolve','whole-batch'].map(stage=>{
     const values=timings.filter(t=>!t.warmup).flatMap(t=>t.measured.filter((m:any)=>m.stage===stage).map((m:any)=>m.ms))
     return {stage,passes:values.length,totalSubmitCompletionMs:values.reduce((a:number,b:number)=>a+b,0)}
    })
    return {status:'passed',adapter:driver.stats().adapter,results,summaries,emptySubmits,
     note:'Real buffers, shaders and original ordering. Only three H strips; host roundtrip/serialization and lost overlap included. Do not subtract empty-submit samples or treat totals as production GPU-exclusive/whole-editor latency.'}
   }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});return {status:'failed',error:String(error),results,active,timings,emptySubmits}}
   finally{renderer.dispose();engine.free()}
  },{scene,document,repeats})
 })
 await proof.write('gpu-result.json',result)
 if(result.status!=='passed')throw Error(result.error||'Prefix substage probe failed')
 return {...prepared,...result}
})
