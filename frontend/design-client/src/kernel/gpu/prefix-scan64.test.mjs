import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
const candidate=readFileSync(new URL('./texture-prefix.wgsl',import.meta.url),'utf8')
const original=readFileSync(new URL('./prefix-int128.wgsl',import.meta.url),'utf8')
const mask128=(1n<<128n)-1n, limit64=1n<<63n
const words=n=>Uint32Array.from([0,1,2,3],i=>Number(((n&mask128)>>BigInt(32*i))&0xffffffffn))
const unsigned=v=>Array.from(v).reduce((a,w,i)=>a+(BigInt(w)<<BigInt(32*i)),0n)
const signed=v=>BigInt.asIntN(128,unsigned(v))
function body(source,name){
 const at=source.indexOf(`fn ${name}(`);assert(at>=0)
 const begin=source.indexOf('{',at);let i=begin+1,depth=1
 while(depth&&i<source.length){if(source[i]==='{')depth++;if(source[i]==='}')depth--;i++}
 assert.equal(depth,0);return source.slice(begin+1,i-1)
}
function transpile(source){
 return source.replace(/\b(0x[0-9a-f]+|\d+)u\b/gi,'$1')
  .replace(/\b([ab])\.([xyzw])\b/g,(_,v,key)=>`${v}[${'xyzw'.indexOf(key)}]`)
  .replace(/\blet\s+(\w+)=([^;]+);/g,'const $1=($2)>>>0;').replace(/\bvar\b/g,'let')
}
const makeWords=(...v)=>new Uint32Array(v.length===1?[v[0],v[0],v[0],v[0]]:v)
const select=(a,b,p)=>p?b:a
const add128=new Function('PrefixInt','select',`return function(a,b){${transpile(body(original,'prefix_add'))}}`)(makeWords,select)
function makeAdd(narrow,enabled=true){
 let wideCalls=0
 const fallback=(a,b)=>{wideCalls++;return add128(a,b)}
 const add=new Function('PrefixInt','select','prefix_add','scanNarrow','PREFIX_SCAN64',`return function(a,b){${transpile(body(candidate,'prefix_scan_add'))}}`)(makeWords,select,fallback,narrow?1:0,enabled)
 return {add,get wideCalls(){return wideCalls}}
}
const gateExpression=candidate.match(/if\((PREFIX_SCAN64&&reason==0u&&[^\n]+)<=63u\)\{scanNarrow=1u;\}/)
assert(gateExpression,'production gate must be extracted exactly')
const gate=new Function('PREFIX_SCAN64','reason','span','length','bsHigh',`return ${gateExpression[1].replace(/\b(\d+)u\b/g,'$1')}<=63`)
const admits=(length,span,accepted=true,enabled=true)=>gate(enabled,accepted?0:1,span,length,n=>31-Math.clz32(n))
const bitLength=n=>32-Math.clz32(n)
function toSample(bits,minimum){
 const e=(bits>>>23)&255,m=(bits&0x7fffff)|(e?0x800000:0)
 if(!m)return 0n
 const n=BigInt(m)<<BigInt(Math.max(e,1)-minimum)
 return bits>>>31?-n:n
}
function exponentRange(values){
 let min=255,max=0
 for(const bits of values)if(bits&0x7fffffff){const e=Math.max((bits>>>23)&255,1);min=Math.min(min,e);max=Math.max(max,e)}
 return {minimum:max?min:1,span:max?max-min:0}
}
function fixture(length,span,pattern){
 const minimum=pattern==='subnormal'?1:40
 const values=Uint32Array.from({length},(_,i)=>{
  const e=i%7===0?minimum:minimum+span
  let bits=(e<<23)|0x7fffff
  if(pattern==='subnormal'&&i%7===0)bits=1
  if(pattern==='mixed'&&i%13===0)bits=0
  if(pattern==='negative'||(pattern==='mixed'&&i%2)||(pattern==='subnormal'&&i%3===0))bits=(bits|0x80000000)>>>0
  return bits
 })
 if(length===1&&pattern==='zero')values[0]=0x80000000
 return values
}
/** This models the established 256-lane Blelloch schedule; both additions are
 * extracted from WGSL, and every stored prefix is checked against a separate
 * sequential arbitrary-precision sum. No GPU or shader compiler is invoked. */
function scan(values,{narrow=undefined,enabled=true}={}){
 const {minimum,span}=exponentRange(values),length=values.length
 narrow??=admits(length,span,true,enabled)
 const production=makeAdd(narrow,enabled)
 let calls=0,carrySum=words(0n),carryMoment=words(0n),expectedSum=0n,expectedMoment=0n
 let maxMagnitude=0n
 function add(a,b){
  const expected=signed(a)+signed(b);calls++
  if(narrow&&enabled){assert(expected>-limit64&&expected<limit64,'every signed64 intermediate must fit')}
  const result=production.add(a,b);assert.deepEqual(result,words(expected),'production add must equal full exact addition')
  const magnitude=expected<0n?-expected:expected;if(magnitude>maxMagnitude)maxMagnitude=magnitude
  return result
 }
 for(let chunk=0;chunk<length;chunk+=256){
  const samples=Array.from({length:256},(_,lane)=>chunk+lane<length?toSample(values[chunk+lane],minimum):0n)
  const moments=samples.map((v,lane)=>v*BigInt(chunk+lane))
  const sums=samples.map(words),weighted=moments.map(words)
  for(let stride=1;stride<256;stride*=2)for(let lane=0;lane<256;lane++){
   const index=(lane+1)*stride*2-1;if(index>=256)continue
   sums[index]=add(sums[index],sums[index-stride]);weighted[index]=add(weighted[index],weighted[index-stride])
  }
  sums[255]=words(0n);weighted[255]=words(0n)
  for(let stride=128;stride>0;stride=Math.floor(stride/2))for(let lane=0;lane<256;lane++){
   const index=(lane+1)*stride*2-1;if(index>=256)continue
   const leftSum=sums[index-stride],leftMoment=weighted[index-stride]
   const parentSum=sums[index],parentMoment=weighted[index]
   sums[index-stride]=parentSum;weighted[index-stride]=parentMoment
   sums[index]=add(parentSum,leftSum);weighted[index]=add(parentMoment,leftMoment)
  }
  let nextSum,nextMoment
  for(let lane=0;lane<256;lane++){
   sums[lane]=add(sums[lane],words(samples[lane]));weighted[lane]=add(weighted[lane],words(moments[lane]))
   const sum=add(carrySum,sums[lane]),moment=add(carryMoment,weighted[lane])
   if(chunk+lane<length){expectedSum+=samples[lane];expectedMoment+=moments[lane];assert.deepEqual(sum,words(expectedSum));assert.deepEqual(moment,words(expectedMoment))}
   if(lane===255){nextSum=sum;nextMoment=moment}
  }
  carrySum=nextSum;carryMoment=nextMoment
 }
 assert.equal(production.wideCalls,narrow&&enabled?0:calls)
 return {calls,maxMagnitude,narrow,span}
}
test('actual gate boundaries include powers of two and require prior admission/flag',()=>{
 for(const length of [1,2,3,255,256,257,511,512,513,1108,3484,16383,16384]){
  const span=39-2*bitLength(length)
  assert(admits(length,span));assert(!admits(length,span+1));assert(!admits(length,span,false));assert(!admits(length,span,true,false))
 }
 assert(admits(3484,15));assert(!admits(3484,16));assert(admits(1108,17));assert(admits(16384,9))
})
test('extracted narrow add preserves carry, negative values and sign extension; wide path preserves upper limbs',()=>{
 const cases=[[0n,0n],[0xffffffffn,1n],[-1n,1n],[-0x100000001n,1n],[-(1n<<62n),1n],[(1n<<62n)-1n,(1n<<62n)-1n]]
 for(const [a,b] of cases)assert.deepEqual(makeAdd(true).add(words(a),words(b)),words(a+b))
 for(const [a,b] of [[1n<<100n,1n],[-(1n<<120n),1n<<80n]]){
  const wide=makeAdd(false);assert.deepEqual(wide.add(words(a),words(b)),words(a+b));assert.equal(wide.wideCalls,1)
  const disabled=makeAdd(true,false);assert.deepEqual(disabled.add(words(a),words(b)),words(a+b));assert.equal(disabled.wideCalls,1)
 }
})
test('all signed prefixes/moments at admission boundary match sequential exact reference across chunk boundaries',()=>{
 for(const length of [1,2,255,256,257,511,512,513,1108,3484,16384]){
  const span=39-2*bitLength(length)
  for(const pattern of ['positive','negative','mixed','subnormal'])assert(scan(fixture(length,span,pattern)).narrow)
 }
 assert(scan(new Uint32Array(513)).narrow)
 assert(scan(new Uint32Array(257).fill(0x80000000)).narrow)
})
test('span one above narrow threshold and wide span40 keep complete 128-bit scan without scalar fallback',()=>{
 for(const length of [257,1108,3484])for(const span of [40-2*bitLength(length),40]){
  const values=fixture(length,span,'mixed'),range=exponentRange(values)
  assert.equal(range.span,span);assert(!scan(values).narrow)
 }
})
test('production narrows only scan additions and retains signed128 workgroup/storage layout',()=>{
 assert(!candidate.slice(candidate.indexOf('fn prefixPairAt(')).includes('prefix_scan_add('))
 assert.equal((body(candidate,'prefixScan').match(/prefix_scan_add\(/g)||[]).length,8)
 assert(!body(candidate,'prefixScan').includes('prefix_add('))
 assert(candidate.includes('struct PrefixPair { sum:PrefixInt, moment:PrefixInt }'))
 assert(candidate.includes('var<workgroup> scanSums:array<PrefixInt,256>;'))
 assert(candidate.includes('var<workgroup> scanMoments:array<PrefixInt,256>;'))
 assert(candidate.includes('if(scanNarrow!=0u){atomicAdd(&prefixMetadata.unused,1u);}'))
})

test('scan defaults on with explicit fallback and keeps the original counter readback',()=>{
 const module=readFileSync(new URL('./prefix-module.ts',import.meta.url),'utf8')
 const setting=module.match(/const scan64 = ([^\n]+)/)?.[1]
 assert(setting)
 for(const value of [undefined,'','0','true','1']){
  const enabled=new Function('value',`return ${setting.replace('import.meta.env.VITE_DESIGN_PREFIX_SCAN64','value')}`)(value)
  assert.equal(enabled,value!=='0')
 }
 assert(module.includes('const PREFIX_SCAN64:bool=${scan64};'))
 assert(body(candidate,'prefix_scan_add').includes('if(PREFIX_SCAN64&&scanNarrow!=0u)'))
 const source=readFileSync(new URL('./texture-prefix.ts',import.meta.url),'utf8')
 assert(source.includes('narrowLines: values[3]'))
 assert(source.includes('encoder.clearBuffer(this.metadata, 0, 16)'))
 assert(source.includes('encoder.copyBufferToBuffer(this.metadata, 0, this.readback, 0, 16)'))
})
