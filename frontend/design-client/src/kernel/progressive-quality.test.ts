import { expect, test } from 'vitest'
import { progressiveTileLayer } from './progressive-quality'
import { compositeDrawPlan } from './gpu/composite-draw-plan'
import { presentationQuality } from './gpu/presentation-quality'
import type { CompositeItem } from './gpu/tile-compositor'

const view = { x: 0, y: 0, zoom: 1 }
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
