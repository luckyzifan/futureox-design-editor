/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking, kernelHit } from './kernel/picking'
import { PencilInput, freehandNode, fitFreehand, defaultPencil, defaultBrush } from './freehand'
import { blank, uid, validateDocument } from './model'
import { Editor } from './engine'
import { freehandFixture } from './freehand-fixtures'
beforeAll(async () =>
  initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  }),
)
const event = (x: number, y: number, pressure = 0.5, pointerType = 'pen', pointerId = 1) => ({
  clientX: x,
  clientY: y,
  pressure,
  pointerId,
  pointerType,
})
const map = (p: { clientX: number; clientY: number }) => ({
  x: (p.clientX - 100) / 2,
  y: (p.clientY - 40) / 2,
})
test('coalesced samples preserve pen pressure and pointer ownership through transforms', () => {
  const input = new PencilInput(1, true)
  input.append(
    [
      event(100, 40, 0.1),
      event(110, 42, 0.8),
      event(140, 70, 0.6),
      event(1000, 1000, 0.9, 'pen', 2),
    ],
    map,
  )
  expect(input.samples).toEqual([
    { x: 0, y: 0, pressure: 0.1 },
    { x: 5, y: 1, pressure: 0.8 },
    { x: 20, y: 15, pressure: 0.6 },
  ])
})
test('mouse and disabled pressure produce uniform strokes', () => {
  const input = new PencilInput(1, true)
  input.append([event(0, 0, 0, 'mouse'), event(20, 10, 1, 'mouse')], map)
  expect(input.samples.every((s) => s.pressure === 0.5)).toBe(true)
  const n = freehandNode(
    uid(),
    [
      { x: 0, y: 0, pressure: 0 },
      { x: 100, y: 0, pressure: 1 },
    ],
    { ...defaultPencil(), pressure: false },
    1,
  )
  expect(n.strokes[0].widthProfile).toBeUndefined()
  expect(n.strokes[0].width).toBe(1)
})
test('pointer release zero does not collapse the last measured pressure', () => {
  const input = new PencilInput(1, true)
  input.append([event(0, 0, 0.8), event(10, 0, 0.6)], map)
  input.append([event(15, 0, 0)], map, true)
  expect(input.samples.at(-1)?.pressure).toBe(0.6)
})
test('input limits fail explicitly without unbounded accumulation', () => {
  const input = new PencilInput(1, true)
  input.append(
    Array.from({ length: 8192 }, (_, i) => event(i, 0)),
    map,
  )
  expect(() => input.append([event(8191, 0, 0)], map, true)).not.toThrow()
  expect(() => input.append([event(8193, 0)], map)).toThrow(/8192/)
  expect(input.samples).toHaveLength(8192)
})
test('single-click dab matches the width and pressure and survives persistence', () => {
  const n = freehandNode(
    uid(),
    [{ x: 50, y: 70, pressure: 0.75 }],
    { ...defaultBrush(), width: 20 },
    1,
  )
  expect(n.kind).toBe('ellipse')
  expect(n.width).toBe(30)
  expect(n.transform.slice(4)).toEqual([35, 55])
  const d = blank()
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  expect(() => validateDocument(d)).not.toThrow()
})
test('one complete gesture creates exactly one undoable object', () => {
  const e = new Editor(blank()),
    n = freehandNode(
      uid(),
      [
        { x: 50, y: 50, pressure: 0.1 },
        { x: 150, y: 50, pressure: 0.9 },
      ],
      defaultPencil(),
      1,
    )
  e.addFreehand(n)
  expect(e.state.selection).toEqual([n.id])
  expect(e.state.doc.nodes[n.id].network?.edges.length).toBe(1)
  e.undo()
  expect(Object.keys(e.state.doc.nodes)).toHaveLength(0)
  expect(e.canUndo).toBe(false)
  e.redo()
  expect(e.state.doc.nodes[n.id].strokes).toEqual(n.strokes)
})
test('recorded freehand fixture produces serializable editable vector networks', () => {
  const d = freehandFixture()
  expect(() => validateDocument(JSON.parse(JSON.stringify(d)))).not.toThrow()
  for (const n of Object.values(d.nodes).filter((n) => n.kind === 'vector'))
    expect(n.network!.edges.every((e) => e.c1 && e.c2)).toBe(true)
})
test('WASM preserves pressure peaks and hit testing follows the widened curve', () => {
  const samples = Array.from({ length: 101 }, (_, i) => ({
    x: i,
    y: 0,
    pressure: 1 - Math.abs(i - 50) / 50,
  }))
  const f = fitFreehand(samples, 0.5)
  expect(f.network.edges).toHaveLength(1)
  expect(f.widthProfile).toHaveLength(3)
  const n = freehandNode(uid(), samples, { ...defaultBrush(), width: 20 }, 1, 'brush')
  expect(kernelHit(n, { x: 50, y: 18 }, 0)).toBe(true)
  expect(kernelHit(n, { x: 5, y: 8 }, 0)).toBe(false)
})

test('pencil and brush keep independent settings and share the existing vector/stroke model', () => {
  const editor = new Editor(blank())
  expect(editor.state.pencil).toEqual({ width:1, color:'#000000', smoothing:0.8, pressure:false })
  expect(editor.state.brush).toEqual({ width:12, color:'#7451ca', smoothing:0.8, pressure:true })
  editor.set({ pencil:{...editor.state.pencil,width:3,color:'#112233'} })
  expect(editor.state.brush.width).toBe(12)
  const samples=[{x:0,y:0,pressure:0.1},{x:100,y:0,pressure:0.9}]
  const pencil=freehandNode(uid(),samples,{...defaultBrush(),width:1,color:'#000000'},1,'pencil')
  expect(pencil.kind).toBe('vector');expect(pencil.strokes[0].widthProfile).toBeUndefined()
  expect(pencil.strokes[0].width).toBe(1);expect(pencil.strokes[0].paint.color).toBe('#000000')
  const brush=freehandNode(uid(),samples,defaultBrush(),1,'brush')
  expect(brush.kind).toBe('vector');expect(brush.strokes[0].widthProfile?.map(point=>point.left)).toEqual([0.2,1.8])
})

test('Shift starts an exact straight segment and releasing Shift resumes freehand at its endpoint', () => {
  const input=new PencilInput(1,false),identity=(p:{clientX:number;clientY:number})=>({x:p.clientX,y:p.clientY})
  input.append([event(0,0),event(10,10)],identity)
  input.append([event(20,20),event(30,10)],identity,false,true)
  expect(input.samples).toEqual([{x:0,y:0,pressure:0.5},{x:10,y:10,pressure:0.5},{x:20,y:10,pressure:0.5},{x:30,y:10,pressure:0.5}])
  input.append([event(40,20)],identity,false,false)
  expect(input.samples.at(-1)).toEqual({x:40,y:20,pressure:0.5})
  expect(input.samples[1]).toEqual({x:10,y:10,pressure:0.5})
})

test('Shift retains interior pressure peaks for the Rust fitter instead of reducing a brush stroke to endpoint pressure', () => {
  const input=new PencilInput(1,true),identity=(p:{clientX:number;clientY:number})=>({x:p.clientX,y:p.clientY})
  input.append([event(0,0,0.1),event(10,8,0.9),event(20,-4,0.4),event(30,0,0.6)],identity,false,true)
  expect(input.samples.map(sample=>sample.y)).toEqual([0,0,0,0])
  expect(input.samples.map(sample=>sample.pressure)).toEqual([0.1,0.9,0.4,0.6])
  const fitted=fitFreehand(input.samples,0.2)
  expect(fitted.network.edges).toHaveLength(1)
  expect(Math.max(...fitted.widthProfile.map(point=>point.left))).toBe(1.8)
  input.append([event(30,0,0)],identity,true,true)
  expect(input.samples.at(-1)?.pressure).toBe(0.6)
})

test('foreign pointers cannot toggle a straight segment and straight samples retain the same budget', () => {
  const input=new PencilInput(1,true),identity=(p:{clientX:number;clientY:number})=>({x:p.clientX,y:p.clientY})
  input.append([event(0,0),event(10,8)],identity,false,true)
  input.append([event(20,200,0.5,'pen',2)],identity,false,false)
  input.append([event(20,0)],identity,false,true)
  expect(input.samples.map(sample=>sample.y)).toEqual([0,0,0])
  const bounded=new PencilInput(1,false)
  bounded.append(Array.from({length:8192},(_,i)=>event(i,0)),identity,false,true)
  expect(()=>bounded.append([event(8193,0)],identity,false,true)).toThrow('8192')
})
