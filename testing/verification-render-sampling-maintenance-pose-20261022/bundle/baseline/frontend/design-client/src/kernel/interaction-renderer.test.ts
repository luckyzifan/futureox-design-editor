import { afterEach, expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { InteractionRenderer } from './interaction-renderer'
import { PageTranslation } from './page-translation'
import type { InteractionProps } from './interaction-layers'
import {KernelClient} from './client'
import * as geometry from '../geometry'
import { CanvasSceneSnapshots } from '../canvas-scene-snapshots'
import { buildInteractionDependencyScope } from './interaction-scene-bounds'

const worker = vi.hoisted(() => ({ jobs: [] as any[], poses:[] as any[],stops:[] as number[],released:[] as number[],disposed: 0 }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {}
  dispose() { worker.disposed++ }
  moveResidentInteraction(...args:unknown[]){worker.poses.push(args)}
  stopResidentInteraction(id:number){worker.stops.push(id)}
  releasePresented(ids:number[]){worker.released.push(...ids)}
  render(document: unknown, options: any, ...rest:any[]) {
    return new Promise((resolve, reject) => worker.jobs.push({ document, options, reject, progress:rest[5], signal:rest[6],
      resolve: (result={}) => resolve({ bytes: new Uint8Array(options.width * options.height * 4),...result }) }))
  }
} }))

const owners: InteractionRenderer[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); worker.jobs.length = 0; worker.poses.length=worker.stops.length=worker.released.length=0;worker.disposed = 0; vi.unstubAllEnvs() })
function fixture(dependent = false, zoom = 1, extent = 100, active = dependent) {
  const doc = blank(), root = node('frame', 0, 0, extent, extent)
  root.blend = 'normal'
  if (dependent) root.effects = [effect('glass')]
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active, epoch: 1, control: { current: null }, onReady: vi.fn() }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const view = { x: 0, y: 0, zoom }
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  return { doc, root, props, owner, view }
}

test('live capture prepares 3,000 page roots without rescanning the scene for every root', () => {
  const doc = blank(), count = 3000
  for (let i = 0; i < count; i++) {
    const root = node('frame', (i % 100) * 40, Math.floor(i / 100) * 40, 30, 30)
    root.blend = 'normal'
    if (!i) root.effects = [{ ...effect('background-blur'), radius: 2 }]
    doc.nodes[root.id] = root; doc.pages[0].children.push(root.id)
  }
  const entries = geometry.scene(doc, doc.pages[0].id)
  let identityReads = 0
  const scene = vi.spyOn(geometry, 'scene').mockReturnValue(entries.map(entry => new Proxy(entry, {
    get(target, key, receiver) {
      if (key === 'id' || key === 'ancestors') identityReads++
      return Reflect.get(target, key, receiver)
    },
  })))
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  try {
    owner.prepare({ document: doc, selection: [doc.pages[0].children[0]], active: true,
      epoch: 1, control: { current: null }, onReady() {} }, doc.pages[0].id,
    { x: 0, y: 0, zoom: 1 }, 1, 'analytic', 'cpu', undefined, { width: 640, height: 480 })
    expect(scene).toHaveBeenCalledOnce()
    expect(worker.jobs).toHaveLength(1)
    expect(worker.jobs[0].options.view.zoom).toBe(1)
    expect(worker.jobs[0].options.interactionWindow).toEqual({ x: 112, y: 112, w: 58, h: 58 })
    // Count actual production data access, not wall-clock time or a helper
    // invocation. The old per-root filter performs almost 18 million reads.
    expect(identityReads).toBeLessThan(count * 20)
  } finally { scene.mockRestore() }
})

test.each([60, 90, 120, 144])('3,000-node %i Hz motion coalesces pending inputs and rejects replaced-selection pixels', async hz => {
  const doc = blank(), count = 3000
  for (let i = 0; i < count; i++) {
    const root = node('frame', i % 100 * 40, Math.floor(i / 100) * 40, 30, 30)
    root.blend = 'normal'
    if (!i) root.effects = [{ ...effect('background-blur'), radius: 2 }]
    doc.nodes[root.id] = root; doc.pages[0].children.push(root.id)
  }
  const shared = new KernelClient(), published: number[] = []
  const owner = new InteractionRenderer(() => published.push(...owner.tiles.flatMap(tile => tile.gpuTile ? [tile.gpuTile] : [])), shared)
  owners.push(owner)
  const initial = doc.pages[0].children[0], replacement = doc.pages[0].children[1]
  let props: InteractionProps = { document: doc, selection: [initial], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: -.25, y: .125, zoom: 1 }, size = { width: 640, height: 480 }
  const prepare = () => owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'cpu', undefined, size)
  const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
  const replaceFrame = Math.floor(hz / 3), completeFrame = Math.floor(hz / 2)
  let elapsed = 0
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
  try {
  prepare()
  expect(worker.jobs).toHaveLength(1)
  for (let frame = 1; frame <= hz; frame++) {
    elapsed = frame * 1000 / hz
    if (frame === replaceFrame) { props = { ...props, selection: [replacement] }; prepare() }
    if (frame > replaceFrame) {
      expect(owner.control.apply(doc, { [replacement]: { transform: [1, 0, 0, 1, 40 + elapsed / 8, -elapsed / 16] } })).not.toBeNull()
      prepare()
    }
    if (frame === completeFrame) {
      worker.jobs[0].resolve({ gpuTile: 701, bytes: new Uint8Array() }); await microtasks()
      expect(worker.released).toContain(701)
      expect(owner.ready).toBe(false)
      expect(worker.jobs).toHaveLength(2)
    }
    expect(worker.jobs.length).toBeLessThanOrEqual(2)
    expect(published).not.toContain(701)
  }
  worker.jobs[1].resolve({ gpuTile: 702, bytes: new Uint8Array() }); await microtasks()
  expect(worker.jobs).toHaveLength(3)
  const final = worker.jobs[2]
  expect(final.document.nodes[replacement].transform).toEqual([1, 0, 0, 1, 165, -62.5])
  expect(final.options.view.zoom).toBe(1)
  final.resolve({ gpuTile: 703, bytes: new Uint8Array() }); await microtasks()
  expect(owner.tiles[0].gpuTile).toBe(703)
  expect(owner.error).toBe('')
  expect(owner.presentedInput.sequence).toBe(hz - replaceFrame)
  expect(owner.presentedInput.at).toBe(1000)
  expect(worker.jobs).toHaveLength(3)
  expect(published).not.toContain(701)
  expect(published).toContain(703)
  } finally { clock.mockRestore(); shared.dispose() }
})

test('exact tiled captures publish atomically and release partial failed replacements', async () => {
  const {doc,root,owner,view}=fixture(true)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  const capture=worker.jobs[1]
  expect(capture.options.view.zoom).toBe(1)
  for(const [i,tile] of capture.options.tileViewport.entries())capture.progress({...tile,gpuTile:100+i,bytes:new Uint8Array()})
  expect(owner.ready).toBe(false)
  capture.resolve({bytes:new Uint8Array()})
  await vi.waitFor(()=>expect(owner.ready).toBe(true))
  const complete=owner.tiles
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,10,0]}})
  const next=worker.jobs[2]
  expect(next.options.tileViewport.length).toBeGreaterThan(0)
  next.progress({...next.options.tileViewport[0],gpuTile:999,bytes:new Uint8Array()})
  expect(owner.tiles).toBe(complete)
  next.reject(Error('GPU tile failed'))
  await vi.waitFor(()=>expect(worker.released).toContain(999))
  expect(owner.tiles).toBe(complete)
  expect(owner.items(view)?.every(item=>item.gutter===1)).toBe(true)
})
test('HQ dependent captures keep the settled computation camera and full density',()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.effects=[effect('glass')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id];doc.rasterProfile='figma'
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  owner.prepare({document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:-.375,y:.125,zoom:1},2,'figma','webgpu',undefined,{width:100,height:100})
  const request=worker.jobs[0].options
  expect(request.view).toEqual({x:-.75,y:.25,zoom:2})
  expect(request.tileViewport.length).toBeGreaterThan(0)
  expect(request.tileViewport.every((tile:any)=>tile.zoom===2&&tile.gutter===1)).toBe(true)
  expect(request.retainInteractionGraph).toBeUndefined()
  shared.dispose()
})

function finalForegroundCapture(earlierBackdrop = true) {
  const doc = blank(), root = node('frame', 0, 0, 1000, 1000)
  const backdrop = node('rectangle', 0, 0, 800, 800), selected = node('rectangle', 300, 300, 238, 118)
  root.clip = false; root.children = [backdrop.id, selected.id]
  if (earlierBackdrop) backdrop.effects = [{ ...effect('background-blur'), radius: 3 }]
  for (const n of [root, backdrop, selected]) doc.nodes[n.id] = n
  doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  owner.prepare({ document: doc, selection: [selected.id], active: true, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 1 }, 2, 'figma', 'webgpu', undefined, { width: 855, height: 888 })
  return { doc, selected, owner, shared }
}
async function completeForegroundCapture(job: any, firstSlot: number) {
  for (const [index, tile] of job.options.tileViewport.entries())
    job.progress({ ...tile, gpuTile: firstSlot + index, bytes: new Uint8Array() })
  job.resolve({ bytes: new Uint8Array() })
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
test('only proven final foreground uses the short reserve while complete swept captures expand in both directions', async () => {
  const { doc, selected, owner, shared } = finalForegroundCapture()
  try {
    const initial = worker.jobs[0]
    // These are real production request extents with a mocked transport.
    // They establish scheduling/coverage, not GPU pixels or measured latency.
    expect(initial.options.width).toBe(732); expect(initial.options.height).toBe(492)
    expect(initial.options.tileViewport).toHaveLength(2)
    expect(initial.options.view).toEqual({ x: 0, y: 0, zoom: 2 })
    await completeForegroundCapture(initial, 100)
    expect(owner.control.apply(doc, { [selected.id]: { transform: [1, 0, 0, 1, 320, 300] } })).not.toBeNull()
    const nearby = worker.jobs[1]
    expect(nearby.options.tileViewport).toEqual(initial.options.tileViewport)
    await completeForegroundCapture(nearby, 200)
    for (const [index, x] of [500, 100].entries()) {
      const previous = owner.tiles
      expect(owner.control.apply(doc, { [selected.id]: { transform: [1, 0, 0, 1, x, 300] } })).not.toBeNull()
      const expanded = worker.jobs[2 + index], tiles = expanded.options.tileViewport
      const left = Math.min(...tiles.map((t: any) => t.x + t.gutter)) / 2
      const right = Math.max(...tiles.map((t: any) => t.x + t.width - t.gutter)) / 2
      const top = Math.min(...tiles.map((t: any) => t.y + t.gutter)) / 2
      const bottom = Math.max(...tiles.map((t: any) => t.y + t.height - t.gutter)) / 2
      expect(left).toBeLessThanOrEqual(Math.min(300, x) - 16)
      expect(right).toBeGreaterThanOrEqual(Math.max(300, x) + 238 + 16)
      expect(top).toBeLessThanOrEqual(300 - 16)
      expect(bottom).toBeGreaterThanOrEqual(300 + 118 + 16)
      expect(expanded.options.width).toBeGreaterThan(initial.options.width)
      expect(expanded.options.view).toEqual(initial.options.view)
      expect(tiles.every((t: any) => t.zoom === 2 && t.gutter === 1)).toBe(true)
      expect(owner.tiles).toBe(previous)
      await completeForegroundCapture(expanded, 300 + index * 100)
      expect(owner.tiles).not.toBe(previous)
    }
    expect(owner.error).toBe('')
  } finally { shared.dispose() }
})
test('ordinary no-backdrop localization retains its original 256-pixel travel reserve', () => {
  const { shared } = finalForegroundCapture(false)
  try {
    expect(worker.jobs[0].options.width).toBe(1628)
    expect(worker.jobs[0].options.height).toBe(1388)
    expect(worker.jobs[0].options.tileViewport).toHaveLength(12)
  } finally { shared.dispose() }
})

test('worker pose inputs do not enumerate the document after validation and rebase materializes the latest pose',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';root.effects=[effect('background-blur')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  for(let i=0;i<500;i++){const child=node('rectangle',i%80,i%70,1,1);doc.nodes[child.id]=child;root.children.push(child.id)}
  let enumerations=0
  doc.nodes=new Proxy(doc.nodes,{ownKeys(target){enumerations++;return Reflect.ownKeys(target)}})
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}}
  owner.prepare(props,doc.pages[0].id,{x:0,y:0,zoom:1},1,'analytic','webgpu',undefined,{width:100,height:100})
  expect(worker.jobs[0].options.view).toEqual({x:0,y:0,zoom:1})
  expect(worker.jobs[0].options.captureViewport).toBeDefined()
  worker.jobs[0].resolve({gpuTile:44,residentInteraction:true});await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,1,0]}})
  const validated=enumerations
  for(let i=2;i<=120;i++)owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,i,0]}})
  expect(enumerations).toBe(validated);expect(worker.jobs).toHaveLength(1);expect(worker.poses).toHaveLength(120)
  owner.acceptResidentSample({slot:44,sequence:120,at:0,needsRebase:true})
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(120)
  expect(doc.nodes[root.id].transform[4]).toBe(0)
  worker.jobs[1].resolve({gpuTile:45,residentInteraction:true})
  await vi.waitFor(()=>expect(owner.samples).toBe(2));shared.dispose()
})

test('retained layer movement reuses pixels, keeps commit preview and releases raster GPU slot', async () => {
  const { doc, root, props, owner, view } = fixture()
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(worker.disposed).toBe(1)
  expect(owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 30, 40] } })).toEqual({ x: 30, y: 40 })
  const pixels = owner.items(view)![0].tile
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, 30, 40] as const } } } as typeof doc
  owner.control.end(moved)
  owner.prepare({ ...props, document: moved }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(owner.items(view)![0].tile).toBe(pixels)
  expect(worker.jobs).toHaveLength(1)
  owner.control.end(doc)
  expect(owner.items(view)).toBeNull()
})

test('dependent render publishes an active sample despite newer input and coalesces pending samples', async () => {
  const { doc, root, props, owner, view } = fixture(true)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 10, 0] } })
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 20, 0] } })
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 30, 0] } })
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(3))
  expect(owner.items(view)?.length).toBe(1)
  expect(worker.jobs[2].document.nodes[root.id].transform[4]).toBe(30)
  owner.control.end(doc)
  worker.jobs[2].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(owner.items(view)).toBeNull()
})

test('selection replacement cannot publish a late warm result', async () => {
  const { doc, props, owner, view } = fixture()
  owner.prepare({ ...props, selection: [] }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  vi.mocked(props.onReady).mockClear()
  worker.jobs[0].resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(owner.ready).toBe(false)
  expect(props.onReady).not.toHaveBeenCalled()
})

test('idle editor notifications preserve a deferred dependent controller for the first drag', async () => {
  const { doc, root, owner } = fixture(true, 1, 100, false)
  owner.control.end(doc)
  owner.control.end(doc)
  expect(worker.disposed).toBe(0)
  expect(worker.jobs).toHaveLength(0)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 20, 0] } })
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.samples).toBe(1))
  expect(worker.disposed).toBe(0)
})

test('pointer input during cold warm-up is retained without restarting or revealing an empty layer', async () => {
  const { doc, root, owner, view } = fixture()
  expect(owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 40, 20] } })).toEqual({ x: 40, y: 20 })
  expect(owner.items(view)).toBeNull()
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  const item = owner.items(view)![0]
  expect(item.placement!.left).toBeCloseTo(item.tile.x / item.tile.zoom + 40)
})

test('intermediate GPU budget failures reduce preview density with bounded retries', async () => {
  const { owner } = fixture(false, .2)
  const firstWidth = worker.jobs[0].options.width
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.width).toBeLessThan(firstWidth)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
})

test('reopening the same document id revokes an active interaction from the previous session', async () => {
  const { doc, root, props, owner, view } = fixture()
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 50, 0] } })
  owner.prepare({ ...props, epoch: 2 }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(owner.items(view)).toBeNull()
  expect(owner.control.isActive()).toBe(false)
})

test('dependent captures follow the visible viewport instead of a fixed 512-pixel page thumbnail', async () => {
  const { doc, props, owner } = fixture(true)
  const view = { x: -5000, y: -4000, zoom: 1 }
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 2, 'analytic', 'webgpu', undefined, { width: 800, height: 500 })
  // A running first job coalesces the replacement viewport; finish it so the
  // new request can publish its current capture policy.
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.width).toBeGreaterThan(1600)
  expect(worker.jobs[1].options.interactionWindow.w).toBe(1600)
  expect(worker.jobs[1].options.view.x).toBeLessThan(-9000)
})

test('a negotiated interaction density survives subsequent pointer samples', async () => {
  const {doc,root,owner}=fixture(true, .2)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  const acceptedScale=worker.jobs[1].options.view.zoom
  worker.jobs[1].resolve();await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,5,0]}})
  expect(worker.jobs).toHaveLength(3)
  expect(worker.jobs[2].options.view.zoom).toBe(acceptedScale)
})
test('normal-zoom budget failure never retries at reduced sampling density',async()=>{
  const {owner}=fixture(true)
  expect(worker.jobs[0].options.interactionNative).toBe(true)
  expect(worker.jobs[0].options.view.zoom).toBe(1)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.view.zoom).toBe(1)
  expect(worker.jobs[1].options.tileViewport.every((tile:any)=>tile.zoom===1)).toBe(true)
  worker.jobs[1].reject(Error('PREVIEW_BUDGET: GPU 表面内存预算超限'))
  await vi.waitFor(()=>expect(owner.error).toContain('PREVIEW_BUDGET'))
  expect(worker.jobs).toHaveLength(2)
})

test('shared GPU movement sends poses, retains a stable texture handle, and leaves the shared client alive',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.effects=[effect('background-blur')];root.blend='normal'
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const view={x:0,y:0,zoom:1},props:InteractionProps={document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}}
  owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu',undefined,{width:100,height:100})
  worker.jobs[0].resolve({gpuTile:44,residentInteraction:true})
  await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,5.25,0]}})
  expect(worker.poses).toHaveLength(1);expect(worker.jobs).toHaveLength(1)
  expect(worker.poses[0][0]).toBe(44)
  expect(worker.poses[0][1][root.id][4]).toBe(5.25)
  owner.acceptResidentSample({slot:44,sequence:1,at:1,total:16,graphMs:5,groupHits:3})
  expect(owner.items(view)![0].tile.gpuTile).toBe(44)
  expect(owner.lastSampleMs).toBe(16);expect(owner.samples).toBe(2)
  const moved={...doc,nodes:{...doc.nodes,[root.id]:{...root,transform:[1,0,0,1,5.25,0] as typeof root.transform}}}
  owner.control.end(moved)
  owner.prepare({...props,document:moved},doc.pages[0].id,view,1,'analytic','webgpu',undefined,{width:100,height:100})
  owner.control.end(moved)
  expect(worker.jobs).toHaveLength(1)
  expect(worker.poses).toHaveLength(2)
  expect(worker.stops).not.toContain(44)
  owner.dispose();expect(worker.disposed).toBe(0);expect(worker.stops).toContain(44)
  shared.dispose()
})

test('zoom refreshes retained layer density without resetting an in-progress drag',async()=>{
  const {doc,root,props,owner}=fixture()
  worker.jobs[0].resolve();await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[root.id]:{transform:[1,0,0,1,30,40]}})
  const zoomed={x:0,y:0,zoom:2},before=owner.items(zoomed)![0].placement
  owner.prepare({...props,active:true},doc.pages[0].id,zoomed,1,'analytic','webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(owner.items(zoomed)![0].tile.zoom).toBe(1)
  worker.jobs[1].resolve()
  await vi.waitFor(()=>expect(owner.items(zoomed)![0].tile.zoom).toBe(2))
  expect(owner.items(zoomed)![0].placement).toEqual(before)
})

test('superseded shared-device layer captures release unpresented textures',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}}
  const view={x:0,y:0,zoom:1}
  owner.prepare(props,doc.pages[0].id,view,1,'analytic','webgpu')
  owner.prepare({...props,epoch:2},doc.pages[0].id,view,1,'analytic','webgpu')
  worker.jobs[0].resolve({gpuTile:77})
  await vi.waitFor(()=>expect(worker.released).toContain(77))
  expect(owner.ready).toBe(false)
  owner.dispose();shared.dispose()
})

test('nested motion retains native Retina density and sends live GPU poses without rebuilding the scene', async () => {
  const doc = blank(), root = node('frame', 0, 0, 1600, 1200), child = node('rectangle', 600, 500, 200, 40)
  root.blend = 'normal'; root.children = [child.id]; doc.nodes[root.id] = root; doc.nodes[child.id] = child
  doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  owner.prepare(props, doc.pages[0].id, { x: 100, y: 100, zoom: .6 }, 2, 'analytic', 'webgpu', undefined, { width: 2560, height: 1440 })
  const job = worker.jobs[0]
  expect(job.options.view.zoom).toBe(1.2)
  expect(job.options.width * job.options.height).toBeLessThan(4_194_304)
  expect(job.options.interactionWindow.w).toBeLessThan(600)
  job.resolve({ gpuTile: 101, residentInteraction: true })
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  for (let i = 1; i <= 60; i++) owner.control.apply(doc, { [child.id]: { transform: [1, 0, 0, 1, 600 + i, 500] } })
  expect(worker.poses).toHaveLength(60)
  expect(worker.jobs).toHaveLength(1)
})

test('nested pointer feedback uses world displacement through a rotated scaled parent', () => {
  const doc = blank(), root = node('frame', 200, 200, 200, 200), child = node('rectangle', 30, 40, 20, 20)
  root.transform = [0, 2, -2, 0, 200, 200]; root.children = [child.id]; root.blend = 'normal'
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare({ document: doc, selection: [child.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 1 }, 1, 'analytic', 'webgpu')
  expect(owner.control.apply(doc, { [child.id]: { transform: [1, 0, 0, 1, 35, 43] } })).toEqual({ x: -6, y: 10 })
})

test('nested background-blur motion captures the fixed board at Retina density instead of the entire wide viewport',async()=>{
  const doc=blank(),root=node('frame',0,0,1440,1030),child=node('rectangle',600,500,200,40)
  root.clip=true;root.blend='multiply';root.effects=[{...effect('background-blur'),radius:8}];root.children=[child.id]
  doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  owner.prepare({document:doc,selection:[child.id],active:true,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:800,y:400,zoom:.6},2,'analytic','webgpu',undefined,{width:2560,height:1440})
  const first=worker.jobs[0];expect(first.options.view.zoom).toBe(1.2);expect(first.options.interactionWindowFixed).toBe(true)
  expect(first.options.width*first.options.height).toBeLessThanOrEqual(4_194_304)
  first.resolve({gpuTile:101,residentInteraction:true});await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,900,500]}})
  expect(worker.poses).toHaveLength(1);expect(worker.jobs).toHaveLength(1)
})

test.each([1, 2])('native retained layers refresh 31x to 32x without a density gap at DPR %i', async dpr => {
  const doc = blank(), root = node('frame', .125, -.25, 2, 2)
  root.blend = 'normal'
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 31 }, dpr, 'analytic', 'webgpu')
  expect(worker.jobs[0].options.view.zoom).toBe(31 * dpr)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1.125, .75] } })
  const view = { x: 0, y: 0, zoom: 32 }
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, dpr, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(32 * dpr)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.items(view)![0].tile.zoom).toBe(32 * dpr))
  expect(owner.control.isActive()).toBe(true)
})

test('in-flight 31x warm-up cannot pin a 32x drag to stale density', async () => {
  const doc = blank(), root = node('frame', 0, 0, 2, 2)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: false,
    epoch: 1, control: { current: null }, onReady() {} }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 31 }, 2, 'analytic', 'webgpu')
  owner.prepare(props, doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 2, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  worker.jobs[1].resolve(); await vi.waitFor(() => expect(owner.tiles[0].zoom).toBe(64))
})


test('native retained layers keep integer pixel motion fast and reraster fractional coverage without a blank', async () => {
  const { doc, root, owner, view, props } = fixture(false, 32, 10)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const previous = owner.items(view)![0]
  expect(worker.jobs).toHaveLength(1)
  expect(owner.mode).toBe('retained-layers')
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.interactionNative).toBe(true)
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(.1)
  expect(owner.items(view)![0].tile).toBe(previous.tile)
  expect(owner.items(view)![0].placement).toEqual(previous.placement)
  expect(owner.items(view)![0].blend).toBe(true)
  // An authored React refresh cannot overwrite the newer imperative pose.
  owner.prepare({ ...props, active: true }, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  expect(worker.jobs).toHaveLength(2)
  expect(owner.items(view)![0].tile).not.toBe(previous.tile)
  expect(owner.items(view)![0].blend).toBe(false)
  expect(owner.presentedInput.sequence).toBe(2)
})

test('fractional retained promotion coalesces newer poses and commits the last native sample', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  for (const x of [.1, .2, .3]) owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, x, 0] } })
  expect(worker.jobs).toHaveLength(2)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(3))
  expect(worker.jobs[2].document.nodes[root.id].transform[4]).toBe(.3)
  expect(worker.jobs[2].options.view.zoom).toBe(32)
  worker.jobs[2].resolve(); await vi.waitFor(() => expect(owner.samples).toBe(2))
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .3, 0] as const } } } as typeof doc
  owner.control.end(moved)
  expect(owner.items(view)).not.toBeNull()
  expect(owner.presentedInput.sequence).toBe(3)
})

test('fractional input during initial retained warm-up publishes then rerasterizes without cancelling useful work', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(owner.ready).toBe(true)
  const previous = owner.items(view)![0]
  expect(previous.placement!.left).toBe(previous.tile.x / previous.tile.zoom * view.zoom)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
})

test('failed retained warm-up admits a changed native density once without a same-request retry loop', async () => {
  const { doc, props, owner, view } = fixture(false, 31, 10)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(owner.error).toContain('PREVIEW_BUDGET'))
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  const higher = { ...view, zoom: 32 }
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.error).toBe('')
})

test('retained captures preserve the world pixel lattice for fractional authored bounds', async () => {
  const doc = blank(), root = node('frame', .1, .2, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 1, 'analytic', 'webgpu')
  expect(Number.isInteger(worker.jobs[0].options.view.x)).toBe(true)
  expect(Number.isInteger(worker.jobs[0].options.view.y)).toBe(true)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.tiles.every(tile => Number.isInteger(tile.x) && Number.isInteger(tile.y))).toBe(true)
})


test('failed fractional replacement retains the complete pose and a newer input recovers', async () => {
  const { doc, root, owner, view } = fixture(false, 32, 10)
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  const retained = owner.items(view)![0].tile
  worker.jobs[1].reject(Error('temporary render failure'))
  await vi.waitFor(() => expect(owner.error).toContain('temporary render failure'))
  expect(owner.items(view)![0].tile).toBe(retained)
  expect(owner.mode).toBe('retained-layers')
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .2, 0] } })
  worker.jobs[2].resolve(); await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  expect(owner.error).toBe('')
})

test('disposing a fractional native replacement releases its late shared GPU handle', async () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, { x: 0, y: 0, zoom: 32 }, 1, 'analytic', 'webgpu')
  worker.jobs[0].resolve({ gpuTile: 70 }); await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  owner.dispose()
  worker.jobs[1].resolve({ gpuTile: 71 })
  await vi.waitFor(() => expect(worker.released).toContain(71))
  expect(owner.ready).toBe(false)
  shared.dispose()
})


test('a failed old-density warm-up consumes the newer queued density exactly once', async () => {
  const { doc, props, owner, view } = fixture(false, 31, 10)
  const higher = { ...view, zoom: 32 }
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(worker.jobs[1].options.view.zoom).toBe(32)
  worker.jobs[1].reject(Error('PREVIEW_BUDGET'))
  await vi.waitFor(() => expect(owner.error).toContain('PREVIEW_BUDGET'))
  owner.prepare(props, doc.pages[0].id, higher, 1, 'analytic', 'webgpu')
  expect(worker.jobs).toHaveLength(2)
})


test('retained and native live samples preserve fractional device camera phase at 32x', async () => {
  const doc = blank(), root = node('frame', 0, 0, 2, 2)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const view = { x: .125, y: -.125, zoom: 32 }, dpr = 2
  owner.prepare({ document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady() {} },
    doc.pages[0].id, view, dpr, 'analytic', 'webgpu', undefined, { width: 100, height: 100 })
  worker.jobs[0].resolve(); await vi.waitFor(() => expect(owner.ready).toBe(true))
  expect(owner.tiles[0].phaseX).toBe(.25); expect(owner.tiles[0].phaseY).toBe(.75)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  worker.jobs[1].resolve(); await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  const tile = owner.tiles[0]
  expect(tile.phaseX).toBe(.25); expect(tile.phaseY).toBe(.75)
  const placement = owner.items(view)![0].placement!
  expect(Number.isInteger(placement.left * dpr)).toBe(true)
  expect(Number.isInteger(placement.top * dpr)).toBe(true)
})


test('page translation hands fractional native motion to the GPU renderer without losing its last complete pose', async () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  root.blend = 'normal'; doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 32 }, size = { width: 100, height: 100 }
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const page = new PageTranslation(vi.fn(), (document, patches, displayed) => {
    owner.prepare({ ...props, document: displayed }, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
    return owner.control.apply(document, patches)
  })
  const tile = { key: 'page', serial: 1, gpuTile: 70, bytes: new Uint8Array(), x: 0, y: 0, width: 512, height: 512, zoom: 32 }
  const items = [{ tile, active: true, layer: 0 }]
  page.prepare(props, doc.pages[0].id, doc, items, doc, true); page.bind()
  props.control.current!.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const accepted = page.items(view)![0].placement!.left
  expect(props.control.current!.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })).toEqual({ x: .1, y: 0 })
  expect(props.control.current).toBe(owner.control)
  expect(owner.ready).toBe(false)
  expect(page.items(view)![0].placement!.left).toBe(accepted)
  expect(worker.jobs[0].document.nodes[root.id].transform[4]).toBe(1 / 32)
  expect(page.prepare(props, doc.pages[0].id, doc, items, doc, true)).toBe(false)
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
  expect(worker.jobs).toHaveLength(1)
  worker.jobs[0].resolve({ gpuTile: 71 })
  await vi.waitFor(() => expect(worker.jobs).toHaveLength(2))
  expect(owner.ready).toBe(true)
  expect(worker.jobs[1].document.nodes[root.id].transform[4]).toBe(.1)
  expect(worker.jobs[1].options.interactionNative).toBe(true)
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu', doc, size)
  worker.jobs[1].resolve({ gpuTile: 72, residentInteraction: true })
  await vi.waitFor(() => expect(owner.mode).toBe('live-kernel'))
  expect(worker.jobs).toHaveLength(2)
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .1, 0] as typeof root.transform } } }
  owner.control.end(moved)
  expect(page.prepare({ ...props, document: moved, active: false }, doc.pages[0].id, moved, items, moved, true)).toBe(true)
  expect(page.handingOff).toBe(false)
  shared.dispose()
})


test('replaced shared capture retires its own requests without cancelling another owner or same-generation motion', async () => {
  const shared = new KernelClient(), doc = blank(), a = node('frame', 0, 0, 100, 100), b = node('frame', 140, 0, 100, 100)
  a.blend = b.blend = 'normal'; doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  const one = new InteractionRenderer(vi.fn(), shared), two = new InteractionRenderer(vi.fn(), shared); owners.push(one, two)
  const props: InteractionProps = { document: doc, selection: [a.id], active: false, epoch: 1, control: { current: null }, onReady() {} }
  const view = { x: .25, y: .125, zoom: .6 }, size = { width: 600, height: 500 }
  one.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  two.prepare({ ...props, control: { current: null } }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  const old = worker.jobs[0], independent = worker.jobs[1]
  expect(old.signal?.aborted).toBe(false); expect(independent.signal?.aborted).toBe(false)
  one.prepare({ ...props, selection: [b.id] }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  expect(old.signal.aborted).toBe(true); expect(independent.signal.aborted).toBe(false)
  const latest = worker.jobs[2]
  expect(latest.signal.aborted).toBe(false)
  one.prepare({ ...props, selection: [b.id] }, doc.pages[0].id, view, 1, 'analytic', 'cpu', doc, size)
  expect(worker.jobs).toHaveLength(3); expect(latest.signal.aborted).toBe(false)
  one.dispose(); expect(latest.signal.aborted).toBe(true); expect(independent.signal.aborted).toBe(false)
})

function pendingRetainedFixture(active = true) {
  vi.stubEnv('VITE_DESIGN_RESIDENT_PENDING_POSE', '1')
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.clip = false; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const shared = new KernelClient(), owner = new InteractionRenderer(vi.fn(), shared); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active, epoch: 1,
    control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 1 }, size = { width: 240, height: 180 }
  const prepare = (next = props, camera = view) =>
    owner.prepare(next, doc.pages[0].id, camera, 2, 'figmaSubpixel', 'webgpu', undefined, size)
  prepare()
  const transform = (dx: number) => [1, 0, 0, 1, 40 + dx, 40] as typeof child.transform
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
  return { doc, root, child, owner, shared, props, view, prepare, transform, flush }
}

test('first retained capture transfers its latest queued pure translation to the same worker slot without a second capture', async () => {
  const f = pendingRetainedFixture(), original = JSON.stringify(f.doc), first = worker.jobs[0]
  expect(first.options.retainInteractionGraph).toBe(true)
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(4) } })
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  expect(worker.jobs).toHaveLength(1)
  first.resolve({ gpuTile: 801, residentInteraction: true }); await f.flush()
  expect(worker.jobs).toHaveLength(1)
  expect(worker.poses).toHaveLength(1)
  expect(worker.poses[0][0]).toBe(801)
  expect(worker.poses[0][1][f.child.id]).toEqual(f.transform(12))
  expect(worker.poses[0][2].sequence).toBe(2)
  // Sending is not a presentation acknowledgement. The captured original is
  // displayed until the actual resident sample reports the latest sequence.
  expect(f.owner.presentedInput.sequence).toBe(0)
  f.owner.acceptResidentSample({ slot: 801, ...worker.poses[0][2], nativePose: true })
  expect(f.owner.presentedInput.sequence).toBe(2)
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(16) } })
  expect(worker.poses).toHaveLength(2)
  expect(worker.jobs).toHaveLength(1)
  expect(JSON.stringify(f.doc)).toBe(original)
})

test('a first capture without worker residency keeps the original whole-scene pending path', async () => {
  const f = pendingRetainedFixture()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  worker.jobs[0].resolve({ gpuTile: 802, residentInteraction: false }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].transform).toEqual(f.transform(12))
})

test('camera changes during the first retained capture require a new capture instead of an old-lattice pose', async () => {
  const f = pendingRetainedFixture(), first = worker.jobs[0]
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  f.prepare(f.props, { x: 11.25, y: -.125, zoom: 1.25 })
  first.resolve({ gpuTile: 803, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].options.view.zoom).toBe(2.5)
})

test('a queued style change cannot enter the first retained capture as a transform-only pose', async () => {
  const f = pendingRetainedFixture()
  const styled = { ...f.doc, nodes: { ...f.doc.nodes, [f.child.id]: { ...f.child, opacity: .25 } } }
  f.prepare({ ...f.props, document: styled })
  worker.jobs[0].resolve({ gpuTile: 804, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].opacity).toBe(.25)
})

test('queued translation is checked against the completed capture document rather than only the original plan', async () => {
  const f = pendingRetainedFixture(false)
  expect(worker.jobs).toHaveLength(0)
  const styled = { ...f.doc, nodes: { ...f.doc.nodes, [f.child.id]: { ...f.child, opacity: .25 } } }
  f.prepare({ ...f.props, document: styled, active: true })
  expect(worker.jobs[0].document).toBe(styled)
  // This pending pose is compatible with the initial plan, but not with the
  // actual styled document currently being captured into slot 805.
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  worker.jobs[0].resolve({ gpuTile: 805, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].opacity).toBe(f.child.opacity)
})

test('session replacement while the first capture is pending releases its late slot without sending a pose', async () => {
  const f = pendingRetainedFixture(), first = worker.jobs[0]
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(12) } })
  f.prepare({ ...f.props, epoch: 2 })
  expect(first.signal.aborted).toBe(true)
  first.resolve({ gpuTile: 806, residentInteraction: true }); await f.flush()
  expect(worker.released).toContain(806)
  expect(worker.poses).toHaveLength(0)
  expect(worker.jobs).toHaveLength(2)
  expect(f.owner.tiles.some(tile => tile.gpuTile === 806)).toBe(false)
})

test('a transferred pending pose outside the worker capture guard still rebuilds the latest real transform', async () => {
  const f = pendingRetainedFixture()
  f.owner.control.apply(f.doc, { [f.child.id]: { transform: f.transform(60) } })
  worker.jobs[0].resolve({ gpuTile: 807, residentInteraction: true }); await f.flush()
  expect(worker.poses).toHaveLength(1)
  expect(worker.jobs).toHaveLength(1)
  f.owner.acceptResidentSample({ slot: 807, ...worker.poses[0][2], needsRebase: true })
  expect(worker.jobs).toHaveLength(2)
  expect(worker.jobs[1].document.nodes[f.child.id].transform).toEqual(f.transform(60))
  expect(f.doc.nodes[f.child.id].transform).toEqual(f.transform(0))
})


test('navigation restoration borrows the published Canvas scene while recomputing camera-dependent scope', () => {
  vi.stubEnv('VITE_DESIGN_LOCAL_BACKDROP', '1')
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.clip = true; root.effects = [effect('background-blur')]; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const pageId = doc.pages[0].id, epoch = 1, store = new CanvasSceneSnapshots()
  store.begin({}, epoch, pageId, true)
  const snapshot = store.currentScene(doc, pageId), borrowed = store.borrowCurrentScene(doc, pageId, epoch)!
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: false, epoch,
    control: { current: null }, onReady: vi.fn(), scene: borrowed }
  const before = JSON.stringify(snapshot.entries), lookup = vi.spyOn(geometry, 'scene')
  try {
    for (const [zoom, dpr] of [[.25, 1], [32, 2], [1, 2], [32, 1]] as const) {
      const view = { x: zoom * 3.25, y: -zoom * 2.5, zoom }
      owner.prepare(undefined, pageId, view, dpr, 'analytic', 'cpu')
      owner.prepare(props, pageId, view, dpr, 'analytic', 'cpu', doc, { width: 640, height: 480 })
      const expected = buildInteractionDependencyScope(doc, pageId, snapshot.entries, props.selection,
        { zoom, dpr, allowFixedBackdrop: true })
      const actual = (owner as any).resident
      for (const field of ['rootBounds', 'parentLinear', 'localizedBounds', 'fixedBounds', 'dependencyPadding', 'finalForeground'] as const)
        expect(actual[field]).toEqual(expected[field])
      expect(props.control.current).toBe(owner.control)
    }
    expect(lookup).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot.entries)).toBe(before)
    expect(props.onReady).toHaveBeenCalledTimes(8)
    expect(worker.jobs).toHaveLength(0)
  } finally { lookup.mockRestore() }
})

test('missing or stale Canvas borrow falls back to fresh geometry, including standalone mutable inputs', () => {
  const doc = blank(), root = node('frame', 0, 0, 240, 180), child = node('rectangle', 40, 40, 24, 20)
  root.blend = 'normal'; root.children = [child.id]
  doc.nodes[root.id] = root; doc.nodes[child.id] = child; doc.pages[0].children = [root.id]
  const pageId = doc.pages[0].id, epoch = 1, store = new CanvasSceneSnapshots()
  store.begin({}, epoch, pageId, true); store.currentScene(doc, pageId)
  const borrowed = store.borrowCurrentScene(doc, pageId, epoch)!
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const props: InteractionProps = { document: doc, selection: [child.id], active: false, epoch,
    control: { current: null }, onReady() {} }
  const view = { x: 0, y: 0, zoom: 1 }, lookup = vi.spyOn(geometry, 'scene')
  try {
    owner.prepare(props, pageId, view, 1, 'analytic', 'cpu', doc, { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(1)
    owner.prepare(undefined, pageId, view, 1, 'analytic', 'cpu')
    // Ordinary standalone callers supply no immutable publication capability.
    child.width = 100
    owner.prepare(props, pageId, view, 1, 'analytic', 'cpu', doc, { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(2)
    expect((owner as any).resident.rootBounds.get(child.id).width).toBe(100)
    owner.prepare(undefined, pageId, view, 1, 'analytic', 'cpu')
    const changed = { ...doc, nodes: { ...doc.nodes, [child.id]: { ...child, width: 120 } } }
    owner.prepare({ ...props, document: changed, scene: borrowed }, pageId, view, 1, 'analytic', 'cpu', changed,
      { width: 640, height: 480 })
    expect(lookup).toHaveBeenCalledTimes(3)
    expect((owner as any).resident.rootBounds.get(child.id).width).toBe(120)
  } finally { lookup.mockRestore() }
})
