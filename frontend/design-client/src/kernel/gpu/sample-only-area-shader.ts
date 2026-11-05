import areaWgsl from '../../../../../design-studio/crates/design-kernel/shaders/area.wgsl?raw'

/** Keep the existing sample classification verbatim. The hypothesis is only
 * that excluding unused analytic coverage routines/private storage may reduce
 * shader resource pressure; fewer registers or faster GPU work is unproven. */
const bitsEnd = areaWgsl.indexOf('fn cvAxis(')
const samplesStart = areaWgsl.indexOf('// Exact binary64 ordering')
const samplesEnd = areaWgsl.indexOf('fn areaCoverage(')
if (bitsEnd < 0 || samplesStart < bitsEnd || samplesEnd < samplesStart)
  throw Error('Unexpected shared sample coverage shader boundaries')

export const sampleCoverageKernelWgsl=areaWgsl.slice(0,bitsEnd)+areaWgsl.slice(samplesStart,samplesEnd)
export const sampleOnlyAreaShaderWgsl = sampleCoverageKernelWgsl + `
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
fn sampleCoverageSparse(pixel:vec2<i32>,index:u32)->f32{
 let header:vec4<f32>=cvFetch(0u);
 if(header.x==4.||header.x==5.){return sampleCoverage(pixel,index);}
 let record:vec4<f32>=cvFetch(u32(header.y)+u32(pixel.y)*4u+index);
 if(record.z==1.){return 1.;}
 return sampleCoverage(pixel,index);
}
@fragment fn areaSampleFragmentSparse(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{
 let pixel=vec2<i32>(floor(p.xy))+vec2<i32>(params.values[10].xy);
 if(any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(params.values[10].zw))){return vec4<f32>(0);}
 return vec4<f32>(sampleCoverageSparse(pixel,u32(params.values[9].z)-1u));
}
struct AreaSamples {
 @location(0) phase0:vec4<f32>,
 @location(1) phase1:vec4<f32>,
 @location(2) phase2:vec4<f32>,
 @location(3) phase3:vec4<f32>,
}
@fragment fn areaSamplesFragment(@builtin(position) p:vec4<f32>)->AreaSamples {
 let pixel=vec2<i32>(floor(p.xy))+vec2<i32>(params.values[10].xy);
 let outside=any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(params.values[10].zw));
 var out:AreaSamples;
 if(outside){return out;}
 out.phase0=vec4<f32>(sampleCoverage(pixel,0u));
 out.phase1=vec4<f32>(sampleCoverage(pixel,1u));
 out.phase2=vec4<f32>(sampleCoverage(pixel,2u));
 out.phase3=vec4<f32>(sampleCoverage(pixel,3u));
 return out;
}
@fragment fn areaSamplesFragmentSparse(@builtin(position) p:vec4<f32>)->AreaSamples {
 let pixel=vec2<i32>(floor(p.xy))+vec2<i32>(params.values[10].xy);
 let outside=any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(params.values[10].zw));
 var out:AreaSamples;
 if(outside){return out;}
 out.phase0=vec4<f32>(sampleCoverageSparse(pixel,0u));
 out.phase1=vec4<f32>(sampleCoverageSparse(pixel,1u));
 out.phase2=vec4<f32>(sampleCoverageSparse(pixel,2u));
 out.phase3=vec4<f32>(sampleCoverageSparse(pixel,3u));
 return out;
}
`
