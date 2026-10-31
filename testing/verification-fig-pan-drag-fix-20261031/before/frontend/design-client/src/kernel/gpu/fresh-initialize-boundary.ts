import { afterEach, beforeEach, expect, vi } from 'vitest'
import { WebGpuDriver } from './webgpu'
import { renderFailureFields } from '../render-failure-telemetry'
import { kernelBoundsCalls } from '../picking-boundary'
import { setGpuDiagnosticSink } from '../../../../design-desktop/src/render-terminal-diagnostics.mjs'

// Adapted ZIP public-API fixture; only the GPU/browser boundary is mocked.
vi.mock('../picking', () => import('../picking-boundary'))
// No replacement of production methods, fields, registries, or maps.
// In particular, device.lost is an untouched native Promise. No extra lost
// subscriber or wrapped .then is installed, including in the gap fixture.
export type SinkMode = 'off' | 'ordinary' | 'throwing' | 'gap-loss' | 'gap-no-loss'
type Event = 'configured' | 'fence-enter' | 'fence-fulfilled' | 'fence-rejected' |
  'loss-resolved' | 'loss-callback-event' | 'texture-destroy' | 'device-destroy' |
  'gap-anchor' | 'gap-job' | 'public-fulfilled' | 'public-rejected'
type Outcome = { ok: true; value: WebGpuDriver } | { ok: false; error: unknown }
export const nextTurn = () => new Promise<void>(resolve => setTimeout(resolve, 0))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const boundaries: Boundary[] = []
export type Boundary = {
  device: any; counts: Record<'adapter' | 'device' | 'configure' | 'fences' | 'submits' | 'deviceDestroy' |
    'textures' | 'textureDestroy' | 'buffers' | 'bufferDestroy' | 'draws' | 'pipelines' |
    'sinkCalls' | 'sinkThrows' | 'callbackEvents' | 'gapAnchors' | 'gapJobs', number>
  owners: Set<WebGpuDriver>; order: Partial<Record<Event, number>>; mark(event: Event): void
  resolveLoss(message?: string): void; fulfillFence(): void; rejectFence(error: unknown): void
  fenceState(): number; lossResolved(): boolean; configuredOwnDevice(): boolean
}
export function deviceBoundary(mode: SinkMode = 'off', holdFirstFence = true): Boundary {
  const loss = deferred<{ reason: string; message: string }>(), fence = deferred<void>()
  const order: Partial<Record<Event, number>> = {}
  let sequence = 0, lossResolved = false, fenceState = 0
  const mark = (event: Event) => { const at = ++sequence; if (order[event] === undefined) order[event] = at }
  const counts = { adapter: 0, device: 0, configure: 0, fences: 0, submits: 0, deviceDestroy: 0,
    textures: 0, textureDestroy: 0, buffers: 0, bufferDestroy: 0, draws: 0, pipelines: 0,
    sinkCalls: 0, sinkThrows: 0, callbackEvents: 0, gapAnchors: 0, gapJobs: 0 }
  const owners = new Set<WebGpuDriver>()
  function resolveLoss(message = 'controlled fresh initialization loss') {
    if (lossResolved) return
    lossResolved = true; mark('loss-resolved')
    loss.resolve({ reason: 'unknown', message })
  }
  function fulfillFence() {
    if (fenceState !== 0) return
    fenceState = 1
    // Undefined is not thenable: this settles the native Promise immediately.
    // Its registered production reactions still run later, without a new shim.
    fence.resolve(undefined); mark('fence-fulfilled')
  }
  function rejectFence(error: unknown) {
    if (fenceState !== 0) return
    fenceState = 2; fence.reject(error); mark('fence-rejected')
  }
  const device: any = {
    features: new Set(), limits: { maxTextureDimension2D: 16384, minUniformBufferOffsetAlignment: 256 },
    lost: loss.promise, addEventListener() {},
    destroy() {
      counts.deviceDestroy++; mark('device-destroy')
      if (!lossResolved) {
        lossResolved = true; mark('loss-resolved')
        loss.resolve({ reason: 'destroyed', message: 'boundary destruction' })
      }
    },
    createShaderModule: (descriptor: object) => ({ ...descriptor, getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: (descriptor: object) => descriptor,
    createPipelineLayout: (descriptor: object) => descriptor,
    createRenderPipelineAsync: (descriptor: object) => Promise.resolve().then(() => ({ ...descriptor, boundaryId: ++counts.pipelines })),
    createBuffer({ size }: { size: number }) {
      counts.buffers++; let destroyed = false
      return { size, destroy() { if (!destroyed) { destroyed = true; counts.bufferDestroy++ } } }
    },
    createTexture({ size, format }: { size: number[]; format: string }) {
      counts.textures++; let destroyed = false
      const texture = { width: size[0], height: size[1], format,
        destroy() { if (!destroyed) { destroyed = true; counts.textureDestroy++; mark('texture-destroy') } },
        createView() { return { texture } } }
      return texture
    },
    createBindGroup: (descriptor: object) => descriptor,
    createCommandEncoder: () => ({
      beginRenderPass() {
        let pipeline: unknown
        return { setPipeline(value: unknown) { expect(value !== undefined).toBe(true); pipeline = value },
          setBindGroup() {}, setScissorRect() {}, setVertexBuffer() {}, setStencilReference() {},
          draw() { expect(pipeline !== undefined).toBe(true); counts.draws++ }, end() {} }
      },
      finish: () => ({}),
    }),
    pushErrorScope() {}, popErrorScope: async () => null,
    queue: { writeBuffer() {}, submit() { counts.submits++ }, onSubmittedWorkDone() {
      counts.fences++; mark('fence-enter')
      if (counts.fences === 1) {
        if (!holdFirstFence) fulfillFence()
        return fence.promise
      }
      return Promise.resolve()
    } },
  }
  let configuredDevice: unknown
  const context = {
    configure(input: { device: unknown }) { counts.configure++; configuredDevice = input.device; mark('configured') },
    getConfiguration: () => ({ toneMapping: { mode: 'standard' } }),
  }
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 })
  vi.stubGlobal('GPUTextureUsage', { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2, COPY_SRC: 4, COPY_DST: 8 })
  vi.stubGlobal('GPUBufferUsage', { UNIFORM: 1, STORAGE: 2, COPY_SRC: 4, COPY_DST: 8, VERTEX: 16 })
  vi.stubGlobal('OffscreenCanvas', class {
    constructor(readonly width: number, readonly height: number) {}
    getContext() { return context }
  })
  vi.stubGlobal('navigator', { gpu: {
    requestAdapter: async () => { counts.adapter++; return { features: new Set(),
      requestDevice: async () => { counts.device++; return device } } },
    getPreferredCanvasFormat: () => 'rgba8unorm',
  } })
  let diagnosticOwner: number | undefined, gapScheduled = false
  const sinkError = new Error('FreshInitializeThrowingDiagnosticSink')
  setGpuDiagnosticSink(mode === 'off' ? undefined : (event: string, value: unknown) => {
    const fields = value as Record<string, number>
    counts.sinkCalls++
    if (event === 'device-lifecycle' && fields.devicePhase === 1) diagnosticOwner = fields.deviceOwner
    if (fields.deviceOwner === diagnosticOwner) {
      if (event === 'device-lifecycle' && fields.devicePhase === 3 && fields.deviceCallbackDisposition === 1) {
        counts.callbackEvents++; mark('loss-callback-event')
      }
      if ((mode === 'gap-loss' || mode === 'gap-no-loss') && event === 'fence' && fields.reasonCode === 9 &&
          fields.deviceFencePhase === 2 && fields.deviceFenceOutcome === 1 && !gapScheduled) {
        gapScheduled = true; counts.gapAnchors++; mark('gap-anchor')
        // Direct public synchronous sink, not an aggregated logger. Exactly one
        // microtask and no await: R resolves loss, queuing L behind initialize I.
        queueMicrotask(() => { counts.gapJobs++; mark('gap-job'); if (mode === 'gap-loss') resolveLoss() })
      }
    }
    if (mode === 'throwing') { counts.sinkThrows++; throw sinkError }
  })
  const boundary = { device, counts, owners, order, mark, resolveLoss, fulfillFence, rejectFence,
    fenceState: () => fenceState, lossResolved: () => lossResolved,
    configuredOwnDevice: () => configuredDevice === device }
  boundaries.push(boundary)
  return boundary
}
export function startCreate(boundary: Boundary) {
  let settled = false
  // Attach both handlers immediately to the actual public create promise.
  const result: Promise<Outcome> = WebGpuDriver.create(true, false, true, false).then(value => {
    settled = true; boundary.owners.add(value); boundary.mark('public-fulfilled')
    return { ok: true as const, value }
  }, error => { settled = true; boundary.mark('public-rejected'); return { ok: false as const, error } })
  return { result, settled: () => settled }
}
export async function expectHeld(boundary: Boundary, pending: ReturnType<typeof startCreate>) {
  await nextTurn() // Drains all runnable work, not an assumed microtask depth.
  expect(boundary.counts.adapter).toBe(1)
  expect(boundary.counts.device).toBe(1)
  expect(boundary.configuredOwnDevice()).toBe(true)
  expect(boundary.counts.fences).toBe(1)
  expect(boundary.counts.submits).toBe(1)
  expect(boundary.counts.textures).toBeGreaterThan(0)
  expect(boundary.counts.textureDestroy).toBe(0)
  expect(boundary.fenceState()).toBe(0)
  expect(pending.settled()).toBe(false)
}
export function expectBefore(boundary: Boundary, first: Event, second: Event) {
  const a = boundary.order[first], b = boundary.order[second]
  expect(typeof a === 'number' && typeof b === 'number' && a < b,
    `FRESH_INITIALIZE_ORDER_${first}_BEFORE_${second}`).toBe(true)
}
export function expectLostError(outcome: Outcome) {
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.error instanceof Error).toBe(true)
  expect(outcome.error instanceof Error && outcome.error.message === 'WebGPU 设备已丢失').toBe(true)
  const fields = renderFailureFields(outcome.error)
  expect(fields.failureCategory).toBe(4); expect(fields.failureCode).toBe(30)
}
export async function finish(boundary: Boundary) {
  // Always release the fixture fence, then deliver genuine loss BEFORE public
  // disposal, so successful controls and wrong old outcomes never enter park.
  boundary.fulfillFence(); await nextTurn()
  boundary.resolveLoss('fixture cleanup'); await nextTurn()
  for (const owner of boundary.owners) owner.dispose()
  await nextTurn()
}
export async function expectNextFresh(previous: Boundary) {
  const boundary = deviceBoundary('off', false), pending = startCreate(boundary)
  try {
    await nextTurn(); expect(pending.settled()).toBe(true)
    const outcome = await pending.result
    expect(outcome.ok, 'NEXT_FRESH_CREATE_MUST_SUCCEED').toBe(true)
    expect(boundary.counts.adapter, 'NEXT_FRESH_MUST_REQUEST_ADAPTER').toBe(1)
    expect(boundary.counts.device, 'NEXT_FRESH_MUST_REQUEST_DEVICE').toBe(1)
    expect(boundary.configuredOwnDevice(), 'NEXT_FRESH_MUST_CONFIGURE_NEW_DEVICE').toBe(true)
    expect(boundary.counts.deviceDestroy).toBe(0)
    if (outcome.ok) {
      expect(previous.owners.has(outcome.value), 'NEXT_FRESH_MUST_NOT_REUSE_PREVIOUS_OWNER').toBe(false)
      expect(outcome.value.stats().deviceLost).toBe(false)
    }
  } finally { await finish(boundary) }
}
beforeEach(() => {
  for (const key of ['VITE_DESIGN_DYNAMIC_UNIFORMS', 'VITE_DESIGN_GPU_TIMINGS',
    'VITE_DESIGN_SAMPLE_ONLY_COVERAGE', 'VITE_DESIGN_STATIC_IMAGE_BLUR_CACHE', 'VITE_DESIGN_QUEUE_WAIT_TIMING']) vi.stubEnv(key, '0')
  vi.stubEnv('VITE_DESIGN_LAZY_PIPELINES', '1')
})
afterEach(async () => {
  try {
    setGpuDiagnosticSink(undefined)
    for (const boundary of boundaries) await finish(boundary)
    expect(kernelBoundsCalls, 'APPLICATION_PICKING_BOUNDARY_MUST_NOT_RUN').toBe(0)
  } finally {
    boundaries.length = 0
    setGpuDiagnosticSink(undefined)
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  }
})
