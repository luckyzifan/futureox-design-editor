import { expect, test } from 'vitest'
import { progressiveTileLayer } from './progressive-quality'
import { compositeDrawPlan } from './gpu/composite-draw-plan'
import { presentationQuality } from './gpu/presentation-quality'
import type { CompositeItem } from './gpu/tile-compositor'
import {tileHasNativePhase} from './tile-preview'

const view = { x: 0, y: 0, zoom: 1 }

test('exact-phase native history fills before denser resampling, and current native pixels remain first',()=>{
  const native=item(101,1,false),denser=item(102,2,false),fresh=item(103,1,true)
  const layer=(fine:boolean,nativePhase:boolean)=>progressiveTileLayer({fine,cached:!fine,coarse:false,
    sameContent:true,refining:true,cameraDependent:false,nativeDensity:true,nativePhase})
  native.layer=layer(false,true);denser.layer=layer(false,false);fresh.layer=layer(true,true)
  expect(compositeDrawPlan([native,denser],view,100,100).map(row=>row.item.tile.serial)).toEqual([101])
  expect(compositeDrawPlan([native,denser,fresh],view,100,100).map(row=>row.item.tile.serial)).toEqual([103])
  expect(layer(false,true)).toBeGreaterThan(layer(false,false))
  expect(progressiveTileLayer({fine:false,cached:true,coarse:false,sameContent:false,refining:true,
    cameraDependent:false,nativeDensity:true,nativePhase:true})).toBeLessThan(native.layer)
  expect(progressiveTileLayer({fine:false,cached:true,coarse:false,sameContent:true,refining:true,
    cameraDependent:true,nativeDensity:true,nativePhase:true})).toBeLessThan(native.layer)
})

test('native-phase priority rejects fractional placement and both lower/higher sampling densities',()=>{
  const camera={x:.125,y:.375,zoom:4},dpr=2
  const tile={key:'phase',x:-1,y:-1,width:514,height:514,zoom:8,phaseX:.25,phaseY:.75}
  expect(tileHasNativePhase(tile,camera,dpr)).toBe(true)
  expect(tileHasNativePhase(tile,{...camera,x:camera.x+3},dpr)).toBe(true)
  expect(tileHasNativePhase(tile,{...camera,x:camera.x+.125},dpr)).toBe(false)
  for(const zoom of [4,16,NaN])expect(tileHasNativePhase({...tile,zoom},camera,dpr)).toBe(false)
  expect(tileHasNativePhase({...tile,phaseX:0},camera,dpr)).toBe(false)
  expect(tileHasNativePhase(tile,camera,0)).toBe(false)
})
const item = (serial: number, density: number, fine: boolean, sameContent = true, cameraDependent = false): CompositeItem => ({
  active: true, gutter: 0,
  layer: progressiveTileLayer({ fine, cached: !fine && sameContent, coarse: false, refining: true, sameContent, cameraDependent }),
  placement: { left: 0, top: 0, width: 100, height: 100 },
  tile: { serial, key: String(serial), x: 0, y: 0, width: density * 100, height: density * 100, zoom: density, bytes: new Uint8Array() },
})
test('a late low-density tile cannot obscure a sharper resident during zoom reversal', () => {
  const high = item(1, 4, false), low = item(2, 1, true)
  expect(compositeDrawPlan([high, low], view, 100, 100).map(row => row.item.tile.serial)).toEqual([1])
  expect(presentationQuality([high, low], view, 100, 100, 2).sharpCoverage).toBe(1)
})
test('higher density fills only its covered area, retaining lower-density coverage in the gaps', () => {
  const high = { ...item(1, 4, false), clip: { left: 25, top: 25, width: 50, height: 50 } }, low = item(2, 1, true)
  const rows = compositeDrawPlan([high, low], view, 100, 100)
  expect(rows.filter(row => row.item === low)).toHaveLength(4)
  expect(rows.reduce((sum, row) => sum + (row.clip.right - row.clip.left) * (row.clip.bottom - row.clip.top), 0)).toBe(10000)
})
test('current native density replaces oversampled history instead of pinning its fragments forever',()=>{
  const old=item(1,4,false),native=item(2,2,true)
  native.layer=progressiveTileLayer({fine:true,cached:false,coarse:false,refining:true,sameContent:true,cameraDependent:false,nativeDensity:true})
  expect(compositeDrawPlan([old,native],view,100,100).map(row=>row.item.tile.serial)).toEqual([2])
  expect(presentationQuality([old,native],view,100,100,2).sharpCoverage).toBe(1)
  const partial={...native,clip:{left:25,top:25,width:50,height:50}}
  const rows=compositeDrawPlan([old,partial],view,100,100)
  expect(rows.filter(row=>row.item===old)).toHaveLength(4)
  expect(rows.filter(row=>row.item===partial)).toHaveLength(1)
  expect(rows.reduce((sum,row)=>sum+(row.clip.right-row.clip.left)*(row.clip.bottom-row.clip.top),0)).toBe(10000)
})
test('native density alone cannot promote an obsolete plan or a sub-native current tile',()=>{
  const old=item(1,4,false),low=item(2,1,true)
  low.layer=progressiveTileLayer({fine:true,cached:false,coarse:false,refining:true,sameContent:true,cameraDependent:false,nativeDensity:false})
  expect(compositeDrawPlan([old,low],view,100,100).map(row=>row.item.tile.serial)).toEqual([1])
  expect(progressiveTileLayer({fine:false,cached:true,coarse:false,refining:true,sameContent:true,cameraDependent:false,nativeDensity:true})).toBe(2)
})
test('new document pixels and pixel-exact modes retain content priority over obsolete sharp textures', () => {
  expect(compositeDrawPlan([item(1, 4, false, false), item(2, 1, true)], view, 100, 100).map(row => row.item.tile.serial)).toEqual([2])
  expect(compositeDrawPlan([item(1, 4, false, true, true), item(2, 1, true, true, true)], view, 100, 100).map(row => row.item.tile.serial)).toEqual([2])
})
