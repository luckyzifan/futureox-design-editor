// Correctly rounded binary32 division for paint coordinates. GPU reciprocal
// approximations can move an exact gradient half-byte across its rounding tie.
fn divideRN(a:f32,b:f32)->f32 {
 let ab=bitcast<u32>(a);let bb=bitcast<u32>(b);let sign=(ab^bb)&0x80000000u;
 let ae=(ab>>23u)&255u;let be=(bb>>23u)&255u;
 if(ae==255u||be==255u){return a/b;}
 var numerator=(ab&0x7fffffu)|select(0u,0x800000u,ae!=0u);
 var denominator=(bb&0x7fffffu)|select(0u,0x800000u,be!=0u);
 if(denominator==0u){return a/b;}if(numerator==0u){return bitcast<f32>(sign);}
 let sa=23u-highestBit(numerator);let sb=23u-highestBit(denominator);
 numerator=numerator<<sa;denominator=denominator<<sb;
 var exponent=i32(max(ae,1u))-i32(sa)-i32(max(be,1u))+i32(sb)+127;
 if(numerator<denominator){numerator=numerator*2u;exponent=exponent-1;}
 var remainder=numerator-denominator;var mantissa=0x800000u;
 for(var bit=22;bit>=0;bit=bit-1){remainder=remainder*2u;if(remainder>=denominator){remainder=remainder-denominator;mantissa=mantissa|(1u<<u32(bit));}}
 if(exponent<=0){let shift=u32(1-exponent);if(shift>24u){return bitcast<f32>(sign);}
  let q=mantissa>>shift;let tail=mantissa&((1u<<shift)-1u);let halfway=1u<<(shift-1u);
  let up=tail>halfway||(tail==halfway&&(remainder!=0u||(q&1u)!=0u));return bitcast<f32>(sign|(q+select(0u,1u,up)));}
 if(remainder*2u>denominator||(remainder*2u==denominator&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 if(mantissa==0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=255){return bitcast<f32>(sign|0x7f800000u);}
 return bitcast<f32>(sign|(u32(exponent)<<23u)|(mantissa&0x7fffffu));
}
// Signed 64-bit affine paint coordinates. Limbs remain exact integers; no
// floating-point division, reassociation or contraction enters this path.
fn wideMultiply(a:u32,b:u32)->vec2<u32>{let a0=a&65535u;let a1=a>>16u;let b0=b&65535u;let b1=b>>16u;let p0=a0*b0;let p1=a1*b0;let p2=a0*b1;let carry=(p0>>16u)+(p1&65535u)+(p2&65535u);return vec2<u32>((p0&65535u)|(carry<<16u),a1*b1+(p1>>16u)+(p2>>16u)+(carry>>16u));}
fn add64(a:vec2<u32>,b:vec2<u32>)->vec2<u32>{let lo=a.x+b.x;return vec2<u32>(lo,a.y+b.y+select(0u,1u,lo<a.x));}
fn negate64(a:vec2<u32>)->vec2<u32>{let lo=~a.x+1u;return vec2<u32>(lo,~a.y+select(0u,1u,lo==0u));}
fn timesCoordinate(a:vec2<u32>,b:i32)->vec2<u32>{let k=u32(abs(b));let product=wideMultiply(a.x,k);let value=vec2<u32>(product.x,product.y+a.y*k);if(b<0){return negate64(value);}return value;}
fn unpack64(words:vec4<f32>)->vec2<u32>{let w=vec4<u32>(words);return vec2<u32>(w.x|(w.y<<16u),w.z|(w.w<<16u));}
fn highestBit(input:u32)->u32{var v=input;var n=0u;if(v>=65536u){v=v>>16u;n=n+16u;}if(v>=256u){v=v>>8u;n=n+8u;}if(v>=16u){v=v>>4u;n=n+4u;}if(v>=4u){v=v>>2u;n=n+2u;}if(v>=2u){n=n+1u;}return n;}
// IEEE binary32 basic operations with integer guard/round/sticky bits.
// Goldberg, Exactly Rounded Operations; no driver reassociation or FMA.
fn shiftJam(value:u32,shift:u32)->u32{
 if(shift==0u){return value;}if(shift>=32u){return select(0u,1u,value!=0u);}
 return (value>>shift)|select(0u,1u,(value<<(32u-shift))!=0u);
}
fn packRN(sign:u32,input:u32,power:i32)->f32{
 var sig=input;var exponent=power;
 if(exponent<1){sig=shiftJam(sig,u32(1-exponent));exponent=1;}
 var mantissa=sig>>3u;let tail=sig&7u;
 if(tail>4u||(tail==4u&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=255){return bitcast<f32>(sign|0x7f800000u);}
 if(mantissa<0x800000u){exponent=0;}
 return bitcast<f32>(sign|(u32(exponent)<<23u)|(mantissa&0x7fffffu));
}
fn addRN(a:f32,b:f32)->f32{
 var aa=bitcast<u32>(a);var bb=bitcast<u32>(b);
 if((aa&0x7fffffffu)<(bb&0x7fffffffu)){let tmp=aa;aa=bb;bb=tmp;}
 let sign=aa&0x80000000u;let ae=(aa>>23u)&255u;let be=(bb>>23u)&255u;
 if(ae==255u){return a+b;}
 var exponent=i32(max(ae,1u));
 let ma=((aa&0x7fffffu)|select(0u,0x800000u,ae!=0u))<<3u;
 let mb=shiftJam(((bb&0x7fffffu)|select(0u,0x800000u,be!=0u))<<3u,u32(exponent)-max(be,1u));
 var sum=ma+mb;
 if(((aa^bb)&0x80000000u)!=0u){sum=ma-mb;if(sum==0u){return 0.;}}
 if(sum>=0x8000000u){sum=shiftJam(sum,1u);exponent=exponent+1;}
 else{for(var i=0;i<26&&sum<0x4000000u&&exponent>1;i=i+1){sum=sum<<1u;exponent=exponent-1;}}
 return packRN(sign,sum,exponent);
}
fn mulRN(a:f32,b:f32)->f32{
 let aa=bitcast<u32>(a);let bb=bitcast<u32>(b);let sign=(aa^bb)&0x80000000u;
 let ae=(aa>>23u)&255u;let be=(bb>>23u)&255u;
 if(ae==255u||be==255u){return a*b;}
 var ma=(aa&0x7fffffu)|select(0u,0x800000u,ae!=0u);
 var mb=(bb&0x7fffffu)|select(0u,0x800000u,be!=0u);
 if(ma==0u||mb==0u){return bitcast<f32>(sign);}
 var ea=i32(max(ae,1u));var eb=i32(max(be,1u));
 let sa=23u-highestBit(ma);let sb=23u-highestBit(mb);
 ma=ma<<sa;mb=mb<<sb;ea=ea-i32(sa);eb=eb-i32(sb);
 let product=wideMultiply(ma,mb);let top=32u+highestBit(product.y);let shift=top-26u;
 let sig=(product.x>>shift)|(product.y<<(32u-shift))|select(0u,1u,(product.x&((1u<<shift)-1u))!=0u);
 return packRN(sign,sig,ea+eb-127+i32(top)-46);
}
fn addRN4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return vec4<f32>(addRN(a.x,b.x),addRN(a.y,b.y),addRN(a.z,b.z),addRN(a.w,b.w));}
fn mulRN4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return vec4<f32>(mulRN(a.x,b.x),mulRN(a.y,b.y),mulRN(a.z,b.z),mulRN(a.w,b.w));}
fn sqrtRN(a:f32)->f32{
 let raw=bitcast<u32>(a);if(raw==0u||raw==0x80000000u){return a;}
 if((raw&0x80000000u)!=0u){return bitcast<f32>((raw&0x7fffffu)|0x7fc00000u);}
 let ae=(raw>>23u)&255u;if(ae==255u){return a;}
 var m=(raw&0x7fffffu)|select(0u,0x800000u,ae!=0u);
 let shift=23u-highestBit(m);m=m<<shift;
 var exponent=i32(max(ae,1u))-127-i32(shift);
 if((exponent&1)!=0){m=m<<1u;exponent=exponent-1;}
 let n=vec2<u32>(m<<23u,m>>9u);var lo=0x800000u;var hi=0x1000000u;
 for(var i=0;i<24;i=i+1){let mid=(lo+hi)>>1u;let sq=wideMultiply(mid,mid);
  if(sq.y<n.y||(sq.y==n.y&&sq.x<=n.x)){lo=mid;}else{hi=mid;}}
 let sq=wideMultiply(lo,lo);let remainder=add64(n,negate64(sq));
 if(remainder.y!=0u||remainder.x>lo){lo=lo+1u;}
 exponent=exponent/2+127;if(lo==0x1000000u){lo=lo>>1u;exponent=exponent+1;}
 return bitcast<f32>((u32(exponent)<<23u)|(lo&0x7fffffu));
}
// BEGIN GENERATED BLEND MATH SOURCE
fn meanFourRN(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{
 // Match CPU's scale-each-sample then left-to-right accumulation. Moving
 // the scale outside the sum changes gradual underflow and rounding.
 let scale:vec4<f32>=vec4<f32>(0.25);
 return addRN4(addRN4(addRN4(mulRN4(a,scale),mulRN4(b,scale)),mulRN4(c,scale)),mulRN4(d,scale));
}
fn straightRN(pixel:vec4<f32>)->vec3<f32>{
 if(pixel.a<=1e-10){return vec3<f32>(0);}
 return vec3<f32>(divideRN(pixel.x,pixel.a),divideRN(pixel.y,pixel.a),divideRN(pixel.z,pixel.a));
}
fn lumRN(c:vec3<f32>)->f32{return addRN(addRN(mulRN(c.x,0.3),mulRN(c.y,0.59)),mulRN(c.z,0.11));}
fn satRN(c:vec3<f32>)->f32{return addRN(max(max(c.x,c.y),c.z),-min(min(c.x,c.y),c.z));}
fn totalLessRN(a:f32,b:f32)->bool{
 let aa:u32=bitcast<u32>(a);let bb:u32=bitcast<u32>(b);var ka:u32=aa|0x80000000u;var kb:u32=bb|0x80000000u;
 if((aa&0x80000000u)!=0u){ka=~aa;}if((bb&0x80000000u)!=0u){kb=~bb;}return ka<kb;
}
fn setSatRN(c:vec3<f32>,amount:f32)->vec3<f32>{
 var indices:vec3<u32>=vec3<u32>(0u,1u,2u);
 if(totalLessRN(c[indices.y],c[indices.x])){let t:u32=indices.x;indices.x=indices.y;indices.y=t;}
 if(totalLessRN(c[indices.z],c[indices.y])){let t:u32=indices.y;indices.y=indices.z;indices.z=t;}
 if(totalLessRN(c[indices.y],c[indices.x])){let t:u32=indices.x;indices.x=indices.y;indices.y=t;}
 var result:vec3<f32>=vec3<f32>(0);
 if(c[indices.z]>c[indices.x]){
  result[indices.y]=divideRN(mulRN(addRN(c[indices.y],-c[indices.x]),amount),addRN(c[indices.z],-c[indices.x]));
  result[indices.z]=amount;
 }
 return result;
}
fn setLumRN(initialColor:vec3<f32>,desiredLum:f32)->vec3<f32>{
 let shift:f32=addRN(desiredLum,-lumRN(initialColor));var c:vec3<f32>=vec3<f32>(addRN(initialColor.x,shift),addRN(initialColor.y,shift),addRN(initialColor.z,shift));
 let l:f32=lumRN(c);let low:f32=min(min(c.x,c.y),c.z);let high:f32=max(max(c.x,c.y),c.z);
 if(low<0.){for(var i:u32=0u;i<3u;i=i+1u){c[i]=addRN(l,divideRN(mulRN(addRN(c[i],-l),l),max(addRN(l,-low),1e-10)));}}
 if(high>1.){for(var i:u32=0u;i<3u;i=i+1u){c[i]=addRN(l,divideRN(mulRN(addRN(c[i],-l),addRN(1.,-l)),max(addRN(high,-l),1e-10)));}}
 return c;
}
fn maskLumRN(c:vec3<f32>)->f32{return clamp(addRN(addRN(mulRN(c.x,0.2126),mulRN(c.y,0.7152)),mulRN(c.z,0.0722)),0.,1.);}
// END GENERATED BLEND MATH SOURCE
fn channelRN(b:f32,s:f32,mode:i32)->f32{
 if(mode==1){return mulRN(b,s);}if(mode==2){return addRN(addRN(b,s),-mulRN(b,s));}
 if(mode==3||mode==8){if(select(b,s,mode==8)<=0.5){return mulRN(mulRN(2.,b),s);}return addRN(1.,-mulRN(mulRN(2.,addRN(1.,-b)),addRN(1.,-s)));}
 if(mode==4){return min(b,s);}if(mode==5){return max(b,s);}
 if(mode==6){if(b<=0.){return 0.;}if(s>=1.){return 1.;}return min(1.,divideRN(b,addRN(1.,-s)));}
 if(mode==7){if(b>=1.){return 1.;}if(s<=0.){return 0.;}return addRN(1.,-min(1.,divideRN(addRN(1.,-b),s)));}
 if(mode==9){if(s<=0.5){return addRN(b,-mulRN(mulRN(addRN(1.,-mulRN(2.,s)),b),addRN(1.,-b)));}
  var d=0.;if(b<=0.25){d=mulRN(addRN(mulRN(addRN(mulRN(16.,b),-12.),b),4.),b);}else{d=sqrtRN(b);}
  return addRN(b,mulRN(addRN(mulRN(2.,s),-1.),addRN(d,-b)));}
 if(mode==16){return max(0.,addRN(addRN(b,s),-1.));}if(mode==17){return min(1.,addRN(b,s));}
 if(mode==10){return abs(addRN(b,-s));}if(mode==11){return addRN(addRN(b,s),-mulRN(mulRN(2.,b),s));}return s;
}
fn blendRN(b:vec4<f32>,s:vec4<f32>,mode:i32)->vec4<f32>{
 let cb=straightRN(b);let cs=straightRN(s);
 var components=vec3<f32>(channelRN(cb.x,cs.x,mode),channelRN(cb.y,cs.y,mode),channelRN(cb.z,cs.z,mode));
 if(mode==12){components=setLumRN(setSatRN(cs,satRN(cb)),lumRN(cb));}
 if(mode==13){components=setLumRN(setSatRN(cb,satRN(cs)),lumRN(cb));}
 if(mode==14){components=setLumRN(cs,lumRN(cb));}
 if(mode==15){components=setLumRN(cb,lumRN(cs));}
 let m=vec4<f32>(components,0.);
 let left=mulRN4(s,vec4<f32>(addRN(1.,-b.a)));let middle=mulRN4(m,vec4<f32>(mulRN(s.a,b.a)));
 let right=mulRN4(b,vec4<f32>(addRN(1.,-s.a)));let rgb=addRN4(addRN4(left,middle),right);
 return vec4<f32>(rgb.xyz,addRN(s.a,mulRN(b.a,addRN(1.,-s.a))));
}
fn fixedLinear(point:vec2<f32>)->f32{
 let bits=u32(u(63).x)+3u;let x=i32(round(point.x*8.));let y=i32(round(point.y*8.));
 let value=add64(add64(timesCoordinate(unpack64(u(49)),x),timesCoordinate(unpack64(u(50)),y)),timesCoordinate(unpack64(u(51)),8));
 if((value.y&0x80000000u)!=0u||all(value==vec2<u32>(0))){return 0.;}
 var denominator=vec2<u32>(0);if(bits<32u){denominator.x=1u<<bits;}else{denominator.y=1u<<(bits-32u);}
 if(value.y>denominator.y||(value.y==denominator.y&&value.x>=denominator.x)){return 1.;}
 var top=highestBit(value.x);if(value.y!=0u){top=32u+highestBit(value.y);}
 var mantissa=0u;if(top<=23u){mantissa=value.x<<(23u-top);}else{let shift=top-23u;mantissa=(value.x>>shift)|(value.y<<(32u-shift));let remainder=value.x&((1u<<shift)-1u);let halfway=1u<<(shift-1u);if(remainder>halfway||(remainder==halfway&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}}
 if(mantissa==0x1000000u){mantissa=mantissa>>1u;top=top+1u;}
 return bitcast<f32>((u32(i32(top)-i32(bits)+127)<<23u)|(mantissa&0x7fffffu));
}

fn scaledPositive64(value:vec2<u32>,bits:u32)->f32{
 if(all(value==vec2<u32>(0))){return 0.;}var top=highestBit(value.x);if(value.y!=0u){top=32u+highestBit(value.y);}var mantissa=0u;var up=false;
 if(top<=23u){mantissa=value.x<<(23u-top);}else{let shift=top-23u;if(shift<32u){mantissa=(value.x>>shift)|(value.y<<(32u-shift));let rem=value.x&((1u<<shift)-1u);let halfway=1u<<(shift-1u);up=rem>halfway||(rem==halfway&&(mantissa&1u)!=0u);}else if(shift==32u){mantissa=value.y;up=value.x>0x80000000u||(value.x==0x80000000u&&(mantissa&1u)!=0u);}else{let s=shift-32u;mantissa=value.y>>s;let rem=value.y&((1u<<s)-1u);let halfway=1u<<(s-1u);up=rem>halfway||(rem==halfway&&(value.x!=0u||(mantissa&1u)!=0u));}if(up){mantissa=mantissa+1u;}}
 if(mantissa==0x1000000u){mantissa=mantissa>>1u;top=top+1u;}let exponent=i32(top)-i32(bits)+127;if(exponent<=0){return bitcast<f32>(value.x<<(149u-bits));}return bitcast<f32>((u32(exponent)<<23u)|(mantissa&0x7fffffu));
}
// An exact f32 materialization of a byte-colour lerp, before paint opacity.
// Integer endpoints and a binary32 t fit a 64-bit rational accumulator.
fn colourMix(a:f32,b:f32,t:f32)->f32{
 let raw=bitcast<u32>(t);
 if(raw==0u||(raw&0x80000000u)!=0u){return a;}
 if(raw>=0x3f800000u){return b;}
 let delta=i32(b)-i32(a);if(delta==0){return a;}
 let exponent=(raw>>23u)&255u;
 let shift=select(150u-exponent,149u,exponent==0u);
 let significand=(raw&0x7fffffu)|select(0x800000u,0u,exponent==0u);
 let product=u32(abs(delta))*significand;
 // Zero endpoints must retain tiny normal and subnormal contributions.
 if(a==0.){return scaledPositive64(vec2<u32>(product,0),shift);}
 // For nonzero byte endpoints the correction is strictly below half an ULP.
 if(shift>55u){return a;}
 var base=vec2<u32>(0);
 if(shift<32u){base=vec2<u32>(u32(a)<<shift,u32(a)>>(32u-shift));}
 else{base.y=u32(a)<<(shift-32u);}
 var term=vec2<u32>(product,0);if(delta<0){term=negate64(term);}
 return scaledPositive64(add64(base,term),shift);
}
fn paintUV(q:vec2<f32>)->vec2<f32>{let uv=vec2<f32>(divideRN(q.x,u(6).z),divideRN(q.y,u(6).w));if(u(62).z>0.5){return vec2<f32>(dot(uv,u(61).xz),dot(uv,u(61).yw))+u(62).xy;}return uv;}
fn gradientT(p:vec2<f32>,q:vec2<f32>,kind:i32)->f32{let uv=paintUV(q);let delta=(uv-0.5)*2.;var t=sqrt(delta.x*delta.x+delta.y*delta.y);if(delta.x==0.){t=abs(delta.y);}else if(delta.y==0.){t=abs(delta.x);}if(kind==1){if(u(63).x>=24.){t=fixedLinear(p+u(46).xy);}else if(u(62).z>0.5){t=uv.x;}else if(u(50).w>0.5){let relative=p+u(46).xy-u(51).xy;t=dot(relative,u(50).xy)+u(50).z;}else{t=dot(uv-0.5,u(49).xy)/max(u(49).z,1e-8)+0.5;}}else if(kind==4){let a=(atan2(uv.y-0.5,uv.x-0.5)-u(8).y)/6.28318530718;t=a-floor(a);}else if(kind==5){let d=uv-0.5;t=2.*max(abs(dot(d,u(49).xy)),abs(dot(d,vec2<f32>(-u(49).y,u(49).x))));}return clamp(t,0.,1.);}
// Gradient-modulated blur, composited in one pass (mode 46). The projection
// t along the node-space gradient segment is affine in the device pixel, so
// the host precomputes f64 coefficients (u(9).xyz); the shader evaluates the
// strength ramp, the decoded two-tier weight curves (smooth (2q)^2, tight
// q^2, matching gradient_blur.rs) and the normalized blend. No CPU readback.
fn gradientBlurComposite(p:vec2<f32>)->vec4<f32>{
 var sharp=at(sourceA,p,u(1));var blurred=at(sourceB,p,u(2));
 if(u(60).x<0.5){
  sharp=vec4<f32>(divideRN(round(mulRN(sharp.x,255.)),255.),divideRN(round(mulRN(sharp.y,255.)),255.),divideRN(round(mulRN(sharp.z,255.)),255.),divideRN(round(mulRN(sharp.w,255.)),255.));
  blurred=vec4<f32>(divideRN(round(mulRN(blurred.x,255.)),255.),divideRN(round(mulRN(blurred.y,255.)),255.),divideRN(round(mulRN(blurred.z,255.)),255.),divideRN(round(mulRN(blurred.w,255.)),255.));
 }
 let t=clamp(fmaRN(u(9).x,p.x,fmaRN(u(9).y,p.y,u(9).z)),0.,1.);
 let b=addRN(u(10).x,mulRN(addRN(u(10).y,-u(10).x),t));
 if(b<1.){return sharp;}
 let d=addRN(b,-1.);let q=addRN(mulRN(d,d),addRN(d,d));
 var wb=mulRN(q,q);if(u(9).w>0.5){let w=addRN(q,q);wb=mulRN(w,w);}
 let ws=mulRN(b,b);let total=addRN(wb,ws);
 return vec4<f32>(
  divideRN(addRN(mulRN(wb,blurred.x),mulRN(ws,sharp.x)),total),
  divideRN(addRN(mulRN(wb,blurred.y),mulRN(ws,sharp.y)),total),
  divideRN(addRN(mulRN(wb,blurred.z),mulRN(ws,sharp.z)),total),
  divideRN(addRN(mulRN(wb,blurred.w),mulRN(ws,sharp.w)),total));
}
override COMPOSITOR_MODE:i32=-1;
struct Params { values:array<vec4<f32>,64> }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var sourceA:texture_2d<f32>;
@group(0) @binding(2) var sourceB:texture_2d<f32>;
@group(0) @binding(3) var sourceC:texture_2d<f32>;
@group(0) @binding(5) var sourceD:texture_2d<f32>;
fn u(i:u32)->vec4<f32>{return params.values[i];}
fn at(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{let q=vec2<i32>(floor(p-r.xy));if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(r.zw))){return vec4<f32>(0);}return textureLoad(tex,q,0);}
fn smp(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{let q=p-r.xy-0.5;let k=fract(q);let base=floor(q)+r.xy+0.5;if(u(60).x>0.5){return bsBilinear4(at(tex,base,r),at(tex,base+vec2<f32>(1,0),r),at(tex,base+vec2<f32>(0,1),r),at(tex,base+vec2<f32>(1,1),r),k,u32(u(63).w),u32(u(63).z));}return mix(mix(at(tex,base,r),at(tex,base+vec2<f32>(1,0),r),k.x),mix(at(tex,base+vec2<f32>(0,1),r),at(tex,base+vec2<f32>(1,1),r),k.x),k.y);}
fn smpIndex(tex:texture_2d<f32>,q:vec2<f32>,r:vec4<f32>)->vec4<f32>{let k=fract(q);let base=floor(q)+r.xy+0.5;if(u(60).x>0.5){return bsBilinear4(at(tex,base,r),at(tex,base+vec2<f32>(1,0),r),at(tex,base+vec2<f32>(0,1),r),at(tex,base+vec2<f32>(1,1),r),k,u32(u(63).w),u32(u(63).z));}return mix(mix(at(tex,base,r),at(tex,base+vec2<f32>(1,0),r),k.x),mix(at(tex,base+vec2<f32>(0,1),r),at(tex,base+vec2<f32>(1,1),r),k.x),k.y);}
fn smpBytesIndex(tex:texture_2d<f32>,q:vec2<f32>,r:vec4<f32>)->vec4<f32>{let k=fract(q);let base=floor(q)+r.xy+0.5;return mix(mix(round(at(tex,base,r)*255.),round(at(tex,base+vec2<f32>(1,0),r)*255.),k.x),mix(round(at(tex,base+vec2<f32>(0,1),r)*255.),round(at(tex,base+vec2<f32>(1,1),r)*255.),k.x),k.y);}
fn smpBytes(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{let q=p-r.xy-0.5;let k=fract(q);let base=floor(q)+r.xy+0.5;return mix(mix(round(at(tex,base,r)*255.),round(at(tex,base+vec2<f32>(1,0),r)*255.),k.x),mix(round(at(tex,base+vec2<f32>(0,1),r)*255.),round(at(tex,base+vec2<f32>(1,1),r)*255.),k.x),k.y);}
fn lum(c:vec3<f32>)->f32{return dot(c,vec3<f32>(0.3,0.59,0.11));}
fn sat(c:vec3<f32>)->f32{return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
fn setLum(input:vec3<f32>,l:f32)->vec3<f32>{var c=input+vec3<f32>(l-lum(input));let n=min(min(c.r,c.g),c.b);let x=max(max(c.r,c.g),c.b);let ll=lum(c);if(n<0.){c=vec3<f32>(ll)+(c-ll)*ll/max(ll-n,1e-10);}if(x>1.){c=vec3<f32>(ll)+(c-ll)*(1.-ll)/max(x-ll,1e-10);}return c;}
fn setSat(c:vec3<f32>,s:f32)->vec3<f32>{let lo=min(min(c.r,c.g),c.b);let hi=max(max(c.r,c.g),c.b);if(hi>lo){return (c-lo)*s/(hi-lo);}return vec3<f32>(0);}
fn channel(b:f32,s:f32,mode:i32)->f32{switch mode{
case 1:{return b*s;}case 2:{return b+s-b*s;}case 3:{if(b<=0.5){return 2.*b*s;}return 1.-2.*(1.-b)*(1.-s);}case 4:{return min(b,s);}case 5:{return max(b,s);}case 6:{if(b<=0.){return 0.;}if(s>=1.){return 1.;}return min(1.,b/(1.-s));}case 7:{if(b>=1.){return 1.;}if(s<=0.){return 0.;}return 1.-min(1.,(1.-b)/s);}case 8:{if(s<=0.5){return 2.*b*s;}return 1.-2.*(1.-b)*(1.-s);}case 9:{var d=sqrt(b);if(b<=0.25){d=((16.*b-12.)*b+4.)*b;}if(s<=0.5){return b-(1.-2.*s)*b*(1.-b);}return b+(2.*s-1.)*(d-b);}case 10:{return abs(b-s);}case 11:{return b+s-2.*b*s;}case 16:{return max(0.,b+s-1.);}case 17:{return min(1.,b+s);}default:{return s;}}}
fn over(b:vec4<f32>,s:vec4<f32>,mode:i32)->vec4<f32>{if(s.a<=0.){return b;}if(b.a<=0.){return s;}if(mode==0){if(u(60).x>0.5){return addRN4(s,mulRN4(b,vec4<f32>(addRN(1.,-s.a))));}return s+b*(1.-s.a);}if(u(60).x>0.5){return blendRN(b,s,mode);}let cb=b.rgb/b.a;let cs=s.rgb/s.a;var m=vec3<f32>(channel(cb.r,cs.r,mode),channel(cb.g,cs.g,mode),channel(cb.b,cs.b,mode));if(mode==12){m=setLum(setSat(cs,sat(cb)),lum(cb));}if(mode==13){m=setLum(setSat(cb,sat(cs)),lum(cb));}if(mode==14){m=setLum(cs,lum(cb));}if(mode==15){m=setLum(cb,lum(cs));}return vec4<f32>(s.rgb*(1.-b.a)+s.a*b.a*m+b.rgb*(1.-s.a),s.a+b.a*(1.-s.a));}
fn noise(p:vec2<i32>,seed:u32)->f32{var h=(bitcast<u32>(p.x)*0x9e3779b1u)^(bitcast<u32>(p.y)*0x85ebca77u)^seed;h=h^(h>>16u);h=h*0x7feb352du;h=h^(h>>15u);h=h*0x846ca68bu;h=h^(h>>16u);return divideRN(f32(h&0x00ffffffu),16777215.);}
fn local(p:vec2<f32>)->vec2<f32>{return vec2<f32>(u(5).x*p.x+u(5).z*p.y+u(6).x,u(5).y*p.x+u(5).w*p.y+u(6).y);}
fn encodePoint(p:vec2<f32>)->vec4<f32>{if(p.x<0.){return vec4<f32>(1);}let q=vec2<u32>(round(p));return vec4<f32>(f32(q.x&255u),f32(q.x>>8u),f32(q.y&255u),f32(q.y>>8u))/255.;}
fn decodePoint(v:vec4<f32>)->vec2<f32>{let q=vec4<u32>(round(v*255.));if(q.x==255u&&q.y==255u){return vec2<f32>(-1);}return vec2<f32>(f32(q.x|(q.y<<8u)),f32(q.z|(q.w<<8u)));}
fn distanceField(p:vec2<f32>)->f32{let q=decodePoint(at(sourceB,p,u(2)));if(q.x<0.){return 1000000.;}return length(p-u(2).xy-0.5-q);}

// BEGIN GENERATED MATERIAL MATH SOURCE
// Independently derived bounded RGBA8 sampling arithmetic. Inputs must satisfy
// the same contracts as design-kernel/src/figma_sampling.rs. No texture data,
// reference pixels or vendor shader source is embedded here.
fn figmaMsb32(rawValue:u32)->u32 {
    var value:u32=rawValue;
    var result:u32=0u;
    if(value>=65536u){value=value>>16u;result=result+16u;}
    if(value>=256u){value=value>>8u;result=result+8u;}
    if(value>=16u){value=value>>4u;result=result+4u;}
    if(value>=4u){value=value>>2u;result=result+2u;}
    if(value>=2u){result=result+1u;}
    return result;
}
fn figmaFractionQ8(value:f32)->u32 {
    let bits:u32=bitcast<u32>(value);
    let exponent:u32=(bits>>23u)&255u;
    if(exponent==0u){return 0u;}
    let significand:u32=(bits&8388607u)|8388608u;
    let shift:u32=142u-exponent;
    if(shift>=25u){return 0u;}
    return (significand+(1u<<(shift-1u)))>>shift;
}
fn figmaNormalizeQ4(q:u32)->f32 {
    if(q==0u){return 0.0;}
    let msb:u32=figmaMsb32(q);
    var exponent:i32=i32(msb)-8;
    if(msb>=7u){
        if(q>=(255u<<(msb-7u))){exponent=exponent+1;}
    }
    let numerator:u32=q<<u32(23-exponent);
    var significand:u32=numerator/255u;
    let remainder:u32=numerator%255u;
    if(remainder>=128u){significand=significand+1u;}
    let bits:u32=(u32(exponent+123)<<23u)|(significand-8388608u);
    return bitcast<f32>(bits);
}
fn figmaEncodeUnorm8(value:f32)->u32 {
    let bits:u32=bitcast<u32>(value);
    let exponent:u32=(bits>>23u)&255u;
    if(exponent==0u){return 0u;}
    let significand:u32=(bits&8388607u)|8388608u;
    let numerator:u32=significand*255u;
    let shift:u32=150u-exponent;
    if(shift>=33u){return 0u;}
    if(shift==32u){
        if(numerator>2147483648u){return 1u;}
        return 0u;
    }
    var quotient:u32=numerator>>shift;
    let remainder:u32=numerator&((1u<<shift)-1u);
    let halfway:u32=1u<<(shift-1u);
    if(remainder>halfway || (remainder==halfway && (quotient&1u)!=0u)){
        quotient=quotient+1u;
    }
    return quotient;
}
// Explicit byte-domain compatibility. Index 253 is reserved by the drivers;
// HDR and all legacy passes keep this branch disabled.
// Texture replay keeps its independently verified source/clip-alpha contract.
// Its Q4 alpha residual table is not a software UNORM8 sampler table.
fn softwareRasterByte()->bool{let mode:i32=i32(u(4).x);return BYTE_SURFACE&&u(63).y>0.5&&(mode<43||mode>45);}
fn softwareLerpByte(a:u32,b:u32,weight:u32)->u32{
 let product:i32=(i32(b)-i32(a))*i32(weight);let magnitude:u32=u32(abs(product));
 let quotient:u32=magnitude>>8u;let remainder:u32=magnitude&255u;
 let rounded:u32=quotient+select(0u,1u,remainder>128u||(remainder==128u&&(quotient&1u)!=0u));
 return u32(i32(a)+select(i32(rounded),-i32(rounded),product<0));
}
fn softwareSampleBytes(p0:vec4<u32>,p1:vec4<u32>,p2:vec4<u32>,p3:vec4<u32>,wx:u32,wy:u32)->vec4<u32>{
 var result:vec4<u32>=vec4<u32>(0u);
 for(var channel:u32=0u;channel<4u;channel=channel+1u){
  let top:u32=softwareLerpByte(p0[channel],p1[channel],wx);
  let bottom:u32=softwareLerpByte(p2[channel],p3[channel],wx);
  result[channel]=softwareLerpByte(top,bottom,wy);
 }
 return result;
}
fn softwareNormalizeByte(value:u32)->f32{return mulRN(f32(value),bitcast<f32>(0x3b808081u));}
fn softwareByteValue(value:vec4<u32>)->vec4<f32>{
 return vec4<f32>(softwareNormalizeByte(value.x),softwareNormalizeByte(value.y),softwareNormalizeByte(value.z),softwareNormalizeByte(value.w));
}
fn softwareEncodeByte(value:f32)->u32{
 let scaled:f32=mulRN(clamp(value,0.,1.),255.);let integral:u32=u32(scaled);
 let remainder:f32=addRN(scaled,-f32(integral));
 return integral+select(0u,1u,remainder>0.5||(remainder==0.5&&(integral&1u)!=0u));
}
fn softwareEncodeBytes(value:vec4<f32>)->vec4<u32>{
 return vec4<u32>(softwareEncodeByte(value.x),softwareEncodeByte(value.y),softwareEncodeByte(value.z),softwareEncodeByte(value.w));
}
fn softwareBlendBytes(previous:vec4<u32>,source:vec4<u32>,factor:u32)->vec4<u32>{
 let src:vec4<u32>=(source*factor+vec4<u32>(127u))/255u;
 let dst:vec4<u32>=(previous*(255u-factor)+vec4<u32>(127u))/255u;
 return min(src+dst,vec4<u32>(255u));
}
fn softwareOver(dst:vec4<f32>,src:vec4<f32>)->vec4<f32>{
 let a:vec4<u32>=softwareEncodeBytes(src);let b:vec4<u32>=softwareEncodeBytes(dst);
 return softwareByteValue(min(a+(b*(255u-a.w)+vec4<u32>(127u))/255u,vec4<u32>(255u)));
}
fn figmaSampleQ8(p0:vec4<u32>,p1:vec4<u32>,p2:vec4<u32>,p3:vec4<u32>,wx:u32,wy:u32)->vec4<f32> {
    if(softwareRasterByte()){return softwareByteValue(softwareSampleBytes(p0,p1,p2,p3,wx,wy));}
    let w0:u32=(256u-wx)*(256u-wy);
    let w1:u32=wx*(256u-wy);
    let w2:u32=(256u-wx)*wy;
    let w3:u32=wx*wy;
    let sum:vec4<u32>=p0*w0+p1*w1+p2*w2+p3*w3;
    return vec4<f32>(figmaNormalizeQ4((sum.x+2048u)>>12u),figmaNormalizeQ4((sum.y+2048u)>>12u),figmaNormalizeQ4((sum.z+2048u)>>12u),figmaNormalizeQ4((sum.w+2048u)>>12u));
}
fn figmaNormalizedResolveSum(sum:u32)->u32 {
    var quotient:u32=sum/4u;
    let remainder:u32=sum%4u;
    if(remainder!=2u){
        if(remainder>2u){quotient=quotient+1u;}
        return quotient;
    }
    let odd:u32=2u*quotient+1u;
    if(odd==255u){return 128u;}
    let shift:u32=(31u-figmaMsb32(odd))%8u;
    let residue:u32=((odd%255u)<<shift)%255u;
    if(residue>=128u){quotient=quotient+1u;}
    return quotient;
}
fn figmaNormalized4(sum:vec4<u32>)->vec4<f32>{
 return vec4<f32>(f32(figmaNormalizedResolveSum(sum.x)),f32(figmaNormalizedResolveSum(sum.y)),f32(figmaNormalizedResolveSum(sum.z)),f32(figmaNormalizedResolveSum(sum.w)))/255.;
}
fn matPower5(m:u32)->vec4<u32>{
 var value:vec4<u32>=vec4<u32>(m,0u,0u,0u);
 for(var n:u32=0u;n<4u;n=n+1u){var carry:u32=0u;for(var i:u32=0u;i<4u;i=i+1u){let p:vec2<u32>=wideMultiply(value[i],m);let lo:u32=p.x+carry;carry=p.y+select(0u,1u,lo<p.x);value[i]=lo;}}
 return value;
}
fn matTop(v:vec4<u32>)->u32{if(v.w!=0u){return 96u+highestBit(v.w);}if(v.z!=0u){return 64u+highestBit(v.z);}if(v.y!=0u){return 32u+highestBit(v.y);}return highestBit(v.x);}
fn matNormalize(v:vec4<u32>,top:u32)->vec4<u32>{
 let shift:u32=127u-top;let words:u32=shift/32u;let bits:u32=shift%32u;var result:vec4<u32>=vec4<u32>(0u);
 for(var i:u32=0u;i<4u;i=i+1u){if(i>=words){result[i]=v[i-words]<<bits;if(bits!=0u&&i>words){result[i]=result[i]|(v[i-words-1u]>>(32u-bits));}}}return result;
}
fn matPowerCompare(m:u32,e:i32,alpha:u32)->i32{
 if(m==0u){return -1;}let value:vec4<u32>=matPower5(m);let top:u32=matTop(value);let ae:u32=(alpha>>23u)&255u;let am:u32=(alpha&0x7fffffu)|select(0u,0x800000u,ae!=0u);let atop:u32=highestBit(am);
 let lhs:i32=i32(top)+e*5;let rhs:i32=i32(atop)+i32(max(ae,1u))-150;if(lhs<rhs){return -1;}if(lhs>rhs){return 1;}
 let p:vec4<u32>=matNormalize(value,top);let a:vec4<u32>=matNormalize(vec4<u32>(am,0u,0u,0u),atop);
 for(var i:i32=3;i>=0;i=i-1){if(p[u32(i)]<a[u32(i)]){return -1;}if(p[u32(i)]>a[u32(i)]){return 1;}}return 0;
}
fn materialRoot5(alpha:f32)->f32{
 let a:u32=bitcast<u32>(alpha);if((a&0x80000000u)!=0u||a==0u){return 0.;}if(a>=0x3f800000u){return 1.;}
 var lo:u32=0u;var hi:u32=0x3f800000u;
 for(var i:u32=0u;i<31u;i=i+1u){if(hi-lo<=1u){break;}let mid:u32=lo+(hi-lo)/2u;let e:u32=(mid>>23u)&255u;let m:u32=(mid&0x7fffffu)|select(0u,0x800000u,e!=0u);if(matPowerCompare(m,i32(max(e,1u))-150,a)<=0){lo=mid;}else{hi=mid;}}
 let e:i32=i32((lo>>23u)&255u);let m:u32=(lo&0x7fffffu)|0x800000u;let cmp:i32=matPowerCompare(2u*m+1u,e-151,a);
 return bitcast<f32>(lo+select(0u,1u,cmp<0||(cmp==0&&(lo&1u)!=0u)));
}
fn positiveLeft64(v:vec2<u32>,n:u32)->vec2<u32>{
 if(n==0u){return v;}if(n<32u){return vec2<u32>(v.x<<n,(v.y<<n)|(v.x>>(32u-n)));}
 return vec2<u32>(0u,v.x<<(n-32u));
}
fn positiveRightJam64(v:vec2<u32>,n:u32)->vec2<u32>{
 if(n==0u){return v;}if(n>=64u){return vec2<u32>(select(0u,1u,v.x!=0u||v.y!=0u),0u);}
 if(n<32u){return vec2<u32>((v.x>>n)|(v.y<<(32u-n))|select(0u,1u,(v.x<<(32u-n))!=0u),v.y>>n);}
 if(n==32u){return vec2<u32>(v.y|select(0u,1u,v.x!=0u),0u);}
 let k:u32=n-32u;return vec2<u32>((v.y>>k)|select(0u,1u,v.x!=0u||(v.y<<(32u-k))!=0u),0u);
}
// Single rounding of a*b+c for finite operands with b,c and the result >=0.
// Normalizing both terms to bit 62 leaves room for their sum. Near cancellation
// their alignment is exact (48-bit product); separated terms retain sticky.
// No hardware FMA or compiler contraction is assumed.
fn nonnegativeResultFmaRN(a:f32,b:f32,c:f32)->f32{
 let aa:u32=bitcast<u32>(a);let bb:u32=bitcast<u32>(b);let cc:u32=bitcast<u32>(c);
 let ae:u32=(aa>>23u)&255u;let be:u32=(bb>>23u)&255u;let ce:u32=(cc>>23u)&255u;
 let ma:u32=(aa&0x7fffffu)|select(0u,0x800000u,ae!=0u);
 let mb:u32=(bb&0x7fffffu)|select(0u,0x800000u,be!=0u);
 let mc:u32=(cc&0x7fffffu)|select(0u,0x800000u,ce!=0u);
 if(ma==0u||mb==0u){return c;}if(mc==0u){return mulRN(a,b);}
 let product:vec2<u32>=wideMultiply(ma,mb);
 var top:u32=highestBit(product.x);if(product.y!=0u){top=32u+highestBit(product.y);}
 let ctop:u32=highestBit(mc);
 let pe:i32=i32(max(ae,1u))+i32(max(be,1u))-300+i32(top);
 let ve:i32=i32(max(ce,1u))-150+i32(ctop);let exponent:i32=max(pe,ve);
 let left:vec2<u32>=positiveRightJam64(positiveLeft64(product,62u-top),u32(exponent-pe));
 let right:vec2<u32>=positiveRightJam64(positiveLeft64(vec2<u32>(mc,0u),62u-ctop),u32(exponent-ve));
 var sum:vec2<u32>=add64(left,right);
 if((aa&0x80000000u)!=0u){sum=add64(right,negate64(left));}
 if(sum.x==0u&&sum.y==0u){return 0.;}
 var last:u32=highestBit(sum.x);if(sum.y!=0u){last=32u+highestBit(sum.y);}
 var significand:vec2<u32>=vec2<u32>(0u);
 if(last>=26u){significand=positiveRightJam64(sum,last-26u);}else{significand=positiveLeft64(sum,26u-last);}
 return packRN(0u,significand.x,exponent+i32(last)-62+127);
}
// Full signed binary32 fused multiply-add, with exactly one RNE. The two
// integer limbs align the exact 48-bit product and 24-bit addend at bit62.
// Near cancellation their alignment is exact; distant tails retain sticky.
// Finite overflow/underflow and signed zero follow IEEE RNE. NaNs (including
// invalid infinity arithmetic) use canonical positive quiet NaN 0x7fc00000.
// No hardware FMA, float arithmetic fallback or large limb array is used.
fn fmaRN(a:f32,b:f32,c:f32)->f32{
 let aa:u32=bitcast<u32>(a);let bb:u32=bitcast<u32>(b);let cc:u32=bitcast<u32>(c);
 // Keep this bitcast a runtime expression: WGSL forbids nonfinite const f32.
 var canonical_nan:u32=0x7fc00000u;
 let av:u32=aa&0x7fffffffu;let bv:u32=bb&0x7fffffffu;let cv:u32=cc&0x7fffffffu;
 let ps:u32=(aa^bb)&0x80000000u;let cs:u32=cc&0x80000000u;
 if(av>0x7f800000u||bv>0x7f800000u||cv>0x7f800000u){return bitcast<f32>(canonical_nan);}
 if(av==0x7f800000u||bv==0x7f800000u){
  if(av==0u||bv==0u||(cv==0x7f800000u&&ps!=cs)){return bitcast<f32>(canonical_nan);}
  return bitcast<f32>(ps|0x7f800000u);
 }
 if(cv==0x7f800000u){return c;}
 if(av==0u||bv==0u){if(cv==0u){return bitcast<f32>(ps&cs);}return c;}
 if(cv==0u){return mulRN(a,b);}
 let ae:u32=(av>>23u)&255u;let be:u32=(bv>>23u)&255u;let ce:u32=(cv>>23u)&255u;
 let ma:u32=(av&0x7fffffu)|select(0u,0x800000u,ae!=0u);
 let mb:u32=(bv&0x7fffffu)|select(0u,0x800000u,be!=0u);
 let mc:u32=(cv&0x7fffffu)|select(0u,0x800000u,ce!=0u);
 let product:vec2<u32>=wideMultiply(ma,mb);
 var top:u32=highestBit(product.x);if(product.y!=0u){top=32u+highestBit(product.y);}
 let ctop:u32=highestBit(mc);
 let pe:i32=i32(max(ae,1u))+i32(max(be,1u))-300+i32(top);
 let ve:i32=i32(max(ce,1u))-150+i32(ctop);let exponent:i32=max(pe,ve);
 let left:vec2<u32>=positiveRightJam64(positiveLeft64(product,62u-top),u32(exponent-pe));
 let right:vec2<u32>=positiveRightJam64(positiveLeft64(vec2<u32>(mc,0u),62u-ctop),u32(exponent-ve));
 var sign:u32=ps;var sum:vec2<u32>=add64(left,right);
 if(ps!=cs){
  if(left.y<right.y||(left.y==right.y&&left.x<right.x)){sum=add64(right,negate64(left));sign=cs;}
  else{sum=add64(left,negate64(right));}
 }
 if(sum.x==0u&&sum.y==0u){return 0.;}
 var last:u32=highestBit(sum.x);if(sum.y!=0u){last=32u+highestBit(sum.y);}
 var significand:vec2<u32>=vec2<u32>(0u);
 if(last>=26u){significand=positiveRightJam64(sum,last-26u);}else{significand=positiveLeft64(sum,26u-last);}
 return packRN(sign,significand.x,exponent+i32(last)-62+127);
}
fn positiveFmaRN(a:f32,b:f32,c:f32)->f32{return nonnegativeResultFmaRN(a,b,c);}
// Constant-color blend is a distinct measured hardware contract from the
// premultiplied source-over path. Export interpolation rounds source-dst,
// then fuses that signed difference with the destination.
fn constantColorBlendRN(source:f32,destination:f32,weight:f32)->f32{
 return nonnegativeResultFmaRN(addRN(source,-destination),weight,destination);
}
fn materialSample(p:vec2<f32>,delta:vec2<f32>)->vec4<f32>{
 let base:vec2<f32>=p+floor(delta);let k:vec2<f32>=delta-floor(delta);
 let a:vec4<f32>=at(sourceA,base,u(1));let b:vec4<f32>=at(sourceA,base+vec2<f32>(1,0),u(1));let c:vec4<f32>=at(sourceA,base+vec2<f32>(0,1),u(1));let d:vec4<f32>=at(sourceA,base+vec2<f32>(1,1),u(1));
 if(u(60).x>0.5){return bsBilinear4(a,b,c,d,k,u32(u(63).w),u32(u(63).z));}
 let x:f32=addRN(1.,-k.x);let y:f32=addRN(1.,-k.y);
 var sum:vec4<f32>=addRN4(vec4<f32>(0),mulRN4(a,vec4<f32>(mulRN(x,y))));
 sum=addRN4(sum,mulRN4(b,vec4<f32>(mulRN(k.x,y))));sum=addRN4(sum,mulRN4(c,vec4<f32>(mulRN(x,k.y))));return addRN4(sum,mulRN4(d,vec4<f32>(mulRN(k.x,k.y))));
}
// Exact scalar texture-clipping contract; numeric data, never painted pixels.
// Atlas: 1024x1024 RGBA8, little-endian roots in bytes0..16323, followed by
// 4164661 residual bytes, remaining13319 bytes zero. High-major triangular
// pair index; two residual nibbles/byte, low first, decodedCode-5 signed ULPs.
// Each backend uploads the same immutable baseline/residual assets and computes
// the alpha indices and weight itself. See texture_noise/clip-weight-metadata.
fn textureClipReadWord(math:texture_2d<f32>,word:u32)->u32{
 let bytes:vec4<u32>=vec4<u32>(round(textureLoad(math,vec2<i32>(i32(word%1024u),i32(word/1024u)),0)*255.));
 return bytes.x|(bytes.y<<8u)|(bytes.z<<16u)|(bytes.w<<24u);
}
fn textureClipAlphaIndex(alpha:f32)->u32{
 let bits:u32=bitcast<u32>(alpha);
 // Unsigned bit order also rejects every negative value, including -0.
 if(bits>0x3f800000u){return 0xffffffffu;}
 let index:u32=u32(round(mulRN(alpha,4080.)));
 if(index>=4081u){return 0xffffffffu;}
 if(bitcast<u32>(figmaNormalizeQ4(index))!=bits){return 0xffffffffu;}
 return index;
}
fn textureClipWeightQ4(math:texture_2d<f32>,original:u32,displaced:u32)->f32{
 if(original>=4081u||displaced>=4081u){var invalid:u32=0x7fc00000u;return bitcast<f32>(invalid);}
 let low:u32=min(original,displaced);let high:u32=max(original,displaced);
 let index:u32=high*(high+1u)/2u+low;
 let a:f32=bitcast<f32>(textureClipReadWord(math,original));
 let b:f32=bitcast<f32>(textureClipReadWord(math,displaced));
 let packed:u32=textureClipReadWord(math,4081u+index/8u);
 let code:u32=(packed>>((index%8u)*4u))&15u;
 return bitcast<f32>(bitcast<u32>(mulRN(a,b))+code-5u);
}
fn textureClipWeight(math:texture_2d<f32>,original:f32,displaced:f32)->f32{
 // Validate both operands before the zero-alpha case can yield zero.
 let a:u32=textureClipAlphaIndex(original);let b:u32=textureClipAlphaIndex(displaced);
 return textureClipWeightQ4(math,a,b);
}
fn figmaByteValue(bytes:vec4<u32>)->vec4<f32>{
 if(softwareRasterByte()){return softwareByteValue(bytes);}
 return vec4<f32>(figmaNormalizeQ4(bytes.x*16u),figmaNormalizeQ4(bytes.y*16u),figmaNormalizeQ4(bytes.z*16u),figmaNormalizeQ4(bytes.w*16u));
}
fn figmaExportStep(previous:vec4<u32>,source:vec4<f32>,weight:f32)->vec4<u32>{
 if(softwareRasterByte()){return softwareBlendBytes(previous,softwareEncodeBytes(source),softwareEncodeByte(weight));}
 let dst:vec4<f32>=figmaByteValue(previous);
 let value:vec4<f32>=clamp(vec4<f32>(constantColorBlendRN(source.x,dst.x,weight),constantColorBlendRN(source.y,dst.y,weight),constantColorBlendRN(source.z,dst.z,weight),constantColorBlendRN(source.w,dst.w,weight)),vec4<f32>(0),vec4<f32>(1));
 return vec4<u32>(figmaEncodeUnorm8(value.x),figmaEncodeUnorm8(value.y),figmaEncodeUnorm8(value.z),figmaEncodeUnorm8(value.w));
}
fn figmaFourPass(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{
 var result:vec4<u32>=figmaExportStep(vec4<u32>(0u),d,1.);
 result=figmaExportStep(result,a,0.5);
 result=figmaExportStep(result,c,bitcast<f32>(0x3eaaaaabu));
 result=figmaExportStep(result,b,0.25);
 return figmaByteValue(result);
}
fn figmaQuarterSum(sum:vec4<u32>)->vec4<f32>{
 return vec4<f32>(figmaNormalizeQ4(sum.x*4u),figmaNormalizeQ4(sum.y*4u),figmaNormalizeQ4(sum.z*4u),figmaNormalizeQ4(sum.w*4u));
}
fn softwareSpatialSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{
 let a:vec4<u32>=softwareEncodeBytes(at(tex,p,r));
 let b:vec4<u32>=softwareEncodeBytes(at(tex,p+vec2<f32>(1,0),r));
 let c:vec4<u32>=softwareEncodeBytes(at(tex,p+vec2<f32>(0,1),r));
 let d:vec4<u32>=softwareEncodeBytes(at(tex,p+vec2<f32>(1,1),r));
 return softwareByteValue(softwareSampleBytes(a,b,c,d,128u,128u));
}
fn figmaSpatialResolve(p:vec2<f32>)->vec4<f32>{
 if(softwareRasterByte()){
  return figmaFourPass(softwareSpatialSample(sourceA,p,u(1)),softwareSpatialSample(sourceB,p,u(2)),softwareSpatialSample(sourceC,p,u(3)),softwareSpatialSample(sourceD,p,u(1)));
 }
 var a:vec4<u32>=vec4<u32>(0u);var b:vec4<u32>=vec4<u32>(0u);var c:vec4<u32>=vec4<u32>(0u);var d:vec4<u32>=vec4<u32>(0u);
 for(var y:u32=0u;y<2u;y=y+1u){for(var x:u32=0u;x<2u;x=x+1u){
  let q:vec2<f32>=p+vec2<f32>(f32(x),f32(y));
  a=a+vec4<u32>(round(at(sourceA,q,u(1))*255.));b=b+vec4<u32>(round(at(sourceB,q,u(2))*255.));
  c=c+vec4<u32>(round(at(sourceC,q,u(3))*255.));d=d+vec4<u32>(round(at(sourceD,q,u(1))*255.));
 }}
 return figmaFourPass(figmaQuarterSum(a),figmaQuarterSum(b),figmaQuarterSum(c),figmaQuarterSum(d));
}
fn materialTexture(p:vec2<f32>)->vec4<f32>{
 let delta:vec2<f32>=at(sourceB,p,u(2)).xy;let first:vec4<f32>=materialSample(p,delta);
 if(u(10).w<0.5){return first;}let original:vec4<f32>=at(sourceA,p,u(1));if((bitcast<u32>(original.a)&0x7fffffffu)==0u){return vec4<f32>(0);}
 let weight:f32=mulRN(materialRoot5(original.a),materialRoot5(first.a));
 let shifted:vec4<f32>=materialSample(p,vec2<f32>(mulRN(delta.x,weight),mulRN(delta.y,weight)));
 if(shifted.a>0.){return shifted;}return original;
}
fn linearTextureTexel(q:vec2<i32>)->vec4<f32>{
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(1).zw))){return vec4<f32>(0);}
 return textureLoad(sourceA,q,0);
}
fn linearTexture(p:vec2<f32>)->vec4<f32>{
 let grid:vec4<f32>=at(sourceB,p,u(2));let q:vec2<i32>=vec2<i32>(grid.xy);
 return bsBilinear4(linearTextureTexel(q),linearTextureTexel(q+vec2<i32>(1,0)),linearTextureTexel(q+vec2<i32>(0,1)),linearTextureTexel(q+vec2<i32>(1,1)),grid.zw,u32(u(63).w),u32(u(63).z));
}
fn legacyTexture(p:vec2<f32>,linear:bool)->vec4<f32>{
 let original=at(sourceA,p,u(1));
 if(original.a<=0.){return original;}
 var shifted:vec4<f32>;
 if(linear){shifted=linearTexture(p);}
 else {
  let q=vec2<i32>(floor(local(p)));
  let delta=(vec2<f32>(noise(q,13u),noise(q,29u))-0.5)*u(10).x;
  let device=vec2<f32>(u(45).x*delta.x+u(45).z*delta.y,u(45).y*delta.x+u(45).w*delta.y);
  shifted=smp(sourceA,p+device,u(1));
 }
 if(original.a==1.&&shifted.a<1.){return over(original,shifted,0);}
 return shifted;
}
fn linearDistance(p:vec2<f32>)->f32{
 let q:vec2<f32>=decodePoint(at(sourceB,p,u(2)));
 if(q.x<0.){return 1000000.;}
 let x:f32=addRN(addRN(addRN(p.x,-u(2).x),-0.5),-q.x);
 let y:f32=addRN(addRN(addRN(p.y,-u(2).y),-0.5),-q.y);
 return sqrtRN(addRN(mulRN(x,x),mulRN(y,y)));
}
fn linearGlass(p:vec2<f32>)->vec4<f32>{
 let d:f32=linearDistance(p);
 let gx:f32=addRN(linearDistance(p+vec2<f32>(1,0)),-linearDistance(p-vec2<f32>(1,0)));
 let gy:f32=addRN(linearDistance(p+vec2<f32>(0,1)),-linearDistance(p-vec2<f32>(0,1)));
 let len:f32=max(sqrtRN(addRN(mulRN(gx,gx),mulRN(gy,gy))),1e-5);
 let factor:f32=clamp(addRN(1.,-divideRN(d,max(u(9).x,4.))),0.,1.);
 let dx:f32=mulRN(mulRN(mulRN(divideRN(gx,len),u(9).y),factor),factor);
 let dy:f32=mulRN(mulRN(mulRN(divideRN(gy,len),u(9).y),factor),factor);
 let samplePoint:vec2<f32>=vec2<f32>(addRN(p.x,dx),addRN(p.y,dy));
 let highlight:f32=clamp(mulRN(mulRN(mulRN(divideRN(abs(addRN(gx,-gy)),len),factor),u(9).z),0.25),0.,1.);
 let result:vec4<f32>=over(smp(sourceA,samplePoint,u(1)),vec4<f32>(highlight),0);
 if(u(9).w>0.5){return result;}
 return mulRN4(result,vec4<f32>(at(sourceC,p,u(3)).a));
}
fn materialOver(b:vec4<f32>,s:vec4<f32>)->vec4<f32>{
 if((bitcast<u32>(s.a)&0x7fffffffu)==0u){return b;}if((bitcast<u32>(b.a)&0x7fffffffu)==0u){return s;}
 return addRN4(s,mulRN4(b,vec4<f32>(addRN(1.,-s.a))));
}
// The capture target is an independent RGBA8 image. Its sampler clamps to
// texel edges and rounds fractions to Q8 before Q4 channel normalization.
fn captureSample(p:vec2<f32>)->vec4<f32>{
 let q:vec2<f32>=p-vec2<f32>(0.5);let base:vec2<i32>=vec2<i32>(floor(q));let last:vec2<i32>=vec2<i32>(u(1).zw)-vec2<i32>(1);
 let a:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,clamp(base,vec2<i32>(0),last),0)*255.));
 let b:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,clamp(base+vec2<i32>(1,0),vec2<i32>(0),last),0)*255.));
 let c:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,clamp(base+vec2<i32>(0,1),vec2<i32>(0),last),0)*255.));
 let d:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,clamp(base+vec2<i32>(1,1),vec2<i32>(0),last),0)*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(q.x-floor(q.x)),figmaFractionQ8(q.y-floor(q.y)));
}
fn captureEncode(value:vec4<f32>)->vec4<f32>{
 if(softwareRasterByte()){return softwareByteValue(softwareEncodeBytes(value));}
 let v:vec4<f32>=clamp(value,vec4<f32>(0),vec4<f32>(1));
 return vec4<f32>(f32(figmaEncodeUnorm8(v.x)),f32(figmaEncodeUnorm8(v.y)),f32(figmaEncodeUnorm8(v.z)),f32(figmaEncodeUnorm8(v.w)))/255.;
}
// Texture capture attachments use normalized UV with clamped Q8 fractions.
// Keep the Q4 result in float until the destination's one UNORM8 store.
fn textureCaptureSample(tex:texture_2d<f32>,uv:vec2<f32>,size:vec2<f32>)->vec4<f32>{
 let bounded:vec2<f32>=clamp(uv,vec2<f32>(0),vec2<f32>(1));
 let q:vec2<f32>=max(vec2<f32>(0),vec2<f32>(addRN(mulRN(bounded.x,size.x),-0.5),addRN(mulRN(bounded.y,size.y),-0.5)));
 let base:vec2<i32>=vec2<i32>(floor(q));let last:vec2<i32>=vec2<i32>(size)-vec2<i32>(1);
 let a:vec4<u32>=vec4<u32>(round(textureLoad(tex,clamp(base,vec2<i32>(0),last),0)*255.));
 let b:vec4<u32>=vec4<u32>(round(textureLoad(tex,clamp(base+vec2<i32>(1,0),vec2<i32>(0),last),0)*255.));
 let c:vec4<u32>=vec4<u32>(round(textureLoad(tex,clamp(base+vec2<i32>(0,1),vec2<i32>(0),last),0)*255.));
 let d:vec4<u32>=vec4<u32>(round(textureLoad(tex,clamp(base+vec2<i32>(1,1),vec2<i32>(0),last),0)*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(q.x,-floor(q.x))),figmaFractionQ8(addRN(q.y,-floor(q.y))));
}
fn textureForwardUV(moved:vec2<f32>)->vec2<f32>{
 var centered:vec2<f32>=vec2<f32>(addRN(fmaRN(moved.x,u(10).x,-0.5),u(10).z),addRN(fmaRN(moved.y,u(11).x,-0.5),u(11).y));
 if(u(9).y>0.5){centered=vec2<f32>(fmaRN(moved.x,u(10).x,addRN(u(10).z,-0.5)),fmaRN(moved.y,u(11).x,addRN(u(11).y,-0.5)));}
 return vec2<f32>(fmaRN(centered.x,u(9).x,0.5),fmaRN(centered.y,u(9).x,0.5));
}
fn textureReplayEffect(p:vec2<f32>)->vec4<f32>{
 let field:vec4<f32>=at(sourceC,p,u(3));
 let moved:vec2<f32>=vec2<f32>(addRN(field.x,field.z),addRN(field.y,field.w));
 let first:vec4<f32>=textureCaptureSample(sourceA,textureForwardUV(moved),u(1).zw);
 if(u(9).y<0.5){return captureEncode(first);}
 let uv:vec2<f32>=vec2<f32>(divideRN(p.x,u(9).w),divideRN(p.y,u(9).w));
 var original:vec4<f32>=vec4<f32>(0);
 if(u(9).z>0.5){original=textureCaptureSample(sourceB,uv,u(2).zw);}else{
  let expanded:vec2<f32>=vec2<f32>(fmaRN(addRN(uv.x,-0.5),u(9).x,0.5),fmaRN(addRN(uv.y,-0.5),u(9).x,0.5));
  original=textureCaptureSample(sourceA,expanded,u(1).zw);
 }
 let weight:f32=textureClipWeight(sourceD,original.a,first.a);
 let adjustedNode:vec2<f32>=vec2<f32>(fmaRN(field.z,weight,field.x),fmaRN(field.w,weight,field.y));
 let adjusted:vec4<f32>=textureCaptureSample(sourceA,textureForwardUV(adjustedNode),u(1).zw);
 if(original.a>0.&&adjusted.a>0.){return captureEncode(adjusted);}return captureEncode(original);
}
fn textureReplayCopyback(p:vec2<f32>)->vec4<f32>{
 let field:vec4<f32>=at(sourceB,p,u(2));let source:vec4<f32>=textureCaptureSample(sourceA,field.xy,u(1).zw);
 if(u(4).w>0.5){return mulRN4(source,vec4<f32>(at(sourceC,p,u(3)).a));}return source;
}
fn textureReplaySource(p:vec2<f32>)->vec4<f32>{
 let field:vec4<f32>=at(sourceB,p,u(2));
 let coordinate:f32=clamp(addRN(mulRN(clamp(field.x,0.,1.),1024.),-0.5),0.,1023.);
 let left:i32=i32(floor(coordinate));let right:i32=min(left+1,1023);
 let a:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,vec2<i32>(left,0),0)*255.));
 let b:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,vec2<i32>(right,0),0)*255.));
 let c:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,vec2<i32>(left,1),0)*255.));
 let d:vec4<u32>=vec4<u32>(round(textureLoad(sourceA,vec2<i32>(right,1),0)*255.));
 let color:vec4<f32>=mulRN4(figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(coordinate,-f32(left))),1u),vec4<f32>(u(8).x));
 if(color.a==0.){return vec4<f32>(0);}var source:vec4<f32>=min(abs(addRN4(color,vec4<f32>(field.y))),vec4<f32>(1));
 if(color.a==1.){source.a=1.;}return captureEncode(source);
}
fn captureDownscale(p:vec2<f32>)->vec4<f32>{
 let uv:vec2<f32>=vec2<f32>(fmaRN(addRN(p.x,-u(9).x),u(9).z,u(10).x),fmaRN(addRN(p.y,-u(9).y),u(9).w,u(10).y));
 return captureEncode(captureSample(vec2<f32>(mulRN(uv.x,u(1).z),mulRN(uv.y,u(1).w))));
}
fn measuredGradientOver(p:vec2<f32>)->vec4<f32>{
 let dst:vec4<f32>=at(sourceA,p,u(1));let coverage:f32=at(sourceB,p,u(2)).a;
 if(coverage<=0.){return dst;}let field:vec4<f32>=at(sourceD,p,u(13));
 let coordinate:f32=clamp(addRN(mulRN(clamp(field.x,0.,1.),1024.),-0.5),0.,1023.);
 let left:i32=i32(floor(coordinate));let right:i32=min(left+1,1023);
 let a:vec4<u32>=vec4<u32>(round(textureLoad(sourceC,vec2<i32>(left,0),0)*255.));
 let b:vec4<u32>=vec4<u32>(round(textureLoad(sourceC,vec2<i32>(right,0),0)*255.));
 let c:vec4<u32>=vec4<u32>(round(textureLoad(sourceC,vec2<i32>(left,1),0)*255.));
 let d:vec4<u32>=vec4<u32>(round(textureLoad(sourceC,vec2<i32>(right,1),0)*255.));
 let color:vec4<f32>=mulRN4(figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(coordinate,-f32(left))),1u),vec4<f32>(u(8).x));
 if(color.a==0.){return dst;}
 var source:vec4<f32>=min(abs(addRN4(color,vec4<f32>(field.y))),vec4<f32>(1));
 if(color.a==1.){source.a=1.;}source=mulRN4(source,vec4<f32>(coverage));let factor:f32=addRN(1.,-source.a);
 if(softwareRasterByte()){return softwareOver(dst,source);}
 return captureEncode(vec4<f32>(positiveFmaRN(dst.x,factor,source.x),positiveFmaRN(dst.y,factor,source.y),positiveFmaRN(dst.z,factor,source.z),positiveFmaRN(dst.w,factor,source.w)));
}
fn captureTriangle(p:vec2<f32>)->vec4<f32>{
 let count:f32=u(9).x;let axis:u32=u32(u(9).y);
 var sum:vec4<f32>=mulRN4(captureSample(p),vec4<f32>(count));var weight:f32=count;
 for(var k:u32=1u;k<u32(u(9).z);k=k+2u){
  if(f32(k)>count){break;}let a:f32=f32(k);let b:f32=min(f32(k+1u),count);
  let wa:f32=addRN(count,-a);let wb:f32=addRN(count,-b);let pair:f32=addRN(wa,wb);
  if(pair==0.){continue;}
  var left:vec2<f32>=p;var right:vec2<f32>=p;
  let size:f32=u(1)[axis+2u];let step:f32=divideRN(1.,size);let uv:f32=divideRN(p[axis],size);
  left[axis]=mulRN(divideRN(addRN(mulRN(addRN(uv,-mulRN(step,a)),wa),mulRN(addRN(uv,-mulRN(step,b)),wb)),pair),size);
  right[axis]=mulRN(divideRN(addRN(mulRN(addRN(uv,mulRN(step,a)),wa),mulRN(addRN(uv,mulRN(step,b)),wb)),pair),size);
  let value:vec4<f32>=addRN4(captureSample(left),captureSample(right));
  sum=vec4<f32>(positiveFmaRN(value.x,pair,sum.x),positiveFmaRN(value.y,pair,sum.y),positiveFmaRN(value.z,pair,sum.z),positiveFmaRN(value.w,pair,sum.w));
  weight=addRN(weight,mulRN(2.,pair));
 }
 return captureEncode(mulRN4(sum,vec4<f32>(divideRN(1.,weight))));
}
fn opticalRay(p:vec2<f32>,delta:vec2<f32>,factor:f32)->vec4<f32>{
 if(BYTE_SURFACE&&u(12).x>0.5){
  let point:vec2<f32>=vec2<f32>(addRN(p.x,mulRN(delta.x,factor)),addRN(p.y,mulRN(delta.y,factor)));
  let centered:vec2<f32>=vec2<f32>(addRN(mulRN(addRN(point.x,-u(12).y),0.001953125),-0.5),addRN(mulRN(addRN(point.y,-u(12).z),0.001953125),-0.5));
  let density:f32=mulRN(u(12).w,0.5);
  let coordinate:vec2<f32>=vec2<f32>(mulRN(fmaRN(centered.x,density,0.5),u(1).z),mulRN(fmaRN(centered.y,density,0.5),u(1).w));
  return captureSample(coordinate);
 }
 let offset:vec2<f32>=vec2<f32>(addRN(u(11).x,mulRN(delta.x,factor)),addRN(u(11).y,mulRN(delta.y,factor)));
 if(!BYTE_SURFACE){return materialSample(p,offset);}
 let base:vec2<f32>=p+floor(offset);let k:vec2<f32>=offset-floor(offset);
 let a:vec4<u32>=vec4<u32>(round(at(sourceA,base,u(1))*255.));
 let b:vec4<u32>=vec4<u32>(round(at(sourceA,base+vec2<f32>(1,0),u(1))*255.));
 let c:vec4<u32>=vec4<u32>(round(at(sourceA,base+vec2<f32>(0,1),u(1))*255.));
 let d:vec4<u32>=vec4<u32>(round(at(sourceA,base+vec2<f32>(1,1),u(1))*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(k.x),figmaFractionQ8(k.y));
}
fn opticalRayChannelAlpha(p:vec2<f32>,delta:vec2<f32>,factor:f32,channel:u32)->vec2<f32>{
 let offset:vec2<f32>=vec2<f32>(addRN(u(11).x,mulRN(delta.x,factor)),addRN(u(11).y,mulRN(delta.y,factor)));
 let base:vec2<f32>=p+floor(offset);let k:vec2<f32>=offset-floor(offset);
 return bsBilinearChannelAlpha(at(sourceA,base,u(1)),at(sourceA,base+vec2<f32>(1,0),u(1)),at(sourceA,base+vec2<f32>(0,1),u(1)),at(sourceA,base+vec2<f32>(1,1),u(1)),k,channel,u32(u(63).w),u32(u(63).z));
}
fn glassFieldAxis(index:i32, fold:vec4<f32>)->i32{
 let bounds=vec4<i32>(fold);
 if(index<bounds.x){return index;}
 if(index<bounds.y){return bounds.x;}
 if(index<bounds.z){return bounds.x+1;}
 return index-bounds.w;
}
fn analyticGlass(p:vec2<f32>)->vec4<f32>{
 // Explicit caller contract: immediate same-pixel mode-3 masked composition.
 // Its zero-alpha source returns the destination before source RGB is used.
 // Do not apply to arbitrary unmasked or masked optical outputs.
 if(!BYTE_SURFACE && u(10).y>0.5 && at(sourceC,p,u(3)).a==0.){return vec4<f32>(0);}
 var field=vec4<f32>(0);
 if(!BYTE_SURFACE&&u(12).x==3.){
  let q=vec2<i32>(floor(p-u(2).xy));
  if(all(q>=vec2<i32>(0))&&all(q<vec2<i32>(u(2).zw))){
   field=textureLoad(sourceB,vec2<i32>(glassFieldAxis(q.x,u(13)),glassFieldAxis(q.y,u(14))),0);
  }
 }else if(!BYTE_SURFACE&&u(12).x==2.){field=u(13);}else{field=at(sourceB,p,u(2));}
 let dispersion:f32=u(10).x;
 let capturedSpectrum:bool=BYTE_SURFACE&&u(12).x>0.5;
 // Flat interior: finite nonnegative ray factors all multiply the exact
 // zero displacement to the same offset. Keep every weighted accumulation.
 let sameRay:bool=!BYTE_SURFACE&&all((bitcast<vec2<u32>>(field.xy)&vec2<u32>(0x7fffffffu))==vec2<u32>(0u))&&dispersion>=0.&&dispersion<=1.&&u(11).z==3.&&u(11).w==8.&&all((bitcast<vec2<u32>>(u(11).xy)&vec2<u32>(0x7fffffffu))<=vec2<u32>(0x7f7fffffu))&&all(bitcast<vec2<u32>>(u(11).xy)!=vec2<u32>(0x80000000u));
 var sharedRay:vec4<f32>=vec4<f32>(0);if(dispersion<0.001||sameRay){sharedRay=opticalRay(p,field.xy,1.);}
 var result:vec4<f32>=vec4<f32>(0);
 if(dispersion<0.001){result=sharedRay;}else{
  var weights:f32=0.;
  // Keep the eight-ray loop dynamic so Metal does not duplicate the complete
  // exact HDR sampler for every tap during pipeline compilation.
  for(var tap:u32=0u;tap<u32(u(11).w);tap=tap+1u){
   var t:f32=0.;
   if(capturedSpectrum){t=fmaRN(f32(tap),0.14285715,-0.5);}else{t=addRN(mulRN(f32(tap),0.14285715),-0.5);}
   let weight:f32=addRN(1.,-abs(mulRN(t,2.)));
   var value:vec4<f32>=sharedRay;
   if(!sameRay){value=vec4<f32>(0);
   // One call site for the exact HDR sampler, also kept dynamic. Three copies
   // of its integer accumulator substantially inflate first-use compilation.
   for(var channel:u32=0u;channel<u32(u(11).z);channel=channel+1u){
    let phase:f32=addRN(t,addRN(0.5,-mulRN(f32(channel),0.5)));
    if(BYTE_SURFACE){
     let ray:vec4<f32>=opticalRay(p,field.xy,addRN(1.,mulRN(phase,dispersion)));
     value[channel]=ray[channel];value.w=max(value.w,ray.w);
    }else{
     let ray:vec2<f32>=opticalRayChannelAlpha(p,field.xy,addRN(1.,mulRN(phase,dispersion)),channel);
     value[channel]=ray.x;value.w=max(value.w,ray.y);
    }
   }
   }
   if(capturedSpectrum){
    result=vec4<f32>(fmaRN(value.x,weight,result.x),fmaRN(value.y,weight,result.y),fmaRN(value.z,weight,result.z),fmaRN(value.w,weight,result.w));
   }else{result=addRN4(result,mulRN4(value,vec4<f32>(weight)));}
   weights=addRN(weights,weight);
  }
  if(capturedSpectrum){result=mulRN4(result,vec4<f32>(divideRN(1.,weights)));}else{
   result=vec4<f32>(divideRN(result.x,weights),divideRN(result.y,weights),divideRN(result.z,weights),divideRN(result.w,weights));
  }
 }
 result=addRN4(result,vec4<f32>(field.z,field.z,field.z,0));
 if(softwareRasterByte()){
  result=softwareByteValue(softwareEncodeBytes(result));
  if(u(9).w>0.5){return result;}return mulRN4(result,vec4<f32>(at(sourceC,p,u(3)).a));
 }
 if(BYTE_SURFACE){
  result=clamp(result,vec4<f32>(0),vec4<f32>(1));
  result=vec4<f32>(f32(figmaEncodeUnorm8(result.x)),f32(figmaEncodeUnorm8(result.y)),f32(figmaEncodeUnorm8(result.z)),f32(figmaEncodeUnorm8(result.w)))/255.;
 }
 if(u(9).w>0.5){return result;}return mulRN4(result,vec4<f32>(at(sourceC,p,u(3)).a));
}
fn solidPaintOver(p:vec2<f32>)->vec4<f32>{
 let dst:vec4<f32>=at(sourceA,p,u(1));let coverage:f32=at(sourceB,p,u(2)).a;
 if(coverage==0.){return dst;}
 let src:vec4<f32>=mulRN4(u(7),vec4<f32>(coverage));let factor:f32=addRN(1.,-src.a);
 if(softwareRasterByte()){return softwareOver(dst,src);}
 let blended:vec4<f32>=clamp(vec4<f32>(positiveFmaRN(dst.x,factor,src.x),positiveFmaRN(dst.y,factor,src.y),positiveFmaRN(dst.z,factor,src.z),positiveFmaRN(dst.w,factor,src.w)),vec4<f32>(0),vec4<f32>(1));
 return vec4<f32>(f32(figmaEncodeUnorm8(blended.x)),f32(figmaEncodeUnorm8(blended.y)),f32(figmaEncodeUnorm8(blended.z)),f32(figmaEncodeUnorm8(blended.w)))/255.;
}
fn materialGlass(p:vec2<f32>)->vec4<f32>{
 let d:f32=linearDistance(p);let gx:f32=addRN(linearDistance(p+vec2<f32>(1,0)),-linearDistance(p-vec2<f32>(1,0)));let gy:f32=addRN(linearDistance(p+vec2<f32>(0,1)),-linearDistance(p-vec2<f32>(0,1)));
 let len:f32=max(sqrtRN(addRN(mulRN(gx,gx),mulRN(gy,gy))),1e-5);let nx:f32=divideRN(gx,len);let ny:f32=divideRN(gy,len);
 let edge:f32=clamp(addRN(1.,-divideRN(d,max(u(9).x,1e-5))),0.,1.);let nz:f32=sqrtRN(max(addRN(1.,-mulRN(edge,edge)),0.));let eta:f32=divideRN(1.,addRN(1.,u(9).y));
 let transmitted:f32=sqrtRN(max(addRN(1.,-mulRN(mulRN(eta,eta),mulRN(edge,edge))),1e-10));var bend:f32=0.;if(u(9).y!=0.){bend=addRN(edge,-divideRN(mulRN(mulRN(eta,edge),nz),transmitted));}
 let shift:f32=mulRN(mulRN(u(9).x,u(9).y),bend);let spread:f32=mulRN(mulRN(mulRN(mulRN(u(9).x,u(10).x),edge),edge),0.125);
 let red:f32=addRN(shift,-spread);let blue:f32=addRN(shift,spread);
 let r:vec4<f32>=materialSample(p,vec2<f32>(mulRN(nx,red),mulRN(ny,red)));let g:vec4<f32>=materialSample(p,vec2<f32>(mulRN(nx,shift),mulRN(ny,shift)));let b:vec4<f32>=materialSample(p,vec2<f32>(mulRN(nx,blue),mulRN(ny,blue)));
 var result:vec4<f32>=vec4<f32>(r.x,g.y,b.z,bitcast<f32>(max(max(bitcast<u32>(r.a),bitcast<u32>(g.a)),bitcast<u32>(b.a))));
 let dot:f32=addRN(mulRN(nx,u(10).y),mulRN(ny,u(10).z));
 let tint:f32=mulRN(mulRN(mulRN(mulRN(dot,u(9).z),edge),edge),0.125);
 if(tint<0.){result=materialOver(result,vec4<f32>(0,0,0,-tint));}else{result=materialOver(result,vec4<f32>(tint));}
 let rim:f32=clamp(addRN(1.,-divideRN(max(addRN(d,-0.5),0.),mulRN(u(11).x,0.9375))),0.,1.);
 let angular:f32=mulRN(abs(dot),sqrtRN(abs(dot)));
 let highlight:f32=clamp(mulRN(mulRN(mulRN(u(9).z,angular),addRN(2.,-mulRN(0.5,dot))),rim),0.,1.);
 result=materialOver(result,vec4<f32>(highlight));
 if(u(9).w>0.5){return result;}return mulRN4(result,vec4<f32>(at(sourceC,p,u(3)).a));
}
// SDR pixel preview has an explicit straight-RGBA8 source boundary. Recreate
// that byte contract on the GPU before its Q12 area filter, including hidden
// RGB on nearest sampling. The return is straight RGBA for readback and
// premultiplied only for presentation (u(4).y).
fn previewByteRound(value:f32)->u32{
 let scaled:f32=mulRN(clamp(value,0.,1.),255.);let q:f32=floor(scaled);
 return u32(q)+select(0u,1u,addRN(scaled,-q)>=0.5);
}
fn previewStraightBytes(value:vec4<f32>)->vec4<u32>{
 var bytes:vec4<u32>=vec4<u32>(0);bytes.w=previewByteRound(value.w);
 if(value.w>1e-10){for(var c:u32=0u;c<3u;c=c+1u){bytes[c]=previewByteRound(divideRN(value[c],value.w));}}
 return bytes;
}
fn previewCDF(edge:f32,lo:f32,scale:f32)->u32{return u32(round(mulRN(clamp(mulRN(addRN(edge,-lo),scale),0.,1.),4096.)));}
fn bytePreview(point:vec2<f32>)->vec4<f32>{
 let scale:f32=u(9).z;let q:vec2<f32>=vec2<f32>(divideRN(addRN(point.x,-u(9).x),scale),divideRN(addRN(point.y,-u(9).y),scale));
 var bytes:vec4<u32>=vec4<u32>(0);
 if(scale>=1.){bytes=previewStraightBytes(at(sourceA,floor(q)+0.5,u(1)));}
 else{
  let lo:vec2<f32>=vec2<f32>(divideRN(addRN(addRN(point.x,-0.5),-u(9).x),scale),divideRN(addRN(addRN(point.y,-0.5),-u(9).y),scale));
  let hi:vec2<f32>=vec2<f32>(divideRN(addRN(addRN(point.x,0.5),-u(9).x),scale),divideRN(addRN(addRN(point.y,0.5),-u(9).y),scale));
  var total:vec4<u32>=vec4<u32>(0);
  for(var y:i32=i32(floor(lo.y));y<i32(ceil(hi.y));y=y+1){for(var x:i32=i32(floor(lo.x));x<i32(ceil(hi.x));x=x+1){
   let wx:u32=previewCDF(f32(x+1),lo.x,scale)-previewCDF(f32(x),lo.x,scale);
   let wy:u32=previewCDF(f32(y+1),lo.y,scale)-previewCDF(f32(y),lo.y,scale);
   let pixel:vec4<u32>=previewStraightBytes(at(sourceA,vec2<f32>(f32(x)+0.5,f32(y)+0.5),u(1)));
   for(var c:u32=0u;c<3u;c=c+1u){total[c]=total[c]+((pixel[c]*pixel.w+127u)/255u)*wx*wy;}
   total.w=total.w+pixel.w*wx*wy;
  }}
  for(var c:u32=0u;c<4u;c=c+1u){let whole:u32=total[c]>>24u;let tail:u32=total[c]&0xffffffu;bytes[c]=whole+select(0u,1u,tail>0x800000u||(tail==0x800000u&&(whole&1u)!=0u));}
  if(bytes.w==0u){bytes=vec4<u32>(0);}else{for(var c:u32=0u;c<3u;c=c+1u){bytes[c]=min(255u,(bytes[c]*510u+bytes.w)/(bytes.w*2u));}}
 }
 var result:vec4<f32>=vec4<f32>(bytes)/255.;
 if(u(4).y>0.5){for(var c:u32=0u;c<3u;c=c+1u){result[c]=mulRN(result[c],result.w);}}
 return result;
}
// Image addresses are compiled from the same binary64 transforms as CPU
// sampling. This field carries no colors; the GPU fetches its own source image.
// A straight RGBA8 upload stores the Rust sRGB table in the two rows under the
// image. Hosted WebGPU replaces linearImageTexel with rgba8uint loads selected
// by u(51).w, then bsBilinear4. u(46).w stays clear: that branch mixes bytes
// and skips the table.
fn sourceTableWord(index:i32,row:i32)->f32{
 let bits=vec4<u32>(round(textureLoad(sourceB,vec2<i32>(index,row),0)*255.));
 return bitcast<f32>(bits.r|(bits.g<<8u)|(bits.b<<16u)|(bits.a<<24u));
}
fn linearImageTexel(q:vec2<i32>)->vec4<f32>{
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(2).zw))){return vec4<f32>(0);}
 let v=textureLoad(sourceB,q,0);
 if(u(4).x==2.&&u(7).x==3.&&u(51).w==1.){
  let b=vec4<i32>(round(v*255.));let row=i32(u(2).w);
  let a=sourceTableWord(b.a,row+1);
  return vec4<f32>(mulRN4(vec4<f32>(sourceTableWord(b.r,row),sourceTableWord(b.g,row),sourceTableWord(b.b,row),1.),vec4<f32>(a)).rgb,a);
 }
 return v;
}
// W=1 identifies two independent coordinate rows; general affine fields
// retain the dense address layout. Both carry metadata only, never colours.
fn byteImageAddress(p:vec2<f32>)->vec4<f32>{
 let pixel:vec2<i32>=vec2<i32>(floor(p-u(0).xy));
 if(textureLoad(sourceD,vec2<i32>(0),0).w>0.5){
  let x:vec4<f32>=textureLoad(sourceD,vec2<i32>(pixel.x,0),0);
  let y:vec4<f32>=textureLoad(sourceD,vec2<i32>(pixel.y,1),0);
  return vec4<f32>(x.x,y.x,x.z*y.z,1.);
 }
 return textureLoad(sourceD,pixel,0);
}
fn hostedStraightByteImage(p:vec2<f32>)->vec4<f32>{return linearImage(p);}
fn linearImage(p:vec2<f32>)->vec4<f32>{
 let grid:vec4<f32>=textureLoad(sourceD,vec2<i32>(floor(p-u(0).xy)),0);let q:vec2<i32>=vec2<i32>(grid.xy);
 return bsBilinear4(linearImageTexel(q),linearImageTexel(q+vec2<i32>(1,0)),linearImageTexel(q+vec2<i32>(0,1)),linearImageTexel(q+vec2<i32>(1,1)),grid.zw,u32(u(63).w),u32(u(63).z));
}
fn gradientStop(index:u32)->vec4<f32>{
 if(u(8).w>32.){return textureLoad(sourceB,vec2<i32>(i32(index),0),0);}
 return u(13u+index);
}
fn gradientStopAlpha(index:u32)->f32{
 if(u(8).w>32.){return textureLoad(sourceB,vec2<i32>(i32(index),1),0).x;}
 return u(52u+index/4u)[index%4u];
}
fn linearGradientStop(index:u32)->vec4<f32>{
 let color:vec4<f32>=gradientStop(index);let alpha:f32=gradientStopAlpha(index);
 return mulRN4(vec4<f32>(color.yzw,1.),vec4<f32>(alpha));
}
fn linearGradient(p:vec2<f32>)->vec4<f32>{
 var address:vec2<i32>=vec2<i32>(floor(p-u(0).xy));
 let dimensions:vec2<i32>=vec2<i32>(textureDimensions(sourceD,0));
 // Only a certified compact field differs from the target extent.
 if(dimensions.x==1&&u(0).z>1.){address.x=0;}
 if(dimensions.y==1&&u(0).w>1.){address.y=0;}
 let grid:vec4<f32>=textureLoad(sourceD,address,0);
 if(grid.x<0.){return mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(60).y));}
 let left:vec4<f32>=linearGradientStop(u32(grid.x));
 if(grid.x==grid.y){return left;}
 let right:vec4<f32>=linearGradientStop(u32(grid.y));
 return addRN4(left,mulRN4(addRN4(right,-left),vec4<f32>(grid.z)));
}
// END GENERATED MATERIAL MATH SOURCE

@group(0) @binding(4) var<storage,read> curves:array<vec4<f32>>;
fn curvePoint(kind:i32,a:vec4<f32>,b:vec4<f32>,t:f32)->vec2<f32>{
 if(kind==2){return a.xy+a.zw*cos(t)+b.xy*sin(t);}
 let ab=mix(a.xy,a.zw,t);let bc=mix(a.zw,b.xy,t);let cd=mix(b.xy,b.zw,t);
 return mix(mix(ab,bc,t),mix(bc,cd,t),t);
}
fn windingFor(point:vec2<f32>,span:vec2<f32>,bands:vec2<f32>)->i32{
 var winding=0;var first=u32(span.x);var count=u32(span.y);
 if(bands.y>0.){let band=curves[u32(bands.x)+u32(clamp(floor(point.y/16.),0.,bands.y-1.))];first=u32(band.x);count=u32(band.y);}
 for(var i=0u;i<count;i=i+1u){var base=first+i*4u;if(bands.y>0.){base=u32(curves[first+i/4u][i%4u]);}
  let segmentInfo=curves[base];let a=curves[base+1u];let b=curves[base+2u];let range=curves[base+3u];
  if(point.y<range.z||point.y>=range.w){continue;}
  var x=0.;let kind=i32(segmentInfo.x);
  if(kind==0){let dy=a.w-a.y;let side=(a.z-a.x)*(point.y-a.y)-(point.x-a.x)*dy;if((dy>0.&&side>0.)||(dy<0.&&side<0.)){winding=winding+i32(segmentInfo.y);}continue;}
  else {var lo=0.;var hi=1.;for(var n=0;n<26;n=n+1){let mid=(lo+hi)*0.5;let t=mix(range.x,range.y,mid);let q=curvePoint(kind,a,b,t);
    if((q.y<point.y)==(segmentInfo.y>0.)){lo=mid;}else{hi=mid;}}
    x=curvePoint(kind,a,b,mix(range.x,range.y,(lo+hi)*0.5)).x;
  }
  if(x>point.x){winding=winding+i32(segmentInfo.y);}
 }
 return winding;
}
fn windingAt(point:vec2<f32>)->i32{return windingFor(point,u(9).xy,u(10).xy);}
fn curveMask(p:vec2<f32>)->vec4<f32>{
 let offsets=array<vec2<f32>,4>(vec2<f32>(0.375,0.125),vec2<f32>(0.875,0.375),vec2<f32>(0.125,0.625),vec2<f32>(0.625,0.875));
 if(u(9).w>0.){let index=u32(u(9).w)-1u;let w=windingAt(p-u(0).xy-0.5+offsets[index]);return vec4<f32>(select(0.,1.,select(w!=0,abs(w)%2!=0,u(9).z>0.5)));}
 var samples=0.;for(var i=0u;i<4u;i=i+1u){let w=windingAt(p-u(0).xy-0.5+offsets[i]);let inside=select(w!=0,abs(w)%2!=0,u(9).z>0.5);if(inside){samples=samples+1.;}}
 if(u(60).x>0.5){return vec4<f32>(samples*0.25);}
 return vec4<f32>(round(samples*63.75)/255.);
}
// Integral of the tent over both source and output pixel footprints.
fn tentWeight(radius:f32,x:f32)->f32{
 // Integrated adjacent-pixel overlap is r/6; avoid (1+r)-1 and r*r.
 if(radius<=1.){if(x==0.){return 1.-radius/3.;}if(x==1.){return divideRN(radius,6.);}return 0.;}
 if(x==0.){return (radius-1./3.)/(radius*radius);}
 if(x+1.<=radius){return (radius-x)/(radius*radius);}
 let a=max(radius+1.-x,0.);let b=max(radius-x,0.);
 return (a*a*a-2.*b*b*b)/(6.*radius*radius);
}
fn blurAt(p:vec2<f32>)->vec4<f32>{var q=p;if(u(9).z>0.5){q=clamp(q,u(1).xy+0.5,u(1).xy+u(1).zw-0.5);}return at(sourceA,q,u(1));}
fn tentInteger(p:vec2<f32>,axis:vec2<f32>,radius:i32)->vec4<f32>{
 var total=vec4<u32>(0);let denominator=u32(6*radius*radius);
 for(var i=-radius;i<=radius;i=i+1){let d=abs(i);var numerator=1u;
  if(d==0){numerator=u32(6*radius-2);}else if(d<radius){numerator=u32(6*(radius-d));}
  total=total+vec4<u32>(round(blurAt(p+axis*f32(i))*255.))*numerator;
 }
 let quotient=total/vec4<u32>(denominator);let remainder=total-quotient*denominator;
 let up=(remainder*2u>vec4<u32>(denominator))|((remainder*2u==vec4<u32>(denominator))&((quotient&vec4<u32>(1))!=vec4<u32>(0)));
 return vec4<f32>(quotient+select(vec4<u32>(0),vec4<u32>(1),up))/255.;
}
fn fourBytes(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{return round(at(tex,p,r)*255.)+round(at(tex,p+vec2<f32>(1,0),r)*255.)+round(at(tex,p+vec2<f32>(0,1),r)*255.)+round(at(tex,p+vec2<f32>(1,1),r)*255.);}
fn resolveFour(input:vec4<f32>,tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{var sum=input;for(var y=0;y<2;y=y+1){for(var x=0;x<2;x=x+1){sum=addRN4(sum,mulRN4(at(tex,p+vec2<f32>(f32(x),f32(y)),r),vec4<f32>(0.0625)));}}return sum;}
fn ccEncode(v:f32)->f32 {let x=abs(v);if(x<=0.0031308){return v*12.92;}return sign(v)*(1.055*pow(x,1./2.4)-0.055);}
fn ccDecode(v:f32)->f32 {let x=abs(v);if(x<=0.04045){return v/12.92;}return sign(v)*pow((x+0.055)/1.055,2.4);}
fn ccRows(p:vec4<f32>,base:u32)->vec3<f32>{var result=vec3<f32>(0);for(var i=0u;i<3u;i=i+1u){let row=u(base+i);result[i]=addRN(addRN(addRN(mulRN(p.r,row.x),mulRN(p.g,row.y)),mulRN(p.b,row.z)),mulRN(p.a,row.w));}return result;}
fn colorControlsPixel(p:vec4<f32>)->vec4<f32>{
 if(p.a==0.){return p;}if(u(12).x<0.5){return vec4<f32>(ccRows(p,9u),p.a);}
 let straight=vec3<f32>(divideRN(p.r,p.a),divideRN(p.g,p.a),divideRN(p.b,p.a));
 let local=ccRows(vec4<f32>(straight,0),13u);
 let encoded=vec3<f32>(ccEncode(local.r),ccEncode(local.g),ccEncode(local.b));
 let adjusted=ccRows(vec4<f32>(encoded,1),9u);
 let decoded=vec3<f32>(ccDecode(adjusted.r),ccDecode(adjusted.g),ccDecode(adjusted.b));
 let result=ccRows(vec4<f32>(decoded,0),16u);
 return vec4<f32>(mulRN(result.r,p.a),mulRN(result.g,p.a),mulRN(result.b,p.a),p.a);
}
fn motionKernelTap(i:u32)->vec4<f32>{return textureLoad(sourceB,vec2<i32>(i32(i%256u),i32(i/256u)),0);}
fn motionBlurPixel(p:vec2<f32>)->vec4<f32>{
 let header=motionKernelTap(0u);var sum=vec4<f32>(0);
 for(var i=0u;i<u32(header.x);i=i+1u){let tap=motionKernelTap(1u+2u*i);let weight=motionKernelTap(2u+2u*i).x;let q=p+tap.xy;
  let value=bsBilinear4(at(sourceA,q,u(1)),at(sourceA,q+vec2<f32>(1,0),u(1)),at(sourceA,q+vec2<f32>(0,1),u(1)),at(sourceA,q+vec2<f32>(1,1),u(1)),tap.zw,19u,9u);
  sum=addRN4(sum,mulRN4(value,vec4<f32>(weight)));
 }
 return vec4<f32>(divideRN(sum.x,header.y),divideRN(sum.y,header.y),divideRN(sum.z,header.y),divideRN(sum.w,header.y));
}
fn zoomSample(p:vec2<f32>,tap:u32)->vec4<f32>{
 let header=motionKernelTap(0u);let pixel=vec2<u32>(floor(p-u(1).xy));
 let x=motionKernelTap(1u+pixel.x*64u+tap);let y=motionKernelTap(u32(header.w)+pixel.y*64u+tap);
 let q=u(1).xy+vec2<f32>(x.x,y.x)+0.5;
 return bsBilinear4(at(sourceA,q,u(1)),at(sourceA,q+vec2<f32>(1,0),u(1)),at(sourceA,q+vec2<f32>(0,1),u(1)),at(sourceA,q+vec2<f32>(1,1),u(1)),vec2<f32>(x.y,y.y),19u,9u);
}
fn zoomBlurPixel(p:vec2<f32>)->vec4<f32>{
 let count=min(64u,u32(motionKernelTap(0u).x));if(count==0u){return at(sourceA,p,u(1));}
 var samples:array<vec4<f32>,4>;var quads:array<vec4<f32>,4>;var groups:array<vec4<f32>,4>;
 // One sampling call site avoids duplicating the wide exact sampler in every
 // branch. The reduction order is still exactly the CPU's 4×4×4 tree.
 for(var i=0u;i<count;i=i+1u){samples[i%4u]=zoomSample(p,i);
  if(i%4u==3u){quads[(i/4u)%4u]=meanFourRN(samples[0],samples[1],samples[2],samples[3]);
   if(i%16u==15u){groups[i/16u]=meanFourRN(quads[0],quads[1],quads[2],quads[3]);}
  }
 }
 return meanFourRN(groups[0],groups[1],groups[2],groups[3]);
}
// Encoded area of one device pixel when an axis-aligned stretch image is near
// half resolution. x<0 means the historical tap still applies. Device scale,
// not a CSS zoom label, selects the band, so DPR 2 at CSS 50% stays 1:1.
fn halfScaleStretch(p:vec2<f32>)->vec4<f32>{
 if(u(60).x>0.5||u(62).z>0.5||u(8).z<1.5||u(5).y!=0.||u(5).z!=0.){return vec4<f32>(-1.);}
 let size=u(2).zw;let node=u(6).zw;
 if(any(node<=vec2<f32>(0.))||any(size<vec2<f32>(1.))){return vec4<f32>(-1.);}
 let origin=floor(p);let scale=size/node;
 let e00=local(origin)*scale;let e10=local(origin+vec2<f32>(1.,0.))*scale;let e01=local(origin+vec2<f32>(0.,1.))*scale;
 let span=abs(vec2<f32>(e10.x-e00.x,e01.y-e00.y));
 if(any(span<vec2<f32>(1.5))||any(span>=vec2<f32>(2.5))){return vec4<f32>(-1.);}
 let xLo=min(e00.x,e10.x);let xHi=max(e00.x,e10.x);let yLo=min(e00.y,e01.y);let yHi=max(e00.y,e01.y);
 var sum=vec4<f32>(0.);var weight=0.;
 let x0=i32(floor(xLo));let y0=i32(floor(yLo));let x1=i32(ceil(xHi));let y1=i32(ceil(yHi));
 let base=vec2<i32>(u(2).xy);
 for(var y=0;y<4;y=y+1){let ty=y0+y;if(ty>=y1){break;}
  let yb=f32(ty);let wy=min(yHi,yb+1.)-max(yLo,yb);if(wy<=0.){continue;}
  for(var x=0;x<4;x=x+1){let tx=x0+x;if(tx>=x1){break;}
   let xb=f32(tx);let wx=min(xHi,xb+1.)-max(xLo,xb);if(wx<=0.){continue;}
   if(tx<0||ty<0||f32(tx)>=size.x||f32(ty)>=size.y){continue;}
   let w=wx*wy;sum=sum+round(textureLoad(sourceB,base+vec2<i32>(tx,ty),0)*255.)*w;weight=weight+w;
  }
 }
 if(weight<=0.){return vec4<f32>(0.);}
 return clamp(floor(sum/weight+vec4<f32>(0.5)),vec4<f32>(0.),vec4<f32>(255.))/255.;
}
fn shade(p:vec2<f32>)->vec4<f32>{let mode=select(i32(u(4).x),COMPOSITOR_MODE,COMPOSITOR_MODE>=0);if(BYTE_SURFACE&&mode==43){return textureReplayEffect(p);}if(BYTE_SURFACE&&mode==44){return textureReplayCopyback(p);}if(BYTE_SURFACE&&mode==45){return textureReplaySource(p);}if(BYTE_SURFACE&&mode==42){return measuredGradientOver(p);}if(BYTE_SURFACE&&mode==40){return captureDownscale(p);}if(BYTE_SURFACE&&mode==41){return captureTriangle(p);}if(BYTE_SURFACE&&mode==36){return figmaFourPass(at(sourceA,p,u(1)),at(sourceB,p,u(2)),at(sourceC,p,u(3)),at(sourceD,p,u(1)));}if(BYTE_SURFACE&&mode==35){return solidPaintOver(p);}if(mode==34){return analyticGlass(p);}if(mode==33){return bytePreview(p);}if(mode==46){return gradientBlurComposite(p);}if(mode==61){return motionBlurPixel(p);}if(mode==62){return zoomBlurPixel(p);}if(mode==8&&u(10).z>0.5){return materialTexture(p);}if(mode==11&&u(10).w>0.5){return materialGlass(p);}let a=smp(sourceA,p,u(1));
 // Managed surfaces preserve extended-range linear light in RGBA32F.
 if(u(60).x>0.5){
  if(mode==3||mode==15){var opacity=u(4).z;if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}let src=mulRN4(a,vec4<f32>(opacity));if(mode==15){return src;}return over(smp(sourceB,p,u(2)),src,i32(u(4).y));}
  if(mode==8){return legacyTexture(p,true);}
  if(mode==11){return linearGlass(p);}
  if(mode==23){return meanFourRN(at(sourceA,p,u(1)),at(sourceB,p,u(2)),at(sourceC,p,u(3)),at(sourceD,p,u(1)));}
  if(mode==26){return meanFourRN(smp(sourceA,p,u(1)),smp(sourceB,p,u(2)),smp(sourceC,p,u(3)),smp(sourceD,p,u(1)));}
  if(mode==24){let q=(p-u(9).xy)/u(9).z-0.5;var sum=vec4<f32>(0);sum=resolveFour(sum,sourceA,q,u(1));sum=resolveFour(sum,sourceB,q,u(2));sum=resolveFour(sum,sourceC,q,u(3));return resolveFour(sum,sourceD,q,u(1));}
  // Match CPU backdrop replacement's separate multiply/subtract rounding.
  // Texture displacement can make coverage > source alpha; contraction here
  // otherwise changes HDR float bits even when final display bytes agree.
  if(mode==25){var opacity=u(4).z;if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceC,p,u(3)).a);}let src=mulRN4(a,vec4<f32>(opacity));let dst=smp(sourceB,p,u(2));let coverage=mulRN(at(sourceD,p,u(47)).a,opacity);let extra=max(0.,addRN(coverage,-src.a));return addRN4(over(dst,src,i32(u(4).y)),-mulRN4(dst,vec4<f32>(extra)));}
  if(mode==22){let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);return rationalBlur(p,axis);}
  if(mode==21){let q=(p-u(9).xy)/u(9).z-0.5;return (at(sourceA,q,u(1))+at(sourceA,q+vec2<f32>(1,0),u(1))+at(sourceA,q+vec2<f32>(0,1),u(1))+at(sourceA,q+vec2<f32>(1,1),u(1)))*0.25;}
  if(mode==27){return smp(sourceA,clamp(p,u(1).xy+0.5,u(1).xy+u(1).zw-0.5),u(1));}
  if(mode==29||mode==28){let dst=smp(sourceB,p,u(2));if(mode==28&&(any(p<u(1).xy)||any(p>=u(1).xy+u(1).zw))){return dst;}var opacity=u(4).z;if(u(4).w>0.5){opacity=opacity*at(sourceC,p,u(3)).a;}if(mode==28){return addRN4(mulRN4(dst,vec4<f32>(addRN(1.,-opacity))),mulRN4(a,vec4<f32>(opacity)));}return over(dst,mulRN4(a,vec4<f32>(opacity)),0);}
  if(mode==6){let b=smp(sourceB,p-u(9).yz,u(2)).a;let coverage=select(b,mulRN(a.a,addRN(1.,-b)),u(9).w>0.5);return mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(8).x)),vec4<f32>(coverage));}
  if(mode==18){let scale=u(9).z;let q=(p-u(9).xy)/scale;if(scale>=1.){return at(sourceA,floor(q)+0.5,u(1));}let lo=(p-0.5-u(9).xy)/scale;let hi=(p+0.5-u(9).xy)/scale;var total=vec4<f32>(0);for(var y=i32(floor(lo.y));y<i32(ceil(hi.y));y=y+1){for(var x=i32(floor(lo.x));x<i32(ceil(hi.x));x=x+1){let cell=vec2<f32>(f32(x),f32(y));let w=max(vec2<f32>(0),min(hi,cell+1.)-max(lo,cell))*scale;total=total+at(sourceA,cell+0.5,u(1))*w.x*w.y;}}return total;}
 }

 if(mode==22){let radius=u(9).x;let reach=i32(ceil(radius));let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);var total=vec4<f32>(0);
  // Gaussian byte surfaces use uniform boxes, never the legacy Q24 tent table.
  if(u(9).w>1.5){var sum=vec4<u32>(0);for(var i=-reach;i<=reach;i=i+1){sum=sum+vec4<u32>(round(blurAt(p+axis*f32(i))*255.));}let denominator=u32(2*reach+1);return vec4<f32>((sum+vec4<u32>(denominator/2u))/vec4<u32>(denominator))/255.;}
  if(u(9).w>0.5){var sum=vec4<u32>(0);for(var i=-reach;i<=reach;i=i+1){let v=vec4<u32>(round(textureLoad(sourceB,vec2<i32>(abs(i),0),0)*255.));let weight=v.x|(v.y<<8u)|(v.z<<16u)|(v.w<<24u);sum=sum+vec4<u32>(round(blurAt(p+axis*f32(i))*255.))*weight;}let q=sum>>vec4<u32>(24);let r=sum&vec4<u32>(0x00ffffffu);let up=(r>vec4<u32>(0x00800000u))|((r==vec4<u32>(0x00800000u))&((q&vec4<u32>(1))!=vec4<u32>(0)));return vec4<f32>(q+select(vec4<u32>(0),vec4<u32>(1),up))/255.;}
  if(radius==floor(radius)){return tentInteger(p,axis,reach);}
  for(var i=-reach;i<=reach;i=i+1){total=total+blurAt(p+axis*f32(i))*tentWeight(radius,abs(f32(i)));}
  return round(clamp(total,vec4<f32>(0),vec4<f32>(1))*255.)/255.;}
 if(mode==20){return curveMask(p);}
 if(mode==26){let total=round(smpBytes(sourceA,p,u(1)))+round(smpBytes(sourceB,p,u(2)))+round(smpBytes(sourceC,p,u(3)))+round(smpBytes(sourceD,p,u(1)));return floor((total+2.)*0.25)/255.;}
 if(mode==27){return round(smpBytes(sourceA,clamp(p,u(1).xy+0.5,u(1).xy+u(1).zw-0.5),u(1)))/255.;}
 if(mode==29){let dst=vec4<u32>(round(smp(sourceB,p,u(2))*255.));let src=vec4<u32>(round(a*255.));var opacity=u(4).z;if(u(4).w>0.5){opacity=opacity*at(sourceC,p,u(3)).a;}let weight=u32(round(clamp(opacity,0.,1.)*65535.));let denominator=16711425u;let numerator=dst*(denominator-src.a*weight)+src*(255u*weight);let q=numerator/vec4<u32>(denominator);let rem=numerator-q*denominator;return vec4<f32>(q+select(vec4<u32>(0),vec4<u32>(1),rem*2u>vec4<u32>(denominator)))/255.;}
 if(mode==28){let dst=smp(sourceB,p,u(2));if(any(p<u(1).xy)||any(p>=u(1).xy+u(1).zw)){return dst;}var opacity=u(4).z;if(u(4).w>0.5){opacity=opacity*at(sourceC,p,u(3)).a;}if(u(4).y>0.5){return round(round(dst*255.)*(1.-opacity)+round(a*255.)*opacity)/255.;}return dst*(1.-opacity)+a*opacity;}
 if(mode==25){var opacity=u(4).z;if(u(4).w>0.5){opacity=opacity*at(sourceC,p,u(3)).a;}let src=a*opacity;let dst=smp(sourceB,p,u(2));let coverage=at(sourceD,p,u(47)).a*opacity;return round(clamp(over(dst,src,i32(u(4).y))-dst*max(0.,coverage-src.a),vec4<f32>(0),vec4<f32>(1))*255.)/255.;}
 if(BYTE_SURFACE&&mode==24){let q=(p-u(9).xy)/u(9).z-0.5;return figmaSpatialResolve(q);}
 if(mode==23){let total=round(at(sourceA,p,u(1))*255.)+round(at(sourceB,p,u(2))*255.)+round(at(sourceC,p,u(3))*255.)+round(at(sourceD,p,u(1))*255.);return floor((total+2.)*0.25)/255.;}
 if(mode==21){let q=(p-u(9).xy)/u(9).z-0.5;
  let total=round(at(sourceA,q,u(1))*255.)+round(at(sourceA,q+vec2<f32>(1,0),u(1))*255.)+round(at(sourceA,q+vec2<f32>(0,1),u(1))*255.)+round(at(sourceA,q+vec2<f32>(1,1),u(1))*255.);
  return figmaNormalized4(vec4<u32>(total));}
 if(mode==19){let q=floor(p-u(0).xy)*2.+0.5;return (at(sourceA,q,u(1))+at(sourceA,q+vec2<f32>(1,0),u(1))+at(sourceA,q+vec2<f32>(0,1),u(1))+at(sourceA,q+vec2<f32>(1,1),u(1)))*0.25;}
 if(mode==18){let scale=u(9).z;let q=(p-u(9).xy)/scale;if(scale>=1.){return at(sourceA,floor(q)+0.5,u(1));}
 let lo=(p-0.5-u(9).xy)/scale;let hi=(p+0.5-u(9).xy)/scale;var total=vec4<u32>(0);
 for(var y=i32(floor(lo.y));y<i32(ceil(hi.y));y=y+1){for(var x=i32(floor(lo.x));x<i32(ceil(hi.x));x=x+1){let cell=vec2<f32>(f32(x),f32(y));
  let w=vec2<u32>(round(clamp((cell+1.-lo)*scale,vec2<f32>(0),vec2<f32>(1))*4096.))-vec2<u32>(round(clamp((cell-lo)*scale,vec2<f32>(0),vec2<f32>(1))*4096.));
  total=total+vec4<u32>(round(at(sourceA,cell+0.5,u(1))*255.))*w.x*w.y;}}
 let quotient=total>>vec4<u32>(24);let r=total&vec4<u32>(0x00ffffffu);let up=(r>vec4<u32>(0x00800000u))|((r==vec4<u32>(0x00800000u))&((quotient&vec4<u32>(1))!=vec4<u32>(0)));return vec4<f32>(quotient+select(vec4<u32>(0),vec4<u32>(1),up))/255.;}
 if(mode==17){let q=p-u(0).xy;let extent=clamp(min(q+0.5,u(9).zw)-max(q-0.5,u(9).xy),vec2<f32>(0),vec2<f32>(1));return vec4<f32>(extent.x*extent.y);}
 if(mode==0||mode==14){return a;}
 if(mode==1){let b=at(sourceB,p,u(2)).a;return vec4<f32>(at(sourceA,p,u(1)).a*select(b,1.-b,u(9).x>0.5));}
 if(mode==2||mode==16){let q=local(p+u(46).xy);let kind=i32(u(7).x);let opacity=u(8).x;var paint=vec4<f32>(u(7).yzw*opacity*u(60).y,opacity*u(60).y);if(kind==0&&u(46).z>0.5){paint=u(48);}
  if((kind==1||kind==2||kind==4||kind==5)&&u(60).x<0.5){let t=gradientT(p,q,kind);let count=u32(u(8).w);if(count>0u){let bytePaint=u(46).w>0.5;let firstAlpha=gradientStopAlpha(0u);var rgba=vec4<f32>(gradientStop(0u).yzw*firstAlpha,firstAlpha);if(bytePaint){rgba=round(rgba*255.);}for(var i=1u;i<64u;i=i+1u){if(i>=count){break;}let l=gradientStop(i-1u);let r=gradientStop(i);if(t>l.x){let la=gradientStopAlpha(i-1u);let ra=gradientStopAlpha(i);var left=vec4<f32>(l.yzw*la,la);var right=vec4<f32>(r.yzw*ra,ra);if(bytePaint){left=round(left*255.);right=round(right*255.);}let k=clamp((t-l.x)/max(r.x-l.x,1e-8),0.,1.);if(bytePaint){rgba=vec4<f32>(colourMix(left.r,right.r,k),colourMix(left.g,right.g,k),colourMix(left.b,right.b,k),colourMix(left.a,right.a,k));}else{rgba=left+(right-left)*k;}}}paint=rgba*opacity;if(bytePaint){paint=round(rgba*opacity)/255.;}}}
  if(u(60).x>0.5){
   if(kind==0){paint=mulRN4(mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(60).y)),vec4<f32>(opacity));}
   if(kind==1||kind==2||kind==4||kind==5){paint=mulRN4(linearGradient(p),vec4<f32>(opacity));}
  }
  if(kind==3&&u(46).w>0.5){let grid=byteImageAddress(p);if(grid.z>0.5){paint=round(smpBytesIndex(sourceB,grid.xy,u(2))*opacity)/255.;}else{paint=vec4<f32>(0);}}else if(kind==3&&u(60).x>0.5&&u(51).w>0.5){paint=mulRN4(hostedStraightByteImage(p),vec4<f32>(opacity));}else if(kind==3&&u(60).x>0.5){paint=mulRN4(linearImage(p),vec4<f32>(opacity));}else if(kind==3){let size=u(2).zw;var coord=paintUV(q)*size-0.5;if(u(62).z<0.5){coord=(q*size-u(6).zw*0.5)/u(6).zw;if(u(8).z<1.5){let ratio=select(min(u(6).z/size.x,u(6).w/size.y),max(u(6).z/size.x,u(6).w/size.y),u(8).z<0.5);coord=(q-(u(6).zw-(size-1.)*ratio)*0.5)/ratio;}}if(u(8).z>0.5&&u(8).z<1.5&&(any(coord<vec2<f32>(-0.5))||any(coord>=size-0.5))){paint=vec4<f32>(0);}else{if(u(46).w>0.5){paint=round(smpBytesIndex(sourceB,clamp(coord,vec2<f32>(0),size-1.),u(2))*opacity)/255.;}else{paint=smpIndex(sourceB,clamp(coord,vec2<f32>(0),size-1.),u(2))*opacity;}}}
  {let half=halfScaleStretch(p);if(kind==3&&half.x>=0.){paint=half*opacity;}}
  if(u(46).w>0.5){paint=round(paint*255.)/255.;}
  var result=paint*at(sourceA,p,u(1)).a;if(u(60).x>0.5){result=mulRN4(paint,vec4<f32>(at(sourceA,p,u(1)).a));}if(mode==16){result=result*u(4).z;if(u(4).w>0.5){result=result*at(sourceC,p,u(3)).a;}}return result;
 }
 if(mode==15){var src=a*u(4).z;if(u(4).w>0.5){src=src*at(sourceC,p,u(3)).a;}return src;}
 if(mode==3&&u(60).x<0.5&&u(4).z<1.&&(u(4).y==1.||u(4).y==2.)){let dst=vec4<u32>(round(smp(sourceB,p,u(2))*255.));let src=vec4<u32>(round(a*255.));var opacity=u(4).z;if(u(4).w>0.5){opacity=opacity*at(sourceC,p,u(3)).a;}let weight=u32(round(clamp(opacity,0.,1.)*65535.));let denominator=16711425u;var sum=dst*(denominator-src.a*weight)+src*(255u*weight);if(u(4).y==1.){sum=vec4<u32>(src.rgb*weight*(vec3<u32>(255u-dst.a)+dst.rgb)+dst.rgb*(denominator-src.a*weight),sum.a);}else{sum=vec4<u32>(src.rgb*weight*(vec3<u32>(255)-dst.rgb)+dst.rgb*denominator,sum.a);}let q=sum/vec4<u32>(denominator);let rem=sum-q*denominator;return vec4<f32>(q+select(vec4<u32>(0),vec4<u32>(1),rem*2u>vec4<u32>(denominator)))/255.;}
 if(mode==3){var src=a*u(4).z;if(u(4).w>0.5){src=src*at(sourceC,p,u(3)).a;}return over(smp(sourceB,p,u(2)),src,i32(u(4).y));}
 if(mode==4||mode==5){let radius=i32(u(9).x);let axis=select(vec2<f32>(0,1),vec2<f32>(1,0),u(9).y<0.5);var total=vec4<f32>(0);var alpha=select(1.,0.,u(9).z>0.5);for(var i=-radius;i<=radius;i=i+1){var v:vec4<f32>;if(mode==5&&u(9).w>0.5){v=at(sourceA,p+axis*f32(i),u(1));}else{v=smp(sourceA,p+axis*f32(i),u(1));}if(mode==4){total=total+v;}else{alpha=select(min(alpha,v.a),max(alpha,v.a),u(9).z>0.5);}}if(mode==4){return total/f32(2*radius+1);}return vec4<f32>(0,0,0,alpha);}
 if(mode==6){if(u(9).x>0.5){let b=smpBytes(sourceB,p-u(9).yz,u(2)).a;let coverage=select(b,round(a.a*255.)*(1.-b/255.),u(9).w>0.5);let alpha=u32(round(clamp(u(8).x*coverage,0.,255.)*65536.));let colors=vec4<u32>(round(vec4<f32>(u(7).yzw,1.)*255.));let numerator=colors*alpha;let denominator=16711680u;let q=numerator/vec4<u32>(denominator);let r=numerator-q*denominator;let up=(r*2u>vec4<u32>(denominator))|((r*2u==vec4<u32>(denominator))&((q&vec4<u32>(1))!=vec4<u32>(0)));return vec4<f32>(q+select(vec4<u32>(0),vec4<u32>(1),up))/255.;}let b=smp(sourceB,p-u(9).yz,u(2)).a;let coverage=select(b,a.a*(1.-b),u(9).w>0.5);let alpha=u(8).x*coverage;let result=vec4<f32>(u(7).yzw*alpha,alpha);if(u(9).x>0.5){return round(result*255.)/255.;}return result;}
 if(mode==60){return colorControlsPixel(a);}
 if(mode==30){return vec4<f32>(maskLumRN(a.rgb));}
 if(mode==7){let v=noise(vec2<i32>(floor(local(p)*max(0.01,u(10).x))),7u);let alpha=u(10).y*a.a;var source=vec4<f32>(vec3<f32>(v*alpha),alpha);if(u(60).x<0.5){source=round(source*255.)/255.;}return over(a,source,9);}
 if(mode==8){return legacyTexture(p,false);}
 if(mode==9){if(at(sourceA,p,u(1)).a>0.5){return vec4<f32>(1);}return encodePoint(floor(p-u(0).xy));}
 if(mode==10){let here=floor(p-u(0).xy);var best=vec2<f32>(-1);var score=1e30;for(var y=-1;y<=1;y=y+1){for(var x=-1;x<=1;x=x+1){let pos=p+vec2<f32>(f32(x),f32(y))*u(9).x;if(any(pos<u(1).xy)||any(pos>=u(1).xy+u(1).zw)){continue;}let candidate=decodePoint(at(sourceA,pos,u(1)));if(candidate.x<0.){continue;}let d=dot(here-candidate,here-candidate);if(d<score){score=d;best=candidate;}}}return encodePoint(best);}
 if(mode==11){let d=distanceField(p);let grad=vec2<f32>(distanceField(p+vec2<f32>(1,0))-distanceField(p-vec2<f32>(1,0)),distanceField(p+vec2<f32>(0,1))-distanceField(p-vec2<f32>(0,1)));let len=max(length(grad),1e-5);let factor=clamp(1.-d/max(u(9).x,4.),0.,1.);let refract=smp(sourceA,p+grad/len*u(9).y*factor*factor,u(1));let highlight=abs(grad.x-grad.y)/len*factor*u(9).z*0.25;if(u(60).x<0.5&&u(9).w>0.5){let dst=vec4<u32>(round(clamp(smpBytes(sourceA,p+grad/len*u(9).y*factor*factor,u(1)),vec4<f32>(0),vec4<f32>(255))));let alpha=u32(round(clamp(highlight,0.,1.)*255.));let sum=dst*(255u-alpha)+vec4<u32>(alpha*255u);let q=sum/vec4<u32>(255);let rem=sum-q*255u;return vec4<f32>(q+select(vec4<u32>(0),vec4<u32>(1),rem*2u>vec4<u32>(255)))/255.;}return over(refract,vec4<f32>(vec3<f32>(highlight),highlight),0)*select(at(sourceC,p,u(3)).a,1.,u(9).w>0.5);}
 if(mode==12){var bg=vec4<f32>(u(12).rgb*u(12).a,u(12).a);if(u(13).w>0.){let cell=vec2<i32>(floor(p/u(13).w));if(((cell.x^cell.y)&1)!=0){bg=vec4<f32>(u(13).rgb,1.);}}if(u(11).w>0.5&&u(11).z>0.13){let spacing=32.*u(11).z;var delta=p-u(11).xy;delta=delta-floor(delta/spacing)*spacing;delta=min(delta,vec2<f32>(spacing)-delta);let alpha=clamp(1.-length(delta),0.,1.)*0.4;bg=over(bg,vec4<f32>(vec3<f32>(0.65,0.67,0.73)*alpha,alpha),0);}return bg;}
 return vec4<f32>(0);
}
@vertex fn quad(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32>{let x=f32((i<<1u)&2u);let y=f32(i&2u);return vec4<f32>(x*2.-1.,1.-y*2.,0.,1.);}
// Match Pixel::straight_rgba8: RN32 division/product, then nonnegative half-up.
// Only terminal SDR presentation uses this; float intermediates stay untouched.
fn analyticDisplayColor(value:vec4<f32>)->vec4<f32>{
 if(value.a<=0.){return vec4<f32>(0);}
 let straight=vec4<f32>(divideRN(value.r,value.a),divideRN(value.g,value.a),divideRN(value.b,value.a),value.a);
 let scaled=mulRN4(clamp(straight,vec4<f32>(0),vec4<f32>(1)),vec4<f32>(255));
 let base=floor(scaled);let bytes=base+select(vec4<f32>(0),vec4<f32>(1),scaled-base>=vec4<f32>(0.5));
 let encoded=bytes/255.;return vec4<f32>(encoded.rgb*encoded.a,encoded.a);
}
fn displayColor(value:vec4<f32>)->vec4<f32>{
 if(value.a<=0.){return vec4<f32>(0);}var c=value.rgb/value.a;
 if(u(60).w<0.5){c=clamp(c,vec3<f32>(0),vec3<f32>(1));}
 let x=abs(c);let encoded=select(1.055*pow(x,vec3<f32>(1./2.4))-0.055,12.92*x,x<=vec3<f32>(0.0031308));
 return vec4<f32>(sign(c)*encoded*value.a,value.a);
}
@fragment fn fragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32>{let value=shade(p.xy+u(0).xy);if(u(60).z>0.5){return displayColor(value);}let mode=i32(u(4).x);if(u(60).x<0.5&&mode!=15&&mode!=16&&mode!=44){return round(clamp(value,vec4<f32>(0),vec4<f32>(1))*255.)/255.;}return value;}

@group(1) @binding(0) var<storage,read> solidData:array<vec4<f32>>;
struct SolidVertex { @builtin(position) position:vec4<f32>, @location(0) @interpolate(flat) item:u32 }
@vertex fn solidQuad(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->SolidVertex {
 let corners=array<vec2<f32>,6>(vec2<f32>(0,0),vec2<f32>(1,0),vec2<f32>(0,1),vec2<f32>(0,1),vec2<f32>(1,0),vec2<f32>(1,1));
 let item=u32(u(9).x)+instance*5u;let r=solidData[item+4u];let p=(r.xy+corners[vertex]*r.zw-u(0).xy)/u(0).zw;
 var out:SolidVertex;out.position=vec4<f32>(p.x*2.-1.,1.-p.y*2.,0.,1.);out.item=item;return out;
}
@fragment fn solidFragment(input:SolidVertex)->@location(0) vec4<f32>{
 let p=input.position.xy+u(0).xy;if(u(4).w>0.5&&at(sourceC,p,u(3)).a<0.5){discard;}
 let offsets=array<vec2<f32>,4>(vec2<f32>(0.375,0.125),vec2<f32>(0.875,0.375),vec2<f32>(0.125,0.625),vec2<f32>(0.625,0.875));
 let r=solidData[input.item];let shapeInfo=solidData[input.item+1u];let q=p-r.xy-0.5+offsets[u32(u(9).y)];var inside=false;
 if(shapeInfo.w>=2.){let b=solidData[input.item+2u];inside=all(q>=b.xy)&&all(q<b.zw);}
 else {let bands=vec2<f32>(max(0.,shapeInfo.z),select(0.,ceil(r.w/16.),shapeInfo.z>=0.));let w=windingFor(q,shapeInfo.xy,bands);inside=select(w!=0,abs(w)%2!=0,(u32(shapeInfo.w)&1u)!=0u);}
 if(!inside){discard;}return solidData[input.item+3u];
}
