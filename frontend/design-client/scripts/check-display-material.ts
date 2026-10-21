/** Actual native PNG decode/upload -> two production WebGPU renderers.
 * A finish observer reads the real raw target while both product renders still
 * use readback=false,present=true. These proof-only waits are not latency data.
 * The candidate is approximate: fixed screen-byte bounds are not bit parity.
 * Run only in the coordinated GPU window with VITE_DESIGN_DISPLAY_MATERIAL_SOURCE=1. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, VectorEngine, encode_png_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'
import { fullSampleCoverage } from '../src/kernel/gpu/horizontal-filter-cache'
import { sceneScale } from '../src/kernel/gpu/scene-index'
import { intersect } from '../src/kernel/gpu/types'

if (process.env.VITE_DESIGN_DISPLAY_MATERIAL_SOURCE !== '1') throw Error('Set only VITE_DESIGN_DISPLAY_MATERIAL_SOURCE=1 for this candidate proof')
for (const flag of ['VITE_DESIGN_SEQUENTIAL_DISPLAY','VITE_DESIGN_SHARP_ZOOM','VITE_DESIGN_GESTURE_DENSITY_HEADROOM',
  'VITE_DESIGN_ORIGINAL_VIEWPORT_CAPTURE','VITE_DESIGN_DISPLAY_IMAGE_SOURCE','VITE_DESIGN_DESKTOP_IMAGE_SOURCE',
  'VITE_DESIGN_DESKTOP_DISPLAY','VITE_DESIGN_DISPLAY_FILTERS','VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE'])
  if (process.env[flag] && process.env[flag] !== '0') throw Error(`${flag} must remain off`)

type Fixture = { label:string; pattern:string; radius:number; zoom:number; transparentSource:boolean;
  edge:boolean; rotated:boolean; expected:'required'|'rejected'|'observe'; document:any; options:any; pngSha256:string }
const LIMITS = Object.freeze({ maximumRgba8:8, meanRgb8:1, meanAlpha8:1 })
await runProof('futureox-display-material-quality',[],async proof=>{
  const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
  const color={documentSpace:'srgb-linear' as const,referenceWhiteNits:203,peakLuminanceNits:1000}
  const sourceWidth=192,sourceHeight=192,width=64,height=48,fixtures:Fixture[]=[]
  const pngs=new Map<string,{uri:string;sha256:string}>()
  for(const pattern of ['photo-gradient','checkerboard','checkerboard-3px','impulse','transparent']) {
    const rgba=new Uint8Array(sourceWidth*sourceHeight*4)
    for(let y=0;y<sourceHeight;y++)for(let x=0;x<sourceWidth;x++) {
      const at=(y*sourceWidth+x)*4,u=x/(sourceWidth-1),v=y/(sourceHeight-1)
      const block=pattern==='checkerboard-3px'?3:1,bright=(Math.floor(x/block)+Math.floor(y/block))%2
      const rgb=pattern.startsWith('checkerboard') ? [bright?238:17,bright?25:224,bright?177:48] :
        pattern==='impulse' ? [x===96&&y===96?255:0,x===96&&y===96?255:0,x===96&&y===96?255:0] :
        [Math.round(28+174*u+18*Math.sin(v*Math.PI)),Math.round(34+157*v+20*u*v),Math.round(42+136*(u+v)/2+17*Math.cos(u*Math.PI))]
      rgba.set([...rgb,pattern==='transparent'&&x%7===0?127:255],at)
    }
    const png=encode_png_rgba(sourceWidth,sourceHeight,rgba)
    pngs.set(pattern,{uri:'data:image/png;base64,'+Buffer.from(png).toString('base64'),sha256:sha256(png)})
  }
  const add=(pattern:string,radius:number,zoom:number,edge=false,rotated=false,expected:Fixture['expected']='required')=>{
    const source=pngs.get(pattern)!,angle=rotated?17*Math.PI/180:0,c=Math.cos(angle),s=Math.sin(angle),center=sourceWidth/2
    const label=[pattern,radius,zoom,edge?'edge':'interior',rotated?'rotated':'axis'].join('/')
    const document={schemaVersion:5,id:'material-quality',name:'Procedural real PNG quality fixture',colorManagement:color,
      pages:[{id:'p',name:'p',children:['image'],background:'#000000'}],nodes:{image:{id:'image',kind:'vector',
        width:sourceWidth,height:sourceHeight,transform:[c,s,-s,c,center-c*center+s*center,center-s*center-c*center],
        visible:true,opacity:1,blend:'normal',children:[],strokes:[],clip:false,mask:false,
        // A real one-pixel corner chamfer keeps the central image/halo fully
        // covered while using the same generic path interval program as the
        // measured source document. Four-corner vectors also become tag 4.
        network:{fillRule:'nonzero',vertices:[[1,0],[191,0],[192,1],[192,191],[191,192],[1,192],[0,191],[0,1]]
          .map(([x,y],i)=>({id:`v${i}`,x,y})),
          edges:Array.from({length:8},(_,i)=>({id:`e${i}`,from:`v${i}`,to:`v${(i+1)%8}`}))},
        fills:[{kind:'image',image:source.uri,fit:'cover',color:'#ffffff',opacity:1,blend:'normal',visible:true}],
        effects:[{kind:'blur',visible:true,radius,x:0,y:0,spread:0,color:'#000000',opacity:1,amount:0}]}}}
    const options={pageId:'p',width,height,view:{x:width/2-(edge?1:center)*zoom,y:height/2-center*zoom,zoom},
      transparent:true,grid:false,rasterProfile:'figmaSubpixel',gpuViewport:{x:0,y:0,w:width,h:height}}
    fixtures.push({label,pattern,radius,zoom,transparentSource:pattern==='transparent',edge,rotated,expected,document,options,pngSha256:source.sha256})
  }
  for(const pattern of ['photo-gradient','checkerboard','checkerboard-3px','impulse'])for(const zoom of [.5,1,2,8,32])add(pattern,2,zoom)
  for(const pattern of ['photo-gradient','checkerboard','checkerboard-3px','impulse'])for(const zoom of [.5,1,32])add(pattern,.25,zoom,false,false,'observe')
  for(const zoom of [.5,1,8,32])add('photo-gradient',2,zoom,true,false,'rejected')
  for(const zoom of [1,8])add('photo-gradient',2,zoom,false,true,'rejected')
  for(const zoom of [1,8])add('transparent',2,zoom,false,false,'rejected')
  const preparationFailures:any[]=[]
  const prepared=fixtures.map(f=>{
    const kernel=new VectorEngine()
    try {
      kernel.load_document(JSON.stringify(f.document))
      const native=kernel.compile_gpu(JSON.stringify(f.options)),scene=JSON.parse(native)
      if(!scene.floatCompositing||!scene.coherentSamples||!scene.integratedBlur||scene.resolve||scene.presentation)
        throw Error(`${f.label}: unexpected native four-phase scene`)
      const output=scene.output
      if(!output||output.x!==0||output.y!==0||output.w!==width||output.h!==height)
        throw Error(`${f.label}: native compilation did not retain the requested production GPU ROI`)
      const node=scene.nodes.image,visible=intersect(node.rect,scene.extent)
      const reach=Math.ceil(node.effects.find((fx:any)=>fx.visible).radius*sceneScale(node.matrix))+1
      const input=intersect(node.rect,{x:visible.x-reach,y:visible.y-reach,w:visible.w+reach*2,h:visible.h+reach*2})
      const coverage={tag:node.fill.area?scene.curves[node.fill.area.first*4]:null,sampleCount:node.fill.sampleCount,
        predictedProductionInput:input,fullSampleCoverage:fullSampleCoverage(node.fill,scene.curves,input),
        requestedRows:input.h,coveredFourPhaseRows:Array.from({length:input.h},(_,row)=>
          fullSampleCoverage(node.fill,scene.curves,{...input,y:input.y+row,h:1})).filter(Boolean).length}
      if(f.expected==='required'&&(coverage.tag!==3||!coverage.fullSampleCoverage))
        preparationFailures.push({label:f.label,kind:'native-required-interval-coverage-not-proven',coverage})
      const uri=f.document.nodes.image.fills[0].image,pixels=kernel.image_linear(uri)
      return {...f,nativeSceneSha256:sha256(native),decodedImageSha256:sha256(new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength)),
        output,coverage,sceneSummary:{version:scene.version,width:scene.width,height:scene.height,extent:scene.extent,output,
          compiledNodes:Object.keys(scene.nodes).length,nodeRect:scene.nodes.image?.rect,
          nodeMatrix:scene.nodes.image?.matrix,nodeSize:scene.nodes.image?.size}}
    } finally {kernel.free()}
  })
  const manifest={cases:prepared.length,wasmSha256:sha256(wasm),limits:LIMITS,
    thresholdsFixedBeforeObservation:true,flag:'VITE_DESIGN_DISPLAY_MATERIAL_SOURCE=1',
    source:'Procedurally encoded real PNGs with native decode and production GPU upload; photo-like smooth field, one-pixel and three-pixel-block checkerboards and impulse. No uploaded hand-made float certificate.',
    informationGate:'Required photo-gradient, three-pixel-block checkerboard and impulse cases must have nonconstant actual reference RGB bytes and finite positive alpha. The one-pixel checker remains a valid frequency-removal case, explicitly not a discriminating color-variation witness.',
    scope:'Approximate display-source blur only. Both renderers receive the identical native scene and present-only flags. Explicit proof target reads add GPU synchronization and cannot measure interaction latency. The independent reference is the original four-phase exact GPU renderer; no CPU raster substitutes for either output.'}
  await proof.write('fixtures.json',{...manifest,preparationFailures,cases:prepared.map(({document,options,...row})=>({...row,options,documentSha256:sha256(JSON.stringify(document))}))})
  if(preparationFailures.length)throw Error(`Required real native interval coverage failed for ${preparationFailures.length} fixtures; inspect fixtures.json`)
  if(proof.prepareOnly)return{...manifest,gpuExecuted:false}
  const measured=await proof.browser(page=>page.evaluate(async({fixtures,manifest,color})=>{
    const {initializeKernelModule}=await import('/src/kernel/module.ts')
    const {VectorEngine,color_encode_rgba8}=await import('/src/generated/design-kernel/design_kernel.js')
    const {createGpu}=await import('/src/kernel/gpu/factory.ts')
    const {fullSampleCoverage}=await import('/src/kernel/gpu/horizontal-filter-cache.ts')
    type Scene=import('/src/kernel/gpu/types').GpuScene
    type Rect=import('/src/kernel/gpu/types').Rect
    type Driver=import('/src/kernel/gpu/webgpu').WebGpuDriver
    await initializeKernelModule()
    const digest=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(value).buffer)))
      .map(value=>value.toString(16).padStart(2,'0')).join('')
    const rawDigest=(values:Float32Array)=>digest(new Uint8Array(values.buffer,values.byteOffset,values.byteLength))
    const crop=(values:Float32Array,source:Rect,target:Rect)=>{
      if(values.length!==source.w*source.h*4||target.x<source.x||target.y<source.y||
          target.x+target.w>source.x+source.w||target.y+target.h>source.y+source.h)throw Error('Native physical ROI absent from observed target')
      const output=new Float32Array(target.w*target.h*4),bits=new Uint32Array(output.buffer),input=new Uint32Array(values.buffer,values.byteOffset,values.length)
      for(let y=0;y<target.h;y++) {
        const start=((target.y-source.y+y)*source.w+target.x-source.x)*4
        bits.set(input.subarray(start,start+target.w*4),y*target.w*4)
      }
      return output
    }
    const compare=async(reference:Float32Array,actual:Float32Array)=>{
      if(reference.length!==actual.length)throw Error('Missing raw GPU components')
      let maximumRgba8=0,sumRgb8=0,sumAlpha8=0,nonfinite=0,rawDifferences=0,referenceNonfinite=0,positiveAlphaPixels=0
      const rawMinimum=[Infinity,Infinity,Infinity,Infinity],rawMaximum=[-Infinity,-Infinity,-Infinity,-Infinity]
      const aa=new Uint32Array(reference.buffer,reference.byteOffset,reference.length),bb=new Uint32Array(actual.buffer,actual.byteOffset,actual.length)
      for(let i=0;i<reference.length;i++) {
        if(!Number.isFinite(reference[i])||!Number.isFinite(actual[i]))nonfinite++
        if(Number.isFinite(reference[i])) {
          rawMinimum[i%4]=Math.min(rawMinimum[i%4],reference[i]);rawMaximum[i%4]=Math.max(rawMaximum[i%4],reference[i])
          if(i%4===3&&reference[i]>0)positiveAlphaPixels++
        } else referenceNonfinite++
        if(aa[i]!==bb[i])rawDifferences++
      }
      const referenceInformation={rawMinimum:rawMinimum.map(value=>Number.isFinite(value)?value:null),
        rawMaximum:rawMaximum.map(value=>Number.isFinite(value)?value:null),
        rawSpan:rawMaximum.map((value,index)=>Number.isFinite(value)&&Number.isFinite(rawMinimum[index])?value-rawMinimum[index]:null),
        referenceNonfinite,positiveAlphaPixels,pixels:reference.length/4}
      const hashes={referenceRawSha256:await rawDigest(reference),actualRawSha256:await rawDigest(actual)}
      // Invalid raw values fail as quality evidence, before the product codec
      // rejects them. Preserve the remaining fixture observations for review.
      if(nonfinite)return {components:reference.length,maximumRgba8:null,meanRgb8:null,meanAlpha8:null,
        rawDifferences,nonfinite,...hashes,referenceInformation:{...referenceInformation,rgba8Available:false,nonconstantRgb8:false},passed:false}
      const a=color_encode_rgba8(reference,JSON.stringify(color)),b=color_encode_rgba8(actual,JSON.stringify(color))
      const minimum=[255,255,255,255],maximum=[0,0,0,0]
      for(let i=0;i<reference.length;i++) {
        minimum[i%4]=Math.min(minimum[i%4],a[i]);maximum[i%4]=Math.max(maximum[i%4],a[i])
        const delta=Math.abs(a[i]-b[i]);maximumRgba8=Math.max(maximumRgba8,delta)
        if(i%4===3)sumAlpha8+=delta;else sumRgb8+=delta
      }
      const span=maximum.map((value,index)=>value-minimum[index])
      const meanRgb8=sumRgb8/(reference.length/4*3),meanAlpha8=sumAlpha8/(reference.length/4)
      return {components:reference.length,maximumRgba8,meanRgb8,meanAlpha8,rawDifferences,nonfinite,
        ...hashes,referenceInformation:{...referenceInformation,rgba8Available:true,minimum,maximum,span,nonconstantRgb8:span.slice(0,3).some(value=>value>0)},
        referenceRgba8Sha256:await digest(a),actualRgba8Sha256:await digest(b),
        passed:!nonfinite&&maximumRgba8<=manifest.limits.maximumRgba8&&meanRgb8<=manifest.limits.meanRgb8&&meanAlpha8<=manifest.limits.meanAlpha8}
    }
    const records:any[]=[],boundaries:any[]=[],failures:any[]=[],adapters=new Set<string>()
    let proofReadbackBytes=0,candidateBuilds=0,candidateHits=0,rejectedFixtures=0
    for(const f of fixtures) {
      const kernel=new VectorEngine();let exact:any,candidate:any,restoreExact:(()=>void)|undefined,restoreCandidate:(()=>void)|undefined
      try {
        kernel.load_document(JSON.stringify(f.document))
        const native=kernel.compile_gpu(JSON.stringify(f.options))
        if(await digest(new TextEncoder().encode(native))!==f.nativeSceneSha256)throw Error('Browser native scene hash changed')
        const original=JSON.parse(native) as Scene,callerBefore=JSON.stringify(original),cache=new Map<string,any>()
        if(!original.output||Object.keys(f.output).some(key=>(original.output as any)[key]!==f.output[key]))
          throw Error('Browser native ROI differs from the bound production GPU ROI')
        const loader=(uri:string,byte=false,level=0)=>{
          if(level!==0)throw Error('Proof cannot silently select a mip level')
          const key=JSON.stringify([uri,byte]);let image=cache.get(key)
          if(!image){const[width,height]=JSON.parse(kernel.image_info(uri));image={width,height,pixels:kernel.image_linear(uri),
            ...(byte?{bytes:kernel.image_rgba8(uri)}:{})};cache.set(key,image)}return image
        }
        const image=loader(f.document.nodes.image.fills[0].image)
        if(await rawDigest(image.pixels)!==f.decodedImageSha256)throw Error('Native PNG decode did not match bound input')
        exact=await createGpu('webgpu',true,false,color,loader,false,true,false,false,false)
        candidate=await createGpu('webgpu',true,false,color,loader,false,true,false,false,false)
        if(exact.driver===candidate.driver)throw Error('Two live proof renderers unexpectedly share one driver')
        const instrument=(renderer:any)=>{
          const driver=renderer.driver as Driver,finish=driver.finish,prepare=driver.prepareScene
          const resolveMaterial=renderer.resolveDisplayMaterial,materialCalls:any[]=[]
          if(typeof resolveMaterial!=='function')throw Error('Production display-material admission method unavailable')
          renderer.resolveDisplayMaterial=async(...args:any[])=>{
            const[node,input,output]=args;let returned=false
            try {const result=await resolveMaterial.apply(renderer,args);returned=!!result;return result}
            finally {
              const paint=node.fills.find((paint:any)=>paint.visible&&paint.kind==='image')
              const source=paint?.image?renderer.images.get(paint.image):undefined
              const range=source?driver.imageTableRange(source.texture):undefined
              materialCalls.push({input:{...input},output:{...output},nodeRect:{...node.rect},nodeSize:[...node.size],
                matrix:[...node.matrix],inverse:[...node.inverse],effectRadius:node.effects.find((fx:any)=>fx.visible)?.radius,
                actualSceneMaterialRequested:renderer.scene?.displayMaterialSource===true,
                actualSceneCoherentSamples:renderer.scene?.coherentSamples===true,actualSceneIntegratedBlur:renderer.scene?.integratedBlur===true,
                actualIntervalTag:node.fill.area?renderer.scene?.curves[node.fill.area.first*4]:null,
                actualSampleCount:node.fill.sampleCount,
                actualFullSampleCoverage:fullSampleCoverage(node.fill,renderer.scene?.curves,input),
                actualSourceSize:source?[source.texture.width,source.texture.height]:null,
                actualUploadRangePresent:!!range,actualUploadOpaqueAlpha:range?.opaqueAlpha??null,
                actualUploadNonnegativeRgb:range?.nonnegativeRgb??null,actualUploadMaximumExponents:range?[...range.maximum]:null,
                returnedMaterial:returned,meaning:'Observed production method arguments and actual driver upload-range query; no certificate was created by this observer.'})
            }
          }
          let observed:Float32Array|undefined,expectedFlags:[boolean,boolean]=[false,true],prepared:Scene|undefined
          driver.prepareScene=async(scene:Scene)=>{prepared=scene;return prepare.call(driver,scene)}
          driver.finish=async(...args:Parameters<Driver['finish']>)=>{
            if(args[4]!==expectedFlags[0]||args[6]!==expectedFlags[1])throw Error('Observer changed actual render admission flags')
            const values=await driver.readSurface(args[0]);proofReadbackBytes+=values.byteLength
            observed=crop(values,args[1],f.output);return finish.apply(driver,args)
          }
          return {driver,restore:()=>{driver.finish=finish;driver.prepareScene=prepare;renderer.resolveDisplayMaterial=resolveMaterial},run:async(scene:Scene,readback=false,present=true)=>{
            const materialStart=materialCalls.length
            expectedFlags=[readback,present];observed=undefined
            const result=await renderer.render(scene,readback,present)
            result.bitmap?.close();if(result.gpuTile)driver.releasePresented?.([result.gpuTile])
            if(result.backend!=='webgpu'||driver.lost||!observed)throw Error('Actual production GPU target was not observed')
            return {pixels:observed,result,prepared,policy:renderer.memoryPolicy(),
              materialAttemptCount:materialCalls.length-materialStart,materialAttemptSamples:materialCalls.slice(materialStart,materialStart+4)}
          }}
        }
        const reference=instrument(exact);restoreExact=reference.restore
        const screen=instrument(candidate);restoreCandidate=screen.restore
        adapters.add(reference.driver.description);adapters.add(screen.driver.description)
        let previousBuilds=0,previousHits=0
        for(let repeat=0;repeat<2;repeat++) {
          const a=await reference.run({...original,displayMaterialSource:false})
          const b=await screen.run({...original,displayMaterialSource:true})
          const builds=b.policy.displayMaterialBuilds-previousBuilds,hits=b.policy.displayMaterialHits-previousHits
          previousBuilds=b.policy.displayMaterialBuilds;previousHits=b.policy.displayMaterialHits
          candidateBuilds+=builds;candidateHits+=hits
          const quality=await compare(a.pixels,b.pixels)
          const requiredInformative=f.expected==='required'&&f.pattern!=='checkerboard'
          const informative=quality.referenceInformation.nonconstantRgb8&&quality.referenceInformation.referenceNonfinite===0&&
            quality.referenceInformation.positiveAlphaPixels===quality.referenceInformation.pixels
          records.push({label:f.label,sourcePattern:f.pattern,repeat,expected:f.expected,requiredInformative,informative,
            informationRole:f.pattern==='checkerboard'?'frequency-removal case; may legitimately become constant':'actual reference information witness',
            builds,hits,cacheBytes:b.policy.displayMaterialBytes,materialAttemptCount:b.materialAttemptCount,
            materialAttemptSamples:b.materialAttemptSamples,...quality})
          if(requiredInformative&&!informative)failures.push({label:f.label,repeat,kind:'uninformative-actual-reference',referenceInformation:quality.referenceInformation})
          if(!quality.passed)failures.push({label:f.label,repeat,kind:'screen-byte-quality',...quality})
          if(f.expected==='rejected'&&(builds||hits||quality.rawDifferences))failures.push({label:f.label,repeat,kind:'rejection-did-not-preserve-exact-fallback'})
          if(f.expected==='required'&&(repeat===0?builds!==1:hits<1))failures.push({label:f.label,repeat,kind:'candidate-build-or-cache-hit-not-executed',builds,hits})
        }
        if(f.expected==='rejected')rejectedFixtures++
        // Warm candidates must clear intent and residency for actual readback
        // or non-present work. These compare against GPU exact raw words.
        if(f.pattern==='photo-gradient'&&!f.edge&&!f.rotated&&f.radius===2&&f.zoom===1) {
          for(const [readback,present] of [[true,true],[false,false]] as const) {
            const beforeWarm=candidate.memoryPolicy()
            await screen.run({...original,displayMaterialSource:true})
            const warmed=candidate.memoryPolicy()
            candidateBuilds+=warmed.displayMaterialBuilds-beforeWarm.displayMaterialBuilds
            candidateHits+=warmed.displayMaterialHits-beforeWarm.displayMaterialHits
            const before=candidate.memoryPolicy(),a=await reference.run({...original,displayMaterialSource:false},readback,present)
            const b=await screen.run({...original,displayMaterialSource:true},readback,present),after=candidate.memoryPolicy(),quality=await compare(a.pixels,b.pixels)
            const off=b.prepared?.displayMaterialSource===false&&after.displayMaterialBytes===0&&
              after.displayMaterialBuilds===before.displayMaterialBuilds&&after.displayMaterialHits===before.displayMaterialHits
            boundaries.push({readback,present,candidateStrictlyOff:off,...quality})
            if(!off||quality.rawDifferences||quality.nonfinite)failures.push({kind:'exact-output-boundary',readback,present,...quality})
          }
        }
        if(JSON.stringify(original)!==callerBefore)throw Error('Renderer mutated caller-owned native scene')
      } finally {
        // Drivers may be parked and revived by the next fixture. Retire only
        // proof observers before disposal, preserving the real method objects
        // and product parking policy rather than stacking old closures.
        restoreExact?.();restoreCandidate?.()
        exact?.dispose();candidate?.dispose();kernel.free()
      }
    }
    if(!candidateBuilds||!candidateHits||rejectedFixtures<1||boundaries.length!==2)
      failures.push({kind:'required-actual-gpu-coverage-not-executed',candidateBuilds,candidateHits,rejectedFixtures,exactBoundaryObservations:boundaries.length})
    return {gpuExecuted:true,backend:'webgpu',adapters:[...adapters],
      cases:fixtures.length,frames:records.length,proofReadbackBytes,candidateBuilds,candidateHits,rejectedFixtures,
      records,boundaries,failures,passed:failures.length===0}
  },{fixtures:prepared,manifest,color}))
  await proof.write('quality-results.json',{...manifest,...measured})
  if(!measured.passed)throw Error(`Display material fixed quality gates failed in ${measured.failures.length} observations; inspect quality-results.json`)
  return {...manifest,...measured}
})
