import compositor from '../../../../../design-studio/crates/design-kernel/shaders/vector.wgsl?raw'
import {sampleCoverageKernelWgsl} from './sample-only-area-shader'
// Both shaders consume the original native four-phase interval buffer. The
// uniform layout (including vec4 offsets) is packed by sourceLayer().
const layerBindings=sampleCoverageKernelWgsl+`
struct Params{values:array<vec4<f32>,64>}
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var dst:texture_2d<f32>;
@group(0) @binding(2) var soft1:texture_2d<f32>;
@group(0) @binding(3) var soft2:texture_2d<f32>;
@group(0) @binding(5) var soft3:texture_2d<f32>;
@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
var<private> program:u32;
var<private> nodeBase:u32;
fn word(i:u32)->vec4<f32>{return params.values[nodeBase+i-5u];}
fn cvFetch(i:u32)->vec4<f32>{return curves[program+i];}
@vertex fn quad(@builtin(vertex_index)i:u32)->@builtin(position)vec4<f32>{return vec4<f32>(f32((i<<1u)&2u)*2.-1.,1.-f32(i&2u)*2.,0.,1.);}
fn inside(p:vec2<i32>,r:vec4<f32>)->bool{let q=p-vec2<i32>(r.xy);return all(q>=vec2<i32>())&&all(q<vec2<i32>(r.zw));}
fn cov(p:vec2<i32>,r:vec4<f32>,index:f32,phase:u32)->f32{
 if(!inside(p,r)||index== -1.){return 0.;}if(index== -2.){return 1.;}
 program=u32(index);return sampleCoverage(p-vec2<i32>(r.xy),phase);
}
fn over(back:vec4<f32>,front:vec4<f32>)->vec4<f32>{if(front.a<=0.){return back;}if(back.a<=0.){return front;}return front+back*(1.-front.a);}
`
export const sourceLayerWgsl=layerBindings+`
fn brush(p:vec2<i32>,idx:u32,count:u32,radial:bool)->vec4<f32>{
 let param=word(idx);if(count==0u){return param;}
 let r=word(6u);let q=vec2<f32>(p-vec2<i32>(r.xy))/max(vec2<f32>(1.),r.zw-1.);
 var t=mix(mix(param.x,param.y,q.x),mix(param.z,param.w,q.x),q.y);
 if(radial){let v=word(idx+1u);t=length(vec2<f32>(t,mix(mix(v.x,v.y,q.x),mix(v.z,v.w,q.x),q.y)));}
 t=clamp(t,0.,1.);
 var stop=idx+1u+u32(radial);var col=word(stop+1u);if(t<=word(stop).x){return col;}
 for(var i=1u;i<count;i++){let a=word(stop).x;stop+=2u;let b=word(stop).x;let next=word(stop+1u);
  if(t<=b){return mix(col,next,(t-a)/(b-a));}col=next;}return col;
}
fn shape(p:vec2<i32>,phase:u32,alphaOnly:bool)->vec4<f32>{
 var color=vec4<f32>(0.);let fill=cov(p,word(7u),word(8u).x,phase);let end=u32(word(5u).z);
 for(var at=9u;at<end;){let r=word(at);let h=word(at+1u);let radial=h.z<0.;let count=u32(abs(h.z));
  if(cov(p,r,h.x,phase)>0.&&((h.y==0.)||(h.y==1.&&fill>0.)||(h.y== -1.&&fill==0.))){
   var c=vec4<f32>(0.);if(alphaOnly){c.a=word(at+2u+select(0u,2u+u32(radial),count>0u)).a;}else{c=brush(p,at+2u,count,radial);}
   color=over(color,c*h.w);
  }at+=3u+u32(radial)+count*2u;
 }return color;
}
fn resolvedAlpha(p:vec2<i32>)->f32{
 return (shape(p,0u,true).a+shape(p,1u,true).a+shape(p,2u,true).a+shape(p,3u,true).a)*.25;
}
fn alphaAt(tex:texture_2d<f32>,p:vec2<i32>,r:vec4<f32>)->f32{
 if(!inside(p,r)){return 0.;}return textureLoad(tex,min(p-vec2<i32>(r.xy),vec2<i32>(textureDimensions(tex))-1),0).a;
}
fn soft(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->f32{
 let q=vec2<i32>(floor(p));let k=fract(p);
 return mix(mix(alphaAt(tex,q,r),alphaAt(tex,q+vec2<i32>(1,0),r),k.x),mix(alphaAt(tex,q+vec2<i32>(0,1),r),alphaAt(tex,q+vec2<i32>(1),r),k.x),k.y);
}
@fragment fn fragment(@builtin(position) pos:vec4<f32>)->@location(0)vec4<f32>{
 let p=vec2<i32>(floor(pos.xy))+vec2<i32>(params.values[0].xy);let phase=u32(params.values[5].x);
 let r=params.values[1];var back=vec4<f32>(0.);
 if(inside(p,r)){back=textureLoad(dst,min(p-vec2<i32>(r.xy),vec2<i32>(textureDimensions(dst))-1),0);}
 if(params.values[4].z>0.&&alphaAt(soft1,p,params.values[2])==0.){return back;}
 nodeBase=5u;
 for(var layer=0u;layer<u32(params.values[4].y);layer++){
 let end=u32(word(5u).w);
 if(!inside(p,word(6u))){nodeBase+=end-5u;continue;}
 var value=shape(p,phase,false);
 for(var at=u32(word(5u).z);at<end;at+=3u){
  let h=word(at);let domain=word(at+2u);let shifted=vec2<f32>(p)-h.yz;var alpha=0.;
  if(h.w<=0.){let q=vec2<i32>(floor(shifted));let k=fract(shifted);
   if(h.w<0.){alpha=shape(q,phase,true).a;}else{
    alpha=mix(mix(resolvedAlpha(q),resolvedAlpha(q+vec2<i32>(1,0)),k.x),mix(resolvedAlpha(q+vec2<i32>(0,1)),resolvedAlpha(q+vec2<i32>(1)),k.x),k.y);}
  }else if(h.w==1.){alpha=soft(soft1,shifted,domain);}else if(h.w==2.){alpha=soft(soft2,shifted,domain);}else{alpha=soft(soft3,shifted,domain);}
  if(h.x==2.){value=over(value,word(at+1u)*(value.a*(1.-alpha)));}else{value=over(word(at+1u)*alpha,value);}
 }
 back=over(back,value*word(5u).y);nodeBase+=end-5u;
 }return back;
}`


const controlsStart=compositor.indexOf('fn ccEncode('),controlsEnd=compositor.indexOf('fn motionKernelTap(')
if(controlsStart<0||controlsEnd<controlsStart)throw Error('Unexpected colour control shader')
export const sourceImageLayerWgsl=layerBindings+compositor.slice(controlsStart,controlsEnd)+`
fn u(i:u32)->vec4<f32>{return params.values[i];}
fn addRN(a:f32,b:f32)->f32{return a+b;}
fn mulRN(a:f32,b:f32)->f32{return a*b;}
fn divideRN(a:f32,b:f32)->f32{return a/b;}
fn tableWord(i:i32,row:i32)->f32{
 let c=vec4<u32>(round(textureLoad(soft1,vec2<i32>(i,row),0)*255.));
 return bitcast<f32>(c.x|(c.y<<8u)|(c.z<<16u)|(c.w<<24u));
}
fn texel(q:vec2<i32>)->vec4<f32>{
 let dimensions=vec2<i32>(u(2).zw);
 let local=q-vec2<i32>(u(2).xy);
 if(any(local<vec2<i32>(0))||any(local>=dimensions)){return vec4<f32>(0.);}
 let value=textureLoad(soft1,local,0);
 if(u(4).z==0.){return value;}
 let c=vec4<i32>(round(value*255.));let a=tableWord(c.a,dimensions.y+1);
 return vec4<f32>(vec3<f32>(tableWord(c.r,dimensions.y),tableWord(c.g,dimensions.y),tableWord(c.b,dimensions.y))*a,a);
}
@fragment fn imageLayer(@builtin(position) pos:vec4<f32>)->@location(0)vec4<f32>{
 let p=vec2<i32>(floor(pos.xy))+vec2<i32>(u(0).xy);var back=vec4<f32>(0.);
 if(inside(p,u(1))){back=textureLoad(dst,min(p-vec2<i32>(u(1).xy),vec2<i32>(textureDimensions(dst))-1),0);}
 if(!inside(p,u(5))||cov(p,u(6),u(7).x,u32(u(4).y))==0.){return back;}
 let pixel=p-vec2<i32>(u(5).xy);let ax=textureLoad(soft2,vec2<i32>(pixel.x,0),0);let ay=textureLoad(soft2,vec2<i32>(pixel.y,1),0);
 var color=vec4<f32>(0.);
 if(ax.z>0.&&ay.z>0.){let q=vec2<i32>(i32(ax.x),i32(ay.x));
 color=mix(mix(texel(q),texel(q+vec2<i32>(1,0)),ax.y),mix(texel(q+vec2<i32>(0,1)),texel(q+vec2<i32>(1)),ax.y),ay.y)*u(7).y;}
 color=over(color,u(8));
 if(u(4).w>0.){color=colorControlsPixel(color);}
 return over(back,color*u(7).z);
}`
