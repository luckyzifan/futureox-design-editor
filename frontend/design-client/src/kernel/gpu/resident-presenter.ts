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
import { physicalCoverage, physicalPixelCoverage } from './physical-coverage'
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
  private linearTarget?: { texture: GPUTexture; bind: GPUBindGroup; width: number; height: number; payload: PayloadToken }
  private sampler: GPUSampler
  private uniforms: GPUBuffer
  private textures = new Map<number, { texture: GPUTexture; bytes: number; bind: GPUBindGroup; payload: PayloadToken }>()
  private terminalQualityGate = new TerminalQualityGate()
  private latest?: ResidentFrame
  private drawn?: ResidentFrame
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
    recordDeviceLifecycle(this, deviceLifecyclePhase.attached, this.diagnosticFields())
  }
  capture(width: number, height: number) {
    if (this.disposed) throw Error('Display device retired')
    const bytes = width * height * 4
    const payload = this.payload.reserve(bytes)
    let texture: GPUTexture | undefined
    try {
      texture = this.device.createTexture({
      size: [width, height],
      format: this.format,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.COPY_SRC,
      })
      const id = ++nextTexture
      const bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView() },
          { binding: 2, resource: this.sampler },
        ],
      })
      this.payload.commit(payload)
      this.textures.set(id, { texture, bytes, bind, payload })
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
  snapshot() {
    if (!this.backbuffer || !this.drawn || this.disposed) return
    const { width, height, texture } = this.backbuffer
    const captured = this.capture(width, height)
    try {
      const encoder = this.device.createCommandEncoder()
      encoder.copyTextureToTexture({ texture }, { texture: captured.texture }, [width, height])
      this.device.queue.submit([encoder.finish()])
      return { gpuTile: captured.id, frame: this.drawn }
    } catch (error) { this.release([captured.id]); throw error }
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
      entry: { texture: GPUTexture; bytes: number; bind: GPUBindGroup }
      raster: NonNullable<ReturnType<typeof compositeRasterQuad>>
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
    if (!frame.allowEmpty && !physicalPixelCoverage(rows.map(row => ({ ...row.raster, blend: row.item.blend })), w, h)) {
      this.report({ coverageDeferred: 1, coverageDeferredDraws: rows.length,
        diagnosticSequence: frame.diagnosticSequence, missingTextureCount: missing.length })
      return
    }
    const linear = frame.linearBlend === true && rows.some((row) => row.item.blend)
    if (rows.length + (linear ? 1 : 0) > 4096) throw Error('Too many visible display tiles')
    // Reserve the entire replacement peak before creating either target. Keep
    // the old targets and visible canvas unchanged if admission/setup fails.
    const replaceBack = !this.backbuffer || this.backbuffer.width !== w || this.backbuffer.height !== h
    const replaceLinear = linear && (!this.linearTarget || this.linearTarget.width !== w || this.linearTarget.height !== h)
    let backPayload: PayloadToken | undefined, linearPayload: PayloadToken | undefined
    let nextBack: typeof this.backbuffer, nextLinear: typeof this.linearTarget
    try {
      if (replaceBack) backPayload = this.payload.reserve(w * h * 4)
      if (replaceLinear) linearPayload = this.payload.reserve(w * h * 8)
      if (backPayload) {
        const texture = this.device.createTexture({ size: [w, h], format: this.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | (this.traceAlpha ? GPUTextureUsage.TEXTURE_BINDING : 0) })
        nextBack = { texture, width: w, height: h, payload: backPayload }
      }
      if (linearPayload) {
        const texture = this.device.createTexture({ size: [w, h], format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
        // Register the cleanup owner before bind creation can throw.
        nextLinear = { texture, width: w, height: h, payload: linearPayload, bind: undefined! }
        nextLinear.bind = this.device.createBindGroup({ layout: this.layout, entries: [
          { binding: 0, resource: { buffer: this.uniforms, size: 48 } },
          { binding: 1, resource: texture.createView() }, { binding: 2, resource: this.sampler },
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
              : this.backbuffer!.texture
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
            view: this.backbuffer!.texture.createView(),
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
    encoder.copyTextureToTexture({ texture: this.backbuffer!.texture }, { texture: output }, [w, h])
    if (frame.overlay) {
      this.overlay ??= new CanvasOverlayRenderer(this.device, this.format)
      const overlay=frame.overlayAffines?transformOverlay(frame.overlay,new Map(Object.entries(frame.overlayAffines))):frame.overlayPose?translateOverlay(frame.overlay,new Map(Object.entries(frame.overlayPose))):frame.overlay
      this.overlay.draw(encoder, output, overlay, view, width, height, dpr)
    }
    if (this.traceAlpha) this.alphaTrace ??= new PresenterAlphaTrace(this.device, this.payload, this.report)
    const alpha = this.alphaTrace?.encode(encoder, this.backbuffer!.texture, {
      ...deviceDiagnosticFields(this), alphaFrame: this.frames + 1, alphaSequence: frame.diagnosticSequence, alphaWidth: w, alphaHeight: h,
    })
    try { this.device.queue.submit([encoder.finish()]) } catch (error) { alpha?.cancel(); throw error }
    alpha?.submitted()
    const submittedEpoch = performance.timeOrigin + performance.now()
    this.drawn = frame
    this.frames++
    const coverageAt=performance.now()
    const terminalQuality = this.terminalQualityGate.claim(frame.terminalQuality, detailedDiagnostics)
    const measureCoverage=strictSharpDiagnostics || traceQuality || !!terminalQuality || import.meta.env.DEV || (detailedDiagnostics && coverageAt-this.diagnosticCoverageAt>=250)
    if(measureCoverage)this.diagnosticCoverageAt=coverageAt
    this.report({
      ...this.diagnosticFields(),
      coverageDeferred: 0,
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
      ...(strictSharpDiagnostics || traceQuality ? presentedFragmentQuality(rows.map(row => ({ ...row.raster,
        sourceWidth: row.entry.texture.width, sourceHeight: row.entry.texture.height, blend: row.item.blend })), w, h) :
        measureCoverage ? { ...presentationQuality(available as CompositeItem[], view, width, height, dpr),
          ...physicalCoverage(rows.map(row=>({...row.raster,
            blend:row.item.blend,native:Math.min(row.item.tile.width*row.raster.uv[2]/row.raster.box[2],row.item.tile.height*row.raster.uv[3]/row.raster.box[3])>=dpr*(1-1e-10)})),w,h) } : {}),
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
