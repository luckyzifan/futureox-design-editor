import math from './byte-tent-prefix.wgsl?raw'
import scan from './byte-tent-prefix-scan.wgsl?raw'
import resolve from './byte-tent-prefix-resolve.wgsl?raw'
import { planByteTentPrefix, type ByteTentOptions, type ByteTentPlan } from './byte-tent-prefix-plan'
export { planByteTentPrefix, type ByteTentOptions, type ByteTentPlan } from './byte-tent-prefix-plan'

/** Real allocated bytes remain charged until a queue-completion promise that
 * covers these commands succeeds. Rejected/uncertain completion is not a
 * destruction certificate; callers may retry with a later covered boundary.
 * No method submits or waits for a queue internally. */
export class ByteTentPrefixLease {
  private state: 'encoded' | 'submitted' | 'waiting' | 'destroyed' = 'encoded'
  constructor(readonly plan: ByteTentPlan, private readonly buffers: GPUBuffer[]) {}
  get bytes() { return this.state === 'destroyed' ? 0 : this.plan.bytes }
  get retired() { return this.state === 'destroyed' }
  /** Call immediately after the owning encoder is submitted. */
  markSubmitted() {
    if (this.state === 'encoded') this.state = 'submitted'
    else if (this.state !== 'submitted') throw Error('Byte tent lease already retiring')
  }
  private destroy() {
    if (this.state === 'destroyed') return
    this.state = 'destroyed'
    for (const buffer of this.buffers) buffer.destroy()
  }
  /** Only for an abandoned encoder whose commands were never submitted. */
  discardUnsubmitted() {
    if (this.state !== 'encoded') throw Error('Byte tent lease already retiring')
    this.destroy()
  }
  /** The caller must pass an actual boundary covering this submission. */
  async retireAfter(coveredCompletion: Promise<unknown>) {
    if (this.state !== 'encoded' && this.state !== 'submitted') throw Error('Byte tent lease already retiring')
    const previous = this.state
    this.state = 'waiting'
    try { await coveredCompletion; this.destroy() }
    catch (error) { if (!this.retired) this.state = previous; throw error }
  }
  /** Device loss/destruction retires all commands; ordinary cancellation does not. */
  disposeAfterDeviceLoss() { this.destroy() }
}

/** Independent, opt-in building block. It is never selected by the renderer
 * automatically. Only shadow alpha consumers may use its RGB-zero result.
 * Input must be the driver's current immutable RGBA8unorm alpha plane. R8/R32F
 * are rejected: their textureLoad .a lane does not contain authored alpha. */
export class ByteTentPrefix {
  private constructor(private readonly device: GPUDevice, private readonly scanLayout: GPUBindGroupLayout,
    private readonly resolveLayout: GPUBindGroupLayout, private readonly scanPipeline: GPUComputePipeline,
    private readonly resolvePipeline: GPURenderPipeline) {}
  static async create(device: GPUDevice): Promise<ByteTentPrefix> {
    const scanModule = device.createShaderModule({ code: math + scan, label: 'Byte shadow alpha u64 prefix' })
    const resolveModule = device.createShaderModule({ code: math + resolve, label: 'Byte shadow alpha exact tent RNE' })
    for (const module of [scanModule, resolveModule]) {
      const errors = (await module.getCompilationInfo()).messages.filter(value => value.type === 'error')
      if (errors.length) throw Error(errors.map(value => `${value.lineNum}:${value.message}`).join('\n'))
    }
    const layout = (compute: boolean) => device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: compute ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } },
      { binding: 1, visibility: compute ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'float' } },
      { binding: 2, visibility: compute ? GPUShaderStage.COMPUTE : GPUShaderStage.FRAGMENT,
        buffer: { type: compute ? 'storage' : 'read-only-storage' } },
    ] })
    const scanLayout = layout(true), resolveLayout = layout(false)
    const scanPipeline = await device.createComputePipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [scanLayout] }),
      compute: { module: scanModule, entryPoint: 'scanByteTent' },
    })
    const resolvePipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [resolveLayout] }),
      vertex: { module: resolveModule, entryPoint: 'byteTentQuad' },
      fragment: { module: resolveModule, entryPoint: 'resolveByteTent', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    return new ByteTentPrefix(device, scanLayout, resolveLayout, scanPipeline, resolvePipeline)
  }
  /** Synchronous recording, no internal submit/fence and no hidden scratch.
   * Undefined declines before allocating/recording. Exceptions require the
   * caller to abandon this encoder, just as a failed ordinary filter pass. */
  encode(encoder: GPUCommandEncoder, source: GPUTexture, target: GPUTexture, options: ByteTentOptions,
    availableBytes = options.scratchBudgetBytes ?? 2 * 1024 * 1024): ByteTentPrefixLease | undefined {
    const plan = planByteTentPrefix(options)
    if (!plan || !Number.isSafeInteger(availableBytes) || availableBytes < plan.bytes || source === target ||
        source.format !== 'rgba8unorm' || target.format !== 'rgba8unorm' || source.sampleCount !== 1 || target.sampleCount !== 1 ||
        source.dimension !== '2d' || target.dimension !== '2d' || source.depthOrArrayLayers !== 1 || target.depthOrArrayLayers !== 1 ||
        source.width !== plan.source.w || source.height !== plan.source.h ||
        target.width !== plan.output.w || target.height !== plan.output.h ||
        !(source.usage & GPUTextureUsage.TEXTURE_BINDING) || !(target.usage & GPUTextureUsage.RENDER_ATTACHMENT)) return
    const buffers: GPUBuffer[] = []
    try {
      const prefix = this.device.createBuffer({ size: plan.prefixBytes, usage: GPUBufferUsage.STORAGE })
      buffers.push(prefix)
      const uniform = this.device.createBuffer({ size: plan.uniformBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      buffers.push(uniform)
      const words = new Uint32Array(plan.uniformBytes / 4), integers = new Int32Array(words.buffer)
      for (let band = 0; band < plan.bands; band++) {
        const offset = band * 64, first = band * plan.bandLines, count = Math.min(plan.bandLines, plan.lines - first)
        words.set([source.width, source.height, target.width, target.height], offset)
        integers.set([plan.output.x - plan.source.x, plan.output.y - plan.source.y, 0, 0], offset + 4)
        words.set([plan.radius, plan.axis, first, count], offset + 8)
      }
      this.device.queue.writeBuffer(uniform, 0, words)
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: uniform, size: 48 } },
        { binding: 1, resource: source.createView() }, { binding: 2, resource: { buffer: prefix } },
      ]
      const scanGroup = this.device.createBindGroup({ layout: this.scanLayout, entries })
      const resolveGroup = this.device.createBindGroup({ layout: this.resolveLayout, entries })
      for (let band = 0; band < plan.bands; band++) {
        const first = band * plan.bandLines, count = Math.min(plan.bandLines, plan.lines - first)
        const compute = encoder.beginComputePass()
        compute.setPipeline(this.scanPipeline); compute.setBindGroup(0, scanGroup, [band * 256])
        compute.dispatchWorkgroups(count); compute.end()
        const render = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(),
          loadOp: band === 0 ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
        render.setPipeline(this.resolvePipeline); render.setBindGroup(0, resolveGroup, [band * 256])
        if (plan.axis === 0) render.setScissorRect(0, first, target.width, count)
        else render.setScissorRect(first, 0, count, target.height)
        render.draw(3); render.end()
      }
      return new ByteTentPrefixLease(plan, buffers)
    } catch (error) { for (const buffer of buffers) buffer.destroy(); throw error }
  }
}
