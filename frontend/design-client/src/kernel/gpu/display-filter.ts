/** Same integrated tent coefficients as effects::tent_weight, evaluated in
 * binary64 once on CPU. Only the canvas reduces them on GPU in float32;
 * export/readback retains the exact rational accumulator. No downsampling. */
export function displayFilterWeights(radius: number, box = false): Float32Array {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 16_384)
    throw new Error('Display filter radius exceeds supported device range')
  const reach = Math.ceil(radius), weights = new Float32Array(reach + 1)
  if (box) { weights.fill(1 / (2 * reach + 1)); return weights }
  let sides = 0
  for (let i = 1; i <= reach; i++) {
    const weight = radius <= 1 ? radius / 6 : i + 1 <= radius ? (radius - i) / (radius * radius) :
      (Math.max(0, radius + 1 - i) ** 3 - 2 * Math.max(0, radius - i) ** 3) / (6 * radius * radius)
    weights[i] = weight; sides += weights[i]
  }
  weights[0] = 1 - 2 * sides
  return weights
}

/** A bounded pass has at most 33 coefficient rows in otherwise unused
 * filter uniforms. Preserve the uploaded texture's exact f32 coefficients. */
export function writeBoundedDisplayCoefficients(params: Float32Array, radius: number) {
  const weights = displayFilterWeights(radius)
  for (let i = 0; i < weights.length; i++) {
    const offset = 64 + i * 4
    params[offset] = weights[i]
    params[offset + 1] = weights[i - 1] ?? 0
    params[offset + 2] = weights[i + 1] ?? 0
  }
}

export const displayFilterWgsl = `
struct Params {values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
@group(0) @binding(2) var sourceB:texture_2d<f32>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);
}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let point=vec2<i32>(floor(position.xy+u(0).xy-u(1).xy));
 let size=vec2<i32>(u(1).zw); let horizontal=u(9).y<0.5;
 let axis=select(vec2<i32>(0,1),vec2<i32>(1,0),horizontal);
 let coordinate=select(point.y,point.x,horizontal);let length=select(size.y,size.x,horizontal);
 let reach=i32(ceil(u(9).x));let edge=u(9).z>0.5;
 let lo=select(max(-reach,-coordinate),-reach,edge);
 let hi=select(min(reach,length-1-coordinate),reach,edge);
 var sum=vec4<f32>(0);var correction=vec4<f32>(0);
 for(var tap=lo;tap<=hi;tap=tap+1){
  var q=point+axis*tap;if(edge){q=clamp(q,vec2<i32>(0),size-1);}
  if(any(q<vec2<i32>(0))||any(q>=size)){continue;}
  let index=abs(tap);let weight=textureLoad(sourceB,vec2<i32>(index%256,index/256),0).x;
  let value=textureLoad(sourceA,q,0)*weight-correction;
  let next=sum+value;correction=(next-sum)-value;sum=next;
 }
 return sum;
}`

/** Fetch adjacent coefficients together and reuse a texel when both taps
 * clamp to it. Keep each multiply and compensated add in the original order.
 * A hardware interpolated tap can quantize its fraction enough to fail SDR
 * parity, particularly for very small radii near a sharp or dark edge. */
export const pairedDisplayFilterWgsl = `
struct Params {values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var weights:texture_2d<f32>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
struct FilterSum {sum:vec4<f32>, correction:vec4<f32>}
fn accumulate(previous:FilterSum, pixel:vec4<f32>, weight:f32)->FilterSum{
 let value=pixel*weight-previous.correction;
 let next=previous.sum+value;
 return FilterSum(next,(next-previous.sum)-value);
}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);
}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let point=vec2<i32>(floor(position.xy+u(0).xy-u(1).xy));
 let size=vec2<i32>(u(1).zw);
 let horizontal=u(9).y<0.5;let axis=select(vec2<i32>(0,1),vec2<i32>(1,0),horizontal);
 let coordinate=select(point.y,point.x,horizontal);let length=select(size.y,size.x,horizontal);
 let reach=i32(ceil(u(9).x));let edge=u(9).z>0.5;
 let lo=select(max(-reach,-coordinate),-reach,edge);let hi=select(min(reach,length-1-coordinate),reach,edge);
 let perpendicular=select(point.x,point.y,horizontal);let crossLength=select(size.x,size.y,horizontal);
 if(!edge && (perpendicular<0 || perpendicular>=crossLength)){return vec4<f32>(0);}
 var value=FilterSum(vec4<f32>(0),vec4<f32>(0));
 let bounded=u(11).y>0.5;
 for(var tap=lo;tap<=hi;tap=tap+2){
  // The centre coefficient and its two neighbours share one vector.
  let k=abs(tap);
  var coefficients:vec4<f32>;
  if(bounded){coefficients=u(16u+u32(k));}
  else{coefficients=textureLoad(weights,vec2<i32>(k%256,k/256),0);}
  let qa=clamp(point+axis*tap,vec2<i32>(0),size-1);
  let first=textureLoad(source,qa,0);
  value=accumulate(value,first,coefficients.x);
  if(tap<hi){
   let qb=clamp(point+axis*(tap+1),vec2<i32>(0),size-1);
   var second=first;
   if(any(qa!=qb)){second=textureLoad(source,qb,0);}
   value=accumulate(value,second,select(coefficients.z,coefficients.y,tap<0));
  }
 }
 return value.sum;
}`
