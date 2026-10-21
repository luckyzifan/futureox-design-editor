import { expect, test } from 'vitest'
import { imageTableQuarterWgsl } from './image-table-quarter'

// Execute the production integer body, not a second copy of its formula.
const body = imageTableQuarterWgsl.slice(imageTableQuarterWgsl.indexOf('{') + 1, imageTableQuarterWgsl.lastIndexOf('}'))
  .replace(/(0x[0-9a-f]+|\d+)u\b/g, '$1')
const quarter = new Function('bits', 'select', body) as (bits: number, select: (a: number,b: number,c: boolean) => number) => number
const select = (a: number,b: number,c: boolean) => c ? b : a
const words = new Uint32Array(1), floats = new Float32Array(words.buffer)
test('production quarter matches independent binary64 exact scale and f32 RNE, including gradual underflow', () => {
  let seed=0x6712a354, checked=0
  for(let exponent=0;exponent<255;exponent++) for(const sign of [0,0x80000000]) {
    const mantissas=[0,1,2,3,4,5,6,7,8,0x3fffff,0x400000,0x7ffff9,0x7ffffa,0x7ffffb,0x7ffffc,0x7ffffd,0x7ffffe,0x7fffff]
    for(let i=0;i<128;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;mantissas.push(seed&0x7fffff)}
    for(const mantissa of mantissas){
      const input=(sign|(exponent<<23)|mantissa)>>>0
      words[0]=input
      const value=floats[0]
      // Any finite f32 multiplied by 2^-2 is exact in binary64. The typed
      // write supplies independent IEEE binary32 RNE, with canonical input 0.
      floats[0]=(value===0?0:value)*0.25
      expect(quarter(input,select)>>>0,`bits ${input.toString(16)}`).toBe(words[0]);checked++
    }
  }
  expect(checked).toBe(74460)
})
