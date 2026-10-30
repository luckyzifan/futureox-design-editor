/** Real 117 X-table source attribution. Test-only private-method access preserves the
 * production image/grid/mask/filter code while separating queue submissions.
 * Never interpret these CPU completion waits as hardware timestamp durations. */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initSync, VectorEngine, image_sampling_axes_placed } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

const scenePath = resolve(process.env.DESIGN_117_SCENE || '/tmp/futureox-fusion-117-scene.json')
const documentPath = resolve(process.env.DESIGN_117_DOCUMENT || '/tmp/futureox-fusion-117-document.json')
const nodeId = process.env.DESIGN_117_IMAGE_NODE || '1AB99304-455A-4A9E-9473-8923A1330FA4'
const sourceVariant = process.env.DESIGN_GPU_STAGE_SOURCE || 'table'
if (!['baseline', 'table'].includes(sourceVariant)) throw Error('DESIGN_GPU_STAGE_SOURCE must be baseline or table')
if (sourceVariant === 'table' && process.env.VITE_DESIGN_EXACT_IMAGE_X_TABLE !== '1') throw Error('Table mode requires VITE_DESIGN_EXACT_IMAGE_X_TABLE=1')
const repeats = Number(process.env.DESIGN_GPU_STAGE_REPEATS || 3)
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5) throw Error('DESIGN_GPU_STAGE_REPEATS must be 1..5')
if (process.env.VITE_DESIGN_GPU_TIMINGS === '1') throw Error('Disable VITE_DESIGN_GPU_TIMINGS for serial wall-time attribution')

await runProof('futureox-real-117-x-table-stages', [scenePath, documentPath], async proof => {
  const sceneBytes = await readFile(scenePath), documentBytes = await readFile(documentPath)
  const scene = JSON.parse(sceneBytes.toString('utf8')), document = JSON.parse(documentBytes.toString('utf8'))
  const n = scene.nodes[nodeId], authored = document.nodes[nodeId]
  if (!n || !authored || n.children.length || n.fills.filter((p: any) => p.visible).length !== 1 ||
      n.fills[0].kind !== 'image' || !n.fills[0].image || n.fills[0].image !== authored.fills[0].image ||
      !scene.floatCompositing || !scene.integratedBlur || !scene.coherentSamples || scene.displayFilters)
    throw Error('Fixture must retain the actual single-image managed 117 blur node')
  const effect = n.effects.filter((e: any) => e.visible)
  if (effect.length !== 1 || effect[0].kind !== 'blur' || effect[0].gradientBlur) throw Error('Expected one ordinary blur')
  const [a,b,c,d] = n.matrix, square = a*a+b*b+c*c+d*d, determinant = a*d-b*c
  const radius = effect[0].radius * Math.sqrt((square+Math.sqrt(Math.max(0,square*square-4*determinant*determinant)))/2)
  const intersection = (a:any,b:any) => ({x:Math.max(a.x,b.x),y:Math.max(a.y,b.y),
    w:Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)),h:Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y))})
  const output = intersection(n.rect,scene.extent), reach = Math.ceil(radius)+1
  const input = intersection(n.rect,{x:output.x-reach,y:output.y-reach,w:output.w+2*reach,h:output.h+2*reach})
  if (radius !== 1224.3035888671875 || input.w !== 3484 || input.h !== 3484 || output.w !== 1032 || output.h !== 1032)
    throw Error(`117 high-zoom fixture changed: ${JSON.stringify({radius,input,output})}`)
  const wasm = await readFile(join(project,'public/kernel/design_kernel_bg.wasm'))
  initSync({module:wasm})
  const engine = new VectorEngine()
  let source: {width:number;height:number;uriSha256:string;pixelsSha256:string;finite:boolean;adjust:unknown}, fieldProof: unknown[] = []
  try {
    engine.load_document(documentBytes.toString('utf8'))
    const [width,height] = JSON.parse(engine.image_info(n.fills[0].image)), pixels = engine.image_linear(n.fills[0].image)
    source={width,height,uriSha256:sha256(n.fills[0].image),pixelsSha256:sha256(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)),
      finite:pixels.every(Number.isFinite),adjust:n.fills[0].adjust || null}
    const p=n.fills[0], paint=JSON.stringify({kind:'image',color:p.color,fit:p.fit,transform:p.transform,tile:p.tile})
    for(let sample=0;sample<4;sample++){
      const field=image_sampling_axes_placed(JSON.stringify(input),new Float64Array(n.matrix),new Float64Array(n.size),
        new Uint32Array([width,height]),paint,sample,0,new Int32Array([0,0]))
      if(!field.length||field[3]!==-1)throw Error(`Actual sample ${sample} no longer admits compact fields`)
      fieldProof.push({sample,components:field.length,sha256:sha256(new Uint8Array(field.buffer,field.byteOffset,field.byteLength))})
    }
  }finally{engine.free()}
  const prepared={nodeId,nodeName:authored.name,sceneSha256:sha256(sceneBytes),documentSha256:sha256(documentBytes),wasmSha256:sha256(wasm),
    radius,input,output,source,fieldProof,repeats,sourceVariant,warmupsPerRegion:1,
    timingContract:{
      primary:'One otherwise-idle production driver queue: upload uniforms and drain first, then submit this stage alone and await completion. CPU wall time, not hardware GPU timestamp duration.',
      source:sourceVariant === 'table' ? 'Actual full-support X table built once, then one resolveImageTable draw per strip. Complete table precomputation cost is separately reported.' : 'Actual production resolveFilterImageSample four times, retaining real interval masks, decoded 117 image and exact sample fields.',
      reference:'Top/middle/bottom source windows are newly computed with original mode2 -> mode3 over zero -> mode48, including original per-sample masks. Cross-variant bit parity is checked independently of within-variant repeat hashes.',
      horizontal:'Actual exactTentAxis on the just-produced source strip. Original mode0 copies assemble the horizontal plane outside timings.',
      vertical:'Actual exactTentAxis reads the completed real horizontal plane, with the original full 3484-row input window.',
      excluded:'Pipeline initialization, image/coordinate/kernel uploads in warmups, uniform upload drain, output readback/hash, prefix-counter mapping and plane assembly.',
      included:'Production render/compute commands, clear/load operations, queue submission and completion notification; encode time is reported separately.',
      limitations:'One real compiled crop and isolated filter chain, without ancestor destination planes or production memory-pressure cleanup. Stage sums describe this serial diagnostic only; they do not predict whole-editor speedup.',
    }}
  await proof.write('fixture-summary.json',prepared)
  if(proof.prepareOnly)return prepared
  const result=await proof.browser(async page=>{
    let progress=0
    await page.exposeFunction('real117StageProgress',async(value:unknown)=>proof.write(`progress-${String(++progress).padStart(2,'0')}.json`,value))
    return page.evaluate(async({scene,document,nodeId,radius,input,output,repeats,fieldProof,sourceVariant})=>{
      const {initializeKernelModule}=await import('/src/kernel/module.ts')
      const {VectorEngine}=await import('/src/generated/design-kernel/design_kernel.js')
      const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
      const {GpuRenderer}=await import('/src/kernel/gpu/renderer.ts')
      const {prefixAlignedStrip}=await import('/src/kernel/gpu/prefix-band.ts')
      const {parameters}=await import('/src/kernel/gpu/types.ts')
      const {planExactImageXTable}=await import('/src/kernel/gpu/exact-image-x-table.ts')
      const {fullSampleCoverage}=await import('/src/kernel/gpu/horizontal-filter-cache.ts')
      await initializeKernelModule()
      const engine=new VectorEngine();engine.load_document(JSON.stringify(document))
      const decoded=new Map<string,any>()
      const loader=(uri:string,byte=false,level=0)=>{
        if(byte||level!==0)throw Error('This probe requires the actual managed level-zero source')
        let value=decoded.get(uri)
        if(!value){const [width,height]=JSON.parse(engine.image_info(uri));value={width,height,pixels:engine.image_linear(uri)};decoded.set(uri,value)}
        return value
      }
      const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
      const renderer=new GpuRenderer(driver,true,false,loader,false,false) as any
      type Region={x:number;y:number;w:number;h:number}
      type Surface={rect:Region;texture:any}
      type Stage='source4'|'horizontal'|'vertical'
      type Row={stage:Stage;region:number;repeat:number;warmup:boolean;width:number;height:number;encodeMs:number;uniformUploadDrainMs:number;
        submitToCompletionMs:number;encodeThroughCompletionMs:number;draws:number;submissions:number;allocationDeltaBytes:number;
        acceptedLines?:number;declinedLines?:number;acceptedPixels?:number}
      const rows:Row[]=[],checks:any[]=[],fieldUploads=new Map<any,Float32Array>()
      const upload=driver.uploadParameters.bind(driver)
      driver.uploadParameters=(values:Float32Array,width:number,height:number)=>{const t=upload(values,width,height);fieldUploads.set(t,values.slice());return t}
      const digest=async(values:Float32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Float32Array(values).buffer)))
        .map(v=>v.toString(16).padStart(2,'0')).join('')
      const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2}
      const hashSurface=async(surface:Surface)=>digest(await driver.readSurface(surface.texture))
      let horizontal:Surface|undefined,final:Surface|undefined,maxTextureBytes=0,actualFields:any[]=[]
      let imageTable:import('/src/kernel/gpu/types.ts').ExactImageTable|undefined,tableBuild:any
      let maxTextureAndScratchBytes=0,maxScratchBytes=0
      const crossVariantChecks:any[]=[]
      const timed=async(stage:Stage,region:number,repeat:number,rect:Region,work:()=>Surface)=>{
        // Nothing from a previous stage may be included in this stage's wait.
        await driver.checkpoint('checkpoint')
        if(stage!=='source4'&&raw.prefix?.scratchBytes){raw.prefix.resetCounters(raw.encoder);await driver.checkpoint('checkpoint')}
        const beforeSubmissions=driver.commandSubmissions,beforeDraws=driver.drawCalls,beforeBytes=driver.stats().textureBytes
        const started=performance.now(),surface=work(),encodedAt=performance.now()
        if(driver.commandSubmissions!==beforeSubmissions)throw Error('A stage overflowed the bounded uniform arena and submitted before timing isolation')
        // Use the real driver's upload function, then drain only those queue
        // writes. No stage command buffer has been submitted at this point.
        raw.uploadUniforms();await raw.device.queue.onSubmittedWorkDone()
        const submittedAt=performance.now();await driver.checkpoint('checkpoint');const completedAt=performance.now()
        const afterBytes=driver.stats().textureBytes
        const row:Row={stage,region,repeat,warmup:repeat<0,width:rect.w,height:rect.h,encodeMs:encodedAt-started,
          uniformUploadDrainMs:submittedAt-encodedAt,submitToCompletionMs:completedAt-submittedAt,
          encodeThroughCompletionMs:completedAt-started,draws:driver.drawCalls-beforeDraws,
          submissions:driver.commandSubmissions-beforeSubmissions,allocationDeltaBytes:afterBytes-beforeBytes}
        if(row.submissions!==1)throw Error('Stage did not produce exactly one isolated submission')
        if(repeat>=0&&row.allocationDeltaBytes!==0)throw Error('Measured stage allocated an unwarmed texture')
        if(stage!=='source4'){
          if(!raw.prefix?.scratchBytes)throw Error('Actual high-radius filter did not reserve its production prefix path')
          raw.prefix.encodeCountersReadback(raw.encoder);await driver.checkpoint('checkpoint')
          Object.assign(row,await raw.prefix.readCounters())
        }
        maxTextureBytes=Math.max(maxTextureBytes,afterBytes)
        maxScratchBytes=Math.max(maxScratchBytes,driver.scratchBytes)
        maxTextureAndScratchBytes=Math.max(maxTextureAndScratchBytes,afterBytes+driver.scratchBytes)
        if(maxTextureAndScratchBytes>256*1024*1024)throw Error('Probe exceeded the 256 MiB texture/scratch budget')
        rows.push(row)
        if(raw.errors.length||driver.lost)throw Error(`GPU error: ${raw.errors.join('; ')}`)
        return surface
      }
      const report=async(stage:string,region:number)=>{
        await (globalThis as any).real117StageProgress({stage,region,rows:rows.length,latest:rows.slice(-8),maxTextureBytes})
      }
      try{
        if(raw.timingQueries)throw Error('Timestamp queries must stay disabled for this serial attribution')
        renderer.scene=scene;renderer.activeNode=nodeId
        await driver.prepareScene(scene);await driver.prepareFilters(true)
        const vertices=new Float32Array(scene.vertices),curves=new Float32Array(scene.curves)
        renderer.meshBits=new Uint32Array(vertices.buffer);renderer.curveBits=new Uint32Array(curves.buffer)
        driver.begin(vertices,curves)
        renderer.filterImageFields={rect:input,fields:new Map(),pinned:new Set()}
        horizontal=renderer.acquire({x:output.x,y:input.y,w:output.w,h:input.h});driver.clear(horizontal!.texture)
        final=renderer.acquire(output);driver.clear(final!.texture)
        await driver.checkpoint('checkpoint')
        const stripRows=prefixAlignedStrip(input.w),stripColumns=prefixAlignedStrip(input.h)
        const rowRegions:Region[]=[],columnRegions:Region[]=[]
        for(let y=input.y;y<input.y+input.h;y+=stripRows)rowRegions.push({x:input.x,y,w:input.w,h:Math.min(stripRows,input.y+input.h-y)})
        for(let x=output.x;x<output.x+output.w;x+=stripColumns)columnRegions.push({x,y:output.y,w:Math.min(stripColumns,output.x+output.w-x),h:output.h})
        const sourceOriginalFour=(region:Region)=>{
          let resolved:Surface|undefined
          for(let sample=0;sample<4;sample++){
            const next=renderer.resolveFilterImageSample(scene.nodes[nodeId],region,sample,resolved)
            if(!next)throw Error(`Actual image fusion gate declined sample ${sample}`)
            renderer.release(resolved);resolved=next
          }
          renderer.sampleIndex=undefined;return resolved!
        }
        // Initialize the actual image and four native full-support field
        // uploads before either timed variant. This warmup is not table build.
        const initialSource=sourceOriginalFour(rowRegions[0]);await driver.checkpoint('checkpoint');renderer.release(initialSource)
        const image=renderer.imageFor(scene.nodes[nodeId].fills[0].image,0,false,scene.nodes[nodeId].fills[0].adjust) as Surface
        const fields=[...renderer.filterImageFields.fields.values()] as Surface[]
        if(fields.length!==4||fields.some(field=>!field))throw Error('Four native full-support fields are required')
        if(sourceVariant==='table'){
          if(!fullSampleCoverage(scene.nodes[nodeId].fill,scene.curves,input))throw Error('Table requires exact full coverage')
          const range=driver.imageTableRange(image.texture)
          const axes=fields.map(field=>driver.imageTableAxes(field.texture))
          if(!range||axes.some(axis=>!axis))throw Error('Actual uploaded image/field certificates missing')
          const prepareStarted=performance.now()
          const plan=planExactImageXTable({axes:axes as Float32Array[],width:input.w,height:input.h,
            imageWidth:image.rect.w,imageHeight:image.rect.h,range})
          if(!plan)throw Error('Native source table plan rejected; fallback is not a measured candidate')
          const plannedAt=performance.now(),beforeScratch=driver.scratchBytes,beforeSubmissions=driver.commandSubmissions
          imageTable=await driver.prepareImageTable(image.texture,plan,renderer.frameBudget-renderer.workingBytes)
          const encodedAt=performance.now()
          if(!imageTable||driver.commandSubmissions!==beforeSubmissions)throw Error('Table build did not remain an isolated admitted command')
          renderer.bytes+=driver.scratchBytes-beforeScratch
          await raw.device.queue.onSubmittedWorkDone()
          const submittedAt=performance.now();await driver.checkpoint('checkpoint');const completedAt=performance.now()
          tableBuild={planMs:plannedAt-prepareStarted,pipelineAllocationUploadEncodeMs:encodedAt-plannedAt,
            uploadDrainMs:submittedAt-encodedAt,buildSubmitToCompletionMs:completedAt-submittedAt,
            totalPrecomputeMs:completedAt-prepareStarted,submissions:driver.commandSubmissions-beforeSubmissions,
            tableBytes:plan.tableBytes,allocatedBytes:imageTable.bytes,rowMin:plan.rowMin,rowCount:plan.rowCount,
            maxKx:plan.maxKx,maxKy:plan.maxKy}
          if(tableBuild.submissions!==1)throw Error('Table build must have exactly one standalone submission')
        }
        const sourceFour=(region:Region):Surface=>{
          if(!imageTable)return sourceOriginalFour(region)
          const surface=renderer.acquire(region)
          const before=driver.drawCalls
          driver.resolveImageTable(surface.texture,imageTable,region.x-input.x,region.y-input.y)
          if(driver.drawCalls-before!==1)throw Error('Table source did not encode its one real draw')
          return surface
        }
        const originalReference=(region:Region):Surface=>{
          // This oracle never calls mode51 or the X-table sampler.
          const empty=renderer.acquire(region);driver.clear(empty.texture)
          let resolved:Surface|undefined
          for(let sample=0;sample<4;sample++){
            const mask=renderer.acquire(region,true);driver.maskRegion!(scene.nodes[nodeId].fill,mask.texture,sample,region)
            const paint=renderer.run(2,region,[mask,image,mask,fields[sample]],(u:Float32Array)=>{
              u[28]=3;u[32]=1;u[241]=1;u.set([input.x,input.y],204)
            })
            const over=renderer.run(3,region,[paint,empty],(u:Float32Array)=>u.set([3,0,1,0],16))
            const next=renderer.run(48,region,[over,resolved||empty],(u:Float32Array)=>{u[17]=sample})
            renderer.release(mask,paint,over,resolved);resolved=next
          }
          renderer.release(empty);return resolved!
        }
        for(const [index,region] of rowRegions.entries()){
          const hRect={x:output.x,y:region.y,w:output.w,h:region.h},check=[0,Math.floor(rowRegions.length/2),rowRegions.length-1].includes(index)
          let sourceHash:string|undefined,horizontalHash:string|undefined,referenceHash:string|undefined
          if(check){
            const before=driver.drawCalls,reference=originalReference(region)
            if(driver.drawCalls-before!==16)throw Error('Original reference requires four masks and twelve ordered passes')
            referenceHash=await hashSurface(reference);renderer.release(reference)
          }
          for(let repeat=-1;repeat<repeats;repeat++){
            const source=await timed('source4',index,repeat,region,()=>sourceFour(region))
            if(check&&(repeat===-1||repeat===repeats-1)){
              const hash=await hashSurface(source)
              if(sourceHash&&hash!==sourceHash)throw Error(`Source raw f32 output changed on repeat at row ${index}`)
              if(hash!==referenceHash)throw Error(`Source variant ${sourceVariant} differs from original paint/over/resolve at row ${index}`)
              crossVariantChecks.push({variant:sourceVariant,region:index,repeat,components:region.w*region.h*4,
                reference:'original-mode2-mode3-mode48-with-four-masks',referenceSha256:referenceHash,candidateSha256:hash,different:0})
              sourceHash=hash;checks.push({stage:'source4',region:index,repeat,components:region.w*region.h*4,sha256:hash})
            }
            const h=await timed('horizontal',index,repeat,hRect,()=>renderer.exactTentAxis(source,radius,0,hRect))
            renderer.release(source)
            if(check&&(repeat===-1||repeat===repeats-1)){
              const hash=await hashSurface(h)
              if(horizontalHash&&hash!==horizontalHash)throw Error(`Horizontal raw f32 output changed on repeat at row ${index}`)
              horizontalHash=hash;checks.push({stage:'horizontal',region:index,repeat,components:hRect.w*hRect.h*4,sha256:hash})
            }
            if(repeat===repeats-1){
              const u=parameters(horizontal!.rect,h.rect);u[16]=0
              driver.pass(horizontal!.texture,u,[h.texture],{x:0,y:region.y-input.y,w:output.w,h:region.h})
              await driver.checkpoint('checkpoint')
            }
            renderer.release(h)
          }
          if(index===0){
            const fields=[...renderer.filterImageFields.fields.values()] as (Surface|null)[]
            if(fields.length!==4||fields.some(field=>!field))throw Error('Actual source did not use four full-support fields')
            actualFields=await Promise.all(fields.map(async(field,sample)=>{
              const values=fieldUploads.get(field!.texture);if(!values)throw Error('Missing actual coordinate upload capture')
              const sha256=await digest(values),expected=fieldProof[sample] as any
              if(sha256!==expected.sha256||values.length!==expected.components)throw Error('Actual renderer field differs from prepared native metadata')
              return {sample,components:values.length,width:field!.texture.width,height:field!.texture.height,sha256}
            }))
          }
          if(index%8===0||index===rowRegions.length-1)await report('source+horizontal',index)
        }
        const horizontalSha256=await hashSurface(horizontal!)
        for(const [index,region] of columnRegions.entries()){
          const check=[0,Math.floor(columnRegions.length/2),columnRegions.length-1].includes(index)
          let reference:string|undefined
          for(let repeat=-1;repeat<repeats;repeat++){
            const v=await timed('vertical',index,repeat,region,()=>renderer.exactTentAxis(horizontal!,radius,1,region))
            if(check&&(repeat===-1||repeat===repeats-1)){
              const hash=await hashSurface(v)
              if(reference&&hash!==reference)throw Error(`Vertical raw f32 output changed on repeat at column ${index}`)
              reference=hash;checks.push({stage:'vertical',region:index,repeat,components:region.w*region.h*4,sha256:hash})
            }
            if(repeat===repeats-1){const u=parameters(output,v.rect);u[16]=0
              driver.pass(final!.texture,u,[v.texture],{x:region.x-output.x,y:0,w:region.w,h:region.h});await driver.checkpoint('checkpoint')}
            renderer.release(v)
          }
          if(index%4===0||index===columnRegions.length-1)await report('vertical',index)
        }
        const finalSha256=await hashSurface(final!)
        const summaries=(['source4','horizontal','vertical'] as Stage[]).map(stage=>{
          const measured=rows.filter(row=>row.stage===stage&&!row.warmup),regions=[...new Set(measured.map(row=>row.region))]
          const perRepeat=Array.from({length:repeats},(_,repeat)=>{
            const selected=measured.filter(row=>row.repeat===repeat)
            return {repeat,encodeMs:selected.reduce((sum,row)=>sum+row.encodeMs,0),
              uniformUploadDrainMs:selected.reduce((sum,row)=>sum+row.uniformUploadDrainMs,0),
              submitToCompletionMs:selected.reduce((sum,row)=>sum+row.submitToCompletionMs,0),
              acceptedLines:selected.reduce((sum,row)=>sum+(row.acceptedLines||0),0),
              declinedLines:selected.reduce((sum,row)=>sum+(row.declinedLines||0),0)}
          })
          return {stage,regions:regions.length,samples:measured.length,perRepeat,
            medianSerialTotalMs:median(perRepeat.map(row=>row.submitToCompletionMs)),
            sumOfRegionMediansMs:regions.reduce((sum,region)=>sum+median(measured.filter(row=>row.region===region).map(row=>row.submitToCompletionMs)),0),
            medianEncodeTotalMs:median(perRepeat.map(row=>row.encodeMs)),
            drawsPerRepeat:measured.filter(row=>row.repeat===0).reduce((sum,row)=>sum+row.draws,0)}
        })
        const finishingScratch=driver.scratchBytes
        await driver.finish(final!.texture,output,output.w,output.h,false,undefined,false)
        renderer.bytes+=driver.scratchBytes-finishingScratch
        return {status:'passed',adapter:driver.stats().adapter,timestampQueriesUsed:false,stripRows,stripColumns,
          actualFields,horizontalSha256,finalSha256,maxTextureBytes,maxScratchBytes,maxTextureAndScratchBytes,rows,summaries,checks,sourceVariant,tableBuild,crossVariantChecks,
          sourceSamplePixelVisits:input.w*input.h*4,horizontalOutputPixels:output.w*input.h,verticalOutputPixels:output.w*output.h,
          sourceScope:'One saved real 117 high-zoom crop; exact production methods and actual image, geometry and coordinate fields; no synthetic pixels'}
      }catch(error){
        await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{})
        return {status:'failed',error:String(error),rows,checks,actualFields,maxTextureBytes,maxScratchBytes,maxTextureAndScratchBytes,sourceVariant,tableBuild,crossVariantChecks}
      }finally{renderer.dispose();engine.free()}
    },{scene,document,nodeId,radius,input,output,repeats,fieldProof,sourceVariant})
  })
  await proof.write('gpu-result.json',result)
  if(result.status!=='passed')throw Error(result.error||'Real 117 stage attribution failed')
  return {...prepared,...result}
})
