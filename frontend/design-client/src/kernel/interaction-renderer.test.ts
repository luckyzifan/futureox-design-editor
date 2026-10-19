import { afterEach, expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { InteractionRenderer } from './interaction-renderer'
import type { InteractionProps } from './interaction-layers'
import {KernelClient} from './client'

const worker = vi.hoisted(() => ({ jobs: [] as any[], poses:[] as any[],stops:[] as number[],released:[] as number[],disposed: 0 }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {}
  dispose() { worker.disposed++ }
  moveResidentInteraction(...args:unknown[]){worker.poses.push(args)}
  stopResidentInteraction(id:number){worker.stops.push(id)}
  releasePresented(ids:number[]){worker.released.push(...ids)}
  render(document: unknown, options: any, ...rest:any[]) {
    return new Promise((resolve, reject) => worker.jobs.push({ document, options, reject, progress:rest[5],
      resolve: (result={}) => resolve({ bytes: new Uint8Array(options.width * options.height * 4),...result }) }))
  }
} }))

const owners: InteractionRenderer[] = []
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); worker.jobs.length = 0; worker.poses.length=worker.stops.length=worker.released.length=0;worker.disposed = 0 })
function fixture(dependent = false, zoom = 1) {
  const doc = blank(), root = node('frame', 0, 0, 100, 100)
  root.blend = 'normal'
  if (dependent) root.effects = [effect('glass')]
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: false, epoch: 1, control: { current: null }, onReady: vi.fn() }
  const owner = new InteractionRenderer(vi.fn()); owners.push(owner)
  const view = { x: 0, y: 0, zoom }
  owner.prepare(props, doc.pages[0].id, view, 1, 'analytic', 'webgpu')
  return { doc, root, props, owner, view }
}

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
  owner.prepare({document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:-.375,y:.125,zoom:1},2,'figma','webgpu',undefined,{width:100,height:100})
  const request=worker.jobs[0].options
  expect(request.view).toEqual({x:0,y:0,zoom:2})
  expect(request.tileViewport.length).toBeGreaterThan(0)
  expect(request.tileViewport.every((tile:any)=>tile.zoom===2&&tile.gutter===1)).toBe(true)
  expect(request.retainInteractionGraph).toBeUndefined()
  shared.dispose()
})

test('worker pose inputs do not enumerate the document after validation and rebase materializes the latest pose',async()=>{
  const doc=blank(),root=node('frame',0,0,100,100);root.blend='normal';root.effects=[effect('background-blur')]
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  for(let i=0;i<500;i++){const child=node('rectangle',i%80,i%70,1,1);doc.nodes[child.id]=child;root.children.push(child.id)}
  let enumerations=0
  doc.nodes=new Proxy(doc.nodes,{ownKeys(target){enumerations++;return Reflect.ownKeys(target)}})
  const shared=new KernelClient(),owner=new InteractionRenderer(vi.fn(),shared);owners.push(owner)
  const props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}}
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

test('idle editor notifications preserve a warmed dependent renderer for the first drag', async () => {
  const { doc, root, owner } = fixture(true)
  worker.jobs[0].resolve()
  await vi.waitFor(() => expect(owner.ready).toBe(true))
  owner.control.end(doc)
  owner.control.end(doc)
  expect(worker.disposed).toBe(0)
  owner.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 20, 0] } })
  worker.jobs[1].resolve()
  await vi.waitFor(() => expect(owner.samples).toBe(2))
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
  const view={x:0,y:0,zoom:1},props:InteractionProps={document:doc,selection:[root.id],active:false,epoch:1,control:{current:null},onReady(){}}
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
  const props: InteractionProps = { document: doc, selection: [child.id], active: false, epoch: 1, control: { current: null }, onReady() {} }
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
  owner.prepare({document:doc,selection:[child.id],active:false,epoch:1,control:{current:null},onReady(){}},
    doc.pages[0].id,{x:800,y:400,zoom:.6},2,'analytic','webgpu',undefined,{width:2560,height:1440})
  const first=worker.jobs[0];expect(first.options.view.zoom).toBe(1.2);expect(first.options.interactionWindowFixed).toBe(true)
  expect(first.options.width*first.options.height).toBeLessThanOrEqual(4_194_304)
  first.resolve({gpuTile:101,residentInteraction:true});await vi.waitFor(()=>expect(owner.ready).toBe(true))
  owner.control.apply(doc,{[child.id]:{transform:[1,0,0,1,900,500]}})
  expect(worker.poses).toHaveLength(1);expect(worker.jobs).toHaveLength(1)
})
