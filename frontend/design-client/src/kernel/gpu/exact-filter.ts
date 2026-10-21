/** A dedicated exact filter entry point keeps the compositor's other passes
 * free of the large integer reducer. Both paths use the shared production math. */
import samplingWgsl from '../../../../../design-studio/crates/design-kernel/shaders/sampling.wgsl?raw'
import samplingGlsl from './sampling.glsl?raw'
import rationalWgsl from '../../../../../design-studio/crates/design-kernel/shaders/rational-filter.wgsl?raw'
import rationalGlsl from './rational-filter.glsl?raw'
import certifiedWgsl from '../../../../../design-studio/crates/design-kernel/shaders/certified-rational.wgsl?raw'
import certifiedGlsl from './certified-rational.glsl?raw'
export const rationalStubWgsl = 'fn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{return vec4<f32>(0);}'
export const rationalStubGlsl = 'vec4 rationalBlur(vec2 point,vec2 axis){return vec4(0);}'
export function exactFilterWgsl(certified: boolean) {
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
override FILTER_CHANNEL:u32=0u;
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
let p=position.xy+u(0).xy;let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);
return vec4<f32>(exactFilterChannel(p,axis,FILTER_CHANNEL));
}`
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
