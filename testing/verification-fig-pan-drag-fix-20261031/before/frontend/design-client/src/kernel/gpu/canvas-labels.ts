import type { CanvasCamera } from '../../canvas-camera'
import type { Point } from '../../model'

export type CanvasLabel = {
  anchor: Point; offset: Point; text: string; size: number; color: string
  basis?: [number, number, number, number]; centered?: boolean; halo?: boolean; owners?: string[]
}
type Entry = { texture: GPUTexture; bind: GPUBindGroup; width: number; height: number; left: number; top: number; advance: number; bytes: number }

function measureLabel(label:CanvasLabel,density:number,measure:OffscreenCanvasRenderingContext2D) {
  if(!Number.isFinite(density)||density<=0)throw Error('Invalid chrome text density')
  const font=`${label.size}px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif`
  measure.font=font
  const metrics=measure.measureText(label.text),pad=label.halo?3:2
  const left=pad+metrics.actualBoundingBoxLeft,top=pad+metrics.actualBoundingBoxAscent
  const width=Math.max(1,Math.ceil((metrics.actualBoundingBoxLeft+metrics.actualBoundingBoxRight+pad*2)*density))
  const height=Math.max(1,Math.ceil((metrics.actualBoundingBoxAscent+metrics.actualBoundingBoxDescent+pad*2)*density))
  return{font,width,height,left,top,advance:metrics.width}
}
function rasterLabel(label:CanvasLabel,density:number,metrics:ReturnType<typeof measureLabel>) {
  const {font,width,height,left,top}=metrics
  const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d')!
  context.setTransform(density,0,0,density,0,0);context.font=font;context.fillStyle=label.color
  if(label.halo){context.strokeStyle='#fff';context.lineWidth=2;context.strokeText(label.text,left,top)}
  context.fillText(label.text,left,top)
  return{canvas,...metrics}
}
export function rasterizeCanvasLabel(label:CanvasLabel,density:number) {
  const metrics=measureLabel(label,density,new OffscreenCanvas(1,1).getContext('2d')!)
  if(metrics.width>8192||metrics.height>8192||metrics.width*metrics.height*4>8*1024*1024)throw Error('Chrome text bitmap budget exceeded')
  return rasterLabel(label,density,metrics)
}

/** Bounded screen-text cache for editor chrome only. Authored document text
 * keeps the kernel's own shaping/outline path and scales with the document. */
export class CanvasLabels {
  private entries = new Map<string, Entry>()
  private bytes = 0
  private uniform: GPUBuffer
  private sampler: GPUSampler
  private pipeline: GPURenderPipeline
  private layout: GPUBindGroupLayout
  private measure = new OffscreenCanvas(1, 1).getContext('2d')!
  constructor(private device: GPUDevice, format: GPUTextureFormat) {
    this.uniform = device.createBuffer({ size: 512 * 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
    this.layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 32 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ] })
    const module = device.createShaderModule({ code: `struct U { origin:vec2<f32>, x:vec2<f32>, y:vec2<f32>, size:vec2<f32> }
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var pixels:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
struct V { @builtin(position) p:vec4<f32>, @location(0) uv:vec2<f32> }
@vertex fn vertex(@builtin(vertex_index) i:u32)->V {
 let corners=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 let q=corners[i]; let p=(u.origin+u.x*q.x+u.y*q.y)/u.size;
 return V(vec4(p.x*2.-1.,1.-p.y*2.,0.,1.),q);
}
@fragment fn fragment(v:V)->@location(0) vec4<f32> { return textureSample(pixels,filtering,v.uv); }` })
    this.pipeline = device.createRenderPipeline({ layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] } })
  }
  private entry(label: CanvasLabel, density: number, protectedKeys: Set<string>) {
    const key = JSON.stringify([label.text,label.size,label.color,!!label.halo,density])
    const existing = this.entries.get(key)
    if (existing) { this.entries.delete(key); this.entries.set(key,existing); protectedKeys.add(key); return existing }
    const metrics=measureLabel(label,density,this.measure),{width,height,left,top,advance}=metrics,bytes=width*height*4
    if (bytes > 8*1024*1024 || width > this.device.limits.maxTextureDimension2D || height > this.device.limits.maxTextureDimension2D) return
    for (const [old,entry] of this.entries) {
      if (this.bytes+bytes<=8*1024*1024 && this.entries.size<512) break
      if (protectedKeys.has(old)) continue
      entry.texture.destroy(); this.entries.delete(old); this.bytes-=entry.bytes
    }
    if (this.bytes+bytes>8*1024*1024 || this.entries.size>=512) return
    const {canvas}=rasterLabel(label,density,metrics)
    const texture=this.device.createTexture({size:[width,height],format:'rgba8unorm',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT})
    this.device.queue.copyExternalImageToTexture({source:canvas},{texture,premultipliedAlpha:true},[width,height])
    const bind=this.device.createBindGroup({layout:this.layout,entries:[
      {binding:0,resource:{buffer:this.uniform,size:32}},{binding:1,resource:texture.createView()},{binding:2,resource:this.sampler}]})
    const result={texture,bind,width:width/density,height:height/density,left,top,advance,bytes}
    this.entries.set(key,result);this.bytes+=bytes;protectedKeys.add(key);return result
  }
  draw(encoder:GPUCommandEncoder,target:GPUTexture,labels:CanvasLabel[],view:CanvasCamera,width:number,height:number,dpr:number) {
    const draws:{entry:Entry;offset:number}[]=[], data=new Float32Array(512*64), protectedKeys=new Set<string>()
    for (const label of labels) {
      if (draws.length>=512) break
      const basis=label.basis||[1,0,0,1], x=label.anchor.x*view.zoom+view.x, y=label.anchor.y*view.zoom+view.y
      // A conservative text bound avoids rasterizing offscreen board names.
      const span=(label.text.length+2)*label.size*Math.max(1,Math.hypot(...basis))*2
      if (x+span<0||x-span>width||y+span<0||y-span>height) continue
      const density=Math.max(1,Math.ceil(dpr*Math.max(Math.hypot(basis[0],basis[1]),Math.hypot(basis[2],basis[3]))*4)/4)
      const entry=this.entry(label,density,protectedKeys);if(!entry)continue
      const ox=label.offset.x-entry.left-(label.centered?entry.advance/2:0),oy=label.offset.y-entry.top
      const index=draws.length, origin=[x+basis[0]*ox+basis[2]*oy,y+basis[1]*ox+basis[3]*oy]
      data.set([...origin,basis[0]*entry.width,basis[1]*entry.width,basis[2]*entry.height,basis[3]*entry.height,width,height],index*64)
      draws.push({entry,offset:index*256})
    }
    if(!draws.length)return
    this.device.queue.writeBuffer(this.uniform,0,data.subarray(0,draws.length*64))
    const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'load',storeOp:'store'}]})
    pass.setPipeline(this.pipeline)
    for(const draw of draws){pass.setBindGroup(0,draw.entry.bind,[draw.offset]);pass.draw(6)}
    pass.end()
  }
  dispose(){for(const entry of this.entries.values())entry.texture.destroy();this.entries.clear();this.uniform.destroy()}
  get residentBytes(){return this.bytes+this.uniform.size}
}
