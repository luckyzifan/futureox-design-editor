import { afterEach, describe, test, expect, vi } from 'vitest'
import { StrokeGpuPipeline, type StrokeStyle } from './stroke-gpu-pipeline'
import { parallelPrefixSumWGSL } from './parallel-prefix-sum.wgsl'

// These execute production host orchestration against a command recorder.
// No shader executes: zero-filled readback is deliberately NOT a geometry oracle.
// Actual WGSL validation, joins/caps and pixels remain explicit TODOs below.
type BufferRecord = {
  size: number; usage: number; bytes: ArrayBuffer; destroyed: boolean
  getMappedRange(): ArrayBuffer; unmap(): void; mapAsync(): Promise<void>; destroy(): void
}
function recorder() {
  const buffers: BufferRecord[] = [], modules: GPUShaderModuleDescriptor[] = []
  const pipelines: GPUComputePipelineDescriptor[] = [], bindings: any[] = []
  const dispatches: { entryPoint: string; groups: number }[] = []
  const writes: { buffer: BufferRecord; offset: number; bytes: Uint8Array }[] = []
  let submissions = 0
  const device = {
    createShaderModule(descriptor: GPUShaderModuleDescriptor) { modules.push(descriptor); return descriptor },
    createComputePipeline(descriptor: GPUComputePipelineDescriptor) {
      pipelines.push(descriptor)
      return { ...descriptor, getBindGroupLayout: () => descriptor.compute.entryPoint }
    },
    createBuffer(descriptor: GPUBufferDescriptor) {
      const record: BufferRecord = { size: descriptor.size, usage: descriptor.usage,
        bytes: new ArrayBuffer(descriptor.size), destroyed: false,
        getMappedRange() { return this.bytes }, unmap() {}, async mapAsync() {}, destroy() { this.destroyed = true } }
      buffers.push(record); return record
    },
    createBindGroup(descriptor: any) { bindings.push(descriptor); return descriptor },
    createCommandEncoder() {
      let entryPoint = ''
      return {
        beginComputePass: () => ({ setPipeline(pipeline: any) { entryPoint = pipeline.compute.entryPoint },
          setBindGroup() {}, dispatchWorkgroups(groups: number) { dispatches.push({ entryPoint, groups }) }, end() {} }),
        copyBufferToBuffer(source: BufferRecord, sourceOffset: number, destination: BufferRecord, destinationOffset: number, bytes: number) {
          new Uint8Array(destination.bytes, destinationOffset, bytes).set(new Uint8Array(source.bytes, sourceOffset, bytes))
        }, finish: () => ({}),
      }
    },
    queue: {
      submit() { submissions++ }, async onSubmittedWorkDone() {},
      writeBuffer(buffer: BufferRecord, offset: number, input: ArrayBufferView) {
        const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice()
        writes.push({ buffer, offset, bytes }); new Uint8Array(buffer.bytes, offset, bytes.length).set(bytes)
      },
    },
  }
  vi.stubGlobal('GPUBufferUsage', { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8, MAP_READ: 16, INDEX: 32 })
  vi.stubGlobal('GPUMapMode', { READ: 1 })
  return { device: device as unknown as GPUDevice, buffers, modules, pipelines, bindings, dispatches, writes,
    submissions: () => submissions }
}
const style: StrokeStyle = { width: 10, color: '#000000', align: 'center', cap: 'butt', join: 'miter', miterLimit: 4 }
const path = new Float32Array([0, 0, 100, 0, 100, 100])
afterEach(() => vi.unstubAllGlobals())

describe('production stroke host contracts, recorded GPU commands only', () => {
  test('uninitialized compute rejects before allocating or submitting any GPU work', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await expect(pipeline.computeStroke(path, style)).rejects.toThrow('Pipeline not initialized')
    expect(r.buffers).toHaveLength(0); expect(r.submissions()).toBe(0)
  })
  test('initialization binds all four production modules to their actual shader entry points', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await pipeline.initialize()
    expect(r.modules).toHaveLength(4); expect(r.modules[0].code).toBe(parallelPrefixSumWGSL)
    expect(r.pipelines.map(p => p.compute.entryPoint)).toEqual(['prefixSum', 'computeNormals', 'computeOffsets', 'computeJoints'])
    for (const p of r.pipelines) expect((p.compute.module as unknown as GPUShaderModuleDescriptor).code).toContain(`fn ${p.compute.entryPoint}(`)
    expect(r.buffers).toHaveLength(0)
  })
  test('513 vertices dispatch normals, offsets, joints and both prefix phases through the production pipeline', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await pipeline.initialize(); await pipeline.computeStroke(new Float32Array(513 * 2), style)
    expect(r.dispatches).toEqual([
      { entryPoint: 'computeNormals', groups: 2 }, { entryPoint: 'computeOffsets', groups: 3 },
      { entryPoint: 'computeJoints', groups: 3 }, { entryPoint: 'prefixSum', groups: 2 }, { entryPoint: 'prefixSum', groups: 2 },
    ])
    const phaseWrites = r.writes.filter(w => w.buffer === r.bindings.find(b => b.layout === 'prefixSum').entries[2].resource.buffer)
    expect(phaseWrites.map(w => Array.from(new Uint32Array(w.bytes.buffer)))).toEqual([[513, 1, 0, 0], [513, 1, 1, 0]])
    expect(r.submissions()).toBe(6) // five compute passes plus owned readback
  })
  test.each([['center', 5], ['outside', 10], ['inside', 0]] as const)('production %s alignment uploads the intended offset width', async (align, expected) => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await pipeline.initialize(); await pipeline.computeStroke(path, { ...style, align })
    const params = r.bindings.find(b => b.layout === 'computeOffsets').entries[3].resource.buffer as BufferRecord
    expect(new DataView(params.bytes).getFloat32(0, true)).toBe(expected)
  })
  test('successful computation reclaims temporary buffers and returns owned input/readback-independent buffers', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device), input = path.slice()
    await pipeline.initialize(); const result = await pipeline.computeStroke(input, style)
    expect(new Float32Array(r.buffers[0].bytes)).toEqual(path)
    input.fill(999); expect(new Float32Array(r.buffers[0].bytes)).toEqual(path)
    const retained = [result.gpuBuffers!.vertexBuffer, result.gpuBuffers!.indexBuffer]
    expect(r.buffers.filter(b => !b.destroyed)).toEqual(retained)
    expect(r.buffers.filter(b => b.destroyed)).toHaveLength(r.buffers.length - 2)
    result.vertices.fill(999)
    expect(new Float32Array((result.gpuBuffers!.vertexBuffer as unknown as BufferRecord).bytes).every(n => n === 0)).toBe(true)
  })
  test('offset buffer has room for all four vec2 values per input vertex written by production WGSL', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await pipeline.initialize(); await pipeline.computeStroke(path, style)
    const offsets = r.bindings.find(b => b.layout === 'computeOffsets').entries[2].resource.buffer as BufferRecord
    expect(offsets.size).toBeGreaterThanOrEqual((path.length / 2) * 4 * 2 * Float32Array.BYTES_PER_ELEMENT)
  })
  test('joint uniform binding preserves the production WGSL field layout and miter-limit offset', async () => {
    const r = recorder(), pipeline = new StrokeGpuPipeline(r.device)
    await pipeline.initialize(); await pipeline.computeStroke(path, { ...style, join: 'bevel', miterLimit: 7.5 })
    const params = r.bindings.find(b => b.layout === 'computeJoints').entries[3].resource.buffer as BufferRecord
    // JointParams declares vertexCount, joinType, _pad0, _pad1, miterLimit, _pad2.
    expect(params.size).toBeGreaterThanOrEqual(24)
    const view = new DataView(params.bytes)
    expect(view.getUint32(0, true)).toBe(3); expect(view.getUint32(4, true)).toBe(2)
    expect(view.getFloat32(16, true)).toBe(7.5)
  })
})

test.todo('real WebGPU validates all production stroke shader modules and pipeline binding layouts')
test.todo('real WebGPU stroke pixels and vertex counts match an independent CPU oracle for butt/round/square caps and miter/round/bevel joins')
test.todo('real WebGPU multi-workgroup stroke prefix offsets agree with an independent scalar prefix oracle')
