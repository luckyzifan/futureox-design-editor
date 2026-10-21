/** Real GPU correctness oracle for the fractional weighted-window admission.
 * Reference is the direct four-channel exact scalar shader, never prefix. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initSync, rational_tent_kernel_rgba, certified_tent_kernel_rgba } from '../src/generated/design-kernel/design_kernel.js'
import { project, runProof, sha256 } from './exact-prefix-proof-utils'
import { certifyPrefixRationalBound, prefixRationalBoundBits } from '../src/kernel/gpu/prefix-preflight'
type Fixture={name:string;axis:number;span:number;pattern:string;width:number;height:number;outputWidth:number;outputHeight:number;offset:number;origin:number[];values:number[];actualSpans:number[];scan64Enabled:boolean;requireNarrow:boolean;requireAccepted:boolean}

await runProof('futureox-prefix-window',[],async proof=>{
 const radius=38.25948715209961,length=1108,short=7,outputLength=1032,offset=38
 const wasm=await readFile(join(project,'public/kernel/design_kernel_bg.wasm'));initSync({module:wasm})
 const nativeKernel=rational_tent_kernel_rgba(radius),certificate=certifyPrefixRationalBound(nativeKernel)
 const boundBits=certificate?prefixRationalBoundBits(certificate,radius):0
 if(!Number.isInteger(boundBits)||boundBits<1||boundBits>120)throw Error('Actual native coefficient bytes did not produce a valid CPU bound')
 const kernel=Array.from(nativeKernel),certified=Array.from(certified_tent_kernel_rgba(radius))
 const fixtures:Fixture[]=[]
 for(const axis of [0,1])for(const span of [0,14,17,22,23,29,30,31])for(const pattern of ['positive-max','negative-near-max','alternating-subnormal-zero']){
  const width=axis===0?length:short,height=axis===1?length:short,values=new Uint32Array(width*height*4)
  const minimum=pattern==='negative-near-max'?254-span:pattern==='alternating-subnormal-zero'?1:100
  for(let line=0;line<short;line++)for(let j=0;j<length;j++)for(let c=0;c<4;c++){
   const low=(j+c+line)%4===0||j===0,exponent=minimum+(low?0:span)
   let word=(exponent<<23)|0x7fffff
   if(pattern==='alternating-subnormal-zero'&&low)word=(j+c+line)%2?1:0x007fffff
   if(pattern==='negative-near-max'||pattern==='alternating-subnormal-zero'&&(j+line+c)%2)word|=0x80000000
   if(j>1&&(j*3+line+c)%13===0)word=(j+c)%2?0x80000000:0
   const x=axis===0?j:line,y=axis===0?line:j;values[(y*width+x)*4+c]=word>>>0
  }
  const actualSpans=[]
  for(let line=0;line<short;line++)for(let c=0;c<4;c++){
   let lo=255,hi=0
   for(let j=0;j<length;j++){const x=axis===0?j:line,y=axis===0?line:j,word=values[(y*width+x)*4+c];if(!(word&0x7fffffff))continue
    const exponent=Math.max(1,word>>>23&255);lo=Math.min(lo,exponent);hi=Math.max(hi,exponent)}
   if(hi-lo!==span)throw Error(`Fixture exponent span changed: ${pattern} axis${axis} ${span}/${hi-lo}`)
   actualSpans.push(hi-lo)
  }
  fixtures.push({name:`${pattern}-span${span}-axis${axis}`,axis,span,pattern,width,height,
   outputWidth:axis===0?outputLength:short,outputHeight:axis===1?outputLength:short,offset,origin:[-31,47],
   values:Array.from(values),actualSpans,scan64Enabled:process.env.VITE_DESIGN_PREFIX_SCAN64==='1',requireNarrow:24+span+2*(Math.floor(Math.log2(length))+1)<=63,requireAccepted:span<=(process.env.VITE_DESIGN_PREFIX_TIGHT_BOUND==='1'?30:22)})
 }
 const prepared={radius,length,outputLength,offset,boundBits,cases:fixtures.length,wasmSha256:sha256(wasm),fixtureSha256:sha256(JSON.stringify({fixtures,kernel,certified,boundBits})),
  reference:'Direct exactFilterWgsl(true), four ordered channel draws into one RGBA32F attachment; no TexturePrefix in reference.',
  acceptance:'Actual native-byte CPU bound is passed to encode. Every fixture marked accepted must use prefix for all channels; the next-span fixtures must decline all lines to the independent scalar fallback.',
  scope:'Single-run raw-f32 correctness only; source lengths1108 with seven orthogonal lines keep the GPU workload bounded.'}
 await proof.write('fixtures.json',{...prepared,fixtures,kernel,certified})
 if(proof.prepareOnly)return prepared
 const result=await proof.browser(async page=>{
  let progress=0
  await page.exposeFunction('prefixWindowProgress',async(value:unknown)=>proof.write(`progress-${++progress}.json`,value))
  return page.evaluate(async({fixtures,kernel,certified,radius,boundBits})=>{
   const {TexturePrefix,PREFIX_SCRATCH_BYTES}=await import('/src/kernel/gpu/texture-prefix.ts')
   const {prefixModule}=await import('/src/kernel/gpu/prefix-module.ts')
   const {exactFilterWgsl}=await import('/src/kernel/gpu/exact-filter.ts')
   const adapter=await navigator.gpu?.requestAdapter();if(!adapter)throw Error('Actual GPU adapter required')
   const device=await adapter.requestDevice(),errors:string[]=[],records:any[]=[],textures:GPUTexture[]=[],buffers:GPUBuffer[]=[]
   let intentionalDestroy=false,scopeOpen=false,prefix:Awaited<ReturnType<typeof TexturePrefix.create>>|undefined,components=0,different=0,active:any
   device.addEventListener('uncapturederror',event=>errors.push(event.error.message))
   void device.lost.then(info=>{if(!intentionalDestroy)errors.push(`device-lost:${info.reason}:${info.message}`)})
   const texture=(width:number,height:number)=>{const t=device.createTexture({size:[width,height],format:'rgba32float',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC|GPUTextureUsage.COPY_DST});textures.push(t);return t}
   const read=async(t:GPUTexture)=>{
    const stride=Math.ceil(t.width*16/256)*256,b=device.createBuffer({size:stride*t.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    try{const e=device.createCommandEncoder();e.copyTextureToBuffer({texture:t},{buffer:b,bytesPerRow:stride},[t.width,t.height]);device.queue.submit([e.finish()])
     await b.mapAsync(GPUMapMode.READ);const padded=new Uint32Array(b.getMappedRange()),packed=new Uint32Array(t.width*t.height*4)
     for(let y=0;y<t.height;y++)packed.set(padded.subarray(y*stride/4,y*stride/4+t.width*4),y*t.width*4)
     b.unmap();return packed
    }finally{b.destroy()}
   }
   const digest=async(a:Uint32Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',a.slice().buffer))).map(v=>v.toString(16).padStart(2,'0')).join('')
   try{
    device.pushErrorScope('validation');scopeOpen=true
    const arena=new Float32Array(256*256),uniformBuffer=device.createBuffer({size:arena.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});buffers.push(uniformBuffer)
    let used=0
    const uniform=(data:Float32Array):GPUBufferBinding=>{if(used+data.length>arena.length)throw Error('Uniform arena overflow');arena.set(data,used);const b={buffer:uniformBuffer,offset:used*4,size:1024};used+=256;return b}
    prefix=await TexturePrefix.create(device,uniform,prefixModule(true),true)
    if(prefix.scratchBytes!==PREFIX_SCRATCH_BYTES)throw Error('Scratch is not exactly 4MiB')
    const module=device.createShaderModule({code:exactFilterWgsl(true),label:'Independent scalar exact window oracle'})
    const messages=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
    if(messages.length)throw Error(messages.map(message=>message.lineNum+':'+message.message).join('\n'))
    const layout=device.createBindGroupLayout({entries:[
     {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:1024}},
     ...[1,2,3].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float' as const}})),
    ]}),pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]}),scalar:GPURenderPipeline[]=[]
    for(let channel=0;channel<4;channel++)scalar.push(await device.createRenderPipelineAsync({layout:pipelineLayout,
     vertex:{module,entryPoint:'quad'},fragment:{module,entryPoint:'fragment',constants:{FILTER_CHANNEL:channel},targets:[{format:'rgba32float',writeMask:1<<channel}]},primitive:{topology:'triangle-list'}}))
    const coefficient=(bytes:number[])=>{const t=texture(bytes.length/4,1),values=Float32Array.from(bytes,v=>v/255)
     device.queue.writeTexture({texture:t},values,{bytesPerRow:values.byteLength},[t.width,1]);return t}
    const rationalTexture=coefficient(kernel),certifiedTexture=coefficient(certified)
    await device.queue.onSubmittedWorkDone()
    for(const f of fixtures){
     active={name:f.name,span:f.span,axis:f.axis,pattern:f.pattern}
     const source=texture(f.width,f.height),reference=texture(f.outputWidth,f.outputHeight),candidate=texture(f.outputWidth,f.outputHeight)
     device.queue.writeTexture({texture:source},new Uint32Array(f.values),{bytesPerRow:f.width*16},[f.width,f.height]);await device.queue.onSubmittedWorkDone()
     const output={x:f.origin[0]+(f.axis===0?f.offset:0),y:f.origin[1]+(f.axis===1?f.offset:0),w:f.outputWidth,h:f.outputHeight}
     const u=new Float32Array(256);u.set([output.x,output.y,output.w,output.h],0);u.set([...f.origin,f.width,f.height],4)
     u[16]=22;u.set([radius,f.axis,0,1],36)
     used=0
     const scalarGroup=device.createBindGroup({layout,entries:[{binding:0,resource:uniform(u)},
      {binding:1,resource:source.createView()},{binding:2,resource:rationalTexture.createView()},{binding:3,resource:certifiedTexture.createView()}]})
     let encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:reference.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
     for(const pipeline of scalar){pass.setPipeline(pipeline);pass.setBindGroup(0,scalarGroup);pass.draw(3)}pass.end()
     device.queue.writeBuffer(uniformBuffer,0,arena.subarray(0,used));device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone()
     const expected=await read(reference)
     used=0;encoder=device.createCommandEncoder();prefix.resetCounters(encoder)
     if(!prefix.encode(encoder,candidate,[source,rationalTexture,certifiedTexture],u,radius,'tent',output,15,255,false,boundBits))throw Error('Expected prefix encode was rejected')
     prefix.encodeCountersReadback(encoder)
     device.queue.writeBuffer(uniformBuffer,0,arena.subarray(0,used));device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone()
     const counters=await prefix.readCounters(),actual=await read(candidate),examples=[]
     let differences=0
     for(let i=0;i<expected.length;i++)if(expected[i]!==actual[i]){differences++;if(examples.length<12)examples.push({component:i,reference:expected[i],candidate:actual[i]})}
     components+=expected.length;different+=differences
     const row={...active,output,boundBits,components:expected.length,differences,examples,counters,
      referenceSha256:await digest(expected),candidateSha256:await digest(actual),prefixRenderPasses:prefix.lastRenderPasses,prefixComputePasses:prefix.lastComputePasses}
     records.push(row);active=row
     if(differences)throw Error(`${f.name}: raw f32 mismatch`)
     const expectedLines=4*(f.axis===0?output.h:output.w)
     if(counters.acceptedLines+counters.declinedLines!==expectedLines)throw Error(`${f.name}: missing actual line-counter evidence`)
     if(f.requireAccepted&&(counters.acceptedLines!==expectedLines||counters.declinedLines!==0))throw Error(`${f.name}: widened gate still used fallback instead of accepted prefix lines`)
     if(!f.requireAccepted&&(counters.declinedLines!==expectedLines||counters.acceptedLines!==0))throw Error(`${f.name}: next-span rejection boundary changed`)
     if(f.scan64Enabled&&counters.narrowLines!==(f.requireNarrow?expectedLines:0))throw Error(`${f.name}: unexpected narrow scan count ${counters.narrowLines}`)
     for(const t of [source,reference,candidate]){t.destroy();textures.splice(textures.indexOf(t),1)}
     await (globalThis as any).prefixWindowProgress({completed:f.name,records,components,different})
    }
    const error=await device.popErrorScope();scopeOpen=false;if(error)errors.push(error.message)
    if(errors.length)throw Error(errors.join('\n'))
    prefix.releaseScratch();if(prefix.scratchBytes!==0)throw Error('Scratch retirement failed')
    return {status:'passed',adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,description:adapter.info.description},
     cases:records.length,components,different,records,errors,scratchAfterRelease:prefix.scratchBytes}
   }catch(error){if(scopeOpen){const validation=await device.popErrorScope().catch(()=>null);scopeOpen=false;if(validation)errors.push(validation.message)}return {status:'failed',error:String(error),active,records,components,different,errors}}
   finally{await device.queue.onSubmittedWorkDone().catch(()=>{});prefix?.destroy();for(const t of textures)t.destroy();for(const b of buffers)b.destroy();intentionalDestroy=true;device.destroy()}
  },{fixtures,kernel,certified,radius,boundBits})
 })
 await proof.write('gpu-result.json',result)
 if(result.status!=='passed')throw Error(result.error||'Weighted-window GPU oracle failed')
 return {...prepared,...result}
})
