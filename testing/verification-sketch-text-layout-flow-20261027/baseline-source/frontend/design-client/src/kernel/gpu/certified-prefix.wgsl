// A Q64 enclosure of the actual core coefficients. This is never an
// approximate result: both signed-128 endpoints must round to identical f32
// bits, otherwise prefixResolve executes the original exact filter.
fn prefixAnyLow(value:PrefixInt,count:u32)->bool{
 let whole=count/32u;let rest=count%32u;
 for(var i=0u;i<4u;i=i+1u){
  if(i<whole&&value[i]!=0u){return true;}
  if(i==whole&&rest!=0u&&(value[i]&((1u<<rest)-1u))!=0u){return true;}
 }
 return false;
}
fn prefixRoundDyadic(input:PrefixInt,quantum:i32)->u32{
 if(all(input==PrefixInt(0u))){return 0u;}
 let sign=input.w&0x80000000u;var value=input;if(sign!=0u){value=prefix_neg(value);}
 let top=prefix_high(value);let exponent=top+quantum;let shift=max(exponent-23,-149)-quantum;
 var mantissa=0u;
 if(shift<=0){mantissa=value.x<<u32(-shift);}
 else if(shift<128){
  let word=u32(shift)/32u;let rest=u32(shift)%32u;mantissa=value[word]>>rest;
  if(rest!=0u&&word<3u){mantissa=mantissa|(value[word+1u]<<(32u-rest));}
  let guard=u32(shift)-1u;
  if((value[guard/32u]&(1u<<(guard%32u)))!=0u&&(prefixAnyLow(value,guard)||(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 }
 var raw=0u;if(exponent>=-126){raw=u32(exponent+127);}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;raw=raw+1u;}
 if(raw==0u&&mantissa>=0x800000u){raw=1u;}
 if(raw>=255u){return sign|0x7f800000u;}
 return sign|(raw<<23u)|(mantissa&0x7fffffu);
}
fn prefixCertifiedLoad(index:u32)->u32{
 let size=vec2<u32>(textureDimensions(sourceC,0));
 let p=vec2<i32>(i32(index%size.x),i32(index/size.x));
 let b=vec4<u32>(round(textureLoad(sourceC,p,0)*255.));
 return b.x|(b.y<<8u)|(b.z<<16u)|(b.w<<24u);
}
fn prefixCertifiedCoefficient(distance:u32)->PrefixInt{
 let at=4u+2u*distance;
 return PrefixInt(prefixCertifiedLoad(at),prefixCertifiedLoad(at+1u),0u,0u);
}
fn prefixCertifiedCoefficients(interior:u32)->bool{
 let reach=rfLoad(2u);let size=vec2<u32>(textureDimensions(sourceC,0));let bound=u(49u).w;
 // The core validated every Q64 coefficient and its intermediate bound
 // against the complete uploaded bytes. Only the driver's private live
 // B/C resource pair can supply this mode and bound; public scene hints do not.
 return PREFIX_CERTIFIED_TENT&&interior>=31u&&interior<=511u&&reach>=interior&&reach-interior<=4u&&
  bound>=1.&&bound<=120.&&floor(bound)==bound&&
  prefixCertifiedLoad(0u)==0x38345143u&&prefixCertifiedLoad(1u)==reach&&
  prefixCertifiedLoad(2u)==48u&&prefixCertifiedLoad(3u)==64u&&size.x*size.y>=4u+2u*(reach+1u);
}
fn prefixCertified(base:u32,x:u32,length:u32,interior:u32,minimum:u32,maximum:u32)->vec2<u32>{
 if(maximum==0u){return vec2<u32>(0u,1u);}
 let center=prefixCertifiedCoefficient(0u);
 let slope=prefix_sub(prefixCertifiedCoefficient(1u),prefixCertifiedCoefficient(2u));
 let intercept=prefix_add(prefixCertifiedCoefficient(1u),slope);
 let lo=u32(max(0,i32(x)-i32(interior)));let hi=min(length,x+interior+1u);
 let before=prefixPairAt(base,lo);let middle=prefixPairAt(base,x);let afterCenter=prefixPairAt(base,x+1u);let after=prefixPairAt(base,hi);
 let left=prefix_sub(middle.sum,before.sum);let right=prefix_sub(after.sum,afterCenter.sum);
 let sums=prefix_add(left,right);
 let distances=prefix_add(prefix_sub(prefix_mul_u32(left,x),prefix_sub(middle.moment,before.moment)),
  prefix_sub(prefix_sub(after.moment,afterCenter.moment),prefix_mul_u32(right,x)));
 var numerator=prefix_add(prefix_mul(prefixValueAt(base,x),center),
  prefix_sub(prefix_mul(sums,intercept),prefix_mul(distances,slope)));
 let reach=rfLoad(2u);
 for(var d=interior+1u;d<=reach;d=d+1u){
  let samples=prefix_add(prefixValueOrZero(base,i32(x)-i32(d),length),prefixValueOrZero(base,i32(x)+i32(d),length));
  numerator=prefix_add(numerator,prefix_mul(samples,prefixCertifiedCoefficient(d)));
 }
 // |sample| <= M in the row's integer quantum. Center and each tail tap
 // contribute <= M; paired interior errors contribute 2*M*(d+3). This bound
 // permits mixed signs and cancellation without trusting sampled extrema.
 let span=maximum-minimum;
 let magnitude=prefix_shl(PrefixInt(0xffffffu,0u,0u,0u),span);
 let error=prefix_mul_u32(magnitude,interior*interior+7u*interior+1u+2u*(reach-interior));
 // Denominator is exactly 2^64. Direct guard/sticky-bit RNE avoids the
 // general rational divider, without a floating estimate or changed bits.
 let quantum=i32(minimum)-214;
 let low=prefixRoundDyadic(prefix_sub(numerator,error),quantum);
 let high=prefixRoundDyadic(prefix_add(numerator,error),quantum);
 return vec2<u32>(low,select(0u,1u,low==high&&(low&0x7f800000u)!=0x7f800000u));
}
