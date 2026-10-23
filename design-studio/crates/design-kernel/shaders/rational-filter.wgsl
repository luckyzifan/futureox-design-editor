// Exact rational weighted binary32 convolution. Generated GLSL uses this same
// integer program; no native floating multiply/reduction chooses the result.
fn rfLoad(index:u32)->u32 {
 let dimensions:vec2<u32>=vec2<u32>(textureDimensions(sourceB,0));
 var point:vec2<i32>=vec2<i32>(i32(index),0);
 if(dimensions.y>1u){point=vec2<i32>(i32(index%dimensions.x),i32(index/dimensions.x));}
 let bytes:vec4<u32>=vec4<u32>(round(textureLoad(sourceB,point,0)*255.));
 return bytes.x|(bytes.y<<8u)|(bytes.z<<16u)|(bytes.w<<24u);
}
fn rfSource(point:vec2<f32>)->vec4<f32> {
 var p:vec2<f32>=point;
 if(u(9).z>0.5){p=clamp(p,u(1).xy+0.5,u(1).xy+u(1).zw-0.5);}
 let q:vec2<i32>=vec2<i32>(floor(p-u(1).xy));
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(1).zw))){return vec4<f32>(0);}
 return textureLoad(sourceA,q,0);
}
fn rfChannel(point:vec2<f32>,axis:vec2<f32>,channel:u32)->f32 {
 let cw:u32=rfLoad(0u);let aw:u32=rfLoad(1u);let reach:i32=i32(rfLoad(2u));
 // Certify the existing constant-tap result before allocating/accumulating the
 // large integer reduction. Compare bits, preserving the original +0 canonical
 // rule. Nonfinite inputs always take the original ordered NaN/Inf handling.
 let firstBits:u32=bitcast<u32>(rfSource(point-axis*f32(reach))[channel]);
 if((firstBits&0x7fffffffu)<0x7f800000u){
  let canonicalFirst:u32=select(firstBits,0u,(firstBits&0x7fffffffu)==0u);
  let lastBits:u32=bitcast<u32>(rfSource(point+axis*f32(reach))[channel]);
  let canonicalLast:u32=select(lastBits,0u,(lastBits&0x7fffffffu)==0u);
  if(canonicalLast==canonicalFirst){
   var constantTaps:bool=true;
   for(var tap:i32=-reach+1;tap<reach;tap=tap+1){
    let bits:u32=bitcast<u32>(rfSource(point+axis*f32(tap))[channel]);
    if(select(bits,0u,(bits&0x7fffffffu)==0u)!=canonicalFirst){constantTaps=false;break;}
   }
   if(constantTaps){return bitcast<f32>(canonicalFirst);}
  }
 }
 var words:array<u32,44>;var divisor:array<u32,44>;
 for(var j:u32=0u;j<aw;j=j+1u){words[j]=0u;divisor[j]=0u;}
 var first:u32=0u;var same:bool=true;
 for(var tap:i32=-reach;tap<=reach;tap=tap+1){
  let sampleBits:u32=bitcast<u32>(rfSource(point+axis*f32(tap))[channel]);
  let exponent:u32=(sampleBits>>23u)&255u;
  if(exponent==255u){return bitcast<f32>((sampleBits&0x7fffffu)|0x7fc00000u);}
  let canonical:u32=select(sampleBits,0u,(sampleBits&0x7fffffffu)==0u);
  if(tap==-reach){first=canonical;}else{same=same&&(canonical==first);}
  let mantissa:u32=(sampleBits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
  if(mantissa==0u){continue;}
  let shift:u32=max(exponent,1u)-1u;let offset:u32=shift%32u;
  let negative:bool=(sampleBits>>31u)!=0u;
  let start:u32=4u+cw*(1u+u32(abs(tap)));
  for(var j:u32=0u;j<cw;j=j+1u){
   let product:vec2<u32>=bsMultiply(rfLoad(start+j),mantissa);
   for(var part:u32=0u;part<4u;part=part+1u){
    var index:u32=shift/32u+j+part/2u;
    var value:u32=product[part/2u]<<offset;
    if((part&1u)!=0u){if(offset==0u){continue;}index=index+1u;value=product[part/2u]>>(32u-offset);}
    while(index<aw&&value!=0u){let old:u32=words[index];if(negative){words[index]=old-value;value=select(0u,1u,old<value);}else{words[index]=old+value;value=select(0u,1u,words[index]<old);}index=index+1u;}
   }
  }
 }
 if(same){return bitcast<f32>(first);}
 let negative:bool=(words[aw-1u]&0x80000000u)!=0u;
 if(negative){
  for(var j:u32=0u;j<aw;j=j+1u){words[j]=~words[j];}
  var carry:u32=1u;var j:u32=0u;
  while(j<aw&&carry!=0u){let old:u32=words[j];words[j]=old+carry;carry=select(0u,1u,words[j]<old);j=j+1u;}
 }
 var last:u32=aw;
 for(var j:u32=0u;j<aw;j=j+1u){if(words[j]!=0u){last=j;}}
 if(last==aw){return 0.;}
 var height:i32=i32(last*32u+bsHigh(words[last]))-i32((cw-1u)*32u+bsHigh(rfLoad(4u+cw-1u)));
 var shift:u32=0u;
 // Stage 0 establishes floor(log2(numerator/denominator)); stage 1 builds
 // the divisor aligned to the highest of the 24 quotient bits.
 for(var stage:u32=0u;stage<2u;stage=stage+1u){
  shift=u32(max(height,0));if(stage==1u){shift=u32(max(height-23,0))+23u;}
  for(var j:u32=0u;j<aw;j=j+1u){divisor[j]=0u;}
  let offset:u32=shift%32u;
  for(var j:u32=0u;j<cw;j=j+1u){
   let value:u32=rfLoad(4u+j);let index:u32=j+shift/32u;
   divisor[index]=divisor[index]|(value<<offset);
   if(offset!=0u&&index+1u<aw){divisor[index+1u]=divisor[index+1u]|(value>>(32u-offset));}
  }
  if(stage==0u&&height>=0){
   var less:bool=false;
   for(var j:u32=aw;j>0u;j=j-1u){if(words[j-1u]!=divisor[j-1u]){less=words[j-1u]<divisor[j-1u];break;}}
   if(less){height=height-1;}
  }
 }
 var quotient:u32=0u;
 for(var bit:i32=23;bit>=0;bit=bit-1){
  var less:bool=false;
  for(var j:u32=aw;j>0u;j=j-1u){if(words[j-1u]!=divisor[j-1u]){less=words[j-1u]<divisor[j-1u];break;}}
  if(!less){
   var borrow:u32=0u;
   for(var j:u32=0u;j<aw;j=j+1u){let old:u32=words[j];let partial:u32=old-divisor[j];let next:u32=partial-borrow;borrow=select(0u,1u,old<divisor[j]||partial<borrow);words[j]=next;}
   quotient=quotient|(1u<<u32(bit));
  }
  if(bit>0){for(var j:u32=0u;j<aw;j=j+1u){let next:u32=divisor[j]>>1u;var carry:u32=0u;if(j+1u<aw){carry=divisor[j+1u]<<31u;}divisor[j]=next|carry;}}
 }
 var carry:u32=0u;
 for(var j:u32=0u;j<aw;j=j+1u){let old:u32=words[j];words[j]=(old<<1u)|carry;carry=old>>31u;}
 var order:i32=0;
 for(var j:u32=aw;j>0u;j=j-1u){if(words[j-1u]!=divisor[j-1u]){order=select(-1,1,words[j-1u]>divisor[j-1u]);break;}}
 if(order>0||(order==0&&(quotient&1u)!=0u)){quotient=quotient+1u;}
 var exponent:u32=u32(max(height-22,0));
 if(quotient>=0x1000000u){quotient=quotient>>1u;exponent=exponent+1u;}
 if(exponent==0u&&quotient>=0x800000u){exponent=1u;}
 return bitcast<f32>(select(0u,0x80000000u,negative)|(exponent<<23u)|(quotient&0x7fffffu));
}
fn rationalBlur(point:vec2<f32>,axis:vec2<f32>)->vec4<f32>{
 return vec4<f32>(rfChannel(point,axis,0u),rfChannel(point,axis,1u),rfChannel(point,axis,2u),rfChannel(point,axis,3u));
}
