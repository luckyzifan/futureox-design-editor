import { expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { PageTranslation, isolatedOpaqueBoard } from './page-translation'
import type { InteractionProps } from './interaction-layers'
import { compositeDrawPlan } from './gpu/composite-draw-plan'

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
  expect(fallback).toHaveBeenCalledWith(doc,expect.anything(),doc)
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
