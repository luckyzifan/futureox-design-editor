// Exact bilinear: Q447, 19 limbs, 9 dyadic terms, one RNE.
fn bsHigh(input:u32)->u32{var v=input;var n=0u;if(v>=65536u){v=v>>16u;n=n+16u;}if(v>=256u){v=v>>8u;n=n+8u;}if(v>=16u){v=v>>4u;n=n+4u;}if(v>=4u){v=v>>2u;n=n+2u;}if(v>=2u){n=n+1u;}return n;}
fn bsMultiply(a:u32,b:u32)->vec2<u32>{let a0=a&65535u;let a1=a>>16u;let b0=b&65535u;let b1=b>>16u;let p0=a0*b0;let p1=a1*b0;let p2=a0*b1;let carry=(p0>>16u)+(p1&65535u)+(p2&65535u);return vec2<u32>((p0&65535u)|(carry<<16u),a1*b1+(p1>>16u)+(p2>>16u)+(carry>>16u));}
fn bsParts(value:f32)->vec3<u32>{let bits=bitcast<u32>(value);let exponent=(bits>>23u)&255u;return vec3<u32>((bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u),max(exponent,1u),bits>>31u);}
// BEGIN BOUNDED BILINEAR
// Algebraically identical to the nine exact dyadic terms below. There is
// no intermediate floating-point rounding. u=U/2^ku and v=V/2^kv are
// decomposed from bits; ku,kv<=31. Four nonnegative integer weights sum
// exactly to 2^(ku+kv). With exponent span<=48 and span+ku+kv<=102,
// sum(abs(products)) < 2^(24+span+ku+kv) <= 2^126. Every signed
// partial sum stays strictly inside signed 128-bit range. Only the final RNE rounds.
// Unsupported weight denominators/exponent spans retain the 19-limb path.
var<private> bsCompact:array<u32,4>;
// Both bounded callers prove shift<=50 and signed partial sums<2^126.
// Assemble each admitted product (at most 86 bits) once and use a fixed 128-bit carry
// chain, preserving the former partial-word additions modulo 2^128.
fn bsCompactAdd(product:vec3<u32>,shift:u32,negative:bool)->u32{
 let offset:u32=shift%32u;
 var words:vec4<u32>=vec4<u32>(product.x<<offset,product.y<<offset,product.z<<offset,0u);
 if(offset!=0u){words=words|vec4<u32>(0u,product.x>>(32u-offset),product.y>>(32u-offset),product.z>>(32u-offset));}
 if(shift>=32u){words=vec4<u32>(0u,words.xyz);}
 var carry:u32=select(0u,1u,negative);
 let old0:u32=bsCompact[0u];var part0:u32=words.x;if(negative){part0=~part0;}
 let sum0:u32=old0+part0;let next0:u32=sum0+carry;
 carry=select(0u,1u,sum0<old0||next0<sum0);bsCompact[0u]=next0;
 let old1:u32=bsCompact[1u];var part1:u32=words.y;if(negative){part1=~part1;}
 let sum1:u32=old1+part1;let next1:u32=sum1+carry;
 carry=select(0u,1u,sum1<old1||next1<sum1);bsCompact[1u]=next1;
 let old2:u32=bsCompact[2u];var part2:u32=words.z;if(negative){part2=~part2;}
 let sum2:u32=old2+part2;let next2:u32=sum2+carry;
 carry=select(0u,1u,sum2<old2||next2<sum2);bsCompact[2u]=next2;
 let old3:u32=bsCompact[3u];var part3:u32=words.w;if(negative){part3=~part3;}
 let sum3:u32=old3+part3;let next3:u32=sum3+carry;
 carry=select(0u,1u,sum3<old3||next3<sum3);bsCompact[3u]=next3;
 return 0u;
}
fn bsFraction(bits:u32)->vec2<u32>{
 let raw:u32=bits&0x7fffffffu;
 if(raw==0u){return vec2<u32>(0u,0u);}
 if(raw>0x3f800000u||bits>0x80000000u){return vec2<u32>(0u,255u);}
 let exponent:u32=(raw>>23u)&255u;
 var numerator:u32=(raw&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
 var denominator:u32=150u-max(exponent,1u);
 while((numerator&1u)==0u&&denominator>0u){numerator=numerator>>1u;denominator=denominator-1u;}
 return vec2<u32>(numerator,denominator);
}
fn bsCompactRound(quantum:i32)->u32{
 let negative:bool=(bsCompact[3]&0x80000000u)!=0u;
 if(negative){
  for(var j:u32=0u;j<4u;j=j+1u){bsCompact[j]=~bsCompact[j];}
  var carry:u32=1u;var j:u32=0u;
  while(j<4u&&carry!=0u){let old:u32=bsCompact[j];bsCompact[j]=old+carry;carry=select(0u,1u,bsCompact[j]<old);j=j+1u;}
 }
 var last:u32=4u;for(var j:u32=0u;j<4u;j=j+1u){if(bsCompact[j]!=0u){last=j;}}
 if(last==4u){return 0u;}
 let top:i32=i32(last*32u+bsHigh(bsCompact[last]));let exponent:i32=top+quantum;
 let shift:i32=max(exponent-23,-149)-quantum;
 var mantissa:u32=0u;
 if(shift<=0){mantissa=bsCompact[0]<<u32(-shift);}
 else if(shift<128){
  let index:u32=u32(shift)/32u;let offset:u32=u32(shift)%32u;
  mantissa=bsCompact[index]>>offset;
  if(offset!=0u&&index+1u<4u){mantissa=mantissa|(bsCompact[index+1u]<<(32u-offset));}
  let guard:u32=u32(shift)-1u;let bit:u32=guard%32u;
  let guardBit:bool=(bsCompact[guard/32u]&(1u<<bit))!=0u;
  var sticky:bool=(bsCompact[guard/32u]&((1u<<bit)-1u))!=0u;
  for(var j:u32=0u;j<guard/32u;j=j+1u){sticky=sticky||bsCompact[j]!=0u;}
  if(guardBit&&(sticky||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 }
 var rawExponent:u32=0u;if(exponent>=-126){rawExponent=u32(exponent+127);}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;rawExponent=rawExponent+1u;}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 let sign:u32=select(0u,0x80000000u,negative);
 if(rawExponent>=255u){return sign|0x7f800000u;}
 return sign|(rawExponent<<23u)|(mantissa&0x7fffffu);
}
fn bsPositiveBounded(p:vec4<f32>,u:f32,v:f32)->vec2<u32>{
 let x:vec2<u32>=bsFraction(bitcast<u32>(u));let y:vec2<u32>=bsFraction(bitcast<u32>(v));
 if(x.y>31u||y.y>31u){return vec2<u32>(0u,0u);}
 let raw:vec4<u32>=bitcast<vec4<u32>>(p);
 var minimum:u32=255u;var maximum:u32=0u;
 for(var i:u32=0u;i<4u;i=i+1u){
  let exponent:u32=(raw[i]>>23u)&255u;if(exponent==255u){return vec2<u32>(0u,0u);}
  if((raw[i]&0x7fffffffu)!=0u){minimum=min(minimum,max(exponent,1u));maximum=max(maximum,max(exponent,1u));}
 }
 if(maximum==0u){return vec2<u32>(0u,1u);}
 if(maximum-minimum>48u||maximum-minimum+x.y+y.y>102u){return vec2<u32>(0u,0u);}
 let dx:u32=1u<<x.y;let dy:u32=1u<<y.y;
 for(var j:u32=0u;j<4u;j=j+1u){bsCompact[j]=0u;}
 for(var term:u32=0u;term<4u;term=term+1u){
  let exponent:u32=(raw[term]>>23u)&255u;
  let mantissa:u32=(raw[term]&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
  if(mantissa==0u){continue;}
  let horizontal:u32=select(dx-x.x,x.x,(term&1u)!=0u);let vertical:u32=select(dy-y.x,y.x,term>=2u);
  if(horizontal==0u||vertical==0u){continue;}
  let weight:vec2<u32>=bsMultiply(horizontal,vertical);
  let low:vec2<u32>=bsMultiply(weight.x,mantissa);let high:vec2<u32>=bsMultiply(weight.y,mantissa);
  let middle:u32=low.y+high.x;let product:vec3<u32>=vec3<u32>(low.x,middle,high.y+select(0u,1u,middle<low.y));
  let shift:u32=max(exponent,1u)-minimum;let offset:u32=shift%32u;let negative:bool=(raw[term]>>31u)!=0u;
  bsCompactAdd(product,shift,negative);
 }
 let bits:u32=bsCompactRound(i32(minimum)-150-i32(x.y)-i32(y.y));
 return vec2<u32>(bits,select(0u,1u,(bits&0x7f800000u)!=0x7f800000u));
}
// Secondary exact path for fine dyadic fractions. Retain the original nine
// monomials and their signs/order, but shift their common quantum to the
// smallest effective exponent sum. Each mantissa product is <2^72; when
// exponent-sum span<=50, the sum of all nine absolute terms is <2^126.
// This bounds every intermediate signed 128-bit accumulation, even when
// the final value nearly cancels. No terms or residual bits are discarded.
fn bsWindowed(p:vec4<f32>,u:f32,v:f32)->vec2<u32>{
 let ub:u32=bitcast<u32>(u);let vb:u32=bitcast<u32>(v);
 if((ub&0x7fffffffu)>0x3f800000u||(vb&0x7fffffffu)>0x3f800000u||ub>0x80000000u||vb>0x80000000u){return vec2<u32>(0u,0u);}
 let raw:vec4<u32>=bitcast<vec4<u32>>(p);
 for(var i:u32=0u;i<4u;i=i+1u){if(((raw[i]>>23u)&255u)==255u){return vec2<u32>(0u,0u);}}
 var minimum:u32=1024u;var maximum:u32=0u;
 for(var term:u32=0u;term<9u;term=term+1u){
  var color:f32=p.x;if(term>=8u){color=p.w;}else if(term>=6u){color=p.z;}else if(term>=4u){color=p.y;}
  var b:f32=u;if(term==0u){b=1.;}else if(term==2u||term==6u){b=v;}
  let c:f32=select(1.,v,term==3u||term==5u||term==7u||term==8u);
  let aa:vec3<u32>=bsParts(color);let bb:vec3<u32>=bsParts(b);let cc:vec3<u32>=bsParts(c);
  if(aa.x==0u||bb.x==0u||cc.x==0u){continue;}
  let exponent:u32=aa.y+bb.y+cc.y;minimum=min(minimum,exponent);maximum=max(maximum,exponent);
 }
 if(maximum==0u){return vec2<u32>(0u,1u);}
 if(maximum-minimum>50u){return vec2<u32>(0u,0u);}
 for(var j:u32=0u;j<4u;j=j+1u){bsCompact[j]=0u;}
 for(var term:u32=0u;term<9u;term=term+1u){
  var color:f32=p.x;if(term>=8u){color=p.w;}else if(term>=6u){color=p.z;}else if(term>=4u){color=p.y;}
  var b:f32=u;if(term==0u){b=1.;}else if(term==2u||term==6u){b=v;}
  let c:f32=select(1.,v,term==3u||term==5u||term==7u||term==8u);
  let aa:vec3<u32>=bsParts(color);let bb:vec3<u32>=bsParts(b);let cc:vec3<u32>=bsParts(c);
  if(aa.x==0u||bb.x==0u||cc.x==0u){continue;}
  let ab:vec2<u32>=bsMultiply(aa.x,bb.x);let low:vec2<u32>=bsMultiply(ab.x,cc.x);let high:vec2<u32>=bsMultiply(ab.y,cc.x);
  let middle:u32=low.y+high.x;let product:vec3<u32>=vec3<u32>(low.x,middle,high.y+select(0u,1u,middle<low.y));
  let shift:u32=aa.y+bb.y+cc.y-minimum;let offset:u32=shift%32u;
  let negative:bool=(aa.z!=0u)!=(term==1u||term==2u||term==5u||term==7u);
  bsCompactAdd(product,shift,negative);
 }
 let bits:u32=bsCompactRound(i32(minimum)-450);
 return vec2<u32>(bits,select(0u,1u,(bits&0x7f800000u)!=0x7f800000u));
}
fn bsBounded(p:vec4<f32>,u:f32,v:f32)->vec2<u32>{
 let positive:vec2<u32>=bsPositiveBounded(p,u,v);
 if(positive.y==1u){return positive;}
 return bsWindowed(p,u,v);
}
// END BOUNDED BILINEAR
fn bsBilinear(p:vec4<f32>,u:f32,v:f32,wordLimit:u32,termCount:u32)->f32{
 let raw=bitcast<vec4<u32>>(p);let pb=select(raw,vec4<u32>(0),(raw&vec4<u32>(0x7fffffffu))==vec4<u32>(0));
 let ub=bitcast<u32>(u)&0x7fffffffu;let vb=bitcast<u32>(v)&0x7fffffffu;
 for(var i=0u;i<4u;i=i+1u){if((raw[i]&0x7fffffffu)>0x7f7fffffu){return p[i];}}
 if(ub>0x3f800000u||vb>0x3f800000u||(bitcast<u32>(u)>0x80000000u)||(bitcast<u32>(v)>0x80000000u)){return bitcast<f32>((ub&0x7fffffu)|0x7fc00000u);}
 if(all(pb==vec4<u32>(pb.x))){return bitcast<f32>(pb.x);}
 if(ub==0u&&vb==0u){return bitcast<f32>(pb.x);}if(ub==0x3f800000u&&vb==0u){return bitcast<f32>(pb.y);}
 if(ub==0u&&vb==0x3f800000u){return bitcast<f32>(pb.z);}if(ub==0x3f800000u&&vb==0x3f800000u){return bitcast<f32>(pb.w);}
 if(wordLimit==19u&&termCount==9u){let compact:vec2<u32>=bsBounded(p,u,v);if(compact.y==1u){return bitcast<f32>(compact.x);}}
 var words:array<u32,19>;
 // Iterate the nine terms without copying a large inout struct per add.
 // Runtime program bounds (19 limbs, 9 terms) prevent driver loop explosion.
 for(var term=0u;term<termCount;term=term+1u){
  var color=p.x;if(term>=8u){color=p.w;}else if(term>=6u){color=p.z;}else if(term>=4u){color=p.y;}
  var b=u;if(term==0u){b=1.;}else if(term==2u||term==6u){b=v;}
  let c=select(1.,v,term==3u||term==5u||term==7u||term==8u);
  let aa=bsParts(color);let bb=bsParts(b);let cc=bsParts(c);if(aa.x==0u||bb.x==0u||cc.x==0u){continue;}
  let ab=bsMultiply(aa.x,bb.x);let low=bsMultiply(ab.x,cc.x);let high=bsMultiply(ab.y,cc.x);
  let mid=low.y+high.x;let product=vec3<u32>(low.x,mid,high.y+select(0u,1u,mid<low.y));
  let shift=aa.y+bb.y+cc.y-3u;let offset=shift%32u;let subtract=(aa.z!=0u)!=(term==1u||term==2u||term==5u||term==7u);
  for(var part=0u;part<6u;part=part+1u){
   var index=shift/32u+part/2u;var value=product[part/2u]<<offset;
   if((part&1u)!=0u){if(offset==0u){continue;}index=index+1u;value=product[part/2u]>>(32u-offset);}
   while(index<wordLimit&&value!=0u){let old=words[index];if(subtract){words[index]=old-value;value=select(0u,1u,old<value);}else{let next=old+value;words[index]=next;value=select(0u,1u,next<old);}index=index+1u;}
  }
 }
 let negative=(words[18]&0x80000000u)!=0u;
 if(negative){for(var i=0u;i<wordLimit;i=i+1u){words[i]=~words[i];}var carry=1u;var index=0u;while(index<wordLimit&&carry!=0u){let old=words[index];words[index]=old+carry;carry=select(0u,1u,words[index]<old);index=index+1u;}}
 var last=wordLimit;for(var i=0u;i<wordLimit;i=i+1u){if(words[i]!=0u){last=i;}}
 if(last==wordLimit){return 0.;}
 let top=last*32u+bsHigh(words[last]);let shift=max(select(0u,top-23u,top>=23u),298u);
 let index=shift/32u;let offset=shift%32u;var mantissa=words[index]>>offset;if(offset!=0u){mantissa=mantissa|(words[index+1u]<<(32u-offset));}
 let guard=shift-1u;let guardBit=(words[guard/32u]&(1u<<(guard%32u)))!=0u;
 var sticky=(words[guard/32u]&((1u<<(guard%32u))-1u))!=0u;for(var i=0u;i<guard/32u;i=i+1u){sticky=sticky||words[i]!=0u;}
 if(guardBit&&(sticky||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 var exponent=select(0,i32(top)-320,top>=321u);if(mantissa>=0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}if(exponent==0&&mantissa>=0x800000u){exponent=1;}
 return bitcast<f32>(select(0u,0x80000000u,negative)|(u32(exponent)<<23u)|(mantissa&0x7fffffu));
}
// Exact k=(0,0) branch shared by scalar sampling and bounded pixel-centre
// compositor passes. Last selects win, preserving first-nonfinite neighbour
// order a,b,c,d even when a later neighbour has zero interpolation weight.
fn bsCorner4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>)->vec4<f32>{
 let mask:vec4<u32>=vec4<u32>(0x7fffffffu);let limit:vec4<u32>=vec4<u32>(0x7f7fffffu);
 let aa:vec4<u32>=bitcast<vec4<u32>>(a);let bb:vec4<u32>=bitcast<vec4<u32>>(b);
 let cc:vec4<u32>=bitcast<vec4<u32>>(c);let dd:vec4<u32>=bitcast<vec4<u32>>(d);
 var result:vec4<u32>=select(aa,vec4<u32>(0),(aa&mask)==vec4<u32>(0));
 result=select(result,dd,(dd&mask)>limit);result=select(result,cc,(cc&mask)>limit);
 result=select(result,bb,(bb&mask)>limit);result=select(result,aa,(aa&mask)>limit);
 return bitcast<vec4<f32>>(result);
}
fn bsBilinear4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,k:vec2<f32>,wordLimit:u32,termCount:u32)->vec4<f32>{
 if(all((bitcast<vec2<u32>>(k)&vec2<u32>(0x7fffffffu))==vec2<u32>(0))){return bsCorner4(a,b,c,d);}
 return vec4<f32>(bsBilinear(vec4<f32>(a.x,b.x,c.x,d.x),k.x,k.y,wordLimit,termCount),bsBilinear(vec4<f32>(a.y,b.y,c.y,d.y),k.x,k.y,wordLimit,termCount),bsBilinear(vec4<f32>(a.z,b.z,c.z,d.z),k.x,k.y,wordLimit,termCount),bsBilinear(vec4<f32>(a.w,b.w,c.w,d.w),k.x,k.y,wordLimit,termCount));}

// Compute only the requested color and alpha; no discarded RGB accumulators.
fn bsBilinearChannelAlpha(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,k:vec2<f32>,channel:u32,wordLimit:u32,termCount:u32)->vec2<f32>{
 if(all((bitcast<vec2<u32>>(k)&vec2<u32>(0x7fffffffu))==vec2<u32>(0))){let value:vec4<f32>=bsCorner4(a,b,c,d);return vec2<f32>(value[channel],value.w);}
 return vec2<f32>(bsBilinear(vec4<f32>(a[channel],b[channel],c[channel],d[channel]),k.x,k.y,wordLimit,termCount),bsBilinear(vec4<f32>(a.w,b.w,c.w,d.w),k.x,k.y,wordLimit,termCount));
}
