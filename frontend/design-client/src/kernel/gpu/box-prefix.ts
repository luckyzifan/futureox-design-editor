import {exactFilterWgsl} from './exact-filter'

export const BOX_PREFIX_BYTES=4*1024*1024

export function boxPrefixBandLines(sourceLength: number) {
  // RGBA prefix values plus three texels of metadata for each source line.
  return Math.floor(BOX_PREFIX_BYTES / (16 * (sourceLength + 3)))
}

/** A checked original Rust coefficient packet, not a public texture flag. */
export function uniformBoxRadius(bytes:Uint8Array):number|undefined{
  if(!(bytes.buffer instanceof ArrayBuffer)||bytes.byteLength<24||bytes.byteLength>65536||bytes.byteLength%4)return
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),r=v.getUint32(8,true)
  if(r<1||r>1024||v.getUint32(0,true)!==1||v.getUint32(4,true)!==Math.ceil((Math.floor(Math.log2(2*r+1))+1+278)/32)||v.getUint32(12,true)!==0||
    bytes.byteLength!==(r+6)*4||v.getUint32(16,true)!==2*r+1)return
  for(let i=5;i<r+6;i++)if(v.getUint32(i*4,true)!==1)return
  return r
}
const scan=`struct Params {values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
@group(0) @binding(4) var<storage,read_write> prefix:array<vec4<f32>>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
var<workgroup> values:array<vec4<f32>,256>;
var<workgroup> lineFlags:atomic<u32>;
@compute @workgroup_size(128) fn scan(@builtin(local_invocation_index) lane:u32,@builtin(workgroup_id) group:vec3<u32>){
 let horizontal=u(9u).y==0.;let length=u32(select(u(1u).w,u(1u).z,horizontal));
 let cross=i32(u(50u).x+f32(group.x)+select(u(0u).x-u(1u).x,u(0u).y-u(1u).y,horizontal));
 let crossLength=i32(select(u(1u).z,u(1u).w,horizontal));let validCross=cross>=0&&cross<crossLength;
 let stride=length+3u;let start=group.x*stride;
 var first=vec4<f32>(0.);if(validCross){first=textureLoad(sourceA,select(vec2<i32>(cross,0),vec2<i32>(0,cross),horizontal),0);}
 first=select(first,vec4<f32>(0.),first==vec4<f32>(0.));
 if(lane==0u){atomicStore(&lineFlags,0u);prefix[start+1u]=first;prefix[start+2u]=vec4<f32>(0.);}
 workgroupBarrier();var carry=vec4<f32>(0.);
 // Each lane checks several texels across the line. Publish its combined
 // result once to avoid contention on a workgroup atomic for every sample.
 var laneFlags=0u;
 for(var block=0u;block<length;block=block+128u){
  let at=block+lane;var value=vec4<f32>(0.);
  if(at<length&&validCross){value=textureLoad(sourceA,select(vec2<i32>(cross,i32(at)),vec2<i32>(i32(at),cross),horizontal),0);}
  value=select(value,vec4<f32>(0.),value==vec4<f32>(0.));
  if(at<length){
   if(!(all(value>=vec4<f32>(0.))&&all(value<=vec4<f32>(1.)))){laneFlags=laneFlags|1u;}
   if(any(value!=first)){laneFlags=laneFlags|2u;}
  }
  values[lane]=value;workgroupBarrier();
  // Alternate the two workgroup arrays. Each step reads the same operands
  // as the in-place scan and needs only a barrier after publishing its sum.
  var readBase=0u;
  var writeBase=128u;
  for(var step=1u;step<128u;step=step*2u){
   var add=vec4<f32>(0.);if(lane>=step){add=values[readBase+lane-step];}
   values[writeBase+lane]=values[readBase+lane]+add;
   workgroupBarrier();
   let previousBase=readBase;readBase=writeBase;writeBase=previousBase;
  }
  if(at<length){prefix[start+3u+at]=carry+values[readBase+lane];}
  carry=carry+values[readBase+127u];workgroupBarrier();
 }
 if(laneFlags!=0u){atomicOr(&lineFlags,laneFlags);}
 workgroupBarrier();
 if(lane==0u){let flags=atomicLoad(&lineFlags);prefix[start]=vec4<f32>(f32(flags&1u),f32((flags>>1u)&1u),0.,0.);}
}`
const resolve=(canvasFallback=false)=>exactFilterWgsl(false,canvasFallback,canvasFallback)+`
@group(0) @binding(4) var<storage,read> prefix:array<vec4<f32>>;
@fragment fn boxResolve(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let horizontal=u(9u).y==0.;let length=i32(select(u(1u).w,u(1u).z,horizontal));
 let line=u32(select(position.x,position.y,horizontal)-u(50u).x);
 let start=line*u32(length+3);let point=position.xy+u(0u).xy;
 let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),horizontal);
 if(prefix[start].x!=0.){
  ${canvasFallback?'if(u(9u).x<=512.){return canvasBlurRgba(point,axis);}':''}
  return vec4<f32>(exactFilterChannel(point,axis,0u),exactFilterChannel(point,axis,1u),exactFilterChannel(point,axis,2u),exactFilterChannel(point,axis,3u));
 }
 let q=i32(floor(select(point.y-u(1u).y,point.x-u(1u).x,horizontal)));let r=i32(u(9u).x);
 let lo=clamp(q-r,0,length);let hi=clamp(q+r+1,0,length);
 if(prefix[start].y==0.&&(all(prefix[start+1u]==vec4<f32>(0.))||(lo==q-r&&hi==q+r+1))){return prefix[start+1u];}
 let a=prefix[start+2u+u32(hi)];let b=prefix[start+2u+u32(lo)];
 return clamp((a-b)/f32(2*r+1),vec4<f32>(0.),vec4<f32>(1.));
}`

/** Bounded per-line prefix sums. Every H/V boundary and original transparent
 * support remains; exceptional source lines run the original rational reducer.
 * Display-only arithmetic is accepted against the existing 1/255 error gate. */
export class BoxPrefix {
  private scratch?:GPUBuffer
  get scratchBytes(){return this.scratch?BOX_PREFIX_BYTES:0}
  lastPasses=0
  private constructor(private device:GPUDevice,private compute:GPUComputePipeline,private render:GPURenderPipeline){}
  static async create(device:GPUDevice,canvasFallback=false){
    const computeLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',minBindingSize:1024,hasDynamicOffset:true}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
      {binding:4,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}}]})
    const renderLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:1024,hasDynamicOffset:true}},
      ...[1,2,3].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float' as const}})),
      {binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}}]})
    const resolveModule=device.createShaderModule({code:resolve(canvasFallback),label:'Bounded box resolve'}),scanModule=device.createShaderModule({code:scan,label:'Bounded box scan'})
    for(const module of [resolveModule,scanModule]){const info=await module.getCompilationInfo();const errors=info.messages.filter(m=>m.type==='error');if(errors.length)throw Error(errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'))}
    const [compute,render]=await Promise.all([
      device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[computeLayout]}),compute:{module:scanModule,entryPoint:'scan'}}),
      device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[renderLayout]}),vertex:{module:resolveModule,entryPoint:'quad'},
        fragment:{module:resolveModule,entryPoint:'boxResolve',targets:[{format:'rgba32float'}]},primitive:{topology:'triangle-list'}})
    ])
    return new BoxPrefix(device,compute,render)
  }
  reserve(){this.scratch??=this.device.createBuffer({size:BOX_PREFIX_BYTES,usage:GPUBufferUsage.STORAGE})}
  release(){this.scratch?.destroy();this.scratch=undefined}
  encode(encoder:()=>GPUCommandEncoder,uniform:(u:Float32Array)=>GPUBufferBinding,target:GPUTexture,source:GPUTexture,kernel:GPUTexture,blank:GPUTexture,u:Float32Array){
    if(!this.scratch)return false
    const horizontal=u[37]===0,length=horizontal?source.width:source.height,lines=horizontal?target.height:target.width
    const band=boxPrefixBandLines(length);if(band<1)return false
    this.lastPasses=0
    const sourceView=source.createView(),kernelView=kernel.createView(),blankView=blank.createView(),targetView=target.createView()
    let groups:{buffer:GPUBuffer;compute:GPUBindGroup;render:GPUBindGroup}|undefined
    for(let at=0;at<lines;at+=band){
      const count=Math.min(band,lines-at),params=u.slice();params[200]=at;params[240]=1;params[251]=0;params[253]=0;params[254]=9;params[255]=19
      const {buffer,offset=0}=uniform(params)
      // Only the uniform slot moves between bands. An arena rollover gives
      // the new buffer its own bindings before encoding the next band.
      if(groups?.buffer!==buffer){
        const binding={buffer,size:1024}
        const compute=this.device.createBindGroup({layout:this.compute.getBindGroupLayout(0),entries:[
          {binding:0,resource:binding},{binding:1,resource:sourceView},{binding:4,resource:{buffer:this.scratch}}]})
        const render=this.device.createBindGroup({layout:this.render.getBindGroupLayout(0),entries:[
          {binding:0,resource:binding},{binding:1,resource:sourceView},{binding:2,resource:kernelView},{binding:3,resource:blankView},{binding:4,resource:{buffer:this.scratch}}]})
        groups={buffer,compute,render}
      }
      const commands=encoder(),scan=commands.beginComputePass();scan.setPipeline(this.compute);scan.setBindGroup(0,groups.compute,[offset]);scan.dispatchWorkgroups(count);scan.end()
      const pass=commands.beginRenderPass({colorAttachments:[{view:targetView,loadOp:at===0?'clear':'load',storeOp:'store',clearValue:[0,0,0,0]}]})
      pass.setPipeline(this.render);pass.setBindGroup(0,groups.render,[offset])
      pass.setScissorRect(horizontal?0:at,horizontal?at:0,horizontal?target.width:count,horizontal?count:target.height)
      pass.draw(3);pass.end();this.lastPasses++
    }
    return true
  }
}
