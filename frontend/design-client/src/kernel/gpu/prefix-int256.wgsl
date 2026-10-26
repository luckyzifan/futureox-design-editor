// Weighted rational windows need more bits than their unweighted scans.
// Keep the existing signed-128 scan/storage and widen only local arithmetic.
alias WidePrefixInt = array<u32,8>;
fn wide_zero()->WidePrefixInt{return WidePrefixInt(0u,0u,0u,0u,0u,0u,0u,0u);}
fn wide_unsigned(a:PrefixInt)->WidePrefixInt{return WidePrefixInt(a.x,a.y,a.z,a.w,0u,0u,0u,0u);}
fn wide_signed(a:PrefixInt)->WidePrefixInt{
 let sign=select(0u,0xffffffffu,(a.w&0x80000000u)!=0u);
 return WidePrefixInt(a.x,a.y,a.z,a.w,sign,sign,sign,sign);
}
fn wide_add(a:WidePrefixInt,b:WidePrefixInt)->WidePrefixInt{
 var result=wide_zero();var carry=0u;
 for(var i=0u;i<8u;i=i+1u){let sum=a[i]+b[i];let value=sum+carry;
  carry=select(0u,1u,sum<a[i]||value<sum);result[i]=value;}
 return result;
}
fn wide_sub(a:WidePrefixInt,b:WidePrefixInt)->WidePrefixInt{
 var result=wide_zero();var borrow=0u;
 for(var i=0u;i<8u;i=i+1u){let part=a[i]-b[i];let value=part-borrow;
  borrow=select(0u,1u,a[i]<b[i]||part<borrow);result[i]=value;}
 return result;
}
fn wide_neg(a:WidePrefixInt)->WidePrefixInt{return wide_sub(wide_zero(),a);}
fn wide_shl(a:WidePrefixInt,shift:u32)->WidePrefixInt{
 if(shift==0u){return a;}var result=wide_zero();if(shift>=256u){return result;}
 let words=shift/32u;let bits=shift%32u;
 for(var i=0u;i<8u;i=i+1u){if(i<words){continue;}let at=i-words;
  result[i]=a[at]<<bits;if(bits!=0u&&at>0u){result[i]=result[i]|(a[at-1u]>>(32u-bits));}}
 return result;
}
fn wide_mul_u32(a:WidePrefixInt,k:u32)->WidePrefixInt{
 var result=wide_zero();var carry=0u;
 for(var i=0u;i<8u;i=i+1u){let product=bsMultiply(a[i],k);let value=product.x+carry;
  carry=product.y+select(0u,1u,value<product.x);result[i]=value;}
 return result;
}
fn wide_mul(a:WidePrefixInt,b:WidePrefixInt)->WidePrefixInt{
 var result=wide_zero();for(var i=0u;i<8u;i=i+1u){if(b[i]==0u){continue;}
  result=wide_add(result,wide_shl(wide_mul_u32(a,b[i]),i*32u));}return result;
}
fn wide_compare(a:WidePrefixInt,b:WidePrefixInt)->i32{
 for(var i=7;i>=0;i=i-1){if(a[u32(i)]<b[u32(i)]){return -1;}if(a[u32(i)]>b[u32(i)]){return 1;}}return 0;
}
fn wide_high(a:WidePrefixInt)->i32{
 for(var i=7;i>=0;i=i-1){if(a[u32(i)]!=0u){return i*32+i32(bsHigh(a[u32(i)]));}}return -1;
}
// Exact nearest-even binary32 conversion. The 24-step integer division needs
// no floating estimate. Every shift is proved in-range before it is executed.
fn wide_round(input:WidePrefixInt,divisorBase:WidePrefixInt,quantum:i32)->vec2<u32>{
 let dh=wide_high(divisorBase);
 if(dh<0||dh>183||quantum < -149||quantum > 104){return vec2<u32>(0u);}
 if(wide_high(input)<0){return vec2<u32>(0u,1u);}
 let sign=input[7]&0x80000000u;var magnitude=input;if(sign!=0u){magnitude=wide_neg(magnitude);}
 let mh=wide_high(magnitude);var power=mh-dh;
 if(power>=0){if(wide_compare(magnitude,wide_shl(divisorBase,u32(power)))<0){power=power-1;}}
 else{if(wide_compare(wide_shl(magnitude,u32(-power)),divisorBase)<0){power=power-1;}}
 var exponent=power+quantum;
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 let unit=max(exponent-23,-149);let shift=unit-quantum;
 if(shift>=256||shift<=-256||mh+max(0,-shift)>253||dh+max(0,shift)+23>253){return vec2<u32>(0u);}
 var remainder=magnitude;var divisor=divisorBase;
 if(shift<0){remainder=wide_shl(magnitude,u32(-shift));}else{divisor=wide_shl(divisorBase,u32(shift));}
 var mantissa=0u;
 for(var bit=23;bit>=0;bit=bit-1){let term=wide_shl(divisor,u32(bit));
  if(wide_compare(remainder,term)>=0){remainder=wide_sub(remainder,term);mantissa=mantissa|(1u<<u32(bit));}}
 let comparison=wide_compare(wide_shl(remainder,1u),divisor);
 if(comparison>0||(comparison==0&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 var raw=0u;if(exponent>=-126){raw=u32(exponent+127);}
 if(raw==0u&&mantissa>=0x800000u){raw=1u;}
 return vec2<u32>(sign|(raw<<23u)|(mantissa&0x7fffffu),1u);
}

fn wide_coefficient(index:u32)->WidePrefixInt{
 let cw=rfLoad(0u);var value=wide_zero();
 for(var i=0u;i<cw&&i<6u;i=i+1u){value[i]=rfLoad(4u+cw*index+i);}return value;
}
fn prefixRational256(base:u32,x:u32,length:u32,interior:u32,quantum:i32)->vec2<u32>{
 let center=wide_coefficient(1u);
 let slope=wide_sub(wide_coefficient(2u),wide_coefficient(3u));
 let intercept=wide_add(wide_coefficient(2u),slope);
 let lo=u32(max(0,i32(x)-i32(interior)));let hi=min(length,x+interior+1u);
 let before=prefixPairAt(base,lo);let middle=prefixPairAt(base,x);let afterCenter=prefixPairAt(base,x+1u);let after=prefixPairAt(base,hi);
 let leftSum=prefix_sub(middle.sum,before.sum);let rightSum=prefix_sub(after.sum,afterCenter.sum);
 let sums=wide_signed(prefix_add(leftSum,rightSum));
 let distances=wide_signed(prefix_add(prefix_sub(prefix_mul_u32(leftSum,x),prefix_sub(middle.moment,before.moment)),
  prefix_sub(prefix_sub(after.moment,afterCenter.moment),prefix_mul_u32(rightSum,x))));
 var numerator=wide_add(wide_mul(wide_signed(prefixValueAt(base,x)),center),wide_sub(wide_mul(sums,intercept),wide_mul(distances,slope)));
 let reach=rfLoad(2u);
 for(var d=interior+1u;d<=reach;d=d+1u){
  let samples=wide_signed(prefix_add(prefixValueOrZero(base,i32(x)-i32(d),length),prefixValueOrZero(base,i32(x)+i32(d),length)));
  numerator=wide_add(numerator,wide_mul(samples,wide_coefficient(d+1u)));
 }
 return wide_round(numerator,wide_coefficient(0u),quantum);
}
