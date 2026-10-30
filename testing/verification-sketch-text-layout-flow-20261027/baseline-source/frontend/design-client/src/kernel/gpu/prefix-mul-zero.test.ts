import { expect, test } from 'vitest'
import source from './prefix-int128.wgsl?raw'
const mask=(1n<<128n)-1n
const words=(value:bigint)=>Uint32Array.from([0,1,2,3],i=>Number((value&mask)>>BigInt(i*32)&0xffffffffn))
const integer=(value:Uint32Array)=>Array.from(value).reduce((sum,word,i)=>sum+(BigInt(word)<<BigInt(i*32)),0n)
/** Execute the production body. BigInt substitutes only its existing exact
 * helpers; the independent expected result is one complete 128-bit product. */
function productionMultiply() {
  const signature='fn prefix_mul(a:PrefixInt,b:PrefixInt)->PrefixInt {',at=source.indexOf(signature)
  if(at<0)throw Error('Production prefix_mul missing')
  let end=at+signature.length,depth=1
  while(depth&&end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++}
  if(depth)throw Error('Unterminated production prefix_mul')
  const body=source.slice(at+signature.length,end-1).replace(/\bvar\b/g,'let').replace(/\b(\d+)u\b/g,'$1')
  const calls={multiply:0,shift:0,add:0}
  const multiply=new Function('PrefixInt','prefix_add','prefix_shl','prefix_mul_u32',`return function(a,b){${body}}`)(
    (n:number)=>new Uint32Array(4).fill(n),
    (a:Uint32Array,b:Uint32Array)=>{calls.add++;return words(integer(a)+integer(b))},
    (a:Uint32Array,shift:number)=>{calls.shift++;return words(integer(a)<<BigInt(shift))},
    (a:Uint32Array,word:number)=>{calls.multiply++;return words(integer(a)*BigInt(word))},
  ) as (a:Uint32Array,b:Uint32Array)=>Uint32Array
  return {calls,multiply}
}
test('zero coefficient skips every helper even for negative signed128 a',()=>{
  for(const a of [0n,1n,-1n,-(1n<<127n),(1n<<127n)-1n]){
    const f=productionMultiply();expect(f.multiply(words(a),words(0n))).toEqual(words(0n))
    expect(f.calls).toEqual({multiply:0,shift:0,add:0})
  }
})
test('sparse rational words and full four-word b retain exact modular products',()=>{
  const factors=[new Uint32Array([1,0,0,0]),new Uint32Array([0,0x80000001,0,0]),new Uint32Array([0xffffffff,0,0x7fffffff,0]),
    new Uint32Array([0,0,0,0xffffffff]),new Uint32Array([1,2,3,4]),new Uint32Array([0xffffffff,0xffffffff,0xffffffff,0xffffffff])]
  for(const a of [0n,1n,-1n,-2n,-(1n<<127n),(1n<<127n)-1n,0x123456789abcdef00123456789abcdefn])for(const b of factors){
    const f=productionMultiply(),count=Array.from(b).filter(word=>word!==0).length
    expect(f.multiply(words(a),b)).toEqual(words(a*integer(b)))
    expect(f.calls).toEqual({multiply:count,shift:count,add:count})
  }
})
test('production branches match an independent BigInt product over random signed patterns',()=>{
  let state=0x67c2b951
  const next=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0}
  let skipped=0,negative=0,full=0
  for(let i=0;i<2000;i++){
    const a=Uint32Array.from({length:4},next),b=Uint32Array.from({length:4},()=>next()%3===0?0:next())
    if(a[3]&0x80000000)negative++
    const count=Array.from(b).filter(word=>word!==0).length;skipped+=4-count;if(count===4)full++
    const f=productionMultiply();expect(f.multiply(a,b)).toEqual(words(integer(a)*integer(b)))
    expect(f.calls.multiply).toBe(count);expect(f.calls.shift).toBe(count);expect(f.calls.add).toBe(count)
  }
  expect(skipped).toBeGreaterThan(2000);expect(negative).toBeGreaterThan(900);expect(full).toBeGreaterThan(300)
})
