import { afterEach, expect, test, vi } from 'vitest'
import {compositeDrawPlan} from './composite-draw-plan'
import { residentFrameMessage, residentFrameSignature } from './resident-frame'
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
