import { describe, it, expect } from 'vitest'
import { decodeNativeRenderPixels } from './native-render-session'
describe('native render pixel protocol', () => {
 it('preserves every byte for legacy and explicit raw pixels', () => {
  const raw = Uint8Array.from({length:256},(_,i)=>i)
  const legacy = btoa(String.fromCharCode(...raw))
  expect(decodeNativeRenderPixels({width:8,height:8,rgba:legacy})).toEqual(raw)
  expect(decodeNativeRenderPixels({width:8,height:8,rgba:raw,encoding:'rgba8'})).toBe(raw)
 })
 it('fails closed on unknown encoding or inconsistent dimensions', () => {
  const raw = new Uint8Array(4)
  for (const frame of [
   {width:1,height:1,rgba:raw,encoding:'future'},
   {width:1,height:1,rgba:raw},
   {width:1,height:1,rgba:'AAAAAA==',encoding:'rgba8'},
   {width:2,height:1,rgba:raw,encoding:'rgba8'},
   {width:0,height:1,rgba:raw,encoding:'rgba8'},
   {width:1.5,height:1,rgba:raw,encoding:'rgba8'},
  ]) expect(()=>decodeNativeRenderPixels(frame as never)).toThrow()
 })
})
