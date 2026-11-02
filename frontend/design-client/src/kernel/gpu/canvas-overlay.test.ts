import { expect, test } from 'vitest'
import { overlayVertices, translateOverlay } from './canvas-overlay'
import { SELECTION_BLUE, srgbUnit } from '../../selection-blue'
import { SPACING_RED } from '../../canvas-measurements'

const stored = (hex: string) => [...new Float32Array(srgbUnit(hex))]

test('selection uses f64 camera projection before narrowing screen coordinates', () => {
  const corners = [{ x: 1e7, y: -1e7 }, { x: 1e7 + 100, y: -1e7 }, { x: 1e7 + 100, y: -1e7 + 50 }, { x: 1e7, y: -1e7 + 50 }]
  const view = { x: -6e6 + .125, y: 6e6 + .375, zoom: .6 }
  const data = overlayVertices({ selection: { corners, handles: false }, pixelGrid: false }, view, 800, 600)
  expect(data.length).toBe(4 * 6 * 8)
  const mean = (axis: number) => Array.from({ length: 6 }, (_, i) => data[i * 8 + axis]).reduce((a,b) => a+b, 0) / 6
  // Precise projection is 0.125, 0.375. The stroke then snaps onto that pixel as a solid 1px row.
  expect(mean(0)).toBeCloseTo(30.5, 5)
  expect(mean(1)).toBeCloseTo(0.5, 5)
  expect(data[7]).toBe(-1)
})
test('grid is absent below four times zoom and remains bounded at high zoom', () => {
  expect(overlayVertices({ pixelGrid: true }, { x: .5, y: .5, zoom: 3.99 }, 1000, 720)).toHaveLength(0)
  const data = overlayVertices({ pixelGrid: true }, { x: -1e7 + .5, y: -1e7 + .5, zoom: 4 }, 1000, 720)
  expect(data.length).toBeGreaterThan(0)
  expect(data.length / 8).toBeLessThan(65536)
  expect([...data].every(Number.isFinite)).toBe(true)
})

test('spacing guides draw the gap plus six-pixel end ticks', () => {
  const data = overlayVertices({ pixelGrid: false, measurements: [{ from: { x: 10, y: 20 }, to: { x: 40, y: 20 }, axis: 'horizontal' }] }, { x: 0, y: 0, zoom: 2 }, 200, 200)
  expect(data.length / 8 / 6).toBe(3)
  expect([...data].every(Number.isFinite)).toBe(true)
  expect([data[2], data[3], data[4], data[5]]).toEqual(stored(SPACING_RED))
})

test('an axis-aligned selection edge is one solid pixel of selection blue', () => {
  const corners = [{ x: 10.2, y: 20.8 }, { x: 40.2, y: 20.8 }, { x: 40.2, y: 50.8 }, { x: 10.2, y: 50.8 }]
  const data = overlayVertices({ pixelGrid: false, selection: { corners, handles: false } }, { x: 0, y: 0, zoom: 1 }, 200, 200)
  const ys = Array.from({ length: 6 }, (_, i) => data[i * 8 + 1])
  expect(Math.min(...ys)).toBe(20)
  expect(Math.max(...ys)).toBe(21)
  expect(data[7]).toBe(-1)
  expect([data[2], data[3], data[4], data[5]]).toEqual(stored(SELECTION_BLUE))
})

test('the selection box uses the same blue as the DOM chrome', () => {
  const corners = [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 50 }, { x: 10, y: 50 }]
  const data = overlayVertices({ pixelGrid: false, selection: { corners, handles: true } }, { x: 0, y: 0, zoom: 1 }, 200, 200)
  expect([data[2], data[3], data[4], data[5]]).toEqual(stored(SELECTION_BLUE))
  expect(SELECTION_BLUE).toBe('#4597f7')
})

test('zero-size selections retain visible finite resize handles', () => {
  const data=overlayVertices({pixelGrid:false,selection:{corners:Array.from({length:4},()=>({x:10,y:20})),handles:true}}, {x:0,y:0,zoom:1}, 800,600)
  const xs=Array.from({length:data.length/8},(_,i)=>data[i*8]), ys=Array.from({length:data.length/8},(_,i)=>data[i*8+1])
  // A zero-length outline emits no segment. The visible span is the 8px corner square.
  expect(Math.max(...xs)-Math.min(...xs)).toBe(8)
  expect(Math.max(...ys)-Math.min(...ys)).toBe(8)
})

test('pose offsets move the selection and its labels but not unrelated chrome',()=>{
  const original={pixelGrid:false,selection:{corners:[{x:1,y:2}],handles:false,owners:['moving']},labels:[
    {anchor:{x:1,y:2},offset:{x:0,y:-12},text:'moving',size:11,color:'#000',owners:['moving','child']},
    {anchor:{x:50,y:60},offset:{x:0,y:-12},text:'fixed',size:11,color:'#000',owners:['fixed']} ]}
  const shifted=translateOverlay(original,new Map([['moving',{x:100,y:-20}]]))
  expect(shifted.selection?.corners).toEqual([{x:101,y:-18}])
  expect(shifted.labels?.map(l=>l.anchor)).toEqual([{x:101,y:-18},{x:50,y:60}])
  expect(original.selection.corners).toEqual([{x:1,y:2}])
})
