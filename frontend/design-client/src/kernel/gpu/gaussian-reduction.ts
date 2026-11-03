/** Display-only reconstruction for a certified reduced Gaussian work surface.
 * Its own small pipeline avoids compiling the general exact compositor just
 * to sample four neighbours. HDR/export never admit this recipe. */
export const gaussianReductionWgsl = `
struct Params { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var source:texture_2d<f32>;
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);
}
fn pixel(q:vec2<i32>)->vec4<f32>{
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(params.values[1].zw))){return vec4<f32>(0);}
 let value=textureLoad(source,q,0);
 if(params.values[9].y>0.5){return vec4<f32>(0,0,0,value.r);}
 return value;
}
// Each destination texel integrates the four full-density texels in its
// footprint. Both passes share the same device lattice, including odd and
// negative origins. Outside the source the filter sees transparent black.
@fragment fn downsample(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let base=(vec2<i32>(floor(position.xy))+vec2<i32>(params.values[0].xy))*2-vec2<i32>(params.values[1].xy);
 return (pixel(base)+pixel(base+vec2<i32>(1,0))+pixel(base+vec2<i32>(0,1))+pixel(base+vec2<i32>(1,1)))*0.25;
}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=(position.xy+params.values[0].xy)/params.values[9].x;
 let q=p-params.values[1].xy-0.5;let base=vec2<i32>(floor(q));let k=fract(q);
 return mix(mix(pixel(base),pixel(base+vec2<i32>(1,0)),k.x),
            mix(pixel(base+vec2<i32>(0,1)),pixel(base+vec2<i32>(1,1)),k.x),k.y);
}`
