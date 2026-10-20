import { expect, test } from 'vitest'
import shader from './prefix-int128.wgsl?raw'
import {
  divisionCases, mask128, quotientCases, quotientExpectation, roundFraction, wideExpectation,
} from '../../../scripts/exact-prefix-division-vectors'

type Division={remainder:bigint;quotient:number;accepted:number}
type Helpers={
  prefix_try_quotient(numerator:bigint,divisor:bigint,estimate:number):Division
  prefix_divide_fast(numerator:bigint,divisor:bigint):Division
  prefix_round_ratio(input:bigint,denominator:number,quantum:number):number[]
  prefix_round_wide(input:bigint,denominator:bigint,quantum:number):number[]
}
const wrap=(value:bigint)=>value&mask128
const high=(value:bigint)=>value===0n?-1:value.toString(2).length-1
function productionFunction(name:string){
  const start=shader.indexOf(`fn ${name}(`)
  if(start<0)throw Error(`Missing production function ${name}`)
  const open=shader.indexOf('{',start)
  let close=open+1,depth=1
  for(;depth&&close<shader.length;close++){
    if(shader[close]==='{')depth++
    else if(shader[close]==='}')depth--
  }
  if(depth)throw Error(`Unclosed production function ${name}`)
  const signature=shader.slice(start,open),argumentsText=signature.slice(signature.indexOf('(')+1,signature.indexOf(')'))
    .split(',').map(argument=>argument.split(':')[0]).join(',')
  const body=shader.slice(open+1,close-1)
    .replace(/\bvar\b/g,'let')
    .replace(/\b(0x[0-9a-f]+|\d+)u\b/gi,'$1')
    .replace(/vec2<u32>/g,'vec2u')
    .replace(/\b(\w+)\.([xyzw])\b/g,(_match,value,axis)=>`word(${value},${'xyzw'.indexOf(axis)})`)
    .replace('prefix_float(numerator)/prefix_float(divisor)','f32(prefix_float(numerator)/prefix_float(divisor))')
  return `function ${name}(${argumentsText}){${body}}`
}
function helpers(forceDecline=false):Helpers{
  // Execute the actual production correction and rounding control flow. The
  // unchanged multiword primitives are supplied as exact BigInt operations.
  const names=['prefix_float','prefix_try_quotient','prefix_divide_fast','prefix_round_ratio','prefix_round_wide']
  const functions=names.map(name=>forceDecline&&name==='prefix_divide_fast'
    ?'function prefix_divide_fast(numerator,divisor){return PrefixDivision(numerator,0,0)}'
    :productionFunction(name)).join('\n')
  const bindings={
    PrefixInt:(...words:number[])=>words.reduce((value,word,index)=>value|(BigInt(word>>>0)<<BigInt(index*32)),0n),
    PrefixDivision:(remainder:bigint,quotient:number,accepted:number)=>({remainder,quotient,accepted}),
    word:(value:bigint,index:number)=>Number((value>>BigInt(index*32))&0xffffffffn),
    prefix_high:high,
    prefix_add:(a:bigint,b:bigint)=>wrap(a+b),
    prefix_sub:(a:bigint,b:bigint)=>wrap(a-b),
    prefix_neg:(a:bigint)=>wrap(-a),
    prefix_mul_u32:(a:bigint,b:number)=>wrap(a*BigInt(b>>>0)),
    prefix_shl:(a:bigint,shift:number)=>shift>=128?0n:wrap(a<<BigInt(shift)),
    prefix_compare:(a:bigint,b:bigint)=>a<b?-1:a>b?1:0,
    vec2u:(a:number,b=a)=>[a>>>0,b>>>0],
    bsHigh:(value:number)=>31-Math.clz32(value),
    min:Math.min,max:Math.max,f32:Math.fround,u32:(value:number)=>value>>>0,i32:(value:number)=>value|0,
    all:(value:boolean)=>value,
  }
  return new Function(...Object.keys(bindings),`${functions};return {${names.join(',')}}`)(...Object.values(bindings))
}
const candidate=helpers(),fallback=helpers(true)

test('production bounded quotient correction certifies all accepted remainders against independent division',()=>{
  for(const item of quotientCases()){
    const actual=candidate.prefix_try_quotient(item.numerator,item.denominator,item.estimate)
    expect(actual).toEqual(quotientExpectation(item))
    if(actual.accepted){
      expect(actual.remainder).toBeGreaterThanOrEqual(0n)
      expect(actual.remainder).toBeLessThan(item.denominator)
      expect(BigInt(actual.quotient)*item.denominator+actual.remainder).toBe(item.numerator)
      expect(actual.quotient).toBeLessThan(0x1000000)
      expect(BigInt(actual.quotient)*item.denominator).toBeLessThan(1n<<127n)
    }
  }
})

test('wide rational outputs match independent exact RNE, including signed zero, half ULP and exponent limits',()=>{
  for(const item of divisionCases()){
    const input=wrap(item.numerator),actual=candidate.prefix_round_wide(input,item.denominator,item.quantum)
    expect(actual).toEqual(wideExpectation(item))
    expect(actual).toEqual(fallback.prefix_round_wide(input,item.denominator,item.quantum))
  }
})

test('ratio outputs retain the original long-division result and independent rational rounding',()=>{
  for(const denominator of [1,2,3,6,288,55296,1572864]){
    for(const quantum of [-149,-148,-126,-24,-23,0,103,104]){
      for(const mantissa of [0n,1n,2n,0x7fffffn,0x800000n,0x800001n,0xfffffen,0xffffffn]){
        for(const remainder of new Set([0n,BigInt(denominator)/2n,BigInt(denominator)-1n])){
          for(const sign of [1n,-1n]){
            const numerator=sign*(BigInt(denominator)*mantissa+remainder),input=wrap(numerator)
            const actual=candidate.prefix_round_ratio(input,denominator,quantum)
            expect(actual).toEqual(fallback.prefix_round_ratio(input,denominator,quantum))
            expect(actual).toEqual([roundFraction(numerator,BigInt(denominator),quantum),1])
          }
        }
      }
    }
  }
})

test('f32 quotient proposals can be inaccurate without becoming unproved output',()=>{
  const denominator=(1n<<95n)-19n
  for(const quotient of [0n,1n,0x7fffffn,0x800000n,0xffffffn]){
    const numerator=denominator*quotient+denominator/2n
    for(const offset of [-8,-1,0,1,8]){
      const estimate=Number(quotient)+offset
      if(estimate<0||estimate>16777216)continue
      const actual=candidate.prefix_try_quotient(numerator,denominator,estimate)
      expect(actual).toEqual(quotientExpectation({numerator,denominator,estimate}))
    }
    for(const estimate of [NaN,Infinity,-Infinity,-1,Number(quotient)+100])
      expect(candidate.prefix_try_quotient(numerator,denominator,estimate).accepted).toBe(0)
  }
})

test('both original 24-step fallbacks remain reachable when the certificate is declined',()=>{
  const ratio=productionFunction('prefix_round_ratio'),wide=productionFunction('prefix_round_wide')
  for(const source of [ratio,wide]){
    expect(source).toContain('if(candidate.accepted!=0)')
    expect(source).toContain('for(let bit=23;bit>=0;bit=bit-1)')
    expect(source).toContain('let comparison=prefix_compare(prefix_shl(remainder,1),divisor)')
  }
  // Valid inputs beyond the fast multiplier's conservative domain retain the
  // old helper result instead of accepting a wrapped product.
  expect(candidate.prefix_divide_fast(1n<<126n,1n<<102n).accepted).toBe(0)
  expect(candidate.prefix_divide_fast(1n,1n<<103n).accepted).toBe(0)
  expect(candidate.prefix_divide_fast(1n,0n).accepted).toBe(0)
})
