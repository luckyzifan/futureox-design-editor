import { expect, test } from 'vitest'
import shader from './texture-prefix.wgsl?raw'

const mask128=(1n<<128n)-1n
const wrap=(value:bigint)=>value&mask128

// Execute the production WGSL scan statements, yielding every invocation at
// each real workgroup barrier. Only WGSL scalar syntax is translated; the scan
// schedule and shared-memory accesses are not reimplemented in this test.
const begin=shader.indexOf('  scanSums[lane]=value;')
const end=shader.indexOf('  let total=PrefixPair(',begin)
if(begin<0||end<begin)throw Error('Production prefix scan block not found')
const source=shader.slice(begin,end)
  .replace(/\b(\d+)u\b/g,'$1')
  .replace(/\bvar\b/g,'let')
  .replace(/stride=stride\/2\b/g,'stride=Math.floor(stride/2)')
  .replace(/workgroupBarrier\(\);/g,'yield;')
type Invocation=Generator<void,void,unknown>
const makeInvocation=new Function('scanSums','scanMoments','prefix_add','prefix_mul_u32','PrefixInt',
  `return function* (lane,value,j){${source}}`) as (
    sums:bigint[],moments:bigint[],add:(a:bigint,b:bigint)=>bigint,
    mul:(a:bigint,b:number)=>bigint,integer:(value:number)=>bigint,
  )=>((lane:number,value:bigint,j:number)=>Invocation)

function scanChunk(values:bigint[],start:number,order:number[]){
  const sums=Array<bigint>(256).fill(0n),moments=Array<bigint>(256).fill(0n)
  let additions=0
  const invoke=makeInvocation(sums,moments,(a,b)=>{additions++;return wrap(a+b)},
    (a,b)=>wrap(a*BigInt(b)),value=>BigInt(value))
  const lanes=Array.from({length:256},(_,lane)=>invoke(lane,wrap(values[lane]??0n),start+lane))
  let barriers=0
  for(;;){
    const completed=order.map(lane=>lanes[lane].next().done===true)
    if(completed.every(Boolean))break
    expect(completed.some(Boolean),'all lanes must reach every workgroup barrier').toBe(false)
    if(++barriers>32)throw Error('Scan failed to finish within its bounded barrier count')
  }
  return {sums,moments,additions,barriers}
}
const forward=Array.from({length:256},(_,i)=>i)
const reverse=[...forward].reverse()
// Coprime permutation exercises a different lane order at every level without
// treating a sequential CPU lane order as a GPU memory-order guarantee.
const permuted=forward.map(i=>(i*137+53)%256)

function scanLine(values:bigint[],order:number[]){
  const sums:bigint[]=[],moments:bigint[]=[]
  let carrySum=0n,carryMoment=0n,additions=0
  for(let start=0;start<values.length;start+=256){
    const chunk=scanChunk(values.slice(start,start+256),start,order)
    additions+=chunk.additions
    for(let lane=0;lane<256&&start+lane<values.length;lane++){
      sums.push(wrap(carrySum+chunk.sums[lane]))
      moments.push(wrap(carryMoment+chunk.moments[lane]))
    }
    carrySum=wrap(carrySum+chunk.sums[255])
    carryMoment=wrap(carryMoment+chunk.moments[255])
  }
  return {sums,moments,additions}
}
function scalarOracle(values:bigint[]){
  const sums:bigint[]=[],moments:bigint[]=[]
  let sum=0n,moment=0n
  values.forEach((value,index)=>{
    // Independent scalar mathematical prefix, reduced only at each output.
    sum+=value;moment+=value*BigInt(index)
    sums.push(wrap(sum));moments.push(wrap(moment))
  })
  return {sums,moments}
}

test.each([1,2,63,255,256,257,511,512,3484,16384])(
  'production scan preserves every sum/moment bit across %i samples and padded chunks',length=>{
    const values=Array.from({length},(_,i)=>{
      const magnitude=(BigInt((i*2654435761)>>>0)<<32n)+BigInt((i*2246822519)>>>0)
      return i%11===0?0n:i%3===0?-magnitude:magnitude
    })
    const actual=scanLine(values,permuted),expected=scalarOracle(values)
    expect(actual.sums).toEqual(expected.sums)
    expect(actual.moments).toEqual(expected.moments)
  },
)

test.each([{name:'forward',order:forward},{name:'reverse',order:reverse},{name:'permuted',order:permuted}])(
 'production scan is independent of $name lane scheduling',({order})=>{
  const values=Array.from({length:256},(_,i)=>i%2===0?(1n<<119n)+BigInt(i):-(1n<<119n)-BigInt(i))
  const actual=scanChunk(values,0,order),expected=scalarOracle(values)
  expect(actual.sums).toEqual(expected.sums)
  expect(actual.moments).toEqual(expected.moments)
  expect(actual.additions).toBe(2*(255+255+256))
  expect(actual.barriers).toBe(18) // initialization + 8 up + root reset + 8 down
})

test('zero and signed cancellation retain the exact prefix carry across chunks',()=>{
  for(const values of [
    Array<bigint>(770).fill(0n),
    Array.from({length:770},(_,i)=>[1n<<63n,-(1n<<63n),1n,-1n][i%4]),
    Array.from({length:770},(_,i)=>i===255?(1n<<120n)-1n:i===256?-((1n<<120n)-1n):0n),
  ]){
    const actual=scanLine(values,reverse),expected=scalarOracle(values)
    expect(actual.sums).toEqual(expected.sums)
    expect(actual.moments).toEqual(expected.moments)
  }
})

test('unsupported-row classification and scalar fallback remain outside the optimized scan',()=>{
  expect(shader.slice(0,begin)).toContain('if(span>40u){reason=3u;}')
  expect(shader.slice(0,begin)).toContain('if(rfLoad(0u)>4u||prefix_high(prefixDenominator())>95){reason=4u;}')
  expect(shader.slice(0,begin)).toContain('if(24+i32(span)+weightedBits+3>123){reason=5u;}')
  expect(shader.slice(end)).toContain('return vec4<f32>(exactFilterChannel(p,direction,PREFIX_CHANNEL));')
})
