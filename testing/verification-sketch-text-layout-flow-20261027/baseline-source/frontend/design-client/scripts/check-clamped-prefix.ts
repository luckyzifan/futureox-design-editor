/** Real GPU raw-f32 oracle. Reference deliberately omits the prefix filter
 * contract and executes the original scalar mode22 reducer on the same source.
 * This is an operator/addressing proof, never a whole-editor latency result. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { prefixRationalUnsupported, certifyPrefixRationalBound } from '../src/kernel/gpu/prefix-preflight'
import { prefixSamplingGeometry } from '../src/kernel/gpu/prefix-sampling-geometry'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'

if(process.env.VITE_DESIGN_EXACT_CLAMP_PREFIX!=='1')throw Error('Set VITE_DESIGN_EXACT_CLAMP_PREFIX=1')
if(process.env.VITE_DESIGN_PREFIX_TIGHT_BOUND==='1')throw Error('This oracle independently classifies the default row bound; keep PREFIX_TIGHT_BOUND off')
type Fixture={name:string;axis:0|1;radius:number;source:{x:number;y:number;w:number;h:number};
  output:{x:number;y:number;w:number;h:number};words:number[];kernel:number[];certified:number[];
  admission:ReturnType<typeof classifyAdmission>}
/** Independent CPU application of the existing shader's default row bounds.
 * This predicts admission; GPU counters expose only accepted/declined totals,
 * not per-line reason codes. Do not relabel a predicted reason as measured. */
function classifyAdmission(f:{axis:0|1;radius:number;source:{x:number;y:number;w:number;h:number};
  output:{x:number;y:number;w:number;h:number};words:number[];kernel:Uint8Array}){
  const k=new DataView(f.kernel.buffer,f.kernel.byteOffset,f.kernel.byteLength),cw=k.getUint32(0,true),reach=k.getUint32(8,true)
  const coefficient=(distance:number)=>{let value=0n;for(let i=cw-1;i>=0;i--)value=value<<32n|BigInt(k.getUint32((4+cw*(1+distance)+i)*4,true));return value}
  let denominator=0n;for(let i=cw-1;i>=0;i--)denominator=denominator<<32n|BigInt(k.getUint32((4+i)*4,true))
  const high=(value:bigint)=>value===0n?-1:value.toString(2).length-1
  const center=coefficient(0),slope=coefficient(1)-coefficient(2)
  const u=new Float32Array(256);u.set([f.output.x,f.output.y,f.output.w,f.output.h]);u.set([f.source.x,f.source.y,f.source.w,f.source.h],4);u[37]=f.axis;u[38]=1
  const geometry=prefixSamplingGeometry(u,f.radius,true),window=Math.min(geometry?.length||0,2*reach+1)
  const windowBits=window>0?Math.floor(Math.log2(window))+1:0
  const weightedBits=Math.max(high(center)+windowBits+3,high(slope)+2*windowBits+4)
  const rational=!Number.isInteger(f.radius)||f.radius>512,rows=[]
  for(let line=0;line<(f.axis===0?f.source.h:f.source.w);line++)for(let channel=0;channel<4;channel++){
    const exponents:number[]=[]
    for(let along=0;along<(f.axis===0?f.source.w:f.source.h);along++){
      const x=f.axis===0?along:line,y=f.axis===0?line:along,word=f.words[(y*f.source.w+x)*4+channel]
      if(word&0x7fffffff)exponents.push(Math.max(1,word>>>23&255))
    }
    const minimum=exponents.length?Math.min(...exponents):1,maximum=exponents.length?Math.max(...exponents):0
    const span=maximum?maximum-minimum:0,weightedLhs=24+span+weightedBits+3
    const predictedReasons=[...(!geometry?['geometry']:[]),...(maximum===255?['nonfinite']:[]),...(span>40?['span']:[]),
      ...(rational&&(cw>4||high(denominator)>95)?['kernel']:[]),...(rational&&weightedLhs>123?['weighted-bound']:[])]
    rows.push({line,channel,minimum,maximum,span,weightedLhs,predictedReasons,expectedAccepted:predictedReasons.length===0})
  }
  const kernelUnsupported=prefixRationalUnsupported(f.kernel)
  if(kernelUnsupported!==(cw>4||high(denominator)>95))throw Error('Independent kernel bound differs from existing CPU guard')
  return{geometryAccepted:!!geometry,virtualLength:geometry?.length,kernelUnsupported,coefficientWords:cw,
    denominatorBits:high(denominator)+1,certifiedBoundAvailable:!!certifyPrefixRationalBound(f.kernel),weightedBits,
    expectedAcceptedLines:geometry?rows.filter(row=>row.expectedAccepted).length:0,
    expectedDeclinedLines:geometry?rows.filter(row=>!row.expectedAccepted).length:0,rows}
}
await runProof('futureox-clamped-prefix',[],async proof=>{
  const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
  const fixtures:Fixture[]=[]
  const add=(name:string,axis:0|1,radius:number,pattern:'ordinary'|'signed-hdr'|'subnormal'|'wide'|'nonfinite',fractional:boolean,edge:'start'|'end'|'interior',oversized=false)=>{
    const length=oversized?16384:radius>1000?(axis===0?3659:1857):139,lines=3
    const source={x:fractional?-1797.8828125:-19,y:fractional?964.162109375:23,w:axis===0?length:lines,h:axis===1?length:lines}
    const offset=edge==='start'?0:edge==='end'?length-13:Math.floor(length/2),output={x:source.x+(axis===0?offset:0),y:source.y+(axis===1?offset:0),w:axis===0?13:lines,h:axis===1?13:lines}
    const pixels=new Float32Array(source.w*source.h*4),words=new Uint32Array(pixels.buffer)
    for(let pixel=0;pixel<pixels.length/4;pixel++)for(let channel=0;channel<4;channel++){
      const at=pixel*4+channel
      if(pattern==='subnormal')words[at]=[0,0x80000000,1,3,0x80000001,0x80000003,0x007fffff,0x00800001][(pixel+channel)%8]
      else if(pattern==='wide')words[at]=[(1<<23)|17,0x7f000001,0xff000003,0x3f800000][(pixel+channel)%4]
      else pixels[at]=(1+(pixel*17+channel*53)%251)/256*(pattern==='signed-hdr'?2**((pixel+channel)%20-4):1)*((pixel+channel)%4===0?-1:1)
    }
    if(pattern==='nonfinite')words[4]=0x7fc12345
    const kernel=rational_tent_kernel_rgba(radius),certified=certified_tent_kernel_rgba(radius)
    const values=[...words],admission=classifyAdmission({axis,radius,source,output,words:values,kernel})
    fixtures.push({name,axis,radius,source,output,words:values,kernel:[...kernel],certified:[...certified],admission})
  }
  for(const axis of [0,1] as const){
    add(`integer-start-${axis}`,axis,32,'ordinary',false,'start')
    add(`fractional-start-${axis}`,axis,1177.21484375,'ordinary',true,'start')
    add(`fractional-end-${axis}`,axis,1177.21484375+2**-14,'signed-hdr',true,'end')
    // Distinct positive controls prevent a legitimate weighted-bound rejection
    // from hiding either an edge-addressing bug or a native-HDR admission miss.
    add(`fractional-end-HDR-admitted-${axis}`,axis,1177.21484375,'signed-hdr',true,'end')
    add(`fractional-end-half-ULP-admitted-${axis}`,axis,1177.21484375+2**-14,'ordinary',true,'end')
    add(`fractional-interior-${axis}`,axis,1177.21484375-2**-14,'ordinary',true,'interior')
    add(`maximum-radius-${axis}`,axis,2048,'signed-hdr',true,'start')
    add(`signed-underflow-${axis}`,axis,38.25948715209961,'subnormal',true,'end')
    add(`span-declines-${axis}`,axis,64,'wide',true,'start')
    add(`nonfinite-declines-${axis}`,axis,32,'nonfinite',true,'start')
    add(`virtual-length-declines-${axis}`,axis,32,'ordinary',false,'start',true)
  }
  const gpuFixtures=fixtures.filter(fixture=>fixture.admission.geometryAccepted)
  const cpuOnlyRejections=fixtures.filter(fixture=>!fixture.admission.geometryAccepted).map(fixture=>({name:fixture.name,
    status:'CPU-only-rejection',scope:'No GPU texture allocated; no pixels compared for this unsupported virtual extent.',admission:fixture.admission}))
  const prepared={cases:fixtures.length,gpuCases:gpuFixtures.length,cpuOnlyCases:cpuOnlyRejections.length,
    wasmSha256:sha256(wasm),fixturesSha256:sha256(JSON.stringify(fixtures)),
    scope:'Exact scalar vs virtual-clamp-prefix; raw f32, fractional origins, both true edges, HDR/sign/subnormal/nonfinite, bound rejection and abort recovery. No FPS or app latency claim.'}
  await proof.write('fixtures.json',{...prepared,fixtures})
  if(proof.prepareOnly)return prepared
  const result=await proof.browser(async page=>page.evaluate(async(fixtures)=>{
    const {WebGpuDriver}=await import('/src/kernel/gpu/webgpu.ts')
    const {parameters}=await import('/src/kernel/gpu/types.ts')
    type Texture=import('/src/kernel/gpu/types.ts').Texture
    const driver=await WebGpuDriver.create(true,false,true,true,false),raw=driver as any
    const records:any[]=[];let components=0,different=0
    try{
      // Two groups per arena exercises submit/encoder rollover without any
      // changed shader, source texture or private uniform addressing.
      raw.uniformData=new Float32Array(256*2)
      for(const fixture of fixtures){
        let reference:Uint32Array|undefined
        for(const candidate of [false,true]){
          await driver.prepareScene({nodes:{}} as any);await driver.prepareFilters(true);driver.begin(new Float32Array(0))
          const owned:Texture[]=[];const own=(texture:Texture)=>{owned.push(texture);return texture}
          try{
            const source=own(driver.create(fixture.source.w,fixture.source.h))
            raw.device.queue.writeTexture({texture:source.resource},new Uint32Array(fixture.words),{bytesPerRow:fixture.source.w*16},[fixture.source.w,fixture.source.h])
            const kernel=own(driver.uploadRgba8(new Uint8Array(fixture.kernel),fixture.kernel.length/4,1))
            const certified=own(driver.uploadRgba8(new Uint8Array(fixture.certified),fixture.certified.length/4,1))
            const target=own(driver.create(fixture.output.w,fixture.output.h)),u=parameters(fixture.output,fixture.source)
            u[16]=22;u.set([fixture.radius,fixture.axis,1,1],36)
            if(candidate)driver.prepareFilterPass(target,u,[source,kernel,certified],15,{kind:'tent',radius:fixture.radius},256*1024*1024-driver.stats().textureBytes)
            driver.pass(target,u,[source,kernel,certified],undefined,15,candidate?{kind:'tent',radius:fixture.radius}:undefined)
            const actual=new Uint32Array((await driver.readSurface(target)).buffer),examples=[]
            let differences=0
            if(candidate){
              if(!reference)throw Error('Missing independent scalar reference')
              for(let i=0;i<actual.length;i++)if(actual[i]!==reference[i]){differences++;if(examples.length<8)examples.push({component:i,expected:reference[i],actual:actual[i]})}
              components+=actual.length;different+=differences
            }else reference=actual.slice()
            let counters:any
            if(raw.prefix?.scratchBytes){raw.prefix.encodeCountersReadback(raw.encoder);await driver.checkpoint('checkpoint');counters=await raw.prefix.readCounters()}
            records.push({name:fixture.name,candidate,components:actual.length,differences,examples,counters,scratchBytes:driver.scratchBytes,
              classification:!fixture.admission.geometryAccepted?'CPU-geometry-rejection':fixture.admission.expectedAcceptedLines===0?'CPU-predicted-shader-rejection':'prefix-admission',
              cpuPredictedAccepted:fixture.admission.expectedAcceptedLines,cpuPredictedDeclined:fixture.admission.expectedDeclinedLines})
            if(candidate&&fixture.admission.geometryAccepted){
              if(!counters)throw Error(`Expected scan/fallback counters missing: ${fixture.name}`)
              if(counters.acceptedLines!==fixture.admission.expectedAcceptedLines||counters.declinedLines!==fixture.admission.expectedDeclinedLines)
                throw Error(`GPU scan counters disagree with independent CPU default bounds: ${fixture.name}`)
            }
            if(differences)throw Error(`${fixture.name}: ${differences} raw f32 differences`)
            if(candidate&&fixture.name==='fractional-start-0'){
              await driver.abortFrameAndReleaseFilterScratch('cancel')
              if(driver.scratchBytes!==0)throw Error('Abort retained filter scratch')
              driver.begin(new Float32Array(0));driver.clear(target)
              const after=new Uint32Array((await driver.readSurface(target)).buffer)
              if(after.some(value=>value!==0))throw Error('Cancelled scratch contaminated later frame')
            }
            await driver.finish(target,fixture.output,fixture.output.w,fixture.output.h,false,undefined,false)
            if(driver.scratchBytes!==0)throw Error('finish leaked prefix scratch')
          }catch(error){await driver.abortFrameAndReleaseFilterScratch('cancel').catch(()=>{});throw error}
          finally{for(const texture of owned)driver.destroy(texture)}
        }
      }
      const candidates=records.filter(row=>row.candidate)
      return {status:'passed',adapter:driver.stats().adapter,components,different,
        admittedCases:candidates.filter(row=>row.classification==='prefix-admission').length,
        shaderRejectionCases:candidates.filter(row=>row.classification==='CPU-predicted-shader-rejection').length,
        gpuCases:fixtures.length,records}
    }catch(error){return {status:'failed',error:String(error),components,different,records}}
    finally{driver.dispose()}
  },gpuFixtures))
  await proof.write('gpu-result.json',{...result,cpuOnlyRejections})
  if(result.status!=='passed')throw Error(result.error||'Clamped prefix GPU oracle failed')
  return {...result,cpuOnlyRejections}
})
