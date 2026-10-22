import areaWgsl from '../../../../../design-studio/crates/design-kernel/shaders/area.wgsl?raw'

/** Keep the existing sample classification verbatim. The hypothesis is only
 * that excluding unused analytic coverage routines/private storage may reduce
 * shader resource pressure; fewer registers or faster GPU work is unproven. */
const bitsEnd = areaWgsl.indexOf('fn cvAxis(')
const samplesStart = areaWgsl.indexOf('// Exact binary64 ordering')
const samplesEnd = areaWgsl.indexOf('fn areaCoverage(')
if (bitsEnd < 0 || samplesStart < bitsEnd || samplesEnd < samplesStart)
  throw Error('Unexpected shared sample coverage shader boundaries')

export const sampleOnlyAreaShaderWgsl = areaWgsl.slice(0, bitsEnd) +
  areaWgsl.slice(samplesStart, samplesEnd) + `
struct AreaParams { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:AreaParams;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
fn cvFetch(index:u32)->vec4<f32>{return curves[u32(params.values[9].x)+index];}
@vertex fn areaQuad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32((i)&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
@fragment fn areaSampleFragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
 let pixel=vec2<i32>(floor(p.xy))+vec2<i32>(params.values[10].xy);
 if(any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(params.values[10].zw))){return vec4<f32>(0);}
 return vec4<f32>(sampleCoverage(pixel,u32(params.values[9].z)-1u));
}
`
