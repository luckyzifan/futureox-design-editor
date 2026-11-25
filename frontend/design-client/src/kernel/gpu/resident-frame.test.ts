import { afterEach, expect, test, vi } from 'vitest'
import {compositeDrawPlan} from './composite-draw-plan'
import { opaquePageClear } from '../../color'
import { anchorPlacementBox, measureAnchors } from '../../canvas-measurements'
import { overlayVertices } from './canvas-overlay'
import { opaqueByteClear, residentFrameMessage, residentFrameSignature } from './resident-frame'
import type { ResidentFrame } from './resident-presenter'
afterEach(()=>vi.unstubAllEnvs())
test('absolute layer renaming preserves the actual painter and clipping plan, but changed order never reuses it',()=>{
 vi.stubEnv('VITE_DESIGN_CANONICAL_COMPOSITE_ORDER','1')
 const frame:ResidentFrame={view:{x:0,y:0,zoom:1},width:100,height:100,dpr:1,items:[0,1,2].map((i)=>({
  active:true,layer:i===2?7:3,blend:i===2,gutter:0,tile:{key:String(i),serial:i,gpuTile:i+1,x:i*10,y:0,width:60,height:60,zoom:1},
 }))}
 const renamed={...frame,items:frame.items.map(item=>({...item,layer:item.layer===7?100:50}))}
 const plan=(f:ResidentFrame)=>compositeDrawPlan(f.items as any,f.view,f.width,f.height).map(({item,placement,clip})=>({id:item.tile.serial,placement,clip}))
 expect(plan(renamed)).toEqual(plan(frame))
 expect(residentFrameSignature(renamed)).toBe(residentFrameSignature(frame))
 const reordered={...renamed,items:renamed.items.map(item=>({...item,layer:item.layer===100?0:1}))}
 expect(plan(reordered)).not.toEqual(plan(frame));expect(residentFrameSignature(reordered)).not.toBe(residentFrameSignature(frame))
 expect(residentFrameSignature({...renamed,presentationId:'new-owner'})).not.toBe(residentFrameSignature(frame))
 expect(residentFrameSignature({...renamed,terminalQuality:{qualitySequence:1,qualityRevision:1,pageToken:1}})).not.toBe(residentFrameSignature(frame))
})
test('camera messages cannot carry document trees, pixels, or raster diagnostics', () => {
  const tile = {
    key: 'tile',
    serial: 1,
    gpuTile: 42,
    x: 0,
    y: 0,
    width: 514,
    height: 514,
    zoom: 2,
    document: { nodes: { large: { image: 'private-document-image'.repeat(50000) } } },
    bytes: new Uint8Array(514 * 514 * 4),
    passTimings: [{ ms: 123 }],
  }
  const frame = {
    presentationId: 'scope:12',
    view: { x: 10, y: 20, zoom: 1 },
    width: 800,
    height: 600,
    dpr: 2,
    items: [{ tile, active: true, layer: 1, clip: { left: 0, top: 0, width: 800, height: 600 } }],
  } as ResidentFrame
  const wire = residentFrameMessage(frame),
    encoded = JSON.stringify(wire)
  expect(encoded.length).toBeLessThan(512)
  expect(wire.items[0].tile).not.toHaveProperty('document')
  expect(wire.items[0].tile).not.toHaveProperty('bytes')
  expect(wire.items[0].tile).not.toHaveProperty('passTimings')
  expect(wire.items[0].tile.gpuTile).toBe(42)
  expect(wire.presentationId).toBe('scope:12')
  expect(wire.items[0].clip).toEqual(frame.items[0].clip)
})

test('translated background support survives the bounded wire and has its own presentation identity',()=>{
  const frame:ResidentFrame={view:{x:0,y:0,zoom:1},width:100,height:100,dpr:2,items:[],interaction:true,
    allowBackground:true,backgroundTranslation:{x:20,y:40}}
  const wire=residentFrameMessage(frame),signature=residentFrameSignature(frame)
  expect(wire.backgroundTranslation).toEqual({x:20,y:40})
  frame.backgroundTranslation!.x=30
  expect(wire.backgroundTranslation!.x).toBe(20)
  expect(residentFrameSignature(frame)).not.toBe(signature)
})

test('an opaque page fill is the 8-bit sRGB plate under a dragged layer', () => {
  expect(opaquePageClear('#ffffff')).toEqual([1, 1, 1, 1])
  expect(opaquePageClear('#f5f5f5')).toEqual([245 / 255, 245 / 255, 245 / 255, 1])
  expect(opaquePageClear('color(srgb 0.2 0.4 0.8)')).toEqual([51 / 255, 102 / 255, 204 / 255, 1])
  expect(opaquePageClear('color(srgb 1 1 1 / 1)')).toEqual([1, 1, 1, 1])
  for (const background of [undefined, '#fff', '#ffffff80', 'color(srgb 1 0 0 / 0.5)', 'color(display-p3 1 1 1)', 'color(srgb-linear 1 1 1)'])
    expect(opaquePageClear(background)).toBeUndefined()
})

test('an opaque page plate survives the display wire and rejects a fractional or non-finite clear', () => {
  const frame: ResidentFrame = { view: { x: 0, y: 0, zoom: 1 }, width: 16, height: 16, dpr: 1, items: [],
    allowEmpty: true, pageBackground: [1, 1, 1, 1] }
  const wire = residentFrameMessage(frame)
  expect(wire.pageBackground).toEqual([1, 1, 1, 1])
  expect(wire.pageBackground).not.toBe(frame.pageBackground)
  expect(residentFrameSignature({ ...frame, pageBackground: [0, 0, 0, 1] })).not.toBe(residentFrameSignature(frame))
  expect(residentFrameMessage({ ...frame, pageBackground: [1, 1, 1, 0.5] }).pageBackground).toBeUndefined()
  expect(opaqueByteClear([1, Number.NaN, 1, 1])).toBeUndefined()
  expect(residentFrameSignature(frame)).toBe(residentFrameSignature(residentFrameMessage(frame)))
})

test('the display wire keeps a vector placement rectangle dashed and leaves anchor distances unchanged', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  const placed = anchorPlacementBox({ x: 10, y: 20 }, { x: 90, y: 70 })
  const frame: ResidentFrame = {
    view, width: 400, height: 300, dpr: 1, items: [],
    overlay: { pixelGrid: false, measurements: placed.lines },
  }
  const wire = residentFrameMessage(frame)
  expect(wire.overlay?.measurements?.map(line => line.dash)).toEqual([true, true, true, true])
  const authored = overlayVertices(frame.overlay!, view, frame.width, frame.height)
  const drawn = overlayVertices(wire.overlay!, view, frame.width, frame.height)
  expect(Array.from(drawn)).toEqual(Array.from(authored))
  expect(drawn.length / 48).toBe(40)
  const top: number[] = []
  for (let quad = 0; quad < drawn.length; quad += 48) {
    const ys = [0, 1, 2, 3, 4, 5].map(vertex => drawn[quad + vertex * 8 + 1])
    const xs = [0, 1, 2, 3, 4, 5].map(vertex => drawn[quad + vertex * 8])
    if (Math.min(...ys) < 22 && Math.max(...ys) > 18 && Math.max(...ys) - Math.min(...ys) < 8)
      top.push(Math.max(...xs) - Math.min(...xs))
  }
  expect(Math.max(...top)).toBeLessThan(80)
  const anchors = measureAnchors({ x: 10, y: 20 }, { x: 90, y: 70 })
  const anchorFrame: ResidentFrame = { ...frame, overlay: { pixelGrid: false, measurements: anchors } }
  const anchorWire = residentFrameMessage(anchorFrame)
  expect(anchorWire.overlay?.measurements?.every(line => line.dash === undefined && line.tick === undefined)).toBe(true)
  expect(Array.from(overlayVertices(anchorWire.overlay!, view, 400, 300))).toEqual(
    Array.from(overlayVertices(anchorFrame.overlay!, view, 400, 300)))
  const withoutDash = {
    ...wire,
    overlay: {
      ...wire.overlay!,
      measurements: wire.overlay!.measurements!.map(line => ({ from: line.from, to: line.to, axis: line.axis })),
    },
  }
  expect(residentFrameSignature(wire)).not.toBe(residentFrameSignature(withoutDash))
})

test('the display wire preserves an opaque Figma measurement band', () => {
  const view = { x: 0, y: 0, zoom: 1 }
  const frame: ResidentFrame = { view, width: 160, height: 90, dpr: 1, items: [],
    overlay: { pixelGrid: false, crispMeasurements: true,
      measurements: [{ from: { x: 10, y: 20 }, to: { x: 40, y: 20 }, axis: 'horizontal' }] } }
  const wire = residentFrameMessage(frame)
  expect(wire.overlay?.crispMeasurements).toBe(true)
  expect(overlayVertices(wire.overlay!, view, frame.width, frame.height)[7]).toBe(-1)
})
