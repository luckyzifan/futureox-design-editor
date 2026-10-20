/** Independent BigInt rational oracle for CPU tests and actual WGSL probes.
 * Expected bits use integer quotient/remainder, never the production reducer. */
export const mask128=(1n<<128n)-1n
export const words128=(value:bigint)=>Array.from({length:4},(_,i)=>Number((value>>BigInt(i*32))&0xffffffffn))
const high=(value:bigint)=>value===0n?-1:value.toString(2).length-1
const signBit=0x80000000
export function roundFraction(numerator:bigint,denominator:bigint,quantum:number):number{
  if(numerator===0n)return 0
  const sign=numerator<0n?signBit:0,magnitude=numerator<0n?-numerator:numerator
  let power=high(magnitude)-high(denominator)
  if(power>=0?magnitude<(denominator<<BigInt(power)):(magnitude<<BigInt(-power))<denominator)power--
  let exponent=power+quantum
  if(exponent>=128)return (sign|0x7f800000)>>>0
  const unit=Math.max(exponent-23,-149),shift=quantum-unit
  const n=shift>=0?magnitude<<BigInt(shift):magnitude
  const d=shift<0?denominator<<BigInt(-shift):denominator
  let quotient=n/d
  const remainder=n%d
  if(remainder*2n>d||(remainder*2n===d&&(quotient&1n)!==0n))quotient++
  if(quotient>=0x1000000n){quotient>>=1n;exponent++}
  if(exponent>=128)return (sign|0x7f800000)>>>0
  let rawExponent=exponent>=-126?exponent+127:0
  if(rawExponent===0&&quotient>=0x800000n)rawExponent=1
  return (sign|(rawExponent<<23)|Number(quotient&0x7fffffn))>>>0
}
export type DivisionCase={numerator:bigint;denominator:bigint;quantum:number}
export function wideExpectation({numerator,denominator,quantum}:DivisionCase):[number,number]{
  const dh=high(denominator)
  if(dh<0||dh>95||quantum< -149||quantum>104)return [0,0]
  if(numerator===0n)return [0,1]
  const magnitude=numerator<0n?-numerator:numerator,mh=high(magnitude)
  let power=mh-dh
  if(power>=0?magnitude<(denominator<<BigInt(power)):(magnitude<<BigInt(-power))<denominator)power--
  const exponent=power+quantum
  // The public helper reports overflow before testing its finite accumulator
  // normalization guards. Preserve that protocol separately from the oracle.
  if(exponent>=128)return [roundFraction(numerator,denominator,quantum),1]
  const shift=Math.max(exponent-23,-149)-quantum
  if(shift>=128||shift<=-128||mh+Math.max(0,-shift)>125||dh+Math.max(0,shift)+23>125)return [0,0]
  return [roundFraction(numerator,denominator,quantum),1]
}
export function divisionCases():DivisionCase[]{
  const cases:DivisionCase[]=[]
  const denominators=[1n,2n,3n,6n,16777213n,(1n<<32n)+1n,(1n<<64n)+13n,(1n<<95n)-19n,1n<<95n]
  const quotients=[0n,1n,2n,3n,(1n<<22n)-1n,1n<<22n,(1n<<23n)-1n,1n<<23n,(1n<<23n)+1n,(1n<<24n)-2n,(1n<<24n)-1n]
  for(const denominator of denominators)for(const quotient of quotients)
    for(const remainder of new Set([0n,denominator/2n,(denominator+1n)/2n,denominator-1n]))
      for(const quantum of [-149,-148,-126,-100,-24,-23,0,103,104])
        for(const sign of [1n,-1n])cases.push({numerator:sign*(denominator*quotient+remainder),denominator,quantum})
  // Large cancellation residuals and normalization near the admitted limit.
  let random=0x9e3779b97f4a7c15n
  const next=()=>{random=(random*6364136223846793005n+1442695040888963407n)&((1n<<64n)-1n);return random}
  for(let i=0;i<1024;i++){
    const numerator=((next()<<59n)|next())&((1n<<123n)-1n)
    const denominator=(((next()<<31n)|next())&((1n<<96n)-1n))||1n
    cases.push({numerator:i%2?-numerator:numerator,denominator,quantum:-149+Number(next()%254n)})
  }
  for(const denominator of [0n,1n<<96n,mask128])cases.push({numerator:1n,denominator,quantum:0})
  for(const quantum of [-150,105])cases.push({numerator:1n,denominator:1n,quantum})
  return cases
}
export type QuotientCase={numerator:bigint;denominator:bigint;estimate:number}
export function quotientCases():QuotientCase[]{
  const cases:QuotientCase[]=[]
  for(const denominator of [1n,3n,(1n<<64n)+13n,(1n<<102n)-1n,(1n<<102n)+13n,(1n<<103n)-1n]){
    for(const quotient of [0n,1n,7n,1234567n,0xfffffen,0xffffffn]){
      for(const remainder of new Set([0n,denominator/2n,denominator-1n])){
        const numerator=denominator*quotient+remainder
        for(const offset of [-100,-9,-8,-1,0,1,8,9,100])
          cases.push({numerator,denominator,estimate:Math.fround(Number(quotient)+offset)})
      }
    }
  }
  for(const estimate of [NaN,Infinity,-Infinity,-1,-0,0,16777216,16777218])
    cases.push({numerator:12345n,denominator:3n,estimate})
  cases.push({numerator:1n<<126n,denominator:1n<<102n,estimate:16777216},
    {numerator:1n,denominator:1n<<103n,estimate:0},
    {numerator:1n,denominator:0n,estimate:0},
    {numerator:0n,denominator:1n,estimate:0})
  return cases
}
export function quotientExpectation({numerator,denominator,estimate}:QuotientCase){
  const declined={remainder:numerator&mask128,quotient:0,accepted:0}
  if(numerator<0n||high(numerator)>125||denominator<=0n||high(denominator)>102||
      !(estimate>=0&&estimate<=16777216))return declined
  const exact=numerator/denominator,guess=BigInt(Math.min(Math.trunc(estimate),16777215))
  if(exact>=1n<<24n||(exact>guess?exact-guess:guess-exact)>8n)return declined
  return {remainder:numerator%denominator,quotient:Number(exact),accepted:1}
}
export function wideGpuVectors(){
  const rows:number[][][]=[],counts={wide:0,quotient:0}
  for(const item of divisionCases()){
    const input=[6,...words128(item.numerator),...words128(item.denominator),item.quantum>>>0,0,0,0,0,0,0]
    rows.push([input,[...wideExpectation(item),0,0]]);counts.wide++
  }
  const floating=new Float32Array(1),bits=new Uint32Array(floating.buffer)
  for(const item of quotientCases()){
    floating[0]=item.estimate
    const expected=quotientExpectation(item),base=[...words128(item.numerator),...words128(item.denominator),bits[0],0,0,0,0,0,0]
    rows.push([[7,...base],[expected.quotient,expected.accepted,0,0]])
    rows.push([[8,...base],words128(expected.remainder)]);counts.quotient+=2
  }
  return {rows,counts}
}
