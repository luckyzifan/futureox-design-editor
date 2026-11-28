import { expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { PageTranslation, isolatedOpaqueBoard } from './page-translation'
import type { InteractionProps } from './interaction-layers'
import { compositeDrawPlan } from './gpu/composite-draw-plan'
import { clippedBoardPrefetch, clippedBoardSource, clippedCommitTiles, tileOnBoardLattice } from './clipped-board-drag'

test('desktop page textures follow fractional input immediately and chrome waits for the owned frame',()=>{
 const doc=blank(),a=node('frame',0,0,100,80);doc.nodes[a.id]=a;doc.pages[0].children=[a.id]
 const native=vi.fn(),feedback=vi.fn(),movement=new PageTranslation(vi.fn(),native)
 const props:InteractionProps={document:doc,selection:[a.id],active:true,epoch:4,control:{current:null},onReady(){},onPosePresented:feedback}
 const tile={key:'page',serial:1,gpuTile:7,bytes:new Uint8Array(),x:-1,y:-1,width:514,height:514,zoom:.790625}
 expect(movement.prepare(props,doc.pages[0].id,doc,[{tile,active:true,layer:0}],doc,true,true)).toBe(true)
 movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,7.589,.3]}})
 expect(native).not.toHaveBeenCalled();expect(movement.control.feedbackPending?.()).toBe(true)
 expect(movement.items({x:0,y:0,zoom:1})![0].placement!.left).toBeCloseTo(-1/tile.zoom+7.589)
 movement.acceptPresentedInput(1,performance.now(),false,[7]);movement.acceptPresentedInput(1,performance.now(),true,[8])
 expect(feedback).not.toHaveBeenCalled()
 movement.acceptPresentedInput(1,performance.now(),true,[7]);expect(feedback).toHaveBeenCalledOnce()
 expect(feedback.mock.calls[0][0]).toMatchObject({sequence:1,offset:{x:7.589,y:.3},document:doc,epoch:4})
 movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,9.3,.7]}})
 movement.clear();movement.acceptPresentedInput(2,performance.now(),true,[7]);expect(feedback).toHaveBeenCalledOnce()
})

test('a rejected viewport-only page move requests native coverage once for the exact live pose',()=>{
  const doc=blank(),a=node('frame',0,0,1000,1000);doc.nodes[a.id]=a;doc.pages[0].children=[a.id]
  const native=vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(()=>({x:40,y:0})),movement=new PageTranslation(vi.fn(),native)
  const props:InteractionProps={document:doc,selection:[a.id],active:true,epoch:1,control:{current:null},onReady(){}}
  const tile={key:'crop',serial:1,gpuTile:7,bytes:new Uint8Array(),x:0,y:0,width:128,height:128,zoom:1,gutter:0}
  movement.prepare(props,doc.pages[0].id,doc,[{tile,active:true,layer:0}],doc,true)
  movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,20,0]}})
  movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,40,0]}})
  expect(movement.backgroundTranslation).toEqual({x:40,y:0})
  expect(movement.repairMissingCoverage(1)).toBe(false)
  expect(native).not.toHaveBeenCalled()
  expect(movement.repairMissingCoverage(2)).toBe(true)
  expect(native).toHaveBeenCalledTimes(1)
  expect(native.mock.calls[0][1][a.id].transform).toEqual([1,0,0,1,40,0])
  expect(movement.repairMissingCoverage(2)).toBe(false)
  movement.clear();expect(movement.repairMissingCoverage(2)).toBe(false)
})

test('uncommitted whole-page coverage uses original world tiles and failed work rebases only its live owner',()=>{
  const doc=blank(),a=node('frame',0,0,1000,1000);doc.nodes[a.id]=a;doc.pages[0].children=[a.id]
  const native=vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(()=>({x:40,y:0}))
  const fill=vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[3]>>(()=>true)
  const movement=new PageTranslation(vi.fn(),native,undefined,fill)
  const props:InteractionProps={document:doc,selection:[a.id],active:true,epoch:1,control:{current:null},onReady(){}}
  const tile={key:'crop',serial:1,gpuTile:7,bytes:new Uint8Array(),x:0,y:0,width:128,height:128,zoom:1,gutter:0}
  movement.prepare(props,doc.pages[0].id,doc,[{tile,active:true,layer:0}],doc,true)
  movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,20,0]}})
  expect(movement.repairMissingCoverage(1)).toBe(true)
  expect(fill.mock.calls[0].slice(0,3)).toEqual([doc,{x:20,y:0},1])
  expect(native).not.toHaveBeenCalled();expect(movement.handingOff).toBe(false)
  movement.control.apply(doc,{[a.id]:{transform:[1,0,0,1,40,0]}})
  fill.mock.calls[0][3]()
  expect(native.mock.calls[0][1][a.id].transform).toEqual([1,0,0,1,40,0])
  movement.clear();fill.mock.calls[0][3]();expect(native).toHaveBeenCalledTimes(1)
})

test('one isolated opaque board lifts from existing tiles without raster work and preserves its final pose', () => {
  const doc = blank(), a = node('frame', 20, 20, 100, 100), b = node('frame', 200, 20, 100, 100)
  for (const root of [a, b]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  doc.pages[0].children = [a.id, b.id]
  const props: InteractionProps = { document: doc, selection: [a.id], active: false, epoch: 1,
    control: { current: null }, onReady() {} }
  const tile = { key: 'page', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1 }
  const items = [{ tile, active: true, layer: 3 }]
  const movement = new PageTranslation(vi.fn())
  expect(movement.prepare(props, doc.pages[0].id, doc, items, doc, true)).toBe(true)
  expect(movement.mode).toBe('retained-board')
  movement.control.apply(doc, { [a.id]: { transform: [1, 0, 0, 1, 60, 170] } })
  const view = { x: 0, y: 0, zoom: 1 }, moved = movement.items(view)!
  expect(moved.every(item => item.tile === tile)).toBe(true)
  const at = (x: number, y: number) => compositeDrawPlan(moved, view, 512, 512)
    .filter(row => row.clip.left <= x && row.clip.right > x && row.clip.top <= y && row.clip.bottom > y)
  expect(at(25, 25)).toHaveLength(0) // The old board location reveals the page background.
  expect(at(65, 175).at(-1)!.item.layer).toBe(4)
  expect(at(205, 25).at(-1)!.item.layer).toBe(0)
  const changed = { ...doc, nodes: { ...doc.nodes, [a.id]: { ...a, transform: [1, 0, 0, 1, 60, 170] as typeof a.transform } } }
  movement.control.end(changed)
  expect(movement.prepare({ ...props, document: changed }, doc.pages[0].id, changed, [], undefined, true)).toBe(true)
  expect(movement.items(view)).not.toBeNull()
  a.opacity = .5
  expect(isolatedOpaqueBoard(doc, doc.pages[0].children, a.id)).toBeUndefined()
})

test('Figma lifts opaque sRGB board pixels and falls back when the board would cover visible siblings', () => {
  const doc = blank()
  const board = node('frame', 20, 20, 100, 100)
  const neighbor = node('frame', 200, 20, 100, 100)
  for (const root of [board, neighbor]) {
    root.blend = 'normal'
    root.clip = true
    doc.nodes[root.id] = root
  }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing solid board paint')
  paint.color = 'color(srgb 0.8 0.9 1 / 1)'
  const pageId = doc.pages[0].id
  doc.pages[0].children = [board.id, neighbor.id]
  const props: InteractionProps = { document: doc, selection: [board.id], active: false, epoch: 1,
    control: { current: null }, onReady() {} }
  const tile = { key: 'page', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1 }
  const items = [{ tile, active: true, layer: 0 }]
  const view = { x: 0, y: 0, zoom: 1 }
  const camera = { view, width: 512, height: 512 }
  const native = vi.fn(() => ({ x: .25, y: .5 }))
  const movement = new PageTranslation(vi.fn(), native)
  expect(movement.prepare(props, pageId, doc, items, doc, true, false, camera)).toBe(false)
  const figma = { ...props, figmaBoardPreview: true }
  expect(movement.prepare(figma, pageId, doc, items, doc, true, false, camera)).toBe(true)
  // 0.25 and 0.5 device pixels are a fractional phase. Keep the settled page
  // and hand the pose to native on the original document.
  expect(movement.items(view)).toBeNull()
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20.25, 20.5] } })).toEqual({ x: .25, y: .5 })
  expect(native).toHaveBeenCalledTimes(1)
  expect(native).toHaveBeenCalledWith(doc, { [board.id]: { transform: [1, 0, 0, 1, 20.25, 20.5] } }, doc, undefined)
  expect(movement.handingOff).toBe(true)
  expect(movement.items(view)).toBeNull()
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 21, 21] } })).toBeNull()
  expect(movement.items(view)).toBeNull()

  movement.clear()
  native.mockClear()
  expect(movement.prepare(figma, pageId, doc, items, doc, true, false, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 40, 50] } })).toEqual({ x: 20, y: 30 })
  expect(native).not.toHaveBeenCalled()
  expect(movement.items(view)?.every(item => item.tile === tile)).toBe(true)

  movement.clear()
  expect(movement.prepare(figma, pageId, doc, items, doc, true, false, camera)).toBe(true)
  movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 190, 20] } })
  expect(native).toHaveBeenCalledTimes(1)
  expect(native).toHaveBeenCalledWith(doc, { [board.id]: { transform: [1, 0, 0, 1, 190, 20] } }, doc, undefined)

  movement.clear()
  paint.color = 'color(srgb 0.8 0.9 1 / 0.9999)'
  expect(movement.prepare(figma, pageId, doc, items, doc, true, false, camera)).toBe(false)
})

test('clipped boards reuse resident textures only when both physical axes are whole pixels', () => {
  const doc = blank(), board = node('frame', 20, 30, 80, 60), other = node('frame', 400, 30, 40, 40)
  for (const root of [board, other]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing solid board paint')
  paint.color = 'color(srgb 0.86 0.91 0.94 / 1)'
  doc.pages[0].children = [board.id, other.id]
  const pageId = doc.pages[0].id
  // 80% CSS zoom at DPR 2. Resident zoom 1.6 is the physical sample scale.
  const view = { x: -10, y: 4, zoom: 0.8 }
  const tile = { key: 'page', serial: 1, gpuTile: 9, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1.6 }
  const items = [{ tile, active: true, layer: 0 }]
  const camera = { view, width: 1143, height: 800 }
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 2,
    figmaBoardPreview: true, control: { current: null }, onReady() {} }
  const native = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(() => ({ x: 28, y: 7 }))
  const movement = new PageTranslation(vi.fn(), native)
  expect(movement.prepare(props, pageId, doc, items, doc, true, true, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 100, 50] } })).toEqual({ x: 80, y: 20 })
  expect(native).not.toHaveBeenCalled()
  const held = movement.items(view)!.map(item => ({ placement: item.placement, clip: item.clip, layer: item.layer }))
  const moved = held.find(item => item.layer === 4)
  expect(moved?.placement?.left).toBe((tile.x) * view.zoom / tile.zoom + view.x + 80 * view.zoom)
  expect(moved?.clip?.left).toBe(20 * view.zoom + view.x + 80 * view.zoom)
  const decisionStarted = performance.now()
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 48, 37] } })).toEqual({ x: 28, y: 7 })
  const decisionMs = performance.now() - decisionStarted
  expect(native).toHaveBeenCalledTimes(1)
  // Shown sRGB pixels have not advanced, so native keeps the original sample document.
  expect(native.mock.calls[0][2]).toBe(doc)
  expect(native.mock.calls[0][1][board.id].transform).toEqual([1, 0, 0, 1, 48, 37])
  expect(movement.handingOff).toBe(true)
  expect(movement.items(view)!.map(item => ({ placement: item.placement, clip: item.clip, layer: item.layer }))).toEqual(held)
  expect(movement.prepare(props, pageId, doc, items, doc, true, true, camera)).toBe(false)
  expect(decisionMs).toBeLessThan(50)
  console.info(`[issue-818] fractional board handoff decision ${decisionMs.toFixed(3)} ms, document clone=false`)

  movement.clear()
  native.mockClear()
  const density = { ...tile, zoom: 1.5 }
  expect(movement.prepare(props, pageId, doc, [{ ...items[0], tile: density }], doc, true, true, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 48, 37] } })).toEqual({ x: 28, y: 7 })
  expect(native).toHaveBeenCalledTimes(1)
  expect(native.mock.calls[0][2]).toBe(doc)
  expect(movement.items(view)).toBeNull()

  movement.clear()
  native.mockClear()
  expect(movement.prepare(props, pageId, doc, [{ ...items[0], tile: density }], doc, true, true, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 100, 50] } })).toEqual({ x: 80, y: 20 })
  expect(native).not.toHaveBeenCalled()
  const integer75 = movement.items(view)!.map(item => item.placement)
  movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 48, 37] } })
  expect(native.mock.calls[0][2]).toBe(doc)
  expect(movement.items(view)!.map(item => item.placement)).toEqual(integer75)
})

test('desktop fractional reprojection leaves a clipped hex board on its last integer frame', () => {
  const doc = blank(), board = node('frame', 20, 30, 80, 60), other = node('frame', 400, 30, 40, 40)
  for (const root of [board, other]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  doc.pages[0].children = [board.id, other.id]
  const pageId = doc.pages[0].id
  const view = { x: 0, y: 0, zoom: 0.8 }
  const tile = { key: 'page', serial: 1, gpuTile: 9, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1.6 }
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    control: { current: null }, onReady() {} }
  const native = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(() => ({ x: 28, y: 7 }))
  const movement = new PageTranslation(vi.fn(), native)
  expect(movement.prepare(props, pageId, doc, [{ tile, active: true, layer: 0 }], doc, true, true)).toBe(true)
  movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 100, 50] } })
  const held = movement.items(view)!.map(item => item.placement)
  movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 48, 37] } })
  expect(native).toHaveBeenCalledTimes(1)
  const displayed = native.mock.calls[0][2]
  expect(displayed).not.toBe(doc)
  expect(displayed.nodes[board.id].transform).toEqual([1, 0, 0, 1, 100, 50])
  expect(movement.items(view)!.map(item => item.placement)).toEqual(held)
  expect(movement.handingOff).toBe(true)
})

test('retained pointer samples do not enumerate the document and reject unrelated edits', () => {
  const doc = blank(), a = node('frame', 0, 0, 100, 100)
  doc.nodes = { [a.id]: a }; doc.pages[0].children = [a.id]
  let enumerations = 0
  doc.nodes = new Proxy(doc.nodes, { ownKeys(target) { enumerations++; return Reflect.ownKeys(target) } })
  const movement = new PageTranslation(vi.fn())
  const props: InteractionProps = { document: doc, selection: [a.id], active: false, epoch: 1,
    control: { current: null }, onReady() {} }
  const tile = { key: 'page', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1 }
  movement.prepare(props, doc.pages[0].id, doc, [{ tile, active: true, layer: 0 }], doc, true)
  enumerations = 0
  for (let i = 0; i < 100; i++) expect(movement.control.apply(doc, { [a.id]: { transform: [1, 0, 0, 1, i, i] } })).toEqual({ x: i, y: i })
  expect(enumerations).toBe(0)
  const edited = { ...doc, nodes: { [a.id]: { ...a, opacity: .5 } } }
  expect(movement.control.apply(edited, { [a.id]: { transform: [1, 0, 0, 1, 30, 40] } })).toBeNull()
  expect(movement.control.apply(doc, { [a.id]: { opacity: .5 } })).toBeNull()
})
test('moving all overlapping boards reuses full-density page pixels even with backdrop and multiply', () => {
  const doc = blank(),
    a = node('frame', 0, 0, 300, 300),
    b = node('frame', 100, 100, 300, 300)
  b.blend = 'multiply'
  b.effects = [effect('background-blur')]
  doc.nodes[a.id] = a
  doc.nodes[b.id] = b
  doc.pages[0].children = [a.id, b.id]
  const props: InteractionProps = {
    document: doc,
    selection: [a.id, b.id],
    active: false,
    epoch: 1,
    control: { current: null },
    onReady() {},
  }
  const tile = {
    key: 'native',
    serial: 1,
    gpuTile: 7,
    bytes: new Uint8Array(),
    x: -1,
    y: -1,
    width: 514,
    height: 514,
    zoom: 2,
  }
  const movement = new PageTranslation(vi.fn())
  expect(
    movement.prepare(props, doc.pages[0].id, doc, [{ tile, active: true, layer: 3 }], doc, true),
  ).toBe(true)
  movement.bind()
  expect(
    movement.control.apply(doc, {
      [a.id]: { transform: [1, 0, 0, 1, 10.5, 20.5] },
      [b.id]: { transform: [1, 0, 0, 1, 110.5, 120.5] },
    }),
  ).toEqual({ x: 10.5, y: 20.5 })
  expect(movement.items({ x: 0, y: 0, zoom: 1 })![0].tile).toBe(tile)
  expect(movement.items({ x: 0, y: 0, zoom: 1 })![0].placement!.left).toBe(10)
  movement.prepare(
    { ...props, active: true },
    doc.pages[0].id,
    doc,
    [{ tile, active: true, layer: 3 }],
    doc,
    true,
  )
  expect(movement.items({ x: 0, y: 0, zoom: 1 })![0].placement!.left).toBe(10)
  expect(
    movement.control.apply(doc, {
      [a.id]: { transform: [1, 0, 0, 1, 10, 20] },
      [b.id]: { transform: [1, 0, 0, 1, 120, 120] },
    }),
  ).toBeNull()
  movement.control.end(doc)
  expect(movement.items({ x: 0, y: 0, zoom: 1 })).toBeNull()
})
test('partial selections and screen-anchored backgrounds cannot reuse a translated page', () => {
  const doc = blank(),
    a = node('frame', 0, 0, 20, 20),
    b = node('frame', 30, 0, 20, 20)
  doc.nodes[a.id] = a
  doc.nodes[b.id] = b
  doc.pages[0].children = [a.id, b.id]
  const props: InteractionProps = {
    document: doc,
    selection: [a.id],
    active: false,
    epoch: 1,
    control: { current: null },
    onReady() {},
  }
  const movement = new PageTranslation(vi.fn())
  expect(movement.prepare(props, doc.pages[0].id, doc, [], doc, true)).toBe(false)
  expect(
    movement.prepare({ ...props, selection: [a.id, b.id] }, doc.pages[0].id, doc, [], doc, false),
  ).toBe(false)
})


test('first fractional input keeps the original native document identity when no page pixels have moved',()=>{
  const doc=blank(),root=node('frame',0,0,10,10)
  doc.nodes[root.id]=root;doc.pages[0].children=[root.id]
  const props:InteractionProps={document:doc,selection:[root.id],active:true,epoch:1,control:{current:null},onReady(){}}
  const fallback=vi.fn(()=>({x:.1,y:0})),movement=new PageTranslation(vi.fn(),fallback)
  const tile={key:'native',serial:1,gpuTile:1,bytes:new Uint8Array(),x:0,y:0,width:512,height:512,zoom:32}
  movement.prepare(props,doc.pages[0].id,doc,[{tile,active:true,layer:0}],doc,true)
  movement.control.apply(doc,{[root.id]:{transform:[1,0,0,1,.1,0]}})
  expect(fallback).toHaveBeenCalledWith(doc,expect.anything(),doc,undefined)
  expect((fallback.mock.calls[0] as unknown[])[2]).toBe(doc)
  expect(movement.handingOff).toBe(true)
})

test('fractional page pixels hand over before changing the accepted pose and cannot rebind stale pixels', () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const tile = { key: 'native32', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: 0, y: 0, width: 512, height: 512, zoom: 32 }
  const items = [{ tile, active: true, layer: 0 }], fallback = vi.fn((_document: typeof doc, _patches: unknown, _displayed: typeof doc) => ({ x: .1, y: 0 }))
  const movement = new PageTranslation(vi.fn(), fallback), view = { x: 0, y: 0, zoom: 32 }
  movement.prepare(props, doc.pages[0].id, doc, items, doc, true)
  movement.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const accepted = movement.items(view)![0].placement
  movement.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, .1, 0] } })
  expect(fallback).toHaveBeenCalledTimes(1)
  expect(fallback.mock.calls[0][2].nodes[root.id].transform[4]).toBe(1 / 32)
  expect(movement.items(view)![0].placement).toEqual(accepted)
  expect(movement.handingOff).toBe(true)
  expect(movement.prepare(props, doc.pages[0].id, doc, items, doc, true)).toBe(false)
  movement.control.end({ ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .1, 0] } } })
  expect(movement.items(view)![0].placement).toEqual(accepted)
})


test('authored fractional translations cannot bypass page phase admission through prepare or end', () => {
  const doc = blank(), root = node('frame', 0, 0, 10, 10)
  doc.nodes[root.id] = root; doc.pages[0].children = [root.id]
  const props: InteractionProps = { document: doc, selection: [root.id], active: true, epoch: 1, control: { current: null }, onReady() {} }
  const tile = { key: 'native32', serial: 1, bytes: new Uint8Array(), x: 0, y: 0, width: 512, height: 512, zoom: 32 }
  const items = [{ tile, active: true, layer: 0 }]
  const moved = { ...doc, nodes: { ...doc.nodes, [root.id]: { ...root, transform: [1, 0, 0, 1, .1, 0] as typeof root.transform } } }
  const callback = vi.fn(() => ({ x: .1, y: 0 })), cold = new PageTranslation(vi.fn(), callback)
  expect(cold.prepare({ ...props, document: moved }, doc.pages[0].id, doc, items, doc, true)).toBe(false)
  expect(cold.handingOff).toBe(true)
  expect(callback).toHaveBeenCalledTimes(1)
  const warm = new PageTranslation(vi.fn(), callback)
  warm.prepare(props, doc.pages[0].id, doc, items, doc, true)
  warm.control.apply(doc, { [root.id]: { transform: [1, 0, 0, 1, 1 / 32, 0] } })
  const before = warm.items({ x: 0, y: 0, zoom: 32 })![0].placement
  warm.control.end(moved)
  expect(warm.handingOff).toBe(true)
  expect(callback).toHaveBeenCalledTimes(2)
  expect(warm.items({ x: 0, y: 0, zoom: 32 })![0].placement).toEqual(before)
})

test('a clipped opaque board follows retained tiles and fills the board instead of redrawing the scene', () => {
  const doc = blank(), board = node('frame', 0, 0, 1000, 400), other = node('frame', 2000, 0, 80, 80)
  for (const root of [board, other]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  doc.pages[0].children = [board.id, other.id]
  const pageId = doc.pages[0].id
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    control: { current: null }, onReady() {} }
  const tile = { key: 'visible', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1 }
  const items = [{ tile, active: true, layer: 0 }]
  const camera = { view: { x: 0, y: 0, zoom: 1 }, width: 400, height: 300 }
  const native = vi.fn(() => null)
  const fill = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[3]>>(() => true)
  const movement = new PageTranslation(vi.fn(), native, undefined, fill)
  expect(movement.prepare(props, pageId, doc, items, doc, true)).toBe(false)
  expect(movement.prepare(props, pageId, doc, items, doc, true, false, camera)).toBe(true)
  expect(movement.mode).toBe('retained-board')
  const view = camera.view
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 40, 0] } })).toEqual({ x: 40, y: 0 })
  expect(native).not.toHaveBeenCalled()
  expect(fill).toHaveBeenCalledTimes(1)
  expect(fill.mock.calls[0][4]).toEqual({ x: 0, y: 0, width: 1000, height: 400 })
  const moved = movement.items(view)!
  expect(moved.every(item => item.tile === tile)).toBe(true)
  expect(moved.some(item => item.layer === 4)).toBe(true)
  const overlay = movement.overlay({ pixelGrid: false, transforms: { [board.id]: [1, 0, 0, 1, 0, 0] },
    selection: { corners: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 400 }, { x: 0, y: 400 }], handles: false, owners: [board.id] } })
  expect(overlay?.selection?.corners[0]).toEqual({ x: 40, y: 0 })
  expect(overlay?.selection?.corners[1]).toEqual({ x: 1040, y: 0 })
  expect(movement.repairMissingCoverage(1)).toBe(true)
  expect(native).not.toHaveBeenCalled()
  const wide = { ...tile, key: 'board', width: 1200 }
  expect(movement.prepare(props, pageId, doc, [{ tile: wide, active: true, layer: 0 }], doc, true, false, camera)).toBe(true)
  // Pointer is still down. Two stale rejections of the now-covered pose stay
  // on the retained path; a third uses the live scene.
  expect(movement.repairMissingCoverage(1)).toBe(false)
  expect(movement.repairMissingCoverage(1)).toBe(false)
  expect(movement.repairMissingCoverage(1)).toBe(true)
  expect(native).toHaveBeenCalledTimes(1)
  const held = new PageTranslation(vi.fn(), native, undefined, fill)
  expect(held.prepare(props, pageId, doc, items, doc, true, false, camera)).toBe(true)
  held.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 40, 0] } })
  const fail = fill.mock.calls.at(-1)![3]
  const committed = { ...doc, nodes: { ...doc.nodes, [board.id]: { ...board, transform: [1, 0, 0, 1, 40, 0] as typeof board.transform } } }
  held.control.end(committed)
  expect(held.handingOff).toBe(false)
  expect(held.items(view)).not.toBeNull()
  fail()
  expect(native).toHaveBeenCalledTimes(1)
  held.clear()
  fail()
  expect(native).toHaveBeenCalledTimes(1)
})

test('a clipped board returns to the live scene when the existing tile budget rejects the fill', () => {
  const doc = blank(), board = node('frame', 0, 0, 1000, 400), other = node('frame', 2000, 0, 80, 80)
  for (const root of [board, other]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  doc.pages[0].children = [board.id, other.id]
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    control: { current: null }, onReady() {} }
  const tile = { key: 'visible', serial: 1, gpuTile: 7, bytes: new Uint8Array(), x: -1, y: -1, width: 514, height: 514, zoom: 1 }
  const camera = { view: { x: 0, y: 0, zoom: 1 }, width: 400, height: 300 }
  const native = vi.fn(() => ({ x: -20, y: 0 }))
  const movement = new PageTranslation(vi.fn(), native, undefined, () => false)
  expect(movement.prepare(props, doc.pages[0].id, doc, [{ tile, active: true, layer: 0 }], doc, true, false, camera)).toBe(true)
  movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, -20, 0] } })
  expect(native).not.toHaveBeenCalled()
  expect(movement.repairMissingCoverage(1)).toBe(true)
  expect(native).toHaveBeenCalledTimes(1)
  expect(movement.handingOff).toBe(true)
  movement.clear()
  expect(movement.repairMissingCoverage(1)).toBe(false)
})

test('a clipped board reuses a finite pixel window and rebases when a move exposes a missing source', () => {
  const doc = blank()
  const board = node('frame', -400, 0, 800, 90)
  const neighbor = node('frame', 900, 0, 100, 90)
  for (const root of [board, neighbor]) {
    root.blend = 'normal'
    root.clip = true
    doc.nodes[root.id] = root
  }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing opaque paint')
  paint.color = 'color(srgb 0.8 0.9 1 / 1)'
  const page = doc.pages[0]
  page.children = [board.id, neighbor.id]
  const props: InteractionProps = { document: doc, selection: [board.id], active: false, epoch: 1,
    figmaBoardPreview: true, control: { current: null }, onReady() {} }
  const camera = { view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 90, dpr: 1 }
  // Deliberately smaller than the visible board so the viewport-coverage
  // fallback cannot satisfy the first prepare and the finite clipped window
  // is the only admitted source.
  const original = { key: 'viewport', serial: 1, gpuTile: 7, bytes: new Uint8Array(),
    x: 0, y: 0, width: 20, height: 20, zoom: 1 }
  const expanded = { ...original, key: 'expanded', serial: 2, gpuTile: 8, x: -257, y: -1, width: 614, height: 92 }
  const visible = [{ tile: original, active: true, layer: 0 }]
  const available = [{ tile: expanded, active: true, layer: 0 }]
  const rebase = vi.fn(() => null)
  const movement = new PageTranslation(vi.fn(), rebase)
  expect(movement.prepare(props, page.id, doc, visible, doc, true, false, camera)).toBe(false)
  expect(movement.prepare(props, page.id, doc, visible, doc, true, false, camera, available)).toBe(true)
  expect(movement.mode).toBe('retained-clipped-board')
  expect(movement.prepare({ ...props, active: true }, page.id, doc, [], undefined, true, false, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, -360, 0] } })).toEqual({ x: 40, y: 0 })
  expect(rebase).not.toHaveBeenCalled()
  expect(movement.prepare({ ...props, active: true }, page.id, doc, visible, doc, true, false, camera)).toBe(true)
  movement.acceptPresentedInput(movement.control.inputSequence!(), 0, true, [8])
  const before = movement.items(camera.view)
  const fractional: typeof board.transform = [1, 0, 0, 1, -359.75, .5]
  expect(movement.control.apply(doc, { [board.id]: { transform: fractional } })).toBeNull()
  expect(rebase).toHaveBeenCalledWith(doc, { [board.id]: { transform: fractional } }, doc, undefined)
  expect(movement.items(camera.view)).toEqual(before)
  expect(movement.handingOff).toBe(true)
  movement.clear()
  rebase.mockClear()
  expect(movement.prepare({ ...props, active: true }, page.id, doc, visible, doc, true, false, camera, available)).toBe(true)
  expect(movement.tiles).toEqual([expanded])
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, -75, 0] } })).toBeNull()
  expect(rebase).toHaveBeenCalledOnce()
  movement.clear()
  expect(movement.prepare(props, page.id, doc, visible, doc, true, false, camera, visible)).toBe(false)
})

test('clipped-board prefetch keeps exact native strips outside the viewport', () => {
  const camera = { view: { x: -1298.1000000000001, y: 271.29999999999995, zoom: .8 },
    width: 1143, height: 933, dpr: 2 }
  const source = clippedBoardSource({x:1617,y:-271,width:1440,height:1030},camera)!
  const phaseX = .7999999999997272, phaseY = .599999999999909
  const cell=(x:number)=>({key:String(x),x,y:-513,width:514,height:514,
    zoom:1.6,phaseX,phaseY,gutter:1})
  expect(tileOnBoardLattice(cell(4607), camera.view, camera.dpr)).toBe(true)
  expect(tileOnBoardLattice({ ...cell(4607), phaseX: phaseX + .125 }, camera.view, camera.dpr)).toBe(false)
  const strips = clippedBoardPrefetch(source, camera, [cell(2559),cell(4607)], 4)
  expect(strips).toHaveLength(2)
  expect(strips.every(tile=>tile.prefetch && tileOnBoardLattice(tile,camera.view,camera.dpr))).toBe(true)
  const left = phaseX - camera.view.x * camera.dpr
  const right = left + camera.width * camera.dpr
  expect(strips[0].x + strips[0].width - 1).toBe(left)
  expect(strips[1].x + 1).toBe(right)
})

test('clipped release bands cover the visible viewport on the ordinary tile lattice', () => {
  const view = { x: -1298.1000000000001, y: 271.29999999999995, zoom: .8 }
  const phase = { x: view.x * 2 - Math.floor(view.x * 2), y: view.y * 2 - Math.floor(view.y * 2) }
  const viewport = { x: -Math.floor(view.x * 2), y: -Math.floor(view.y * 2), w: 2286, h: 1866 }
  const bands = clippedCommitTiles(viewport, view.zoom * 2, phase)!
  expect(bands).toHaveLength(6)
  expect(bands.every(tile => tile.gutter === 1 && tileOnBoardLattice(tile, view, 2))).toBe(true)
  expect(bands.map(tile => [tile.x - viewport.x + 1, tile.y - viewport.y + 1, tile.width - 2, tile.height - 2]))
    .toEqual([[0, 0, 960, 960], [960, 0, 960, 960], [1920, 0, 366, 960],
      [0, 960, 960, 906], [960, 960, 960, 906], [1920, 960, 366, 906]])
  expect(clippedCommitTiles({ ...viewport, x: viewport.x + .1 }, view.zoom * 2, phase)).toBeUndefined()
  expect(clippedCommitTiles({ ...viewport, w: 8193 }, view.zoom * 2, phase)).toBeUndefined()
})

test('a fully visible isolated board can use the exact release bands at the same camera', () => {
  const doc = blank()
  const board = node('frame', 0, 0, 80, 70)
  const neighbor = node('frame', 180, 0, 40, 70)
  for (const root of [board, neighbor]) {
    root.blend = 'normal'
    root.clip = true
    doc.nodes[root.id] = root
  }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing opaque paint')
  paint.color = 'color(srgb 0.8 0.9 1 / 1)'
  const page = doc.pages[0]
  page.children = [board.id, neighbor.id]
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    figmaBoardPreview: true, control: { current: null }, onReady() {} }
  const camera = { view: { x: 10, y: 10, zoom: .75 }, width: 140, height: 120, dpr: 2 }
  const tile = { key: 'viewport', serial: 1, gpuTile: 7, bytes: new Uint8Array(),
    x: -24, y: -24, width: 284, height: 244, zoom: 1.5 }
  const items = [{ tile, active: true, layer: 0 }]
  const movement = new PageTranslation(vi.fn())
  const transform: typeof board.transform = [1, 0, 0, 1, 11, 3]
  const committed = { ...doc, nodes: { ...doc.nodes, [board.id]: { ...board, transform } } }
  expect(movement.prepare(props, page.id, doc, items, doc, true, false, camera)).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform } })).toEqual({ x: 11, y: 3 })
  expect(movement.mode).toBe('retained-board')
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(false)
  movement.control.releaseInput?.('move')
  movement.control.end(committed)
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(true)
  movement.control.end(committed)
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(true)
  expect(movement.control.boardCommit?.(doc, page.id, camera)).toBe(false)
  expect(movement.control.boardCommit?.(committed, page.id, { ...camera, width: 141 })).toBe(false)
  movement.clear()
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(false)
})

test('a released clipped board never starts native drag repair from a late coverage miss', () => {
  const doc = blank()
  const board = node('frame', -400, 0, 800, 90)
  const neighbor = node('frame', 900, 0, 100, 90)
  for (const root of [board, neighbor]) {
    root.blend = 'normal'
    root.clip = true
    doc.nodes[root.id] = root
  }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing opaque paint')
  paint.color = 'color(srgb 0.8 0.9 1 / 1)'
  const page = doc.pages[0]
  page.children = [board.id, neighbor.id]
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    figmaBoardPreview: true, control: { current: null }, onReady() {} }
  const camera = { view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 90, dpr: 1 }
  const tile = { key: 'expanded', serial: 1, gpuTile: 7, bytes: new Uint8Array(),
    x: -257, y: -1, width: 614, height: 92, zoom: 1 }
  const rebase = vi.fn(() => null)
  const movement = new PageTranslation(vi.fn(), rebase)
  expect(movement.prepare(props, page.id, doc, [], doc, true, false, camera,
    [{ tile, active: true, layer: 0 }])).toBe(true)
  const transform: typeof board.transform = [1, 0, 0, 1, -360, 0]
  expect(movement.control.apply(doc, { [board.id]: { transform } })).toEqual({ x: 40, y: 0 })
  const sequence = movement.control.inputSequence!()
  expect(movement.control.boardCommit?.(doc, page.id, camera)).toBe(false)
  movement.control.releaseInput?.('move')
  const committed = { ...doc, nodes: { ...doc.nodes, [board.id]: { ...board, transform } } }
  movement.control.end(committed)
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(true)
  expect(movement.control.boardCommit?.({ ...committed }, page.id, camera)).toBe(false)
  expect(movement.control.boardCommit?.(committed, 'another-page', camera)).toBe(false)
  expect(movement.control.boardCommit?.(committed, page.id, { ...camera, dpr: 2 })).toBe(false)
  expect(movement.repairMissingCoverage(sequence)).toBe(false)
  expect(movement.control.apply(doc, { [board.id]: { transform } })).toBeNull()
  expect(movement.items(camera.view)).not.toBeNull()
  // A resize can invalidate the retained crop while exact tiles are pending.
  expect(movement.prepare({ ...props, active: false, document: committed }, page.id,
    committed, [], undefined, true, false, { ...camera, width: 120 })).toBe(false)
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(false)
  expect(rebase).not.toHaveBeenCalled()
})

/** A clipped 1440-wide board seen through a 1143×800 Retina viewport. The
 * certified window is the visible board plus a half native cell of margin. */
function clippedBoardFixture() {
  const doc = blank(), board = node('frame', 20, 30, 1440, 1030), other = node('frame', 1600, 30, 40, 40)
  for (const root of [board, other]) { root.blend = 'normal'; root.clip = true; doc.nodes[root.id] = root }
  const paint = board.fills[0]
  if (paint.kind !== 'solid') throw Error('Missing opaque paint')
  paint.color = 'color(srgb 0.86 0.91 0.94 / 1)'
  const page = doc.pages[0]
  page.children = [board.id, other.id]
  const camera = { view: { x: 0, y: 0, zoom: 1.25 }, width: 1143, height: 800, dpr: 2 }
  const source = clippedBoardSource({ x: 20, y: 30, width: 1440, height: 1030 }, camera)!
  const tile = { key: 'crop', serial: 1, gpuTile: 9, bytes: new Uint8Array(),
    x: Math.floor(source.x * 2.5) - 1, y: Math.floor(source.y * 2.5) - 1,
    width: Math.ceil((source.x + source.width) * 2.5) - Math.floor(source.x * 2.5) + 2,
    height: Math.ceil((source.y + source.height) * 2.5) - Math.floor(source.y * 2.5) + 2,
    zoom: 2.5, gutter: 1 }
  const props: InteractionProps = { document: doc, selection: [board.id], active: true, epoch: 1,
    figmaBoardPreview: true, control: { current: null }, onReady() {} }
  return { doc, board, page, camera, source, tile, props }
}

test('a certified clipped crop suppresses the wide page fill while it covers the pose', () => {
  const { doc, board, page, camera, tile, props } = clippedBoardFixture()
  const fill = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[3]>>(() => true)
  const native = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(() => ({ x: .2, y: 0 }))
  const movement = new PageTranslation(vi.fn(), native, undefined, fill)
  expect(movement.prepare(props, page.id, doc, [], doc, true, true, camera, [{ tile, active: true, layer: 0 }])).toBe(true)
  expect(movement.mode).toBe('retained-clipped-board')
  const first = movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20.4, 30.8] } })!
  expect(first.x).toBeCloseTo(.4, 9)
  expect(first.y).toBeCloseTo(.8, 9)
  const baseline = movement.items(camera.view)
  expect(baseline).not.toBeNull()
  // `FUTUREOX_CLIPPED_SAMPLES` scales the fixed input replay for the CPU
  // microbenchmark; the default stays at the contract's 40 in-crop samples.
  const steps = Math.max(1, Math.min(4000, Number(process.env.FUTUREOX_CLIPPED_SAMPLES) || 40))
  const samples = performance.now()
  // Every sample stays inside the certified window (the board is 1440 wide and
  // the window keeps a 102-pixel physical margin): no page fill may start.
  for (let step = 1; step <= steps; step++) {
    // A held drag jitters back and forth inside the certified margin. Every
    // sample is a whole physical pixel at 250%, so each one must stay on the
    // retained lattice without asking the page budget for the 1440px board.
    const offset = (step % 2 ? 1 : -1) * (Math.ceil(step / 2) % 20 + 1) * .4
    const applied = movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20 + offset, 30] } })
    expect(applied).not.toBeNull()
    expect(applied!.x).toBeCloseTo(offset, 9)
    expect(applied!.y).toBe(0)
    expect(movement.items(camera.view)).not.toBeNull()
  }
  const sampleMs = (performance.now() - samples) / steps
  expect(fill).not.toHaveBeenCalled()
  expect(native).not.toHaveBeenCalled()
  expect(movement.handingOff).toBe(false)
  console.info(`[issue-817] ${steps} in-crop clipped samples: page fills 0, native rebases 0, ${sampleMs.toFixed(3)} ms/sample`)
  // Leaving the certified window still hands the pose to the live scene on the
  // original lattice; suppression never turns into a lost frame.
  const leaving: typeof board.transform = [1, 0, 0, 1, -400, 30]
  // Rebase forwards the native callback's feedback for the new pose.
  expect(movement.control.apply(doc, { [board.id]: { transform: leaving } })).toEqual({ x: .2, y: 0 })
  expect(native).toHaveBeenCalledOnce()
  expect(native.mock.calls[0][1][board.id].transform).toEqual(leaving)
  expect(fill).not.toHaveBeenCalled()
})

test('a refused covered clipped pose keeps two stale receipts before the live scene owns it', () => {
  const { doc, board, page, camera, tile, props } = clippedBoardFixture()
  const fill = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[3]>>(() => true)
  const rebase = vi.fn(() => null)
  const movement = new PageTranslation(vi.fn(), rebase, undefined, fill)
  expect(movement.prepare(props, page.id, doc, [], doc, true, true, camera, [{ tile, active: true, layer: 0 }])).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20.4, 30] } })).not.toBeNull()
  const sequence = movement.control.inputSequence!()
  expect(movement.repairMissingCoverage(sequence)).toBe(false)
  expect(movement.repairMissingCoverage(sequence)).toBe(false)
  expect(movement.repairMissingCoverage(sequence)).toBe(true)
  expect(rebase).toHaveBeenCalledOnce()
  expect(fill).not.toHaveBeenCalled()
})

test('whole physical steps with float noise stay resident and true half pixels hand off to native', () => {
  const { doc, board, page, camera, tile, props } = clippedBoardFixture()
  const native = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(() => ({ x: .2, y: 0 }))
  const movement = new PageTranslation(vi.fn(), native)
  expect(movement.prepare(props, page.id, doc, [], doc, true, true, camera, [{ tile, active: true, layer: 0 }])).toBe(true)
  // 0.4 and 0.8 document units are exactly 1 and 2 physical pixels at 250%.
  // `20.4 - 20` evaluates to 0.3999999999999986, so the lattice test needs the
  // physical tolerance rather than an exact integer comparison.
  const whole = movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20.4, 30.8] } })!
  expect(whole.x).toBeCloseTo(.4, 9)
  expect(whole.y).toBeCloseTo(.8, 9)
  expect(native).not.toHaveBeenCalled()
  expect(movement.items(camera.view)).not.toBeNull()
  // 0.2 units is half a physical pixel; only the native renderer can carry it.
  const fractional: typeof board.transform = [1, 0, 0, 1, 20.2, 30]
  const handed = movement.control.apply(doc, { [board.id]: { transform: fractional } })!
  expect(handed.x).toBeCloseTo(.2, 9)
  expect(handed.y).toBe(0)
  expect(native).toHaveBeenCalledWith(doc, { [board.id]: { transform: fractional } }, doc, undefined)
  expect(movement.handingOff).toBe(true)
})

test('a released clipped pose commits once, then ignores samples and undo clears it', () => {
  const { doc, board, page, camera, tile, props } = clippedBoardFixture()
  const native = vi.fn<NonNullable<ConstructorParameters<typeof PageTranslation>[1]>>(() => ({ x: .2, y: 0 }))
  const movement = new PageTranslation(vi.fn(), native)
  expect(movement.prepare(props, page.id, doc, [], doc, true, true, camera, [{ tile, active: true, layer: 0 }])).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 21.2, 30] } })!.x).toBeCloseTo(1.2, 9)
  const held = movement.items(camera.view)
  expect(held).not.toBeNull()
  movement.control.releaseInput?.('move')
  const committed = { ...doc, nodes: { ...doc.nodes, [board.id]: { ...board, transform: [1, 0, 0, 1, 21.2, 30] as typeof board.transform } } }
  movement.control.end?.(committed)
  expect(movement.control.boardCommit?.(committed, page.id, camera)).toBe(true)
  expect(movement.items(camera.view)).not.toBeNull()
  // The certified input is closed: no later sample may move this frame.
  expect(movement.control.apply(committed, { [board.id]: { transform: [1, 0, 0, 1, 24.2, 30] } })).toBeNull()
  expect(native).not.toHaveBeenCalled()
  movement.clear()
  expect(movement.control.apply(committed, { [board.id]: { transform: [1, 0, 0, 1, 24.2, 30] } })).toBeNull()
  // Undo returns the authored pose: no offset means no retained frame.
  expect(movement.prepare(props, page.id, doc, [], doc, true, true, camera, [{ tile, active: true, layer: 0 }])).toBe(true)
  expect(movement.control.apply(doc, { [board.id]: { transform: [1, 0, 0, 1, 20, 30] } })).toEqual({ x: 0, y: 0 })
  movement.control.end?.(doc)
  expect(movement.items(camera.view)).toBeNull()
  expect(movement.control.boardCommit?.(doc, page.id, camera)).toBe(false)
})
