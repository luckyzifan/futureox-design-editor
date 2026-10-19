// Exact bilinear: Q447, 19 limbs, 9 dyadic terms, one RNE.
uint bsHigh(uint v){uint n=0u;if(v>=65536u){v>>=16u;n+=16u;}if(v>=256u){v>>=8u;n+=8u;}if(v>=16u){v>>=4u;n+=4u;}if(v>=4u){v>>=2u;n+=2u;}if(v>=2u)n++;return n;}
uvec2 bsMultiply(uint a,uint b){uint a0=a&65535u,a1=a>>16u,b0=b&65535u,b1=b>>16u,p0=a0*b0,p1=a1*b0,p2=a0*b1,carry=(p0>>16u)+(p1&65535u)+(p2&65535u);return uvec2((p0&65535u)|(carry<<16u),a1*b1+(p1>>16u)+(p2>>16u)+(carry>>16u));}
uvec3 bsParts(float value){uint bits=floatBitsToUint(value),exponent=(bits>>23u)&255u;return uvec3((bits&0x7fffffu)|(exponent!=0u?0x800000u:0u),max(exponent,1u),bits>>31u);}
// BEGIN GENERATED BOUNDED BILINEAR
uint sbSelect(uint a,uint b,bool s){return s?b:a;}
int sbSelect(int a,int b,bool s){return s?b:a;}
float sbSelect(float a,float b,bool s){return s?b:a;}
// Algebraically identical to the nine exact dyadic terms below. There is
// no intermediate floating-point rounding. u=U/2^ku and v=V/2^kv are
// decomposed from bits; ku,kv<=31. Four nonnegative integer weights sum
// exactly to 2^(ku+kv). With exponent span<=48 and span+ku+kv<=102,
// sum(abs(products)) < 2^(24+span+ku+kv) <= 2^126. Every signed
// partial sum stays strictly inside signed 128-bit range. Only the final RNE rounds.
// Unsupported weight denominators/exponent spans retain the 19-limb path.
uint bsCompact[4];
// Both bounded callers prove shift<=50 and signed partial sums<2^126.
// Assemble each admitted product (at most 86 bits) once and use a fixed 128-bit carry
// chain, preserving the former partial-word additions modulo 2^128.
uint bsCompactAdd(uvec3 product,uint shift,bool negative){
 uint offset=shift%32u;
 uvec4 words=uvec4(product.x<<offset,product.y<<offset,product.z<<offset,0u);
 if(offset!=0u){words=words|uvec4(0u,product.x>>(32u-offset),product.y>>(32u-offset),product.z>>(32u-offset));}
 if(shift>=32u){words=uvec4(0u,words.xyz);}
 uint carry=sbSelect(0u,1u,negative);
 uint old0=bsCompact[0u];uint part0=words.x;if(negative){part0=~part0;}
 uint sum0=old0+part0;uint next0=sum0+carry;
 carry=sbSelect(0u,1u,sum0<old0||next0<sum0);bsCompact[0u]=next0;
 uint old1=bsCompact[1u];uint part1=words.y;if(negative){part1=~part1;}
 uint sum1=old1+part1;uint next1=sum1+carry;
 carry=sbSelect(0u,1u,sum1<old1||next1<sum1);bsCompact[1u]=next1;
 uint old2=bsCompact[2u];uint part2=words.z;if(negative){part2=~part2;}
 uint sum2=old2+part2;uint next2=sum2+carry;
 carry=sbSelect(0u,1u,sum2<old2||next2<sum2);bsCompact[2u]=next2;
 uint old3=bsCompact[3u];uint part3=words.w;if(negative){part3=~part3;}
 uint sum3=old3+part3;uint next3=sum3+carry;
 carry=sbSelect(0u,1u,sum3<old3||next3<sum3);bsCompact[3u]=next3;
 return 0u;
}
uvec2 bsFraction(uint bits){
 uint raw=bits&0x7fffffffu;
 if(raw==0u){return uvec2(0u,0u);}
 if(raw>0x3f800000u||bits>0x80000000u){return uvec2(0u,255u);}
 uint exponent=(raw>>23u)&255u;
 uint numerator=(raw&0x7fffffu)|sbSelect(0u,0x800000u,exponent!=0u);
 uint denominator=150u-max(exponent,1u);
 while((numerator&1u)==0u&&denominator>0u){numerator=numerator>>1u;denominator=denominator-1u;}
 return uvec2(numerator,denominator);
}
uint bsCompactRound(int quantum){
 bool negative=(bsCompact[3]&0x80000000u)!=0u;
 if(negative){
  for(uint j=0u;j<4u;j=j+1u){bsCompact[j]=~bsCompact[j];}
  uint carry=1u;uint j=0u;
  while(j<4u&&carry!=0u){uint old=bsCompact[j];bsCompact[j]=old+carry;carry=sbSelect(0u,1u,bsCompact[j]<old);j=j+1u;}
 }
 uint last=4u;for(uint j=0u;j<4u;j=j+1u){if(bsCompact[j]!=0u){last=j;}}
 if(last==4u){return 0u;}
 int top=int(last*32u+bsHigh(bsCompact[last]));int exponent=top+quantum;
 int shift=max(exponent-23,-149)-quantum;
 uint mantissa=0u;
 if(shift<=0){mantissa=bsCompact[0]<<uint(-shift);}
 else if(shift<128){
  uint index=uint(shift)/32u;uint offset=uint(shift)%32u;
  mantissa=bsCompact[index]>>offset;
  if(offset!=0u&&index+1u<4u){mantissa=mantissa|(bsCompact[index+1u]<<(32u-offset));}
  uint guard=uint(shift)-1u;uint bit=guard%32u;
  bool guardBit=(bsCompact[guard/32u]&(1u<<bit))!=0u;
  bool sticky=(bsCompact[guard/32u]&((1u<<bit)-1u))!=0u;
  for(uint j=0u;j<guard/32u;j=j+1u){sticky=sticky||bsCompact[j]!=0u;}
  if(guardBit&&(sticky||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 }
 uint rawExponent=0u;if(exponent>=-126){rawExponent=uint(exponent+127);}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;rawExponent=rawExponent+1u;}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 uint sign=sbSelect(0u,0x80000000u,negative);
 if(rawExponent>=255u){return sign|0x7f800000u;}
 return sign|(rawExponent<<23u)|(mantissa&0x7fffffu);
}
uvec2 bsPositiveBounded(vec4 p,float u,float v){
 uvec2 x=bsFraction(floatBitsToUint(u));uvec2 y=bsFraction(floatBitsToUint(v));
 if(x.y>31u||y.y>31u){return uvec2(0u,0u);}
 uvec4 raw=floatBitsToUint(p);
 uint minimum=255u;uint maximum=0u;
 for(uint i=0u;i<4u;i=i+1u){
  uint exponent=(raw[i]>>23u)&255u;if(exponent==255u){return uvec2(0u,0u);}
  if((raw[i]&0x7fffffffu)!=0u){minimum=min(minimum,max(exponent,1u));maximum=max(maximum,max(exponent,1u));}
 }
 if(maximum==0u){return uvec2(0u,1u);}
 if(maximum-minimum>48u||maximum-minimum+x.y+y.y>102u){return uvec2(0u,0u);}
 uint dx=1u<<x.y;uint dy=1u<<y.y;
 for(uint j=0u;j<4u;j=j+1u){bsCompact[j]=0u;}
 for(uint term=0u;term<4u;term=term+1u){
  uint exponent=(raw[term]>>23u)&255u;
  uint mantissa=(raw[term]&0x7fffffu)|sbSelect(0u,0x800000u,exponent!=0u);
  if(mantissa==0u){continue;}
  uint horizontal=sbSelect(dx-x.x,x.x,(term&1u)!=0u);uint vertical=sbSelect(dy-y.x,y.x,term>=2u);
  if(horizontal==0u||vertical==0u){continue;}
  uvec2 weight=bsMultiply(horizontal,vertical);
  uvec2 low=bsMultiply(weight.x,mantissa);uvec2 high=bsMultiply(weight.y,mantissa);
  uint middle=low.y+high.x;uvec3 product=uvec3(low.x,middle,high.y+sbSelect(0u,1u,middle<low.y));
  uint shift=max(exponent,1u)-minimum;uint offset=shift%32u;bool negative=(raw[term]>>31u)!=0u;
  bsCompactAdd(product,shift,negative);
 }
 uint bits=bsCompactRound(int(minimum)-150-int(x.y)-int(y.y));
 return uvec2(bits,sbSelect(0u,1u,(bits&0x7f800000u)!=0x7f800000u));
}
// Secondary exact path for fine dyadic fractions. Retain the original nine
// monomials and their signs/order, but shift their common quantum to the
// smallest effective exponent sum. Each mantissa product is <2^72; when
// exponent-sum span<=50, the sum of all nine absolute terms is <2^126.
// This bounds every intermediate signed 128-bit accumulation, even when
// the final value nearly cancels. No terms or residual bits are discarded.
uvec2 bsWindowed(vec4 p,float u,float v){
 uint ub=floatBitsToUint(u);uint vb=floatBitsToUint(v);
 if((ub&0x7fffffffu)>0x3f800000u||(vb&0x7fffffffu)>0x3f800000u||ub>0x80000000u||vb>0x80000000u){return uvec2(0u,0u);}
 uvec4 raw=floatBitsToUint(p);
 for(uint i=0u;i<4u;i=i+1u){if(((raw[i]>>23u)&255u)==255u){return uvec2(0u,0u);}}
 uint minimum=1024u;uint maximum=0u;
 for(uint term=0u;term<9u;term=term+1u){
  float color=p.x;if(term>=8u){color=p.w;}else if(term>=6u){color=p.z;}else if(term>=4u){color=p.y;}
  float b=u;if(term==0u){b=1.;}else if(term==2u||term==6u){b=v;}
  float c=sbSelect(1.,v,term==3u||term==5u||term==7u||term==8u);
  uvec3 aa=bsParts(color);uvec3 bb=bsParts(b);uvec3 cc=bsParts(c);
  if(aa.x==0u||bb.x==0u||cc.x==0u){continue;}
  uint exponent=aa.y+bb.y+cc.y;minimum=min(minimum,exponent);maximum=max(maximum,exponent);
 }
 if(maximum==0u){return uvec2(0u,1u);}
 if(maximum-minimum>50u){return uvec2(0u,0u);}
 for(uint j=0u;j<4u;j=j+1u){bsCompact[j]=0u;}
 for(uint term=0u;term<9u;term=term+1u){
  float color=p.x;if(term>=8u){color=p.w;}else if(term>=6u){color=p.z;}else if(term>=4u){color=p.y;}
  float b=u;if(term==0u){b=1.;}else if(term==2u||term==6u){b=v;}
  float c=sbSelect(1.,v,term==3u||term==5u||term==7u||term==8u);
  uvec3 aa=bsParts(color);uvec3 bb=bsParts(b);uvec3 cc=bsParts(c);
  if(aa.x==0u||bb.x==0u||cc.x==0u){continue;}
  uvec2 ab=bsMultiply(aa.x,bb.x);uvec2 low=bsMultiply(ab.x,cc.x);uvec2 high=bsMultiply(ab.y,cc.x);
  uint middle=low.y+high.x;uvec3 product=uvec3(low.x,middle,high.y+sbSelect(0u,1u,middle<low.y));
  uint shift=aa.y+bb.y+cc.y-minimum;uint offset=shift%32u;
  bool negative=(aa.z!=0u)!=(term==1u||term==2u||term==5u||term==7u);
  bsCompactAdd(product,shift,negative);
 }
 uint bits=bsCompactRound(int(minimum)-450);
 return uvec2(bits,sbSelect(0u,1u,(bits&0x7f800000u)!=0x7f800000u));
}
uvec2 bsBounded(vec4 p,float u,float v){
 uvec2 positive=bsPositiveBounded(p,u,v);
 if(positive.y==1u){return positive;}
 return bsWindowed(p,u,v);
}
// END GENERATED BOUNDED BILINEAR
float bsBilinear(vec4 p,float u,float v,uint wordLimit,uint termCount){
 uvec4 pb=floatBitsToUint(p);for(int i=0;i<4;i++)if((pb[i]&0x7fffffffu)==0u)pb[i]=0u;
 uint ub=floatBitsToUint(u)&0x7fffffffu,vb=floatBitsToUint(v)&0x7fffffffu;
 for(int i=0;i<4;i++)if((pb[i]&0x7fffffffu)>0x7f7fffffu)return p[i];
 if(ub>0x3f800000u||vb>0x3f800000u||floatBitsToUint(u)>0x80000000u||floatBitsToUint(v)>0x80000000u)return uintBitsToFloat((ub&0x7fffffu)|0x7fc00000u);
 if(all(equal(pb,uvec4(pb.x))))return uintBitsToFloat(pb.x);
 if(ub==0u&&vb==0u)return uintBitsToFloat(pb.x);if(ub==0x3f800000u&&vb==0u)return uintBitsToFloat(pb.y);
 if(ub==0u&&vb==0x3f800000u)return uintBitsToFloat(pb.z);if(ub==0x3f800000u&&vb==0x3f800000u)return uintBitsToFloat(pb.w);
 if(wordLimit==19u&&termCount==9u){uvec2 compact=bsBounded(p,u,v);if(compact.y==1u)return uintBitsToFloat(compact.x);}
 uint words[19];for(uint i=0u;i<wordLimit;i++)words[i]=0u;
 for(uint term=0u;term<termCount;term++){
  float color=term>=8u?p.w:term>=6u?p.z:term>=4u?p.y:p.x;
  float b=term==0u?1.:(term==2u||term==6u)?v:u,c=(term==3u||term==5u||term==7u||term==8u)?v:1.;
  uvec3 aa=bsParts(color),bb=bsParts(b),cc=bsParts(c);if(aa.x==0u||bb.x==0u||cc.x==0u)continue;
  uvec2 ab=bsMultiply(aa.x,bb.x),low=bsMultiply(ab.x,cc.x),high=bsMultiply(ab.y,cc.x);
  uint mid=low.y+high.x;uvec3 product=uvec3(low.x,mid,high.y+uint(mid<low.y));
  uint shift=aa.y+bb.y+cc.y-3u,offset=shift%32u;bool subtract=(aa.z!=0u)!=(term==1u||term==2u||term==5u||term==7u);
  for(uint part=0u;part<6u;part++){
   uint index=shift/32u+part/2u,value=product[part/2u]<<offset;
   if((part&1u)!=0u){if(offset==0u)continue;index++;value=product[part/2u]>>(32u-offset);}
   while(index<wordLimit&&value!=0u){uint old=words[index];if(subtract){words[index]=old-value;value=uint(old<value);}else{uint next=old+value;words[index]=next;value=uint(next<old);}index++;}
  }
 }
 bool negative=(words[18]&0x80000000u)!=0u;
 if(negative){for(uint i=0u;i<wordLimit;i++)words[i]=~words[i];uint carry=1u,index=0u;while(index<wordLimit&&carry!=0u){uint old=words[index];words[index]=old+carry;carry=uint(words[index]<old);index++;}}
 uint last=wordLimit;for(uint i=0u;i<wordLimit;i++)if(words[i]!=0u)last=i;
 if(last==wordLimit)return 0.;uint top=last*32u+bsHigh(words[last]),shift=max(top>=23u?top-23u:0u,298u);
 uint index=shift/32u,offset=shift%32u,mantissa=words[index]>>offset;if(offset!=0u)mantissa|=words[index+1u]<<(32u-offset);
 uint guard=shift-1u;bool guardBit=(words[guard/32u]&(1u<<(guard%32u)))!=0u,sticky=(words[guard/32u]&((1u<<(guard%32u))-1u))!=0u;
 for(uint i=0u;i<guard/32u;i++)sticky=sticky||words[i]!=0u;
 if(guardBit&&(sticky||(mantissa&1u)!=0u))mantissa++;
 int exponent=top>=321u?int(top)-320:0;if(mantissa>=0x1000000u){mantissa>>=1u;exponent++;}if(exponent==0&&mantissa>=0x800000u)exponent=1;
 return uintBitsToFloat((negative?0x80000000u:0u)|(uint(exponent)<<23u)|(mantissa&0x7fffffu));
}
// Same ordered nonfinite and signed-zero contract as shared WGSL bsCorner4.
vec4 bsCorner4(vec4 a,vec4 b,vec4 c,vec4 d){
 uvec4 aa=floatBitsToUint(a),bb=floatBitsToUint(b),cc=floatBitsToUint(c),dd=floatBitsToUint(d),result=aa;
 for(int i=0;i<4;i++){
  if((aa[i]&0x7fffffffu)==0u)result[i]=0u;
  if((dd[i]&0x7fffffffu)>0x7f7fffffu)result[i]=dd[i];
  if((cc[i]&0x7fffffffu)>0x7f7fffffu)result[i]=cc[i];
  if((bb[i]&0x7fffffffu)>0x7f7fffffu)result[i]=bb[i];
  if((aa[i]&0x7fffffffu)>0x7f7fffffu)result[i]=aa[i];
 }
 return uintBitsToFloat(result);
}
vec4 bsBilinear4(vec4 a,vec4 b,vec4 c,vec4 d,vec2 k,uint wordLimit,uint termCount){
 if(all(equal(floatBitsToUint(k)&uvec2(0x7fffffffu),uvec2(0))))return bsCorner4(a,b,c,d);
 return vec4(bsBilinear(vec4(a.x,b.x,c.x,d.x),k.x,k.y,wordLimit,termCount),bsBilinear(vec4(a.y,b.y,c.y,d.y),k.x,k.y,wordLimit,termCount),bsBilinear(vec4(a.z,b.z,c.z,d.z),k.x,k.y,wordLimit,termCount),bsBilinear(vec4(a.w,b.w,c.w,d.w),k.x,k.y,wordLimit,termCount));}
