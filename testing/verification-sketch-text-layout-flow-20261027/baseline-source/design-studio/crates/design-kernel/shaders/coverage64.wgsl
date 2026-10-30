// One invocation-private scratch arena, reinitialized for every width.
var<private> cvWords:array<u32,35>;
// Coverage arithmetic for scanline interval geometry. Endpoints are binary64
// fractions in [0,1], encoded low/high u32. Preserve the CPU's binary64
// subtraction/multiplication boundary, followed by binary32 RNE. No f64 GPU
// extension, float32 endpoint downgrade, native fusion, or CPU mask upload.
fn cvScaled(value:vec2<u32>,bits:u32)->f32{
 if(all(value==vec2<u32>(0))){return 0.;}
 var top:u32=highestBit(value.x);if(value.y!=0u){top=32u+highestBit(value.y);}
 let exponent:i32=i32(top)-i32(bits)+127;
 if(exponent<=0){
  if(bits<=149u){return bitcast<f32>(value.x<<(149u-bits));}
  let shift:u32=bits-149u;var q:u32=0u;var guard:bool=false;var sticky:bool=false;
  if(shift>64u){return 0.;}
  if(shift==64u){guard=(value.y&0x80000000u)!=0u;sticky=value.x!=0u||(value.y&0x7fffffffu)!=0u;}
  else if(shift>=32u){
   let s:u32=shift-32u;q=value.y>>s;
   if(s==0u){guard=(value.x&0x80000000u)!=0u;sticky=(value.x&0x7fffffffu)!=0u;}
   else{guard=(value.y&(1u<<(s-1u)))!=0u;sticky=value.x!=0u||(value.y&((1u<<(s-1u))-1u))!=0u;}
  }else{q=(value.x>>shift)|(value.y<<(32u-shift));guard=(value.x&(1u<<(shift-1u)))!=0u;sticky=(value.x&((1u<<(shift-1u))-1u))!=0u;}
  if(guard&&(sticky||(q&1u)!=0u)){q=q+1u;}return bitcast<f32>(q);
 }
 return scaledPositive64(value,bits);
}
// Result = (lo | hi<<32) / 2^bits, correctly rounded to binary64 first.
fn cvWidth(integer:u32,right:vec2<u32>,left:vec2<u32>)->vec3<u32>{

 for(var j:u32=0u;j<35u;j=j+1u){cvWords[j]=0u;}
 for(var term:u32=0u;term<3u;term=term+1u){
  var bits:vec2<u32>=vec2<u32>(0);if(term==0u&&integer!=0u){bits=vec2<u32>(0u,0x3ff00000u);}else if(term==1u){bits=right;}else if(term==2u){bits=left;}
  let negative:bool=((bits.y>>31u)!=0u)!=(term==2u);
  let exponent:u32=(bits.y>>20u)&2047u;
  let mantissa:vec2<u32>=vec2<u32>(bits.x,(bits.y&0xfffffu)|select(0u,0x100000u,exponent!=0u));
  let shift:u32=max(exponent,1u)-1u;let offset:u32=shift%32u;
  for(var part:u32=0u;part<4u;part=part+1u){
   var index:u32=shift/32u+part/2u;var value:u32=mantissa[part/2u]<<offset;
   if((part&1u)!=0u){if(offset==0u){continue;}index=index+1u;value=mantissa[part/2u]>>(32u-offset);}
   while(index<35u&&value!=0u){let old:u32=cvWords[index];if(negative){cvWords[index]=old-value;value=select(0u,1u,old<value);}else{cvWords[index]=old+value;value=select(0u,1u,cvWords[index]<old);}index=index+1u;}
  }
 }
 var last:u32=35u;for(var j:u32=0u;j<35u;j=j+1u){if(cvWords[j]!=0u){last=j;}}
 if(last==35u){return vec3<u32>(0);}
 var top:u32=last*32u+highestBit(cvWords[last]);
 // Inputs/areas are nonnegative and <=1. Values below half the minimum
 // binary32 subnormal remain zero after multiplying another width <=1.
 if(top<924u){return vec3<u32>(0);}
 let shift:u32=top-52u;let index:u32=shift/32u;let offset:u32=shift%32u;
 var lo:u32=cvWords[index]>>offset;var hi:u32=cvWords[index+1u]>>offset;
 if(offset!=0u){lo=lo|(cvWords[index+1u]<<(32u-offset));hi=hi|(cvWords[index+2u]<<(32u-offset));}
 let guard:u32=shift-1u;let guardBit:bool=(cvWords[guard/32u]&(1u<<(guard%32u)))!=0u;
 var sticky:bool=(cvWords[guard/32u]&((1u<<(guard%32u))-1u))!=0u;
 for(var j:u32=0u;j<guard/32u;j=j+1u){sticky=sticky||cvWords[j]!=0u;}
 if(guardBit&&(sticky||(lo&1u)!=0u)){let old:u32=lo;lo=lo+1u;if(lo<old){hi=hi+1u;}}
 if(hi>=0x200000u){lo=(lo>>1u)|(hi<<31u);hi=hi>>1u;top=top+1u;}
 return vec3<u32>(lo,hi,1126u-top);
}
fn cvDifference(right:vec2<u32>,left:vec2<u32>)->vec3<u32>{return cvWidth(0u,right,left);}
fn cvProduct(a:vec3<u32>,b:vec3<u32>)->f32{
 if(all(a.xy==vec2<u32>(0))||all(b.xy==vec2<u32>(0))){return 0.;}
 var words:array<u32,4>;
 for(var i:u32=0u;i<4u;i=i+1u){words[i]=0u;}
 for(var i:u32=0u;i<2u;i=i+1u){for(var j:u32=0u;j<2u;j=j+1u){
  let product:vec2<u32>=wideMultiply(a[i],b[j]);
  for(var part:u32=0u;part<2u;part=part+1u){var index:u32=i+j+part;var value:u32=product[part];
   while(index<4u&&value!=0u){let old:u32=words[index];words[index]=old+value;value=select(0u,1u,words[index]<old);index=index+1u;}
  }
 }}
 var top:u32=96u+highestBit(words[3]);
 let shift:u32=top-52u;let offset:u32=shift-32u;
 var lo:u32=(words[1]>>offset)|(words[2]<<(32u-offset));
 var hi:u32=(words[2]>>offset)|(words[3]<<(32u-offset));
 let guard:bool=(words[1]&(1u<<(offset-1u)))!=0u;
 let sticky:bool=words[0]!=0u||(words[1]&((1u<<(offset-1u))-1u))!=0u;
 if(guard&&(sticky||(lo&1u)!=0u)){let old:u32=lo;lo=lo+1u;if(lo<old){hi=hi+1u;}}
 var bits:u32=a.z+b.z-shift;
 if(hi>=0x200000u){lo=(lo>>1u)|(hi<<31u);hi=hi>>1u;bits=bits-1u;}
 return cvScaled(vec2<u32>(lo,hi),bits);
}
