/// <reference types="@webgpu/types" />
/** Exact tent filtering, including fractional radii and cropped outputs,
 * with bounded GPU scratch. Uncertified rows retain the scalar exact path. */
export const PREFIX_SCRATCH_BYTES = 4 * 1024 * 1024
const PREFIX_BYTES = 3275776,
  RESULT_BYTES = 901120,
  METADATA_BYTES = 16384,
  READBACK_BYTES = 1024
if (PREFIX_BYTES + RESULT_BYTES + METADATA_BYTES + READBACK_BYTES !== PREFIX_SCRATCH_BYTES)
  throw new Error('scratch accounting')
type Rectangle = { x: number; y: number; w: number; h: number }
export class TexturePrefix {
  private prefix?: GPUBuffer
  private results?: GPUBuffer
  private metadata?: GPUBuffer
  private readback?: GPUBuffer
  private scratchLayout: GPUBindGroupLayout
  private sourceLayout: GPUBindGroupLayout
  private scratchGroup?: GPUBindGroup
  private scan!: GPUComputePipeline
  private solve!: GPUComputePipeline
  lastRenderPasses = 0
  lastComputePasses = 0
  private resolve: GPURenderPipeline[] = []
  get scratchBytes() {
    return this.prefix ? PREFIX_SCRATCH_BYTES : 0
  }
  private constructor(
    private device: GPUDevice,
    private uniform: (data: Float32Array) => GPUBufferBinding,
  ) {
    this.sourceLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT | GPUShaderStage.VERTEX,
          buffer: { type: 'uniform', minBindingSize: 1024 },
        },
        ...[1, 2, 3].map((binding) => ({
          binding,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' as const },
        })),
      ],
    })
    this.scratchLayout = device.createBindGroupLayout({
      entries: [0, 1, 2].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
        buffer: { type: 'storage' as const },
      })),
    })
  }
  /** Caller must admit every byte before allocation. */
  reserveScratch() {
    if (this.prefix) return
    try {
      const storage = (size: number) =>
        this.device.createBuffer({
          size,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        })
      this.prefix = storage(PREFIX_BYTES)
      this.results = storage(RESULT_BYTES)
      this.metadata = storage(METADATA_BYTES)
      this.readback = this.device.createBuffer({
        size: READBACK_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      this.scratchGroup = this.device.createBindGroup({
        layout: this.scratchLayout,
        entries: [this.prefix, this.metadata, this.results].map((buffer, binding) => ({
          binding,
          resource: { buffer: buffer! },
        })),
      })
    } catch (error) {
      this.releaseScratch()
      throw error
    }
  }
  /** Call only after submitted GPU work and readback complete, or before first use. */
  releaseScratch() {
    this.prefix?.destroy()
    this.results?.destroy()
    this.metadata?.destroy()
    this.readback?.destroy()
    this.prefix = undefined
    this.results = undefined
    this.metadata = undefined
    this.readback = undefined
    this.scratchGroup = undefined
  }
  static async create(
    device: GPUDevice,
    uniform: (data: Float32Array) => GPUBufferBinding,
    source: string,
    reserve = true,
  ) {
    const candidate = new TexturePrefix(device, uniform)
    try {
      await candidate.initialize(source)
      if (reserve) candidate.reserveScratch()
      return candidate
    } catch (error) {
      candidate.destroy()
      throw error
    }
  }
  private async initialize(code: string) {
    const module = this.device.createShaderModule({ code })
    const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
    if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.message}`).join('\n'))
    const layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.sourceLayout, this.scratchLayout],
    })
    this.scan = await this.device.createComputePipelineAsync({
      layout,
      compute: { module, entryPoint: 'prefixScan' },
    })
    this.solve = await this.device.createComputePipelineAsync({
      layout,
      compute: { module, entryPoint: 'prefixSolve' },
    })
    for (let channel = 0; channel < 4; channel++)
      this.resolve.push(
        await this.device.createRenderPipelineAsync({
          layout,
          vertex: { module, entryPoint: 'quad' },
          fragment: {
            module,
            entryPoint: 'prefixResolve',
            constants: { PREFIX_CHANNEL: channel },
            targets: [{ format: 'rgba32float', writeMask: 1 << channel }],
          },
          primitive: { topology: 'triangle-list' },
        }),
      )
  }
  resetCounters(encoder: GPUCommandEncoder) {
    if (this.metadata) encoder.clearBuffer(this.metadata, 0, 16)
  }
  encodeCountersReadback(encoder: GPUCommandEncoder) {
    if (!this.metadata || !this.readback) throw Error('Prefix scratch not reserved')
    encoder.copyBufferToBuffer(this.metadata, 0, this.readback, 0, 16)
  }
  async counters(encoder: GPUCommandEncoder) {
    this.encodeCountersReadback(encoder)
    this.device.queue.submit([encoder.finish()])
    return this.readCounters()
  }
  async readCounters() {
    if (!this.readback) throw Error('Prefix scratch not reserved')
    await this.readback.mapAsync(GPUMapMode.READ)
    const values = Array.from(new Uint32Array(this.readback.getMappedRange(), 0, 4))
    this.readback.unmap()
    return { acceptedLines: values[0], declinedLines: values[1], acceptedPixels: values[2] }
  }
  canEncode(
    target: GPUTexture,
    inputs: GPUTexture[],
    base: Float32Array,
    originalRadius: number,
    kind: 'tent' | 'box',
    rect: Rectangle,
    channels = 15,
    maxBandLines = 255,
  ): boolean {
    if (
      kind !== 'tent' ||
      !Number.isFinite(originalRadius) ||
      originalRadius < 1 ||
      originalRadius > 2048 ||
      base[36] !== Math.fround(originalRadius) ||
      (!Number.isInteger(originalRadius) && originalRadius < 3) ||
      base[38] !== 0 ||
      base[242] !== 0 ||
      inputs.length < 3 ||
      !(channels & 15)
    )
      return false
    if (
      ![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) ||
      Math.abs(rect.x) > 1048576 ||
      Math.abs(rect.y) > 1048576 ||
      rect.w < 1 ||
      rect.h < 1 ||
      rect.w > 16384 ||
      rect.h > 16384
    )
      return false
    if (
      base[0] !== rect.x ||
      base[1] !== rect.y ||
      base[2] !== rect.w ||
      base[3] !== rect.h ||
      !base.subarray(4, 8).every(Number.isSafeInteger) ||
      rect.x < base[4] || rect.y < base[5] ||
      rect.x + rect.w > base[4] + base[6] || rect.y + rect.h > base[5] + base[7]
    )
      return false
    if (
      target.format !== 'rgba32float' ||
      inputs[0]?.format !== 'rgba32float' ||
      target.width !== rect.w ||
      target.height !== rect.h ||
      inputs[0].width !== base[6] ||
      inputs[0].height !== base[7] ||
      inputs[0].width > 16384 || inputs[0].height > 16384 ||
      inputs.includes(target)
    )
      return false
    const axis = base[37]
    if (axis !== 0 && axis !== 1) return false
    const length = axis === 0 ? inputs[0].width : inputs[0].height,
      lineCount = axis === 0 ? rect.h : rect.w
    const bandSize = Math.min(
      Math.floor(PREFIX_BYTES / (32 * (length + 1))),
      Math.floor(RESULT_BYTES / (8 * length)),
      Math.floor((METADATA_BYTES - 16) / 16),
      maxBandLines,
    )
    if (!Number.isInteger(bandSize) || bandSize < 1) return false
    return true
  }
  /** The caller passes original f64 radius and explicit kind before f32 upload. */
  encode(
    encoderSource: GPUCommandEncoder | (() => GPUCommandEncoder),
    target: GPUTexture,
    inputs: GPUTexture[],
    base: Float32Array,
    originalRadius: number,
    kind: 'tent' | 'box',
    rect: Rectangle,
    channels = 15,
    maxBandLines = 255,
  ): boolean {
    this.lastRenderPasses = 0
    this.lastComputePasses = 0
    const getEncoder = typeof encoderSource === 'function' ? encoderSource : () => encoderSource
    if (
      !this.scratchGroup ||
      !this.canEncode(target, inputs, base, originalRadius, kind, rect, channels, maxBandLines)
    )
      return false
    const axis = base[37],
      length = axis === 0 ? inputs[0].width : inputs[0].height,
      lineCount = axis === 0 ? rect.h : rect.w
    const outputLength = axis === 0 ? rect.w : rect.h
    const offset = axis === 0 ? rect.x - base[4] : rect.y - base[5]
    const crossOffset = axis === 0 ? rect.y - base[5] : rect.x - base[4]
    const rational = !Number.isInteger(originalRadius) || originalRadius > 512
    const bandSize = Math.min(
      Math.floor(PREFIX_BYTES / (32 * (length + 1))),
      Math.floor(RESULT_BYTES / (8 * length)),
      Math.floor((METADATA_BYTES - 16) / 16),
      maxBandLines,
    )
    let drawn = false
    for (let channel = 0; channel < 4; channel++) {
      if (!(channels & (1 << channel))) continue
      for (let first = 0; first < lineCount; first += bandSize) {
        const count = Math.min(bandSize, lineCount - first)
        const u = base.slice()
        u.set([length, first, count, axis], 192)
        u.set([channel, rational ? Math.floor(originalRadius) - 1 : originalRadius, rational ? 1 : 0, 0], 196)
        u.set([offset, outputLength, crossOffset, 0], 200)
        const group = this.device.createBindGroup({
          layout: this.sourceLayout,
          entries: [
            { binding: 0, resource: this.uniform(u) },
            ...[0, 1, 2].map((i) => ({
              binding: i + 1,
              resource: (inputs[i] || inputs[0]).createView(),
            })),
          ],
        })
        // uniform() may submit and replace the caller's bounded command encoder.
        const encoder = getEncoder()
        const scan = encoder.beginComputePass()
        scan.setPipeline(this.scan)
        scan.setBindGroup(0, group)
        scan.setBindGroup(1, this.scratchGroup)
        scan.dispatchWorkgroups(count)
        scan.end()
        const solve = encoder.beginComputePass()
        solve.setPipeline(this.solve)
        solve.setBindGroup(0, group)
        solve.setBindGroup(1, this.scratchGroup)
        solve.dispatchWorkgroups(Math.ceil(outputLength / 64), count)
        solve.end()
        const resolve = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: target.createView(),
              loadOp: drawn ? 'load' : 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 0],
            },
          ],
        })
        resolve.setPipeline(this.resolve[channel])
        resolve.setBindGroup(0, group)
        resolve.setBindGroup(1, this.scratchGroup)
        if (axis === 0) resolve.setScissorRect(0, first, rect.w, count)
        else resolve.setScissorRect(first, 0, count, rect.h)
        resolve.draw(3)
        resolve.end()
        drawn = true
        this.lastRenderPasses++
        this.lastComputePasses += 2
      }
    }
    return true
  }
  destroy() {
    this.releaseScratch()
  }
}
