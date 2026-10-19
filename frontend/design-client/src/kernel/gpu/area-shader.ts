import vectorWgsl from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import vectorGlsl from './vector.glsl?raw'
import coverageWgsl from '../../../../../design-studio/crates/design-kernel/shaders/coverage64.wgsl?raw'
import coverageGlsl from './coverage64.glsl?raw'
import areaWgsl from '../../../../../design-studio/crates/design-kernel/shaders/area.wgsl?raw'
import areaGlsl from './area.glsl?raw'

export const areaShaderWgsl =
  vectorWgsl.slice(0, vectorWgsl.indexOf('fn fixedLinear')) +
  vectorWgsl.slice(vectorWgsl.indexOf('fn scaledPositive64'), vectorWgsl.indexOf('fn paintUV')) +
  coverageWgsl +
  areaWgsl +
  `
struct AreaParams { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:AreaParams;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
fn cvFetch(index:u32)->vec4<f32>{return curves[u32(params.values[9].x)+index];}
fn cvSampleIndex()->i32{return i32(params.values[9].z);}
@vertex fn areaQuad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32((i)&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
@fragment fn areaFragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{return vec4<f32>(areaCoverage(vec2<i32>(floor(p.xy))));}
`

export const areaShaderGlsl =
  `#version 300 es
precision highp float;precision highp int;
layout(std140) uniform Params {vec4 u[64];};
uniform highp sampler2D sourceCurves;
out vec4 color;
int cvSampleIndex(){return int(u[9].z);}
vec4 cvFetch(uint index){int i=int(uint(u[9].x)+index);ivec2 size=textureSize(sourceCurves,0);return texelFetch(sourceCurves,ivec2(i%size.x,i/size.x),0);}
` +
  vectorGlsl.slice(
    vectorGlsl.indexOf('uvec2 wideMultiply'),
    vectorGlsl.indexOf('float fixedLinear'),
  ) +
  vectorGlsl.slice(
    vectorGlsl.indexOf('float scaledPositive64'),
    vectorGlsl.indexOf('vec2 paintUV'),
  ) +
  coverageGlsl +
  areaGlsl +
  `void main(){color=vec4(areaCoverage(ivec2(floor(gl_FragCoord.xy))));}`
