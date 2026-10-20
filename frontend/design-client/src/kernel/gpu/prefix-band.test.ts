import { expect, test } from 'vitest'
import { prefixAlignedStrip, prefixBandSize, PREFIX_BYTES, RESULT_BYTES, METADATA_BYTES } from './prefix-band'

test('3484-wide 117 support fills two 29-line bands within the original 64-row ceiling',()=>{
  expect(prefixBandSize(3484)).toBe(29)
  expect(prefixAlignedStrip(3484)).toBe(58)
  const bands=(rows:number,strip:number)=>{let count=0;for(let y=0;y<rows;y+=strip)count+=Math.ceil(Math.min(strip,rows-y)/29);return count}
  expect((bands(3484,64)+bands(1032,64))*4).toBe(848)
  expect((bands(3484,58)+bands(1032,58))*4).toBe(628)
})
test('every supported length stays inside all scratch planes and the strip ceiling',()=>{
 for(let length=1;length<=16384;length++){
  const band=prefixBandSize(length),strip=prefixAlignedStrip(length)
  expect(band*(length+1)*32).toBeLessThanOrEqual(PREFIX_BYTES)
  expect(band*length*8).toBeLessThanOrEqual(RESULT_BYTES)
  expect(band*16+16).toBeLessThanOrEqual(METADATA_BYTES)
  expect(strip).toBeGreaterThan(0);expect(strip).toBeLessThanOrEqual(64)
  if(band<=64)expect(strip%band).toBe(0)
 }
})
test('unsupported lengths preserve the bounded 64-row fallback',()=>{
 for(const length of [0,-1,NaN,Infinity,1.5,16385]){
  expect(prefixBandSize(length)).toBe(0);expect(prefixAlignedStrip(length)).toBe(64)
 }
})
