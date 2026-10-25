import source from '../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import {identityShader} from './identity-guards.mjs'
const report:any={status:'running',scope:'actual hardware float bits for original/candidate arithmetic helpers; synthetic operator gate, not GUI acceptance',cases:[]}
const publish=async()=>{(window as any).__tileReport=report;document.querySelector('#results')!.textContent=JSON.stringify({status:report.status,error:report.error});await fetch('/__render_report',{method:'POST',body:JSON.stringify(report)})}
let device:GPUDevice|undefined
try{
 const adapter=await navigator.gpu.requestAdapter();if(!adapter||adapter.info.isFallbackAdapter)throw Error('Hardware WebGPU required')
 report.adapter={vendor:adapter.info.vendor,architecture:adapter.info.architecture,fallback:adapter.info.isFallbackAdapter};device=await adapter.requestDevice()
 const edges=[0,0x80000000,1,0x80000001,0x7fffff,0x807fffff,0x800000,0x80800000,0x1000000,0x1800000,0x3e800000,0xbe800000,0x3f000000,0xbf000000,0x3f7fffff,0x3f800000,0xbf800000,0x3f800001,0x40000000,0xc0000000,0x7f7fffff,0xff7fffff,0x7f800000,0xff800000,0x7fc01234,0xffc01234,0x7f801234,0xff801234]
 const pairs:number[]=[];for(const a of edges)for(const b of edges)pairs.push(a,b)
 let seed=0x38162781;while(pairs.length<8192*2){seed=(Math.imul(seed,1664525)+1013904223)>>>0;const a=seed;seed=(Math.imul(seed,1664525)+1013904223)>>>0;pairs.push(a,pairs.length%4?edges[seed%edges.length]:seed)}
 const input=new Uint32Array(pairs),count=input.length/2,buffer=device.createBuffer({size:input.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,input)
 const original=source.slice(0,source.indexOf('// BEGIN GENERATED BLEND MATH SOURCE'));let expected:Uint32Array|undefined
 for(const variant of ['reference','candidate']){
  const math=variant==='reference'?original:identityShader(original)
  const code=math+`\n@group(0) @binding(0) var<storage,read> values:array<vec2<u32>>;
 @vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);}
 @fragment fn fragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{let v=values[u32(p.x)];let a=bitcast<f32>(v.x);let b=bitcast<f32>(v.y);return vec4<f32>(addRN(a,b),mulRN(a,b),0,1);}`
  const module=device.createShaderModule({code});const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(e=>e.message).join('\n'))
  const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:'rgba32float'}]},primitive:{topology:'triangle-list'}})
  const texture=device.createTexture({size:[count,1],format:'rgba32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}),read=device.createBuffer({size:count*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
  const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),loadOp:'clear',clearValue:[0,0,0,0],storeOp:'store'}]})
  pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer}}]}));pass.draw(3);pass.end()
  encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:count*16},[count,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ)
  const words=new Uint32Array(read.getMappedRange()).slice();expected??=words;const differences=[]
  for(let i=0;i<words.length;i++)if(words[i]!==expected[i])differences.push({pair:Math.floor(i/4),channel:i%4,a:input[Math.floor(i/4)*2],b:input[Math.floor(i/4)*2+1],before:expected[i],after:words[i]})
  report.cases.push({variant,pairs:count,words:words.length,mismatches:differences.length,examples:differences.slice(0,16)});read.unmap();read.destroy();texture.destroy();await publish();if(differences.length)throw Error('Arithmetic helper bits changed')
 }
 buffer.destroy();report.status='passed'
}catch(error){report.status='failed';report.error=String(error)}finally{device?.destroy()}
await publish()
