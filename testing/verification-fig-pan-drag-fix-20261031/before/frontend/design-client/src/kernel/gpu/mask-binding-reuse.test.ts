import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { GpuBindingCache } from './binding-cache'
import type { PathMesh, Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function fixture(limit = 2048) {
  vi.stubGlobal('OffscreenCanvas', class {})
  const bindings: GPUBindGroup[] = [], draws: number[][] = []
  const createBindGroup = vi.fn((descriptor: GPUBindGroupDescriptor) => ({ ...descriptor }) as unknown as GPUBindGroup)
  const resource = { createView: () => ({}) } as GPUTexture
  const texture = { width: 32, height: 32, bytes: 4096, resource } as Texture
  const driver = new WebGpuDriver(true)
  const cache = new GpuBindingCache(limit)
  // Exercise production mask() and uniform() with deterministic API contracts.
  // No real device, shader execution or pixel/performance claim is involved.
  Object.assign(driver, {
    device: { createBindGroup }, bindingCache: cache, uniforms: {}, maskLayout: {}, vertices: {},
    maskPipelines: new Map([['nonzero', {}]]), maskCover: {},
    maskBuffer: () => ({ color: resource, depth: resource, high: texture, low: texture }),
    pass: vi.fn(), encoder: { beginRenderPass: () => ({
      setBindGroup: (_: number, bind: GPUBindGroup) => bindings.push(bind),
      setPipeline() {}, setVertexBuffer() {}, setStencilReference() {},
      draw: (...args: number[]) => draws.push(args), end() {},
    }) },
  })
  const path: PathMesh = { rect: { x: 0, y: 0, w: 32, h: 32 }, first: 3, count: 6, rule: 'nonzero' }
  const frame = () => { Object.assign(driver, { offset: 0, uploadedOffset: 0 }); cache.begin(); driver.mask(path, texture) }
  const bytes = () => Array.from(new Uint32Array((driver as unknown as { uniformData: Float32Array }).uniformData.buffer, 0, 256))
  return { driver, cache, texture, path, frame, bytes, bindings, draws, createBindGroup }
}

test('repeated MSAA mask frames reuse descriptors but preserve every uniform bit and draw', () => {
  vi.stubEnv('VITE_DESIGN_BINDING_CACHE', '0')
  const baseline = fixture(); baseline.frame(); const expected = baseline.bytes(); baseline.frame()
  expect(baseline.createBindGroup).toHaveBeenCalledTimes(2)
  vi.stubEnv('VITE_DESIGN_BINDING_CACHE', '1')
  const cached = fixture(); cached.frame(); cached.frame()
  expect(cached.createBindGroup).toHaveBeenCalledTimes(1)
  expect(cached.bindings[0]).toBe(cached.bindings[1])
  expect(cached.bytes()).toEqual(expected)
  expect(cached.draws).toEqual(baseline.draws)
  expect(cached.cache.groupHits).toBe(1)
})

test('mask bindings keep fixed offsets even with dynamic compositor bindings', () => {
  const f = fixture(); Object.assign(f.driver, { dynamicUniformBindings: true })
  f.frame(); f.driver.mask(f.path, f.texture)
  const descriptors = f.createBindGroup.mock.calls.map(([d]) => Array.from(d.entries)[0].resource)
  expect(descriptors).toMatchObject([{ offset: 0, size: 1024 }, { offset: 1024, size: 1024 }])
  expect(f.bindings[0]).not.toBe(f.bindings[1])
  f.frame(); expect(f.bindings[2]).toBe(f.bindings[0])
})

test('replacement uniform buffers and device-generation revocation never reuse stale groups', () => {
  const f = fixture(); f.frame()
  Object.assign(f.driver, { uniforms: {} }); f.frame()
  expect(f.bindings[1]).not.toBe(f.bindings[0])
  // Run the actual loss handler: it must revoke descriptors before releasing
  // physical frame resources, including a still-pending GPU submission.
  const release = vi.fn(() => expect(f.cache.size).toBe(0))
  Object.assign(f.driver, { releaseFrameResources: release })
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  ;(f.driver as unknown as { releaseLostResources(): void }).releaseLostResources()
  expect(release).toHaveBeenCalledOnce()
  f.frame()
  expect(f.bindings[2]).not.toBe(f.bindings[1])
  expect(f.cache.size).toBe(1)
  // These groups retain only layout + live arena buffer, never mask scratch
  // textures or vertex buffers that can be destroyed after a submission.
  const descriptor = f.createBindGroup.mock.calls.at(-1)![0]
  expect(Array.from(descriptor.entries)).toHaveLength(1)
  expect(Array.from(descriptor.entries)[0].resource).toMatchObject({ offset: 0, size: 1024 })
})

test('shared LRU bound evicts descriptors without destroying GPU resources or pending commands', () => {
  const f = fixture(1); f.frame(); const pendingGroup = f.bindings[0]
  f.driver.mask(f.path, f.texture)
  expect(f.cache.size).toBe(1)
  f.frame()
  expect(f.createBindGroup).toHaveBeenCalledTimes(3)
  expect(f.bindings[2]).not.toBe(pendingGroup)
  // Previously encoded passes retain their original descriptor; eviction only
  // removes the cache reference and cannot mutate submitted resources.
  expect(f.bindings[0]).toBe(pendingGroup)
})
