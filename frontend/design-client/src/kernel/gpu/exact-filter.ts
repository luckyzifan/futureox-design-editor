/** A dedicated exact filter entry point keeps the compositor's other passes
 * free of the large integer reducer. Both paths use the shared production math. */
import samplingWgsl from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import samplingGlsl from './sampling.glsl?raw'
import rationalWgsl from '../../../../../design-studio/crates/design-kernel/shaders/rational-filter.wgsl?raw'
import rationalGlsl from './rational-filter.glsl?raw'
import certifiedWgsl from '../../../../../design-studio/crates/design-kernel/shaders/certified-rational.wgsl?raw'
import certifiedGlsl from './certified-rational.glsl?raw'
import { canvasBlurChannelWgsl, canvasBlurRgbaWgsl } from './canvas-blur-filter'
export const rationalStubWgsl = 'fn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}'
export const rationalStubGlsl = 'vec4 rationalBlur(vec2 point,vec2 axis){return vec4(0);}'
/** An admitted small uniform box has an integer denominator. Sum each normal
 * positive binary32 mantissa at its minimum exponent, and round the integer
 * quotient once, to nearest even. Two words cover an exponent spread of 31
 * across at most 17 taps. Other channels keep the original reducer. */
const smallExactBoxWgsl = `
fn shiftedBoxWord(low:u32,high:u32,shift:u32)->u32 {
 if(shift==0u){return low;}
 if(shift>=32u){return high>>(shift-32u);}
 return (low>>shift)|(high<<(32u-shift));
}
fn smallBoxRemainder(low:u32,high:u32,bits:u32)->bool {
 if(bits==0u){return false;}
 if(bits<32u){return (low&((1u<<bits)-1u))!=0u;}
 return low!=0u||(high&((1u<<(bits-32u))-1u))!=0u;
}
fn smallBoxMean(low:u32, high:u32, taps:u32, minimum:u32)->vec2<u32> {
 if(low==0u&&high==0u){return vec2<u32>(0u,1u);}
 let leading=select(firstLeadingBit(low),32u+firstLeadingBit(high),high!=0u);
 var height=leading-firstLeadingBit(taps);
 var limitLow=0u;
 var limitHigh=0u;
 if(height>=32u){limitHigh=taps<<(height-32u);}
 else{
  limitLow=taps<<height;
  if(height!=0u){limitHigh=taps>>(32u-height);}
 }
 if(high<limitHigh||(high==limitHigh&&low<limitLow)){height=height-1u;}
 var exponent=i32(minimum)+i32(height)-23;
 if(exponent<=0||exponent>=255){return vec2<u32>(0u);}
 let shift=u32(max(i32(height)-23,0));
 var numerator=shiftedBoxWord(low,high,shift);
 if(height<23u){numerator=low<<(23u-height);}
 var mantissa=numerator/taps;
 let twice=(numerator-mantissa*taps)*2u;
 var roundUp=twice>taps;
 // The tap count is odd. The discarded bits can decide the rounding only
 // when the integer remainder is exactly half a tap below the midpoint.
 if(shift!=0u&&twice+1u==taps&&(shiftedBoxWord(low,high,shift-1u)&1u)!=0u){
  roundUp=smallBoxRemainder(low,high,shift-1u)||(mantissa&1u)!=0u;
 }
 if(roundUp){mantissa=mantissa+1u;}
 if(mantissa==0x01000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=255){return vec2<u32>(0u);}
 return vec2<u32>((u32(exponent)<<23u)|(mantissa&0x007fffffu),1u);
}
@fragment fn fragmentSmallBox(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let point=position.xy+u(0).xy;
 let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);
 let reach=i32(rfLoad(2u));
 var words:array<vec4<u32>,17>;
 var minimum=vec4<u32>(255);
 var valid=vec4<bool>(true);
 for(var tap=-reach;tap<=reach;tap=tap+1){
  let bits=bitcast<vec4<u32>>(rfSource(point+axis*f32(tap)));
  let magnitude=bits&vec4<u32>(0x7fffffffu);
  let exponent=(bits>>vec4<u32>(23))&vec4<u32>(255);
  let normal=(bits==magnitude)&(exponent>vec4<u32>(0))&(exponent<vec4<u32>(255));
  words[tap+reach]=select(vec4<u32>(0),bits,normal);
  minimum=min(minimum,select(vec4<u32>(255),exponent,normal));
  valid=valid&(normal|(magnitude==vec4<u32>(0)));
 }
 var low=vec4<u32>(0);
 var high=vec4<u32>(0);
 for(var i=0;i<=reach*2;i=i+1){
  let bits=words[i];
  let normal=bits!=vec4<u32>(0);
  let exponent=bits>>vec4<u32>(23);
  let shift=select(vec4<u32>(0),exponent-minimum,normal);
  let mantissa=select(vec4<u32>(0),(bits&vec4<u32>(0x007fffffu))|vec4<u32>(0x00800000u),normal);
  let safeShift=min(shift,vec4<u32>(31));
  let added=mantissa<<safeShift;
  let upper=select(vec4<u32>(0),mantissa>>((vec4<u32>(32)-safeShift)&vec4<u32>(31)),safeShift!=vec4<u32>(0));
  let next=low+added;
  high=high+upper+select(vec4<u32>(0),vec4<u32>(1),next<low);
  low=next;
  valid=valid&(shift<=vec4<u32>(31));
 }
 var result=vec4<f32>(0);
 for(var channel=0u;channel<4u;channel=channel+1u){
  if(valid[channel]){
   let mean=smallBoxMean(low[channel],high[channel],u32(reach*2+1),minimum[channel]);
   if(mean.y!=0u){result[channel]=bitcast<f32>(mean.x);continue;}
  }
  result[channel]=exactFilterChannel(point,axis,channel);
 }
 return result;
}
`

export function exactFilterWgsl(certified: boolean, canvasBlur = false, rgba = false, uniformBox = false, smallExactBox = false) {
  const source = `struct Params {values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
@group(0) @binding(2) var sourceB:texture_2d<f32>;
@group(0) @binding(3) var sourceC:texture_2d<f32>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
const FILTER_SOURCE_WINDOWS:bool=${import.meta.env.VITE_DESIGN_FILTER_SOURCE_WINDOW === '1'};
fn filterSourcePixel(q:vec2<i32>)->vec2<i32>{
 if(FILTER_SOURCE_WINDOWS&&u(52u).z==1.){return q+vec2<i32>(u(52u).xy);}
 return q;
}
` + samplingWgsl.slice(0, samplingWgsl.indexOf('fn bsParts')) + rationalWgsl + (certified ? certifiedWgsl : '') + `
fn exactFilterChannel(p:vec2<f32>,axis:vec2<f32>,channel:u32)->f32{
${certified ? 'let result=rfCertifiedChannel(p,axis,channel);if(result.y!=0u){return bitcast<f32>(result.x);}' : ''}
return rfChannel(p,axis,channel);
}
${canvasBlur ? canvasBlurChannelWgsl : ''}
${canvasBlur && rgba ? canvasBlurRgbaWgsl(uniformBox) : ''}
${smallExactBox ? smallExactBoxWgsl : ''}
override FILTER_CHANNEL:u32=0u;
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
let p=position.xy+u(0).xy;let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);
return vec4<f32>(${canvasBlur ? 'canvasBlurChannel' : 'exactFilterChannel'}(p,axis,FILTER_CHANNEL));
}

${canvasBlur && rgba ? `@fragment fn fragmentRgba(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
let p=position.xy+u(0).xy;let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);
return canvasBlurRgba(p,axis);}` : ''}`
  // Shadow filtering consumes only alpha. R32F stores that f32 unchanged;
  // expand at the source boundary so the identical channel reducer still runs.
  return source.replaceAll('return textureLoad(sourceA,q,0);',
    'let value=textureLoad(sourceA,filterSourcePixel(q),0);return select(value,vec4<f32>(value.r),(u32(u(62).w)&1u)!=0u);')
}
export function exactFilterGlsl(certified: boolean) {
  return `#version 300 es
precision highp float;precision highp int;
layout(std140) uniform Params {vec4 u[64];};
uniform highp sampler2D sourceA;uniform highp sampler2D sourceB;uniform highp sampler2D sourceC;
out vec4 color;
uniform int filterChannel;
` + samplingGlsl.slice(0, samplingGlsl.indexOf('uvec3 bsParts')) + rationalGlsl + (certified ? certifiedGlsl : '') + `
float exactFilterChannel(vec2 p,vec2 axis,uint channel){
${certified ? 'uvec2 result=rfCertifiedChannel(p,axis,channel);if(result.y!=0u)return uintBitsToFloat(result.x);' : ''}
return rfChannel(p,axis,channel);
}
void main(){vec2 p=gl_FragCoord.xy+u[0].xy;vec2 axis=u[9].y<.5?vec2(1,0):vec2(0,1);
color=vec4(exactFilterChannel(p,axis,uint(filterChannel)));}
`
}
