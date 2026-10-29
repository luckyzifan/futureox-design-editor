/** Presentation-only arithmetic. The rational packet remains the coefficient
 * authority; no radius conversion, resampling or halo change. Out-of-range
 * channels execute the original exact reducer on the GPU. */
export const canvasBlurChannelWgsl = `
fn canvasCoefficient(start:u32,words:u32)->f32 {
 var value=f32(rfLoad(start+words-1u));
 if(words>1u){value=value+f32(rfLoad(start+words-2u))*2.3283064365386963e-10;}
 if(words>2u){value=value+f32(rfLoad(start+words-3u))*5.421010862427522e-20;}
 return value;
}
fn canvasBlurChannel(point:vec2<f32>,axis:vec2<f32>,channel:u32)->f32 {
 let cw=rfLoad(0u);let reach=i32(rfLoad(2u));
 let q=vec2<i32>(floor(point-u(1u).xy));let size=vec2<i32>(u(1u).zw);
 let horizontal=axis.x!=0.;let coordinate=select(q.y,q.x,horizontal);
 let length=select(size.y,size.x,horizontal);
 let cross=select(q.x,q.y,horizontal);let crossLength=select(size.x,size.y,horizontal);
 let edge=u(9u).z>0.5;
 let aligned=all(u(0u)==floor(u(0u)))&&all(u(1u)==floor(u(1u)));
 if(aligned&&!edge&&(cross<0||cross>=crossLength)){return 0.;}
 // Absent source texels are exact +0. Skip only those taps, keeping the
 // original denominator and every in-domain endpoint (even zero weights).
 let lo=select(max(-reach,-coordinate),-reach,edge||!aligned);
 let hi=select(min(reach,length-1-coordinate),reach,edge||!aligned);
 if(lo>hi){return 0.;}
 let firstBits=bitcast<u32>(rfSource(point+axis*f32(lo))[channel]);
 let first=select(firstBits,0u,(firstBits&0x7fffffffu)==0u);
 if((first&0x7fffffffu)<0x7f800000u&&(first==0u||(lo==-reach&&hi==reach))){
  let lastBits=bitcast<u32>(rfSource(point+axis*f32(hi))[channel]);
  if(select(lastBits,0u,(lastBits&0x7fffffffu)==0u)==first){
   var same=true;
   for(var tap=lo+1;tap<hi;tap=tap+1){
    let bits=bitcast<u32>(rfSource(point+axis*f32(tap))[channel]);
    if(select(bits,0u,(bits&0x7fffffffu)==0u)!=first){same=false;break;}
   }
   if(same){return bitcast<f32>(first);}
  }
 }
 let denominator=canvasCoefficient(4u,cw);
 var sum=0.;var correction=0.;
 for(var tap=lo;tap<=hi;tap=tap+1){
  let sample=rfSource(point+axis*f32(tap))[channel];
  let bits=bitcast<u32>(sample);
  // Negative zero is canonicalized to +0 by the exact reducer as well.
  if((bits&0x7fffffffu)>0x3f800000u||((bits&0x80000000u)!=0u&&(bits&0x7fffffffu)!=0u)){
   return exactFilterChannel(point,axis,channel);
  }
  let weight=canvasCoefficient(4u+cw*(1u+u32(abs(tap))),cw)/denominator;
  let value=sample*weight-correction;
  let next=sum+value;correction=(next-sum)-value;sum=next;
 }
 // This kernel is nonnegative and normalized. Only f32 overshoot is clamped;
 // authored HDR took the exact fallback above.
 return clamp(sum,0.,1.);
}
`

export function canvasBlurSceneEligible(enabled: boolean,
  scene: { integratedBlur?: boolean; softwareRaster?: boolean; displayFilters?: boolean },
  driver: { name?: string; managed?: boolean; hdr?: boolean; displayMath?: boolean },
  readback: boolean, present: boolean) {
  return enabled && !readback && present && driver.name === 'webgpu' && driver.managed === true &&
    !driver.hdr && !driver.displayMath && !scene.softwareRaster && !scene.displayFilters
}

export function canvasBlurGeometry(u: Float32Array) {
  return u.subarray(0, 8).every(v => Number.isFinite(v) && Math.abs(v) <= 1048576)
}

export function canvasBlurPassEligible(enabled: boolean, u: Float32Array, channels: number,
  filter?: { kind: 'tent'; radius: number }) {
  if (!enabled || u[16] !== 22 || (channels !== 15 && channels !== 8)) return false
  // Aligned device texels use zero-support clipping in the shader; fractional
  // origins retain every original tap and its original addressing operations.
  if (!canvasBlurGeometry(u)) return false
  // Explicit Gaussian passes carry the exact box packet and mode marker 2.
  // They have no tent/prefix metadata and keep all six H/V boundaries.
  if (u[39] === 2) return !filter && Number.isInteger(u[36]) && u[36] > 0 && u[36] <= 512
  return u[39] === 1 && filter?.kind === 'tent' && Number.isFinite(filter.radius) &&
    filter.radius > 0 && filter.radius <= (channels === 8 ? 4096 : 2048) && Math.fround(filter.radius) === u[36]
}
