/** A physical-pixel copy into a linear floating retained layer. Encoding and
 * premultiplied-alpha quantization happen only at final presentation. */
export const linearRetainedCaptureWgsl=`
struct Params { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var source:texture_2d<f32>;
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{
 let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);
}
@fragment fn fragment(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 if(params.values[9].x>0.5){return textureLoad(source,vec2<i32>(0),0);}
 let q=vec2<i32>(floor(position.xy+params.values[0].xy-params.values[1].xy));
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(textureDimensions(source)))){return vec4<f32>(0);}
 return textureLoad(source,q,0);
}`
