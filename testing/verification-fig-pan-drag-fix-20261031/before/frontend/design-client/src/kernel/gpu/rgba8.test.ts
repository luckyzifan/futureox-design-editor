import {expect,test} from 'vitest'
import {solidRgba8,minifiedPreviewRgba8} from './rgba8'
test('half-byte solid paint agrees with the native premultiplied color contract',()=>{
  expect(solidRgba8([221/255,68/255,119/255],0.625).map(v=>Math.round(v*255))).toEqual([138,42,74,159])
})
test('all opaque gray levels survive solid-paint staging unchanged',()=>{
  for(let i=0;i<256;i++)expect(solidRgba8([i/255,i/255,i/255],1).map(v=>Math.round(v*255))).toEqual([i,i,i,255])
  expect(solidRgba8([1,0.5,0],0)).toEqual([0,0,0,0])
})
test('minified pixel preview preserves the CPU half-up ties at translucent boundaries',()=>{
  const bytes=new Uint8Array([36,72,108,136,0,0,0,0,12,34,56,255])
  expect(minifiedPreviewRgba8(bytes)).toBe(bytes)
  expect([...bytes]).toEqual([68,135,203,136,0,0,0,0,12,34,56,255])
})
