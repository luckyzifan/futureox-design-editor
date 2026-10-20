import { afterEach, expect, test, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { parameters, type Texture } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function fixture(filterable: boolean) {
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2 })
  vi.stubGlobal('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} })
  const passes: unknown[] = []
  const device = {
    features: new Set(filterable ? ['float32-filterable'] : []),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label, getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: (descriptor: unknown) => descriptor,
    createPipelineLayout: ({ bindGroupLayouts }: { bindGroupLayouts: unknown[] }) => {
      if (bindGroupLayouts.some(layout => !layout)) throw new TypeError('Missing bind group layout')
      return bindGroupLayouts
    },
    createRenderPipelineAsync: async (descriptor: { fragment: { module: { label: string } } }) => ({ label: descriptor.fragment.module.label }),
    createSampler: vi.fn(() => ({ kind: 'sampler' })),
    createBindGroup: vi.fn(({ layout, entries }: GPUBindGroupDescriptor) => {
      for (const entry of entries) {
        if (!entry.resource) throw new TypeError('Required member is undefined')
        if ('createView' in entry.resource) throw new TypeError('Texture binding requires a GPUTextureView')
      }
      if (!layout) throw new TypeError('Missing bind group layout')
      return { layout, entries }
    }),
  }
  const texture = (): Texture => ({ width: 32, height: 32, bytes: 32 * 32 * 16,
    resource: { createView: () => ({ kind: 'view' }) } as unknown as GPUTexture })
  // Validate production dispatch and WebGPU resource descriptors without
  // replacing the shader contract with assertions on source text.
  const driver = Object.assign(new WebGpuDriver(true), {
    managed: true, displayFilters: true, pairDisplayTaps: false, device, layout: {}, uniforms: {}, curves: {},
    uniform: () => ({ buffer: {} }), blank: texture(), modePipelines: new Map([[6, { label: 'Exact shadow' }]]),
    filterPipelines: [], drawCalls: 0, timingRows: [],
    encoder: { beginRenderPass: () => ({ setPipeline: (pipeline: unknown) => passes.push(pipeline),
      setBindGroup() {}, draw() {}, end() {} }) },
  }) as WebGpuDriver
  return { driver, device, passes, texture }
}

test.each([false, true])('preview then settled shadows retain the compositor contract (filterable=%s)', async filterable => {
  const { driver, passes, texture } = fixture(filterable)
  await driver.prepareFilters()
  const u = parameters({ x: 0, y: 0, w: 32, h: 32 })
  u[16] = 6
  // Imported shadows used to populate these spare lanes, which accidentally
  // selected the unrelated canvas-chrome shader after filter preparation.
  u[44] = 1; u[48] = 16; u[59] = 1; u[60] = 1
  for (const preview of [true, false]) {
    Object.assign(driver, { displayFilters: preview })
    expect(() => driver.pass(texture(), u, [texture(), texture()])).not.toThrow()
    expect(passes.at(-1)).toEqual({ label: 'Exact shadow' })
  }
})

test('ordinary canvas preparation compiles no experimental shadow or chrome programs', async () => {
  const { driver, device } = fixture(true)
  Object.assign(driver, { pairDisplayTaps: true })
  await driver.prepareFilters()
  const labels = device.createShaderModule.mock.calls.map(([descriptor]) => descriptor.label)
  expect(labels.sort()).toEqual(['Canvas integrated tent', 'Paired integrated display filter'].sort())
})

test('integrated paired display binds source and kernel views with its initialized sampler', async () => {
  const { driver, device, passes, texture } = fixture(true)
  Object.assign(driver, { pairDisplayTaps: true })
  await driver.prepareFilters()
  const u = parameters({ x: 0, y: 0, w: 32, h: 32 })
  u[16] = 22; u[36] = 4
  expect(() => driver.pass(texture(), u, [texture(), texture()])).not.toThrow()
  expect(passes.at(-1)).toEqual({ label: 'Paired integrated display filter' })
  const descriptor = device.createBindGroup.mock.calls.at(-1)![0]
  expect(Array.from(descriptor.entries).map(entry => entry.resource)).toEqual([
    { buffer: {} }, { kind: 'sampler' }, { kind: 'view' }, { kind: 'view' },
  ])
})

test.each([false, true])('retired prototype flags cannot divert integrated filtering (filterable=%s)', async filterable => {
  const { driver, device, passes, texture } = fixture(filterable)
  Object.assign(driver, { pairDisplayTaps: true })
  await driver.prepareFilters()
  const u = parameters({ x: 0, y: 0, w: 32, h: 32 })
  u[16] = 22; u[36] = 4; u[40] = 8; u[45] = 1
  expect(() => driver.pass(texture(), u, [texture(), texture()])).not.toThrow()
  expect(passes.at(-1)).toEqual({ label: 'Canvas integrated tent' })
  const labels = device.createShaderModule.mock.calls.map(([descriptor]) => descriptor.label)
  expect(labels.sort()).toEqual((filterable
    ? ['Canvas integrated tent', 'Paired integrated display filter']
    : ['Canvas integrated tent']).sort())
})

test('paired display fallback remains complete and does not repeatedly rebuild a failed program', async () => {
  const { driver, device, passes, texture } = fixture(true)
  Object.assign(driver, { pairDisplayTaps: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  device.createSampler.mockImplementationOnce(() => { throw Error('Unavailable sampler') })
  await driver.prepareFilters()
  const u = parameters({ x: 0, y: 0, w: 32, h: 32 }); u[16] = 22; u[36] = 64
  driver.pass(texture(), u, [texture(), texture()])
  expect(passes.at(-1)).toEqual({ label: 'Canvas integrated tent' })
  await driver.prepareFilters()
  expect(device.createSampler).toHaveBeenCalledTimes(1)
})
