import {sampleCoverageKernelWgsl} from './sample-only-area-shader'
// Same binary64 sample classification as the ordinary four coverage planes.
// Empty fragments discard; every covered fragment writes the same opaque
// canonical f32 colour. No blend reassociation, reduced samples or MSAA.
export const opaqueSolidShader=sampleCoverageKernelWgsl+`
struct Params{values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
@group(1) @binding(0) var<storage,read> instances:array<vec4<f32>>;
var<private> programFirst:u32;
fn cvFetch(index:u32)->vec4<f32>{return curves[programFirst+index];}
struct V{@builtin(position) position:vec4<f32>,@location(0) @interpolate(flat) item:u32}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) instance:u32)->V{
 let corners=array<vec2<f32>,6>(vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
 let item=u32(params.values[9].x)+instance*5u;let r=instances[item+4u];
 let p=(r.xy+corners[v]*r.zw-params.values[0].xy)/params.values[0].zw;
 return V(vec4(p.x*2.-1.,1.-p.y*2.,0.,1.),item);
}
@fragment fn fragment(v:V)->@location(0) vec4<f32>{
 let r=instances[v.item];programFirst=u32(instances[v.item+1u].x);
 let pixel=vec2<i32>(floor(v.position.xy))+vec2<i32>(params.values[0].xy-r.xy);
 if(any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(r.zw))){discard;}
 if(sampleCoverage(pixel,u32(params.values[9].y))!=1.){discard;}
 return instances[v.item+3u];
}
`
