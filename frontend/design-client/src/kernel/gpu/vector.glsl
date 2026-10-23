#version 300 es
#ifndef COMPOSITOR_MODE
#define COMPOSITOR_MODE int(u[4].x)
#endif
precision highp float;
precision highp int;
layout(std140) uniform Params { vec4 u[64]; };
uniform sampler2D sourceA;
uniform sampler2D sourceB;
uniform sampler2D sourceC;
uniform sampler2D sourceD;
out vec4 color;
vec4 at(sampler2D tex,vec2 p,vec4 r){ivec2 q=ivec2(floor(p-r.xy));if(q.x<0||q.y<0||q.x>=int(r.z)||q.y>=int(r.w))return vec4(0);return texelFetch(tex,q,0);}
vec4 smp(sampler2D tex,vec2 p,vec4 r){vec2 q=p-r.xy-.5;vec2 k=fract(q);vec2 base=floor(q)+r.xy+.5;if(u[60].x>.5)return bsBilinear4(at(tex,base,r),at(tex,base+vec2(1,0),r),at(tex,base+vec2(0,1),r),at(tex,base+vec2(1,1),r),k,uint(u[63].w),uint(u[63].z));return mix(mix(at(tex,base,r),at(tex,base+vec2(1,0),r),k.x),mix(at(tex,base+vec2(0,1),r),at(tex,base+vec2(1,1),r),k.x),k.y);}
vec4 smpIndex(sampler2D tex,vec2 q,vec4 r){vec2 k=fract(q);vec2 base=floor(q)+r.xy+.5;if(u[60].x>.5)return bsBilinear4(at(tex,base,r),at(tex,base+vec2(1,0),r),at(tex,base+vec2(0,1),r),at(tex,base+vec2(1,1),r),k,uint(u[63].w),uint(u[63].z));return mix(mix(at(tex,base,r),at(tex,base+vec2(1,0),r),k.x),mix(at(tex,base+vec2(0,1),r),at(tex,base+vec2(1,1),r),k.x),k.y);}
vec4 smpBytesIndex(sampler2D tex,vec2 q,vec4 r){vec2 k=fract(q);vec2 base=floor(q)+r.xy+.5;return mix(mix(roundEven(at(tex,base,r)*255.),roundEven(at(tex,base+vec2(1,0),r)*255.),k.x),mix(roundEven(at(tex,base+vec2(0,1),r)*255.),roundEven(at(tex,base+vec2(1,1),r)*255.),k.x),k.y);}
vec4 smpBytes(sampler2D tex,vec2 p,vec4 r){vec2 q=p-r.xy-.5;vec2 k=fract(q);vec2 base=floor(q)+r.xy+.5;return mix(mix(roundEven(at(tex,base,r)*255.),roundEven(at(tex,base+vec2(1,0),r)*255.),k.x),mix(roundEven(at(tex,base+vec2(0,1),r)*255.),roundEven(at(tex,base+vec2(1,1),r)*255.),k.x),k.y);}
float lum(vec3 c){return dot(c,vec3(.3,.59,.11));}
float sat(vec3 c){return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
vec3 setLum(vec3 c,float l){c+=l-lum(c);float n=min(min(c.r,c.g),c.b),x=max(max(c.r,c.g),c.b),ll=lum(c);if(n<0.)c=ll+(c-ll)*ll/max(ll-n,1e-10);if(x>1.)c=ll+(c-ll)*(1.-ll)/max(x-ll,1e-10);return c;}
vec3 setSat(vec3 c,float s){float lo=min(min(c.r,c.g),c.b),hi=max(max(c.r,c.g),c.b);return hi>lo?(c-lo)*s/(hi-lo):vec3(0);}
vec4 blendRN(vec4 b,vec4 s,int mode);float addRN(float a,float b);vec4 addRN4(vec4 a,vec4 b);vec4 mulRN4(vec4 a,vec4 b);
float channel(float b,float s,int mode){if(mode==1)return b*s;if(mode==2)return b+s-b*s;if(mode==3)return b<=.5?2.*b*s:1.-2.*(1.-b)*(1.-s);if(mode==4)return min(b,s);if(mode==5)return max(b,s);if(mode==6)return b<=0.?0.:s>=1.?1.:min(1.,b/(1.-s));if(mode==7)return b>=1.?1.:s<=0.?0.:1.-min(1.,(1.-b)/s);if(mode==8)return s<=.5?2.*b*s:1.-2.*(1.-b)*(1.-s);if(mode==9){float d=b<=.25?((16.*b-12.)*b+4.)*b:sqrt(b);return s<=.5?b-(1.-2.*s)*b*(1.-b):b+(2.*s-1.)*(d-b);}if(mode==10)return abs(b-s);if(mode==11)return b+s-2.*b*s;if(mode==16)return max(0.,b+s-1.);if(mode==17)return min(1.,b+s);return s;}
// Match the correctly rounded binary32 coordinate division in WGSL.
uvec2 wideMultiply(uint a,uint b){uint a0=a&65535u,a1=a>>16u,b0=b&65535u,b1=b>>16u,p0=a0*b0,p1=a1*b0,p2=a0*b1,carry=(p0>>16u)+(p1&65535u)+(p2&65535u);return uvec2((p0&65535u)|(carry<<16u),a1*b1+(p1>>16u)+(p2>>16u)+(carry>>16u));}
uvec2 add64(uvec2 a,uvec2 b){uint lo=a.x+b.x;return uvec2(lo,a.y+b.y+uint(lo<a.x));}
uvec2 negate64(uvec2 a){uint lo=~a.x+1u;return uvec2(lo,~a.y+uint(lo==0u));}
uvec2 timesCoordinate(uvec2 a,int b){uint k=uint(abs(b));uvec2 product=wideMultiply(a.x,k),value=uvec2(product.x,product.y+a.y*k);return b<0?negate64(value):value;}
uvec2 unpack64(vec4 words){uvec4 w=uvec4(words);return uvec2(w.x|(w.y<<16u),w.z|(w.w<<16u));}
uint highestBit(uint v){uint n=0u;if(v>=65536u){v>>=16u;n+=16u;}if(v>=256u){v>>=8u;n+=8u;}if(v>=16u){v>>=4u;n+=4u;}if(v>=4u){v>>=2u;n+=2u;}if(v>=2u)n++;return n;}
float divideRN(float a,float b){
 uint ab=floatBitsToUint(a),bb=floatBitsToUint(b),sign=(ab^bb)&0x80000000u,ae=(ab>>23u)&255u,be=(bb>>23u)&255u;
 if(ae==255u||be==255u)return a/b;
 uint numerator=(ab&0x7fffffu)|(ae!=0u?0x800000u:0u),denominator=(bb&0x7fffffu)|(be!=0u?0x800000u:0u);
 if(denominator==0u)return a/b;if(numerator==0u)return uintBitsToFloat(sign);
 uint sa=23u-highestBit(numerator),sb=23u-highestBit(denominator);numerator<<=sa;denominator<<=sb;
 int exponent=int(max(ae,1u))-int(sa)-int(max(be,1u))+int(sb)+127;
 if(numerator<denominator){numerator*=2u;exponent--;}
 uint remainder=numerator-denominator,mantissa=0x800000u;
 for(int bit=22;bit>=0;bit--){remainder*=2u;if(remainder>=denominator){remainder-=denominator;mantissa|=1u<<uint(bit);}}
 if(exponent<=0){uint shift=uint(1-exponent);if(shift>24u)return uintBitsToFloat(sign);
  uint q=mantissa>>shift,tail=mantissa&((1u<<shift)-1u),halfway=1u<<(shift-1u);
  bool up=tail>halfway||(tail==halfway&&(remainder!=0u||(q&1u)!=0u));return uintBitsToFloat(sign|(q+uint(up)));}
 if(remainder*2u>denominator||(remainder*2u==denominator&&(mantissa&1u)!=0u))mantissa++;
 if(mantissa==0x1000000u){mantissa>>=1u;exponent++;}
 if(exponent>=255)return uintBitsToFloat(sign|0x7f800000u);
 return uintBitsToFloat(sign|(uint(exponent)<<23u)|(mantissa&0x7fffffu));
}
// Integer guard/round/sticky binary32 operations; mirrored by oracle tests.
uint shiftJam(uint value,uint shift){if(shift==0u)return value;if(shift>=32u)return uint(value!=0u);return (value>>shift)|uint((value<<(32u-shift))!=0u);}
float packRN(uint sign,uint sig,int exponent){
 if(exponent<1){sig=shiftJam(sig,uint(1-exponent));exponent=1;}
 uint mantissa=sig>>3u,tail=sig&7u;if(tail>4u||(tail==4u&&(mantissa&1u)!=0u))mantissa++;
 if(mantissa>=0x1000000u){mantissa>>=1u;exponent++;}
 if(exponent>=255)return uintBitsToFloat(sign|0x7f800000u);
 if(mantissa<0x800000u)exponent=0;
 return uintBitsToFloat(sign|(uint(exponent)<<23u)|(mantissa&0x7fffffu));
}
float addRN(float a,float b){
 uint aa=floatBitsToUint(a),bb=floatBitsToUint(b);
 if((aa&0x7fffffffu)<(bb&0x7fffffffu)){uint tmp=aa;aa=bb;bb=tmp;}
 uint sign=aa&0x80000000u,ae=(aa>>23u)&255u,be=(bb>>23u)&255u;if(ae==255u)return a+b;
 int exponent=int(max(ae,1u));
 uint ma=((aa&0x7fffffu)|(ae!=0u?0x800000u:0u))<<3u;
 uint mb=shiftJam(((bb&0x7fffffu)|(be!=0u?0x800000u:0u))<<3u,uint(exponent)-max(be,1u)),sum=ma+mb;
 if(((aa^bb)&0x80000000u)!=0u){sum=ma-mb;if(sum==0u)return 0.;}
 if(sum>=0x8000000u){sum=shiftJam(sum,1u);exponent++;}
 else for(int i=0;i<26&&sum<0x4000000u&&exponent>1;i++){sum<<=1u;exponent--;}
 return packRN(sign,sum,exponent);
}
float mulRN(float a,float b){
 uint aa=floatBitsToUint(a),bb=floatBitsToUint(b),sign=(aa^bb)&0x80000000u,ae=(aa>>23u)&255u,be=(bb>>23u)&255u;
 if(ae==255u||be==255u)return a*b;
 uint ma=(aa&0x7fffffu)|(ae!=0u?0x800000u:0u),mb=(bb&0x7fffffu)|(be!=0u?0x800000u:0u);
 if(ma==0u||mb==0u)return uintBitsToFloat(sign);
 int ea=int(max(ae,1u)),eb=int(max(be,1u));uint sa=23u-highestBit(ma),sb=23u-highestBit(mb);
 ma<<=sa;mb<<=sb;ea-=int(sa);eb-=int(sb);
 uvec2 product=wideMultiply(ma,mb);uint top=32u+highestBit(product.y),shift=top-26u;
 uint sig=(product.x>>shift)|(product.y<<(32u-shift))|uint((product.x&((1u<<shift)-1u))!=0u);
 return packRN(sign,sig,ea+eb-127+int(top)-46);
}
vec4 addRN4(vec4 a,vec4 b){return vec4(addRN(a.x,b.x),addRN(a.y,b.y),addRN(a.z,b.z),addRN(a.w,b.w));}
vec4 mulRN4(vec4 a,vec4 b){return vec4(mulRN(a.x,b.x),mulRN(a.y,b.y),mulRN(a.z,b.z),mulRN(a.w,b.w));}
float sqrtRN(float a){
 uint raw=floatBitsToUint(a);if(raw==0u||raw==0x80000000u)return a;
 if((raw&0x80000000u)!=0u)return uintBitsToFloat(0x7fc00000u);
 uint ae=(raw>>23u)&255u;if(ae==255u)return a;
 uint m=(raw&0x7fffffu)|(ae!=0u?0x800000u:0u),shift=23u-highestBit(m);m<<=shift;
 int exponent=int(max(ae,1u))-127-int(shift);if((exponent&1)!=0){m<<=1u;exponent--;}
 uvec2 n=uvec2(m<<23u,m>>9u);uint lo=0x800000u,hi=0x1000000u;
 for(int i=0;i<24;i++){uint mid=(lo+hi)>>1u;uvec2 sq=wideMultiply(mid,mid);
  if(sq.y<n.y||(sq.y==n.y&&sq.x<=n.x))lo=mid;else hi=mid;}
 uvec2 remainder=add64(n,negate64(wideMultiply(lo,lo)));
 if(remainder.y!=0u||remainder.x>lo)lo++;
 exponent=exponent/2+127;if(lo==0x1000000u){lo>>=1u;exponent++;}
 return uintBitsToFloat((uint(exponent)<<23u)|(lo&0x7fffffu));
}
// BEGIN GENERATED BLEND MATH
vec4 meanFourRN(vec4 a,vec4 b,vec4 c,vec4 d){
 // Match CPU's scale-each-sample then left-to-right accumulation. Moving
 // the scale outside the sum changes gradual underflow and rounding.
 vec4 scale=vec4(0.25);
 return addRN4(addRN4(addRN4(mulRN4(a,scale),mulRN4(b,scale)),mulRN4(c,scale)),mulRN4(d,scale));
}
vec3 straightRN(vec4 pixel){
 if(pixel.a<=1e-10){return vec3(0);}
 return vec3(divideRN(pixel.x,pixel.a),divideRN(pixel.y,pixel.a),divideRN(pixel.z,pixel.a));
}
float lumRN(vec3 c){return addRN(addRN(mulRN(c.x,0.3),mulRN(c.y,0.59)),mulRN(c.z,0.11));}
float satRN(vec3 c){return addRN(max(max(c.x,c.y),c.z),-min(min(c.x,c.y),c.z));}
bool totalLessRN(float a,float b){
 uint aa=floatBitsToUint(a);uint bb=floatBitsToUint(b);uint ka=aa|0x80000000u;uint kb=bb|0x80000000u;
 if((aa&0x80000000u)!=0u){ka=~aa;}if((bb&0x80000000u)!=0u){kb=~bb;}return ka<kb;
}
vec3 setSatRN(vec3 c,float amount){
 uvec3 indices=uvec3(0u,1u,2u);
 if(totalLessRN(c[indices.y],c[indices.x])){uint t=indices.x;indices.x=indices.y;indices.y=t;}
 if(totalLessRN(c[indices.z],c[indices.y])){uint t=indices.y;indices.y=indices.z;indices.z=t;}
 if(totalLessRN(c[indices.y],c[indices.x])){uint t=indices.x;indices.x=indices.y;indices.y=t;}
 vec3 result=vec3(0);
 if(c[indices.z]>c[indices.x]){
  result[indices.y]=divideRN(mulRN(addRN(c[indices.y],-c[indices.x]),amount),addRN(c[indices.z],-c[indices.x]));
  result[indices.z]=amount;
 }
 return result;
}
vec3 setLumRN(vec3 initialColor,float desiredLum){
 float shift=addRN(desiredLum,-lumRN(initialColor));vec3 c=vec3(addRN(initialColor.x,shift),addRN(initialColor.y,shift),addRN(initialColor.z,shift));
 float l=lumRN(c);float low=min(min(c.x,c.y),c.z);float high=max(max(c.x,c.y),c.z);
 if(low<0.){for(uint i=0u;i<3u;i=i+1u){c[i]=addRN(l,divideRN(mulRN(addRN(c[i],-l),l),max(addRN(l,-low),1e-10)));}}
 if(high>1.){for(uint i=0u;i<3u;i=i+1u){c[i]=addRN(l,divideRN(mulRN(addRN(c[i],-l),addRN(1.,-l)),max(addRN(high,-l),1e-10)));}}
 return c;
}
float maskLumRN(vec3 c){return clamp(addRN(addRN(mulRN(c.x,0.2126),mulRN(c.y,0.7152)),mulRN(c.z,0.0722)),0.,1.);}
// END GENERATED BLEND MATH
float channelRN(float b,float s,int mode){
 if(mode==1)return mulRN(b,s);if(mode==2)return addRN(addRN(b,s),-mulRN(b,s));
 if(mode==3||mode==8){if((mode==8?s:b)<=.5)return mulRN(mulRN(2.,b),s);return addRN(1.,-mulRN(mulRN(2.,addRN(1.,-b)),addRN(1.,-s)));}
 if(mode==4)return min(b,s);if(mode==5)return max(b,s);
 if(mode==6){if(b<=0.)return 0.;if(s>=1.)return 1.;return min(1.,divideRN(b,addRN(1.,-s)));}
 if(mode==7){if(b>=1.)return 1.;if(s<=0.)return 0.;return addRN(1.,-min(1.,divideRN(addRN(1.,-b),s)));}
 if(mode==9){if(s<=.5)return addRN(b,-mulRN(mulRN(addRN(1.,-mulRN(2.,s)),b),addRN(1.,-b)));
  float d=b<=.25?mulRN(addRN(mulRN(addRN(mulRN(16.,b),-12.),b),4.),b):sqrtRN(b);
  return addRN(b,mulRN(addRN(mulRN(2.,s),-1.),addRN(d,-b)));}
 if(mode==16)return max(0.,addRN(addRN(b,s),-1.));if(mode==17)return min(1.,addRN(b,s));
 if(mode==10)return abs(addRN(b,-s));if(mode==11)return addRN(addRN(b,s),-mulRN(mulRN(2.,b),s));return s;
}
// BEGIN GENERATED BLEND COMPOSITE
vec4 blendRN(vec4 b,vec4 s,int mode){
 vec3 cb=straightRN(b);vec3 cs=straightRN(s);
 vec3 components=vec3(channelRN(cb.x,cs.x,mode),channelRN(cb.y,cs.y,mode),channelRN(cb.z,cs.z,mode));
 if(mode==12){components=setLumRN(setSatRN(cs,satRN(cb)),lumRN(cb));}
 if(mode==13){components=setLumRN(setSatRN(cb,satRN(cs)),lumRN(cb));}
 if(mode==14){components=setLumRN(cs,lumRN(cb));}
 if(mode==15){components=setLumRN(cb,lumRN(cs));}
 vec4 m=vec4(components,0.);
 vec4 left=mulRN4(s,vec4(addRN(1.,-b.a)));vec4 middle=mulRN4(m,vec4(mulRN(s.a,b.a)));
 vec4 right=mulRN4(b,vec4(addRN(1.,-s.a)));vec4 rgb=addRN4(addRN4(left,middle),right);
 return vec4(rgb.xyz,addRN(s.a,mulRN(b.a,addRN(1.,-s.a))));
}
// END GENERATED BLEND COMPOSITE
float fixedLinear(vec2 point){
 uint bits=uint(u[63].x)+3u;int x=int(roundEven(point.x*8.)),y=int(roundEven(point.y*8.));
 uvec2 value=add64(add64(timesCoordinate(unpack64(u[49]),x),timesCoordinate(unpack64(u[50]),y)),timesCoordinate(unpack64(u[51]),8));
 if((value.y&0x80000000u)!=0u||all(equal(value,uvec2(0))))return 0.;
 uvec2 denominator=uvec2(0);if(bits<32u)denominator.x=1u<<bits;else denominator.y=1u<<(bits-32u);
 if(value.y>denominator.y||(value.y==denominator.y&&value.x>=denominator.x))return 1.;
 uint top=value.y!=0u?32u+highestBit(value.y):highestBit(value.x),mantissa;
 if(top<=23u)mantissa=value.x<<(23u-top);else{uint shift=top-23u;mantissa=(value.x>>shift)|(value.y<<(32u-shift));uint remainder=value.x&((1u<<shift)-1u),halfway=1u<<(shift-1u);if(remainder>halfway||(remainder==halfway&&(mantissa&1u)!=0u))mantissa++;}
 if(mantissa==0x1000000u){mantissa>>=1u;top++;}
 return uintBitsToFloat((uint(int(top)-int(bits)+127)<<23u)|(mantissa&0x7fffffu));
}

float scaledPositive64(uvec2 value,uint bits){
 if(all(equal(value,uvec2(0))))return 0.;uint top=value.y!=0u?32u+highestBit(value.y):highestBit(value.x),mantissa=0u;bool up=false;
 if(top<=23u)mantissa=value.x<<(23u-top);else{uint shift=top-23u;if(shift<32u){mantissa=(value.x>>shift)|(value.y<<(32u-shift));uint rem=value.x&((1u<<shift)-1u),halfway=1u<<(shift-1u);up=rem>halfway||(rem==halfway&&(mantissa&1u)!=0u);}else if(shift==32u){mantissa=value.y;up=value.x>0x80000000u||(value.x==0x80000000u&&(mantissa&1u)!=0u);}else{uint s=shift-32u;mantissa=value.y>>s;uint rem=value.y&((1u<<s)-1u),halfway=1u<<(s-1u);up=rem>halfway||(rem==halfway&&(value.x!=0u||(mantissa&1u)!=0u));}if(up)mantissa++;}
 if(mantissa==0x1000000u){mantissa>>=1u;top++;}int exponent=int(top)-int(bits)+127;if(exponent<=0)return uintBitsToFloat(value.x<<(149u-bits));return uintBitsToFloat((uint(exponent)<<23u)|(mantissa&0x7fffffu));
}
float colourMix(float a,float b,float t){
 uint raw=floatBitsToUint(t);
 if(raw==0u||(raw&0x80000000u)!=0u)return a;
 if(raw>=0x3f800000u)return b;
 int delta=int(b)-int(a);if(delta==0)return a;
 uint exponent=(raw>>23u)&255u,shift=exponent==0u?149u:150u-exponent;
 uint significand=(raw&0x7fffffu)|(exponent==0u?0u:0x800000u);
 uint product=uint(abs(delta))*significand;
 if(a==0.)return scaledPositive64(uvec2(product,0),shift);
 if(shift>55u)return a;
 uvec2 base=uvec2(0);
 if(shift<32u)base=uvec2(uint(a)<<shift,uint(a)>>(32u-shift));
 else base.y=uint(a)<<(shift-32u);
 uvec2 term=uvec2(product,0);if(delta<0)term=negate64(term);
 return scaledPositive64(add64(base,term),shift);
}
vec2 paintUV(vec2 q){vec2 uv=vec2(divideRN(q.x,u[6].z),divideRN(q.y,u[6].w));if(u[62].z>.5)return vec2(dot(uv,u[61].xz),dot(uv,u[61].yw))+u[62].xy;return uv;}
float gradientT(vec2 p,vec2 q,int kind){vec2 uv=paintUV(q);vec2 delta=(uv-.5)*2.;float t=sqrt(delta.x*delta.x+delta.y*delta.y);if(delta.x==0.)t=abs(delta.y);else if(delta.y==0.)t=abs(delta.x);if(kind==1)t=u[63].x>=24.?fixedLinear(p+u[46].xy):u[62].z>.5?uv.x:(u[50].w>.5?dot(p+u[46].xy-u[51].xy,u[50].xy)+u[50].z:dot(uv-.5,u[49].xy)/max(u[49].z,1e-8)+.5);else if(kind==4){float a=(atan(uv.y-.5,uv.x-.5)-u[8].y)/6.28318530718;t=a-floor(a);}else if(kind==5){vec2 d=uv-.5;t=2.*max(abs(dot(d,u[49].xy)),abs(dot(d,vec2(-u[49].y,u[49].x))));}return clamp(t,0.,1.);}
// Gradient-modulated blur, composited in one pass (mode 46), mirroring
// vector.wgsl. The host precomputes f64 affine field coefficients (u[9].xyz,
// smooth tier in u[9].w); the shader decodes the counts ramp (u[10].xy), the
// two-tier weight curves and the normalized blend. No CPU readback.
float fmaRN(float a,float b,float c);
vec4 gradientBlurComposite(vec2 p){
 vec4 sharp=at(sourceA,p,u[1]);vec4 blurred=at(sourceB,p,u[2]);
 if(u[60].x<.5){
  sharp=vec4(divideRN(round(mulRN(sharp.x,255.)),255.),divideRN(round(mulRN(sharp.y,255.)),255.),divideRN(round(mulRN(sharp.z,255.)),255.),divideRN(round(mulRN(sharp.w,255.)),255.));
  blurred=vec4(divideRN(round(mulRN(blurred.x,255.)),255.),divideRN(round(mulRN(blurred.y,255.)),255.),divideRN(round(mulRN(blurred.z,255.)),255.),divideRN(round(mulRN(blurred.w,255.)),255.));
 }
 float t=clamp(fmaRN(u[9].x,p.x,fmaRN(u[9].y,p.y,u[9].z)),0.,1.);
 float b=addRN(u[10].x,mulRN(addRN(u[10].y,-u[10].x),t));
 if(b<1.)return sharp;
 float d=addRN(b,-1.);float q=addRN(mulRN(d,d),addRN(d,d));
 float wb=mulRN(q,q);if(u[9].w>.5){float w=addRN(q,q);wb=mulRN(w,w);}
 float ws=mulRN(b,b);float total=addRN(wb,ws);
 return vec4(divideRN(addRN(mulRN(wb,blurred.x),mulRN(ws,sharp.x)),total),divideRN(addRN(mulRN(wb,blurred.y),mulRN(ws,sharp.y)),total),divideRN(addRN(mulRN(wb,blurred.z),mulRN(ws,sharp.z)),total),divideRN(addRN(mulRN(wb,blurred.w),mulRN(ws,sharp.w)),total));
}
vec4 over(vec4 b,vec4 s,int mode){if(s.a<=0.)return b;if(b.a<=0.)return s;if(mode==0){if(u[60].x>.5)return addRN4(s,mulRN4(b,vec4(addRN(1.,-s.a))));return s+b*(1.-s.a);}if(u[60].x>.5)return blendRN(b,s,mode);vec3 cb=b.rgb/b.a,cs=s.rgb/s.a,m=vec3(channel(cb.r,cs.r,mode),channel(cb.g,cs.g,mode),channel(cb.b,cs.b,mode));if(mode==12)m=setLum(setSat(cs,sat(cb)),lum(cb));if(mode==13)m=setLum(setSat(cb,sat(cs)),lum(cb));if(mode==14)m=setLum(cs,lum(cb));if(mode==15)m=setLum(cb,lum(cs));return vec4(s.rgb*(1.-b.a)+s.a*b.a*m+b.rgb*(1.-s.a),s.a+b.a*(1.-s.a));}
float noise(ivec2 p,uint seed){uint h=uint(p.x)*0x9e3779b1u^uint(p.y)*0x85ebca77u^seed;h^=h>>16;h*=0x7feb352du;h^=h>>15;h*=0x846ca68bu;h^=h>>16;return divideRN(float(h&0x00ffffffu),16777215.);}
vec2 local(vec2 p){return vec2(u[5].x*p.x+u[5].z*p.y+u[6].x,u[5].y*p.x+u[5].w*p.y+u[6].y);}
vec4 encodePoint(vec2 p){if(p.x<0.)return vec4(1);uvec2 q=uvec2(round(p));return vec4(float(q.x&255u),float(q.x>>8),float(q.y&255u),float(q.y>>8))/255.;}
vec2 decodePoint(vec4 v){uvec4 q=uvec4(round(v*255.));if(q.x==255u&&q.y==255u)return vec2(-1);return vec2(float(q.x|(q.y<<8)),float(q.z|(q.w<<8)));}
float distanceField(vec2 p){vec2 q=decodePoint(at(sourceB,p,u[2]));return q.x<0.?1000000.:length(p-u[2].xy-.5-q);}
// BEGIN GENERATED MATERIAL MATH
uint materialSelect(uint a,uint b,bool s){return s?b:a;}
int materialSelect(int a,int b,bool s){return s?b:a;}
// Independently derived bounded RGBA8 sampling arithmetic. Inputs must satisfy
// the same contracts as design-kernel/src/figma_sampling.rs. No texture data,
// reference pixels or vendor shader source is embedded here.
uint figmaMsb32(uint rawValue) {
    uint value=rawValue;
    uint result=0u;
    if(value>=65536u){value=value>>16u;result=result+16u;}
    if(value>=256u){value=value>>8u;result=result+8u;}
    if(value>=16u){value=value>>4u;result=result+4u;}
    if(value>=4u){value=value>>2u;result=result+2u;}
    if(value>=2u){result=result+1u;}
    return result;
}
uint figmaFractionQ8(float value) {
    uint bits=floatBitsToUint(value);
    uint exponent=(bits>>23u)&255u;
    if(exponent==0u){return 0u;}
    uint significand=(bits&8388607u)|8388608u;
    uint shift=142u-exponent;
    if(shift>=25u){return 0u;}
    return (significand+(1u<<(shift-1u)))>>shift;
}
float figmaNormalizeQ4(uint q) {
    if(q==0u){return 0.0;}
    uint msb=figmaMsb32(q);
    int exponent=int(msb)-8;
    if(msb>=7u){
        if(q>=(255u<<(msb-7u))){exponent=exponent+1;}
    }
    uint numerator=q<<uint(23-exponent);
    uint significand=numerator/255u;
    uint remainder=numerator%255u;
    if(remainder>=128u){significand=significand+1u;}
    uint bits=(uint(exponent+123)<<23u)|(significand-8388608u);
    return uintBitsToFloat(bits);
}
uint figmaEncodeUnorm8(float value) {
    uint bits=floatBitsToUint(value);
    uint exponent=(bits>>23u)&255u;
    if(exponent==0u){return 0u;}
    uint significand=(bits&8388607u)|8388608u;
    uint numerator=significand*255u;
    uint shift=150u-exponent;
    if(shift>=33u){return 0u;}
    if(shift==32u){
        if(numerator>2147483648u){return 1u;}
        return 0u;
    }
    uint quotient=numerator>>shift;
    uint remainder=numerator&((1u<<shift)-1u);
    uint halfway=1u<<(shift-1u);
    if(remainder>halfway || (remainder==halfway && (quotient&1u)!=0u)){
        quotient=quotient+1u;
    }
    return quotient;
}
// Explicit byte-domain compatibility. Index 253 is reserved by the drivers;
// HDR and all legacy passes keep this branch disabled.
// Texture replay keeps its independently verified source/clip-alpha contract.
// Its Q4 alpha residual table is not a software UNORM8 sampler table.
bool softwareRasterByte(){int mode=int(u[4].x);return BYTE_SURFACE&&u[63].y>0.5&&(mode<43||mode>45);}
uint softwareLerpByte(uint a,uint b,uint weight){
 int product=(int(b)-int(a))*int(weight);uint magnitude=uint(abs(product));
 uint quotient=magnitude>>8u;uint remainder=magnitude&255u;
 uint rounded=quotient+materialSelect(0u,1u,remainder>128u||(remainder==128u&&(quotient&1u)!=0u));
 return uint(int(a)+materialSelect(int(rounded),-int(rounded),product<0));
}
uvec4 softwareSampleBytes(uvec4 p0,uvec4 p1,uvec4 p2,uvec4 p3,uint wx,uint wy){
 uvec4 result=uvec4(0u);
 for(uint channel=0u;channel<4u;channel=channel+1u){
  uint top=softwareLerpByte(p0[channel],p1[channel],wx);
  uint bottom=softwareLerpByte(p2[channel],p3[channel],wx);
  result[channel]=softwareLerpByte(top,bottom,wy);
 }
 return result;
}
float softwareNormalizeByte(uint value){return mulRN(float(value),uintBitsToFloat(0x3b808081u));}
vec4 softwareByteValue(uvec4 value){
 return vec4(softwareNormalizeByte(value.x),softwareNormalizeByte(value.y),softwareNormalizeByte(value.z),softwareNormalizeByte(value.w));
}
uint softwareEncodeByte(float value){
 float scaled=mulRN(clamp(value,0.,1.),255.);uint integral=uint(scaled);
 float remainder=addRN(scaled,-float(integral));
 return integral+materialSelect(0u,1u,remainder>0.5||(remainder==0.5&&(integral&1u)!=0u));
}
uvec4 softwareEncodeBytes(vec4 value){
 return uvec4(softwareEncodeByte(value.x),softwareEncodeByte(value.y),softwareEncodeByte(value.z),softwareEncodeByte(value.w));
}
uvec4 softwareBlendBytes(uvec4 previous,uvec4 source,uint factor){
 uvec4 src=(source*factor+uvec4(127u))/255u;
 uvec4 dst=(previous*(255u-factor)+uvec4(127u))/255u;
 return min(src+dst,uvec4(255u));
}
vec4 softwareOver(vec4 dst,vec4 src){
 uvec4 a=softwareEncodeBytes(src);uvec4 b=softwareEncodeBytes(dst);
 return softwareByteValue(min(a+(b*(255u-a.w)+uvec4(127u))/255u,uvec4(255u)));
}
vec4 figmaSampleQ8(uvec4 p0,uvec4 p1,uvec4 p2,uvec4 p3,uint wx,uint wy) {
    if(softwareRasterByte()){return softwareByteValue(softwareSampleBytes(p0,p1,p2,p3,wx,wy));}
    uint w0=(256u-wx)*(256u-wy);
    uint w1=wx*(256u-wy);
    uint w2=(256u-wx)*wy;
    uint w3=wx*wy;
    uvec4 sum=p0*w0+p1*w1+p2*w2+p3*w3;
    return vec4(figmaNormalizeQ4((sum.x+2048u)>>12u),figmaNormalizeQ4((sum.y+2048u)>>12u),figmaNormalizeQ4((sum.z+2048u)>>12u),figmaNormalizeQ4((sum.w+2048u)>>12u));
}
uint figmaNormalizedResolveSum(uint sum) {
    uint quotient=sum/4u;
    uint remainder=sum%4u;
    if(remainder!=2u){
        if(remainder>2u){quotient=quotient+1u;}
        return quotient;
    }
    uint odd=2u*quotient+1u;
    if(odd==255u){return 128u;}
    uint shift=(31u-figmaMsb32(odd))%8u;
    uint residue=((odd%255u)<<shift)%255u;
    if(residue>=128u){quotient=quotient+1u;}
    return quotient;
}
vec4 figmaNormalized4(uvec4 sum){
 return vec4(float(figmaNormalizedResolveSum(sum.x)),float(figmaNormalizedResolveSum(sum.y)),float(figmaNormalizedResolveSum(sum.z)),float(figmaNormalizedResolveSum(sum.w)))/255.;
}
uvec4 matPower5(uint m){
 uvec4 value=uvec4(m,0u,0u,0u);
 for(uint n=0u;n<4u;n=n+1u){uint carry=0u;for(uint i=0u;i<4u;i=i+1u){uvec2 p=wideMultiply(value[i],m);uint lo=p.x+carry;carry=p.y+materialSelect(0u,1u,lo<p.x);value[i]=lo;}}
 return value;
}
uint matTop(uvec4 v){if(v.w!=0u){return 96u+highestBit(v.w);}if(v.z!=0u){return 64u+highestBit(v.z);}if(v.y!=0u){return 32u+highestBit(v.y);}return highestBit(v.x);}
uvec4 matNormalize(uvec4 v,uint top){
 uint shift=127u-top;uint words=shift/32u;uint bits=shift%32u;uvec4 result=uvec4(0u);
 for(uint i=0u;i<4u;i=i+1u){if(i>=words){result[i]=v[i-words]<<bits;if(bits!=0u&&i>words){result[i]=result[i]|(v[i-words-1u]>>(32u-bits));}}}return result;
}
int matPowerCompare(uint m,int e,uint alpha){
 if(m==0u){return -1;}uvec4 value=matPower5(m);uint top=matTop(value);uint ae=(alpha>>23u)&255u;uint am=(alpha&0x7fffffu)|materialSelect(0u,0x800000u,ae!=0u);uint atop=highestBit(am);
 int lhs=int(top)+e*5;int rhs=int(atop)+int(max(ae,1u))-150;if(lhs<rhs){return -1;}if(lhs>rhs){return 1;}
 uvec4 p=matNormalize(value,top);uvec4 a=matNormalize(uvec4(am,0u,0u,0u),atop);
 for(int i=3;i>=0;i=i-1){if(p[uint(i)]<a[uint(i)]){return -1;}if(p[uint(i)]>a[uint(i)]){return 1;}}return 0;
}
float materialRoot5(float alpha){
 uint a=floatBitsToUint(alpha);if((a&0x80000000u)!=0u||a==0u){return 0.;}if(a>=0x3f800000u){return 1.;}
 uint lo=0u;uint hi=0x3f800000u;
 for(uint i=0u;i<31u;i=i+1u){if(hi-lo<=1u){break;}uint mid=lo+(hi-lo)/2u;uint e=(mid>>23u)&255u;uint m=(mid&0x7fffffu)|materialSelect(0u,0x800000u,e!=0u);if(matPowerCompare(m,int(max(e,1u))-150,a)<=0){lo=mid;}else{hi=mid;}}
 int e=int((lo>>23u)&255u);uint m=(lo&0x7fffffu)|0x800000u;int cmp=matPowerCompare(2u*m+1u,e-151,a);
 return uintBitsToFloat(lo+materialSelect(0u,1u,cmp<0||(cmp==0&&(lo&1u)!=0u)));
}
uvec2 positiveLeft64(uvec2 v,uint n){
 if(n==0u){return v;}if(n<32u){return uvec2(v.x<<n,(v.y<<n)|(v.x>>(32u-n)));}
 return uvec2(0u,v.x<<(n-32u));
}
uvec2 positiveRightJam64(uvec2 v,uint n){
 if(n==0u){return v;}if(n>=64u){return uvec2(materialSelect(0u,1u,v.x!=0u||v.y!=0u),0u);}
 if(n<32u){return uvec2((v.x>>n)|(v.y<<(32u-n))|materialSelect(0u,1u,(v.x<<(32u-n))!=0u),v.y>>n);}
 if(n==32u){return uvec2(v.y|materialSelect(0u,1u,v.x!=0u),0u);}
 uint k=n-32u;return uvec2((v.y>>k)|materialSelect(0u,1u,v.x!=0u||(v.y<<(32u-k))!=0u),0u);
}
// Single rounding of a*b+c for finite operands with b,c and the result >=0.
// Normalizing both terms to bit 62 leaves room for their sum. Near cancellation
// their alignment is exact (48-bit product); separated terms retain sticky.
// No hardware FMA or compiler contraction is assumed.
float nonnegativeResultFmaRN(float a,float b,float c){
 uint aa=floatBitsToUint(a);uint bb=floatBitsToUint(b);uint cc=floatBitsToUint(c);
 uint ae=(aa>>23u)&255u;uint be=(bb>>23u)&255u;uint ce=(cc>>23u)&255u;
 uint ma=(aa&0x7fffffu)|materialSelect(0u,0x800000u,ae!=0u);
 uint mb=(bb&0x7fffffu)|materialSelect(0u,0x800000u,be!=0u);
 uint mc=(cc&0x7fffffu)|materialSelect(0u,0x800000u,ce!=0u);
 if(ma==0u||mb==0u){return c;}if(mc==0u){return mulRN(a,b);}
 uvec2 product=wideMultiply(ma,mb);
 uint top=highestBit(product.x);if(product.y!=0u){top=32u+highestBit(product.y);}
 uint ctop=highestBit(mc);
 int pe=int(max(ae,1u))+int(max(be,1u))-300+int(top);
 int ve=int(max(ce,1u))-150+int(ctop);int exponent=max(pe,ve);
 uvec2 left=positiveRightJam64(positiveLeft64(product,62u-top),uint(exponent-pe));
 uvec2 right=positiveRightJam64(positiveLeft64(uvec2(mc,0u),62u-ctop),uint(exponent-ve));
 uvec2 sum=add64(left,right);
 if((aa&0x80000000u)!=0u){sum=add64(right,negate64(left));}
 if(sum.x==0u&&sum.y==0u){return 0.;}
 uint last=highestBit(sum.x);if(sum.y!=0u){last=32u+highestBit(sum.y);}
 uvec2 significand=uvec2(0u);
 if(last>=26u){significand=positiveRightJam64(sum,last-26u);}else{significand=positiveLeft64(sum,26u-last);}
 return packRN(0u,significand.x,exponent+int(last)-62+127);
}
// Full signed binary32 fused multiply-add, with exactly one RNE. The two
// integer limbs align the exact 48-bit product and 24-bit addend at bit62.
// Near cancellation their alignment is exact; distant tails retain sticky.
// Finite overflow/underflow and signed zero follow IEEE RNE. NaNs (including
// invalid infinity arithmetic) use canonical positive quiet NaN 0x7fc00000.
// No hardware FMA, float arithmetic fallback or large limb array is used.
float fmaRN(float a,float b,float c){
 uint aa=floatBitsToUint(a);uint bb=floatBitsToUint(b);uint cc=floatBitsToUint(c);
 // Keep this bitcast a runtime expression: WGSL forbids nonfinite const f32.
 uint canonical_nan=0x7fc00000u;
 uint av=aa&0x7fffffffu;uint bv=bb&0x7fffffffu;uint cv=cc&0x7fffffffu;
 uint ps=(aa^bb)&0x80000000u;uint cs=cc&0x80000000u;
 if(av>0x7f800000u||bv>0x7f800000u||cv>0x7f800000u){return uintBitsToFloat(canonical_nan);}
 if(av==0x7f800000u||bv==0x7f800000u){
  if(av==0u||bv==0u||(cv==0x7f800000u&&ps!=cs)){return uintBitsToFloat(canonical_nan);}
  return uintBitsToFloat(ps|0x7f800000u);
 }
 if(cv==0x7f800000u){return c;}
 if(av==0u||bv==0u){if(cv==0u){return uintBitsToFloat(ps&cs);}return c;}
 if(cv==0u){return mulRN(a,b);}
 uint ae=(av>>23u)&255u;uint be=(bv>>23u)&255u;uint ce=(cv>>23u)&255u;
 uint ma=(av&0x7fffffu)|materialSelect(0u,0x800000u,ae!=0u);
 uint mb=(bv&0x7fffffu)|materialSelect(0u,0x800000u,be!=0u);
 uint mc=(cv&0x7fffffu)|materialSelect(0u,0x800000u,ce!=0u);
 uvec2 product=wideMultiply(ma,mb);
 uint top=highestBit(product.x);if(product.y!=0u){top=32u+highestBit(product.y);}
 uint ctop=highestBit(mc);
 int pe=int(max(ae,1u))+int(max(be,1u))-300+int(top);
 int ve=int(max(ce,1u))-150+int(ctop);int exponent=max(pe,ve);
 uvec2 left=positiveRightJam64(positiveLeft64(product,62u-top),uint(exponent-pe));
 uvec2 right=positiveRightJam64(positiveLeft64(uvec2(mc,0u),62u-ctop),uint(exponent-ve));
 uint sign=ps;uvec2 sum=add64(left,right);
 if(ps!=cs){
  if(left.y<right.y||(left.y==right.y&&left.x<right.x)){sum=add64(right,negate64(left));sign=cs;}
  else{sum=add64(left,negate64(right));}
 }
 if(sum.x==0u&&sum.y==0u){return 0.;}
 uint last=highestBit(sum.x);if(sum.y!=0u){last=32u+highestBit(sum.y);}
 uvec2 significand=uvec2(0u);
 if(last>=26u){significand=positiveRightJam64(sum,last-26u);}else{significand=positiveLeft64(sum,26u-last);}
 return packRN(sign,significand.x,exponent+int(last)-62+127);
}
float positiveFmaRN(float a,float b,float c){return nonnegativeResultFmaRN(a,b,c);}
// Constant-color blend is a distinct measured hardware contract from the
// premultiplied source-over path. Export interpolation rounds source-dst,
// then fuses that signed difference with the destination.
float constantColorBlendRN(float source,float destination,float weight){
 return nonnegativeResultFmaRN(addRN(source,-destination),weight,destination);
}
vec4 materialSample(vec2 p,vec2 delta){
 vec2 base=p+floor(delta);vec2 k=delta-floor(delta);
 vec4 a=at(sourceA,base,u[1]);vec4 b=at(sourceA,base+vec2(1,0),u[1]);vec4 c=at(sourceA,base+vec2(0,1),u[1]);vec4 d=at(sourceA,base+vec2(1,1),u[1]);
 if(u[60].x>0.5){return bsBilinear4(a,b,c,d,k,uint(u[63].w),uint(u[63].z));}
 float x=addRN(1.,-k.x);float y=addRN(1.,-k.y);
 vec4 sum=addRN4(vec4(0),mulRN4(a,vec4(mulRN(x,y))));
 sum=addRN4(sum,mulRN4(b,vec4(mulRN(k.x,y))));sum=addRN4(sum,mulRN4(c,vec4(mulRN(x,k.y))));return addRN4(sum,mulRN4(d,vec4(mulRN(k.x,k.y))));
}
// Exact scalar texture-clipping contract; numeric data, never painted pixels.
// Atlas: 1024x1024 RGBA8, little-endian roots in bytes0..16323, followed by
// 4164661 residual bytes, remaining13319 bytes zero. High-major triangular
// pair index; two residual nibbles/byte, low first, decodedCode-5 signed ULPs.
// Each backend uploads the same immutable baseline/residual assets and computes
// the alpha indices and weight itself. See texture_noise/clip-weight-metadata.
uint textureClipReadWord(highp sampler2D math,uint word){
 uvec4 bytes=uvec4(round(texelFetch(math,ivec2(int(word%1024u),int(word/1024u)),0)*255.));
 return bytes.x|(bytes.y<<8u)|(bytes.z<<16u)|(bytes.w<<24u);
}
uint textureClipAlphaIndex(float alpha){
 uint bits=floatBitsToUint(alpha);
 // Unsigned bit order also rejects every negative value, including -0.
 if(bits>0x3f800000u){return 0xffffffffu;}
 uint index=uint(round(mulRN(alpha,4080.)));
 if(index>=4081u){return 0xffffffffu;}
 if(floatBitsToUint(figmaNormalizeQ4(index))!=bits){return 0xffffffffu;}
 return index;
}
float textureClipWeightQ4(highp sampler2D math,uint original,uint displaced){
 if(original>=4081u||displaced>=4081u){uint invalid=0x7fc00000u;return uintBitsToFloat(invalid);}
 uint low=min(original,displaced);uint high=max(original,displaced);
 uint index=high*(high+1u)/2u+low;
 float a=uintBitsToFloat(textureClipReadWord(math,original));
 float b=uintBitsToFloat(textureClipReadWord(math,displaced));
 uint packed=textureClipReadWord(math,4081u+index/8u);
 uint code=(packed>>((index%8u)*4u))&15u;
 return uintBitsToFloat(floatBitsToUint(mulRN(a,b))+code-5u);
}
float textureClipWeight(highp sampler2D math,float original,float displaced){
 // Validate both operands before the zero-alpha case can yield zero.
 uint a=textureClipAlphaIndex(original);uint b=textureClipAlphaIndex(displaced);
 return textureClipWeightQ4(math,a,b);
}
vec4 figmaByteValue(uvec4 bytes){
 if(softwareRasterByte()){return softwareByteValue(bytes);}
 return vec4(figmaNormalizeQ4(bytes.x*16u),figmaNormalizeQ4(bytes.y*16u),figmaNormalizeQ4(bytes.z*16u),figmaNormalizeQ4(bytes.w*16u));
}
uvec4 figmaExportStep(uvec4 previous,vec4 source,float weight){
 if(softwareRasterByte()){return softwareBlendBytes(previous,softwareEncodeBytes(source),softwareEncodeByte(weight));}
 vec4 dst=figmaByteValue(previous);
 vec4 value=clamp(vec4(constantColorBlendRN(source.x,dst.x,weight),constantColorBlendRN(source.y,dst.y,weight),constantColorBlendRN(source.z,dst.z,weight),constantColorBlendRN(source.w,dst.w,weight)),vec4(0),vec4(1));
 return uvec4(figmaEncodeUnorm8(value.x),figmaEncodeUnorm8(value.y),figmaEncodeUnorm8(value.z),figmaEncodeUnorm8(value.w));
}
vec4 figmaFourPass(vec4 a,vec4 b,vec4 c,vec4 d){
 uvec4 result=figmaExportStep(uvec4(0u),d,1.);
 result=figmaExportStep(result,a,0.5);
 result=figmaExportStep(result,c,uintBitsToFloat(0x3eaaaaabu));
 result=figmaExportStep(result,b,0.25);
 return figmaByteValue(result);
}
vec4 figmaQuarterSum(uvec4 sum){
 return vec4(figmaNormalizeQ4(sum.x*4u),figmaNormalizeQ4(sum.y*4u),figmaNormalizeQ4(sum.z*4u),figmaNormalizeQ4(sum.w*4u));
}
vec4 softwareSpatialSample(highp sampler2D tex,vec2 p,vec4 r){
 uvec4 a=softwareEncodeBytes(at(tex,p,r));
 uvec4 b=softwareEncodeBytes(at(tex,p+vec2(1,0),r));
 uvec4 c=softwareEncodeBytes(at(tex,p+vec2(0,1),r));
 uvec4 d=softwareEncodeBytes(at(tex,p+vec2(1,1),r));
 return softwareByteValue(softwareSampleBytes(a,b,c,d,128u,128u));
}
vec4 figmaSpatialResolve(vec2 p){
 if(softwareRasterByte()){
  return figmaFourPass(softwareSpatialSample(sourceA,p,u[1]),softwareSpatialSample(sourceB,p,u[2]),softwareSpatialSample(sourceC,p,u[3]),softwareSpatialSample(sourceD,p,u[1]));
 }
 uvec4 a=uvec4(0u);uvec4 b=uvec4(0u);uvec4 c=uvec4(0u);uvec4 d=uvec4(0u);
 for(uint y=0u;y<2u;y=y+1u){for(uint x=0u;x<2u;x=x+1u){
  vec2 q=p+vec2(float(x),float(y));
  a=a+uvec4(round(at(sourceA,q,u[1])*255.));b=b+uvec4(round(at(sourceB,q,u[2])*255.));
  c=c+uvec4(round(at(sourceC,q,u[3])*255.));d=d+uvec4(round(at(sourceD,q,u[1])*255.));
 }}
 return figmaFourPass(figmaQuarterSum(a),figmaQuarterSum(b),figmaQuarterSum(c),figmaQuarterSum(d));
}
vec4 materialTexture(vec2 p){
 vec2 delta=at(sourceB,p,u[2]).xy;vec4 first=materialSample(p,delta);
 if(u[10].w<0.5){return first;}vec4 original=at(sourceA,p,u[1]);if((floatBitsToUint(original.a)&0x7fffffffu)==0u){return vec4(0);}
 float weight=mulRN(materialRoot5(original.a),materialRoot5(first.a));
 vec4 shifted=materialSample(p,vec2(mulRN(delta.x,weight),mulRN(delta.y,weight)));
 if(shifted.a>0.){return shifted;}return original;
}
vec4 linearTextureTexel(ivec2 q){
 if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,ivec2(u[1].zw)))){return vec4(0);}
 return texelFetch(sourceA,q,0);
}
vec4 linearTexture(vec2 p){
 vec4 grid=at(sourceB,p,u[2]);ivec2 q=ivec2(grid.xy);
 return bsBilinear4(linearTextureTexel(q),linearTextureTexel(q+ivec2(1,0)),linearTextureTexel(q+ivec2(0,1)),linearTextureTexel(q+ivec2(1,1)),grid.zw,uint(u[63].w),uint(u[63].z));
}
float linearDistance(vec2 p){
 vec2 q=decodePoint(at(sourceB,p,u[2]));
 if(q.x<0.){return 1000000.;}
 float x=addRN(addRN(addRN(p.x,-u[2].x),-0.5),-q.x);
 float y=addRN(addRN(addRN(p.y,-u[2].y),-0.5),-q.y);
 return sqrtRN(addRN(mulRN(x,x),mulRN(y,y)));
}
vec4 linearGlass(vec2 p){
 float d=linearDistance(p);
 float gx=addRN(linearDistance(p+vec2(1,0)),-linearDistance(p-vec2(1,0)));
 float gy=addRN(linearDistance(p+vec2(0,1)),-linearDistance(p-vec2(0,1)));
 float len=max(sqrtRN(addRN(mulRN(gx,gx),mulRN(gy,gy))),1e-5);
 float factor=clamp(addRN(1.,-divideRN(d,max(u[9].x,4.))),0.,1.);
 float dx=mulRN(mulRN(mulRN(divideRN(gx,len),u[9].y),factor),factor);
 float dy=mulRN(mulRN(mulRN(divideRN(gy,len),u[9].y),factor),factor);
 vec2 samplePoint=vec2(addRN(p.x,dx),addRN(p.y,dy));
 float highlight=clamp(mulRN(mulRN(mulRN(divideRN(abs(addRN(gx,-gy)),len),factor),u[9].z),0.25),0.,1.);
 vec4 result=over(smp(sourceA,samplePoint,u[1]),vec4(highlight),0);
 if(u[9].w>0.5){return result;}
 return mulRN4(result,vec4(at(sourceC,p,u[3]).a));
}
vec4 materialOver(vec4 b,vec4 s){
 if((floatBitsToUint(s.a)&0x7fffffffu)==0u){return b;}if((floatBitsToUint(b.a)&0x7fffffffu)==0u){return s;}
 return addRN4(s,mulRN4(b,vec4(addRN(1.,-s.a))));
}
// The capture target is an independent RGBA8 image. Its sampler clamps to
// texel edges and rounds fractions to Q8 before Q4 channel normalization.
vec4 captureSample(vec2 p){
 vec2 q=p-vec2(0.5);ivec2 base=ivec2(floor(q));ivec2 last=ivec2(u[1].zw)-ivec2(1);
 uvec4 a=uvec4(round(texelFetch(sourceA,clamp(base,ivec2(0),last),0)*255.));
 uvec4 b=uvec4(round(texelFetch(sourceA,clamp(base+ivec2(1,0),ivec2(0),last),0)*255.));
 uvec4 c=uvec4(round(texelFetch(sourceA,clamp(base+ivec2(0,1),ivec2(0),last),0)*255.));
 uvec4 d=uvec4(round(texelFetch(sourceA,clamp(base+ivec2(1,1),ivec2(0),last),0)*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(q.x-floor(q.x)),figmaFractionQ8(q.y-floor(q.y)));
}
vec4 captureEncode(vec4 value){
 if(softwareRasterByte()){return softwareByteValue(softwareEncodeBytes(value));}
 vec4 v=clamp(value,vec4(0),vec4(1));
 return vec4(float(figmaEncodeUnorm8(v.x)),float(figmaEncodeUnorm8(v.y)),float(figmaEncodeUnorm8(v.z)),float(figmaEncodeUnorm8(v.w)))/255.;
}
// Texture capture attachments use normalized UV with clamped Q8 fractions.
// Keep the Q4 result in float until the destination's one UNORM8 store.
vec4 textureCaptureSample(highp sampler2D tex,vec2 uv,vec2 size){
 vec2 bounded=clamp(uv,vec2(0),vec2(1));
 vec2 q=max(vec2(0),vec2(addRN(mulRN(bounded.x,size.x),-0.5),addRN(mulRN(bounded.y,size.y),-0.5)));
 ivec2 base=ivec2(floor(q));ivec2 last=ivec2(size)-ivec2(1);
 uvec4 a=uvec4(round(texelFetch(tex,clamp(base,ivec2(0),last),0)*255.));
 uvec4 b=uvec4(round(texelFetch(tex,clamp(base+ivec2(1,0),ivec2(0),last),0)*255.));
 uvec4 c=uvec4(round(texelFetch(tex,clamp(base+ivec2(0,1),ivec2(0),last),0)*255.));
 uvec4 d=uvec4(round(texelFetch(tex,clamp(base+ivec2(1,1),ivec2(0),last),0)*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(q.x,-floor(q.x))),figmaFractionQ8(addRN(q.y,-floor(q.y))));
}
vec2 textureForwardUV(vec2 moved){
 vec2 centered=vec2(addRN(fmaRN(moved.x,u[10].x,-0.5),u[10].z),addRN(fmaRN(moved.y,u[11].x,-0.5),u[11].y));
 if(u[9].y>0.5){centered=vec2(fmaRN(moved.x,u[10].x,addRN(u[10].z,-0.5)),fmaRN(moved.y,u[11].x,addRN(u[11].y,-0.5)));}
 return vec2(fmaRN(centered.x,u[9].x,0.5),fmaRN(centered.y,u[9].x,0.5));
}
vec4 textureReplayEffect(vec2 p){
 vec4 field=at(sourceC,p,u[3]);
 vec2 moved=vec2(addRN(field.x,field.z),addRN(field.y,field.w));
 vec4 first=textureCaptureSample(sourceA,textureForwardUV(moved),u[1].zw);
 if(u[9].y<0.5){return captureEncode(first);}
 vec2 uv=vec2(divideRN(p.x,u[9].w),divideRN(p.y,u[9].w));
 vec4 original=vec4(0);
 if(u[9].z>0.5){original=textureCaptureSample(sourceB,uv,u[2].zw);}else{
  vec2 expanded=vec2(fmaRN(addRN(uv.x,-0.5),u[9].x,0.5),fmaRN(addRN(uv.y,-0.5),u[9].x,0.5));
  original=textureCaptureSample(sourceA,expanded,u[1].zw);
 }
 float weight=textureClipWeight(sourceD,original.a,first.a);
 vec2 adjustedNode=vec2(fmaRN(field.z,weight,field.x),fmaRN(field.w,weight,field.y));
 vec4 adjusted=textureCaptureSample(sourceA,textureForwardUV(adjustedNode),u[1].zw);
 if(original.a>0.&&adjusted.a>0.){return captureEncode(adjusted);}return captureEncode(original);
}
vec4 textureReplayCopyback(vec2 p){
 vec4 field=at(sourceB,p,u[2]);vec4 source=textureCaptureSample(sourceA,field.xy,u[1].zw);
 if(u[4].w>0.5){return mulRN4(source,vec4(at(sourceC,p,u[3]).a));}return source;
}
vec4 textureReplaySource(vec2 p){
 vec4 field=at(sourceB,p,u[2]);
 float coordinate=clamp(addRN(mulRN(clamp(field.x,0.,1.),1024.),-0.5),0.,1023.);
 int left=int(floor(coordinate));int right=min(left+1,1023);
 uvec4 a=uvec4(round(texelFetch(sourceA,ivec2(left,0),0)*255.));
 uvec4 b=uvec4(round(texelFetch(sourceA,ivec2(right,0),0)*255.));
 uvec4 c=uvec4(round(texelFetch(sourceA,ivec2(left,1),0)*255.));
 uvec4 d=uvec4(round(texelFetch(sourceA,ivec2(right,1),0)*255.));
 vec4 color=mulRN4(figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(coordinate,-float(left))),1u),vec4(u[8].x));
 if(color.a==0.){return vec4(0);}vec4 source=min(abs(addRN4(color,vec4(field.y))),vec4(1));
 if(color.a==1.){source.a=1.;}return captureEncode(source);
}
vec4 captureDownscale(vec2 p){
 vec2 uv=vec2(fmaRN(addRN(p.x,-u[9].x),u[9].z,u[10].x),fmaRN(addRN(p.y,-u[9].y),u[9].w,u[10].y));
 return captureEncode(captureSample(vec2(mulRN(uv.x,u[1].z),mulRN(uv.y,u[1].w))));
}
vec4 measuredGradientOver(vec2 p){
 vec4 dst=at(sourceA,p,u[1]);float coverage=at(sourceB,p,u[2]).a;
 if(coverage<=0.){return dst;}vec4 field=at(sourceD,p,u[13]);
 float coordinate=clamp(addRN(mulRN(clamp(field.x,0.,1.),1024.),-0.5),0.,1023.);
 int left=int(floor(coordinate));int right=min(left+1,1023);
 uvec4 a=uvec4(round(texelFetch(sourceC,ivec2(left,0),0)*255.));
 uvec4 b=uvec4(round(texelFetch(sourceC,ivec2(right,0),0)*255.));
 uvec4 c=uvec4(round(texelFetch(sourceC,ivec2(left,1),0)*255.));
 uvec4 d=uvec4(round(texelFetch(sourceC,ivec2(right,1),0)*255.));
 vec4 color=mulRN4(figmaSampleQ8(a,b,c,d,figmaFractionQ8(addRN(coordinate,-float(left))),1u),vec4(u[8].x));
 if(color.a==0.){return dst;}
 vec4 source=min(abs(addRN4(color,vec4(field.y))),vec4(1));
 if(color.a==1.){source.a=1.;}source=mulRN4(source,vec4(coverage));float factor=addRN(1.,-source.a);
 if(softwareRasterByte()){return softwareOver(dst,source);}
 return captureEncode(vec4(positiveFmaRN(dst.x,factor,source.x),positiveFmaRN(dst.y,factor,source.y),positiveFmaRN(dst.z,factor,source.z),positiveFmaRN(dst.w,factor,source.w)));
}
vec4 captureTriangle(vec2 p){
 float count=u[9].x;uint axis=uint(u[9].y);
 vec4 sum=mulRN4(captureSample(p),vec4(count));float weight=count;
 for(uint k=1u;k<uint(u[9].z);k=k+2u){
  if(float(k)>count){break;}float a=float(k);float b=min(float(k+1u),count);
  float wa=addRN(count,-a);float wb=addRN(count,-b);float pair=addRN(wa,wb);
  if(pair==0.){continue;}
  vec2 left=p;vec2 right=p;
  float size=u[1][axis+2u];float step=divideRN(1.,size);float uv=divideRN(p[axis],size);
  left[axis]=mulRN(divideRN(addRN(mulRN(addRN(uv,-mulRN(step,a)),wa),mulRN(addRN(uv,-mulRN(step,b)),wb)),pair),size);
  right[axis]=mulRN(divideRN(addRN(mulRN(addRN(uv,mulRN(step,a)),wa),mulRN(addRN(uv,mulRN(step,b)),wb)),pair),size);
  vec4 value=addRN4(captureSample(left),captureSample(right));
  sum=vec4(positiveFmaRN(value.x,pair,sum.x),positiveFmaRN(value.y,pair,sum.y),positiveFmaRN(value.z,pair,sum.z),positiveFmaRN(value.w,pair,sum.w));
  weight=addRN(weight,mulRN(2.,pair));
 }
 return captureEncode(mulRN4(sum,vec4(divideRN(1.,weight))));
}
vec4 opticalRay(vec2 p,vec2 delta,float factor){
 if(BYTE_SURFACE&&u[12].x>0.5){
  vec2 point=vec2(addRN(p.x,mulRN(delta.x,factor)),addRN(p.y,mulRN(delta.y,factor)));
  vec2 centered=vec2(addRN(mulRN(addRN(point.x,-u[12].y),0.001953125),-0.5),addRN(mulRN(addRN(point.y,-u[12].z),0.001953125),-0.5));
  float density=mulRN(u[12].w,0.5);
  vec2 coordinate=vec2(mulRN(fmaRN(centered.x,density,0.5),u[1].z),mulRN(fmaRN(centered.y,density,0.5),u[1].w));
  return captureSample(coordinate);
 }
 vec2 offset=vec2(addRN(u[11].x,mulRN(delta.x,factor)),addRN(u[11].y,mulRN(delta.y,factor)));
 if(!BYTE_SURFACE){return materialSample(p,offset);}
 vec2 base=p+floor(offset);vec2 k=offset-floor(offset);
 uvec4 a=uvec4(round(at(sourceA,base,u[1])*255.));
 uvec4 b=uvec4(round(at(sourceA,base+vec2(1,0),u[1])*255.));
 uvec4 c=uvec4(round(at(sourceA,base+vec2(0,1),u[1])*255.));
 uvec4 d=uvec4(round(at(sourceA,base+vec2(1,1),u[1])*255.));
 return figmaSampleQ8(a,b,c,d,figmaFractionQ8(k.x),figmaFractionQ8(k.y));
}
vec2 opticalRayChannelAlpha(vec2 p,vec2 delta,float factor,uint channel){
 vec2 offset=vec2(addRN(u[11].x,mulRN(delta.x,factor)),addRN(u[11].y,mulRN(delta.y,factor)));
 vec2 base=p+floor(offset);vec2 k=offset-floor(offset);
 return bsBilinearChannelAlpha(at(sourceA,base,u[1]),at(sourceA,base+vec2(1,0),u[1]),at(sourceA,base+vec2(0,1),u[1]),at(sourceA,base+vec2(1,1),u[1]),k,channel,uint(u[63].w),uint(u[63].z));
}
vec4 analyticGlass(vec2 p){
 // Explicit caller contract: immediate same-pixel mode-3 masked composition.
 // Its zero-alpha source returns the destination before source RGB is used.
 // Do not apply to arbitrary unmasked or masked optical outputs.
 if(!BYTE_SURFACE && u[10].y>0.5 && at(sourceC,p,u[3]).a==0.){return vec4(0);}
 vec4 field=at(sourceB,p,u[2]);if(!BYTE_SURFACE&&u[12].x==2.){field=u[13];}float dispersion=u[10].x;
 bool capturedSpectrum=BYTE_SURFACE&&u[12].x>0.5;
 // Flat interior: finite nonnegative ray factors all multiply the exact
 // zero displacement to the same offset. Keep every weighted accumulation.
 bool sameRay=!BYTE_SURFACE&&all(equal((floatBitsToUint(field.xy)&uvec2(0x7fffffffu)),uvec2(0u)))&&dispersion>=0.&&dispersion<=1.&&u[11].z==3.&&u[11].w==8.&&all(lessThanEqual((floatBitsToUint(u[11].xy)&uvec2(0x7fffffffu)),uvec2(0x7f7fffffu)))&&all(notEqual(floatBitsToUint(u[11].xy),uvec2(0x80000000u)));
 vec4 sharedRay=vec4(0);if(dispersion<0.001||sameRay){sharedRay=opticalRay(p,field.xy,1.);}
 vec4 result=vec4(0);
 if(dispersion<0.001){result=sharedRay;}else{
  float weights=0.;
  // Keep the eight-ray loop dynamic so Metal does not duplicate the complete
  // exact HDR sampler for every tap during pipeline compilation.
  for(uint tap=0u;tap<uint(u[11].w);tap=tap+1u){
   float t=0.;
   if(capturedSpectrum){t=fmaRN(float(tap),0.14285715,-0.5);}else{t=addRN(mulRN(float(tap),0.14285715),-0.5);}
   float weight=addRN(1.,-abs(mulRN(t,2.)));
   vec4 value=sharedRay;
   if(!sameRay){value=vec4(0);
   // One call site for the exact HDR sampler, also kept dynamic. Three copies
   // of its integer accumulator substantially inflate first-use compilation.
   for(uint channel=0u;channel<uint(u[11].z);channel=channel+1u){
    float phase=addRN(t,addRN(0.5,-mulRN(float(channel),0.5)));
    if(BYTE_SURFACE){
     vec4 ray=opticalRay(p,field.xy,addRN(1.,mulRN(phase,dispersion)));
     value[channel]=ray[channel];value.w=max(value.w,ray.w);
    }else{
     vec2 ray=opticalRayChannelAlpha(p,field.xy,addRN(1.,mulRN(phase,dispersion)),channel);
     value[channel]=ray.x;value.w=max(value.w,ray.y);
    }
   }
   }
   if(capturedSpectrum){
    result=vec4(fmaRN(value.x,weight,result.x),fmaRN(value.y,weight,result.y),fmaRN(value.z,weight,result.z),fmaRN(value.w,weight,result.w));
   }else{result=addRN4(result,mulRN4(value,vec4(weight)));}
   weights=addRN(weights,weight);
  }
  if(capturedSpectrum){result=mulRN4(result,vec4(divideRN(1.,weights)));}else{
   result=vec4(divideRN(result.x,weights),divideRN(result.y,weights),divideRN(result.z,weights),divideRN(result.w,weights));
  }
 }
 result=addRN4(result,vec4(field.z,field.z,field.z,0));
 if(softwareRasterByte()){
  result=softwareByteValue(softwareEncodeBytes(result));
  if(u[9].w>0.5){return result;}return mulRN4(result,vec4(at(sourceC,p,u[3]).a));
 }
 if(BYTE_SURFACE){
  result=clamp(result,vec4(0),vec4(1));
  result=vec4(float(figmaEncodeUnorm8(result.x)),float(figmaEncodeUnorm8(result.y)),float(figmaEncodeUnorm8(result.z)),float(figmaEncodeUnorm8(result.w)))/255.;
 }
 if(u[9].w>0.5){return result;}return mulRN4(result,vec4(at(sourceC,p,u[3]).a));
}
vec4 solidPaintOver(vec2 p){
 vec4 dst=at(sourceA,p,u[1]);float coverage=at(sourceB,p,u[2]).a;
 if(coverage==0.){return dst;}
 vec4 src=mulRN4(u[7],vec4(coverage));float factor=addRN(1.,-src.a);
 if(softwareRasterByte()){return softwareOver(dst,src);}
 vec4 blended=clamp(vec4(positiveFmaRN(dst.x,factor,src.x),positiveFmaRN(dst.y,factor,src.y),positiveFmaRN(dst.z,factor,src.z),positiveFmaRN(dst.w,factor,src.w)),vec4(0),vec4(1));
 return vec4(float(figmaEncodeUnorm8(blended.x)),float(figmaEncodeUnorm8(blended.y)),float(figmaEncodeUnorm8(blended.z)),float(figmaEncodeUnorm8(blended.w)))/255.;
}
vec4 materialGlass(vec2 p){
 float d=linearDistance(p);float gx=addRN(linearDistance(p+vec2(1,0)),-linearDistance(p-vec2(1,0)));float gy=addRN(linearDistance(p+vec2(0,1)),-linearDistance(p-vec2(0,1)));
 float len=max(sqrtRN(addRN(mulRN(gx,gx),mulRN(gy,gy))),1e-5);float nx=divideRN(gx,len);float ny=divideRN(gy,len);
 float edge=clamp(addRN(1.,-divideRN(d,max(u[9].x,1e-5))),0.,1.);float nz=sqrtRN(max(addRN(1.,-mulRN(edge,edge)),0.));float eta=divideRN(1.,addRN(1.,u[9].y));
 float transmitted=sqrtRN(max(addRN(1.,-mulRN(mulRN(eta,eta),mulRN(edge,edge))),1e-10));float bend=0.;if(u[9].y!=0.){bend=addRN(edge,-divideRN(mulRN(mulRN(eta,edge),nz),transmitted));}
 float shift=mulRN(mulRN(u[9].x,u[9].y),bend);float spread=mulRN(mulRN(mulRN(mulRN(u[9].x,u[10].x),edge),edge),0.125);
 float red=addRN(shift,-spread);float blue=addRN(shift,spread);
 vec4 r=materialSample(p,vec2(mulRN(nx,red),mulRN(ny,red)));vec4 g=materialSample(p,vec2(mulRN(nx,shift),mulRN(ny,shift)));vec4 b=materialSample(p,vec2(mulRN(nx,blue),mulRN(ny,blue)));
 vec4 result=vec4(r.x,g.y,b.z,uintBitsToFloat(max(max(floatBitsToUint(r.a),floatBitsToUint(g.a)),floatBitsToUint(b.a))));
 float dot=addRN(mulRN(nx,u[10].y),mulRN(ny,u[10].z));
 float tint=mulRN(mulRN(mulRN(mulRN(dot,u[9].z),edge),edge),0.125);
 if(tint<0.){result=materialOver(result,vec4(0,0,0,-tint));}else{result=materialOver(result,vec4(tint));}
 float rim=clamp(addRN(1.,-divideRN(max(addRN(d,-0.5),0.),mulRN(u[11].x,0.9375))),0.,1.);
 float angular=mulRN(abs(dot),sqrtRN(abs(dot)));
 float highlight=clamp(mulRN(mulRN(mulRN(u[9].z,angular),addRN(2.,-mulRN(0.5,dot))),rim),0.,1.);
 result=materialOver(result,vec4(highlight));
 if(u[9].w>0.5){return result;}return mulRN4(result,vec4(at(sourceC,p,u[3]).a));
}
// SDR pixel preview has an explicit straight-RGBA8 source boundary. Recreate
// that byte contract on the GPU before its Q12 area filter, including hidden
// RGB on nearest sampling. The return is straight RGBA for readback and
// premultiplied only for presentation (u[4].y).
uint previewByteRound(float value){
 float scaled=mulRN(clamp(value,0.,1.),255.);float q=floor(scaled);
 return uint(q)+materialSelect(0u,1u,addRN(scaled,-q)>=0.5);
}
uvec4 previewStraightBytes(vec4 value){
 uvec4 bytes=uvec4(0);bytes.w=previewByteRound(value.w);
 if(value.w>1e-10){for(uint c=0u;c<3u;c=c+1u){bytes[c]=previewByteRound(divideRN(value[c],value.w));}}
 return bytes;
}
uint previewCDF(float edge,float lo,float scale){return uint(round(mulRN(clamp(mulRN(addRN(edge,-lo),scale),0.,1.),4096.)));}
vec4 bytePreview(vec2 point){
 float scale=u[9].z;vec2 q=vec2(divideRN(addRN(point.x,-u[9].x),scale),divideRN(addRN(point.y,-u[9].y),scale));
 uvec4 bytes=uvec4(0);
 if(scale>=1.){bytes=previewStraightBytes(at(sourceA,floor(q)+0.5,u[1]));}
 else{
  vec2 lo=vec2(divideRN(addRN(addRN(point.x,-0.5),-u[9].x),scale),divideRN(addRN(addRN(point.y,-0.5),-u[9].y),scale));
  vec2 hi=vec2(divideRN(addRN(addRN(point.x,0.5),-u[9].x),scale),divideRN(addRN(addRN(point.y,0.5),-u[9].y),scale));
  uvec4 total=uvec4(0);
  for(int y=int(floor(lo.y));y<int(ceil(hi.y));y=y+1){for(int x=int(floor(lo.x));x<int(ceil(hi.x));x=x+1){
   uint wx=previewCDF(float(x+1),lo.x,scale)-previewCDF(float(x),lo.x,scale);
   uint wy=previewCDF(float(y+1),lo.y,scale)-previewCDF(float(y),lo.y,scale);
   uvec4 pixel=previewStraightBytes(at(sourceA,vec2(float(x)+0.5,float(y)+0.5),u[1]));
   for(uint c=0u;c<3u;c=c+1u){total[c]=total[c]+((pixel[c]*pixel.w+127u)/255u)*wx*wy;}
   total.w=total.w+pixel.w*wx*wy;
  }}
  for(uint c=0u;c<4u;c=c+1u){uint whole=total[c]>>24u;uint tail=total[c]&0xffffffu;bytes[c]=whole+materialSelect(0u,1u,tail>0x800000u||(tail==0x800000u&&(whole&1u)!=0u));}
  if(bytes.w==0u){bytes=uvec4(0);}else{for(uint c=0u;c<3u;c=c+1u){bytes[c]=min(255u,(bytes[c]*510u+bytes.w)/(bytes.w*2u));}}
 }
 vec4 result=vec4(bytes)/255.;
 if(u[4].y>0.5){for(uint c=0u;c<3u;c=c+1u){result[c]=mulRN(result[c],result.w);}}
 return result;
}
// Image addresses are compiled from the same binary64 transforms as CPU
// sampling. This field carries no colors; the GPU fetches its own source image.
vec4 linearImageTexel(ivec2 q){
 if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,ivec2(u[2].zw)))){return vec4(0);}
 return texelFetch(sourceB,q,0);
}
// W=1 identifies two independent coordinate rows; general affine fields
// retain the dense address layout. Both carry metadata only, never colours.
vec4 byteImageAddress(vec2 p){
 ivec2 pixel=ivec2(floor(p-u[0].xy));
 if(texelFetch(sourceD,ivec2(0),0).w>0.5){
  vec4 x=texelFetch(sourceD,ivec2(pixel.x,0),0);
  vec4 y=texelFetch(sourceD,ivec2(pixel.y,1),0);
  return vec4(x.x,y.x,x.z*y.z,1.);
 }
 return texelFetch(sourceD,pixel,0);
}
vec4 linearImage(vec2 p){
 vec4 grid=texelFetch(sourceD,ivec2(floor(p-u[0].xy)),0);ivec2 q=ivec2(grid.xy);
 return bsBilinear4(linearImageTexel(q),linearImageTexel(q+ivec2(1,0)),linearImageTexel(q+ivec2(0,1)),linearImageTexel(q+ivec2(1,1)),grid.zw,uint(u[63].w),uint(u[63].z));
}
vec4 gradientStop(uint index){
 if(u[8].w>32.){return texelFetch(sourceB,ivec2(int(index),0),0);}
 return u[13u+index];
}
float gradientStopAlpha(uint index){
 if(u[8].w>32.){return texelFetch(sourceB,ivec2(int(index),1),0).x;}
 return u[52u+index/4u][index%4u];
}
vec4 linearGradientStop(uint index){
 vec4 color=gradientStop(index);float alpha=gradientStopAlpha(index);
 return mulRN4(vec4(color.yzw,1.),vec4(alpha));
}
vec4 linearGradient(vec2 p){
 vec4 grid=texelFetch(sourceD,ivec2(floor(p-u[0].xy)),0);
 if(grid.x<0.){return mulRN4(vec4(u[7].yzw,1.),vec4(u[60].y));}
 vec4 left=linearGradientStop(uint(grid.x));
 if(grid.x==grid.y){return left;}
 vec4 right=linearGradientStop(uint(grid.y));
 return addRN4(left,mulRN4(addRN4(right,-left),vec4(grid.z)));
}
// END GENERATED MATERIAL MATH

uniform highp sampler2D sourceCurves;
vec4 curveData(int i){ivec2 size=textureSize(sourceCurves,0);return texelFetch(sourceCurves,ivec2(i%size.x,i/size.x),0);}
vec2 curvePoint(int kind,vec4 a,vec4 b,float t){if(kind==2)return a.xy+a.zw*cos(t)+b.xy*sin(t);vec2 ab=mix(a.xy,a.zw,t),bc=mix(a.zw,b.xy,t),cd=mix(b.xy,b.zw,t);return mix(mix(ab,bc,t),mix(bc,cd,t),t);}
int windingFor(vec2 point,vec2 span,vec2 bands){int winding=0,first=int(span.x),count=int(span.y);if(bands.y>0.){vec4 band=curveData(int(bands.x)+int(clamp(floor(point.y/16.),0.,bands.y-1.)));first=int(band.x);count=int(band.y);}for(int i=0;i<count;i++){int base=first+i*4;if(bands.y>0.)base=int(curveData(first+i/4)[i%4]);vec4 segmentInfo=curveData(base),a=curveData(base+1),b=curveData(base+2),range=curveData(base+3);if(point.y<range.z||point.y>=range.w)continue;float x;int kind=int(segmentInfo.x);
if(kind==0){float dy=a.w-a.y,side=(a.z-a.x)*(point.y-a.y)-(point.x-a.x)*dy;if((dy>0.&&side>0.)||(dy<0.&&side<0.))winding+=int(segmentInfo.y);continue;}else{float lo=0.,hi=1.;for(int n=0;n<26;n++){float mid=(lo+hi)*.5;vec2 q=curvePoint(kind,a,b,mix(range.x,range.y,mid));if((q.y<point.y)==(segmentInfo.y>0.))lo=mid;else hi=mid;}x=curvePoint(kind,a,b,mix(range.x,range.y,(lo+hi)*.5)).x;}if(x>point.x)winding+=int(segmentInfo.y);}return winding;}
int windingAt(vec2 point){return windingFor(point,u[9].xy,u[10].xy);}
vec4 curveMask(vec2 p){vec2 offsets[4]=vec2[4](vec2(.375,.125),vec2(.875,.375),vec2(.125,.625),vec2(.625,.875));if(u[9].w>0.){int index=int(u[9].w)-1;int w=windingAt(p-u[0].xy-.5+offsets[index]);return vec4((u[9].z>.5?abs(w)%2!=0:w!=0)?1.:0.);}float samples=0.;for(int i=0;i<4;i++){int w=windingAt(p-u[0].xy-.5+offsets[i]);bool inside=u[9].z>.5?abs(w)%2!=0:w!=0;if(inside)samples+=1.;}return u[60].x>.5?vec4(samples*.25):vec4(roundEven(samples*63.75)/255.);}
float tentWeight(float radius,float x){
 // Integrated adjacent-pixel overlap is r/6; avoid (1+r)-1 and r*r.
 if(radius<=1.){if(x==0.)return 1.-radius/3.;if(x==1.)return divideRN(radius,6.);return 0.;}
 if(x==0.)return (radius-1./3.)/(radius*radius);
 if(x+1.<=radius)return (radius-x)/(radius*radius);
 float a=max(radius+1.-x,0.),b=max(radius-x,0.);
 return (a*a*a-2.*b*b*b)/(6.*radius*radius);
}
vec4 blurAt(vec2 p){vec2 q=u[9].z>.5?clamp(p,u[1].xy+.5,u[1].xy+u[1].zw-.5):p;return at(sourceA,q,u[1]);}
vec4 tentInteger(vec2 p,vec2 axis,int radius){
 uvec4 total=uvec4(0);uint denominator=uint(6*radius*radius);
 for(int i=-radius;i<=radius;i++){int d=abs(i);uint numerator=d==0?uint(6*radius-2):d<radius?uint(6*(radius-d)):1u;
  total+=uvec4(roundEven(blurAt(p+axis*float(i))*255.))*numerator;
 }
 uvec4 quotient=total/denominator,remainder=total-quotient*denominator;
 for(int c=0;c<4;c++)if(remainder[c]*2u>denominator||(remainder[c]*2u==denominator&&(quotient[c]&1u)!=0u))quotient[c]++;
 return vec4(quotient)/255.;
}
vec4 fourBytes(sampler2D tex,vec2 p,vec4 r){return roundEven(at(tex,p,r)*255.)+roundEven(at(tex,p+vec2(1,0),r)*255.)+roundEven(at(tex,p+vec2(0,1),r)*255.)+roundEven(at(tex,p+vec2(1,1),r)*255.);}
vec4 resolveFour(vec4 sum,sampler2D tex,vec2 p,vec4 r){for(int y=0;y<2;y++){for(int x=0;x<2;x++){sum=addRN4(sum,mulRN4(at(tex,p+vec2(x,y),r),vec4(.0625)));}}return sum;}
vec4 shade(vec2 p){
 int mode=COMPOSITOR_MODE;if(BYTE_SURFACE&&mode==43)return textureReplayEffect(p);if(BYTE_SURFACE&&mode==44)return textureReplayCopyback(p);if(BYTE_SURFACE&&mode==45)return textureReplaySource(p);if(BYTE_SURFACE&&mode==42)return measuredGradientOver(p);if(BYTE_SURFACE&&mode==40)return captureDownscale(p);if(BYTE_SURFACE&&mode==41)return captureTriangle(p);if(BYTE_SURFACE&&mode==36)return figmaFourPass(at(sourceA,p,u[1]),at(sourceB,p,u[2]),at(sourceC,p,u[3]),at(sourceD,p,u[1]));if(BYTE_SURFACE&&mode==35)return solidPaintOver(p);if(mode==34)return analyticGlass(p);if(mode==33)return bytePreview(p);if(mode==46)return gradientBlurComposite(p);if(mode==8&&u[10].z>.5)return materialTexture(p);if(mode==11&&u[10].w>.5)return materialGlass(p);vec4 a=smp(sourceA,p,u[1]);
 if(u[60].x>.5){
  if(mode==3||mode==15){float opacity=u[4].z;if(u[4].w>.5)opacity=mulRN(opacity,at(sourceC,p,u[3]).a);vec4 src=mulRN4(a,vec4(opacity));if(mode==15)return src;return over(smp(sourceB,p,u[2]),src,int(u[4].y));}
  if(mode==8){return linearTexture(p);}
  if(mode==11){return linearGlass(p);}
  if(mode==23)return meanFourRN(at(sourceA,p,u[1]),at(sourceB,p,u[2]),at(sourceC,p,u[3]),at(sourceD,p,u[1]));
  if(mode==26)return meanFourRN(smp(sourceA,p,u[1]),smp(sourceB,p,u[2]),smp(sourceC,p,u[3]),smp(sourceD,p,u[1]));
  if(mode==24){vec2 q=(p-u[9].xy)/u[9].z-.5;vec4 sum=vec4(0);sum=resolveFour(sum,sourceA,q,u[1]);sum=resolveFour(sum,sourceB,q,u[2]);sum=resolveFour(sum,sourceC,q,u[3]);return resolveFour(sum,sourceD,q,u[1]);}
  if(mode==25){float opacity=u[4].z;if(u[4].w>.5)opacity=mulRN(opacity,at(sourceC,p,u[3]).a);vec4 src=mulRN4(a,vec4(opacity)),dst=smp(sourceB,p,u[2]);float coverage=mulRN(at(sourceD,p,u[47]).a,opacity);float extra=max(0.,addRN(coverage,-src.a));return addRN4(over(dst,src,int(u[4].y)),-mulRN4(dst,vec4(extra)));}
  if(mode==22){vec2 axis=u[9].y<.5?vec2(1,0):vec2(0,1);return rationalBlur(p,axis);}
  if(mode==21){vec2 q=(p-u[9].xy)/u[9].z-.5;return (at(sourceA,q,u[1])+at(sourceA,q+vec2(1,0),u[1])+at(sourceA,q+vec2(0,1),u[1])+at(sourceA,q+vec2(1,1),u[1]))*.25;}
  if(mode==27)return smp(sourceA,clamp(p,u[1].xy+.5,u[1].xy+u[1].zw-.5),u[1]);
  if(mode==29||mode==28){vec4 dst=smp(sourceB,p,u[2]);if(mode==28&&(any(lessThan(p,u[1].xy))||any(greaterThanEqual(p,u[1].xy+u[1].zw))))return dst;float opacity=u[4].z;if(u[4].w>.5)opacity*=at(sourceC,p,u[3]).a;return mode==28?addRN4(mulRN4(dst,vec4(addRN(1.,-opacity))),mulRN4(a,vec4(opacity))):over(dst,mulRN4(a,vec4(opacity)),0);}
  if(mode==6){float b=smp(sourceB,p-u[9].yz,u[2]).a;float coverage=u[9].w>.5?mulRN(a.a,addRN(1.,-b)):b;return mulRN4(mulRN4(vec4(u[7].yzw,1.),vec4(u[8].x)),vec4(coverage));}
  if(mode==18){float scale=u[9].z;vec2 q=(p-u[9].xy)/scale;if(scale>=1.)return at(sourceA,floor(q)+.5,u[1]);vec2 lo=(p-.5-u[9].xy)/scale,hi=(p+.5-u[9].xy)/scale;vec4 total=vec4(0);for(int y=int(floor(lo.y));y<int(ceil(hi.y));y++){for(int x=int(floor(lo.x));x<int(ceil(hi.x));x++){vec2 cell=vec2(x,y),w=max(vec2(0),min(hi,cell+1.)-max(lo,cell))*scale;total+=at(sourceA,cell+.5,u[1])*w.x*w.y;}}return total;}
 }

 if(mode==22){float radius=u[9].x;int reach=int(ceil(radius));vec2 axis=u[9].y<.5?vec2(1,0):vec2(0,1);vec4 total=vec4(0);
  if(u[9].w>.5){uvec4 sum=uvec4(0);for(int i=-reach;i<=reach;i++){uvec4 v=uvec4(roundEven(texelFetch(sourceB,ivec2(abs(i),0),0)*255.));uint weight=v.x|(v.y<<8u)|(v.z<<16u)|(v.w<<24u);sum+=uvec4(roundEven(blurAt(p+axis*float(i))*255.))*weight;}uvec4 q=sum>>24u,r=sum&0x00ffffffu;uvec4 up=uvec4(greaterThan(r,uvec4(0x00800000u)))+(uvec4(equal(r,uvec4(0x00800000u)))&(q&1u));return vec4(q+up)/255.;}
  if(radius==floor(radius))return tentInteger(p,axis,reach);
  for(int i=-reach;i<=reach;i++)total+=blurAt(p+axis*float(i))*tentWeight(radius,abs(float(i)));
  return roundEven(clamp(total,0.,1.)*255.)/255.;}
 if(mode==20){return curveMask(p);}
 if(mode==26){vec4 total=roundEven(smpBytes(sourceA,p,u[1]))+roundEven(smpBytes(sourceB,p,u[2]))+roundEven(smpBytes(sourceC,p,u[3]))+roundEven(smpBytes(sourceD,p,u[1]));return floor((total+2.)*.25)/255.;}
 if(mode==27){return roundEven(smpBytes(sourceA,clamp(p,u[1].xy+.5,u[1].xy+u[1].zw-.5),u[1]))/255.;}
 if(mode==29){uvec4 dst=uvec4(roundEven(smp(sourceB,p,u[2])*255.)),src=uvec4(roundEven(a*255.));float opacity=u[4].z;if(u[4].w>.5)opacity*=at(sourceC,p,u[3]).a;uint weight=uint(roundEven(clamp(opacity,0.,1.)*65535.)),denominator=16711425u;uvec4 numerator=dst*(denominator-src.a*weight)+src*(255u*weight),q=numerator/denominator,rem=numerator-q*denominator;return vec4(q+uvec4(greaterThan(rem*2u,uvec4(denominator))))/255.;}
 if(mode==28){vec4 dst=smp(sourceB,p,u[2]);if(any(lessThan(p,u[1].xy))||any(greaterThanEqual(p,u[1].xy+u[1].zw))){return dst;}float opacity=u[4].z;if(u[4].w>.5)opacity*=at(sourceC,p,u[3]).a;if(u[4].y>.5)return roundEven(roundEven(dst*255.)*(1.-opacity)+roundEven(a*255.)*opacity)/255.;return dst*(1.-opacity)+a*opacity;}
 if(mode==25){float opacity=u[4].z;if(u[4].w>.5)opacity*=at(sourceC,p,u[3]).a;vec4 src=a*opacity,dst=smp(sourceB,p,u[2]);float coverage=at(sourceD,p,u[47]).a*opacity;return roundEven(clamp(over(dst,src,int(u[4].y))-dst*max(0.,coverage-src.a),0.,1.)*255.)/255.;}
 if(BYTE_SURFACE&&mode==24){vec2 q=(p-u[9].xy)/u[9].z-.5;return figmaSpatialResolve(q);}
 if(mode==23){vec4 total=roundEven(at(sourceA,p,u[1])*255.)+roundEven(at(sourceB,p,u[2])*255.)+roundEven(at(sourceC,p,u[3])*255.)+roundEven(at(sourceD,p,u[1])*255.);return floor((total+2.)*.25)/255.;}
 if(mode==21){vec2 q=(p-u[9].xy)/u[9].z-.5;
  vec4 total=roundEven(at(sourceA,q,u[1])*255.)+roundEven(at(sourceA,q+vec2(1,0),u[1])*255.)+roundEven(at(sourceA,q+vec2(0,1),u[1])*255.)+roundEven(at(sourceA,q+vec2(1,1),u[1])*255.);
  return figmaNormalized4(uvec4(total));}
 if(mode==19){vec2 q=floor(p-u[0].xy)*2.+.5;return (at(sourceA,q,u[1])+at(sourceA,q+vec2(1,0),u[1])+at(sourceA,q+vec2(0,1),u[1])+at(sourceA,q+vec2(1,1),u[1]))*.25;}
 if(mode==18){float scale=u[9].z;vec2 q=(p-u[9].xy)/scale;if(scale>=1.)return at(sourceA,floor(q)+.5,u[1]);
 vec2 lo=(p-.5-u[9].xy)/scale,hi=(p+.5-u[9].xy)/scale;uvec4 total=uvec4(0);for(int y=int(floor(lo.y));y<int(ceil(hi.y));y++)for(int x=int(floor(lo.x));x<int(ceil(hi.x));x++){vec2 cell=vec2(float(x),float(y));uvec2 w=uvec2(roundEven(clamp((cell+1.-lo)*scale,0.,1.)*4096.))-uvec2(roundEven(clamp((cell-lo)*scale,0.,1.)*4096.));total+=uvec4(roundEven(at(sourceA,cell+.5,u[1])*255.))*w.x*w.y;}uvec4 quotient=total>>24u,r=total&0x00ffffffu;for(int c=0;c<4;c++)if(r[c]>0x00800000u||(r[c]==0x00800000u&&(quotient[c]&1u)!=0u))quotient[c]++;return vec4(quotient)/255.;}
 if(mode==17){vec2 q=p-u[0].xy;vec2 extent=clamp(min(q+.5,u[9].zw)-max(q-.5,u[9].xy),vec2(0),vec2(1));return vec4(extent.x*extent.y);}
 if(mode==0||mode==14)return a;
 if(mode==1){float v=at(sourceA,p,u[1]).a,b=at(sourceB,p,u[2]).a;v*=u[9].x>.5?1.-b:b;return vec4(v);}
 if(mode==2||mode==16){vec2 q=local(p+u[46].xy);int kind=int(u[7].x);float opacity=u[8].x;vec4 paint=vec4(u[7].yzw*opacity*u[60].y,opacity*u[60].y);if(kind==0&&u[46].z>.5)paint=u[48];
  if((kind==1||kind==2||kind==4||kind==5)&&u[60].x<.5){float t=gradientT(p,q,kind);int count=int(u[8].w);if(count>0){bool bytePaint=u[46].w>.5;float firstAlpha=gradientStopAlpha(0u);vec4 rgba=vec4(gradientStop(0u).yzw*firstAlpha,firstAlpha);if(bytePaint)rgba=roundEven(rgba*255.);for(int i=1;i<64;i++){if(i>=count)break;vec4 l=gradientStop(uint(i-1)),r=gradientStop(uint(i));if(t>l.x){float la=gradientStopAlpha(uint(i-1)),ra=gradientStopAlpha(uint(i));vec4 left=vec4(l.yzw*la,la),right=vec4(r.yzw*ra,ra);if(bytePaint){left=roundEven(left*255.);right=roundEven(right*255.);}float k=clamp((t-l.x)/max(r.x-l.x,1e-8),0.,1.);rgba=bytePaint?vec4(colourMix(left.r,right.r,k),colourMix(left.g,right.g,k),colourMix(left.b,right.b,k),colourMix(left.a,right.a,k)):left+(right-left)*k;}}paint=rgba*opacity;if(bytePaint)paint=roundEven(rgba*opacity)/255.;}}
  if(u[60].x>.5){
   if(kind==0)paint=mulRN4(mulRN4(vec4(u[7].yzw,1.),vec4(u[60].y)),vec4(opacity));
   if(kind==1||kind==2||kind==4||kind==5){paint=mulRN4(linearGradient(p),vec4(opacity));}
  }
  if(kind==3&&u[60].x>.5){paint=mulRN4(linearImage(p),vec4(opacity));}else if(kind==3&&u[46].w>.5){vec4 grid=byteImageAddress(p);paint=grid.z>.5?roundEven(smpBytesIndex(sourceB,grid.xy,u[2])*opacity)/255.:vec4(0);}else if(kind==3){vec2 size=u[2].zw;vec2 coord=paintUV(q)*size-.5;if(u[62].z<.5){coord=(q*size-u[6].zw*.5)/u[6].zw;if(u[8].z<1.5){float ratio=u[8].z<.5?max(u[6].z/size.x,u[6].w/size.y):min(u[6].z/size.x,u[6].w/size.y);coord=(q-(u[6].zw-(size-1.)*ratio)*.5)/ratio;}}if(u[8].z>.5&&u[8].z<1.5&&(any(lessThan(coord,vec2(-.5)))||any(greaterThanEqual(coord,size-.5))))paint=vec4(0);else if(u[46].w>.5)paint=roundEven(smpBytesIndex(sourceB,clamp(coord,vec2(0),size-1.),u[2])*opacity)/255.;else paint=smpIndex(sourceB,clamp(coord,vec2(0),size-1.),u[2])*opacity;}
  if(u[46].w>.5)paint=roundEven(paint*255.)/255.;vec4 result=paint*at(sourceA,p,u[1]).a;if(u[60].x>.5)result=mulRN4(paint,vec4(at(sourceA,p,u[1]).a));if(mode==16){result*=u[4].z;if(u[4].w>0.5)result*=at(sourceC,p,u[3]).a;}return result;
 }
 if(mode==15){vec4 src=a*u[4].z;if(u[4].w>0.5)src*=at(sourceC,p,u[3]).a;return src;}
 if(mode==3&&u[60].x<.5&&u[4].z<1.&&(u[4].y==1.||u[4].y==2.)){uvec4 dst=uvec4(roundEven(smp(sourceB,p,u[2])*255.));uvec4 src=uvec4(roundEven(a*255.));float opacity=u[4].z;if(u[4].w>.5)opacity*=at(sourceC,p,u[3]).a;uint weight=uint(roundEven(clamp(opacity,0.,1.)*65535.));uint denominator=16711425u;uvec4 sum=dst*(denominator-src.a*weight)+src*(255u*weight);if(u[4].y==1.)sum=uvec4(src.rgb*weight*(uvec3(255u-dst.a)+dst.rgb)+dst.rgb*(denominator-src.a*weight),sum.a);else sum=uvec4(src.rgb*weight*(uvec3(255)-dst.rgb)+dst.rgb*denominator,sum.a);uvec4 q=sum/denominator;uvec4 rem=sum-q*denominator;return vec4(q+uvec4(greaterThan(rem*2u,uvec4(denominator))))/255.;}
 if(mode==3){vec4 src=a*u[4].z;if(u[4].w>.5)src*=at(sourceC,p,u[3]).a;return over(smp(sourceB,p,u[2]),src,int(u[4].y));}
 if(mode==4||mode==5){int r=int(u[9].x);vec2 axis=u[9].y<.5?vec2(1,0):vec2(0,1);vec4 total=vec4(0);float alpha=u[9].z>.5?0.:1.;for(int i=-r;i<=r;i++){vec4 v=(mode==5&&u[9].w>.5)?at(sourceA,p+axis*float(i),u[1]):smp(sourceA,p+axis*float(i),u[1]);if(mode==4)total+=v;else alpha=u[9].z>.5?max(alpha,v.a):min(alpha,v.a);}return mode==4?total/float(2*r+1):vec4(0,0,0,alpha);}
 if(mode==6){if(u[9].x>.5){float b=smpBytes(sourceB,p-u[9].yz,u[2]).a;float coverage=u[9].w>.5?roundEven(a.a*255.)*(1.-b/255.):b;uint alpha=uint(roundEven(clamp(u[8].x*coverage,0.,255.)*65536.));uvec4 numerator=uvec4(roundEven(vec4(u[7].yzw,1.)*255.))*alpha;uint denominator=16711680u;uvec4 q=numerator/denominator,r=numerator-q*denominator;uvec4 up=uvec4(greaterThan(r*2u,uvec4(denominator)))+(uvec4(equal(r*2u,uvec4(denominator)))&(q&1u));return vec4(q+up)/255.;}float b=smp(sourceB,p-u[9].yz,u[2]).a;float coverage=u[9].w>.5?a.a*(1.-b):b;float alpha=u[8].x*coverage;vec4 result=vec4(u[7].yzw*alpha,alpha);return u[9].x>.5?roundEven(result*255.)/255.:result;}
 if(mode==30)return vec4(maskLumRN(a.rgb));
 if(mode==7){float v=noise(ivec2(floor(local(p)*max(.01,u[10].x))),7u);float alpha=u[10].y*a.a;vec4 source=vec4(vec3(v*alpha),alpha);if(u[60].x<.5)source=roundEven(source*255.)/255.;return over(a,source,9);}
 if(mode==8){ivec2 q=ivec2(floor(local(p)));vec2 delta=(vec2(noise(q,13u),noise(q,29u))-.5)*u[10].x;vec2 device=vec2(u[45].x*delta.x+u[45].z*delta.y,u[45].y*delta.x+u[45].w*delta.y);return smp(sourceA,p+device,u[1]);}
 if(mode==9)return at(sourceA,p,u[1]).a>.5?vec4(1):encodePoint(floor(p-u[0].xy));
 if(mode==10){vec2 here=floor(p-u[0].xy),best=vec2(-1);float score=1e30;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 pos=p+vec2(x,y)*u[9].x;if(any(lessThan(pos,u[1].xy))||any(greaterThanEqual(pos,u[1].xy+u[1].zw)))continue;vec2 candidate=decodePoint(at(sourceA,pos,u[1]));if(candidate.x<0.)continue;float d=dot(here-candidate,here-candidate);if(d<score){score=d;best=candidate;}}return encodePoint(best);}
 if(mode==11){float d=distanceField(p);vec2 grad=vec2(distanceField(p+vec2(1,0))-distanceField(p-vec2(1,0)),distanceField(p+vec2(0,1))-distanceField(p-vec2(0,1)));float len=max(length(grad),1e-5);float factor=clamp(1.-d/max(u[9].x,4.),0.,1.);vec4 refract=smp(sourceA,p+grad/len*u[9].y*factor*factor,u[1]);float highlight=abs(grad.x-grad.y)/len*factor*u[9].z*.25;if(u[60].x<.5&&u[9].w>.5){uvec4 dst=uvec4(roundEven(clamp(smpBytes(sourceA,p+grad/len*u[9].y*factor*factor,u[1]),vec4(0),vec4(255))));uint alpha=uint(roundEven(clamp(highlight,0.,1.)*255.));uvec4 sum=dst*(255u-alpha)+uvec4(alpha*255u);uvec4 q=sum/255u;uvec4 rem=sum-q*255u;return vec4(q+uvec4(greaterThan(rem*2u,uvec4(255))))/255.;}return over(refract,vec4(vec3(highlight),highlight),0)*(u[9].w>.5?1.:at(sourceC,p,u[3]).a);}
 if(mode==12){vec4 bg=vec4(u[12].rgb*u[12].a,u[12].a);if(u[13].w>0.){ivec2 cell=ivec2(floor(p/u[13].w));if(((cell.x^cell.y)&1)!=0)bg=vec4(u[13].rgb,1.);}if(u[11].w>.5&&u[11].z>.13){float spacing=32.*u[11].z;vec2 delta=mod(p-u[11].xy,spacing);delta=min(delta,spacing-delta);float alpha=clamp(1.-length(delta),0.,1.)*.4;bg=over(bg,vec4(vec3(.65,.67,.73)*alpha,alpha),0);}return bg;}
 return vec4(0);
}
vec4 analyticDisplayColor(vec4 value){
 if(value.a<=0.)return vec4(0);
 vec4 straight=vec4(divideRN(value.r,value.a),divideRN(value.g,value.a),divideRN(value.b,value.a),value.a);
 vec4 scaled=mulRN4(clamp(straight,vec4(0),vec4(1)),vec4(255));
 vec4 base=floor(scaled);vec4 bytes=base+vec4(greaterThanEqual(scaled-base,vec4(.5)));
 vec4 encoded=bytes/255.;return vec4(encoded.rgb*encoded.a,encoded.a);
}
vec4 displayColor(vec4 value){if(value.a<=0.)return vec4(0);vec3 c=value.rgb/value.a;if(u[60].w<.5)c=clamp(c,vec3(0),vec3(1));vec3 x=abs(c),encoded=mix(1.055*pow(x,vec3(1./2.4))-.055,12.92*x,lessThanEqual(x,vec3(.0031308)));return vec4(sign(c)*encoded*value.a,value.a);}
#ifndef SOLID_BATCH
void main(){vec2 p=gl_FragCoord.xy;if((int(u[4].x)==14||((int(u[4].x)==18||int(u[4].x)==33)&&u[4].y>.5)))p.y=u[0].w-p.y;color=shade(p+u[0].xy);if(u[60].z>.5)color=displayColor(color);else if(int(u[4].x)==14&&u[61].x>.5)color=analyticDisplayColor(color);else if(u[60].x<.5&&int(u[4].x)!=15&&int(u[4].x)!=16&&int(u[4].x)!=44)color=roundEven(clamp(color,vec4(0),vec4(1))*255.)/255.;}

#else
uniform highp sampler2D sourceInstances;
flat in highp int solidItem;
vec4 solidData(int i){ivec2 size=textureSize(sourceInstances,0);return texelFetch(sourceInstances,ivec2(i%size.x,i/size.x),0);}
void main(){vec2 p=gl_FragCoord.xy+u[0].xy;if(u[4].w>.5&&at(sourceC,p,u[3]).a<.5)discard;
 vec2 offsets[4]=vec2[4](vec2(.375,.125),vec2(.875,.375),vec2(.125,.625),vec2(.625,.875));
 vec4 r=solidData(solidItem),shapeInfo=solidData(solidItem+1);vec2 q=p-r.xy-.5+offsets[int(u[9].y)];bool inside;
 if(shapeInfo.w>=2.){vec4 b=solidData(solidItem+2);inside=all(greaterThanEqual(q,b.xy))&&all(lessThan(q,b.zw));}
 else{vec2 bands=vec2(max(0.,shapeInfo.z),shapeInfo.z>=0.?ceil(r.w/16.):0.);int w=windingFor(q,shapeInfo.xy,bands);inside=(int(shapeInfo.w)&1)!=0?abs(w)%2!=0:w!=0;}
 if(!inside)discard;color=solidData(solidItem+3);
}
#endif
