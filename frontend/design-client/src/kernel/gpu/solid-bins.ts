import { exactBlendLattice } from './effect-region'
import { solidBinningWgsl, solidBinShadeWgsl } from './solid-bins.wgsl'
import { intersect, type GpuNode, type GpuScene } from './types'

const RECORD_WORDS = 12
const MAX_RECORDS = 4096
const MAX_RUN_LENGTH = 64
const MIN_RUN_LENGTH = 4
export const SOLID_BIN_SIDE = 16
export const SOLID_BIN_MAX_SIDE = 1024
const INDEX_BYTES = (SOLID_BIN_MAX_SIDE / SOLID_BIN_SIDE) ** 2 * 8
export const SOLID_BIN_STORAGE_BYTES = MAX_RECORDS * RECORD_WORDS * 4 + INDEX_BYTES

type Run = Readonly<{ start: number; count: number; end: number }>
export type SolidBinScene = Readonly<{
  runs: WeakMap<readonly string[], Run>
  records: Uint32Array<ArrayBuffer>
}>

function encodeSolid(scene: GpuScene, node: GpuNode | undefined, out: number[]) {
  const paint = node?.fills[0], path = node?.fill
  if (!node || !paint?.visible || paint.kind !== 'solid' || paint.opacity !== 1 || paint.blend !== 'normal' ||
      node.opacity !== 1 || node.blend !== 'normal' || node.clip || node.mask || node.maskId || node.passthrough ||
      node.fills.length !== 1 || node.strokes.length || node.children.length || node.effects.length ||
      node.captureReplay || node.textureReplay || node.opaqueCoverage || node.analyticRegion ||
      !path?.area || !path.count || !exactBlendLattice([node.rect, path.rect])) return false
  const { first, count } = path.area
  const curves = scene.curves
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 1 ||
      !curves || (first + count) * 4 > curves.length) return false
  const format = curves[first * 4], width = curves[first * 4 + 2], height = curves[first * 4 + 3]
  if ((format !== 0 && format !== 1) || width !== path.rect.w || height !== path.rect.h) return false
  if (!/^#[a-f\d]{6}$/i.test(paint.color)) return false
  const colour = scene.colors?.[paint.color] ?? [1, 3, 5].map(i => Number.parseInt(paint.color.slice(i, i + 2), 16) / 255).concat(1)
  if (colour.length !== 4 || colour[3] !== 1 || !colour.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) return false
  const bounds = intersect(node.rect, path.rect)
  if (!bounds.w || !bounds.h) return false
  const bits = new Uint32Array(new Float32Array(colour.slice(0, 3)).buffer)
  out.push(bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h,
    path.rect.x, path.rect.y, path.rect.w, path.rect.h, bits[0], bits[1], bits[2], first)
  return true
}

/** The native packet already contains the exact coverage programs. Pack only
 * the ordered pure-vector prefixes once, with their original program IDs. */
export function encodeSolidBinScene(scene: GpuScene): SolidBinScene | undefined {
  const payload: number[] = [], runs = new WeakMap<readonly string[], Run>()
  const encode = (ids: readonly string[]) => {
    if (ids.length < MIN_RUN_LENGTH || payload.length / RECORD_WORDS + MIN_RUN_LENGTH > MAX_RECORDS) return
    const start = payload.length / RECORD_WORDS
    let end = 0
    while (end < ids.length && payload.length / RECORD_WORDS - start < MAX_RUN_LENGTH &&
        payload.length / RECORD_WORDS < MAX_RECORDS) {
      const node = scene.nodes[ids[end]]
      if (node && !(node.opacity <= 0) && !encodeSolid(scene, node, payload)) break
      end++
    }
    const count = payload.length / RECORD_WORDS - start
    if (count >= MIN_RUN_LENGTH) runs.set(ids, { start, count, end })
    else payload.length = start * RECORD_WORDS
  }
  encode(scene.roots)
  for (const node of Object.values(scene.nodes)) {
    if (node.children.length && !node.mask && !node.maskId && !node.effects.length && !node.strokes.length)
      encode(node.children)
  }
  if (payload.length) return { runs, records: new Uint32Array(payload) }
}

export class SolidBinPipeline {
  private records?: GPUBuffer
  private bins?: GPUBuffer
  private uploaded?: SolidBinScene
  private constructor(private readonly device: GPUDevice, private readonly bin: GPUComputePipeline,
    private readonly shade: GPURenderPipeline) {}

  static async create(device: GPUDevice) {
    const bin = device.createShaderModule({ code: solidBinningWgsl, label: 'Solid-vector tile bins' })
    const shade = device.createShaderModule({ code: solidBinShadeWgsl, label: 'Exact binned solid-vector paint' })
    const shadeLayout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 1024 } },
      ...[1, 2, 3].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' as const } })),
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
    ] })
    const [binPipeline, shadePipeline] = await Promise.allSettled([
      device.createComputePipelineAsync({ layout: 'auto', compute: { module: bin, entryPoint: 'bin' } }),
      device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [shadeLayout] }),
        vertex: { module: shade, entryPoint: 'quad' },
        fragment: { module: shade, entryPoint: 'fragment', targets: [{ format: 'rgba32float' }] } }),
    ])
    if (binPipeline.status === 'rejected') throw binPipeline.reason
    if (shadePipeline.status === 'rejected') throw shadePipeline.reason
    return new SolidBinPipeline(device, binPipeline.value, shadePipeline.value)
  }

  get bytes() { return (this.records?.size || 0) + (this.bins?.size || 0) }
  begin() { this.uploaded = undefined }

  upload(scene: SolidBinScene, offsets: ReadonlyMap<number, number> | undefined, available: number) {
    if (this.uploaded === scene) return true
    if (!this.records && available < SOLID_BIN_STORAGE_BYTES) return false
    const records = scene.records.slice()
    if (offsets) for (let i = RECORD_WORDS - 1; i < records.length; i += RECORD_WORDS) {
      const offset = offsets.get(records[i])
      if (offset === undefined) return false
      records[i] = offset
    }
    if (!this.records || !this.bins) {
      const buffer = this.device.createBuffer({ size: MAX_RECORDS * RECORD_WORDS * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
      try {
        this.bins = this.device.createBuffer({ size: INDEX_BYTES, usage: GPUBufferUsage.STORAGE })
        this.records = buffer
      } catch (error) {
        buffer.destroy()
        throw error
      }
    }
    this.device.queue.writeBuffer(this.records, 0, records)
    this.uploaded = scene
    return true
  }

  encode(encoder: GPUCommandEncoder, parameters: GPUBufferBinding, curves: GPUBuffer, base: GPUTextureView,
    out: GPUTextureView, columns: number, rows: number) {
    const common = [
      { binding: 0, resource: parameters },
      { binding: 1, resource: { buffer: this.records! } },
      { binding: 2, resource: { buffer: this.bins! } },
    ]
    const bin = encoder.beginComputePass()
    bin.setPipeline(this.bin)
    bin.setBindGroup(0, this.device.createBindGroup({ layout: this.bin.getBindGroupLayout(0), entries: common }))
    bin.dispatchWorkgroups(Math.ceil(columns / 8), Math.ceil(rows / 8))
    bin.end()
    const shade = encoder.beginRenderPass({ colorAttachments: [{
      view: out, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
    }] })
    shade.setPipeline(this.shade)
    shade.setBindGroup(0, this.device.createBindGroup({ layout: this.shade.getBindGroupLayout(0), entries: [
      ...common, { binding: 3, resource: { buffer: curves } }, { binding: 4, resource: base },
    ] }))
    shade.draw(3)
    shade.end()
  }

  destroy() {
    this.records?.destroy()
    this.bins?.destroy()
    this.records = undefined
    this.bins = undefined
    this.uploaded = undefined
  }
}
