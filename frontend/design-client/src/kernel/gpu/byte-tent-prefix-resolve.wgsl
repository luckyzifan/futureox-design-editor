@group(0) @binding(0) var<uniform> config:ByteTentConfig;
@group(0) @binding(1) var sourceAlpha:texture_2d<f32>;
@group(0) @binding(2) var<storage,read> prefixes:array<vec4<u32>>;
fn btPrefix(line:u32,at:i32,length:u32)->vec4<u32>{
 if(at<0){return vec4<u32>(0u);}return prefixes[line*length+min(u32(at),length-1u)];
}
fn btWindow(line:u32,first:i32,last:i32,length:u32)->vec4<u32>{
 if(last<first||last<0||first>=i32(length)){return vec4<u32>(0u);}
 let a=btPrefix(line,last,length);let b=btPrefix(line,first-1,length);
 return vec4<u32>(a.x-b.x,0u,btSub(a.zw,b.zw));
}
fn btAlpha(pixel:vec2<i32>)->u32{
 if(any(pixel<vec2<i32>(0))||any(pixel>=vec2<i32>(config.dims.xy))){return 0u;}
 return u32(round(textureLoad(sourceAlpha,pixel,0).a*255.));
}
fn btByte(numerator:vec2<u32>,denominator:u32)->u32{
 var low=0u;var high=256u;
 for(var bit=0u;bit<8u;bit=bit+1u){let middle=(low+high)/2u;
  if(btLe(btMul(denominator,middle),numerator)){low=middle;}else{high=middle;}
 }
 let remainder=btSub(numerator,btMul(denominator,low));let twice=remainder.x*2u;
 let up=twice>denominator||(twice==denominator&&(low&1u)!=0u);
 return low+select(0u,1u,up);
}
@vertex fn byteTentQuad(@builtin(vertex_index) index:u32)->@builtin(position) vec4<f32>{
 let positions=array<vec2<f32>,3>(vec2<f32>(-1.,-1.),vec2<f32>(3.,-1.),vec2<f32>(-1.,3.));return vec4<f32>(positions[index],0.,1.);
}
@fragment fn resolveByteTent(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let horizontal=config.settings.y==0u;let local=vec2<u32>(position.xy);let line=select(local.x,local.y,horizontal);
 if(line<config.settings.z||line>=config.settings.z+config.settings.w){discard;}
 let sourcePixel=vec2<i32>(local)+config.offsets.xy;let center=select(sourcePixel.y,sourcePixel.x,horizontal);
 let length=select(config.dims.y,config.dims.x,horizontal);let radius=i32(config.settings.x);
 let left=btWindow(line-config.settings.z,center-radius+1,center,length);
 let right=btWindow(line-config.settings.z,center+1,center+radius-1,length);
 var leftWeighted=left.zw;
 if(center>=radius){leftWeighted=btSub(leftWeighted,btMul(u32(center-radius),left.x));}
 else{leftWeighted=btAdd(leftWeighted,btMul(u32(radius-center),left.x));}
 var rightWeighted=vec2<u32>(0u);
 if(center+radius>=0){rightWeighted=btSub(btMul(u32(center+radius),right.x),right.zw);}
 let triangular=btAdd(leftWeighted,rightWeighted);
 let centerAlpha=btAlpha(sourcePixel);let delta=select(vec2<i32>(0,1),vec2<i32>(1,0),horizontal)*radius;
 let edges=btAlpha(sourcePixel-delta)+btAlpha(sourcePixel+delta);
 let numerator=btAdd(btSub(btScale(triangular,6u),vec2<u32>(centerAlpha*2u,0u)),vec2<u32>(edges,0u));
 let denominator=6u*config.settings.x*config.settings.x;let alpha=btByte(numerator,denominator);
 return vec4<f32>(0.,0.,0.,f32(alpha)/255.);
}
