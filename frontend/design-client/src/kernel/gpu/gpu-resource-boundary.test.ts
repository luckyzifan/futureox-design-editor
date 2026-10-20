import { setDeviceDiagnosticRequestContext } from './device-lifecycle-diagnostics'
import { setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'
// CPU-only descriptor/ownership instrumentation of production renderer/driver
// methods. WGSL is neither executed nor validated here; these are work counts,
// coefficient-byte and command-contract checks, never pixel or timing claims.
import { afterEach, expect, test, vi } from 'vitest'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { GpuRenderer } from './renderer'
import { WebGpuDriver } from './webgpu'
import { ImmutableKernelCache } from './immutable-kernel-cache'
import { parameters, type GpuScene, type Texture } from './types'
import { displayFilterWeights } from './display-filter'
import { rational_tent_kernel_rgba } from '../../generated/design-kernel/design_kernel'

afterEach(() => { setDeviceDiagnosticRequestContext(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
const frozenBaseline = process.env.GPU_RESOURCE_BASELINE === '1'
function measurement(value: object) {
  const row = JSON.stringify({ source: frozenBaseline ? 'frozen-base-5b7ed1a' : 'working-tree', ...value })
  console.info('GPU_RESOURCE_MEASUREMENT ' + row)
  if (process.env.GPU_RESOURCE_REPORT) appendFileSync(process.env.GPU_RESOURCE_REPORT, row + '\n')
}

const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
type Resource = { id: number; destroyed: boolean; size?: number; data?: Uint8Array; trace?: string; width?: number; height?: number; format?: string; destroy(): void }
function deviceBoundary() {
  let next = 0, lost = false, scopes = 0
  const live = new Set<Resource>(), pending = new Set<Resource>()
  const records: { mode: number; words: number[]; textures: number[]; offset: number }[] = []
  const writes: Uint8Array[] = [], normalized: object[] = []
  let bindCreates = 0, passCreates = 0, submissions = 0, waits = 0
  let rejectWait = false, rejectScope = false, finishWait: (() => void) | undefined
  let lose!: (info: { reason: string; message: string }) => void
  const lostPromise = new Promise<{ reason: string; message: string }>(resolve => { lose = resolve })
  function resource(extra: object = {}): Resource {
    const value = { id: ++next, destroyed: false, ...extra, destroy() {
      expect(lost || !pending.has(value), 'cannot destroy a resource before its submitted reads complete').toBe(true)
      expect(value.destroyed, 'resource is destroyed exactly once').toBe(false)
      value.destroyed = true; live.delete(value)
    } }
    live.add(value); return value
  }
  const device: any = {
    features: new Set(), limits: { maxTextureDimension2D: 16384, minUniformBufferOffsetAlignment: 256 },
    lost: lostPromise,
    addEventListener() {},
    createShaderModule: (descriptor: object) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (descriptor: any) => descriptor,
    createPipelineLayout: (descriptor: any) => descriptor,
    createRenderPipelineAsync: async (descriptor: any) => descriptor,
    createBuffer: ({ size }: { size: number }) => resource({ size, data: new Uint8Array(size) }),
    createTexture: ({ size, format }: { size: number[]; format: string }) => {
      const value = resource({ width: size[0], height: size[1], format }) as any
      value.createView = () => { expect(value.destroyed).toBe(false); return { texture: value } }
      return value
    },
    createBindGroup({ layout, entries }: any) {
      bindCreates++
      for (const entry of entries) {
        expect(entry.resource).toBeDefined()
        if (entry.resource.buffer) {
          expect(entry.resource.buffer.destroyed).toBe(false)
          const range = entry.resource
          expect((range.offset || 0) + (range.size || 0)).toBeLessThanOrEqual(range.buffer.size)
        }
      }
      return { layout, entries }
    },
    createCommandEncoder() {
      const operations: any[] = [], resources = new Set<Resource>()
      return {
        beginRenderPass({ colorAttachments }: any) {
          passCreates++
          const attachment = colorAttachments[0], target = attachment.view.texture
          resources.add(target)
          operations.push({ kind: 'load', target, loadOp: attachment.loadOp, clearValue: attachment.clearValue })
          let pipeline: any, groups: any[] = [], scissor: number[] | undefined
          return {
            setPipeline(value: any) { pipeline = value },
            setBindGroup(index: number, group: any, offsets: number[] = []) {
              const dynamic = group.layout.entries.filter((entry: any) => entry.buffer?.hasDynamicOffset)
              expect(offsets.length, 'dynamic offset count must match the actual production layout').toBe(dynamic.length)
              groups[index] = { group, offsets: [...offsets] }
              for (const entry of group.entries) {
                if (entry.resource.texture) {
                  expect(entry.resource.texture).not.toBe(target)
                  resources.add(entry.resource.texture)
                }
                if (entry.resource.buffer) resources.add(entry.resource.buffer)
              }
            },
            setScissorRect(...value: number[]) { scissor = value }, setVertexBuffer() {}, setStencilReference() {},
            draw(...args: number[]) { operations.push({ kind: 'draw', pipeline, groups: [...groups], target, scissor, args }) }, end() {},
          }
        },
        finish() { return { operations, resources } },
      }
    },
    pushErrorScope() { scopes++ },
    async popErrorScope() { expect(scopes).toBeGreaterThan(0); scopes--; return rejectScope ? { message: 'Injected validation failure' } : null },
    queue: {
      writeBuffer(buffer: Resource, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
        expect(buffer.destroyed).toBe(false)
        const source = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data)
        buffer.data!.set(source.subarray(dataOffset, size === undefined ? undefined : dataOffset + size), offset)
      },
      writeTexture({ texture }: { texture: Resource }, data: ArrayBufferView) {
        expect(texture.destroyed).toBe(false)
        const copy = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
        texture.data = copy; texture.trace = digest({ upload: [...copy], format: texture.format, width: texture.width, height: texture.height }); writes.push(copy)
      },
      submit(commands: any[]) {
        submissions++
        for (const command of commands) {
          for (const value of command.resources) { expect(value.destroyed).toBe(false); pending.add(value) }
          for (const draw of command.operations) {
            if (draw.kind === 'load') {
              if (draw.loadOp === 'clear') draw.target.trace = digest({ clear: draw.clearValue, width: draw.target.width, height: draw.target.height, format: draw.target.format })
              continue
            }
            const first = draw.groups[0]
            if (!first) continue
            const binding = first.group.entries.find((entry: any) => entry.binding === 0).resource
            if (!binding.size) continue // storage-only groups are not compositor uniforms
            const offset = (binding.offset || 0) + (first.offsets[0] || 0)
            expect(offset % 256).toBe(0)
            expect(offset + 1024).toBeLessThanOrEqual(binding.buffer.size)
            const words = [...new Uint32Array(binding.buffer.data.buffer, offset, 256)]
            const values = new Float32Array(binding.buffer.data.buffer, offset, 256)
            const pipeline = draw.pipeline
            const commandTrace = {
              uniforms: words,
              vertex: { shader: digest(pipeline.vertex.module.code), entryPoint: pipeline.vertex.entryPoint },
              fragment: { shader: digest(pipeline.fragment.module.code), entryPoint: pipeline.fragment.entryPoint,
                constants: pipeline.fragment.constants, targets: pipeline.fragment.targets },
              primitive: pipeline.primitive, scissor: draw.scissor, draw: draw.args,
              target: { width: draw.target.width, height: draw.target.height, format: draw.target.format, previous: draw.target.trace },
              inputs: first.group.entries.filter((entry: any) => entry.binding !== 0).map((entry: any) => ({ binding: entry.binding,
                identity: entry.resource.texture?.trace || (entry.resource.buffer ? digest([...entry.resource.buffer.data]) : 'uninitialized'),
                width: entry.resource.texture?.width, height: entry.resource.texture?.height, format: entry.resource.texture?.format })),
            }
            normalized.push(commandTrace); draw.target.trace = digest(commandTrace)
            records.push({ mode: values[16], words, offset,
              textures: first.group.entries.filter((entry: any) => entry.resource.texture).map((entry: any) => entry.resource.texture.id) })
          }
        }
      },
      async onSubmittedWorkDone() {
        waits++
        if (rejectWait) throw Error('Injected completion rejection')
        if (finishWait) await new Promise<void>(resolve => { finishWait = resolve })
        pending.clear()
      },
    },
    destroy() { lost = true; pending.clear(); lose({ reason: 'destroyed', message: 'Injected device loss' }) },
  }
  const context = { configure() {}, getConfiguration: () => ({ toneMapping: { mode: 'standard' } }) }
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, STORAGE: 2, COPY_SRC: 4, COPY_DST: 8, VERTEX: 16 })
  vi.stubGlobal('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} getContext() { return context } })
  vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(), requestDevice: async () => device }), getPreferredCanvasFormat: () => 'rgba8unorm' } })
  return { device, records, normalized, writes, live, pending,
    counts: () => ({ bindCreates, passCreates, submissions, waits, textureUploads: writes.length, uploadBytes: writes.reduce((sum, data) => sum + data.byteLength, 0) }),
    rejectWait(value: boolean) { rejectWait = value }, rejectScope(value: boolean) { rejectScope = value },
    holdWait() { finishWait = () => {} }, releaseWait() { const resolve = finishWait; finishWait = undefined; resolve?.() },
  }
}
async function createDriver(dynamic: boolean, managed = true, certified = false) {
  vi.stubEnv('VITE_DESIGN_DYNAMIC_UNIFORMS', dynamic ? '1' : '0')
  const boundary = deviceBoundary()
  const driver = new WebGpuDriver(managed, false, managed, certified)
  await (driver as any).initialize() // actual layout, buffers, pipeline descriptors and blank texture
  return { boundary, driver }
}
const empty: GpuScene = { version: 8, width: 8, height: 8, output: { x: 0, y: 0, w: 8, h: 8 },
  extent: { x: 0, y: 0, w: 8, h: 8 }, floatCompositing: true, coherentSamples: false, integratedBlur: true,
  background: '#ffffff', transparent: false, grid: false, view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [] }

test('production dynamic descriptors reuse across offsets and arena wrap with identical submitted uniform words', async () => {
  const results: { counts: ReturnType<ReturnType<typeof deviceBoundary>['counts']>; records: object[]; normalized: object[] }[] = []
  for (const dynamic of [false, true]) {
    const { boundary, driver } = await createDriver(dynamic)
    await driver.prepareScene(empty)
    // Exercise queue-ordered wrap through the production allocator, with a
    // small test arena to avoid manufacturing 4096 redundant draws.
    ;(driver as any).uniformData = new Float32Array(1024)
    driver.begin(new Float32Array(0))
    const target = driver.create(8, 8), source = driver.create(8, 8)
    for (let i = 0; i < 13; i++) {
      const u = parameters(empty.extent, empty.extent); u[16] = 0; u[36] = i + .125
      driver.pass(target, u, [source])
    }
    await driver.checkpoint()
    expect(driver.drawCalls).toBe(13)
    expect(boundary.records.map(record => new Float32Array(new Uint32Array(record.words).buffer)[36])).toEqual(Array.from({ length: 13 }, (_, i) => i + .125))
    results.push({ counts: boundary.counts(), normalized: boundary.normalized, records: boundary.records.map(({ offset: _offset, ...rest }) => rest) })
    driver.dispose()
  }
  expect(results[1].records).toEqual(results[0].records)
  expect(results[1].normalized).toEqual(results[0].normalized)
  expect(results[0].counts.bindCreates).toBe(4)
  expect(results[1].counts.bindCreates).toBe(frozenBaseline ? 4 : 1)
  expect(results[1].counts.passCreates).toBe(results[0].counts.passCreates)
  expect(results[1].counts.submissions).toBe(results[0].counts.submissions)
  measurement({ scope: 'CPU production WebGpuDriver descriptors; no shader/GPU timing', scenario: '13 draws; 4-slot uniform arena', commandTraceSha256: digest(results[0].normalized), static: results[0].counts, dynamic: results[1].counts })
})

test('dynamic groups revoke on resource identity changes and disabling the cache is a negative control', async () => {
  const { boundary, driver } = await createDriver(true)
  await driver.prepareScene(empty); driver.begin(new Float32Array(0))
  const target = driver.create(8, 8), first = driver.create(8, 8), replacement = driver.create(8, 8)
  const draw = (input: Texture) => { const u = parameters(empty.extent, empty.extent); driver.pass(target, u, [input]) }
  draw(first); draw(first); expect(driver.stats().bindGroupCreates).toBe(1)
  draw(replacement); expect(driver.stats().bindGroupCreates).toBe(2)
  await driver.checkpoint()
  const oldCurves = (driver as any).curves
  ;(driver as any).curves = boundary.device.createBuffer({ size: 16 })
  oldCurves.destroy()
  draw(replacement); expect(driver.stats().bindGroupCreates).toBe(3)
  await driver.checkpoint()
  const oldUniforms = (driver as any).uniforms
  ;(driver as any).uniforms = boundary.device.createBuffer({ size: 4 * 1024 * 1024 })
  oldUniforms.destroy()
  draw(replacement); expect(driver.stats().bindGroupCreates).toBe(4)
  vi.stubEnv('VITE_DESIGN_BINDING_CACHE', '0')
  draw(replacement); draw(replacement); expect(driver.stats().bindGroupCreates).toBe(6)
  await driver.checkpoint(); driver.dispose(); expect(boundary.live.size).toBe(0)
})

test('an incompatible dynamic uniform alignment fails explicitly before any command is encoded', async () => {
  vi.stubEnv('VITE_DESIGN_DYNAMIC_UNIFORMS', '1')
  const boundary = deviceBoundary()
  boundary.device.limits.minUniformBufferOffsetAlignment = 2048
  const driver = new WebGpuDriver(true)
  await expect((driver as any).initialize()).rejects.toThrow('1024-byte stride')
  expect(boundary.counts().submissions).toBe(0)
  driver.dispose(); expect(boundary.live.size).toBe(0)
})

test('completed epochs distinguish async finish, fences, rejected waits, abort and device loss', async () => {
  const { boundary, driver } = await createDriver(true)
  await driver.prepareScene(empty)
  const target = driver.create(8, 8)
  for (let i = 1; i <= 4; i++) {
    driver.begin(new Float32Array(0)); driver.clear(target)
    await driver.finish(target, empty.extent, 8, 8, false, undefined, false)
    expect(driver.resourceEpoch).toBe(i)
    expect(driver.completedResourceEpoch).toBe(i === 4 ? 4 : 0)
  }
  expect(driver.stats().queueWaits.reasons.periodic.completed).toBe(1)
  expect(driver.stats().queueWaits.pendingResourceEpochs).toBe(0)
  driver.begin(new Float32Array(0)); driver.clear(target)
  boundary.rejectWait(true)
  await expect(driver.checkpoint()).rejects.toThrow('completion rejection')
  expect(driver.completedResourceEpoch).toBe(4)
  boundary.rejectWait(false)
  await driver.checkpoint(); expect(driver.completedResourceEpoch).toBe(4)
  await driver.abortFrameAndReleaseFilterScratch(); expect(driver.completedResourceEpoch).toBe(5)
  driver.begin(new Float32Array(0)); driver.clear(target)
  boundary.device.destroy(); await Promise.resolve()
  expect(driver.lost).toBe(true)
  expect(() => driver.begin(new Float32Array(0))).toThrow('设备已丢失')
  expect(driver.stats().bindGroupCacheSize).toBe(0)
  driver.dispose()
})

async function kernelScenario(retained: boolean, displayFilters = true, coherentSamples = false, certified = false) {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', retained ? '1' : '0')
  const { boundary, driver } = await createDriver(false, true, certified)
  // Retaining roots requests the existing finish fence; no new wait is added.
  const scene: GpuScene = { ...empty, interactionRetained: true, displayFilters, coherentSamples, roots: ['blur'], nodes: { blur: {
    id: 'blur', previewDynamic: true, rect: empty.extent, matrix: [1, 0, 0, 1, 0, 0], inverse: [1, 0, 0, 1, 0, 0], size: [8, 8],
    fill: { rect: empty.extent, first: 0, count: 0, rule: 'evenodd' }, fills: [], strokes: [], children: [],
    mask: false, clip: false, opacity: 1, blend: 'normal',
    effects: [{ id: 'blur', kind: 'blur', visible: true, radius: 12.25, x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }],
  } } }
  const renderer = new GpuRenderer(driver, true, true)
  const frames = []
  for (let i = 0; i < 3; i++) frames.push(await renderer.render(scene, false, false))
  const uploaded = boundary.writes.map(bytes => [...bytes])
  const counts = boundary.counts(), passWords = boundary.records.map(record => record.words), normalized = boundary.normalized
  renderer.dispose()
  return { frames, counts, uploaded, passWords, normalized }
}
test('real renderer and upload/encoding boundaries reduce immutable uploads with unchanged coefficient bytes and commands', async () => {
  const before = await kernelScenario(false), after = await kernelScenario(true)
  expect(before.counts.textureUploads).toBe(3)
  expect(after.counts.textureUploads).toBe(frozenBaseline ? 3 : 1)
  expect(after.uploaded[0]).toEqual(before.uploaded[0])
  expect(before.uploaded.every(bytes => JSON.stringify(bytes) === JSON.stringify(after.uploaded[0]))).toBe(true)
  expect(after.passWords).toEqual(before.passWords)
  expect(after.normalized).toEqual(before.normalized)
  expect(after.counts.passCreates).toBe(before.counts.passCreates)
  expect(after.counts.waits).toBe(before.counts.waits)
  if (!frozenBaseline) {
    expect(after.frames.map(frame => frame.kernelBuilds)).toEqual([1, 0, 0])
    expect(after.frames.map(frame => frame.kernelResidentHits)).toEqual([0, 1, 1])
  }
  measurement({ scope: 'CPU production GpuRenderer + WebGpuDriver uploads; actual WASM/JS coefficients; no GPU pixels/timing', scenario: '3 identical display-blur frames; radius 24.5', commandTraceSha256: digest(before.normalized), before: before.counts, retained: after.counts })
})

test.each([{ coherent: false, certified: false }, { coherent: true, certified: true }])(
  'real exact-filter command traces retain channel write masks and sample order (coherent=$coherent, certified=$certified)', async ({ coherent, certified }) => {
  const before = await kernelScenario(false, false, coherent, certified)
  const after = await kernelScenario(true, false, coherent, certified)
  expect(before.counts.textureUploads).toBe((certified ? 2 : 1) * 3)
  expect(after.counts.textureUploads).toBe((certified ? 2 : 1) * (frozenBaseline ? 3 : 1))
  expect(after.normalized).toEqual(before.normalized)
  expect(after.uploaded.slice(0, certified ? 2 : 1)).toEqual(before.uploaded.slice(0, certified ? 2 : 1))
  expect(after.counts.passCreates).toBe(before.counts.passCreates)
  expect(after.counts.waits).toBe(before.counts.waits)
  measurement({ scope: 'CPU exact-filter production renderer/driver; no GPU pixels/timing', scenario: `3 exact-blur frames; radius 24.5; coherent=${coherent}; certified=${certified}`,
    commandTraceSha256: digest(before.normalized), before: before.counts, retained: after.counts })
})

test('an unfenced failed frame pins immutable kernels and the next frame reuses them safely', async () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', '1')
  const { boundary, driver } = await createDriver(false)
  const renderer = new GpuRenderer(driver) as any
  driver.begin(new Float32Array(0)); renderer.scene = empty
  const kernel = renderer.filterKernel('rational-tent', 8, () => rational_tent_kernel_rgba(8))
  await driver.prepareScene(empty)
  const target = driver.create(8, 8)
  driver.pass(target, parameters(empty.extent, empty.extent), [kernel.texture])
  boundary.rejectScope(true)
  await expect(driver.finish(target, empty.extent, 8, 8, false, undefined, false)).rejects.toThrow('validation failure')
  expect(driver.completedResourceEpoch).toBe(0)
  renderer.beginKernelFrame(); driver.begin(new Float32Array(0))
  const reused = renderer.filterKernel('rational-tent', 8, () => { throw Error('Must not rebuild immutable coefficients') })
  expect(reused.texture).toBe(kernel.texture)
  expect(renderer.kernelCache.evictCompleted(Infinity, driver.completedResourceEpoch)).toBe(0)
  boundary.rejectScope(false)
  await driver.abortFrameAndReleaseFilterScratch()
  renderer.beginKernelFrame()
  expect(renderer.kernelCache.evictCompleted(Infinity, driver.completedResourceEpoch)).toBe(kernel.texture.bytes)
  renderer.dispose(); expect(boundary.live.size).toBe(0)
})

test('kernel operator/domain changes miss, stale device owners do not leak, and pressure pins current reads', async () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', '1')
  const { boundary, driver } = await createDriver(false)
  const renderer = new GpuRenderer(driver) as any
  renderer.scene = empty
  driver.begin(new Float32Array(0))
  const radius = 24.5
  const exact = renderer.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius))
  const display = renderer.filterKernel('display-tent', radius, () => {
    const data = new Float32Array(256 * 4); displayFilterWeights(radius).forEach((v, i) => { data[i * 4] = v }); return data
  }, () => [256, 1])
  expect(display.texture).not.toBe(exact.texture)
  driver.hdr = true
  const hdr = renderer.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius))
  expect(hdr.texture).not.toBe(exact.texture)
  driver.hdr = false
  const uploaded = boundary.writes[0]
  expect([...new Float32Array(uploaded.buffer)]).toEqual([...Float32Array.from(rational_tent_kernel_rgba(radius), value => value / 255)])
  const retainedBytes = renderer.kernelCache.bytes
  expect(renderer.kernelCache.evictCompleted(retainedBytes, driver.completedResourceEpoch)).toBe(0)
  await driver.abortFrameAndReleaseFilterScratch()
  renderer.beginKernelFrame()
  expect(renderer.kernelCache.evictCompleted(retainedBytes, driver.completedResourceEpoch)).toBe(retainedBytes)
  expect(renderer.bytes).toBe(0)
  driver.begin(new Float32Array(0))
  const newExact = renderer.filterKernel('rational-tent', radius, () => rational_tent_kernel_rgba(radius))
  expect(newExact.texture).not.toBe(exact.texture)
  boundary.device.destroy(); await Promise.resolve()
  await expect(renderer.render(empty)).rejects.toThrow('设备已丢失')
  renderer.dispose(); expect(renderer.kernelCache.size).toBe(0)
})

test('denied cache admission stays in the shared ledger until an explicit completion', async () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', '1')
  const { boundary, driver } = await createDriver(false)
  const renderer = new GpuRenderer(driver) as any
  renderer.scene = empty
  renderer.kernelCache = new ImmutableKernelCache(0, 0, (texture: Texture) => renderer.forgetUpload(texture))
  await driver.prepareScene(empty); driver.begin(new Float32Array(0))
  const kernel = renderer.filterKernel('rational-tent', 8, () => rational_tent_kernel_rgba(8))
  const target = driver.create(8, 8)
  driver.pass(target, parameters(empty.extent, empty.extent), [kernel.texture])
  await driver.finish(target, empty.extent, 8, 8, false, undefined, false)
  renderer.beginKernelFrame()
  expect(renderer.retiredKernels).toHaveLength(1)
  expect(renderer.bytes).toBe(kernel.texture.bytes)
  expect((kernel.texture.resource as any).destroyed).toBe(false)
  await driver.abortFrameAndReleaseFilterScratch()
  renderer.reapRetiredKernels()
  expect(renderer.retiredKernels).toHaveLength(0)
  expect(renderer.bytes).toBe(0)
  expect((kernel.texture.resource as any).destroyed).toBe(true)
  renderer.dispose()
})

test('a driver without completion epochs keeps per-attempt ownership despite the retention flag', async () => {
  vi.stubEnv('VITE_DESIGN_KERNEL_CACHE', '1')
  const { boundary, driver } = await createDriver(false)
  ;(driver as any).resourceEpoch = undefined
  ;(driver as any).completedResourceEpoch = undefined
  const renderer = new GpuRenderer(driver) as any
  const first = renderer.filterKernel('rational-tent', 8, () => rational_tent_kernel_rgba(8))
  renderer.beginKernelFrame()
  const second = renderer.filterKernel('rational-tent', 8, () => rational_tent_kernel_rgba(8))
  expect(first.texture).not.toBe(second.texture)
  expect(renderer.kernelCache.size).toBe(0)
  expect(boundary.counts().textureUploads).toBe(2)
  renderer.dispose(); expect(boundary.live.size).toBe(0)
})

test('production queue telemetry preserves deferred checkpoint epochs and exports bounded snapshots', async () => {
  const { boundary, driver } = await createDriver(true)
  driver.begin(new Float32Array(0))
  boundary.holdWait()
  const wait = driver.checkpoint('admission')
  const pending = driver.stats().queueWaits
  expect(pending).toMatchObject({ pending: 1, resourceEpoch: 1, completedResourceEpoch: 0, pendingResourceEpochs: 1 })
  expect(pending.reasons.admission).toMatchObject({ started: 1, completed: 0, pending: 1 })
  boundary.releaseWait(); await wait
  expect(driver.completedResourceEpoch).toBe(0) // Current-frame reads may still follow.
  expect(driver.stats().queueWaits.reasons.admission).toMatchObject({ completed: 1, pending: 0 })
  boundary.rejectWait(true)
  await expect(driver.checkpoint('readback')).rejects.toThrow('completion rejection')
  expect(driver.stats().queueWaits.reasons.readback.rejected).toBe(1)
  expect(driver.completedResourceEpoch).toBe(0)
  boundary.rejectWait(false)
  await driver.abortFrameAndReleaseFilterScratch('cancel')
  const final = driver.stats().queueWaits
  expect(final.reasons.cancel.completed).toBe(1)
  expect(final.pendingResourceEpochs).toBe(0)
  expect(final.submitCalls).toBe(boundary.counts().submissions)
  expect(JSON.parse(JSON.stringify(final))).toEqual(final)
  driver.dispose()
})

test('interaction fence reason retains periodic short-circuit cadence and native opt-out', async () => {
  const { driver } = await createDriver(true)
  const target = driver.create(8, 8)
  const internals = driver as any
  const finish = async () => {
    driver.begin(new Float32Array(0)); driver.clear(target)
    await driver.finish(target, empty.extent, 8, 8, false, undefined, false)
  }
  // Set after begin: begin reads interaction flags from prepared scene state.
  const interactionFinish = async () => {
    driver.begin(new Float32Array(0)); driver.clear(target)
    internals.interactionPresentation = true
    await driver.finish(target, empty.extent, 8, 8, false, undefined, false)
  }
  await finish(); expect(internals.presentationSubmissions).toBe(1)
  await interactionFinish()
  expect(driver.stats().queueWaits.reasons.interaction.completed).toBe(1)
  expect(internals.presentationSubmissions).toBe(0)
  vi.stubEnv('VITE_DESIGN_NATIVE_PIPELINE', '1')
  internals.nativeInteractionPresentation = true
  await interactionFinish()
  expect(driver.stats().queueWaits.reasons.interaction.completed).toBe(1)
  expect(internals.presentationSubmissions).toBe(1)
  await driver.abortFrameAndReleaseFilterScratch()
  driver.dispose()
})


test('admission context rides the existing fence event without advancing completion early', async () => {
  const { boundary, driver } = await createDriver(true)
  const records: { event: string; fields: any }[] = []
  const metadata = { admissionKind: 1 as const, admissionPressure: 1 as const,
    admissionRequiredBytes: 4096, admissionWorkingBytes: 8192, admissionBudgetBytes: 10000,
    admissionReclaimableBytes: 2048, admissionPoolBytes: 1024, admissionPoolCount: 1,
    admissionUploadCount: 2, admissionImageCount: 3 }
  setGpuDiagnosticSink((event, fields) => records.push({ event, fields }))
  try {
    driver.begin(new Float32Array(0)); boundary.holdWait()
    const waiting = driver.checkpoint('admission', metadata)
    expect(records).toEqual([]); expect(driver.completedResourceEpoch).toBe(0)
    boundary.releaseWait(); await waiting
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'fence', fields: { ...metadata, reasonCode: 6 } })
    expect(driver.completedResourceEpoch).toBe(0)
    expect(driver.stats().queueWaits.reasons.admission.completed).toBe(1)
  } finally { setGpuDiagnosticSink(undefined); driver.dispose() }
})

test('completed pool proof preserves submission but does not wait or advance completion',async()=>{
  const {boundary,driver}=await createDriver(true)
  driver.begin(new Float32Array(0));await driver.checkpoint('admission')
  driver.begin(new Float32Array(0));await driver.checkpoint('admission')
  expect(driver.completedResourceEpoch).toBe(1)
  const before=driver.stats().queueWaits
  await driver.checkpoint('admission',undefined,1)
  const after=driver.stats().queueWaits
  expect(after.submitCalls).toBe(before.submitCalls+1)
  expect(after.reasons.admission.started).toBe(before.reasons.admission.started)
  expect(driver.completedResourceEpoch).toBe(1)
  for(const proof of [0,2,NaN,Infinity,1.5,-1]){
    const count=driver.stats().queueWaits.reasons.admission.started
    await driver.checkpoint('admission',undefined,proof)
    expect(driver.stats().queueWaits.reasons.admission.started).toBe(count+1)
  }
  const count=driver.stats().queueWaits.reasons.readback.started
  await driver.checkpoint('readback',undefined,1)
  expect(driver.stats().queueWaits.reasons.readback.started).toBe(count+1)
  boundary.rejectWait(true)
  await expect(driver.checkpoint('admission',undefined,2)).rejects.toThrow('completion rejection')
  boundary.rejectWait(false);await driver.checkpoint();driver.dispose()
})

test('pool completion proof leaves newly submitted work pending and does not bypass device loss',async()=>{
  const {boundary,driver}=await createDriver(true)
  driver.begin(new Float32Array(0));const old=driver.create(2,2);driver.clear(old);await driver.checkpoint('admission')
  driver.begin(new Float32Array(0));await driver.checkpoint('admission')
  const current=driver.create(2,2);driver.clear(current)
  const waits=boundary.counts().waits
  await driver.checkpoint('admission',undefined,1)
  expect(boundary.counts().waits).toBe(waits)
  expect(boundary.pending.has(current.resource as any)).toBe(true)
  driver.destroy(old)
  expect((old.resource as any).destroyed).toBe(true)
  expect((current.resource as any).destroyed).toBe(false)
  driver.lost=true
  await expect(driver.checkpoint('admission',undefined,1)).rejects.toThrow('设备已丢失')
  driver.lost=false;await driver.checkpoint();driver.destroy(current);driver.dispose()
})

// Lifecycle observations must not alter real production descriptor/queue traces.
test('device diagnostics off/on/throwing preserve production command sequence and queue counts',async()=>{
  const outputs:{trace:object[];counts:ReturnType<ReturnType<typeof deviceBoundary>['counts']>}[]=[]
  for(const mode of ['off','on','throwing']){
    setGpuDiagnosticSink(mode==='off'?undefined:()=>{if(mode==='throwing')throw Error('diagnostic observer failure')})
    try{
      const {boundary,driver}=await createDriver(true)
      await driver.prepareScene(empty);driver.begin(new Float32Array(0))
      const target=driver.create(8,8),source=driver.create(8,8)
      driver.pass(target,parameters(empty.extent,empty.extent),[source]);await driver.checkpoint('checkpoint')
      outputs.push({trace:boundary.normalized,counts:boundary.counts()});driver.dispose()
      await Promise.resolve()
    }finally{setGpuDiagnosticSink(undefined)}
  }
  expect(outputs[1]).toEqual(outputs[0]);expect(outputs[2]).toEqual(outputs[0])
})
test('production lost callback is numeric, nonthrowing and keeps existing disposed suppression',async()=>{
  const records:{event:string;fields:any}[]=[]
  setGpuDiagnosticSink((event,fields)=>records.push({event,fields}))
  try{
    const {boundary,driver}=await createDriver(true)
    const created=records.find(row=>row.event==='device-lifecycle'&&row.fields.devicePhase===1)!
    boundary.device.destroy();await Promise.resolve()
    expect(driver.lost).toBe(true)
    expect(records.find(row=>row.event==='device-lifecycle'&&row.fields.devicePhase===3)?.fields)
      .toMatchObject({deviceIncarnation:created.fields.deviceIncarnation,deviceLostReason:2,deviceCallbackDisposition:1,deviceCounterMask:0})
    expect(JSON.stringify(records)).not.toContain('Injected device loss')
    driver.dispose()
    records.length=0
    const second=await createDriver(true);second.driver.dispose();await Promise.resolve()
    expect(second.driver.lost).toBe(false) // existing intentional destroyed+disposed early return
    expect(records.find(row=>row.event==='device-lifecycle'&&row.fields.devicePhase===4)?.fields.deviceCallbackDisposition).toBe(2)
  }finally{setGpuDiagnosticSink(undefined)}
})
test('delayed fence retains initiating request, identity and start epochs despite another current device',async()=>{
  let activeRequest = 74
  setDeviceDiagnosticRequestContext(() => activeRequest)
  const records:{event:string;fields:any}[]=[]
  setGpuDiagnosticSink((event,fields)=>records.push({event,fields}))
  try{
    const first=await createDriver(true);first.driver.begin(new Float32Array(0));first.boundary.holdWait()
    const pending=first.driver.checkpoint('admission'),firstId=records.find(row=>row.event==='device-lifecycle')!.fields.deviceIncarnation
    activeRequest = 75
    const second=await createDriver(true)
    first.boundary.releaseWait();await pending
    const row=records.filter(row=>row.event==='fence'&&row.fields.reasonCode===6).at(-1)!
    expect(row.fields).toMatchObject({requestId:74,deviceIncarnation:firstId,deviceFenceResourceEpoch:1,deviceFenceCompletedResourceEpoch:0})
    expect(first.driver.completedResourceEpoch).toBe(0)
    first.driver.dispose();second.driver.dispose()
  }finally{setGpuDiagnosticSink(undefined)}
})
test('same-device park/revive preserves lifecycle incarnation without another creation event',async()=>{
  const records:{event:string;fields:any}[]=[]
  setGpuDiagnosticSink((event,fields)=>records.push({event,fields}))
  let driver:WebGpuDriver|undefined
  try{
    const made=await createDriver(true);driver=made.driver;(driver as any).poolKey='diagnostic-test'
    const created=records.find(row=>row.event==='device-lifecycle'&&row.fields.devicePhase===1)!.fields.deviceIncarnation
    driver.dispose()
    const revived=await (WebGpuDriver as any).reviveParked('diagnostic-test')
    expect(revived).toBe(driver)
    expect(records.filter(row=>row.event==='device-lifecycle'&&row.fields.devicePhase===1)).toHaveLength(1)
    expect(records.filter(row=>row.event==='device-lifecycle'&&[5,6,7].includes(row.fields.devicePhase)).map(row=>row.fields.deviceIncarnation)).toEqual([created,created,created])
  }finally{if(driver)(driver as any).destroyDeviceNow();setGpuDiagnosticSink(undefined)}
})

test('actual driver park and revive preserve the same presenter payload ledger and reservations', async()=>{
  const made=await createDriver(true),driver=made.driver,device=(driver as any).device
  device.createRenderPipeline=(descriptor:any)=>descriptor
  device.createSampler=()=>({})
  const context={configure(){},unconfigure(){}}
  const canvas={width:16,height:16,getContext:()=>context} as unknown as OffscreenCanvas
  driver.attachPresenter(canvas,()=>{})
  const presenter=(driver as any).presenter,payload=presenter.payload
  presenter.capture(16,16)
  const output=payload.reserve(256,'capture'),before=presenter.payloadStats
  ;(driver as any).poolKey='payload-park-revive'
  try {
    driver.dispose()
    expect((driver as any).presenter).toBe(presenter)
    const revived=await (WebGpuDriver as any).reviveParked('payload-park-revive')
    expect(revived).toBe(driver);expect((driver as any).presenter.payload).toBe(payload)
    expect(presenter.payloadStats).toEqual(before)
    payload.cancel(output)
  } finally { (driver as any).destroyDeviceNow() }
})
