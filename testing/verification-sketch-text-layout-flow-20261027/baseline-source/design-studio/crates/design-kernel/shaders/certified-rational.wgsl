// Q48 integer enclosure, not approximate rendering. sourceC packet:
// [0x38345143, reach, 48, 0], then floor(w*2^48) as low/high u32 per distance.
// w lies in [q,q+1]*2^-48. A finite binary32 sample is sign*m*2^(e-150),
// e=max(rawExponent,1). For exponent span <=40, <=1025 products with
// m<2^24 and q+1<=2^48+1 have absolute partial sums <2^124. Four signed
// u32 limbs cannot overflow. Endpoint RNE is integer-only. Return a value
// ONLY when both endpoints have identical finite binary32 bits; otherwise
// caller executes its existing full rational filter. No native float error
// estimate, TwoSum, FMA, rounding mode, or subnormal arithmetic is assumed.
var<private> cfLower:array<u32,4>;
var<private> cfUpper:array<u32,4>;
var<private> cfWork:array<u32,4>;

fn rfCertifiedLoad(index:u32)->u32 {
 let dimensions:vec2<u32>=vec2<u32>(textureDimensions(sourceC,0));
 var point:vec2<i32>=vec2<i32>(i32(index),0);
 if(dimensions.y>1u){point=vec2<i32>(i32(index%dimensions.x),i32(index/dimensions.x));}
 let bytes:vec4<u32>=vec4<u32>(round(textureLoad(sourceC,point,0)*255.));
 return bytes.x|(bytes.y<<8u)|(bytes.z<<16u)|(bytes.w<<24u);
}
fn rfCertifiedSource(point:vec2<f32>)->vec4<f32> {
 var p:vec2<f32>=point;
 if(u(9).z>0.5){p=clamp(p,u(1).xy+0.5,u(1).xy+u(1).zw-0.5);}
 let q:vec2<i32>=vec2<i32>(floor(p-u(1).xy));
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(1).zw))){return vec4<f32>(0);}
 return textureLoad(sourceA,q,0);
}
fn cfAdd(mantissa:u32,low:u32,high:u32,shift:u32,negative:bool,upper:bool)->u32 {
 let a:vec2<u32>=bsMultiply(low,mantissa);let b:vec2<u32>=bsMultiply(high,mantissa);
 let middle:u32=a.y+b.x;
 let product:vec3<u32>=vec3<u32>(a.x,middle,b.y+select(0u,1u,middle<a.y));
 // The caller proves shift <= 40. Assemble the shifted 72-bit product
 // once, then add/subtract all four limbs with a fixed carry chain. This is
 // the same signed modulo-2^128 sum as the former six partial-word loops;
 // the enclosure bound (<2^124) excludes signed overflow.
 let offset:u32=shift%32u;
 var words:vec4<u32>=vec4<u32>(product.x<<offset,product.y<<offset,product.z<<offset,0u);
 if(offset!=0u){words=words|vec4<u32>(0u,product.x>>(32u-offset),product.y>>(32u-offset),product.z>>(32u-offset));}
 if(shift>=32u){words=vec4<u32>(0u,words.xyz);}
 var carry:u32=select(0u,1u,negative);
 var old0:u32=cfLower[0u];if(upper){old0=cfUpper[0u];}
 var part0:u32=words.x;if(negative){part0=~part0;}
 let sum0:u32=old0+part0;let next0:u32=sum0+carry;
 carry=select(0u,1u,sum0<old0||next0<sum0);
 if(upper){cfUpper[0u]=next0;}else{cfLower[0u]=next0;}
 var old1:u32=cfLower[1u];if(upper){old1=cfUpper[1u];}
 var part1:u32=words.y;if(negative){part1=~part1;}
 let sum1:u32=old1+part1;let next1:u32=sum1+carry;
 carry=select(0u,1u,sum1<old1||next1<sum1);
 if(upper){cfUpper[1u]=next1;}else{cfLower[1u]=next1;}
 var old2:u32=cfLower[2u];if(upper){old2=cfUpper[2u];}
 var part2:u32=words.z;if(negative){part2=~part2;}
 let sum2:u32=old2+part2;let next2:u32=sum2+carry;
 carry=select(0u,1u,sum2<old2||next2<sum2);
 if(upper){cfUpper[2u]=next2;}else{cfLower[2u]=next2;}
 var old3:u32=cfLower[3u];if(upper){old3=cfUpper[3u];}
 var part3:u32=words.w;if(negative){part3=~part3;}
 let sum3:u32=old3+part3;let next3:u32=sum3+carry;
 carry=select(0u,1u,sum3<old3||next3<sum3);
 if(upper){cfUpper[3u]=next3;}else{cfLower[3u]=next3;}
 return 0u;
}
// The two coefficient endpoints differ by exactly one Q48 unit. Accumulate
// the positive enclosure width separately instead of multiplying every tap by
// q and q+1. The admitted span + ceil(log2(taps)) <= 51 keeps the positive width
// below 75 bits, including up to 4097 taps.
fn cfAddWidth(mantissa:u32,shift:u32)->u32 {
 var low:u32=0u;var high:u32=0u;
 if(shift>=32u){high=mantissa<<(shift-32u);}
 else{low=mantissa<<shift;if(shift!=0u){high=mantissa>>(32u-shift);}}
 let old0:u32=cfUpper[0];let next0:u32=old0+low;cfUpper[0]=next0;
 let old1:u32=cfUpper[1];let sum1:u32=old1+high;let next1:u32=sum1+select(0u,1u,next0<old0);cfUpper[1]=next1;
 cfUpper[2]=cfUpper[2]+select(0u,1u,sum1<old1||next1<sum1);
 return 0u;
}
fn cfRound(upper:bool,quantum:i32)->u32 {
 for(var j:u32=0u;j<4u;j=j+1u){cfWork[j]=cfLower[j];if(upper){cfWork[j]=cfUpper[j];}}
 let negative:bool=(cfWork[3]&0x80000000u)!=0u;
 if(negative){
  for(var j:u32=0u;j<4u;j=j+1u){cfWork[j]=~cfWork[j];}
  var carry:u32=1u;var j:u32=0u;
  while(j<4u&&carry!=0u){let old:u32=cfWork[j];cfWork[j]=old+carry;carry=select(0u,1u,cfWork[j]<old);j=j+1u;}
 }
 var last:u32=4u;
 for(var j:u32=0u;j<4u;j=j+1u){if(cfWork[j]!=0u){last=j;}}
 if(last==4u){return 0u;}
 let top:i32=i32(last*32u+bsHigh(cfWork[last]));
 let exponent:i32=top+quantum;
 let unit:i32=max(exponent-23,-149);let shift:i32=unit-quantum;
 var mantissa:u32=0u;
 if(shift<=0){mantissa=cfWork[0]<<u32(-shift);}
 else if(shift<128){
  let index:u32=u32(shift)/32u;let offset:u32=u32(shift)%32u;
  mantissa=cfWork[index]>>offset;
  if(offset!=0u&&index+1u<4u){mantissa=mantissa|(cfWork[index+1u]<<(32u-offset));}
  let guard:u32=u32(shift)-1u;let bit:u32=guard%32u;
  let guardBit:bool=(cfWork[guard/32u]&(1u<<bit))!=0u;
  var sticky:bool=(cfWork[guard/32u]&((1u<<bit)-1u))!=0u;
  for(var j:u32=0u;j<guard/32u;j=j+1u){sticky=sticky||cfWork[j]!=0u;}
  if(guardBit&&(sticky||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 }
 var rawExponent:u32=0u;if(exponent>=-126){rawExponent=u32(exponent+127);}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;rawExponent=rawExponent+1u;}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 let sign:u32=select(0u,0x80000000u,negative);
 if(rawExponent>=255u){return sign|0x7f800000u;}
 return sign|(rawExponent<<23u)|(mantissa&0x7fffffu);
}
fn rfCertifiedChannel(point:vec2<f32>,axis:vec2<f32>,channel:u32)->vec2<u32> {
 let reach:u32=rfCertifiedLoad(1u);let wide:bool=rfCertifiedLoad(3u)==64u;
 if(rfCertifiedLoad(0u)!=0x38345143u||rfCertifiedLoad(2u)!=48u||reach>2048u){return vec2<u32>(0u,0u);}
 var minimum:u32=255u;var maximum:u32=0u;var first:u32=0u;var same:bool=true;
 for(var tap:i32=-i32(reach);tap<=i32(reach);tap=tap+1){
  let bits:u32=bitcast<u32>(rfCertifiedSource(point+axis*f32(tap))[channel]);
  let exponent:u32=(bits>>23u)&255u;
  if(exponent==255u){return vec2<u32>(0u,0u);}
  let canonical:u32=select(bits,0u,(bits&0x7fffffffu)==0u);
  if(tap==-i32(reach)){first=canonical;}else{same=same&&(first==canonical);}
  if((bits&0x7fffffffu)!=0u){minimum=min(minimum,max(exponent,1u));maximum=max(maximum,max(exponent,1u));}
 }
 if(same||maximum==0u){return vec2<u32>(first,1u);}
 if(maximum-minimum>min(40u,51u-(bsHigh(2u*reach)+1u))){return vec2<u32>(0u,0u);}
 for(var j:u32=0u;j<4u;j=j+1u){cfLower[j]=0u;cfUpper[j]=0u;}
 for(var tap:i32=-i32(reach);tap<=i32(reach);tap=tap+1){
  let bits:u32=bitcast<u32>(rfCertifiedSource(point+axis*f32(tap))[channel]);
  let exponent:u32=(bits>>23u)&255u;
  let mantissa:u32=(bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
  if(mantissa==0u){continue;}
  let at:u32=4u+2u*u32(abs(tap));
  let rawLow:u32=rfCertifiedLoad(at);let rawHigh:u32=rfCertifiedLoad(at+1u);
  let low:u32=select(rawLow,(rawLow>>16u)|(rawHigh<<16u),wide);let high:u32=select(rawHigh,rawHigh>>16u,wide);
  if(high>65536u||(high==65536u&&low!=0u)){return vec2<u32>(0u,0u);}
  let upperLow:u32=low+1u;let upperHigh:u32=high+select(0u,1u,upperLow==0u);
  let shift:u32=max(exponent,1u)-minimum;let negative:bool=(bits>>31u)!=0u;
  if(negative){cfAdd(mantissa,upperLow,upperHigh,shift,true,false);}
  else{cfAdd(mantissa,low,high,shift,false,false);}
  cfAddWidth(mantissa,shift);
 }
 // Upper = lower + sum(abs(sample)), in the shared Q48 integer quantum.
 // This is bit-for-bit the former per-tap upper sum, including cancellation.
 var carry:u32=0u;
 for(var j:u32=0u;j<4u;j=j+1u){let old:u32=cfUpper[j];let sum:u32=old+cfLower[j];let next:u32=sum+carry;
  carry=select(0u,1u,sum<old||next<sum);cfUpper[j]=next;}
 let lower:u32=cfRound(false,i32(minimum)-198);let upper:u32=cfRound(true,i32(minimum)-198);
 return vec2<u32>(lower,select(0u,1u,lower==upper&&(lower&0x7f800000u)!=0x7f800000u));
}
