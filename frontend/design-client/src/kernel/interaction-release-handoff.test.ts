import { afterEach, expect, test, vi } from 'vitest'
import { blank, effect, node, type DesignDocument } from '../model'
import { KernelClient } from './client'
import { InteractionRenderer } from './interaction-renderer'
import { interactionPatchedDocument, type InteractionProps } from './interaction-layers'

const worker = vi.hoisted(() => ({
  jobs: [] as any[], released: [] as number[], channelCancels: 0,
}))
// Delay only the worker boundary. Abort deliberately does not settle its
// promise: production ownership checks must reject even a late successful reply.
vi.mock('./client', () => ({
  KernelClient: class {
    cancelPreview() { worker.channelCancels++ }
    dispose() {}
    stopResidentInteraction() {}
    moveResidentInteraction() {}
    releasePresented(ids: number[]) { worker.released.push(...ids) }
    render(document: unknown, options: any, ...rest: any[]) {
      return new Promise((resolve, reject) => worker.jobs.push({
        document, options, reject, progress: rest[5], signal: rest[6],
        resolve: (result = {}) => resolve({ bytes: new Uint8Array(), compileMs: 0, ...result }),
      }))
    }
  },
}))

const owners: InteractionRenderer[] = []
afterEach(() => {
  owners.splice(0).forEach(owner => owner.dispose())
  worker.jobs.length = worker.released.length = worker.channelCancels = 0
})

const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture(shared = new KernelClient(), active = true, profile: 'figma'|'analytic'|'figmaSoftware' = 'figma', gestureKind?: string) {
  const document = blank(), root = node('frame', 0, 0, 200, 180)
  const selected = node('rectangle', 10, 10, 30, 20), other = node('rectangle', 60, 10, 30, 20)
  root.blend = 'normal'; root.clip = false; root.effects = [effect('background-blur')]
  root.children = [selected.id, other.id]
  document.nodes[root.id] = root; document.nodes[selected.id] = selected; document.nodes[other.id] = other
  document.pages[0].children = [root.id]
  const props: InteractionProps = {
    document, selection: [selected.id], active: false, epoch: 1, gestureKind, control: { current: null }, onReady: vi.fn(),
  }
  const changed = vi.fn(), owner = new InteractionRenderer(changed, shared)
  owners.push(owner)
  const view = { x: -.375, y: .125, zoom: 1 }, size = { width: 160, height: 120 }
  const prepare = (next = props, settled?: DesignDocument, camera = view, viewport = size, dpr = 2,
    profile: 'figma' | 'analytic' | 'figmaSoftware' = 'figma') =>
    owner.prepare(next, next.document.pages[0].id, camera, dpr, profile, 'webgpu', settled, viewport)
  prepare({ ...props, active }, undefined, view, size, 2, profile)
  const moved = (x: number, source = document) =>
    interactionPatchedDocument(source, { [selected.id]: { transform: [1, 0, 0, 1, x, 10] } })
  const apply = (x: number, source = document) =>
    owner.control.apply(source, { [selected.id]: { transform: [1, 0, 0, 1, x, 10] } })
  return { document, selected, other, props, owner, view, size, prepare, moved, apply, changed, shared }
}
async function complete(job: any, base: number, from = 0) {
  expect(job.options.interactionBranch).toBe(2)
  expect(job.options.tileViewport.length).toBeGreaterThan(1)
  for (const [index, tile] of job.options.tileViewport.entries()) {
    if (index >= from) job.progress({ ...tile, gpuTile: base + index, bytes: new Uint8Array() })
  }
  job.resolve()
  await microtasks()
}

test('release aborts this capture, keeps complete pixels, and never queues a final full-viewport group', async () => {
  const f = fixture()
  await complete(worker.jobs[0], 100)
  const previous = f.owner.tiles
  expect(f.apply(20)).not.toBeNull()
  const inFlight = worker.jobs[1]
  expect(f.apply(30)).not.toBeNull() // A newer pose waits behind the in-flight group.
  const final = f.moved(30)
  inFlight.progress({ ...inFlight.options.tileViewport[0], gpuTile: 200, bytes: new Uint8Array() })
  expect(f.owner.tiles).toBe(previous)
  f.owner.control.end(final)
  expect(inFlight.signal.aborted).toBe(true)
  expect(worker.channelCancels).toBe(0)
  expect(f.owner.control.isActive()).toBe(true)
  expect(f.owner.items(f.view)?.map(item => item.tile)).toEqual(previous)
  const committed = { ...f.props, document: final, active: false }
  f.prepare(committed)
  f.prepare(committed)
  f.owner.control.end(final) // Idle editor notifications are idempotent.
  expect(worker.jobs).toHaveLength(2)

  await complete(inFlight, 200, 1)
  expect(worker.jobs).toHaveLength(2)
  expect(f.owner.tiles).toBe(previous)
  expect(f.owner.error).toBe('')
  expect(worker.released).toEqual(inFlight.options.tileViewport.map((_: unknown, index: number) => 200 + index))
  expect(worker.released.some(id => previous.some(tile => tile.gpuTile === id))).toBe(false)
  // Merely submitting the new authored document did not retire its preview.
  expect(f.owner.control.isActive()).toBe(true)
  f.prepare(committed, final)
  expect(f.owner.control.isActive()).toBe(false)
  expect(f.owner.items(f.view)).toBeNull()
  f.prepare(committed)
  expect(worker.jobs).toHaveLength(2) // Idle rerenders cannot rewarm the released pose.
})

test('a new gesture survives the previous aborted promise unwinding', async () => {
  const f = fixture()
  await complete(worker.jobs[0], 100)
  f.apply(20)
  const old = worker.jobs[1], final = f.moved(20)
  f.owner.control.end(final)
  const next = { ...f.props, document: final, active: true }
  f.prepare(next)
  expect(f.apply(45, final)).not.toBeNull()
  expect(worker.jobs).toHaveLength(2) // One owner never runs two capture loops.
  expect(old.signal.aborted).toBe(true)
  await complete(old, 200)
  expect(worker.jobs).toHaveLength(3)
  const current = worker.jobs[2]
  expect(current.signal).not.toBe(old.signal)
  expect(current.signal.aborted).toBe(false)
  expect(current.options.interactionOwner).toBe(old.options.interactionOwner)
  expect(current.options.interactionGeneration).toBeGreaterThan(old.options.interactionGeneration)
  expect(current.document.nodes[f.selected.id].transform[4]).toBe(45)
  expect(f.owner.tiles[0].gpuTile).toBe(100)
  await complete(current, 300)
  expect(f.owner.tiles[0].gpuTile).toBe(300)
  expect(f.owner.control.isActive()).toBe(true)
  expect(f.owner.presentedInput.sequence).toBe(2)
  expect(worker.jobs).toHaveLength(3)
})

test('an incomplete initial capture is aborted without declaring any preview pixels ready', async () => {
  const f = fixture(), initial = worker.jobs[0]
  f.apply(20)
  const final = f.moved(20)
  f.owner.control.end(final)
  expect(initial.signal.aborted).toBe(true)
  expect(f.owner.ready).toBe(false)
  expect(f.owner.items(f.view)).toBeNull()
  f.prepare({ ...f.props, document: final })
  await complete(initial, 100)
  expect(f.owner.ready).toBe(false)
  expect(worker.jobs).toHaveLength(1)
  f.prepare({ ...f.props, document: final }, final)
  expect(f.owner.control.isActive()).toBe(false)
})

test.each(['success', 'cancel'] as const)('release before the first whole capture completes retires its %s without a second capture', async outcome => {
  const f = fixture(new KernelClient(), true, 'analytic'), initial = worker.jobs[0]
  expect(initial.options.interactionBranch).toBe(3)
  expect(f.owner.ready).toBe(false)
  expect(f.apply(20)).not.toBeNull()
  const final = f.moved(20)
  f.owner.control.end(final)
  expect(initial.signal.aborted).toBe(true)
  expect(worker.channelCancels).toBe(0)
  const committed = { ...f.props, document: final, active: false }
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  if (outcome === 'success') initial.resolve({ gpuTile: 100 })
  else initial.reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  expect(worker.jobs).toHaveLength(1)
  expect(f.owner.ready).toBe(false)
  expect(f.owner.items(f.view)).toBeNull()
  expect(worker.released).toEqual(outcome === 'success' ? [100] : [])
  f.prepare(committed, final, f.view, f.size, 2, 'analytic')
  expect(f.owner.control.isActive()).toBe(false)
})

test('release cancellation does not cancel another owner on the shared client', async () => {
  const shared = new KernelClient(), first = fixture(shared)
  await complete(worker.jobs[0], 100)
  first.apply(20)
  const firstJob = worker.jobs[1], second = fixture(shared), secondJob = worker.jobs[2]
  first.owner.control.end(first.moved(20))
  expect(firstJob.signal.aborted).toBe(true)
  expect(secondJob.signal.aborted).toBe(false)
  expect(firstJob.options.interactionOwner).not.toBe(secondJob.options.interactionOwner)
  expect(worker.channelCancels).toBe(0)
  await complete(secondJob, 300)
  expect(second.owner.ready).toBe(true)
  expect(second.owner.tiles[0].gpuTile).toBe(300)
  firstJob.reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  expect(second.owner.tiles[0].gpuTile).toBe(300)
})

test.each(['document', 'session', 'selection', 'camera', 'viewport', 'dpr', 'policy'] as const)(
  '%s changes revoke the released ownership fence and allow fresh capture', async change => {
    const f = fixture()
    await complete(worker.jobs[0], 100)
    f.apply(20)
    const old = worker.jobs[1], final = f.moved(20)
    f.owner.control.end(final)
    old.reject(Error('PREVIEW_CANCELLED'))
    await microtasks()
    let props = { ...f.props, document: final, active: true }
    if (change === 'document') props = { ...props, document: { ...final } }
    if (change === 'session') props = { ...props, epoch: 2 }
    if (change === 'selection') props = { ...props, selection: [f.other.id] }
    f.prepare(props, undefined,
      change === 'camera' ? { ...f.view, x: f.view.x + 25 } : f.view,
      change === 'viewport' ? { ...f.size, width: f.size.width + 25 } : f.size,
      change === 'dpr' ? 3 : 2, change === 'policy' ? 'analytic' : 'figma')
    expect(worker.jobs).toHaveLength(3)
    expect(worker.jobs[2].signal.aborted).toBe(false)
    expect(worker.jobs[2].document).toBe(props.document)
  },
)

test('content changes cannot enter the translation-only release handoff', async () => {
  const f = fixture()
  await complete(worker.jobs[0], 100)
  f.apply(20)
  const pending = worker.jobs[1], translated = f.moved(20)
  const changed = { ...translated, nodes: { ...translated.nodes,
    [f.selected.id]: { ...translated.nodes[f.selected.id], opacity: .5 } } }
  f.owner.control.end(changed)
  expect(pending.signal.aborted).toBe(false)
  await complete(pending, 200)
  expect(worker.jobs).toHaveLength(3)
  expect(worker.jobs[2].document).toBe(changed)
})

test.each([false, true])('finished resize content yields branch3 to canvas with complete resident=%s', async completeFirst => {
  const f = fixture(new KernelClient(), true, 'analytic', 'resize')
  const resized = (width: number) => ({ ...f.document, nodes: { ...f.document.nodes,
    [f.selected.id]: { ...f.selected, width } } })
  if (completeFirst) { worker.jobs[0].resolve({ gpuTile: 920 }); await microtasks() }
  const previous = f.owner.tiles, intermediate = resized(50), final = resized(70)
  f.prepare({ ...f.props, active: true, document: intermediate }, undefined, f.view, f.size, 2, 'analytic')
  const inFlight = worker.jobs.at(-1), count = worker.jobs.length
  expect(inFlight.options.interactionBranch).toBe(3)
  expect(inFlight.signal.aborted).toBe(false)
  f.prepare({ ...f.props, active: true, document: final }, undefined, f.view, f.size, 2, 'analytic')
  expect(worker.jobs).toHaveLength(count)
  f.owner.control.end(final)
  expect(inFlight.signal.aborted).toBe(true)
  // end() precedes React's committed props. Neither the stale active render
  // nor repeated exact final snapshots may resurrect queued resize captures.
  f.prepare({ ...f.props, active: true, document: final }, undefined, f.view, f.size, 2, 'analytic')
  const committed = { ...f.props, active: false, document: final }
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  expect(f.owner.tiles).toBe(previous)
  inFlight.resolve({ gpuTile: 921 }); await microtasks()
  expect(worker.released.filter(id => id === 921)).toHaveLength(1)
  expect(worker.jobs).toHaveLength(count)
  expect(f.owner.tiles).toBe(previous)
  expect(f.owner.error).toBe('')
})

test.each(['no-op click', 'new resize content'] as const)('resize release handles %s without a prior imperative apply', async action => {
  const f = fixture(new KernelClient(), true, 'analytic', 'resize')
  worker.jobs[0].resolve({ gpuTile: 922 }); await microtasks()
  const resized = (width: number) => ({ ...f.document, nodes: { ...f.document.nodes,
    [f.selected.id]: { ...f.selected, width } } })
  const final = resized(70)
  f.prepare({ ...f.props, active: true, document: final }, undefined, f.view, f.size, 2, 'analytic')
  const inFlight = worker.jobs.at(-1), count = worker.jobs.length
  f.owner.control.end(final)
  expect(inFlight.signal.aborted).toBe(true)
  inFlight.resolve({ gpuTile: 923 }); await microtasks()
  const committed = { ...f.props, active: false, document: final }
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  // React may report a newly active pointer before any content changed. The
  // same final snapshot alone must not restart an optional whole-view capture.
  f.prepare({ ...committed, active: true }, undefined, f.view, f.size, 2, 'analytic')
  expect(worker.jobs).toHaveLength(count)
  if (action === 'no-op click') {
    f.owner.control.end(final)
    f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
    expect(worker.jobs).toHaveLength(count)
    expect(f.owner.tiles[0].gpuTile).toBe(922)
  } else {
    // Resize content need not call apply(); its first changed snapshot must
    // revoke the old exact-document fence and own an uncancelled new capture.
    const next = resized(90)
    f.prepare({ ...committed, document: next, active: true }, undefined, f.view, f.size, 2, 'analytic')
    expect(worker.jobs).toHaveLength(count + 1)
    expect(worker.jobs.at(-1).signal.aborted).toBe(false)
    expect(worker.jobs.at(-1).document).toBe(next)
  }
})

test('ended resize never acknowledges old content as the committed revision and retires only at exact readiness', async () => {
  const f = fixture(new KernelClient(), true, 'analytic', 'resize')
  worker.jobs[0].resolve({ gpuTile: 930 }); await microtasks()
  const final = { ...f.document, nodes: { ...f.document.nodes, [f.selected.id]: { ...f.selected, width: 80 } } }
  f.prepare({ ...f.props, active: true, document: final }, undefined, f.view, f.size, 2, 'analytic')
  const before = f.owner.presentedInput.sequence
  f.owner.control.end(final)
  const committed = { ...f.props, active: false, document: final, onPosePresented: vi.fn() }
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  expect(f.owner.items(f.view)?.map(item => item.tile.gpuTile)).toEqual([930])
  f.owner.acceptPresentedInput(before + 1)
  expect(committed.onPosePresented).not.toHaveBeenCalled()
  f.prepare(committed, final, f.view, f.size, 2, 'analytic')
  expect(f.owner.items(f.view)).toBeNull()
  expect(worker.jobs).toHaveLength(2)
})

test('real imperative input revokes resize release before React updates active props', async () => {
  const f = fixture(new KernelClient(), true, 'analytic', 'resize')
  worker.jobs[0].resolve({ gpuTile: 940 }); await microtasks()
  f.apply(20)
  const inFlight = worker.jobs[1], final = f.moved(20)
  f.owner.control.end(final)
  expect(inFlight.signal.aborted).toBe(true)
  const committed = { ...f.props, document: final, active: false }
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  expect(f.apply(35, final)).not.toBeNull()
  f.prepare(committed, undefined, f.view, f.size, 2, 'analytic')
  inFlight.resolve({ gpuTile: 941 }); await microtasks()
  expect(worker.jobs).toHaveLength(3)
  expect(worker.jobs[2].signal.aborted).toBe(false)
  expect(worker.jobs[2].document.nodes[f.selected.id].transform[4]).toBe(35)
})

test('cancelled cold capture stays idle until active same-document same-density preparation', async () => {
  const f = fixture(), readyNotifications = vi.mocked(f.props.onReady).mock.calls.length
  worker.jobs[0].reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  expect(f.owner.error).toBe('')
  expect(f.owner.ready).toBe(false)
  expect(f.owner.samples).toBe(0)
  expect(worker.jobs).toHaveLength(1)
  expect(f.props.onReady).toHaveBeenCalledTimes(readyNotifications)
  f.owner.control.end(f.document)
  f.prepare(f.props, f.document)
  f.prepare()
  f.prepare()
  expect(worker.jobs).toHaveLength(1)
  const active = { ...f.props, active: true }
  f.prepare(active)
  f.prepare(active)
  expect(worker.jobs).toHaveLength(2)
  await complete(worker.jobs[1], 200)
  expect(f.owner.ready).toBe(true)
  expect(f.owner.samples).toBe(1)
  expect(f.owner.error).toBe('')
})

test('a new gesture can apply and publish after a cold live cancellation', async () => {
  const f = fixture()
  worker.jobs[0].reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  expect(f.apply(30)).not.toBeNull()
  expect(f.owner.moves).toBe(1)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.selected.id].transform[4]).toBe(30)
  await complete(worker.jobs[1], 200)
  expect(f.owner.samples).toBe(1)
  expect(f.owner.presentedInput.sequence).toBe(1)
  expect(f.owner.items(f.view)).not.toBeNull()
  expect(f.owner.error).toBe('')
})

test('idle camera changes after cold cancellation wait for an active gesture before retrying the latest camera', async () => {
  const f = fixture(), camera = { ...f.view, x: f.view.x + 24, y: f.view.y - 12 }
  worker.jobs[0].reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  f.owner.control.end(f.document)
  f.prepare(f.props, f.document)
  f.prepare(f.props, undefined, camera)
  f.prepare(f.props, undefined, camera)
  expect(worker.jobs).toHaveLength(1)
  f.prepare({ ...f.props, active: true }, undefined, camera)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view).toEqual({ x: camera.x * 2, y: camera.y * 2, zoom: 2 })
  await complete(worker.jobs[1], 200)
  expect(f.owner.samples).toBe(1)
  expect(f.owner.ready).toBe(true)
})

test('real cold render errors remain visible and cannot become an automatic retry loop', async () => {
  const f = fixture()
  worker.jobs[0].reject(Error('GPU invalid binding'))
  await microtasks()
  expect(f.owner.error).toContain('GPU invalid binding')
  f.prepare()
  f.prepare()
  expect(worker.jobs).toHaveLength(1)
  expect(f.apply(30)).toBeNull()
  expect(f.owner.samples).toBe(0)
  expect(f.owner.error).toContain('GPU invalid binding')
})

test('released handoff wins over a cancelled active capture until exact canvas readiness', async () => {
  const f = fixture()
  await complete(worker.jobs[0], 100)
  const previous = f.owner.tiles
  f.apply(30)
  worker.jobs[1].reject(Error('PREVIEW_CANCELLED'))
  await microtasks()
  expect(f.owner.control.isActive()).toBe(true)
  const final = f.moved(30)
  f.owner.control.end(final)
  const released = { ...f.props, document: final, active: false }
  f.prepare(released)
  f.prepare(released)
  expect(worker.jobs).toHaveLength(2)
  expect(f.owner.tiles).toBe(previous)
  expect(f.owner.items(f.view)).not.toBeNull()
  f.prepare(released, final)
  expect(f.owner.items(f.view)).toBeNull()
  expect(worker.jobs).toHaveLength(2)
})

test('navigation clears an obsolete capture without idle reinitialization; first apply starts the latest camera', async () => {
  const f = fixture(), obsolete = worker.jobs[0]
  const camera = { ...f.view, zoom: 32, x: -4000, y: -3000 }
  f.owner.prepare(undefined, f.document.pages[0].id, camera, 2, 'figma', 'webgpu')
  f.prepare(f.props, undefined, camera)
  expect(obsolete.signal.aborted).toBe(true)
  expect(worker.channelCancels).toBe(0)
  f.prepare(f.props, undefined, camera)
  expect(worker.jobs).toHaveLength(1)
  await complete(obsolete, 100)
  expect(f.owner.ready).toBe(false)
  expect(f.owner.samples).toBe(0)
  expect(f.owner.error).toBe('')
  expect(worker.released).toEqual(obsolete.options.tileViewport.map((_: unknown, i: number) => 100 + i))
  f.prepare(f.props, undefined, camera)
  expect(worker.jobs).toHaveLength(1)
  expect(f.apply(30)).not.toBeNull()
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].signal.aborted).toBe(false)
  expect(worker.jobs[1].options.view.zoom).toBe(64)
  expect(worker.jobs[1].options.interactionGeneration).toBeGreaterThan(obsolete.options.interactionGeneration)
  await complete(worker.jobs[1], 200)
  expect(f.owner.samples).toBe(1)
  expect(f.owner.moves).toBe(1)
})

test('repeated navigation removal and inactive restoration never initializes a live GPU capture', async () => {
  const f = fixture(undefined, false)
  expect(f.props.control.current).toBe(f.owner.control)
  expect(worker.jobs).toHaveLength(0)
  for (const zoom of [1, 32, 1, 32]) {
    const camera = { ...f.view, zoom }
    f.owner.prepare(undefined, f.document.pages[0].id, camera, 2, 'figma', 'webgpu')
    f.prepare(f.props, f.document, camera)
    f.prepare(f.props, f.document, camera)
    expect(f.props.control.current).toBe(f.owner.control)
    expect(worker.jobs).toHaveLength(0)
    expect(f.owner.ready).toBe(false)
  }
  f.prepare({ ...f.props, active: true }, undefined, { ...f.view, zoom: 32 })
  expect(f.owner.control.isActive()).toBe(true)
  expect(worker.jobs).toHaveLength(1)
  expect(worker.jobs[0].options.view.zoom).toBe(64)
  await complete(worker.jobs[0], 100)
  expect(f.owner.samples).toBe(1)
  expect(f.apply(30)).not.toBeNull()
  expect(f.owner.moves).toBe(1)
  expect(worker.jobs).toHaveLength(2)
})

test.each(['analytic','figmaSoftware'] as const)('native %s translation commit hands exact work to canvas without another whole-viewport capture',async profile=>{
  const f=fixture(new KernelClient(),true,profile)
  expect(worker.jobs[0].options.interactionBranch).toBe(3)
  worker.jobs[0].resolve({gpuTile:900,residentInteraction:false});await microtasks()
  const previous=f.owner.tiles
  const transform=[1,0,0,1,20,10]
  f.owner.control.apply(f.document,{[f.selected.id]:{transform:transform as any}})
  const inFlight=worker.jobs[1]
  expect(inFlight.options.interactionBranch).toBe(3)
  const final=interactionPatchedDocument(f.document,{[f.selected.id]:{transform:transform as any}})
  f.owner.control.end(final)
  expect(inFlight.signal.aborted).toBe(true)
  const committed={...f.props,document:final,active:false}
  f.prepare(committed,undefined,f.view,f.size,2,profile)
  f.prepare(committed,undefined,f.view,f.size,2,profile)
  expect(worker.jobs).toHaveLength(2)
  inFlight.resolve({gpuTile:901,residentInteraction:false});await microtasks()
  expect(worker.jobs).toHaveLength(2)
  expect(worker.released).toContain(901)
  expect(f.owner.tiles).toBe(previous)
  f.prepare(committed,final,f.view,f.size,2,profile)
  expect(f.owner.items(f.view)).toBeNull()
})
