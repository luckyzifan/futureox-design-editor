import vectorWgsl from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import coverageWgsl from '../../../../../design-studio/crates/design-kernel/shaders/coverage64.wgsl?raw'
import areaWgsl from '../../../../../design-studio/crates/design-kernel/shaders/area.wgsl?raw'

/** Area coverage is the analytic mask (sample index 0: four-sample average
 * for headers 3/4/5, exact area otherwise) stored in RGBA32F. The blend is
 * the managed mode-0 branch of `over`, including mode 47's mulRN by opacity
 * 1 when there is no clip and the signed-zero canonicalization of the
 * covered source. One pass reads a copy of the destination, so every quad
 * in the draw must be pixel-disjoint. */
export const analyticViewportShader=
  vectorWgsl.slice(0,vectorWgsl.indexOf('fn fixedLinear'))+
  vectorWgsl.slice(vectorWgsl.indexOf('fn scaledPositive64'),vectorWgsl.indexOf('fn paintUV'))+
  coverageWgsl+
  areaWgsl+
  `
struct AnalyticParams { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:AnalyticParams;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
@group(1) @binding(0) var<storage,read> instances:array<vec4<f32>>;
var<private> programFirst:u32;
fn cvFetch(index:u32)->vec4<f32>{return curves[programFirst+index];}
fn cvSampleIndex()->i32{return 0;}
fn at(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{let q=vec2<i32>(floor(p-r.xy));if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(r.zw))){return vec4<f32>(0);}return textureLoad(tex,q,0);}
fn bsCorner4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{
 let mask:vec4<u32>=vec4<u32>(0x7fffffffu);let limit:vec4<u32>=vec4<u32>(0x7f7fffffu);
 let aa:vec4<u32>=bitcast<vec4<u32>>(a);let bb:vec4<u32>=bitcast<vec4<u32>>(b);
 let cc:vec4<u32>=bitcast<vec4<u32>>(c);let dd:vec4<u32>=bitcast<vec4<u32>>(d);
 var result:vec4<u32>=select(aa,vec4<u32>(0),(aa&mask)==vec4<u32>(0));
 result=select(result,dd,(dd&mask)>limit);result=select(result,cc,(cc&mask)>limit);
 result=select(result,bb,(bb&mask)>limit);result=select(result,aa,(aa&mask)>limit);
 return bitcast<vec4<f32>>(result);
}
fn integerSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{
 return bsCorner4(at(tex,p,r),at(tex,p+vec2<f32>(1,0),r),at(tex,p+vec2<f32>(0,1),r),at(tex,p+vec2<f32>(1,1),r));
}
struct AnalyticVertex { @builtin(position) position:vec4<f32>, @location(0) @interpolate(flat) item:u32 }
@vertex fn analyticQuad(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->AnalyticVertex{
 let corners=array<vec2<f32>,6>(vec2<f32>(0,0),vec2<f32>(1,0),vec2<f32>(0,1),vec2<f32>(0,1),vec2<f32>(1,0),vec2<f32>(1,1));
 let item=u32(params.values[9].x)+instance*5u;let r=instances[item+4u];
 let p=(r.xy+corners[vertex]*r.zw-params.values[0].xy)/params.values[0].zw;
 var out:AnalyticVertex;out.position=vec4<f32>(p.x*2.-1.,1.-p.y*2.,0.,1.);out.item=item;return out;
}
@fragment fn analyticFragment(input:AnalyticVertex)->@location(0) vec4<f32>{
 let rect=instances[input.item];let info=instances[input.item+1u];
 let pixel=vec2<i32>(floor(input.position.xy))+vec2<i32>(params.values[0].xy-rect.xy);
 let dst=integerSample(sourceA,input.position.xy+params.values[0].xy,params.values[1]);
 if(any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(rect.zw))){return dst;}
 programFirst=u32(info.x);
 let raw=instances[input.item+3u];
 let paint=mulRN4(mulRN4(vec4<f32>(raw.xyz,1.),vec4<f32>(raw.w)),vec4<f32>(info.y));
 let covered=mulRN4(paint,vec4<f32>(areaCoverage(pixel)));
 let bits=bitcast<vec4<u32>>(covered);
 let sampled=bitcast<vec4<f32>>(select(bits,vec4<u32>(0),(bits&vec4<u32>(0x7fffffffu))==vec4<u32>(0)));
 let src=mulRN4(sampled,vec4<f32>(1.));
 if(src.a<=0.){return dst;}if(dst.a<=0.){return src;}
 return addRN4(src,mulRN4(dst,vec4<f32>(addRN(1.,-src.a))));
}
`
