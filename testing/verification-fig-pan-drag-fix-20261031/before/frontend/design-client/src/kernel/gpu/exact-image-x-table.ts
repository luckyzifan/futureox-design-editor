/** Exact, unrounded horizontal image interpolation for four certified axis
 * fields. Certificates describe the immutable full upload supplied by the
 * driver; the driver must revoke them on any write/reupload or owner change. */
const ranges = new WeakSet<object>()
const nonzeroChannels=new WeakMap<ExactImageRange,readonly boolean[]>()
const planRanges = new WeakMap<ExactImageXTablePlan, { range: ExactImageRange; snapshot: ExactImageXTablePlan }>()
export type ExactImageRange = Readonly<{
  pixels: number
  minimum: readonly number[]
  maximum: readonly number[]
  /** Every actual uploaded alpha word is exactly 0x3f800000. */
  opaqueAlpha: boolean
  /** Every actual alpha is in [0,1], including either signed zero. */
  unitAlpha?: true
  /** RGB has no negative nonzero word; signed zero is canonicalized by resolve. */
  nonnegativeRgb: boolean
}>
export function certifyExactImageRange(pixels: Float32Array): ExactImageRange | undefined {
  // A concurrent writer could change texels between the scan and upload.
  // Ordinary ArrayBuffer bytes are scanned/uploaded synchronously by the owner.
  if (!(pixels instanceof Float32Array) || !(pixels.buffer instanceof ArrayBuffer) || !pixels.length || pixels.length % 4) return
  const bits = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length)
  let minR=255,minG=255,minB=255,minA=255,maxR=0,maxG=0,maxB=0,maxA=0
  let opaqueAlpha=true,unitAlpha=true,nonnegativeRgb=true
  // Read every RGBA word. Scalar extrema avoid per-component Math calls and
  // dynamic array indexing; zeros and subnormals retain the same exponent rule.
  for(let i=0;i<bits.length;i+=4){
    const r=bits[i],g=bits[i+1],b=bits[i+2],a=bits[i+3]
    const er=r>>>23&255,eg=g>>>23&255,eb=b>>>23&255,ea=a>>>23&255
    if(er===255||eg===255||eb===255||ea===255)return
    if(a!==0x3f800000)opaqueAlpha=false
    if(a>0x80000000||(a&0x7fffffff)>0x3f800000)unitAlpha=false
    // Uint32 words above negative zero are precisely negative nonzero values.
    if(r>0x80000000||g>0x80000000||b>0x80000000)nonnegativeRgb=false
    if(r&0x7fffffff){const e=er||1;if(e<minR)minR=e;if(e>maxR)maxR=e}
    if(g&0x7fffffff){const e=eg||1;if(e<minG)minG=e;if(e>maxG)maxG=e}
    if(b&0x7fffffff){const e=eb||1;if(e<minB)minB=e;if(e>maxB)maxB=e}
    if(a&0x7fffffff){const e=ea||1;if(e<minA)minA=e;if(e>maxA)maxA=e}
  }
  const minimum=[maxR?minR:1,maxG?minG:1,maxB?minB:1,maxA?minA:1]
  const maximum=[maxR||1,maxG||1,maxB||1,maxA||1]
  const range = Object.freeze({ pixels: pixels.length / 4, opaqueAlpha, ...(unitAlpha?{unitAlpha:true as const}:{}), nonnegativeRgb,
    minimum: Object.freeze(minimum), maximum: Object.freeze(maximum) })
  ranges.add(range)
  nonzeroChannels.set(range,[!!maxR,!!maxG,!!maxB,!!maxA])
  return range
}

/** Constant-space accumulation of already certified immutable row chunks.
 * No full-image float buffer, caller-authored extrema or partial receipt. */
export function createExactImageRangeAccumulator(){
 let pixels=0,closed=false,opaqueAlpha=true,unitAlpha=true,nonnegativeRgb=true
 const minimum=[255,255,255,255],maximum=[0,0,0,0]
 return {
  add(range:ExactImageRange){
   const nonzero=nonzeroChannels.get(range)
   if(closed||!ranges.has(range)||!nonzero||!Number.isSafeInteger(pixels+range.pixels))throw Error('Invalid image range accumulation')
   pixels+=range.pixels;opaqueAlpha&&=range.opaqueAlpha;unitAlpha&&=range.unitAlpha===true;nonnegativeRgb&&=range.nonnegativeRgb
   for(let c=0;c<4;c++)if(nonzero[c]){minimum[c]=Math.min(minimum[c],range.minimum[c]);maximum[c]=Math.max(maximum[c],range.maximum[c])}
  },
  finish(expectedPixels:number):ExactImageRange|undefined{
   if(closed)return;closed=true
   if(!pixels||pixels!==expectedPixels)return
   const nonzero=maximum.map(Boolean)
   const range=Object.freeze({pixels,opaqueAlpha,...(unitAlpha?{unitAlpha:true as const}:{}),nonnegativeRgb,
    minimum:Object.freeze(minimum.map((value,c)=>nonzero[c]?value:1)),maximum:Object.freeze(maximum.map(value=>value||1))})
   ranges.add(range);nonzeroChannels.set(range,nonzero);return range
  },
 }
}

/** Exact f32 fraction U / 2^k, including both signed zeros and one.
 * U never exceeds 24 bits; k may exceed 31. No 1 << k arithmetic is used. */
function fraction(raw: number): [number, number] | undefined {
  if ((raw & 0x7fffffff) > 0x3f800000 || raw > 0x80000000) return
  if (!(raw & 0x7fffffff)) return [0, 0]
  const exponent = raw >>> 23 & 255
  let numerator = (raw & 0x7fffff) | (exponent ? 0x800000 : 0)
  let denominator = 150 - Math.max(exponent, 1)
  while (!(numerator & 1) && denominator > 0) { numerator >>>= 1; denominator-- }
  return [numerator, denominator]
}
export type ExactImageXTablePlan = {
  /** X: qx,U,ku,0, unique program-major. Y: qy-rowMin,V,kv,0,
   * still four sample-major arrays. No Y phase or sample sum is shared. */
  x: Uint32Array; y: Uint32Array
  /** shape=(w,h,rowMin,rowCount), image=(iw,ih,storedChannels,opaqueAlpha), minimum exponents,
   * output=(stripOffsetX,stripOffsetY,outputWidth,outputHeight). */
  uniform: Uint32Array
  /** Number of bit-identical complete X programs retained (1..4). */
  xSampleCount: number
  rowMin: number; rowCount: number; tableBytes: number
  maxKx: number; maxKy: number
}
/** The driver compares this identity with its immutable upload certificate
 * before snapshotting plan buffers and entering any asynchronous preparation. */
export function imageXTablePlanRange(plan: ExactImageXTablePlan): ExactImageRange | undefined {
  const known = planRanges.get(plan)
  if (!known) return
  const sameWords = (a: Uint32Array, b: Uint32Array) => a instanceof Uint32Array &&
    a.buffer instanceof ArrayBuffer && a.length === b.length && a.every((word, index) => word === b[index])
  const original = known.snapshot
  if (!sameWords(plan.x, original.x) || !sameWords(plan.y, original.y) || !sameWords(plan.uniform, original.uniform) ||
      plan.rowMin !== original.rowMin || plan.rowCount !== original.rowCount || plan.tableBytes !== original.tableBytes ||
      plan.maxKx !== original.maxKx || plan.maxKy !== original.maxKy || plan.xSampleCount !== original.xSampleCount) return
  return known.range
}
export function planExactImageXTable(input: {
  axes: readonly Float32Array[]; width: number; height: number
  imageWidth: number; imageHeight: number; range: ExactImageRange
  maxTableBytes?: number
  /** Exact negative control. False retains four independent X tables. */
  reuseIdenticalX?: boolean
}): ExactImageXTablePlan | undefined {
  const { axes, width, height, imageWidth, imageHeight, range } = input
  if (!range || !ranges.has(range) || axes.length !== 4 ||
      ![width, height, imageWidth, imageHeight].every(v => Number.isSafeInteger(v) && v > 0 && v <= 8192) ||
      imageWidth < 2 || imageHeight < 2 || range.pixels !== imageWidth * imageHeight) return
  const span = Math.max(width, height), allX = new Uint32Array(width * 4 * 4), y = new Uint32Array(height * 4 * 4)
  let rowMin = imageHeight, rowMax = 0, maxKx = 0, maxKy = 0
  for (let sample = 0; sample < 4; sample++) {
    const field = axes[sample]
    if (!(field instanceof Float32Array) || !(field.buffer instanceof ArrayBuffer) || field.length !== span * 8 || field[3] !== -1) return
    const fieldBits = new Uint32Array(field.buffer, field.byteOffset, field.length)
    for (let axis = 0; axis < 2; axis++) {
      const length = axis ? height : width, target = axis ? y : allX, limit = axis ? imageHeight : imageWidth
      for (let i = 0; i < length; i++) {
        const at = (axis * span + i) * 4, cell = field[at], part = fraction(fieldBits[at + 1])
        // This candidate has no contain-margin, border or nonfinite branch.
        // Even a zero-weight neighbour must exist in the same finite upload.
        if (!Number.isSafeInteger(cell) || cell < 0 || cell + 1 >= limit ||
            field[at + 2] !== 1 || field[at + 3] !== -1 || !part) return
        target.set([cell, part[0], part[1], 0], (sample * length + i) * 4)
        if (axis) { rowMin = Math.min(rowMin, cell); rowMax = Math.max(rowMax, cell + 1); maxKy = Math.max(maxKy, part[1]) }
        else maxKx = Math.max(maxKx, part[1])
      }
    }
  }
  // Four correlated samples commonly have two complete X programs and four
  // distinct Y programs. Share only a byte-identical admitted X program: the
  // source texels, dyadic numerator and exponent must all match at every X.
  // This removes duplicate integer interpolation work, not any sample phase.
  const representatives: number[] = [], sampleGroups: number[] = []
  const xWords = width * 4
  for (let sample = 0; sample < 4; sample++) {
    const group = input.reuseIdenticalX === false ? -1 : representatives.findIndex(previous => {
      for (let word = 0; word < xWords; word++)
        if (allX[sample * xWords + word] !== allX[previous * xWords + word]) return false
      return true
    })
    if (group >= 0) sampleGroups.push(group)
    else { sampleGroups.push(representatives.length); representatives.push(sample) }
  }
  const xSampleCount = representatives.length, x = new Uint32Array(xWords * xSampleCount)
  representatives.forEach((sample, group) => x.set(allX.subarray(sample * xWords, (sample + 1) * xWords), group * xWords))
  for (let c = 0; c < 4; c++) {
    const p = 24 + range.maximum[c] - range.minimum[c]
    // |H| < 2^(p+kx), stored signed96. The delta form's two signed
    // intermediates need two additional conservative bits in signed128.
    if (p + maxKx > 95 || p + maxKx + maxKy + 2 > 126) return
  }
  const rowCount = rowMax - rowMin + 1
  // Three exact u32 limbs per signed96 value. Opaque alpha is proved to be
  // one and needs no stored slot; this changes layout, never arithmetic.
  const channels = range.opaqueAlpha ? 3 : 4
  const tableBytes = xSampleCount * width * rowCount * channels * 12
  const budget = input.maxTableBytes ?? 16 * 1024 * 1024
  if (!Number.isSafeInteger(budget) || budget < 0 || !Number.isSafeInteger(tableBytes) || tableBytes > budget) return
  for (let at = 0; at < y.length; at += 4) y[at] -= rowMin
  const plan = { x, y, rowMin, rowCount, tableBytes, maxKx, maxKy, xSampleCount,
    uniform: new Uint32Array([width, height, rowMin, rowCount, imageWidth, imageHeight, channels, Number(range.opaqueAlpha), ...range.minimum, 0, 0, width, height, ...sampleGroups]) }
  // A WeakMap identity alone does not certify mutable TypedArray contents.
  // Keep an exact private witness; admission rejects later edits before it
  // snapshots GPU inputs. No digest or caller-provided bound grants authority.
  planRanges.set(plan, { range, snapshot: { ...plan, x: x.slice(), y: y.slice(), uniform: plan.uniform.slice() } })
  return plan
}

/** Fixed limbs, modular arithmetic; CPU admission proves every interpreted
 * signed intermediate fits. There is no approximate floating arithmetic. */
export const exactImageXTableMathWgsl = `
fn xiMulWord(a:u32,b:u32)->vec2<u32>{
 let a0=a&65535u;let a1=a>>16u;let b0=b&65535u;let b1=b>>16u;
 let p0=a0*b0;let p1=a1*b0;let p2=a0*b1;
 let carry=(p0>>16u)+(p1&65535u)+(p2&65535u);
 return vec2<u32>((p0&65535u)|(carry<<16u),a1*b1+(p1>>16u)+(p2>>16u)+(carry>>16u));
}
fn xiAdd(a:vec4<u32>,b:vec4<u32>)->vec4<u32>{
 let s=a+b;var r=s;var c=select(0u,1u,s.x<a.x);
 r.y=s.y+c;c=select(0u,1u,s.y<a.y||r.y<s.y);
 r.z=s.z+c;c=select(0u,1u,s.z<a.z||r.z<s.z);
 r.w=s.w+c;return r;
}
fn xiNeg(a:vec4<u32>)->vec4<u32>{return xiAdd(~a,vec4<u32>(1u,0u,0u,0u));}
fn xiSub(a:vec4<u32>,b:vec4<u32>)->vec4<u32>{return xiAdd(a,xiNeg(b));}
fn xiShift(a:vec4<u32>,shift:u32)->vec4<u32>{
 if(shift>=128u){return vec4<u32>(0u);}
 var v=a;
 if(shift>=96u){v=vec4<u32>(0u,0u,0u,a.x);}
 else if(shift>=64u){v=vec4<u32>(0u,0u,a.xy);}
 else if(shift>=32u){v=vec4<u32>(0u,a.xyz);}
 let k=shift&31u;if(k==0u){return v;}
 return (v<<vec4<u32>(k))|vec4<u32>(0u,v.xyz>>(vec3<u32>(32u-k)));
}
fn xiTimesWord(a:vec4<u32>,b:u32)->vec4<u32>{
 let p0=xiMulWord(a.x,b);let p1=xiMulWord(a.y,b);let p2=xiMulWord(a.z,b);
 let r1=p1.x+p0.y;var c=select(0u,1u,r1<p1.x);
 let s2=p2.x+p1.y;let r2=s2+c;c=select(0u,1u,s2<p2.x||r2<s2);
 return vec4<u32>(p0.x,r1,r2,a.w*b+p2.y+c);
}
fn xiDecode(bits:u32,minimum:u32)->vec4<u32>{
 if((bits&0x7fffffffu)==0u){return vec4<u32>(0u);}
 let exponent=(bits>>23u)&255u;
 let mantissa=(bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
 let value=xiShift(vec4<u32>(mantissa,0u,0u,0u),max(exponent,1u)-minimum);
 if((bits&0x80000000u)!=0u){return xiNeg(value);}return value;
}
fn xiSigned96(words:vec4<u32>)->vec4<u32>{
 return vec4<u32>(words.xyz,select(0u,0xffffffffu,(words.z&0x80000000u)!=0u));
}
fn xiRound(value:vec4<u32>,quantum:i32)->u32{
 let negative=(value.w&0x80000000u)!=0u;var a=value;if(negative){a=xiNeg(a);}
 if(all(a==vec4<u32>(0u))){return 0u;}
 var last=0u;if(a.y!=0u){last=1u;}if(a.z!=0u){last=2u;}if(a.w!=0u){last=3u;}
 let top=i32(last*32u+31u-countLeadingZeros(a[last]));let exponent=top+quantum;
 let shift=max(exponent-23,-149)-quantum;var mantissa=0u;
 if(shift<=0){mantissa=a.x<<u32(-shift);}
 else if(shift<128){
  let index=u32(shift)/32u;let offset=u32(shift)&31u;mantissa=a[index]>>offset;
  if(offset!=0u&&index<3u){mantissa=mantissa|(a[index+1u]<<(32u-offset));}
  let guard=u32(shift)-1u;let word=guard/32u;let bit=guard&31u;
  let guardBit=(a[word]&(1u<<bit))!=0u;var sticky=(a[word]&((1u<<bit)-1u))!=0u;
  if(word>0u){sticky=sticky||a.x!=0u;}if(word>1u){sticky=sticky||a.y!=0u;}if(word>2u){sticky=sticky||a.z!=0u;}
  if(guardBit&&(sticky||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 }
 var rawExponent=0u;if(exponent>=-126){rawExponent=u32(exponent+127);}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;rawExponent=rawExponent+1u;}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 let sign=select(0u,0x80000000u,negative);
 if(rawExponent>=255u){return sign|0x7f800000u;}
 return sign|(rawExponent<<23u)|(mantissa&0x7fffffu);
}
struct XiConfig{shape:vec4<u32>,image:vec4<u32>,minimum:vec4<u32>,output:vec4<u32>,sampleGroups:vec4<u32>}
`

/** Build layout: uniform, immutable image, X metadata, writable H table. */
export const exactImageXTableBuildWgsl = exactImageXTableMathWgsl + `
@group(0) @binding(0) var<uniform> xiConfig:XiConfig;
@group(0) @binding(1) var xiImage:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> xiX:array<vec4<u32>>;
@group(0) @binding(3) var<storage,read_write> xiTable:array<u32>;
@compute @workgroup_size(64) fn buildExactImageXTable(@builtin(global_invocation_id) invocation:vec3<u32>){
 let width=xiConfig.shape.x;let rows=xiConfig.shape.w;let index=invocation.x;
 if(index>=arrayLength(&xiX)*rows){return;}
 let x=index%width;let row=(index/width)%rows;let sample=index/(width*rows);
 let phase=xiX[sample*width+x];let q=vec2<i32>(i32(phase.x),i32(xiConfig.shape.z+row));
 let a=bitcast<vec4<u32>>(textureLoad(xiImage,q,0));let b=bitcast<vec4<u32>>(textureLoad(xiImage,q+vec2<i32>(1,0),0));
 let channels=xiConfig.image.z;
 for(var c=0u;c<channels;c=c+1u){
  let left=xiDecode(a[c],xiConfig.minimum[c]);let right=xiDecode(b[c],xiConfig.minimum[c]);
  let h=xiAdd(xiShift(left,phase.z),xiTimesWord(xiSub(right,left),phase.y));
  let at=(index*channels+c)*3u;
  xiTable[at]=h.x;xiTable[at+1u]=h.y;xiTable[at+2u]=h.z;
 }
}
`

/** Resolve layout: uniform, X metadata, Y metadata, read-only H table.
 * No fragment entry is included: the caller preserves the original finite
 * paint/alpha gate/quarter/ordered-add boundaries for samples 0,1,2,3. */
export const exactImageXTableSampleWgsl = exactImageXTableMathWgsl + `
@group(0) @binding(0) var<uniform> xiConfig:XiConfig;
@group(0) @binding(1) var<storage,read> xiX:array<vec4<u32>>;
@group(0) @binding(2) var<storage,read> xiY:array<vec4<u32>>;
@group(0) @binding(3) var<storage,read> xiTable:array<u32>;
fn xiTableSigned96(at:u32)->vec4<u32>{
 return xiSigned96(vec4<u32>(xiTable[at],xiTable[at+1u],xiTable[at+2u],0u));
}
fn exactImageXTableSample(localPixel:vec2<u32>,sample:u32)->vec4<f32>{
 let pixel=localPixel+xiConfig.output.xy;
 let width=xiConfig.shape.x;let rows=xiConfig.shape.w;
 let group=xiConfig.sampleGroups[sample];
 let x=xiX[group*width+pixel.x];let y=xiY[sample*xiConfig.shape.y+pixel.y];
 let channels=xiConfig.image.z;let rowStride=width*channels*3u;
 let at=((group*rows+y.x)*width+pixel.x)*channels*3u;var result=vec4<u32>(0u,0u,0u,0x3f800000u);
 for(var c=0u;c<channels;c=c+1u){
  let a=xiTableSigned96(at+c*3u);let b=xiTableSigned96(at+rowStride+c*3u);
  let value=xiAdd(xiShift(a,y.z),xiTimesWord(xiSub(b,a),y.y));
  result[c]=xiRound(value,i32(xiConfig.minimum[c])-150-i32(x.z)-i32(y.z));
 }
 return bitcast<vec4<f32>>(result);
}
`
