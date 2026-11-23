// Production WebGPU queue ordering. No device, pixels, or frame timing.
import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import type { Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

function fixture(managed = true) {
  vi.stubGlobal('OffscreenCanvas', class {})
  vi.stubEnv('VITE_DESIGN_BINDING_CACHE', '0')
  const order: string[] = []
  const page = { width: 8, height: 8, bytes: 1024, resource: { label: 'atlas-page' } } as Texture
  const blank = { width: 1, height: 1, bytes: 16, resource: { label: 'blank' } } as Texture
  const encoder = () => ({ finish: () => { order.push('finish'); return {} } })
  const driver = new WebGpuDriver(managed)
  Object.assign(driver, {
    device: {
      createBindGroup: () => ({}),
      createCommandEncoder: encoder,
      queue: { writeTexture() { order.push('write') } },
    },
    encoder: encoder(),
    bindingCache: { view: () => ({}), group: (_key: unknown, _offset: unknown, create: () => GPUBindGroup) => create() },
    blank, layout: {}, curves: {}, uniforms: {},
    uploadUniforms() {}, closeOver() {},
    submitQueue() { order.push('queue') },
  })
  return { driver, page, blank, order }
}

function sample(driver: WebGpuDriver, blank: Texture, page: Texture) {
  ;(driver as unknown as { bind(u: Float32Array, inputs: Texture[]): void }).bind(new Float32Array(256), [blank, page, blank])
}

test('an atlas slot write submits the encoder that already samples that page', () => {
  const { driver, page, blank, order } = fixture()
  sample(driver, blank, page)
  expect((driver as unknown as { unsubmittedTextures: Set<GPUTexture> }).unsubmittedTextures.has(page.resource as GPUTexture)).toBe(true)
  driver.uploadAtlasLinear(page, 1, 1, 1, 1, new Float32Array([0.2, 0.4, 0.6, 1]))
  expect(order).toEqual(['finish', 'queue', 'write'])
  order.length = 0
  driver.uploadAtlasLinear(page, 3, 1, 1, 1, new Float32Array([0.1, 0.2, 0.3, 1]))
  expect(order).toEqual(['write'])
  sample(driver, blank, page)
  driver.uploadAtlasRgba8(page, 5, 1, 1, 1, new Uint8Array([9, 8, 7, 255]))
  expect(order).toEqual(['write', 'finish', 'queue', 'write'])
})

test('a page this encoder has not sampled is written without a submit', () => {
  const { driver, page, order } = fixture()
  Object.assign(driver, { drawCalls: 6, submittedDrawCalls: 1 })
  const submit = vi.spyOn(driver as unknown as { submitCommands(): void }, 'submitCommands')
  driver.uploadAtlasLinear(page, 0, 0, 2, 1, new Float32Array(8))
  expect(submit).not.toHaveBeenCalled()
  expect(order).toEqual(['write'])
})

test('byte atlas admission uses the same fence and a fresh page does not', () => {
  const { driver, page, blank, order } = fixture(false)
  driver.uploadAtlasRgba8(page, 0, 0, 1, 1, new Uint8Array([1, 2, 3, 4]))
  expect(order).toEqual(['write'])
  sample(driver, blank, page)
  driver.uploadAtlasRgba8(page, 2, 0, 1, 1, new Uint8Array([5, 6, 7, 8]))
  expect(order).toEqual(['write', 'finish', 'queue', 'write'])
})
