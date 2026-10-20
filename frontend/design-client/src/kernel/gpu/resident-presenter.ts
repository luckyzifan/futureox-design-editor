import { TerminalQualityGate, type TerminalQuality } from './terminal-quality'
import { gpuDiagnosticsDetail } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import type { CanvasCamera } from '../../canvas-camera'
import type { CompositeItem } from './tile-compositor'
import { presentationQuality } from './presentation-quality'
import { compositeDrawPlan, compositeRasterQuad } from './composite-draw-plan'
import { DISPLAY_TEXTURE_BUDGET } from './display-budget'
import { CanvasOverlayRenderer, translateOverlay, type CanvasOverlay } from './canvas-overlay'
import { ResidentUniforms } from './resident-uniforms'
import { physicalCoverage } from './physical-coverage'

export type ResidentItem = Omit<CompositeItem, 'tile'> & {
  tile: Omit<CompositeItem['tile'], 'bytes' | 'bitmap'> & { gpuTile: number }
}
export type ResidentFrame = {
  overlay?: CanvasOverlay
  /** Worker-local placement from the completed resident pose, not input. */
  overlayPose?: Record<string, {x:number;y:number}>
  terminalQuality?: TerminalQuality
  presentationId?: string
  items: ResidentItem[]
  view: CanvasCamera
  width: number
  height: number
  dpr: number
  interaction?: boolean
  allowEmpty?: boolean
  linearBlend?: boolean
  backgroundLinear?: [number, number, number, number]
  input?: { sequence: number; at: number; owner?:string }
}
let nextTexture = 0
const source = `override COLOR_MODE:i32=0;struct U { box:vec4<f32>,uv:vec4<f32>,viewport:vec2<f32> }
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var pixels:texture_2d<f32>;
@group(0) @binding(2) var filtering:sampler;
struct V { @builtin(position) p:vec4<f32>, @location(0) uv:vec2<f32> }
@vertex fn vertex(@builtin(vertex_index) i:u32)->V {
 let corners=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 let q=corners[i];let p=(u.box.xy+q*u.box.zw)/u.viewport;
 return V(vec4(p.x*2.-1.,1.-p.y*2.,0.,1.),u.uv.xy+q*u.uv.zw);
}
@fragment fn fragment(v:V)->@location(0) vec4<f32>{
 let value=textureSample(pixels,filtering,v.uv);
 if(COLOR_MODE==0){return value;}if(value.a<=0.){return vec4<f32>(0);}
 let c=clamp(value.rgb/value.a,vec3<f32>(0),vec3<f32>(1));
 if(COLOR_MODE==1){let linear=select(pow((c+0.055)/1.055,vec3<f32>(2.4)),c/12.92,c<=vec3<f32>(0.04045));return vec4(linear*value.a,value.a);}
 let encoded=select(1.055*pow(c,vec3<f32>(1./2.4))-0.055,12.92*c,c<=vec3<f32>(0.0031308));
 return vec4(encoded*value.a,value.a);
}`

/** The raster device also owns display textures and the final canvas. Frames
 * contain handles and transforms only; no ImageBitmap or pixel readback. */
export class ResidentPresenter {
  private transformData = new ResidentUniforms()
  private context: GPUCanvasContext
  private layout: GPUBindGroupLayout
  private pipeline: GPURenderPipeline
  private blendPipeline: GPURenderPipeline
  private linearPipeline: GPURenderPipeline
  private linearBlendPipeline: GPURenderPipeline
  private resolvePipeline: GPURenderPipeline
  private linearTarget?: { texture: GPUTexture; bind: GPUBindGroup; width: number; height: number }
  private sampler: GPUSampler
  private uniforms: GPUBuffer
  private textures = new Map<number, { texture: GPUTexture; bytes: number; bind: GPUBindGroup }>()
  private terminalQualityGate = new TerminalQualityGate()
  private latest?: ResidentFrame
  private drawn?: ResidentFrame
  private backbuffer?: { texture: GPUTexture; width: number; height: number }
  private diagnosticCoverageAt = -Infinity
  private frames = 0
  private captures = 0
  private imports = 0
  private bytes = 0
  private disposed = false
  private overlay?: CanvasOverlayRenderer
  attachCanvas(canvas: OffscreenCanvas) {
    if (this.canvas === canvas) return
    this.context.unconfigure()
    this.canvas = canvas
    this.context = canvas.getContext('webgpu')!
    if (!this.context) throw Error('WebGPU display canvas unavailable')
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      colorSpace: 'srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    })
    this.repaint()
  }
  constructor(
    private device: GPUDevice,
    private canvas: OffscreenCanvas,
    readonly format: GPUTextureFormat,
    private report: (stats: Record<string, unknown>) => void,
  ) {
    this.context = canvas.getContext('webgpu')!
    if (!this.context) throw Error('WebGPU display canvas unavailable')
    this.context.configure({ device, format, alphaMode: 'premultiplied', colorSpace: 'srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })
    this.layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    const module = device.createShaderModule({ code: source }),
      layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const pipeline = (format: GPUTextureFormat, mode = 0, blend?: GPUBlendState) =>
      device.createRenderPipeline({
        layout,
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          constants: { COLOR_MODE: mode },
          targets: [{ format, blend }],
        },
        primitive: { topology: 'triangle-list' },
      })
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    }
    this.pipeline = pipeline(format)
    this.blendPipeline = pipeline(format, 0, blend)
    this.linearPipeline = pipeline('rgba16float', 1)
    this.linearBlendPipeline = pipeline('rgba16float', 1, blend)
    this.resolvePipeline = pipeline(format, 2)
    // The recovered Figma viewer atlas uses LINEAR_MIN_NEAREST_MAG_CLAMP.
    // Do not add bilinear blur to enlarged cached pixels while native detail
    // catches up. Antialiasing remains in the raster; this cannot invent detail.
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'nearest' })
    this.uniforms = device.createBuffer({
      size: 4096 * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }
  capture(width: number, height: number) {
    if (this.disposed) throw Error('Display device retired')
    const bytes = width * height * 4
    if (this.residentBytes + bytes > DISPLAY_TEXTURE_BUDGET)
      throw Error('GPU display resident budget exceeded')
    const texture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
    })
    try {
      const id = ++nextTexture
      const bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.textures.set(id, { texture, bytes, bind })
      this.bytes += bytes
      this.captures++
      return { id, texture }
    } catch (error) {
      // Registration has not completed, so release(ids) cannot find this yet.
      texture.destroy()
      throw error
    }
  }

  import(bitmap: ImageBitmap) {
    let capture: ReturnType<ResidentPresenter['capture']> | undefined
    try {
      capture = this.capture(bitmap.width, bitmap.height)
      this.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: capture.texture, premultipliedAlpha: true },
        [bitmap.width, bitmap.height],
      )
      this.imports++
      return capture.id
    } catch (error) {
      if (capture) this.release([capture.id])
      throw error
    } finally {
      // Ownership arrives here even when resident admission rejects the copy.
      bitmap.close()
    }
  }

  release(ids: number[]) {
    for (const id of ids) {
      const entry = this.textures.get(id)
      if (entry) {
        entry.texture.destroy()
        this.bytes -= entry.bytes
        this.textures.delete(id)
      }
    }
  }
  replace(slot: number, next: number) {
    const old = this.textures.get(slot),
      replacement = this.textures.get(next)
    if (
      !old ||
      !replacement ||
      old.texture.width !== replacement.texture.width ||
      old.texture.height !== replacement.texture.height
    )
      throw Error('Resident interaction texture ownership changed')
    old.texture.destroy()
    this.bytes -= old.bytes
    this.textures.delete(next)
    this.textures.set(slot, replacement)
  }
  snapshot() {
    if (!this.backbuffer || !this.drawn || this.disposed) return
    const { width, height, texture } = this.backbuffer
    const captured = this.capture(width, height), encoder = this.device.createCommandEncoder()
    encoder.copyTextureToTexture({ texture }, { texture: captured.texture }, [width, height])
    this.device.queue.submit([encoder.finish()])
    return { gpuTile: captured.id, frame: this.drawn }
  }
  private contentFrame() {
    const frame=this.drawn
    if(!frame)throw Error('No displayed document content')
    return {presentationId:frame.presentationId,view:frame.view,width:frame.width,height:frame.height,dpr:frame.dpr,
      interaction:!!frame.interaction,ids:frame.items.filter(i=>i.active).map(i=>i.tile.gpuTile)}
  }
  async readContentPixel(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement) {
    if(!this.backbuffer||![u,v].every(Number.isFinite)||u<0||v<0||u>=1||v>=1)throw Error('Invalid content sample')
    const {texture,width,height}=this.backbuffer,frame=this.contentFrame()
    if(expected&&(expected.presentationId!==frame.presentationId||expected.view.x!==frame.view.x||expected.view.y!==frame.view.y||expected.view.zoom!==frame.view.zoom||expected.width!==frame.width||expected.height!==frame.height||expected.dpr!==frame.dpr))
      throw Error('画面已变化，请重新取色')
    const buffer=this.device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    try{
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToBuffer({texture,origin:[Math.floor(u*width),Math.floor(v*height),0]},{buffer,bytesPerRow:256},[1,1])
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ)
      const bytes=new Uint8Array(buffer.getMappedRange().slice(0,4));buffer.unmap()
      if(this.format.startsWith('bgra'))[bytes[0],bytes[2]]=[bytes[2],bytes[0]]
      const alpha=bytes[3]/255
      return {contentPixel:[...bytes.slice(0,3)].map(c=>alpha?Math.min(255,Math.round(c/alpha)):0).concat(bytes[3]),contentFrame:frame}
    }finally{buffer.destroy()}
  }
  async captureContentBitmap() {
    if(!this.backbuffer)throw Error('No displayed document content')
    const {texture,width,height}=this.backbuffer,frame=this.contentFrame()
    if(this.residentBytes+width*height*4>DISPLAY_TEXTURE_BUDGET)throw Error('Content snapshot budget exceeded')
    const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('webgpu')!
    context.configure({device:this.device,format:this.format,alphaMode:'premultiplied',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT})
    try{
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToTexture({texture},{texture:context.getCurrentTexture()},[width,height])
      this.device.queue.submit([encoder.finish()]);await this.device.queue.onSubmittedWorkDone()
      return {bitmap:canvas.transferToImageBitmap(),contentFrame:frame}
    }finally{context.unconfigure()}
  }
  draw(frame: ResidentFrame) {
    this.latest = frame
    if (this.disposed) return
    const { view, width, height, dpr } = frame,
      w = Math.max(1, Math.ceil(width * dpr)),
      h = Math.max(1, Math.ceil(height * dpr))
    if (
      w > this.device.limits.maxTextureDimension2D ||
      h > this.device.limits.maxTextureDimension2D
    )
      throw Error('Display dimensions exceed device limits')
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    const rows: {
      item: ResidentItem
      entry: { texture: GPUTexture; bytes: number; bind: GPUBindGroup }
      raster: NonNullable<ReturnType<typeof compositeRasterQuad>>
    }[] = []
    // A nonresident tile cannot occlude a valid lower-density source. Filter
    // before planning, not after covered rectangles have removed that source.
    const available = frame.items.filter(item => this.textures.has(item.tile.gpuTile))
    const missing = frame.items.filter(item => item.active && !this.textures.has(item.tile.gpuTile)).map(item => item.tile.gpuTile)
    if (missing.length) this.report({ missingGpuTiles: missing })
    for (const planned of compositeDrawPlan(available as CompositeItem[], view, width, height)) {
      const item = planned.item as ResidentItem
      const { tile, active, placement } = item,
        entry = this.textures.get(tile.gpuTile)
      if (!active || !entry) continue
      const scale = view.zoom / tile.zoom,
        p = placement || {
          left: (tile.x - (tile.phaseX || 0)) * scale + view.x,
          top: (tile.y - (tile.phaseY || 0)) * scale + view.y,
          width: tile.width * scale,
          height: tile.height * scale,
        }
      const raster = compositeRasterQuad(p, planned.clip, width, height, dpr)
      if (!raster) continue
      rows.push({
        item,
        entry,
        raster,
      })
    }
    // Do not clear a previously displayed frame for an empty/incomplete handoff.
    if (!rows.length && !frame.allowEmpty) return
    if (!this.backbuffer || this.backbuffer.width !== w || this.backbuffer.height !== h) {
      if (this.bytes + w * h * 4 + (this.overlay?.residentBytes || 0) + (this.linearTarget ? this.linearTarget.width * this.linearTarget.height * 8 : 0) > DISPLAY_TEXTURE_BUDGET)
        throw Error('GPU display resident budget exceeded')
      const texture = this.device.createTexture({ size: [w, h], format: this.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC })
      this.backbuffer?.texture.destroy()
      this.backbuffer = { texture, width: w, height: h }
    }
    const linear = frame.linearBlend === true && rows.some((row) => row.item.blend)
    if (rows.length + (linear ? 1 : 0) > 4096) throw Error('Too many visible display tiles')
    if (
      linear &&
      (!this.linearTarget || this.linearTarget.width !== w || this.linearTarget.height !== h)
    ) {
      if (this.bytes + w * h * 8 + w * h * 4 + (this.overlay?.residentBytes || 0) > DISPLAY_TEXTURE_BUDGET)
        throw Error('GPU linear display budget exceeded')
      this.linearTarget?.texture.destroy()
      const texture = this.device.createTexture({
        size: [w, h],
        format: 'rgba16float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      const bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.linearTarget = { texture, bind, width: w, height: h }
    }
    this.transformData.begin()
    rows.forEach((row,i)=>this.transformData.set(i,[...row.raster.box,...row.raster.uv,width,height,0,0]))
    if(linear)this.transformData.set(rows.length,[0,0,width,height,0,0,1,1,width,height,0,0])
    const update=this.transformData.changed()
    const upload=import.meta.env.VITE_DESIGN_RESIDENT_TRANSFORMS==='0'
      ?{offset:0,data:this.transformData.data.subarray(0,(rows.length+(linear?1:0))*64)}:update
    if(upload?.data.length)this.device.queue.writeBuffer(this.uniforms,upload.offset,upload.data)
    const background = frame.backgroundLinear || [1, 1, 1, 1]
    const encoder = this.device.createCommandEncoder(),
      pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: (linear
              ? this.linearTarget!.texture
              : this.backbuffer.texture
            ).createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: linear
              ? [
                  background[0] * background[3],
                  background[1] * background[3],
                  background[2] * background[3],
                  background[3],
                ]
              : [0, 0, 0, 0],
          },
        ],
      })
    rows.forEach((row, i) => {
      const r = row.raster
      pass.setScissorRect(r.x, r.y, r.width, r.height)
      pass.setPipeline(
        linear
          ? row.item.blend
            ? this.linearBlendPipeline
            : this.linearPipeline
          : row.item.blend
            ? this.blendPipeline
            : this.pipeline,
      )
      pass.setBindGroup(0, row.entry.bind, [i * 256])
      pass.draw(6)
    })
    pass.end()
    if (linear) {
      const resolve = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.backbuffer.texture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      })
      resolve.setPipeline(this.resolvePipeline)
      resolve.setBindGroup(0, this.linearTarget!.bind, [rows.length * 256])
      resolve.draw(6)
      resolve.end()
    }
    const output = this.context.getCurrentTexture()
    encoder.copyTextureToTexture({ texture: this.backbuffer.texture }, { texture: output }, [w, h])
    if (frame.overlay) {
      this.overlay ??= new CanvasOverlayRenderer(this.device, this.format)
      const overlay=frame.overlayPose?translateOverlay(frame.overlay,new Map(Object.entries(frame.overlayPose))):frame.overlay
      this.overlay.draw(encoder, output, overlay, view, width, height, dpr)
    }
    this.device.queue.submit([encoder.finish()])
    this.drawn = frame
    this.frames++
    const coverageAt=performance.now()
    const terminalQuality = this.terminalQualityGate.claim(frame.terminalQuality, gpuDiagnosticsDetail())
    const measureCoverage=!!terminalQuality || import.meta.env.DEV || (gpuDiagnosticsDetail() && coverageAt-this.diagnosticCoverageAt>=250)
    if(measureCoverage)this.diagnosticCoverageAt=coverageAt
    this.report({
      ...(terminalQuality ? { ...terminalQuality, qualityTerminal: true } : {}),
      coverageMeasured:measureCoverage,
      ...(measureCoverage?{coverageAt}:{}),
      compositor: 'webgpu-resident',
      compositorFrames: this.frames,
      compositorTransformUploadBytes: upload?.data.byteLength || 0,
      compositorUploads: this.imports,
      compositorCaptures: this.captures,
      compositorBytes: this.residentBytes,
      compositorOverlayBytes: this.overlay?.residentBytes || 0,
      compositorTiles: this.textures.size,
      compositorDraws: rows.length + (linear ? 1 : 0),
      linearBlend: linear,
      presented: {
        presentationId: frame.presentationId,
        gpuOverlay: !!frame.overlay,
        view,
        width,
        height,
        dpr,
        interaction: !!frame.interaction,
        ids: frame.items
          .filter((item) => item.active && this.textures.has(item.tile.gpuTile))
          .map((item) => item.tile.gpuTile),
      },
      input: frame.input,
      missingTextureCount: missing.length,
      ...(measureCoverage ? presentationQuality(available as CompositeItem[], view, width, height, dpr) : {}),
      ...(measureCoverage ? physicalCoverage(rows.map(row=>({...row.raster,
        blend:row.item.blend,native:Math.min(row.item.tile.width*row.raster.uv[2]/row.raster.box[2],row.item.tile.height*row.raster.uv[3]/row.raster.box[3])>=dpr*(1-1e-10)})),w,h):{}),
      // Diagnostic geometry of pixels actually submitted, excluding missing
      // textures. Tests can distinguish absent document content from the known
      // empty page background outside the document's paint bounds.
      ...(import.meta.env.DEV ? { worldCoverage: JSON.stringify(rows.map(row => ({
        x: (row.raster.box[0] - view.x) / view.zoom,
        y: (row.raster.box[1] - view.y) / view.zoom,
        width: row.raster.box[2] / view.zoom, height: row.raster.box[3] / view.zoom,
        density: row.item.tile.zoom,
      }))) } : {}),
    })
  }
  repaint() {
    if (this.latest) this.draw(this.latest)
  }
  get residentBytes() {
    return (
      this.bytes + (this.linearTarget ? this.linearTarget.width * this.linearTarget.height * 8 : 0) +
      (this.backbuffer ? this.backbuffer.width * this.backbuffer.height * 4 : 0) + (this.overlay?.residentBytes || 0)
    )
  }
  lost(message: string) {
    this.report({ error: `GPU display device lost: ${message}` })
  }
  dispose() {
    this.overlay?.dispose()
    if (this.disposed) return
    this.disposed = true
    this.release([...this.textures.keys()])
    this.linearTarget?.texture.destroy()
    this.backbuffer?.texture.destroy()
    this.uniforms.destroy()
    this.context.unconfigure()
  }
}
