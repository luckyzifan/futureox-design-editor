import vectorShader from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import { imageTableQuarterWgsl } from './image-table-quarter'
import { exactImageXTableBuildWgsl, exactImageXTableSampleWgsl, type ExactImageXTablePlan } from './exact-image-x-table'

// Reuse the existing correctly-rounded addition and retain the four ordered
// quarter/add boundaries. The certified table path needs neither identity
// multiplications nor the general 19-limb sampling fallback.
const arithmeticEnd = vectorShader.indexOf('fn sqrtRN(')
if (arithmeticEnd < 0) throw Error('Missing exact image arithmetic')
const resolveShader = exactImageXTableSampleWgsl + vectorShader.slice(0, arithmeticEnd) +
  imageTableQuarterWgsl + [
    '@vertex fn imageTableQuad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{',
    'let p=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));return vec4<f32>(p[i],0.,1.);}',
    '@fragment fn imageTableResolve(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{',
    'let pixel=vec2<u32>(position.xy);var value=vec4<f32>(0.);',
    // The table's private source certificate proves finite image values and
    // coverage=1. Preserve the alpha gate, canonical zero, per-sample quarter,
    // and original left-to-right additions; never move scale outside the sum.
    'let channels=xiConfig.image.z;',
    'for(var sample=0u;sample<4u;sample=sample+1u){',
    'let sampled=exactImageXTableSample(pixel,sample);var quarter=vec4<f32>(0.);',
    'if(sampled.a>0.){for(var c=0u;c<channels;c=c+1u){quarter[c]=bitcast<f32>(imageTableQuarterBits(bitcast<u32>(sampled[c])));}}',
    'for(var c=0u;c<channels;c=c+1u){if(sample==0u){value[c]=quarter[c];}else{value[c]=addRN(value[c],quarter[c]);}}}',
    'if(xiConfig.image.w==1u){value.a=1.;}',
    'return value;}',
  ].join('\n')

export class ImageXTableStorage {
  readonly buffers: GPUBuffer[] = []
  readonly uniform: GPUBuffer
  readonly x: GPUBuffer
  readonly y: GPUBuffer
  readonly table: GPUBuffer
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly config: Uint32Array
  constructor(device: GPUDevice, readonly plan: ExactImageXTablePlan) {
    this.width=plan.uniform[0];this.height=plan.uniform[1];this.config=plan.uniform.slice()
    const create=(size:number,usage:number)=>{
      const buffer=device.createBuffer({size,usage});this.buffers.push(buffer);return buffer
    }
    try {
      this.uniform=create(256,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST)
      this.x=create(plan.x.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)
      this.y=create(plan.y.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST)
      this.table=create(plan.tableBytes,GPUBufferUsage.STORAGE)
      device.queue.writeBuffer(this.uniform,0,plan.uniform)
      device.queue.writeBuffer(this.x,0,plan.x)
      device.queue.writeBuffer(this.y,0,plan.y)
    } catch(error) { this.destroy();throw error }
    this.bytes=256+plan.x.byteLength+plan.y.byteLength+plan.tableBytes
  }
  destroy(){for(const buffer of this.buffers.splice(0))buffer.destroy()}
}

export class ImageXTablePipeline {
  private constructor(private device:GPUDevice,private buildLayout:GPUBindGroupLayout,
    private drawLayout:GPUBindGroupLayout,private build:GPUComputePipeline,private draw:GPURenderPipeline){}
  static async create(device:GPUDevice){
    const buildModule=device.createShaderModule({code:exactImageXTableBuildWgsl,label:'Exact image X table'})
    const drawModule=device.createShaderModule({code:resolveShader,label:'Exact four image samples from X table'})
    for(const module of [buildModule,drawModule]){
      const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error')
      if(errors.length)throw Error(errors.map(message=>message.lineNum+':'+message.message).join('\n'))
    }
    const buildLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform',minBindingSize:80}},
      {binding:1,visibility:GPUShaderStage.COMPUTE,texture:{sampleType:'unfilterable-float'}},
      {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
      {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
    ]})
    const drawLayout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform',minBindingSize:80}},
      ...[1,2,3].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage' as const}})),
    ]})
    const build=await device.createComputePipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[buildLayout]}),
      compute:{module:buildModule,entryPoint:'buildExactImageXTable'}})
    const draw=await device.createRenderPipelineAsync({layout:device.createPipelineLayout({bindGroupLayouts:[drawLayout]}),
      vertex:{module:drawModule,entryPoint:'imageTableQuad'},fragment:{module:drawModule,entryPoint:'imageTableResolve',targets:[{format:'rgba32float'}]},
      primitive:{topology:'triangle-list'}})
    return new ImageXTablePipeline(device,buildLayout,drawLayout,build,draw)
  }
  encodeBuild(encoder:GPUCommandEncoder,image:GPUTexture,storage:ImageXTableStorage,timestampWrites?:GPUComputePassTimestampWrites){
    const group=this.device.createBindGroup({layout:this.buildLayout,entries:[
      {binding:0,resource:{buffer:storage.uniform,size:80}},{binding:1,resource:image.createView()},
      {binding:2,resource:{buffer:storage.x}},{binding:3,resource:{buffer:storage.table}},
    ]})
    const pass=encoder.beginComputePass(timestampWrites?{timestampWrites}:undefined);pass.setPipeline(this.build);pass.setBindGroup(0,group)
    pass.dispatchWorkgroups(Math.ceil(storage.width*storage.plan.rowCount*storage.plan.xSampleCount/64));pass.end()
  }
  encodeResolve(encoder:GPUCommandEncoder,target:GPUTexture,storage:ImageXTableStorage,uniform:GPUBufferBinding,timestampWrites?:GPURenderPassTimestampWrites){
    const group=this.device.createBindGroup({layout:this.drawLayout,entries:[
      {binding:0,resource:uniform},{binding:1,resource:{buffer:storage.x}},
      {binding:2,resource:{buffer:storage.y}},{binding:3,resource:{buffer:storage.table}},
    ]})
    const pass=encoder.beginRenderPass({...(timestampWrites?{timestampWrites}:{}),colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]})
    pass.setPipeline(this.draw);pass.setBindGroup(0,group);pass.draw(3);pass.end()
  }
}
