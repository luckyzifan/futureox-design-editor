import { PresenterPayloadLedger, type PayloadToken } from './presenter-payload-ledger'
import { deviceDiagnosticFields, registerDeviceDiagnosticOwner, recordDeviceLifecycle, recordDeviceCallback, deviceLostReason, deviceLifecyclePhase } from './device-lifecycle-diagnostics'
import { TerminalQualityGate, type TerminalQuality } from './terminal-quality'
import { gpuDiagnosticsDetail } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import type { CanvasCamera } from '../../canvas-camera'
import type { CompositeItem } from './tile-compositor'
import { presentationQuality } from './presentation-quality'
import { compositeDrawPlan, compositeRasterQuad } from './composite-draw-plan'
import { DISPLAY_TEXTURE_BUDGET } from './display-budget'
import { CanvasOverlayRenderer, translateOverlay, transformOverlay, type CanvasOverlay } from './canvas-overlay'
import { ResidentUniforms } from './resident-uniforms'
import { physicalCoverage, physicalPixelCoverage, physicalCoverageGaps } from './physical-coverage'
import { backgroundPaintRects, emptyBackgroundTile, pageBackgroundProof, type PageBackgroundProof, type PixelContentProof } from './page-background'
import { presentedFragmentQuality } from './presented-fragment-quality'
import { PresenterAlphaTrace } from './presenter-alpha-trace'

export type ResidentItem = Omit<CompositeItem, 'tile'> & {
  tile: Omit<CompositeItem['tile'], 'bytes' | 'bitmap'> & { gpuTile: number }
}
export type ResidentFrame = {
  /** Diagnostic request ordering only, not a content identity. */
  diagnosticSequence?: number
  overlay?: CanvasOverlay
  /** Worker-local placement from the completed resident pose, not input. */
  overlayPose?: Record<string, {x:number;y:number}>
  overlayAffines?: Record<string, import('../../model').Matrix>
  /** Resolve only through this worker's compiled live/stopped slot basis. */
  overlayPoseSlot?: number
  terminalQuality?: TerminalQuality
  presentationId?: string
  items: ResidentItem[]
  view: CanvasCamera
  width: number
  height: number
  dpr: number
  interaction?: boolean
  gestureGuides?: boolean
  allowEmpty?: boolean
  allowBackground?: boolean
  /** Uniform translation of all authored page roots, in world units. Only
   * changes the compiler-owned paint support used for background gap proof. */
  backgroundTranslation?: { x: number; y: number }
  linearBlend?: boolean
  backgroundLinear?: [number, number, number, number]
  input?: import('../interaction-layers').InteractionInput & { owner?:string }
}
let nextTexture = 0
const source = `override COLOR_MODE:i32=0;struct U { box:vec4<f32>,uv:vec4<f32>,viewport:vec2<f32>,sample:f32,pad:f32 }
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
// Preserve coverage/background correlation between independent retained
// layers. Each raster phase is composed before the single final resolve.
const sampleSource = source.replace('pixels:texture_2d<f32>', 'pixels:texture_2d_array<f32>')
  .replace('let value=textureSample(pixels,filtering,v.uv);', `
 var value=textureSample(pixels,filtering,v.uv,i32(u.sample));
 if(COLOR_MODE==2){value=(textureSample(pixels,filtering,v.uv,0)+textureSample(pixels,filtering,v.uv,1)+
 textureSample(pixels,filtering,v.uv,2)+textureSample(pixels,filtering,v.uv,3))*0.25;}`)

/** The raster device also owns display textures and the final canvas. Frames
 * contain handles and transforms only; no ImageBitmap or pixel readback. */
export class ResidentPresenter {
  private transformData = new ResidentUniforms()
  private context: GPUCanvasContext
  private layout: GPUBindGroupLayout
  private sampleLayout: GPUBindGroupLayout
  private pipeline: GPURenderPipeline
  private blendPipeline: GPURenderPipeline
  private linearPipeline: GPURenderPipeline
  private linearBlendPipeline: GPURenderPipeline
  private linearSourcePipeline: GPURenderPipeline
  private linearSourceBlendPipeline: GPURenderPipeline
  private resolvePipeline: GPURenderPipeline
  private samplePipeline: GPURenderPipeline
  private sampleBlendPipeline: GPURenderPipeline
  private sampleResolvePipeline: GPURenderPipeline
  private linearTarget?: { texture: GPUTexture; bind: GPUBindGroup; width: number; height: number; samples:1|4; payload: PayloadToken }
  private sampler: GPUSampler
  private uniforms: GPUBuffer
  private textures = new Map<number, { texture: GPUTexture; bytes: number; bind: GPUBindGroup; payload: PayloadToken; background?:PageBackgroundProof; content?:PixelContentProof; constantBackground?:boolean;linear?:boolean;samples?:1|4 }>()
  private terminalQualityGate = new TerminalQualityGate()
  private latest?: ResidentFrame
  private drawn?: ResidentFrame
  private translatedProof?:{frame:ResidentFrame;source:PageBackgroundProof;offset:{x:number;y:number}}
  private translatedProofChecks=0
  private backbuffer?: { texture: GPUTexture; width: number; height: number; payload: PayloadToken }
  private payload: PresenterPayloadLedger
  private diagnosticCoverageAt = -Infinity
  private frames = 0
  private captures = 0
  private imports = 0
  private bytes = 0
  private disposed = false
  private overlay?: CanvasOverlayRenderer
  private alphaTrace?: PresenterAlphaTrace
  private readonly traceAlpha = import.meta.env.VITE_DESIGN_PRESENT_ALPHA_TRACE === '1'
  get payloadStats() { return this.payload.snapshot() }
  diagnosticFields() {
    const payload = this.payloadStats
    return { ...deviceDiagnosticFields(this), deviceCounterMask: 15, devicePendingCaptures: payload.pendingCaptures,
      devicePendingCapturePayloadBytes: payload.captureReservedBytes, devicePendingReadbacks: payload.pendingReadbacks,
      deviceLogicalPayloadBytes: this.residentBytes, deviceRetiringPayloadBytes: payload.retiringBytes }
  }
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
    // Reattachment may happen while latest is still incomplete. The accepted
    // backing survives independently of its tile handles, so restore it without
    // acknowledging the pending camera or trying to resurrect retired tiles.
    if (this.backbuffer && this.drawn && !this.disposed) {
      this.payload.assertOpen()
      const { width, height, texture } = this.backbuffer, frame = this.drawn
      this.canvas.width = width
      this.canvas.height = height
      const encoder = this.device.createCommandEncoder(), output = this.context.getCurrentTexture()
      encoder.copyTextureToTexture({ texture }, { texture: output }, [width, height])
      this.drawOverlay(encoder, output, frame)
      this.device.queue.submit([encoder.finish()])
    }
    this.repaint()
    recordDeviceLifecycle(this, deviceLifecyclePhase.attached, this.diagnosticFields())
  }
  constructor(
    private device: GPUDevice,
    private canvas: OffscreenCanvas,
    readonly format: GPUTextureFormat,
    private report: (stats: Record<string, unknown>) => void,
  ) {
    this.payload = new PresenterPayloadLedger(() => device.queue.onSubmittedWorkDone(), DISPLAY_TEXTURE_BUDGET, () => this.overlay?.residentBytes || 0)
    const diagnosticIdentity = registerDeviceDiagnosticOwner(this, device, 2)
    const payload = this.payload
    // A healthy parked driver is disposed but deliberately retains this
    // presenter. Its driver loss callback can return early in that state, so
    // pending presenter outputs must observe loss independently.
    void device.lost.then(info => {
      if (this.device !== device || this.payload !== payload) return
      payload.close('lost')
      recordDeviceCallback(this, diagnosticIdentity, this.disposed ? deviceLifecyclePhase.callbackDiscarded : deviceLifecyclePhase.lost,
        { ...this.diagnosticFields(), deviceLostReason: deviceLostReason(info.reason), deviceCallbackDisposition: this.disposed ? 3 : 1 })
    })
    this.context = canvas.getContext('webgpu')!
    if (!this.context) throw Error('WebGPU display canvas unavailable')
    this.context.configure({ device, format, alphaMode: 'premultiplied', colorSpace: 'srgb',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST })
    const makeLayout = (array=false) => device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension:array?'2d-array':'2d' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    this.layout=makeLayout();this.sampleLayout=makeLayout(true)
    const module = device.createShaderModule({ code: source }),
      layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      sampleModule = device.createShaderModule({code:sampleSource}),
      sampleLayout = device.createPipelineLayout({bindGroupLayouts:[this.sampleLayout]})
    const pipeline = (format: GPUTextureFormat, mode = 0, blend?: GPUBlendState,array=false) =>
      device.createRenderPipeline({
        layout:array?sampleLayout:layout,
        vertex: { module:array?sampleModule:module, entryPoint: 'vertex' },
        fragment: {
          module:array?sampleModule:module,
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
    this.linearSourcePipeline = pipeline('rgba16float', 0)
    this.linearSourceBlendPipeline = pipeline('rgba16float', 0, blend)
    this.resolvePipeline = pipeline(format, 2)
    this.samplePipeline=pipeline('rgba16float',0,undefined,true)
    this.sampleBlendPipeline=pipeline('rgba16float',0,blend,true)
    this.sampleResolvePipeline=pipeline(format,2,undefined,true)
    // The recovered Figma viewer atlas uses LINEAR_MIN_NEAREST_MAG_CLAMP.
    // Do not add bilinear blur to enlarged cached pixels while native detail
    // catches up. Antialiasing remains in the raster; this cannot invent detail.
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'nearest' })
    this.uniforms = device.createBuffer({
      size: 4096 * 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    recordDeviceLifecycle(this, deviceLifecyclePhase.attached, this.diagnosticFields())
  }
  capture(width: number, height: number, background?:PageBackgroundProof, content:PixelContentProof|undefined=background,linear=false,samples:1|4=1) {
    if (this.disposed) throw Error('Display device retired')
    if(samples!==1&&samples!==4||samples===4&&!linear)throw Error('Invalid retained sample encoding')
    const bytes = width * height * (linear?8:4)*samples
    const payload = this.payload.reserve(bytes)
    let texture: GPUTexture | undefined
    try {
      texture = this.device.createTexture({
      size: [width, height,samples],
      format: linear?'rgba16float':this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
      })
      const id = ++nextTexture
      const bind = this.device.createBindGroup({
        layout: samples===4?this.sampleLayout:this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView({dimension:samples===4?'2d-array':'2d'}) },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.payload.commit(payload)
      this.textures.set(id, { texture, bytes, bind, payload, background, content,linear,samples })
      this.bytes += bytes
      this.captures++
      return { id, texture }
    } catch (error) {
      // Registration has not completed, so release(ids) cannot find this yet.
      try { texture?.destroy() } finally { this.payload.cancel(payload) }
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

  /** Reserve both the destination and the temporary bitmap before the producer
   * creates an output. The transfer remains charged through destination-queue
   * completion; closing ImageBitmap is not a GPU completion certificate. */
  reserveBitmapImport(width:number,height:number,background?:PageBackgroundProof,content:PixelContentProof|undefined=background){
    const transfer=this.payload.reserve(width*height*4)
    let capture:ReturnType<ResidentPresenter['capture']>
    try{capture=this.capture(width,height,background,content)}catch(error){this.payload.cancel(transfer);throw error}
    let consumed=false
    return {
      id:capture.id,texture:capture.texture,
      cancel:()=>{if(!consumed){consumed=true;this.payload.cancel(transfer)}this.release([capture.id])},
      copy:(bitmap:ImageBitmap)=>{
        let queued=false
        try{
          if(consumed)throw Error('Display transfer already consumed')
          this.payload.assertOpen()
          if(bitmap.width!==width||bitmap.height!==height)throw Error('Display transfer dimensions changed')
          this.device.queue.copyExternalImageToTexture({source:bitmap},{texture:capture.texture,premultipliedAlpha:true},[width,height])
          queued=true;this.imports++;return capture.id
        }finally{
          try{bitmap.close()}finally{
            if(!consumed){consumed=true;if(queued)this.payload.retire(transfer);else{this.payload.cancel(transfer);this.release([capture.id])}}
          }
        }
      },
    }
  }

  release(ids: number[]) {
    for (const id of ids) {
      const entry = this.textures.get(id)
      if (entry) {
        this.textures.delete(id)
        this.bytes -= entry.bytes
        this.payload.retire(entry.payload)
        entry.texture.destroy()
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
    if (slot === next) return
    this.payload.retire(old.payload)
    old.texture.destroy()
    this.bytes -= old.bytes
    this.textures.delete(next)
    this.textures.set(slot, replacement)
  }
  snapshot(background?:PageBackgroundProof) {
    if (!this.backbuffer || !this.drawn || this.disposed) return
    const { width, height, texture } = this.backbuffer
    const captured = this.capture(width, height, background)
    try {
      const encoder = this.device.createCommandEncoder()
      encoder.copyTextureToTexture({ texture }, { texture: captured.texture }, [width, height])
      this.device.queue.submit([encoder.finish()])
      return { gpuTile: captured.id, frame: this.drawn }
    } catch (error) { this.release([captured.id]); throw error }
  }
  backgroundTile(owner:object,contract:string,view:CanvasCamera,output:{x:number;y:number;w:number;h:number}){
    if(this.disposed)return
    for(const entry of this.textures.values()){
      const proof=entry.background
      if(!proof||!emptyBackgroundTile(proof,owner,contract,view,output))continue
      // A one-texel texture is constant under both compositor samplers. Copy
      // the actual encoded pixel; never reproduce color conversion in JS.
      const target=this.capture(1,1,{...proof,pixel:[.5,.5]})
      this.textures.get(target.id)!.constantBackground=true
      try{
        const encoder=this.device.createCommandEncoder()
        encoder.copyTextureToTexture({texture:entry.texture,origin:[Math.floor(proof.pixel![0]*entry.texture.width),Math.floor(proof.pixel![1]*entry.texture.height)]},
          {texture:target.texture},[1,1])
        this.device.queue.submit([encoder.finish()])
        return target.id
      }catch(error){this.release([target.id]);throw error}
    }
  }
  snapshotPageTranslation(sourceOwner:object,targetOwner:object,offset:{x:number;y:number},width:number,height:number,scale:number,contract:string){
    const proof=this.translatedProof,frame=this.drawn
    const decline=(reason:number)=>{if(gpuDiagnosticsDetail())this.report({pageCommitStage:2,pageCommitReason:reason,pageCommitChecks:this.translatedProofChecks});return undefined}
    if(!proof||!frame)return decline(1)
    if(proof.frame!==frame)return decline(2)
    if(proof.source.owner!==sourceOwner)return decline(3)
    if(!contract||proof.source.contract!==contract)return decline(4)
    if(proof.offset.x!==offset.x||proof.offset.y!==offset.y)return decline(5)
    if(frame.view.zoom*frame.dpr!==scale||Math.ceil(frame.width*frame.dpr)!==width||Math.ceil(frame.height*frame.dpr)!==height)return decline(6)
    const dx=frame.view.x*frame.dpr-proof.source.view.x+offset.x*scale
    const dy=frame.view.y*frame.dpr-proof.source.view.y+offset.y*scale
    if(![dx,dy].every(Number.isSafeInteger))return decline(7)
    const source={owner:targetOwner,contract,view:{x:frame.view.x*frame.dpr,y:frame.view.y*frame.dpr,zoom:scale},
      bounds:proof.source.bounds.map(b=>[b[0]+dx,b[1]+dy,b[2]+dx,b[3]+dy])}
    const result=this.snapshot(pageBackgroundProof(source,{x:0,y:0,w:width,h:height},width,height))
    if(result&&gpuDiagnosticsDetail())this.report({pageCommitStage:2,pageCommitReason:10,pageCommitChecks:this.translatedProofChecks})
    return result
  }

  private contentFrame() {
    const frame=this.drawn
    if(!frame)throw Error('No displayed document content')
    return {presentationId:frame.presentationId,view:frame.view,width:frame.width,height:frame.height,dpr:frame.dpr,
      interaction:!!frame.interaction,ids:frame.items.filter(i=>i.active).map(i=>i.tile.gpuTile)}
  }
  async readContentPixel(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement) {
    if(!this.backbuffer||![u,v].every(Number.isFinite)||u<0||v<0||u>=1||v>=1)throw Error('Invalid content sample')
    const owner = this.backbuffer
    const payload = await this.payload.reserveAsync(256, 'readback')
    let buffer: GPUBuffer | undefined, submitted = false, completed = false
    try {
      this.payload.assertOpen()
      if (this.backbuffer !== owner) throw Error('画面已变化，请重新取色')
      const {texture,width,height}=owner,frame=this.contentFrame()
      if(expected&&(expected.presentationId!==frame.presentationId||expected.view.x!==frame.view.x||expected.view.y!==frame.view.y||expected.view.zoom!==frame.view.zoom||expected.width!==frame.width||expected.height!==frame.height||expected.dpr!==frame.dpr))
        throw Error('画面已变化，请重新取色')
      buffer=this.device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToBuffer({texture,origin:[Math.floor(u*width),Math.floor(v*height),0]},{buffer,bytesPerRow:256},[1,1])
      this.device.queue.submit([encoder.finish()]);submitted=true;await buffer.mapAsync(GPUMapMode.READ)
      this.payload.assertOpen()
      const bytes=new Uint8Array(buffer.getMappedRange().slice(0,4));buffer.unmap();completed=true
      if(this.format.startsWith('bgra'))[bytes[0],bytes[2]]=[bytes[2],bytes[0]]
      const alpha=bytes[3]/255
      return {contentPixel:[...bytes.slice(0,3)].map(c=>alpha?Math.min(255,Math.round(c/alpha)):0).concat(bytes[3]),contentFrame:frame}
    } finally {
      try { buffer?.destroy() } finally {
        if (submitted && (!completed || this.payloadStats.closed)) this.payload.retire(payload)
        else this.payload.cancel(payload)
      }
    }
  }
  async captureContentBitmap() {
    if(!this.backbuffer)throw Error('No displayed document content')
    const owner = this.backbuffer
    const payload = await this.payload.reserveAsync(owner.width * owner.height * 4, 'capture')
    let context: GPUCanvasContext | undefined, bitmap: ImageBitmap | undefined
    let submitted = false, completed = false, cleanupFailed = false
    try {
      this.payload.assertOpen()
      if (this.backbuffer !== owner) throw Error('Content snapshot owner changed')
      const {texture,width,height}=owner,frame=this.contentFrame()
      const canvas=new OffscreenCanvas(width,height)
      context=canvas.getContext('webgpu')!
      if (!context) throw Error('WebGPU content snapshot unavailable')
      context.configure({device:this.device,format:this.format,alphaMode:'premultiplied',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT})
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToTexture({texture},{texture:context.getCurrentTexture()},[width,height])
      this.device.queue.submit([encoder.finish()]);submitted=true;await this.device.queue.onSubmittedWorkDone()
      this.payload.assertOpen()
      bitmap=canvas.transferToImageBitmap();completed=true
      return {bitmap,contentFrame:frame}
    } finally {
      try { context?.unconfigure() }
      catch (error) { cleanupFailed=true;bitmap?.close();throw error }
      finally {
        if (cleanupFailed || (submitted && (!completed || this.payloadStats.closed))) this.payload.retire(payload)
        else this.payload.cancel(payload)
      }
    }
  }
  draw(frame: ResidentFrame) {
    this.latest = frame
    if (this.disposed) return
    this.payload.assertOpen()
    const { view, width, height, dpr } = frame,
      w = Math.max(1, Math.ceil(width * dpr)),
      h = Math.max(1, Math.ceil(height * dpr))
    const detailedDiagnostics = gpuDiagnosticsDetail()
    const strictSharpDiagnostics = import.meta.env.VITE_DESIGN_SHARP_ZOOM === '1' && detailedDiagnostics
    // Independent measurement switch: trace every submitted fragment without
    // selecting another navigation/rendering policy. Off for timing runs.
    const traceQuality = import.meta.env.VITE_DESIGN_MOTION_QUALITY_TRACE === '1' && detailedDiagnostics
    if (
      w > this.device.limits.maxTextureDimension2D ||
      h > this.device.limits.maxTextureDimension2D
    )
      throw Error('Display dimensions exceed device limits')
    const rows: {
      item: ResidentItem
      entry: { texture: GPUTexture; bytes: number; bind: GPUBindGroup; background?:PageBackgroundProof; content?:PixelContentProof; constantBackground?:boolean;linear?:boolean;samples?:1|4 }
      raster: NonNullable<ReturnType<typeof compositeRasterQuad>>
      constant?:boolean
    }[] = []
    // A nonresident tile cannot occlude a valid lower-density source. Filter
    // before planning, not after covered rectangles have removed that source.
    const available = frame.items.filter(item => this.textures.has(item.tile.gpuTile))
    const missing = strictSharpDiagnostics ? [...new Set(compositeDrawPlan(frame.items as CompositeItem[], view, width, height)
      .filter(planned => !this.textures.has((planned.item as ResidentItem).tile.gpuTile) &&
        compositeRasterQuad(planned.placement, planned.clip, width, height, dpr))
      .map(planned => (planned.item as ResidentItem).tile.gpuTile))] :
      frame.items.filter(item => item.active && !this.textures.has(item.tile.gpuTile)).map(item => item.tile.gpuTile)
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
    // A few ready tiles are not authority to replace the entire backbuffer.
    // Check the actual surviving physical draws before resizing, allocating,
    // clearing or acknowledging this camera. Explicit empty interaction
    // captures retain their existing separate clear/background contract.
    let complete=physicalPixelCoverage(rows.map(row=>({...row.raster,blend:row.item.blend})),w,h),backgroundAdded=false
    let backgroundDecline=complete?0:1
    if(!complete&&frame.allowBackground&&!frame.linearBlend){
      // Draw order starts with overview/history. Those certificates describe
      // their own sampling density, so choose a density-matched native source
      // instead of letting the first coarse row veto the entire frame.
      const backgroundView=frame.backgroundTranslation ? {
        ...view,x:view.x+frame.backgroundTranslation.x*view.zoom,y:view.y+frame.backgroundTranslation.y*view.zoom,
      } : view
      const source=rows.find(row=>row.entry.background?.pixel&&
        backgroundPaintRects(row.entry.background,backgroundView,dpr,w,h)!==undefined),proof=source?.entry.background
      backgroundDecline=rows.some(row=>row.entry.background)?3:2
      if(!source&&rows.some(row=>row.entry.background?.pixel))backgroundDecline=4
      if(source&&proof&&rows.every(row=>row.entry.content?.owner===proof.owner&&row.entry.content.contract===proof.contract)){
        backgroundDecline=4
        const paint=backgroundPaintRects(proof,backgroundView,dpr,w,h)
        const gaps=paint&&physicalCoverageGaps(rows.map(row=>({...row.raster,blend:row.item.blend})),w,h)
        if(paint)backgroundDecline=5
        if(paint&&gaps?.every(gap=>!paint.some(b=>gap.x<b.x+b.width&&gap.x+gap.width>b.x&&gap.y<b.y+b.height&&gap.y+gap.height>b.y))){
          const [u,v]=proof.pixel!
          rows.unshift({item:{...source.item,blend:false},entry:source.entry,constant:true,
            raster:{x:0,y:0,width:w,height:h,box:[0,0,width,height],uv:[u,v,0,0]}})
          complete=true;backgroundAdded=true;backgroundDecline=0
        }
      }
    }
    // Empty background is intentional for isolated interaction layers, but a
    // missing source is never intentional transparency. Do not clear the
    // accepted backing when an imported/released interaction handle is absent.
    if (!frame.allowEmpty && !complete || frame.allowEmpty && missing.length > 0) {
      const densityProofs=rows.flatMap(row=>row.entry.background?.pixel&&row.entry.background.view.zoom===view.zoom*dpr?[row.entry.background]:[])
      const backgroundPhaseError=densityProofs.length?Math.min(...densityProofs.map(p=>{
        const dx=view.x*dpr-p.view.x,dy=view.y*dpr-p.view.y;return Math.max(Math.abs(dx-Math.round(dx)),Math.abs(dy-Math.round(dy)))
      })):0
      this.report({ coverageDeferred: 1, coverageDeferredDraws: rows.length, backgroundDecline,
        backgroundDensitySources:densityProofs.length,backgroundPhaseError,
        ...(frame.interaction ? { interactionCoverageMissing: true, input: frame.input } : {}),
        diagnosticSequence: frame.diagnosticSequence, missingTextureCount: missing.length })
      return
    }
    const linear = frame.linearBlend === true && rows.some((row) => row.item.blend)
    if(!linear&&rows.some(row=>row.entry.linear))throw Error('Linear retained layers require linear composition')
    const samples:1|4=linear&&rows.some(row=>row.entry.samples===4)?4:1
    const drawCount=rows.length*samples
    if (drawCount + (linear ? 1 : 0) > 4096) throw Error('Too many visible display tiles')
    // Reserve the entire replacement peak before creating either target. Keep
    // the old targets and visible canvas unchanged if admission/setup fails.
    const replaceBack = !this.backbuffer || this.backbuffer.width !== w || this.backbuffer.height !== h
    const replaceLinear = linear && (!this.linearTarget || this.linearTarget.width !== w || this.linearTarget.height !== h || this.linearTarget.samples!==samples)
    let backPayload: PayloadToken | undefined, linearPayload: PayloadToken | undefined
    let nextBack: typeof this.backbuffer, nextLinear: typeof this.linearTarget
    try {
      if (replaceBack) backPayload = this.payload.reserve(w * h * 4)
      if (replaceLinear) linearPayload = this.payload.reserve(w * h * 8*samples)
      if (backPayload) {
        const texture = this.device.createTexture({ size: [w, h], format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | (this.traceAlpha ? GPUTextureUsage.TEXTURE_BINDING : 0) })
        nextBack = { texture, width: w, height: h, payload: backPayload }
      }
      if (linearPayload) {
        const texture = this.device.createTexture({ size: [w, h,samples], format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
        // Register the cleanup owner before bind creation can throw.
        nextLinear = { texture, width: w, height: h, samples, payload: linearPayload, bind: undefined! }
        nextLinear.bind = this.device.createBindGroup({ layout: samples===4?this.sampleLayout:this.layout, entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView({dimension:samples===4?'2d-array':'2d'}) }, { binding: 2, resource: this.sampler },
        ] })
      }
    } catch (error) {
      try { nextBack?.texture.destroy(); nextLinear?.texture.destroy() }
      finally { if (backPayload) this.payload.cancel(backPayload); if (linearPayload) this.payload.cancel(linearPayload) }
      throw error
    }
    // Publish every new owner before retiring either old target: retirement
    // can synchronously fail its observer and close further admission.
    const oldBack = this.backbuffer, oldLinear = this.linearTarget
    if (nextBack) this.payload.commit(nextBack.payload)
    if (nextLinear) this.payload.commit(nextLinear.payload)
    if (nextBack) this.backbuffer = nextBack
    if (nextLinear) this.linearTarget = nextLinear
    if (nextBack && oldBack) { this.payload.retire(oldBack.payload); oldBack.texture.destroy() }
    if (nextLinear && oldLinear) { this.payload.retire(oldLinear.payload); oldLinear.texture.destroy() }
    this.payload.assertOpen()
    if (this.canvas.width !== w) this.canvas.width = w
    if (this.canvas.height !== h) this.canvas.height = h
    this.transformData.begin()
    for(let phase=0;phase<samples;phase++)rows.forEach((row,i)=>this.transformData.set(phase*rows.length+i,[...row.raster.box,...row.raster.uv,width,height,phase,0]))
    if(linear)this.transformData.set(drawCount,[0,0,width,height,0,0,1,1,width,height,0,0])
    const update=this.transformData.changed()
    const upload=import.meta.env.VITE_DESIGN_RESIDENT_TRANSFORMS==='0'
      ?{offset:0,data:this.transformData.data.subarray(0,(drawCount+(linear?1:0))*64)}:update
    if(upload?.data.length)this.device.queue.writeBuffer(this.uniforms,upload.offset,upload.data)
    const background = frame.backgroundLinear || [1, 1, 1, 1]
    const encoder = this.device.createCommandEncoder()
    for(let phase=0;phase<samples;phase++){
    const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: (linear
              ? this.linearTarget!.texture
              : this.backbuffer!.texture
            ).createView({dimension:'2d',baseArrayLayer:phase,arrayLayerCount:1}),
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
          ? row.entry.samples===4
            ? row.item.blend?this.sampleBlendPipeline:this.samplePipeline
            : row.entry.linear
            ? row.item.blend?this.linearSourceBlendPipeline:this.linearSourcePipeline
            : row.item.blend
            ? this.linearBlendPipeline
            : this.linearPipeline
          : row.item.blend
            ? this.blendPipeline
            : this.pipeline,
      )
      pass.setBindGroup(0, row.entry.bind, [(phase*rows.length+i) * 256])
      pass.draw(6)
    })
    pass.end()
    }
    if (linear) {
      const resolve = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.backbuffer!.texture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      })
      resolve.setPipeline(samples===4?this.sampleResolvePipeline:this.resolvePipeline)
      resolve.setBindGroup(0, this.linearTarget!.bind, [drawCount * 256])
      resolve.draw(6)
      resolve.end()
    }
    const output = this.context.getCurrentTexture()
    encoder.copyTextureToTexture({ texture: this.backbuffer!.texture }, { texture: output }, [w, h])
    this.drawOverlay(encoder, output, frame)
    if (this.traceAlpha) this.alphaTrace ??= new PresenterAlphaTrace(this.device, this.payload, fields => this.report(fields))
    const alpha = this.alphaTrace?.encode(encoder, this.backbuffer!.texture, {
      ...deviceDiagnosticFields(this), alphaFrame: this.frames + 1, alphaSequence: frame.diagnosticSequence, alphaWidth: w, alphaHeight: h,
    })
    try { this.device.queue.submit([encoder.finish()]) } catch (error) { alpha?.cancel(); throw error }
    alpha?.submitted()
    const submittedEpoch = performance.timeOrigin + performance.now()
    this.drawn = frame
    this.translatedProof=undefined
    const translation=frame.backgroundTranslation,sourceProof=rows.find(row=>row.entry.background?.pixel)?.entry.background
    this.translatedProofChecks=Number(complete)|Number(!!frame.interaction)<<1|Number(!!translation)<<2|Number(!!sourceProof)<<3|
      Number(!!sourceProof?.contract)<<4|Number(sourceProof?.view.zoom===view.zoom*dpr)<<5|
      Number(!!sourceProof&&rows.every(row=>row.entry.content?.owner===sourceProof.owner))<<6|
      Number(!!sourceProof&&rows.every(row=>row.entry.content?.contract===sourceProof.contract))<<7
    if(complete&&frame.interaction&&translation&&sourceProof&&sourceProof.view.zoom===view.zoom*dpr&&
      Number.isSafeInteger(width*dpr)&&Number.isSafeInteger(height*dpr)&&
      [translation.x*view.zoom*dpr,translation.y*view.zoom*dpr].every(Number.isSafeInteger)&&
      rows.every(row=>!row.item.blend&&row.entry.content?.owner===sourceProof.owner&&row.entry.content.contract===sourceProof.contract&&
        (row.constant||row.entry.constantBackground||(()=>{
          const tile=row.item.tile,s=view.zoom/tile.zoom,p=row.item.placement
          return !!p&&tile.zoom===view.zoom*dpr&&tile.width===row.entry.texture.width&&tile.height===row.entry.texture.height&&
            [p.left*dpr,p.top*dpr].every(Number.isSafeInteger)&&p.width*dpr===row.entry.texture.width&&p.height*dpr===row.entry.texture.height&&
            p.left===(tile.x-(tile.phaseX||0))*s+view.x+translation.x*view.zoom&&
            p.top===(tile.y-(tile.phaseY||0))*s+view.y+translation.y*view.zoom&&
            p.width===tile.width*s&&p.height===tile.height*s
        })()))){
      // Strict pixel-lattice checks above and complete integer scissors are
      // authority here. The sparse/toleranced quality diagnostics are not.
      this.translatedProof={frame,source:sourceProof,offset:{...translation}}
    }
    this.frames++
    const coverageAt=performance.now()
    const terminalQuality = this.terminalQualityGate.claim(complete?frame.terminalQuality:undefined, detailedDiagnostics)
    const measureCoverage=strictSharpDiagnostics || traceQuality || !!terminalQuality || import.meta.env.DEV || (detailedDiagnostics && coverageAt-this.diagnosticCoverageAt>=250)
    if(measureCoverage)this.diagnosticCoverageAt=coverageAt
    this.report({
      ...this.diagnosticFields(),
      coverageDeferred: 0,
      ...(!complete&&!frame.interaction?{pixelCoverageComplete:false,nativeCoverageComplete:false,qualityTerminal:false}:{}),
      backgroundCoverage: Number(backgroundAdded),
      diagnosticSequence: frame.diagnosticSequence, submittedEpoch,
      gridVisible: !!frame.overlay?.pixelGrid && view.zoom>=4, dpr,
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
      compositorDraws: drawCount + (linear ? 1 : 0),
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
      ...(strictSharpDiagnostics || traceQuality || backgroundAdded ? presentedFragmentQuality(rows.map(row => ({ ...row.raster,constant:row.constant,
        sourceWidth: row.entry.texture.width, sourceHeight: row.entry.texture.height, blend: row.item.blend })), w, h) :
        measureCoverage ? { ...presentationQuality(available as CompositeItem[], view, width, height, dpr),
          ...physicalCoverage(rows.map(row=>({...row.raster,
            blend:row.item.blend,native:!!row.constant||Math.min(row.item.tile.width*row.raster.uv[2]/row.raster.box[2],row.item.tile.height*row.raster.uv[3]/row.raster.box[3])>=dpr*(1-1e-10)})),w,h) } : {}),
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
  private drawOverlay(encoder: GPUCommandEncoder, output: GPUTexture, frame: ResidentFrame) {
    const guides = frame.gestureGuides ? frame.input?.guides : undefined
    if (!frame.overlay && !guides?.length) return
    this.overlay ??= new CanvasOverlayRenderer(this.device, this.format)
    const base = frame.overlay || { pixelGrid:false }
    const overlay = frame.overlayAffines ? transformOverlay(base, new Map(Object.entries(frame.overlayAffines))) :
      frame.overlayPose ? translateOverlay(base, new Map(Object.entries(frame.overlayPose))) : base
    // Guide coordinates already describe this sampled pose and its stationary
    // targets. Never affine-transform them with the selected object again.
    this.overlay.draw(encoder, output, { ...overlay, guides }, frame.view, frame.width, frame.height, frame.dpr)
  }
  get residentBytes() {
    return (
      this.bytes + (this.linearTarget ? this.linearTarget.width * this.linearTarget.height * 8*this.linearTarget.samples : 0) +
      (this.backbuffer ? this.backbuffer.width * this.backbuffer.height * 4 : 0) + (this.overlay?.residentBytes || 0)
    )
  }
  lost(message: string) {
    this.payload.close('lost')
    this.report({ ...this.diagnosticFields(), error: `GPU display device lost: ${message}` })
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.alphaTrace?.close()
    this.payload.close('disposed')
    recordDeviceLifecycle(this, deviceLifecyclePhase.disposed, this.diagnosticFields())
    this.overlay?.dispose()
    this.release([...this.textures.keys()])
    if (this.linearTarget) { this.payload.retire(this.linearTarget.payload); this.linearTarget.texture.destroy(); this.linearTarget = undefined }
    if (this.backbuffer) { this.payload.retire(this.backbuffer.payload); this.backbuffer.texture.destroy(); this.backbuffer = undefined }
    this.uniforms.destroy()
    this.context.unconfigure()
  }
}
