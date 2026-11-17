import { expect, test } from 'vitest'
import { WebGpuDriver } from './webgpu'
import type { GpuScene } from './types'

const empty: GpuScene = {
  version: 8, width: 8, height: 8, output: { x: 0, y: 0, w: 8, h: 8 },
  extent: { x: 0, y: 0, w: 8, h: 8 }, floatCompositing: true, coherentSamples: false, integratedBlur: true,
  background: '#ffffff', transparent: false, grid: false, view: { x: 0, y: 0, zoom: 1 }, roots: [], nodes: {}, vertices: [],
}

function deviceBoundary() {
  let next = 0, submissions = 0, waits = 0
  const pending = new Set<object>()
  let finishWait: (() => void) | undefined
  const resource = (extra: object = {}) => {
    const value = { id: ++next, destroyed: false, ...extra, destroy() { value.destroyed = true; pending.delete(value) } }
    return value
  }
  const device: any = {
    features: new Set(),
    limits: { maxTextureDimension2D: 16384, minUniformBufferOffsetAlignment: 256 },
    lost: new Promise(() => {}),
    addEventListener() {},
    createShaderModule: (descriptor: object) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (descriptor: any) => descriptor,
    createPipelineLayout: (descriptor: any) => descriptor,
    createRenderPipelineAsync: async (descriptor: any) => descriptor,
    createBuffer: ({ size }: { size: number }) => resource({ size, data: new Uint8Array(size) }),
    createTexture: ({ size, format }: { size: number[]; format: string }) => {
      const value = resource({ width: size[0], height: size[1], format }) as any
      value.createView = () => ({ texture: value })
      return value
    },
    createBindGroup: ({ layout, entries }: any) => ({ layout, entries }),
    createCommandEncoder() {
      const resources = new Set<object>()
      return {
        copyTextureToTexture() {},
        beginRenderPass() {
          return { setPipeline() {}, setBindGroup() {}, setScissorRect() {}, setVertexBuffer() {}, setStencilReference() {}, draw() {}, end() {} }
        },
        finish() { return { resources } },
      }
    },
    pushErrorScope() {},
    async popErrorScope() { return null },
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() { submissions++ },
      async onSubmittedWorkDone() {
        waits++
        if (finishWait) await new Promise<void>(resolve => { finishWait = resolve })
        pending.clear()
      },
    },
    destroy() {},
  }
  const context = { configure() {}, getConfiguration: () => ({ toneMapping: { mode: 'standard' } }) }
  return {
    device, context,
    counts: () => ({ submissions, waits }),
    holdWait() { finishWait = () => {} },
    releaseWait() { const resolve = finishWait; finishWait = undefined; resolve?.() },
  }
}

test('held zoom-focus completion submits the next crop before the previous scope resolves', async () => {
  const boundary = deviceBoundary()
  viStub(boundary)
  const driver = new WebGpuDriver(true, false, true, false)
  await (driver as any).initialize()
  const captures: { destroy(): void }[] = []
  Object.assign(driver, {
    captureDisplay: true,
    presenter: {
      capture(width: number, height: number) {
        const texture = boundary.device.createTexture({ size: [width, height], format: 'bgra8unorm' })
        captures.push(texture)
        return { id: captures.length, texture }
      },
      release() {},
      diagnosticFields: () => ({}),
      dispose() { for (const texture of captures) texture.destroy() },
    },
  })
  let releaseScope!: () => void
  const scopeGate = new Promise<void>(resolve => { releaseScope = resolve })
  let pops = 0
  boundary.device.popErrorScope = async () => {
    pops += 1
    await scopeGate
    return null
  }
  const scopeStarted = performance.now()
  const submittedBefore = boundary.counts().submissions
  const waitsBefore = boundary.counts().waits
  const target = driver.create(8, 8)
  driver.holdCapturedCompletion = true
  const finish = () => {
    driver.begin(new Float32Array(0))
    driver.clear(target)
    return driver.finish(target, empty.extent, 8, 8, false, undefined, true)
  }
  try {
    const first = finish()
    const second = finish()
    expect(pops).toBe(2)
    expect(performance.now() - scopeStarted).toBeLessThan(20)
    expect(boundary.counts().waits).toBe(waitsBefore)
    expect(boundary.counts().submissions - submittedBefore).toBeGreaterThanOrEqual(2)
    await expect(first).resolves.toMatchObject({ gpuTile: 1 })
    await expect(second).resolves.toMatchObject({ gpuTile: 2 })
    expect(boundary.counts().waits).toBe(waitsBefore)
    expect(driver.completedResourceEpoch).toBe(0)
    let flushed = false
    const done = driver.flushHeldCompletion().then(() => { flushed = true })
    await Promise.resolve()
    expect(flushed).toBe(false)
    expect(boundary.counts().waits).toBe(waitsBefore)
    releaseScope()
    await done
    expect(flushed).toBe(true)
    expect(boundary.counts().waits).toBe(waitsBefore + 1)
    expect(driver.completedResourceEpoch).toBeGreaterThan(0)
  } finally {
    driver.holdCapturedCompletion = false
    releaseScope()
    await driver.flushHeldCompletion().catch(() => undefined)
    await driver.abortFrameAndReleaseFilterScratch('cancel')
    driver.dispose()
  }
})

test('held crops pay for one scope delay where separate finishes pay for each', async () => {
  const delayMs = 30
  const run = async (hold: boolean) => {
    const boundary = deviceBoundary()
    viStub(boundary)
    const driver = new WebGpuDriver(true, false, true, false)
    await (driver as any).initialize()
    Object.assign(driver, {
      captureDisplay: true,
      presenter: {
        capture(width: number, height: number) {
          const texture = boundary.device.createTexture({ size: [width, height], format: 'bgra8unorm' })
          return { id: 1, texture }
        },
        release() {}, diagnosticFields: () => ({}), dispose() {},
      },
    })
    boundary.device.popErrorScope = async () => {
      await new Promise(resolve => setTimeout(resolve, delayMs))
      return null
    }
    const target = driver.create(8, 8)
    driver.holdCapturedCompletion = hold
    const finish = () => {
      driver.begin(new Float32Array(0))
      driver.clear(target)
      return driver.finish(target, empty.extent, 8, 8, false, undefined, true)
    }
    const started = performance.now()
    try {
      await finish()
      await finish()
      if (hold) await driver.flushHeldCompletion()
      return performance.now() - started
    } finally {
      driver.holdCapturedCompletion = false
      await driver.flushHeldCompletion().catch(() => undefined)
      await driver.abortFrameAndReleaseFilterScratch('cancel')
      driver.dispose()
    }
  }
  const serial = await run(false)
  const overlapped = await run(true)
  expect(serial).toBeGreaterThanOrEqual(delayMs * 2)
  expect(overlapped).toBeLessThan(serial * 0.75)
  expect(overlapped).toBeGreaterThanOrEqual(delayMs)
})

function viStub(boundary: ReturnType<typeof deviceBoundary>) {
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true })
  define('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  define('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  define('GPUBufferUsage', { UNIFORM: 1, STORAGE: 2, COPY_SRC: 4, COPY_DST: 8, VERTEX: 16 })
  define('OffscreenCanvas', class { constructor(readonly width: number, readonly height: number) {} getContext() { return boundary.context } })
  define('navigator', { gpu: { requestAdapter: async () => ({ features: new Set(), requestDevice: async () => boundary.device }), getPreferredCanvasFormat: () => 'rgba8unorm' } })
}
