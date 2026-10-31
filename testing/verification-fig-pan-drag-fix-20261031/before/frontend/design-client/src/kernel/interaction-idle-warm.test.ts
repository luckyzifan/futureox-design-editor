import { afterEach, expect, test, vi } from 'vitest'
import { blank, node } from '../model'
import type { DesignDocument } from '../model'
import type { CanvasCamera } from '../canvas-camera'
import type { InteractionProps } from './interaction-layers'
import { InteractionRenderer } from './interaction-renderer'
import { KernelClient, type KernelOptions } from './client'

const transport = vi.hoisted(() => ({ jobs: [] as any[], poses: [] as any[], released: [] as number[] }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {} dispose() {} stopResidentInteraction() {}
  moveResidentInteraction(...args: unknown[]) { transport.poses.push(args) }
  releasePresented(ids: number[]) { transport.released.push(...ids) }
  render(document: DesignDocument, options: KernelOptions, ...rest: any[]) {
    return new Promise((resolve, reject) => transport.jobs.push({ document, options, reject, signal: rest[6],
      resolve: (result = {}) => resolve({ bytes: new Uint8Array(), ...result }) }))
  }
} }))

const owners: InteractionRenderer[] = []
afterEach(() => {
  owners.splice(0).forEach(owner => owner.dispose())
  transport.jobs.length = transport.poses.length = transport.released.length = 0
  vi.useRealTimers(); vi.unstubAllEnvs()
})
function fixture(allowIdleWarm = true, shared = true) {
  vi.useFakeTimers()
  vi.stubEnv('VITE_DESIGN_NESTED_IDLE_WARM', '1')
  vi.stubEnv('VITE_DESIGN_RESIDENT_PENDING_POSE', '1')
  const document = blank(), root = node('frame', 0, 0, 240, 180), selected = node('rectangle', 40, 40, 24, 20)
  root.clip = false; root.blend = 'normal'; root.children = [selected.id]
  document.nodes[root.id] = root; document.nodes[selected.id] = selected; document.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn(), shared ? new KernelClient() : undefined, allowIdleWarm)
  owners.push(owner)
  const props: InteractionProps = { document, selection: [selected.id], active: false, epoch: 1,
    control: { current: null }, onReady: vi.fn() }
  const view = { x: 0, y: 0, zoom: 1 }
  const prepare = (settled: DesignDocument | undefined, next = props, camera: CanvasCamera = view,
    profile: KernelOptions['rasterProfile'] = 'figmaSubpixel') => owner.prepare(next, document.pages[0].id,
      camera, 2, profile, 'webgpu', settled, { width: 240, height: 180 })
  const move = () => owner.control.apply(document, { [selected.id]: { transform: [1, 0, 0, 1, 52, 40] } })
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { owner, document, root, selected, props, view, prepare, move, flush }
}

test('a deferred neutral-group selection upgrades to independent pixels once its real canvas settles',async()=>{
 const f=fixture();vi.stubEnv('VITE_DESIGN_NEUTRAL_PAGE_GROUP','1')
 f.root.kind='group';f.root.fills=[]
 f.prepare(undefined);await f.flush();expect(transport.jobs).toHaveLength(0)
 f.prepare(f.document);await f.flush()
 expect(transport.jobs).toHaveLength(1)
 expect(transport.jobs[0].options.gpuRoots).toEqual([f.selected.id])
 transport.jobs[0].resolve({gpuTile:901});await f.flush()
 expect(f.owner.ready).toBe(true)
 expect(f.move()).not.toBeNull();await f.flush();expect(transport.jobs).toHaveLength(1)
})

test('waits for full canvas readiness and 150 ms of stable idle time, then warms once without activating or editing', async () => {
  const f = fixture(), original = JSON.stringify(f.document)
  f.prepare(undefined); await vi.advanceTimersByTimeAsync(500)
  expect(transport.jobs).toHaveLength(0)
  f.prepare(f.document); await vi.advanceTimersByTimeAsync(149)
  expect(transport.jobs).toHaveLength(0)
  f.prepare(f.document) // A same-state React update does not reset the timer.
  await vi.advanceTimersByTimeAsync(1)
  expect(transport.jobs).toHaveLength(1)
  expect(transport.jobs[0].options).toMatchObject({ rasterProfile: 'figmaSubpixel', interactionNative: true,
    retainInteractionGraph: true, livePreview: true })
  expect(f.owner.control.isActive()).toBe(false)
  transport.jobs[0].resolve({ gpuTile: 901, residentInteraction: true }); await f.flush()
  expect(f.owner.ready).toBe(true); expect(f.owner.samples).toBe(1)
  expect(f.owner.moves).toBe(0); expect(f.owner.presentedInput.sequence).toBe(0)
  expect(f.owner.items(f.view)).toBeNull()
  for (let i = 0; i < 3; i++) { f.prepare(f.document); await vi.advanceTimersByTimeAsync(500) }
  expect(transport.jobs).toHaveLength(1)
  expect(JSON.stringify(f.document)).toBe(original)
})

test.each(['permission', 'flag', 'unset', 'profile', 'shared'] as const)('keeps idle warming disabled without its %s gate', async gate => {
  const f = fixture(gate !== 'permission', gate !== 'shared')
  if (gate === 'flag' || gate === 'unset') vi.stubEnv('VITE_DESIGN_NESTED_IDLE_WARM', gate === 'flag' ? '0' : '')
  f.prepare(f.document, f.props, f.view, gate === 'profile' ? 'figma' : 'figmaSubpixel')
  await vi.advanceTimersByTimeAsync(1000)
  expect(transport.jobs).toHaveLength(0)
})

test('a real gesture before the timer fires captures immediately without a delayed duplicate', async () => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(100)
  expect(f.move()).not.toBeNull()
  expect(transport.jobs).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(transport.jobs).toHaveLength(1)
  expect(transport.jobs[0].document.nodes[f.selected.id].transform[4]).toBe(52)
})

test('a useful in-flight warm joins the first/latest pose path when a same-context gesture begins', async () => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(150)
  const warm = transport.jobs[0]
  expect(f.move()).not.toBeNull()
  expect(warm.signal.aborted).toBe(false)
  warm.resolve({ gpuTile: 902, residentInteraction: true }); await f.flush()
  expect(transport.jobs).toHaveLength(1); expect(transport.poses).toHaveLength(1)
  expect(transport.poses[0][0]).toBe(902)
  expect(transport.poses[0][2].sequence).toBe(1)
  expect(f.owner.presentedInput.sequence).toBe(0)
})

test('loss of full readiness cancels a waiting timer and requires a new stable readiness interval', async () => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(149)
  f.prepare(undefined); await vi.advanceTimersByTimeAsync(1000)
  expect(transport.jobs).toHaveLength(0)
  f.prepare(f.document); await vi.advanceTimersByTimeAsync(149)
  expect(transport.jobs).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1); expect(transport.jobs).toHaveLength(1)
})

test.each(['camera', 'document', 'selection', 'epoch', 'ready', 'dispose'] as const)(
  '%s changes retire only the obsolete warm capture and late pixels cannot publish', async change => {
    const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(150)
    const warm = transport.jobs[0]
    if (change === 'camera') f.prepare(undefined, f.props, { ...f.view, x: 16 })
    if (change === 'document') f.prepare(undefined, { ...f.props,
      document: { ...f.document, nodes: { ...f.document.nodes, [f.selected.id]: { ...f.selected, opacity: .5 } } } })
    if (change === 'selection') f.prepare(undefined, { ...f.props, selection: [] })
    if (change === 'epoch') f.prepare(undefined, { ...f.props, epoch: 2 })
    if (change === 'ready') f.prepare(undefined)
    if (change === 'dispose') f.owner.dispose()
    expect(warm.signal.aborted).toBe(true)
    warm.resolve({ gpuTile: 903, residentInteraction: true }); await f.flush()
    expect(transport.released).toContain(903)
    expect(f.owner.ready).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.jobs).toHaveLength(1)
  })

test('a camera change before startup invalidates the old timer and captures only the later settled camera', async () => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(100)
  const changed = { ...f.view, zoom: 1.25, x: .125 }
  f.prepare(undefined, f.props, changed); await vi.advanceTimersByTimeAsync(500)
  expect(transport.jobs).toHaveLength(0)
  f.prepare(f.document, f.props, changed); await vi.advanceTimersByTimeAsync(150)
  expect(transport.jobs).toHaveLength(1)
  expect(transport.jobs[0].options.view.zoom).toBe(2.5)
})

test('callback rechecks copied camera values even if a caller mutates its old camera object', async () => {
  const f = fixture(); f.prepare(f.document)
  f.view.x = 12
  await vi.advanceTimersByTimeAsync(150)
  expect(transport.jobs).toHaveLength(0)
})

test('an optional idle failure is remembered without a retry loop and a later gesture can retry normally', async () => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(150)
  transport.jobs[0].reject(Error('Optional capture could not be prepared')); await f.flush()
  expect(f.owner.error).toBe(''); expect((f.owner as any).idleWarmFailed).toBeDefined()
  f.prepare(f.document); await vi.advanceTimersByTimeAsync(1000)
  expect(transport.jobs).toHaveLength(1)
  expect(f.move()).not.toBeNull()
  expect(transport.jobs).toHaveLength(2)
  transport.jobs[1].resolve({ gpuTile: 904, residentInteraction: true }); await f.flush()
  expect(f.owner.ready).toBe(true)
})

test.each(['device', 'gesture'] as const)('does not hide a real %s failure as optional idle preparation', async kind => {
  const f = fixture(); f.prepare(f.document); await vi.advanceTimersByTimeAsync(150)
  if (kind === 'gesture') f.move()
  const message = kind === 'device' ? 'WebGPU 设备已丢失' : 'Actual gesture failed'
  transport.jobs[0].reject(Error(message)); await f.flush()
  expect(f.owner.error).toContain(message)
})
