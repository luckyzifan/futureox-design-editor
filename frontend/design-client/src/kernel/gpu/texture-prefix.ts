import { PREFIX_BYTES, RESULT_BYTES, METADATA_BYTES, READBACK_BYTES, prefixBandSize, prefixRgbBandSize } from './prefix-band'
import { filterSourceWindowUniforms, snapshotFilterSourceWindow, type FilterSourceWindow } from './filter-source-window'
import { prefixSamplingGeometry } from './prefix-sampling-geometry'
import { recordGpuDiagnostic, gpuDiagnosticsEnabled } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
/// <reference types="@webgpu/types" />
/** Exact tent filtering, including fractional radii and cropped outputs,
 * with bounded GPU scratch. Uncertified rows retain the scalar exact path. */
export const PREFIX_SCRATCH_BYTES = 4 * 1024 * 1024
if (PREFIX_BYTES + RESULT_BYTES + METADATA_BYTES + READBACK_BYTES !== PREFIX_SCRATCH_BYTES)
  throw new Error('scratch accounting')
type Rectangle = { x: number; y: number; w: number; h: number }
export type PrefixPassTiming = (
  stage: 'prefix-scan' | 'prefix-solve' | 'prefix-resolve',
  width: number, height: number, radius: number, channel: number,
) => GPUComputePassTimestampWrites | undefined
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
  private solveRgb?: GPUComputePipeline
  private resolveRgb?: GPURenderPipeline
  lastRenderPasses = 0
  lastComputePasses = 0
  private resolve: GPURenderPipeline[] = []
  get scratchBytes() {
    return this.prefix ? PREFIX_SCRATCH_BYTES : 0
  }
  private constructor(
    private device: GPUDevice,
    private uniform: (data: Float32Array) => GPUBufferBinding,
    private measure?: PrefixPassTiming,
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
    measure?: PrefixPassTiming,
  ) {
    const candidate = new TexturePrefix(device, uniform, measure)
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
    if (import.meta.env.VITE_DESIGN_PREFIX_RGB_RESOLVE !== '0') {
      this.solveRgb = await this.device.createComputePipelineAsync({
        layout, compute: { module, entryPoint: 'prefixSolveRgb' },
      })
      this.resolveRgb = await this.device.createRenderPipelineAsync({
        layout, vertex: { module, entryPoint: 'quad' },
        fragment: { module, entryPoint: 'prefixResolveRgb', targets: [{ format: 'rgba32float' }] },
        primitive: { topology: 'triangle-list' },
      })
    }
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
    const started=gpuDiagnosticsEnabled()?performance.now():0
    await this.readback.mapAsync(GPUMapMode.READ)
    recordGpuDiagnostic('prefix',{mapMs:performance.now()-started})
    const values = Array.from(new Uint32Array(this.readback.getMappedRange(), 0, 4))
    this.readback.unmap()
    return { acceptedLines: values[0], declinedLines: values[1], acceptedPixels: values[2], narrowLines: values[3] }
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
    sourceWindow?: FilterSourceWindow,
  ): boolean {
    const extended = import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1'
    const geometry = prefixSamplingGeometry(base, originalRadius, extended)
    const window = sourceWindow === undefined ? undefined : snapshotFilterSourceWindow(inputs[0], base, sourceWindow)
    if (sourceWindow !== undefined && (import.meta.env.VITE_DESIGN_FILTER_SOURCE_WINDOW !== '1' || !window)) return false
    if (
      kind !== 'tent' ||
      !Number.isFinite(originalRadius) ||
      originalRadius < 1 ||
      originalRadius > 2048 ||
      base[36] !== Math.fround(originalRadius) ||
      (!Number.isInteger(originalRadius) && originalRadius < 3) ||
      !geometry ||
      base[242] !== 0 ||
      inputs.length < 3 ||
      !(channels & 15)
    )
      return false
    if (
      ![rect.x, rect.y].every(v => Number.isFinite(v) && (extended || Number.isInteger(v))) ||
      ![rect.w, rect.h].every(Number.isInteger) ||
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
      !base.subarray(4, 6).every(v => Number.isFinite(v) && (extended || Number.isSafeInteger(v))) ||
      !base.subarray(6, 8).every(Number.isSafeInteger)
    )
      return false
    if (
      target.format !== 'rgba32float' ||
      inputs[0]?.format !== 'rgba32float' ||
      target.width !== rect.w ||
      target.height !== rect.h ||
      !window && (inputs[0].width !== base[6] || inputs[0].height !== base[7]) ||
      inputs[0].width > 16384 || inputs[0].height > 16384 ||
      inputs.includes(target)
    )
      return false
    const axis = base[37]
    if (axis !== 0 && axis !== 1) return false
    const length = geometry.length,
      lineCount = axis === 0 ? rect.h : rect.w
    const bandSize = prefixBandSize(length, maxBandLines)
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
    opaqueAlpha = false,
    rationalBoundBits = 0,
    sourceWindow?: FilterSourceWindow,
    certifiedTent = false,
  ): boolean {
    this.lastRenderPasses = 0
    this.lastComputePasses = 0
    const getEncoder = typeof encoderSource === 'function' ? encoderSource : () => encoderSource
    const window = sourceWindow === undefined ? undefined : snapshotFilterSourceWindow(inputs[0], base, sourceWindow)
    if (sourceWindow !== undefined && !window) return false
    if (
      !this.scratchGroup ||
      !this.canEncode(target, inputs, base, originalRadius, kind, rect, channels, maxBandLines, window)
    )
      return false
    base = filterSourceWindowUniforms(base, window)
    // The caller obtains this bound from the actual immutable coefficient
    // upload. Zero/unknown values retain the existing shader admission gate.
    const boundBits = Number.isInteger(rationalBoundBits) && rationalBoundBits >= 1 && rationalBoundBits <= 120
      ? rationalBoundBits : 0
    if (import.meta.env.VITE_DESIGN_PREFIX_RGB_RESOLVE !== '0' && opaqueAlpha && channels === 7 &&
        this.solveRgb && this.resolveRgb)
      return this.encodeOpaqueRgb(getEncoder, target, inputs, base, originalRadius, rect, maxBandLines, boundBits,certifiedTent)
    const geometry = prefixSamplingGeometry(base, originalRadius, import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1')!
    const axis = base[37],
      length = geometry.length,
      lineCount = axis === 0 ? rect.h : rect.w
    const outputLength = axis === 0 ? rect.w : rect.h
    const offset = geometry.offset
    const crossOffset = geometry.crossOffset
    const rational = !Number.isInteger(originalRadius) || originalRadius > 512
    const bandSize = prefixBandSize(length, maxBandLines)
    let drawn = false
    for (let channel = 0; channel < 4; channel++) {
      if (!(channels & (1 << channel))) continue
      for (let first = 0; first < lineCount; first += bandSize) {
        const count = Math.min(bandSize, lineCount - first)
        const u = base.slice()
        u.set([length, first, count, axis], 192)
        u.set([channel, rational||certifiedTent ? Math.floor(originalRadius) - 1 : originalRadius, certifiedTent?2:rational ? 1 : 0, boundBits], 196)
        u.set([offset, outputLength, crossOffset, geometry.padding], 200)
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
        const scan = encoder.beginComputePass({
          timestampWrites: this.measure?.('prefix-scan', length, count, originalRadius, channel),
        })
        scan.setPipeline(this.scan)
        scan.setBindGroup(0, group)
        scan.setBindGroup(1, this.scratchGroup)
        scan.dispatchWorkgroups(count)
        scan.end()
        const solve = encoder.beginComputePass({
          timestampWrites: this.measure?.('prefix-solve', outputLength, count, originalRadius, channel),
        })
        solve.setPipeline(this.solve)
        solve.setBindGroup(0, group)
        solve.setBindGroup(1, this.scratchGroup)
        solve.dispatchWorkgroups(Math.ceil(outputLength / 64), count)
        solve.end()
        const resolve = encoder.beginRenderPass({
          timestampWrites: this.measure?.('prefix-resolve', outputLength, count, originalRadius, channel),
          colorAttachments: [
            {
              view: target.createView(),
              loadOp: drawn ? 'load' : 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, opaqueAlpha ? 1 : 0],
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
  /** Opaque-alpha specialization only. Each band completes all three channel
   * scans/solves before one full-RGB resolve. Uniform allocation may roll the
   * encoder between channels; always reacquire it after creating the group. */
  private encodeOpaqueRgb(getEncoder: () => GPUCommandEncoder, target: GPUTexture, inputs: GPUTexture[],
    base: Float32Array, radius: number, rect: Rectangle, maxBandLines: number, rationalBoundBits: number,certifiedTent=false): boolean {
    const geometry = prefixSamplingGeometry(base, radius, import.meta.env.VITE_DESIGN_EXACT_CLAMP_PREFIX === '1')!
    const axis = base[37], length = geometry.length
    const outputLength = axis === 0 ? rect.w : rect.h, lineCount = axis === 0 ? rect.h : rect.w
    const bandSize = prefixRgbBandSize(length, outputLength, maxBandLines)
    if (!bandSize) return false
    const offset = geometry.offset
    const crossOffset = geometry.crossOffset
    const rational = !Number.isInteger(radius) || radius > 512
    let drawn = false
    for (let first = 0; first < lineCount; first += bandSize) {
      const count = Math.min(bandSize, lineCount - first)
      let lastGroup!: GPUBindGroup
      for (let channel = 0; channel < 3; channel++) {
        const u = base.slice()
        u.set([length, first, count, axis], 192)
        u.set([channel, rational||certifiedTent ? Math.floor(radius) - 1 : radius, certifiedTent?2:rational ? 1 : 0, rationalBoundBits], 196)
        u.set([offset, outputLength, crossOffset, geometry.padding], 200)
        lastGroup = this.device.createBindGroup({ layout: this.sourceLayout, entries: [
          { binding: 0, resource: this.uniform(u) },
          ...[0, 1, 2].map(i => ({ binding: i + 1, resource: (inputs[i] || inputs[0]).createView() })),
        ] })
        const encoder = getEncoder()
        const scan = encoder.beginComputePass({ timestampWrites: this.measure?.('prefix-scan', length, count, radius, channel) })
        scan.setPipeline(this.scan); scan.setBindGroup(0, lastGroup); scan.setBindGroup(1, this.scratchGroup!)
        scan.dispatchWorkgroups(count); scan.end()
        const solve = encoder.beginComputePass({ timestampWrites: this.measure?.('prefix-solve', outputLength, count, radius, channel) })
        solve.setPipeline(this.solveRgb!); solve.setBindGroup(0, lastGroup); solve.setBindGroup(1, this.scratchGroup!)
        solve.dispatchWorkgroups(Math.ceil(outputLength / 64), count); solve.end()
        this.lastComputePasses += 2
      }
      const resolve = getEncoder().beginRenderPass({
        timestampWrites: this.measure?.('prefix-resolve', outputLength, count, radius, -1),
        colorAttachments: [{ view: target.createView(), loadOp: drawn ? 'load' : 'clear',
          storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      })
      resolve.setPipeline(this.resolveRgb!); resolve.setBindGroup(0, lastGroup); resolve.setBindGroup(1, this.scratchGroup!)
      if (axis === 0) resolve.setScissorRect(0, first, rect.w, count)
      else resolve.setScissorRect(first, 0, count, rect.h)
      resolve.draw(3); resolve.end(); drawn = true; this.lastRenderPasses++
    }
    return true
  }
  destroy() {
    this.releaseScratch()
  }
}
