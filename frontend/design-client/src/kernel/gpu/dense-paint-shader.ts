import compositor from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import {sampleCoverageKernelWgsl} from './sample-only-area-shader'
export const DENSE_PAINT_MODE=78
const arithmetic=compositor.slice(compositor.indexOf('fn wideMultiply('),compositor.indexOf('fn sqrtRN('))
const first=compositor.indexOf('fn fixedLinear(')
const fixed=compositor.slice(first,compositor.indexOf('\n}',first)+2)
  .replace('fixedLinear(point:vec2<f32>)','denseFixed(point:vec2<f32>,table:u32,fractionBits:f32)')
  .replace('u(63).x','fractionBits').replace('u(49)','word(table)').replace('u(50)','word(table+1u)').replace('u(51)','word(table+2u)')

// A stack entry is one isolated source, exactly as in the ordinary painter.
// Paths read the same binary64 interval endpoints. Stop weights come from
// the native sampler or the existing fixed-point [0,1] gradient operation.
export const densePaintWgsl=arithmetic+sampleCoverageKernelWgsl+`
struct Params{values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var dst:texture_2d<f32>;
@group(0) @binding(2) var atlas:texture_2d<f32>;
@group(0) @binding(3) var clipTex:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
var<private> program:u32;
fn cvFetch(i:u32)->vec4<f32>{return curves[program+i];}
fn word(i:u32)->vec4<f32>{let w=textureDimensions(atlas).x;return textureLoad(atlas,vec2<i32>(i32(i%w),i32(i/w)),0);}
fn inside(p:vec2<i32>,r:vec4<f32>)->bool{let q=p-vec2<i32>(r.xy);return all(q>=vec2<i32>(0))&&all(q<vec2<i32>(r.zw));}
fn mask(p:vec2<i32>,r:vec4<f32>,at:f32,phase:u32)->bool{
 if(at== -1.||!inside(p,r)){return false;}if(at== -2.){return true;}
 program=u32(at);return sampleCoverage(p-vec2<i32>(r.xy),phase)>0.;
}
fn scaleColor(c:vec4<f32>,v:f32)->vec4<f32>{if(v==1.){return c;}return mulRN4(c,vec4<f32>(v));}
fn stopChannel(a:f32,b:f32,t:f32)->f32{if(a==b||t==0.){return a;}return addRN(a,mulRN(addRN(b,-a),t));}
fn sourceOver(b:vec4<f32>,s:vec4<f32>)->vec4<f32>{
 if(s.a<=0.){return b;}if(b.a<=0.||(s.a==1.&&all(abs(b)<=vec4<f32>(3.4028234e38)))){return s;}return addRN4(s,mulRN4(b,vec4<f32>(addRN(1.,-s.a))));
}
`+fixed+`
fn brush(p:vec2<i32>,at:u32,phase:u32)->vec4<f32>{
 let spec=word(at+2u);let stops=at+3u;
 if(spec.x==0.){return word(stops);}
 let field=u32(spec.z);var a=0u;var b=1u;var t=0.;
 if(spec.x==1.){t=denseFixed(vec2<f32>(p)+sampleOffset(phase),field,spec.w);if(t==0.){b=0u;}}
 else{
  let region=word(field);var q=p-vec2<i32>(region.xy);if(region.z==1.){q.x=0;}if(region.w==1.){q.y=0;}let j=field+1u+2u*u32(q.y*i32(region.z)+q.x);
  t=word(j)[phase];let pair=u32(word(j+1u)[phase]);a=pair%64u;b=pair/64u;
 }
 let left=word(stops+a);if(a==b){return left;}
 let right=word(stops+b);return vec4<f32>(stopChannel(left.r,right.r,t),stopChannel(left.g,right.g,t),stopChannel(left.b,right.b,t),stopChannel(left.a,right.a,t));
}
fn evaluate(p:vec2<i32>,phase:u32,start:u32,back:vec4<f32>,clip:f32)->vec4<f32>{
 var colors:array<vec4<f32>,17>;var ends:array<u32,17>;var opacity:array<f32,17>;
 colors[0]=back;let limit=u32(word(start).x);var depth=0u;var pc=start;
 loop{
  if(depth>0u&&pc==ends[depth]){let src=scaleColor(colors[depth],opacity[depth]);depth--;colors[depth]=sourceOver(colors[depth],src);continue;}
  if(pc>=limit){break;}
  let hdr=word(pc);let end=u32(hdr.x);
  if(!inside(p,word(pc+1u))){pc=end;continue;}
  let children=u32(hdr.y);var source=vec4<f32>(0.);var cursor=pc+4u;
  while(cursor<children){
   let h=word(cursor);if(mask(p,word(cursor+1u),h.z,phase)){
    var covered=true;
    if(h.y!=0.){let fill=mask(p,word(pc+3u),word(pc+2u).x,phase);covered=select(!fill,fill,h.y>0.);}
    if(covered){source=sourceOver(source,scaleColor(brush(p,cursor,phase),h.w));}
   }
   cursor=u32(h.x);
  }
  var alpha=hdr.w;if(depth==0u&&clip!=1.){alpha=mulRN(alpha,clip);}
  if(children==end){colors[depth]=sourceOver(colors[depth],scaleColor(source,alpha));pc=end;}
  else{depth++;colors[depth]=source;ends[depth]=end;opacity[depth]=alpha;pc=children;}
 }
 return colors[0];
}
@vertex fn quad(@builtin(vertex_index)i:u32)->@builtin(position)vec4<f32>{return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);}
@fragment fn densePaint(@builtin(position) pos:vec4<f32>)->@location(0)vec4<f32>{
 let p=vec2<i32>(floor(pos.xy))+vec2<i32>(params.values[0].xy);let r=params.values[1];
 var out=vec4<f32>(0.);if(params.values[54].x==0.&&inside(p,r)){out=textureLoad(dst,min(p-vec2<i32>(r.xy),vec2<i32>(textureDimensions(dst))-1),0);}
 var clip=1.;if(params.values[4].w!=0.){let c=params.values[3];if(!inside(p,c)){return out;}clip=textureLoad(clipTex,min(p-vec2<i32>(c.xy),vec2<i32>(textureDimensions(clipTex))-1),0).a;}
 let phase=u32(params.values[4].z);
 for(var k=0u;k<u32(params.values[4].y);k++){out=evaluate(p,phase,u32(params.values[5u+k/4u][k%4u]),out,clip);}
 return out;
}`
