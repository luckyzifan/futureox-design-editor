import { captureDeviceDiagnosticRequest, deviceDiagnosticFields, registerDeviceDiagnosticOwner, recordDeviceLifecycle, recordDeviceDiagnostic, recordDeviceCallback, deviceLifecyclePhase, deviceLostReason } from './device-lifecycle-diagnostics'
import { markRenderFailure, renderFailureFields, withRenderFailureStage } from '../render-failure-telemetry'
import { recordGpuDiagnostic, gpuDiagnosticsEnabled } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
import { QueueWaitStats, type QueueWaitReason } from './queue-wait-stats'
import { textureByteLength } from './texture-byte-length'
/// <reference types="@webgpu/types" />
import vectorShader from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import { minifiedPreviewRgba8 } from './rgba8'
import samplingShader from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import { exactFilterWgsl, rationalStubWgsl } from './exact-filter'
import { compositorModes } from './compositor-modes'
import { TexturePrefix, PREFIX_SCRATCH_BYTES } from './texture-prefix'
import { prefixModule } from './prefix-module'
import { displayFilterWgsl, pairedDisplayFilterWgsl } from './display-filter'
import { displayArithmeticSource } from './display-arithmetic'
import { imageCoordinateSource } from './image-coordinate-source'
import { scalarCoverageSource, SCALAR_COVERAGE_UNIFORM } from './scalar-coverage'
import { ResidentPresenter, type ResidentFrame } from './resident-presenter'
import { isDisplayBudgetError } from './display-budget'
import byteSamplingShader from '../../../../../design-studio/crates/design-kernel/shaders/byte-sampling.wgsl?raw'
import { areaShaderWgsl } from './area-shader'
import type { Driver, Texture, PathMesh, Rect, GpuScene, GpuAdmissionDiagnostic } from './types'
import { parameters, previewUniforms, type PreviewPresentation } from './types'
import { MAX_SOLID_INSTANCES, SOLID_INSTANCE_FLOATS } from './solid-batch'
import { GpuBindingCache } from './binding-cache'
import { ResidentGeometry } from './resident-geometry'
import { ResidentPrograms } from './resident-programs'
import { PipelineRegistry } from './pipeline-registry'
const maskShader = `struct Params{values:array<vec4<f32>,64>} @group(0) @binding(0) var<uniform> p:Params;
@vertex fn mesh(@location(0) point:vec2<f32>)->@builtin(position) vec4<f32>{return vec4<f32>((point.x-p.values[1].x)/p.values[0].z*2.-1.,1.-(point.y-p.values[1].y)/p.values[0].w*2.-1.,0.,1.);}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);}
@fragment fn white()->@location(0) vec4<f32>{return vec4<f32>(1);}`

/** Consecutive frames of ≥4× overprovision before a geometry buffer shrinks. */
const CAPACITY_SHRINK_FRAMES = 60
/** How long a parked driver keeps its (non-lost) device and compiled pipelines
 * between a dispose and the next matching create. Preview-tile budget recovery
 * disposes and immediately re-creates the whole GPU stack; parking lets that
 * re-entry reuse the device and pipelines instead of paying a full
 * adapter/device/pipeline rebuild. Idle entries are reaped so the memory
 * returns when no recovery follows (freeGPUMemoryForWorker semantics). */
const PARKED_REAP_MS = 30_000
type ParkedDriver = {
  driver: WebGpuDriver
  key: string
  settled: Promise<void>
  reaper: ReturnType<typeof setTimeout>
}
export class WebGpuDriver implements Driver {
  private queueWaitStats = new QueueWaitStats(import.meta.env.VITE_DESIGN_QUEUE_WAIT_TIMING === '1')
  private waitForQueue(reason: QueueWaitReason, admission?: GpuAdmissionDiagnostic) {
    const diagnosticIdentity = { ...captureDeviceDiagnosticRequest(), ...deviceDiagnosticFields(this), deviceFenceResourceEpoch: this.resourceEpoch, deviceFenceCompletedResourceEpoch: this.completedResourceEpoch }
    const started=gpuDiagnosticsEnabled()?performance.now():0
    const pending=this.queueWaitStats.wait(reason, () => this.device.queue.onSubmittedWorkDone(), () => this.lost)
    if(!gpuDiagnosticsEnabled())return pending
    return pending.finally(()=>recordDeviceDiagnostic('fence',{...admission,...diagnosticIdentity,reasonCode:['readback','timing','prefix-scratch','interaction','periodic','admission','checkpoint','cancel','initialization','park'].indexOf(reason)+1,queueWaitMs:performance.now()-started,resourceEpoch:this.resourceEpoch,completedResourceEpoch:this.completedResourceEpoch}))
  }
  private bindingCache = new GpuBindingCache()
  // Rollout gate until real-device validation and timings are available. The
  // static-offset route remains an exact negative control for bisection.
  private dynamicUniformBindings = import.meta.env.VITE_DESIGN_DYNAMIC_UNIFORMS === '1'
  resourceEpoch = 0
  completedResourceEpoch = 0
  private pipelines = new PipelineRegistry()
  private curveMirror = new ResidentGeometry()
  private vertexMirror = new ResidentGeometry()
  private geometryUploadBytes = 0
  private rasterReadbackBytes = 0
  private crossDeviceBitmaps = 0
  private residentCaptures = 0
  private programArena = new ResidentPrograms()
  private scenePrograms?: NonNullable<PathMesh['area']>[]
  private programOffsets?: Map<number,number>
  private programGpuValid = false
  private programArenaActive = false
  private programHits = 0
  private programHitBytes = 0
  captureDisplay = false
  private presenter?: ResidentPresenter
  private lifecycleFields() {
    const counters = this.presenter?.diagnosticFields()
    return { ...counters, ...deviceDiagnosticFields(this), deviceCounterMask: counters?.deviceCounterMask ?? 0 }
  }
  attachPresenter(canvas: OffscreenCanvas, report: (stats: Record<string, unknown>) => void) {
    if(this.presenter)this.presenter.attachCanvas(canvas)
    else this.presenter=new ResidentPresenter(this.device, canvas, this.format, report)
  }
  presentFrame(frame: ResidentFrame) { this.presenter?.draw(frame) }
  releasePresented(ids: number[]) { this.presenter?.release(ids) }
  replacePresented(slot:number,next:number){this.presenter?.replace(slot,next)}
  snapshotPresented(){return this.presenter?.snapshot()}
  async readContentPixel(u:number,v:number,expected?:import('../resident-presentation').ResidentAcknowledgement){if(!this.presenter)throw Error('No resident display');return this.presenter.readContentPixel(u,v,expected)}
  async captureContentBitmap(){if(!this.presenter)throw Error('No resident display');return this.presenter.captureContentBitmap()}
  importPresented(bitmap: ImageBitmap) {
    if (!this.presenter) { bitmap.close(); throw Error('No resident display') }
    return this.presenter.import(bitmap)
  }
  readonly supportsDisplayFilters = true
  readonly zeroTextureSampling = true
  readonly constantTextureSampling = true
  readonly sequentialSampleResolve = true
  readonly scalarAlphaFilter = true
  readonly exactShadowOver = true
  private displayFilters = false
  private displayFilterPipeline?: GPURenderPipeline
  private pairedDisplay?: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; sampler: GPUSampler }
  private pairDisplayTaps = true
  pairedFilterPasses = 0
  private pairedDisplayFailed = false
  private softwareRaster = false
  readonly name = 'webgpu' as const
  readonly exactSolidPaintOver = true
  readonly canvas = new OffscreenCanvas(1, 1)
  description = 'WebGPU'
  lost = false
  drawCalls = 0
  private mergedExactFilterPasses = 0
  triangles = 0
  commandSubmissions = 0
  private presentationSubmissions = 0
  private interactionPresentation = false
  private nativeInteractionPresentation = false
  private prefix?: TexturePrefix
  private prefixEnabled = false
  private frameScopeOpen = false
  frameScratchBytes = 0
  /** Peak transient bytes the finish path itself allocated (presentation copy,
   * readback target and MAP_READ staging coexist at this peak). Frame-scoped:
   * begin() resets it. */
  finishTransientBytes = 0
  get scratchBytes(){ return this.prefix?.scratchBytes || 0 }
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private format!: GPUTextureFormat
  private layout!: GPUBindGroupLayout
  private maskLayout!: GPUBindGroupLayout
  private paintPipeline!: GPURenderPipeline
  private compositorModule!: GPUShaderModule
  private modePipelines = new Map<number, GPURenderPipeline>()
  private filterPipelines: GPURenderPipeline[] = []
  private normalPipeline?: GPURenderPipeline
  private solidPaintOverPipeline?: GPURenderPipeline
  private resolveStepPipeline?: GPURenderPipeline
  private scalarFilterPipeline?: GPURenderPipeline
  private alphaResolvePipeline?: GPURenderPipeline
  private shadowOverPipeline?: GPURenderPipeline
  private normalCornerPipeline?: GPURenderPipeline
  private copyCornerPipeline?: GPURenderPipeline
  private copyPipeline?: GPURenderPipeline
  private areaPipeline?: GPURenderPipeline
  private binaryAreaPipeline?: GPURenderPipeline
  private scalarAreaPipeline?: GPURenderPipeline
  private scalarPipelines = new Map<number, GPURenderPipeline>()
  private binaryPipelines = new Map<number, GPURenderPipeline>()
  private overPipeline!: GPURenderPipeline
  private solidPipeline!: GPURenderPipeline
  private solidLayout!: GPUBindGroupLayout
  private solidBuffer?: GPUBuffer
  private solidBind?: GPUBindGroup
  private solidData = new Float32Array(MAX_SOLID_INSTANCES * SOLID_INSTANCE_FLOATS)
  private solidOffset = 0
  private solidUploaded = 0
  private solidRanges = new Map<Float32Array, number>()
  private presentPipeline!: GPURenderPipeline
  private maskPipelines = new Map<string, GPURenderPipeline>()
  private coverPipelines = new Map<string, GPURenderPipeline>()
  private uniforms!: GPUBuffer
  private vertices?: GPUBuffer
  private curves?: GPUBuffer
  private curveCapacity = 0
  private vertexCapacity = 0
  /** Consecutive low-demand frames and the window's peak demand per buffer,
   * feeding the capacity shrink in finish(). */
  private vertexShrink = { frames: 0, maxDemand: 0 }
  private curveShrink = { frames: 0, maxDemand: 0 }
  private initialized = false
  private parkedForReuse = false
  private poolKey?: string
  private static parkedDriver?: ParkedDriver
  private offset = 0
  private uploadedOffset = 0
  private uniformCommands = 0
  private uniformData = new Float32Array(1024 * 1024)
  private timingQueries?: GPUQuerySet
  private passTimings?: { mode: number; radius: number; width: number; height: number; count: number; ms: number }[]
  private timingRows: { mode: number; radius: number; width: number; height: number; blend?: number; paint?: number; integerCentres?: boolean }[] = []
  private timingSkipped = 0
  private encoder!: GPUCommandEncoder
  private activeOver?: GPURenderPassEncoder
  private activeTarget?: Texture
  private blank!: Texture
  private textures = new Set<Texture>()
  private replayParameterTextures = new Set<Texture>()
  private transient: GPUTexture[] = []
  private transientTargets: Texture[] = []
  private transientBytes = 0
  private msaa = new Map<
    string,
    { color: GPUTexture; depth: GPUTexture; high: Texture; low: Texture }
  >()
  private disposed = false
  private errors: string[] = []
  constructor(
    readonly managed = false,
    public hdr = false,
    readonly linearLight = managed,
    readonly certifiedFilter = managed,
    readonly displayMath = false,
  ) {}
  private get layerFormat(): GPUTextureFormat {
    return this.managed ? 'rgba32float' : 'rgba8unorm'
  }
  static async create(managed = false, hdr = false, linearLight = managed, certified = true, displayMath = false) {
    displayMath = displayMath && managed && !hdr
    const poolKey = JSON.stringify([managed, hdr, linearLight, certified, displayMath])
    const revived = await WebGpuDriver.reviveParked(poolKey)
    if (revived) {
      revived.prefixEnabled = managed && certified && import.meta.env.VITE_DESIGN_EXACT_PREFIX !== '0'
      return revived
    }
    const driver = new WebGpuDriver(managed, hdr, linearLight, managed && certified && import.meta.env.VITE_DESIGN_CERTIFIED_FILTER !== '0', displayMath)
    try {
      await driver.initialize()
      driver.poolKey = poolKey
      driver.prefixEnabled = managed && certified && import.meta.env.VITE_DESIGN_EXACT_PREFIX !== '0'
      return driver
    } catch (e) {
      driver.dispose()
      throw e
    }
  }
  /** Serve a parked (non-lost, matching-config) driver to the next create so
   * budget-failure recovery reuses its device and compiled pipelines; anything
   * else (lost device, config mismatch, revive failure) falls through to the
   * existing full rebuild. */
  private static async reviveParked(key: string): Promise<WebGpuDriver | undefined> {
    const parked = WebGpuDriver.parkedDriver
    if (!parked) return undefined
    WebGpuDriver.parkedDriver = undefined
    clearTimeout(parked.reaper)
    try {
      await parked.settled
    } catch (error) {
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'park-cleanup-failed', error: String(error) })}`)
    }
    if (parked.driver.lost || parked.key !== key) {
      const configBits=(value:string)=>{try{return (JSON.parse(value) as boolean[]).reduce((bits,v,i)=>bits|(v?1<<i:0),0)}catch{return -1}}
      recordGpuDiagnostic('cache',{reasonCode:parked.driver.lost?2:1,oldConfig:configBits(parked.key),newConfig:configBits(key)})
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({
        event: 'discarded', reason: parked.driver.lost ? 'device-lost' : 'config-mismatch',
      })}`)
      parked.driver.destroyDeviceNow()
      return undefined
    }
    try {
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveStart, parked.driver.lifecycleFields())
      await parked.driver.revive()
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveReady, parked.driver.lifecycleFields())
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'revived', key })}`)
      return parked.driver
    } catch (error) {
      recordDeviceLifecycle(parked.driver, deviceLifecyclePhase.reviveFailed, parked.driver.lifecycleFields())
      console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'revive-failed', error: String(error) })}`)
      parked.driver.destroyDeviceNow()
      return undefined
    }
  }
  private async initialize() {
    if (!navigator.gpu) throw new Error('浏览器未提供 WebGPU')
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      .catch(error => { throw new Error(`GPU_UNAVAILABLE: ${String(error)}`, { cause: error }) })
    if (!adapter) throw new Error('没有可用的 WebGPU 适配器')
    const timing = import.meta.env.DEV && import.meta.env.VITE_DESIGN_GPU_TIMINGS === '1'
    if (timing && !adapter.features.has('timestamp-query')) throw new Error('GPU timestamp queries unavailable')
    const requiredFeatures: GPUFeatureName[] = timing ? ['timestamp-query'] : []
    if (adapter.features.has('float32-filterable')) requiredFeatures.push('float32-filterable')
    this.device = await adapter.requestDevice({ requiredFeatures })
      .catch(error => { throw new Error(`GPU_UNAVAILABLE: ${String(error)}`, { cause: error }) })
    if (this.dynamicUniformBindings) {
      const alignment = this.device.limits.minUniformBufferOffsetAlignment
      if (!Number.isInteger(alignment) || alignment < 1 || 1024 % alignment !== 0)
        throw new Error('WebGPU dynamic uniform alignment does not support the exact 1024-byte stride')
    }
    const diagnosticIdentity = registerDeviceDiagnosticOwner(this, this.device, 1)
    recordDeviceLifecycle(this, deviceLifecyclePhase.created, { deviceCounterMask: 0 })
    if (timing) this.timingQueries = this.device.createQuerySet({ type: 'timestamp', count: 4096 })
    this.description = adapter.info?.description || adapter.info?.architecture || 'WebGPU'
    this.device.lost.then((info) => {
      // Intentional teardown (dispose/reaper) has nothing further to report.
      const fields = { ...this.lifecycleFields(), deviceLostReason: deviceLostReason(info.reason) }
      if (info.reason === 'destroyed' && this.disposed) {
        recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.callbackDiscarded, { ...fields, deviceCallbackDisposition: 2 })
        return
      }
      this.lost = true
      if (this.disposed) {
        recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.callbackDiscarded, { ...fields, deviceCallbackDisposition: 3 })
        return
      }
      recordDeviceCallback(this, diagnosticIdentity, deviceLifecyclePhase.lost, { ...fields, deviceCallbackDisposition: 1 })
      this.presenter?.lost(info.message || 'device lost')
      this.errors.push(info.message || 'GPU device lost')
      // freeGpuMemory semantics: reclaim every pooled texture/buffer/querySet
      // immediately instead of waiting for the next request to dispose. Every
      // destroy() on a lost device is a safe no-op, so this races nothing.
      this.releaseLostResources()
    })
    this.device.addEventListener('uncapturederror', (e) => this.errors.push(e.error.message))
    this.context = this.canvas.getContext('webgpu')!
    if (!this.context) throw new Error('WebGPU Canvas 不可用')
    this.format = this.linearLight && this.hdr ? 'rgba16float' : navigator.gpu.getPreferredCanvasFormat()
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'premultiplied',
      colorSpace: 'srgb',
      toneMapping: { mode: this.hdr ? 'extended' : 'standard' },
    })
    this.hdr = this.hdr && this.context.getConfiguration()?.toneMapping?.mode === 'extended'
    const compositorCode =
        `const BYTE_SURFACE:bool=${!this.managed};\n` +
        (this.managed
          ? samplingShader + '\n' + rationalStubWgsl
          : byteSamplingShader +
            '\nfn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}' + '\nfn bsCorner4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{return a;}') +
        '\n' +
        vectorShader + `
@fragment fn exactPresent(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
 let value=smp(sourceA,p.xy+u(0).xy,u(1));
 if(u(60).z>0.5){return displayColor(value);}
 if(u(61).x>0.5){return analyticDisplayColor(value);}
 if(u(60).x<0.5){return round(clamp(value,vec4<f32>(0),vec4<f32>(1))*255.)/255.;}
 return value;
}
fn integerSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{
 return bsCorner4(at(tex,p,r),at(tex,p+vec2<f32>(1,0),r),at(tex,p+vec2<f32>(0,1),r),at(tex,p+vec2<f32>(1,1),r));
}
@fragment fn exactCopyCorner(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{return integerSample(sourceA,position.xy+u(0).xy,u(1));}
@fragment fn exactResolveStep(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let quarter=mulRN4(at(sourceA,p,u(1)),vec4<f32>(0.25));
 if(u(4).y==0.){return quarter;}
 return addRN4(at(sourceB,p,u(2)),quarter);
}
@fragment fn exactAlphaResolve(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;
 return vec4<f32>(meanFourRN(at(sourceA,p,u(1)),at(sourceB,p,u(2)),at(sourceC,p,u(3)),at(sourceD,p,u(1))).a);
}
fn exactShadowValue(p:vec2<f32>)->vec4<f32>{
 if(any(p<u(0).xy)||any(p>=u(0).xy+u(0).zw)){return vec4<f32>(0);}
 let a=smp(sourceA,p,u(1));let b=smp(sourceB,p-u(9).yz,u(2)).a;
 let coverage=select(b,mulRN(a.a,addRN(1.,-b)),u(9).w>0.5);
 return mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(8).x)),vec4<f32>(coverage));
}
@fragment fn exactShadowOver(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let plane=integerSample(sourceA,p,u(1));
 // Preserve the former texture's integer-centre sampling, including neighbour
 // NaN propagation and zero canonicalization, before the same normal blend.
 let shadow=bsCorner4(exactShadowValue(p),exactShadowValue(p+vec2<f32>(1,0)),exactShadowValue(p+vec2<f32>(0,1)),exactShadowValue(p+vec2<f32>(1,1)));
 if(u(9).w>0.5){return over(plane,mulRN4(shadow,vec4<f32>(1)),0);}
 return over(shadow,mulRN4(plane,vec4<f32>(1)),0);
}
@fragment fn exactNormalCorner(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let a=integerSample(sourceA,p,u(1));var opacity=u(4).z;
 if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 let src=mulRN4(a,vec4<f32>(opacity));let dst=integerSample(sourceB,p,u(2));
 if(src.a<=0.){return dst;}if(dst.a<=0.){return src;}
 return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}
@fragment fn exactSolidPaintOver(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let dst=integerSample(sourceA,p,u(1));
 if(any(p<u(13).xy)||any(p>=u(13).xy+u(13).zw)){return dst;}
 let paint=mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(60).y)),vec4<f32>(u(8).x));
 let covered=mulRN4(paint,vec4<f32>(at(sourceB,p,u(2)).a));
 let bits=bitcast<vec4<u32>>(covered);
 let sampled=bitcast<vec4<f32>>(select(bits,vec4<u32>(0),(bits&vec4<u32>(0x7fffffffu))==vec4<u32>(0)));
 var opacity=1.;if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 return over(dst,mulRN4(sampled,vec4<f32>(opacity)),0);
}
@fragment fn exactNormal(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let a=smp(sourceA,p,u(1));var opacity=u(4).z;
 if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}
 let src=mulRN4(a,vec4<f32>(opacity));let dst=smp(sourceB,p,u(2));
 if(src.a<=0.){return dst;}if(dst.a<=0.){return src;}
 return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}`
    const addressedCode = this.managed ? scalarCoverageSource(imageCoordinateSource(compositorCode)) : compositorCode
    const module = this.device.createShaderModule({
      code: this.displayMath ? displayArithmeticSource(addressedCode, import.meta.env.VITE_DESIGN_NATIVE_DIVISION !== '0') : addressedCode,
      label: 'Self-developed vector compositor',
    })
    this.compositorModule = module
    const mask = this.device.createShaderModule({ code: maskShader, label: 'Stencil and cover' })
    for (const m of [module, mask]) {
      const info = await m.getCompilationInfo()
      const errors = info.messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((e) => `${e.lineNum}:${e.message}`).join('\n'))
    }
    this.layout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 1024, hasDynamicOffset: this.dynamicUniformBindings },
        },
        ...[1, 2, 3, 5].map((binding) => ({
          binding,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage', minBindingSize: 16 },
        },
      ],
    })
    this.maskLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 1024 },
        },
      ],
    })
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      maskLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.maskLayout] })
    // Compile independent programs together; publication waits for every
    // job to settle so a failed initialization cannot outlive device cleanup.
    const register = (key: string, build: () => Promise<void>) => this.pipelines.register(key, build)
    register('paint', async () => {
    this.paintPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: { module, entryPoint: 'fragment', ...(this.managed ? { constants: { COMPOSITOR_MODE: 12 } } : {}), targets: [{ format: this.layerFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    if (this.managed) this.modePipelines.set(12, this.paintPipeline)
    })
    register('area', async () => {
      const areaModule = this.device.createShaderModule({ code: areaShaderWgsl })
      const errors = (await areaModule.getCompilationInfo()).messages.filter(
        (m) => m.type === 'error',
      )
      if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
      this.areaPipeline = await this.device.createRenderPipelineAsync({
        layout,
        vertex: { module: areaModule, entryPoint: 'areaQuad' },
        fragment: {
          module: areaModule,
          entryPoint: 'areaFragment',
          targets: [{ format: this.layerFormat }],
        },
        primitive: { topology: 'triangle-list' },
      })
      if (this.managed) this.binaryAreaPipeline = await this.device.createRenderPipelineAsync({
        layout, vertex: { module: areaModule, entryPoint: 'areaQuad' },
        fragment: { module: areaModule, entryPoint: 'areaFragment', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      if (this.managed) this.scalarAreaPipeline = await this.device.createRenderPipelineAsync({
        layout, vertex:{module:areaModule,entryPoint:'areaQuad'},
        fragment:{module:areaModule,entryPoint:'areaFragment',targets:[{format:'r32float'}]},primitive:{topology:'triangle-list'},
      })
    })
    if (this.managed) register('binary', () => Promise.all([12, 20].map(async (mode) => {
      const pipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' },
        fragment: { module, entryPoint: 'fragment', constants: { COMPOSITOR_MODE: mode }, targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list' },
      })
      this.binaryPipelines.set(mode, pipeline)
    })).then(() => {}))
    if(this.managed)register('scalar', () => Promise.all([12,17,20].map(async mode=>{
      this.scalarPipelines.set(mode,await this.device.createRenderPipelineAsync({layout,
        vertex:{module,entryPoint:'quad'},fragment:{module,entryPoint:'fragment',constants:{COMPOSITOR_MODE:mode},targets:[{format:'r32float'}]},
        primitive:{topology:'triangle-list'}}))
    })).then(()=>{}))
    register('present', async () => {
    this.presentPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: { module, entryPoint: 'exactPresent', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    })
    })
    register('compose', async () => {
    if (this.managed) {
      const make = (entryPoint: string) => this.device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint, targets: [{ format: this.layerFormat }] },
        primitive: { topology: 'triangle-list' } })
      ;[this.normalPipeline, this.copyPipeline, this.normalCornerPipeline, this.copyCornerPipeline, this.solidPaintOverPipeline, this.resolveStepPipeline, this.shadowOverPipeline] = await Promise.all([make('exactNormal'), make('exactPresent'), make('exactNormalCorner'), make('exactCopyCorner'), make('exactSolidPaintOver'), make('exactResolveStep'), make('exactShadowOver')])
      this.alphaResolvePipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'exactAlphaResolve', targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' } })
    }
    if (this.managed) this.overPipeline = this.normalPipeline!
    else {
    this.overPipeline = await this.device.createRenderPipelineAsync({
      layout,
      vertex: { module, entryPoint: 'quad' },
      fragment: {
        module,
        entryPoint: 'fragment',
        ...(this.managed ? { constants: { COMPOSITOR_MODE: 3 } } : {}),
        targets: [
          {
            format: this.layerFormat,
            blend: this.managed
              ? undefined
              : {
                  color: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                  alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    })
    }
    })
    this.solidLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage', minBindingSize: 80 },
        },
      ],
    })
    register('solid', async () => {
    this.solidPipeline = await this.device.createRenderPipelineAsync({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.layout, this.solidLayout],
      }),
      vertex: { module, entryPoint: 'solidQuad' },
      fragment: { module, entryPoint: 'solidFragment', targets: [{ format: this.layerFormat }] },
      primitive: { topology: 'triangle-list' },
    })
    })
    for (const rule of this.managed ? [] : ['evenodd', 'nonzero', 'union']) register(`mask:${rule}`, async () => {
      const op: GPUStencilOperation =
        rule === 'evenodd' ? 'invert' : rule === 'union' ? 'replace' : 'increment-wrap'
      const readMask = rule === 'evenodd' ? 1 : 255
      this.maskPipelines.set(
        rule,
        await this.device.createRenderPipelineAsync({
          layout: maskLayout,
          vertex: {
            module: mask,
            entryPoint: 'mesh',
            buffers: [
              {
                arrayStride: 8,
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
              },
            ],
          },
          fragment: {
            module: mask,
            entryPoint: 'white',
            targets: [{ format: this.layerFormat, writeMask: 0 }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          multisample: { count: 4 },
          depthStencil: {
            format: 'depth24plus-stencil8',
            depthWriteEnabled: false,
            depthCompare: 'always',
            stencilFront: { compare: 'always', passOp: op },
            stencilBack: { compare: 'always', passOp: rule === 'nonzero' ? 'decrement-wrap' : op },
            stencilReadMask: readMask,
            stencilWriteMask: readMask,
          },
        }),
      )
      this.coverPipelines.set(
        rule,
        await this.device.createRenderPipelineAsync({
          layout: maskLayout,
          vertex: { module: mask, entryPoint: 'quad' },
          fragment: { module: mask, entryPoint: 'white', targets: [{ format: this.layerFormat }] },
          primitive: { topology: 'triangle-list' },
          multisample: { count: 4 },
          depthStencil: {
            format: 'depth24plus-stencil8',
            depthWriteEnabled: false,
            depthCompare: 'always',
            stencilFront: { compare: 'not-equal' },
            stencilBack: { compare: 'not-equal' },
            stencilReadMask: readMask,
            stencilWriteMask: 0,
          },
        }),
      )
    })
    // Only programs required even for an empty viewport block device readiness.
    // All other exact programs are admitted from the compiled scene below.
    await this.pipelines.prepare(import.meta.env.VITE_DESIGN_LAZY_PIPELINES === '0'
      ? this.pipelines.keys() : ['paint', 'present'])

    this.uniforms = this.device.createBuffer({
      size: 4 * 1024 * 1024,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.encoder = this.device.createCommandEncoder()
    this.blank = this.create(1, 1)
    this.clear(this.blank)
    this.queueWaitStats.submit(() => this.device.queue.submit([this.encoder.finish()]))
    await this.waitForQueue('initialization')
    this.initialized = true
  }
  async prepareScene(scene: GpuScene) {
    this.interactionPresentation = scene.interactionRetained === true
    this.nativeInteractionPresentation = scene.nativeInteraction === true
    this.pairDisplayTaps = scene.pairedDisplayFilters ?? (import.meta.env.VITE_DESIGN_PAIRED_DISPLAY === '1')
    this.displayFilters = scene.displayFilters === true
    this.softwareRaster = !!scene.softwareRaster && !this.managed

    const paths = Object.values(scene.nodes).flatMap(n => [n.fill, ...n.strokes.map(s => s.path)])
    this.scenePrograms = import.meta.env.VITE_DESIGN_PROGRAM_RESIDENCY !== '0' &&
      !paths.some(p=>p.analytic||p.area&&!p.area.fingerprint)
      ? paths.flatMap(p=>p.area?[p.area]:[]) : undefined
    const required = new Set(['compose'])
    if (paths.length) required.add('solid')
    if (paths.some(p => p.area && p.count)) required.add('area')
    if (this.managed && paths.length) { required.add('binary'); required.add('scalar') }
    if (!this.managed) for (const path of paths)
      if (path.count && !path.area && !path.analytic) required.add(`mask:${path.rule}`)
    await this.pipelines.prepare(required)
    if (!this.managed) return
    const modes = compositorModes(scene)
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
    const pending: string[] = []
    for (const mode of modes) {
      if (this.modePipelines.has(mode)) continue
      const key = `mode:${mode}`; pending.push(key)
      this.pipelines.register(key, async () => {
      const pipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module: this.compositorModule, entryPoint: 'quad' },
        fragment: { module: this.compositorModule, entryPoint: 'fragment', constants: { COMPOSITOR_MODE: mode }, targets: [{ format: this.layerFormat }] },
        primitive: { topology: 'triangle-list' } })
      this.modePipelines.set(mode, pipeline)
      })
    }
    await this.pipelines.prepare(pending)
  }
  async prepareFilters(prefixUseful = false) {
    if (this.managed && this.displayFilters) {
      if (this.pairDisplayTaps && !this.pairedDisplay && !this.pairedDisplayFailed && this.device.features.has('float32-filterable')) {
        try {
        const layout = this.device.createBindGroupLayout({ entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 1024 } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
        ] })
        const module = this.device.createShaderModule({ code: pairedDisplayFilterWgsl, label: 'Paired integrated display filter' })
        const pipeline = await this.device.createRenderPipelineAsync({ layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
          vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: this.layerFormat }] },
          primitive: { topology: 'triangle-list' } })
        const sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
        this.pairedDisplay = { layout, pipeline, sampler }
        } catch (error) {
          this.pairedDisplayFailed = true
          console.warn('Paired integrated display filter unavailable; using integrated tent filter', error)
        }
      }
      if (!this.displayFilterPipeline) {
        const module = this.device.createShaderModule({ code: displayFilterWgsl, label: 'Canvas integrated tent' })
        this.displayFilterPipeline = await this.device.createRenderPipelineAsync({
          layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
          vertex: { module, entryPoint: 'quad' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: this.layerFormat }] },
          primitive: { topology: 'triangle-list' },
        })
      }
      return
    }
    if (this.managed && !this.filterPipelines.length) {
      const filterModule = this.device.createShaderModule({ code: exactFilterWgsl(this.certifiedFilter), label: 'Exact rational filter' })
      const errors = (await filterModule.getCompilationInfo()).messages.filter((m) => m.type === 'error')
      if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
      const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] })
      this.filterPipelines = await Promise.all([0, 1, 2, 3].map((channel) => this.device.createRenderPipelineAsync({ layout,
        vertex: { module: filterModule, entryPoint: 'quad' }, fragment: { module: filterModule, entryPoint: 'fragment',
          constants: { FILTER_CHANNEL: channel }, targets: [{ format: this.layerFormat, writeMask: 1 << channel }] },
        primitive: { topology: 'triangle-list' } })))
      this.scalarFilterPipeline = await this.device.createRenderPipelineAsync({ layout,
        vertex: { module: filterModule, entryPoint: 'quad' }, fragment: { module: filterModule, entryPoint: 'fragment',
          constants: { FILTER_CHANNEL: 3 }, targets: [{ format: 'r32float' }] },
        primitive: { topology: 'triangle-list' } })
    }
    if (this.prefixEnabled && prefixUseful && !this.prefix)
      this.prefix = await TexturePrefix.create(this.device, (u) => this.uniform(u), prefixModule(this.certifiedFilter), false)
  }
  private prefixPolicy(u: Float32Array, channels: number, filter?: {kind: 'tent'; radius: number}, kernel?: Texture) {
    // Actual operator measurements: alpha-only remains faster on the old path;
    // the tested 48/96-pixel RGBA filters benefit from 4 MiB bands.
    return !!(!this.displayFilters && this.prefix && filter?.kind === 'tent' && filter.radius >= 48 &&
      !((!Number.isInteger(filter.radius) || filter.radius > 512) && kernel?.prefixRationalUnsupported === true) && channels === 15 && u[16] === 22)
  }
  prepareFilterPass(target: Texture, u: Float32Array, inputs: Texture[], channels: number, filter: {kind: 'tent'; radius: number}, availableBytes: number) {
    if (!this.prefixPolicy(u, channels, filter, inputs[1]) || this.prefix!.scratchBytes) return
    recordGpuDiagnostic('prefix',{reasonCode:availableBytes<PREFIX_SCRATCH_BYTES?1:0,availableBytes,scratchBytes:PREFIX_SCRATCH_BYTES,radius:filter.radius,width:u[2],height:u[3]})
    const sources = [0, 1, 2].map((i) => (inputs[i] || this.blank).resource as GPUTexture)
    if (availableBytes < PREFIX_SCRATCH_BYTES || !this.prefix!.canEncode(target.resource as GPUTexture, sources, u, filter.radius, filter.kind, {x:u[0],y:u[1],w:u[2],h:u[3]}, channels)) return
    this.prefix!.reserveScratch()
    this.prefix!.resetCounters(this.encoder)
    this.frameScratchBytes = Math.max(this.frameScratchBytes, this.prefix!.scratchBytes)
  }
  async abortFrameAndReleaseFilterScratch(reason: 'admission' | 'cancel' = 'admission') {
    this.closeOver()
    // Abandon recorded commands; already submitted commands retain their
    // resources until this explicit completion boundary.
    this.encoder = this.device.createCommandEncoder()
    const epoch = this.resourceEpoch
    await this.waitForQueue(reason)
    if (!this.lost) this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch)
    if (this.frameScopeOpen) {
      const error = await this.device.popErrorScope(); this.frameScopeOpen = false
      if (error || this.errors.length) throw markRenderFailure(new Error([error?.message, ...this.errors].filter(Boolean).join('\n')), { failureStage: 7, failureCategory: error ? renderFailureFields(error).failureCategory : this.lost ? 4 : 0, failureCode: 201 })
    }
    this.prefix?.releaseScratch()
    for (const target of this.transientTargets) this.destroy(target)
    this.transientTargets = []
    for (const texture of this.transient) texture.destroy()
    this.transient = []; this.msaa.clear(); this.transientBytes = 0
  }
  begin(vertices: Float32Array, curves = new Float32Array(0)) {
    this.geometryUploadBytes = 0
    this.bindingCache.begin()
    this.pairedFilterPasses = 0
    if (this.disposed || this.lost) throw new Error('WebGPU 设备已丢失')
    this.resourceEpoch++
    this.drawCalls = 0
    this.mergedExactFilterPasses = 0
    this.finishTransientBytes = 0
    this.frameScratchBytes = 0
    this.timingRows = []
    this.timingSkipped = 0
    this.triangles = 0
    this.offset = 0
    this.uploadedOffset = 0
    this.uniformCommands = 0
    this.commandSubmissions = 0
    this.solidOffset = 0
    this.solidUploaded = 0
    this.solidRanges.clear()
    this.errors = []
    if (!this.programArenaActive) this.programArena.reset()
    const programs=this.scenePrograms?this.programArena.plan(curves,this.scenePrograms):undefined
    this.programOffsets=programs?.offsets
    this.programHits=programs?.hits||0;this.programHitBytes=programs?.hitBytes||0
    if(!programs&&this.programArenaActive){this.programArena.reset();this.curveMirror.reset()}
    if(programs&&!this.programArenaActive){this.programGpuValid=false;this.curveMirror.reset()}
    this.programArenaActive=!!programs
    const curveBytes=programs?this.programArena.bytes:curves.byteLength
    this.trackCapacityDemand(Math.max(16, curveBytes), this.curveCapacity, this.curveShrink, 16)
    if (!this.curves || Math.max(16, curveBytes) > this.curveCapacity) {
      const previous=this.curves,copy=!!(programs&&this.programGpuValid&&previous)
      this.curveMirror.reset()
      if(!copy)this.programGpuValid=false
      this.curveCapacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(16, curveBytes))))
      this.curves = this.device.createBuffer({
        size: this.curveCapacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      })
      if(copy){
        // Grow on the same device. The submitted copy retains its old buffer
        // until completion; subsequent queue writes append only new programs.
        const encoder=this.device.createCommandEncoder()
        encoder.copyBufferToBuffer(previous!,0,this.curves,0,Math.min(previous!.size,this.curveCapacity))
        this.queueWaitStats.submit(() => this.device.queue.submit([encoder.finish()]));this.commandSubmissions++
      }
      previous?.destroy()
    }
    const curveUpdate=programs
      ?this.programGpuValid?programs.upload:{offset:0,data:programs.words}
      :this.curveMirror.update(curves.byteLength ? curves : new Float32Array(4))
    if(curveUpdate){this.device.queue.writeBuffer(this.curves,curveUpdate.offset,curveUpdate.data);this.geometryUploadBytes+=curveUpdate.data.byteLength}
    if(programs)this.programGpuValid=true
    this.encoder = this.device.createCommandEncoder()
    this.prefix?.resetCounters(this.encoder)
    this.trackCapacityDemand(vertices.byteLength, this.vertexCapacity, this.vertexShrink, 256)
    if (vertices.byteLength > this.vertexCapacity) {
      this.vertices?.destroy()
      this.vertexMirror.reset()
      this.vertexCapacity = Math.max(
        256,
        2 ** Math.ceil(Math.log2(Math.max(1, vertices.byteLength))),
      )
      this.vertices = this.device.createBuffer({
        size: this.vertexCapacity,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    if (!this.vertices) {
      this.vertexCapacity = 256
      this.vertices = this.device.createBuffer({
        size: 256,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    const vertexUpdate=this.vertexMirror.update(vertices)
    if(vertexUpdate){this.device.queue.writeBuffer(this.vertices,vertexUpdate.offset,vertexUpdate.data);this.geometryUploadBytes+=vertexUpdate.data.byteLength}
    this.device.pushErrorScope('validation')
    this.frameScopeOpen = true
  }
  /** Track consecutive frames whose demand stays ≥4× below the capacity,
   * remembering the window's peak demand so a shrink targets the next
   * doubling tier the growth path would choose. */
  private trackCapacityDemand(
    demand: number,
    capacity: number,
    window: { frames: number; maxDemand: number },
    floorBytes: number,
  ) {
    const tier = Math.max(floorBytes, 2 ** Math.ceil(Math.log2(Math.max(1, demand))))
    window.maxDemand = Math.max(window.maxDemand, demand)
    if (capacity >= tier * 4) window.frames++
    else window.frames = 0
  }
  /** Shrink a ≥4× overprovisioned vertex/curve buffer after 60 consecutive
   * low-demand frames. Call only after a checkpoint: submitted commands may
   * still reference the old buffer, and the onSubmittedWorkOrdered fence in
   * finish() guarantees they are done. */
  private shrinkCapacities() {
    if (this.vertexShrink.frames >= CAPACITY_SHRINK_FRAMES && this.vertices) {
      const target = Math.max(256, 2 ** Math.ceil(Math.log2(Math.max(1, this.vertexShrink.maxDemand))))
      if (target < this.vertexCapacity) {
        console.debug(`DESIGN_GPU_SHRINK ${JSON.stringify({ buffer: 'vertices', from: this.vertexCapacity, to: target })}`)
        this.vertices.destroy()
        this.vertexMirror.reset()
        this.vertexCapacity = target
        this.vertices = this.device.createBuffer({
          size: target,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        })
      }
      this.vertexShrink = { frames: 0, maxDemand: 0 }
    }
    if (this.curveShrink.frames >= CAPACITY_SHRINK_FRAMES && this.curves) {
      const target = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, this.curveShrink.maxDemand))))
      if (target < this.curveCapacity) {
        console.debug(`DESIGN_GPU_SHRINK ${JSON.stringify({ buffer: 'curves', from: this.curveCapacity, to: target })}`)
        this.curves.destroy()
        this.curveMirror.reset()
        this.programGpuValid=false
        this.curveCapacity = target
        this.curves = this.device.createBuffer({
          size: target,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        })
      }
      this.curveShrink = { frames: 0, maxDemand: 0 }
    }
  }
  create(width: number, height: number): Texture {
    return this.createFormat(width, height, this.layerFormat)
  }
  createBinaryCoverage(width: number, height: number): Texture {
    const texture = this.createFormat(width, height, 'rgba8unorm')
    texture.binaryCoverage = true
    return texture
  }
  createScalarCoverage(width:number,height:number):Texture {
    const texture=this.createFormat(width,height,'r32float');texture.scalarCoverage=true;return texture
  }
  private createFormat(width: number, height: number, format: GPUTextureFormat): Texture {
    if (
      width < 1 ||
      height < 1 ||
      width > this.device.limits.maxTextureDimension2D ||
      height > this.device.limits.maxTextureDimension2D
    )
      throw new Error('WebGPU 纹理尺寸超限')
    const bytes = textureByteLength(width, height, format === 'rgba32float' ? 16 : 4)
    const resource = this.device.createTexture({
      label: `Forma layer ${width}x${height} ${this.layerFormat}`,
      size: [width, height],
      format,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.COPY_SRC |
        GPUTextureUsage.COPY_DST,
    })
    const t = {
      width,
      height,
      resource,
      bytes,
    }
    this.textures.add(t)
    return t
  }
  destroy(t: Texture) {
    this.replayParameterTextures.delete(t)
    if (this.textures.delete(t)) (t.resource as GPUTexture).destroy()
  }
  upload(bitmap: ImageBitmap) {
    const t = this.create(bitmap.width, bitmap.height)
    this.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: t.resource as GPUTexture, premultipliedAlpha: true },
      [bitmap.width, bitmap.height],
    )
    return t
  }
  uploadLinear(values: Float32Array, width: number, height: number) {
    if (!this.managed || values.length !== width * height * 4) throw new Error('无效的浮点纹理')
    return this.uploadParameters(values, width, height)
  }
  uploadParameters(values: Float32Array, width: number, height: number) {
    if (values.length !== width * height * 4)
      throw new Error('无效的材质参数纹理')
    // Dense coordinate fields can contain millions of scalars per tile. A
    // direct loop preserves admission without one callback per scalar.
    for (let i = 0; i < values.length; i++)
      if (!Number.isFinite(values[i])) throw new Error('无效的材质参数纹理')
    const t = this.createFormat(width, height, 'rgba32float')
    this.device.queue.writeTexture(
      { texture: t.resource as GPUTexture },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
    return t
  }
  uploadRgba8(bytes: Uint8Array, width: number, height: number) {
    if (this.managed)
      return this.uploadLinear(
        Float32Array.from(bytes, (v) => v / 255),
        width,
        height,
      )
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理')
    const t = this.create(width, height)
    this.device.queue.writeTexture(
      { texture: t.resource as GPUTexture },
      new Uint8Array(bytes),
      { bytesPerRow: width * 4 },
      [width, height],
    )
    return t
  }
  uploadAtlasLinear(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    values: Float32Array,
  ) {
    if (values.length !== width * height * 4) throw new Error('无效的浮点纹理写入')
    this.device.queue.writeTexture(
      { texture: texture.resource as GPUTexture, origin: { x, y } },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
  }
  uploadAtlasRgba8(
    texture: Texture,
    x: number,
    y: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ) {
    if (this.managed) {
      this.uploadAtlasLinear(
        texture,
        x,
        y,
        width,
        height,
        Float32Array.from(bytes, (v) => v / 255),
      )
      return
    }
    if (bytes.length !== width * height * 4) throw new Error('无效的 RGBA8 数据纹理写入')
    this.device.queue.writeTexture(
      { texture: texture.resource as GPUTexture, origin: { x, y } },
      new Uint8Array(bytes),
      { bytesPerRow: width * 4 },
      [width, height],
    )
  }
  uploadReplayParameters(values: Float32Array, width: number, height: number, target?: Texture) {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024 ||
      values.length !== width * height * 4 ||
      values.some((v) => !Number.isFinite(v))
    )
      throw new Error('无效的纹理重放参数')
    if (target) {
      if (!this.textures.has(target) || !this.replayParameterTextures.has(target))
        throw new Error('无效的纹理重放参数缓冲区')
      // Queue writes precede commands still in an encoder. Submit those reads
      // first; then overwrite the same allocation in queue order, without
      // destroying it or pretending its bytes have been released.
      this.submitCommands()
    } else {
      target = this.createFormat(1024, 1024, 'rgba32float')
      this.replayParameterTextures.add(target)
    }
    this.device.queue.writeTexture(
      { texture: target.resource as GPUTexture },
      values,
      { bytesPerRow: width * 16 },
      [width, height],
    )
    return target
  }
  clear(t: Texture) {
    this.closeOver()
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.bindingCache.view((t.resource as GPUTexture)),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.end()
  }
  private uniform(u: Float32Array) {
    if (++this.uniformCommands > 262144) throw new Error('GPU frame command work budget exceeded')
    if (this.offset + 1024 > this.uniformData.byteLength) this.submitCommands()
    const offset = this.offset
    this.offset += 1024
    this.uniformData.set(u, offset / 4)
    return { buffer: this.uniforms, offset, size: 1024 }
  }
  private submitCommands() {
    this.closeOver()
    this.uploadUniforms()
    this.queueWaitStats.submit(() => this.device.queue.submit([this.encoder.finish()]))
    this.commandSubmissions++
    this.encoder = this.device.createCommandEncoder()
    // Queue writes and submissions execute in order. Reuse this bounded arena
    // only after submitting the commands that refer to its old contents.
    // Keep MSAA scratch alive: the caller may be about to bind one of those
    // textures in the next command (for example its downsample pass).
    this.offset = 0
    this.uploadedOffset = 0
  }
  async readSurface(source: Texture): Promise<Float32Array> {
    await this.checkpoint('readback')
    const width=source.width,height=source.height,floating=source.bytes===width*height*16,bpp=floating?16:4
    const stride=Math.ceil(width*bpp/256)*256
    const buffer=this.device.createBuffer({size:stride*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})
    try {
      const encoder=this.device.createCommandEncoder()
      encoder.copyTextureToBuffer({texture:source.resource as GPUTexture},{buffer,bytesPerRow:stride},[width,height])
      this.queueWaitStats.submit(() => this.device.queue.submit([encoder.finish()]));this.commandSubmissions++
      await buffer.mapAsync(GPUMapMode.READ)
      const raw=new Uint8Array(buffer.getMappedRange()),packed=new Uint8Array(width*height*bpp)
      for(let y=0;y<height;y++)packed.set(raw.subarray(y*stride,y*stride+width*bpp),y*width*bpp)
      if(source.scalarCoverage){const values=new Float32Array(packed.buffer);return Float32Array.from({length:values.length*4},(_,i)=>values[Math.floor(i/4)])}
      return floating?new Float32Array(packed.buffer):Float32Array.from(packed,v=>v/255)
    } finally { buffer.destroy() }
  }
  async checkpoint(reason: QueueWaitReason = 'checkpoint', admission?: GpuAdmissionDiagnostic, completedPoolEpoch?: number) {
    this.submitCommands()
    // Do not advance completion here: the newly submitted commands may still
    // be running. This certificate covers only old, no-longer-used pool entries.
    if (reason === 'admission' && !this.lost && Number.isSafeInteger(completedPoolEpoch) && completedPoolEpoch! > 0 &&
        completedPoolEpoch! < this.resourceEpoch && completedPoolEpoch! <= this.completedResourceEpoch) return
    const epoch = this.resourceEpoch
    await this.waitForQueue(reason, admission)
    if (this.lost) throw new Error('GPU 设备已丢失')
    // The current frame may encode more reads after this checkpoint. Only
    // earlier frames are eligible for immutable-resource eviction.
    this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch - 1)
  }
  submitPending() {
    // Reuse exactly the uniform-arena overflow submission contract. No
    // transient/scratch lifetime ends here and no readback is introduced.
    if (this.offset > 0) this.submitCommands()
  }
  private flush() {
    this.submitCommands()
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
  }
  private uploadUniforms() {
    if (this.solidBuffer && this.solidOffset > this.solidUploaded) {
      this.device.queue.writeBuffer(
        this.solidBuffer,
        this.solidUploaded * 4,
        this.solidData.buffer,
        this.solidUploaded * 4,
        (this.solidOffset - this.solidUploaded) * 4,
      )
      this.solidUploaded = this.solidOffset
    }
    if (this.offset === this.uploadedOffset) return
    this.device.queue.writeBuffer(
      this.uniforms,
      this.uploadedOffset,
      this.uniformData.buffer,
      this.uploadedOffset,
      this.offset - this.uploadedOffset,
    )
    this.uploadedOffset = this.offset
  }
  private maskBuffer(width: number, height: number, density = 2) {
    const key = `${density}:${width}:${height}`,
      existing = this.msaa.get(key)
    if (existing) return existing
    // 2x spatial resolution plus hardware 4x MSAA gives 16 coverage samples.
    // Byte accounting follows the actual layer format: the high/low resolve
    // textures and the 4x MSAA color target cost layerBpp per sample, the
    // depth24plus-stencil8 scratch 4 bytes per sample. rgba8unorm reduces to
    // the historical w·h·4·(d²·9+1); rgba32float is ~2.7× that, which the old
    // single-formula budget let through the 64 MiB gate.
    // Tiles keep all resolve/color/stencil scratch within the 64 MiB budget.
    const layerBpp = this.layerFormat === 'rgba32float' ? 16 : 4
    const required =
      width * height *
      (layerBpp * (density * density + 1) + density * density * 4 * (layerBpp + 4))
    if (this.transientBytes + required > 64 * 1024 * 1024) this.flush()
    const high = this.create(width * density, height * density),
      low = this.create(width, height)
    const color = this.device.createTexture({
        size: [width * density, height * density],
        format: this.layerFormat,
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      }),
      depth = this.device.createTexture({
        size: [width * density, height * density],
        format: 'depth24plus-stencil8',
        sampleCount: 4,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    this.transient.push(color, depth)
    this.transientTargets.push(high, low)
    this.transientBytes += required
    const buffer = { color, depth, high, low }
    this.msaa.set(key, buffer)
    return buffer
  }
  maskRegion(path: PathMesh, target: Texture, sampleIndex: number, region: Rect) {
    if (!path.area) throw Error('Regional coverage requires an interval program')
    this.mask(path, target, sampleIndex, region)
  }
  mask(path: PathMesh, target: Texture, sampleIndex?: number, region = path.rect) {
    if (path.area) {
      if (!this.areaPipeline) throw new Error('Coverage program unavailable')
      const u = parameters(region)
      u[16] = 31
      const first=this.programOffsets?.get(path.area.first)
      if(this.programOffsets&&first===undefined)throw new Error('Resident coverage program is missing')
      u[36] = first??path.area.first
      u[38] = sampleIndex === undefined ? 0 : sampleIndex + 1
      u.set([region.x - path.rect.x, region.y - path.rect.y, path.rect.w, path.rect.h], 40)
      this.pass(target, u, [])
      this.triangles++
      return
    }
    if (path.analytic) {
      const u = parameters(path.rect)
      u[16] = 20
      u.set(
        [
          path.analytic.first,
          path.analytic.count,
          path.rule === 'evenodd' ? 1 : 0,
          sampleIndex === undefined ? 0 : sampleIndex + 1,
        ],
        36,
      )
      if (path.analytic.bands !== undefined)
        u.set([path.analytic.bands, Math.ceil(path.rect.h / 16), 0, 0], 40)
      this.pass(target, u, [])
      this.triangles++
      return
    }

    if (path.analyticRect) {
      const u = parameters(path.rect),
        b = path.analyticRect
      u[16] = 17
      u.set([b[0] - path.rect.x, b[1] - path.rect.y, b[2] - path.rect.x, b[3] - path.rect.y], 36)
      this.pass(target, u, [])
      this.triangles++
      return
    }
    this.closeOver()
    const density = path.sampleCount === 4 ? 1 : 2
    for (let y = 0; y < target.height; y += 512)
      for (let x = 0; x < target.width; x += 512) {
        const w = Math.min(512, target.width - x),
          h = Math.min(512, target.height - y),
          { color, depth, high, low } = this.maskBuffer(w, h, density),
          u = parameters({ x: 0, y: 0, w, h })
        u.set([x, y], 4)
        const uniform = this.uniform(u)
        const create = () => this.device.createBindGroup({
          layout: this.maskLayout,
          entries: [{ binding: 0, resource: uniform }],
        })
        // Only descriptors are reused: every tile still writes its exact
        // uniforms. Fixed offsets remain part of the key even when the main
        // compositor uses dynamic bindings; maskLayout has no dynamic offset.
        let bind: GPUBindGroup
        if (import.meta.env.VITE_DESIGN_BINDING_CACHE === '0') {
          this.bindingCache.groupCreates++
          bind = create()
        } else {
          bind = this.bindingCache.group([this.maskLayout, uniform.buffer], uniform.offset, create)
        }
        const pass = this.encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.bindingCache.view(color),
              resolveTarget: this.bindingCache.view((high.resource as GPUTexture)),
              loadOp: 'clear',
              storeOp: 'discard',
              clearValue: [0, 0, 0, 0],
            },
          ],
          depthStencilAttachment: {
            view: this.bindingCache.view(depth),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'discard',
            stencilClearValue: 0,
            stencilLoadOp: 'clear',
            stencilStoreOp: 'discard',
          },
        })
        pass.setBindGroup(0, bind)
        pass.setPipeline(this.maskPipelines.get(path.rule)!)
        pass.setVertexBuffer(0, this.vertices!)
        pass.setStencilReference(path.rule === 'union' ? 1 : 0)
        pass.draw(path.count, 1, path.first)
        this.drawCalls++
        this.triangles += path.count / 3
        pass.setPipeline(this.coverPipelines.get(path.rule)!)
        pass.setStencilReference(0)
        pass.draw(3)
        this.drawCalls++
        pass.end()
        const down = parameters(
          { x: 0, y: 0, w, h },
          { x: 0, y: 0, w: w * density, h: h * density },
        )
        down[16] = density === 2 ? 19 : 0
        const single = target.width <= 512 && target.height <= 512
        this.pass(single ? target : low, down, [high])
        if (!single)
          this.encoder.copyTextureToTexture(
            { texture: low.resource as GPUTexture },
            { texture: target.resource as GPUTexture, origin: [x, y] },
            [w, h],
          )
      }
  }
  private bind(u: Float32Array, inputs: Texture[]) {
    u[SCALAR_COVERAGE_UNIFORM]=inputs.reduce((flags,t,i)=>flags|
      (t.scalarCoverage?1<<i:0)|(t.transparentZero?1<<(i+4):0)|(t.uniformColor?1<<(i+8):0),0)
    u[240] = this.managed ? 1 : 0
    u[253] = this.softwareRaster ? 1 : 0
    u[254] = 9
    u[255] = 19 // Exact sampler limb count; keep compiler loops bounded.
    const uniform = this.uniform(u), textures = [0, 1, 2, 3].map(i => (inputs[i] || this.blank).resource as GPUTexture)
    const offset = this.dynamicUniformBindings ? 0 : uniform.offset
    const create = () => this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { ...uniform, offset } },
        ...[0, 1, 2, 3].map((i) => ({
          binding: i === 3 ? 5 : i + 1,
          resource: this.bindingCache.view(textures[i]),
        })),
        { binding: 4, resource: { buffer: this.curves! } },
      ],
    })
    let group: GPUBindGroup
    if (import.meta.env.VITE_DESIGN_BINDING_CACHE === '0') { this.bindingCache.groupCreates++; group = create() }
    else group = this.bindingCache.group([this.layout, uniform.buffer, this.curves!, ...textures], offset, create)
    return { group, offsets: this.dynamicUniformBindings ? [uniform.offset] : [] }
  }
  solidBatch(target: Texture, u: Float32Array, data: Float32Array, clip?: Texture) {
    if (clip === target) throw new Error('GPU texture feedback loop')
    this.closeOver()
    if (!this.solidBuffer) {
      this.solidBuffer = this.device.createBuffer({
        size: this.solidData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
      this.solidBind = this.device.createBindGroup({
        layout: this.solidLayout,
        entries: [{ binding: 0, resource: { buffer: this.solidBuffer } }],
      })
    }
    let base = this.solidRanges.get(data)
    if (base === undefined) {
      if (this.solidOffset + data.length > this.solidData.length)
        throw new Error('GPU solid instance budget exceeded')
      base = this.solidOffset / 4
      this.solidData.set(data, this.solidOffset)
      this.solidOffset += data.length
      this.solidRanges.set(data, base)
    }
    u[36] = base
    const bind = this.bind(u, clip ? [this.blank, this.blank, clip] : [])
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        { view: this.bindingCache.view((target.resource as GPUTexture)), loadOp: 'load', storeOp: 'store' },
      ],
    })
    pass.setPipeline(this.solidPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.setBindGroup(1, this.solidBind!)
    const count = data.length / SOLID_INSTANCE_FLOATS
    pass.draw(6, count)
    pass.end()
    this.drawCalls++
    this.triangles += count * 2
  }
  pass(target: Texture, u: Float32Array, inputs: Texture[], region?: Rect, channels = 15, filter?: {kind: 'tent'; radius: number}, clearOutside = false) {
    this.closeOver()
    if (inputs.includes(target)) throw new Error('GPU texture feedback loop')
    if (this.prefixPolicy(u, channels, filter, inputs[1]) && filter && !region && this.prefix!.encode(() => this.encoder, target.resource as GPUTexture,
      [0, 1, 2].map((i) => (inputs[i] || this.blank).resource as GPUTexture), u, filter.radius, filter.kind,
      {x:u[0],y:u[1],w:u[2],h:u[3]}, channels)) { this.drawCalls += this.prefix!.lastRenderPasses; return }
    const bind = this.bind(u, inputs)
    // With integer origins/sizes bounded by 2^20, pixel centres and every
    // subtraction/addition forming q/base are exactly representable binary32
    // integers or half-integers (<2^23). Thus the original sampler has k=0.
    // The corner helper also retains zero canonicalization and NaN neighbour order.
    const integerCentres = u.subarray(0, 16).every((v) => Number.isInteger(v) && Math.abs(v) <= 1048576) && u[242] === 0
    if (target.binaryCoverage && ![12, 20, 31].includes(u[16]))
      throw new Error('Only binary coverage may write a binary mask texture')
    const displayFilter = this.managed && this.displayFilters && u[16] === 22
    if (displayFilter && this.pairDisplayTaps && this.pairedDisplay && u[40] === 0 && channels === 15 && !region && inputs[0] && inputs[1]) {
      const bind = this.device.createBindGroup({ layout: this.pairedDisplay.layout, entries: [
        { binding: 0, resource: this.uniform(u) }, { binding: 1, resource: this.pairedDisplay.sampler },
        { binding: 2, resource: this.bindingCache.view((inputs[0].resource as GPUTexture)) },
        { binding: 3, resource: this.bindingCache.view((inputs[1].resource as GPUTexture)) },
      ] })
      const pass = this.encoder.beginRenderPass({ colorAttachments: [{
        view: this.bindingCache.view((target.resource as GPUTexture)), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      }] })
      pass.setPipeline(this.pairedDisplay.pipeline); pass.setBindGroup(0, bind); pass.draw(3); pass.end()
      this.drawCalls++; this.pairedFilterPasses++; return
    }
    // Mode 6 composites a shadow from source + blurred alpha. The standalone
    // SDF/chrome shaders have different uniforms and cannot share this mode;
    // spare uniform lanes must never select them or require optional samplers.
    const pipelines = target.scalarCoverage ? [u[16]===49?this.alphaResolvePipeline!:u[16]===22?this.scalarFilterPipeline!:u[16]===31?this.scalarAreaPipeline!:this.scalarPipelines.get(u[16])!] : displayFilter ? [this.displayFilterPipeline!] : target.binaryCoverage
      ? [u[16] === 31 ? this.binaryAreaPipeline! : this.binaryPipelines.get(u[16])!]
      : this.managed && u[16] === 22 ? this.filterPipelines : [
      u[16] === 50 ? this.shadowOverPipeline! : u[16] === 48 ? this.resolveStepPipeline! : u[16] === 47 ? this.solidPaintOverPipeline! : u[16] === 31 ? this.areaPipeline! : this.managed && u[16] === 3 && u[17] === 0
        ? (integerCentres ? this.normalCornerPipeline! : this.normalPipeline!) :
      this.managed && u[16] === 0 ? (integerCentres ? this.copyCornerPipeline! : this.copyPipeline!) :
      this.managed ? this.modePipelines.get(u[16])! : this.paintPipeline]
    if (!pipelines.length || pipelines.some((pipeline) => !pipeline)) throw new Error(`Exact compositor pipeline ${u[16]} not prepared`)
    // The exact channel pipelines read only source textures, never this
    // attachment, and write disjoint channels without blending. Keep their
    // four reducers/draws in the original order, but clear/store the shared
    // attachment once. No arithmetic, sampler, or filter support changes.
    // Scissored/partial-channel work and per-channel timestamp probes retain
    // the established clear/load and query boundaries below.
    if (this.managed && u[16] === 22 && !displayFilter && !target.scalarCoverage &&
        !target.binaryCoverage && pipelines === this.filterPipelines && pipelines.length === 4 &&
        channels === 15 && !region && !this.timingQueries) {
      const pass = this.encoder.beginRenderPass({ colorAttachments: [{
        view: this.bindingCache.view(target.resource as GPUTexture),
        loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
      }] })
      for (const pipeline of pipelines) {
        pass.setPipeline(pipeline)
        pass.setBindGroup(0, bind.group, bind.offsets)
        pass.draw(3)
        this.drawCalls++
      }
      pass.end()
      this.mergedExactFilterPasses++
      return
    }
    let drawn = false
    for (let channel = 0; channel < pipelines.length; channel++) {
    if (this.managed && u[16] === 22 && !displayFilter && !target.scalarCoverage && !(channels & (1 << channel))) continue
    const timingIndex = this.timingRows.length * 2
    const timed = !!this.timingQueries && timingIndex < 4096
    if (this.timingQueries && !timed) this.timingSkipped++
    if (timed) this.timingRows.push({ mode: u[16], radius: u[36], width: region?.w || target.width, height: region?.h || target.height,
      ...(u[16] === 3 ? { blend: u[17], integerCentres } : {}), ...(u[16] === 2 ? { paint: u[28] } : {}) })
    const pass = this.encoder.beginRenderPass({
      ...(timed ? { timestampWrites: { querySet: this.timingQueries!,
        beginningOfPassWriteIndex: timingIndex, endOfPassWriteIndex: timingIndex + 1 } } : {}),
      colorAttachments: [
        {
          view: this.bindingCache.view((target.resource as GPUTexture)),
          loadOp: region && !clearOutside || drawn ? 'load' : 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.setPipeline(pipelines[channel])
    pass.setBindGroup(0, bind.group, bind.offsets)
    if (region) pass.setScissorRect(region.x, region.y, region.w, region.h)
    pass.draw(3)
    pass.end()
    drawn = true
    this.drawCalls++
    }
  }
  over(target: Texture, u: Float32Array, inputs: Texture[], region: Rect) {
    if (this.managed) throw new Error('RGBA32F 合成必须使用显式着色器混合')
    if (inputs.includes(target)) throw new Error('GPU texture feedback loop')
    if (this.activeTarget !== target) this.closeOver()
    const bind = this.bind(u, inputs)
    const pass =
      this.activeOver ||
      this.encoder.beginRenderPass({
        colorAttachments: [
          {
            view: this.bindingCache.view((target.resource as GPUTexture)),
            loadOp: 'load',
            storeOp: 'store',
          },
        ],
      })
    this.activeOver = pass
    this.activeTarget = target
    pass.setPipeline(this.overPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.setScissorRect(region.x, region.y, region.w, region.h)
    pass.draw(3)
    this.drawCalls++
  }
  private closeOver() {
    this.activeOver?.end()
    this.activeOver = undefined
    this.activeTarget = undefined
  }
  async finish(
    source: Texture,
    r: Rect,
    width: number,
    height: number,
    readback: boolean,
    preview?: PreviewPresentation,
    present = true,
    outputRect?: Rect,
  ) {
    let captured: { id: number; texture: GPUTexture } | undefined
    try {
    this.closeOver()
    const bytePreview = !!preview && this.managed && !this.linearLight
    // Peak transient bytes this finish call itself allocates (shown copy,
    // readback target, MAP_READ staging). Pure accounting.
    let finishTransient = 0
    if (present) {
    if (this.captureDisplay && this.presenter && !readback && !this.hdr) captured = withRenderFailureStage(10, () => this.presenter!.capture(width, height))
    if (this.canvas.width !== width) this.canvas.width = width
    if (this.canvas.height !== height) this.canvas.height = height
    const u = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
    u[16] = 14
    u[242] = this.linearLight ? 1 : 0
    u[243] = this.hdr ? 1 : 0
    u[244] = this.managed && !this.linearLight && !this.hdr ? 1 : 0
    previewUniforms(u, preview, true)
    if (bytePreview) u[16] = 33
    let shown = source
    if (preview) {
      shown = this.create(width, height)
      const resolve = u.slice()
      resolve[242] = 0 // Convert display color exactly once, in exactPresent.
      this.pass(shown, resolve, [source])
      this.transientTargets.push(shown)
      this.transientBytes += shown.bytes
      finishTransient += shown.bytes
      u.set([0, 0, width, height], 0)
      u.set([0, 0, width, height], 4)
      u[16] = 14
    }
    const bind = this.bind(u, [shown])
    const pass = this.encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.bindingCache.view((captured?.texture || withRenderFailureStage(10, () => this.context.getCurrentTexture()))),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    })
    pass.setPipeline(this.presentPipeline)
    pass.setBindGroup(0, bind.group, bind.offsets)
    pass.draw(3)
    pass.end()
    this.drawCalls++
    }
    let buffer: GPUBuffer | undefined, output: Texture | undefined
    const bpp = this.managed ? 16 : 4
    const stride = Math.ceil((width * bpp) / 256) * 256
    if (readback) {
      output = this.create(width, height)
      const copy = parameters(outputRect || { x: 0, y: 0, w: width, h: height }, r)
      previewUniforms(copy, preview)
      if (bytePreview) copy[16] = 33
      this.pass(output, copy, [source])
      buffer = this.device.createBuffer({
        size: stride * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      finishTransient += output.bytes + stride * height
      this.encoder.copyTextureToBuffer(
        { texture: output.resource as GPUTexture },
        { buffer, bytesPerRow: stride },
        [width, height],
      )
    }
    // Finish-path transient accounting: the presentation copy, the readback
    // target and the MAP_READ staging buffer coexist at this peak. Pure
    // bookkeeping — no allocation or command changes.
    this.finishTransientBytes = Math.max(this.finishTransientBytes, finishTransient)
    if (this.prefix?.scratchBytes) this.prefix.encodeCountersReadback(this.encoder)
    let timingRead: GPUBuffer | undefined, timingResolve: GPUBuffer | undefined
    if (this.timingQueries && this.timingRows.length) {
      const size = this.timingRows.length * 16
      timingResolve = this.device.createBuffer({ size, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC })
      timingRead = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
      this.encoder.resolveQuerySet(this.timingQueries, 0, this.timingRows.length * 2, timingResolve, 0)
      this.encoder.copyBufferToBuffer(timingResolve, 0, timingRead, 0, size)
    }
    this.uploadUniforms()
    this.queueWaitStats.submit(() => this.device.queue.submit([this.encoder.finish()]))
    this.commandSubmissions++
    // Presentation-only tiles stay on the GPU timeline. Submitted commands
    // retain their resources; subsequent uploads are ordered by the queue.
    // Readbacks/probes still fence before reading or reusing mapped storage.
    // Primary trigger uses the original short-circuit order, including the
    // periodic counter increment only when no earlier trigger applies.
    const waitReason: QueueWaitReason | undefined = readback ? 'readback' : timingRead ? 'timing' :
      this.prefix?.scratchBytes ? 'prefix-scratch' : this.interactionPresentation &&
        (!this.nativeInteractionPresentation || import.meta.env.VITE_DESIGN_NATIVE_PIPELINE !== '1') ? 'interaction' :
        ++this.presentationSubmissions >= 4 ? 'periodic' : undefined
    if (waitReason) {
      const epoch = this.resourceEpoch
      await this.waitForQueue(waitReason)
      if (!this.lost) this.completedResourceEpoch = Math.max(this.completedResourceEpoch, epoch)
      this.presentationSubmissions = 0
    }
    const error = await this.device.popErrorScope()
    this.frameScopeOpen = false
    if (error || this.errors.length)
      throw markRenderFailure(new Error([error?.message, ...this.errors].filter(Boolean).join('\n')), { failureStage: 7, failureCategory: error ? renderFailureFields(error).failureCategory : this.lost ? 4 : 0, failureCode: 201 })
    // All frame commands have completed (the fence above): safe to reclaim
    // overprovisioned geometry buffers for the next frame.
    this.shrinkCapacities()
    if (this.prefix?.scratchBytes) {
      const counters=await this.prefix.readCounters()
      recordGpuDiagnostic('prefix',counters)
      if(!gpuDiagnosticsEnabled())console.debug('DESIGN_GPU_PREFIX ' + JSON.stringify(counters))
      this.prefix.releaseScratch()
    }
    if (timingRead) {
      await timingRead.mapAsync(GPUMapMode.READ)
      const values = new BigUint64Array(timingRead.getMappedRange())
      const totals = new Map<string, { mode: number; radius: number; width: number; height: number; count: number; ms: number }>()
      this.timingRows.forEach((row, i) => {
        const key = JSON.stringify(row), entry = totals.get(key) || { ...row, count: 0, ms: 0 }
        entry.count++; entry.ms += Number(values[i * 2 + 1] - values[i * 2]) / 1e6; totals.set(key, entry)
      })
      this.passTimings = [...totals.values()].sort((a, b) => b.ms - a.ms)
      console.debug('DESIGN_GPU_PROFILE ' + JSON.stringify(this.passTimings))
      if (this.timingSkipped) console.debug('DESIGN_GPU_PROFILE_SAMPLING ' + JSON.stringify({ recorded:this.timingRows.length,skipped:this.timingSkipped }))
      timingRead.unmap(); timingRead.destroy(); timingResolve?.destroy()
    }
    let rgba: Uint8Array | undefined,
      linear: Float32Array | undefined,
      straightRgba: Uint8Array | undefined
    if (buffer) {
      await buffer.mapAsync(GPUMapMode.READ)
      this.rasterReadbackBytes += stride * height
      const data = new Uint8Array(buffer.getMappedRange())
      rgba = new Uint8Array(width * height * bpp)
      for (let y = 0; y < height; y++)
        rgba.set(data.subarray(y * stride, y * stride + width * bpp), y * width * bpp)
      if (this.managed) {
        linear = new Float32Array(rgba.buffer)
        rgba = undefined
      }
      buffer.unmap()
      buffer.destroy()
      if (output) this.destroy(output)
    }
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
    if (bytePreview && linear) {
      straightRgba = Uint8Array.from(linear, (v) => Math.round(Math.max(0, Math.min(1, v)) * 255))
      linear = undefined
    }
    if (rgba && preview && preview.scale < 1) {
      straightRgba = minifiedPreviewRgba8(rgba)
      rgba = undefined
    }
    const bitmap = present && !captured ? withRenderFailureStage(10, () => this.canvas.transferToImageBitmap()) : undefined
    if (bitmap) this.crossDeviceBitmaps++
    if (captured) this.residentCaptures++
    return { gpuTile: captured?.id, bitmap, rgba, linear, straightRgba }
    } catch (error) {
      if (captured) this.presenter?.release([captured.id])
      if (isDisplayBudgetError(error)) await this.abortFrameAndReleaseFilterScratch()
      throw error
    }
  }
  /** Byte-level GPU memory accounting. Frame fields refer to the most recent
   * begin/finish cycle; capacity fields are current high-water allocations. */
  stats() {
    let textureBytes = 0
    for (const texture of this.textures) textureBytes += texture.bytes
    return {
      textureBytes:textureBytes+(this.presenter?.residentBytes||0),
      displayTextureBytes:this.presenter?.residentBytes||0,
      transientBytes: this.transientBytes,
      finishTransientBytes: this.finishTransientBytes,
      frameScratchBytes: this.frameScratchBytes,
      scratchBytes: this.scratchBytes,
      vertexBufferBytes: this.vertexCapacity,
      curveBufferBytes: this.curveCapacity,
      geometryUploadBytes: this.geometryUploadBytes,
      adapter: this.description,
      // Driver-lifetime raster transport only. Explicit picking/QA captures
      // in ResidentPresenter are separate from ordinary canvas presentation.
      rasterReadbackBytes:this.rasterReadbackBytes,
      crossDeviceBitmaps:this.crossDeviceBitmaps,residentCaptures:this.residentCaptures,
      geometryMirrorBytes: this.curveMirror.bytes + this.vertexMirror.bytes,
      residentProgramBytes:this.programArena.bytes,
      residentProgramHits:this.programHits,residentProgramHitBytes:this.programHitBytes,
      solidBufferBytes: this.solidBuffer?.size ?? 0,
      uniformBufferBytes: this.uniforms?.size ?? 0,
      deviceLost: this.lost,
      queueWaits: this.queueWaitStats.snapshot(this.resourceEpoch, this.completedResourceEpoch),
      pipelineBuilds: this.pipelines.builds, pipelineBuildMs: this.pipelines.buildMs, pipelineReady: this.pipelines.ready,
      passTimings: this.passTimings,
      textureViewCreates: this.bindingCache.viewCreates,
      bindGroupCreates: this.bindingCache.groupCreates,
      bindGroupHits: this.bindingCache.groupHits,
      bindGroupCacheSize: this.bindingCache.size,
      dynamicUniformBindings: this.dynamicUniformBindings,
      mergedExactFilterPasses: this.mergedExactFilterPasses,
    }
  }
  async loseDeviceForTesting() {
    if (!import.meta.env.DEV) throw new Error('Development check only')
    this.device.destroy()
    await this.device.lost
    if (!this.lost) throw new Error('WebGPU device loss was not observed')
  }
  dispose() {
    this.bindingCache.clear()
    if (this.disposed) return
    this.disposed = true
    this.closeOver()
    if (this.initialized && !this.lost && this.poolKey !== undefined) {
      // Park instead of destroying: non-device-lost teardown (budget-failure
      // recovery, preview tile splits) re-creates the GPU stack within
      // milliseconds and reuses this device and its compiled pipelines; only
      // renderer-level accounting is rebuilt around it. The reaper frees the
      // device when no matching create follows.
      if (WebGpuDriver.parkedDriver) {
        const previous = WebGpuDriver.parkedDriver
        WebGpuDriver.parkedDriver = undefined
        clearTimeout(previous.reaper)
        void previous.settled.then(
          () => previous.driver.destroyDeviceNow(),
          () => previous.driver.destroyDeviceNow(),
        )
      }
      this.parkedForReuse = true
      recordDeviceLifecycle(this, deviceLifecyclePhase.parked, this.lifecycleFields())
      const settled = this.reclaimForPark()
      const reaper = setTimeout(() => {
        if (WebGpuDriver.parkedDriver?.driver === this) {
          WebGpuDriver.parkedDriver = undefined
          console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'reaped' })}`)
          this.destroyDeviceNow()
        }
      }, PARKED_REAP_MS)
      WebGpuDriver.parkedDriver = { driver: this, key: this.poolKey, settled, reaper }
      return
    }
    this.destroyDeviceNow()
  }
  /** Full synchronous teardown: reclaim every resource and destroy the device. */
  private destroyDeviceNow() {
    recordDeviceLifecycle(this, deviceLifecyclePhase.disposed, this.lifecycleFields())
    this.presenter?.dispose(); this.presenter = undefined
    this.parkedForReuse = false
    this.closeOver()
    this.releaseFrameResources()
    this.prefix?.destroy()
    this.prefix = undefined
    this.timingQueries?.destroy()
    this.timingQueries = undefined
    this.uniforms?.destroy()
    this.device?.destroy()
  }
  /** Fence submitted commands, then reclaim frame resources while keeping the
   * device, pipelines and uniform arena for a matching future create. */
  private reclaimForPark(): Promise<void> {
    return (async () => {
      try {
        await this.waitForQueue('park')
      } catch {
        /* A device lost mid-fence reclaims itself; nothing left to do. */
      }
      if (!this.parkedForReuse || this.lost) return
      this.releaseFrameResources()
      // A failed frame can leave its validation scope open. Its error was
      // already thrown to the caller; pop the scope so a revived driver's
      // scope stack is balanced for its next frame.
      if (this.frameScopeOpen) {
        this.frameScopeOpen = false
        try {
          const stale = await this.device.popErrorScope()
          if (stale)
            console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'stale-scope-dropped', message: stale.message })}`)
        } catch (error) {
          console.debug(`DESIGN_GPU_PARK ${JSON.stringify({ event: 'stale-scope-pop-failed', error: String(error) })}`)
        }
      }
      this.errors = []
    })()
  }
  /** Restore a parked driver to its post-initialize state; only valid after
   * the park cleanup settled. */
  private async revive() {
    this.disposed = false
    this.parkedForReuse = false
    this.errors = []
    this.encoder = this.device.createCommandEncoder()
    this.blank = this.create(1, 1)
    this.clear(this.blank)
    this.queueWaitStats.submit(() => this.device.queue.submit([this.encoder.finish()]))
    this.commandSubmissions = 1
    await this.waitForQueue('initialization')
  }
  /** Reclaim frame-scoped resources: textures, MSAA/transient scratch, geometry
   * and solid buffers, and per-frame counters. Call only after submitted
   * commands completed (park path) or after device loss (every destroy is then
   * a safe no-op). */
  private releaseFrameResources() {
    this.prefix?.releaseScratch()
    for (const t of [...this.textures]) this.destroy(t)
    for (const t of this.transientTargets) this.destroy(t)
    this.transientTargets = []
    for (const t of this.transient) t.destroy()
    this.transient = []
    this.msaa.clear()
    this.transientBytes = 0
    this.vertices?.destroy()
    this.vertices = undefined
    this.vertexCapacity = 0
    this.curves?.destroy()
    this.curveMirror.reset(); this.vertexMirror.reset()
    this.programArena.reset();this.programOffsets=undefined;this.programGpuValid=false;this.programArenaActive=false
    this.curves = undefined
    this.curveCapacity = 0
    this.solidBuffer?.destroy()
    this.solidBuffer = undefined
    this.solidBind = undefined
    this.solidRanges.clear()
    this.solidOffset = 0
    this.solidUploaded = 0
    this.vertexShrink = { frames: 0, maxDemand: 0 }
    this.curveShrink = { frames: 0, maxDemand: 0 }
    this.offset = 0
    this.uploadedOffset = 0
    this.uniformCommands = 0
    this.frameScratchBytes = 0
    this.finishTransientBytes = 0
    this.timingRows = []
    this.softwareRaster = false
    this.activeTarget = undefined
    if (this.device && !this.lost) this.encoder = this.device.createCommandEncoder()
  }
  /** device.lost handler body: reclaim immediately instead of waiting for the
   * next request to dispose. */
  private releaseLostResources() {
    this.bindingCache.clear()
    console.debug(
      `DESIGN_GPU_LOST ${JSON.stringify({ event: 'immediate-cleanup', textures: this.textures.size })}`,
    )
    this.releaseFrameResources()
  }
}
