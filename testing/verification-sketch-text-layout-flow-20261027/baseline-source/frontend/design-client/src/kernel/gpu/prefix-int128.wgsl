// Exact signed-128 operations and rational-to-binary32 rounding. Requires
// bsHigh and bsMultiply from sampling.wgsl. Arithmetic/rounding results are exact;
// native floating arithmetic only proposes an independently certified quotient.
alias PrefixInt = vec4<u32>;

fn prefix_add(a:PrefixInt,b:PrefixInt)->PrefixInt {
 var result=PrefixInt(0u);var carry=0u;
 for(var i=0u;i<4u;i=i+1u){let sum=a[i]+b[i];let value=sum+carry;
  carry=select(0u,1u,sum<a[i]||value<sum);result[i]=value;}
 return result;
}
fn prefix_sub(a:PrefixInt,b:PrefixInt)->PrefixInt {
 var result=PrefixInt(0u);var borrow=0u;
 for(var i=0u;i<4u;i=i+1u){let part=a[i]-b[i];let value=part-borrow;
  borrow=select(0u,1u,a[i]<b[i]||part<borrow);result[i]=value;}
 return result;
}
fn prefix_neg(a:PrefixInt)->PrefixInt{return prefix_add(~a,PrefixInt(1u,0u,0u,0u));}
fn prefix_mul_u32(a:PrefixInt,k:u32)->PrefixInt {
 var result=PrefixInt(0u);var carry=0u;
 for(var i=0u;i<4u;i=i+1u){let product=bsMultiply(a[i],k);let value=product.x+carry;
  carry=product.y+select(0u,1u,value<product.x);result[i]=value;}
 return result;
}
fn prefix_mul_i32(a:PrefixInt,k:i32)->PrefixInt {
 if(k<0){return prefix_neg(prefix_mul_u32(a,u32(-k)));}
 return prefix_mul_u32(a,u32(k));
}
fn prefix_mul(a:PrefixInt,b:PrefixInt)->PrefixInt {
 var result=PrefixInt(0u);
 // Exact zero words contribute nothing modulo 2^128. Rational coefficient
 // words are shared by the pass, so this also avoids uniform zero work.
 for(var i=0u;i<4u;i=i+1u){if(b[i]==0u){continue;}result=prefix_add(result,prefix_shl(prefix_mul_u32(a,b[i]),i*32u));}
 return result;
}
fn prefix_shl(a:PrefixInt,shift:u32)->PrefixInt {
 if(shift==0u){return a;}if(shift>=128u){return PrefixInt(0u);}
 let words=shift/32u;let bits=shift%32u;var result=PrefixInt(0u);
 for(var i=0u;i<4u;i=i+1u){if(i<words){continue;}let sourceIndex=i-words;
  result[i]=a[sourceIndex]<<bits;
  if(bits!=0u&&sourceIndex>0u){result[i]=result[i]|(a[sourceIndex-1u]>>(32u-bits));}
 }
 return result;
}
fn prefix_compare(a:PrefixInt,b:PrefixInt)->i32 {
 for(var i=3;i>=0;i=i-1){if(a[u32(i)]<b[u32(i)]){return -1;}if(a[u32(i)]>b[u32(i)]){return 1;}}
 return 0;
}
fn prefix_high(a:PrefixInt)->i32 {
 for(var i=3;i>=0;i=i-1){if(a[u32(i)]!=0u){return i*32+i32(bsHigh(a[u32(i)]));}}
 return -1;
}
// Exact finite binary32 to signed integer at quantum Emin-150. Call only after
// the complete line/channel admission proves finite values and span <=40.
fn prefix_sample(bits:u32,minimum:u32)->PrefixInt {
 let exponent=(bits>>23u)&255u;let mantissa=(bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
 if(mantissa==0u){return PrefixInt(0u);}
 let value=prefix_shl(PrefixInt(mantissa,0u,0u,0u),max(exponent,1u)-minimum);
 if((bits&0x80000000u)!=0u){return prefix_neg(value);}return value;
}
struct PrefixDivision { remainder:PrefixInt, quotient:u32, accepted:u32 }
// Floating arithmetic proposes a quotient only. Every accepted result is
// independently certified with exact integers; an inaccurate estimate falls
// back to the existing bit-at-a-time division.
fn prefix_float(value:PrefixInt)->f32 {
 return f32(f32(f32(f32(value.w)*79228162514264337593543950336.0+
  f32(value.z)*18446744073709551616.0)+f32(value.y)*4294967296.0)+f32(value.x));
}
fn prefix_try_quotient(numerator:PrefixInt,divisor:PrefixInt,estimate:f32)->PrefixDivision {
 let declined=PrefixDivision(numerator,0u,0u);let dh=prefix_high(divisor);
 // N < 2^126, D < 2^103, q < 2^24 imply D*q < 2^127.
 // Thus multiplication and every bounded correction are exact in 128 bits.
 if(prefix_high(numerator)>125||dh<0||dh>102){return declined;}
 if(!(estimate>=0.0&&estimate<=16777216.0)){return declined;}
 var quotient=min(u32(estimate),16777215u);
 var product=prefix_mul_u32(divisor,quotient);
 for(var correction=0u;correction<=8u;correction=correction+1u){
  if(prefix_compare(product,numerator)>0){
   if(correction==8u||quotient==0u){return declined;}
   quotient=quotient-1u;product=prefix_sub(product,divisor);
  }else{
   let remainder=prefix_sub(numerator,product);
   if(prefix_compare(remainder,divisor)<0){return PrefixDivision(remainder,quotient,1u);}
   if(correction==8u||quotient==16777215u){return declined;}
   quotient=quotient+1u;product=prefix_add(product,divisor);
  }
 }
 return declined;
}
fn prefix_divide_fast(numerator:PrefixInt,divisor:PrefixInt)->PrefixDivision {
 let dh=prefix_high(divisor);
 if(prefix_high(numerator)>125||dh<0||dh>102){return PrefixDivision(numerator,0u,0u);}
 return prefix_try_quotient(numerator,divisor,prefix_float(numerator)/prefix_float(divisor));
}
// bits, accepted. Invalid protocol values decline; callers must use the old
// exact filter and count the decline, never treat its zero placeholder as data.
fn prefix_round_ratio(input:PrefixInt,denominator:u32,quantum:i32)->vec2<u32> {
 if(denominator==0u||denominator>1572864u||quantum < -149||quantum > 104){return vec2<u32>(0u);}
 if(all(input==PrefixInt(0u))){return vec2<u32>(0u,1u);}
 let sign=input.w&0x80000000u;var magnitude=input;if(sign!=0u){magnitude=prefix_neg(magnitude);}
 let divisorBase=PrefixInt(denominator,0u,0u,0u);
 var power=prefix_high(magnitude)-i32(bsHigh(denominator));
 if(power>=0){if(prefix_compare(magnitude,prefix_shl(divisorBase,u32(power)))<0){power=power-1;}}
 else{if(prefix_compare(prefix_shl(magnitude,u32(-power)),divisorBase)<0){power=power-1;}}
 var exponent=power+quantum;
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 let unit=max(exponent-23,-149);let shift=unit-quantum;
 if(shift>=128||shift<=-128){return vec2<u32>(0u);}
 var remainder=magnitude;var divisor=divisorBase;
 if(shift<0){remainder=prefix_shl(magnitude,u32(-shift));}else{divisor=prefix_shl(divisorBase,u32(shift));}
 var mantissa=0u;
 let candidate=prefix_divide_fast(remainder,divisor);
 if(candidate.accepted!=0u){remainder=candidate.remainder;mantissa=candidate.quotient;}else{
 for(var bit=23;bit>=0;bit=bit-1){let term=prefix_shl(divisor,u32(bit));
  if(prefix_compare(remainder,term)>=0){remainder=prefix_sub(remainder,term);mantissa=mantissa|(1u<<u32(bit));}
 }
 }
 let comparison=prefix_compare(prefix_shl(remainder,1u),divisor);
 if(comparison>0||(comparison==0&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 var rawExponent=0u;if(exponent>=-126){rawExponent=u32(exponent+127);}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 return vec2<u32>(sign|(rawExponent<<23u)|(mantissa&0x7fffffu),1u);
}

// Same nearest-even division for the exact coefficient packet's denominator.
// Admission bounds signed accumulation to 123 bits and denominator to 96;
// the extra guards also cover cancellation/subnormal normalization shifts.
fn prefix_round_wide(input:PrefixInt,divisorBase:PrefixInt,quantum:i32)->vec2<u32> {
 let dh=prefix_high(divisorBase);
 if(dh<0||dh>95||quantum < -149||quantum > 104){return vec2<u32>(0u);}
 if(all(input==PrefixInt(0u))){return vec2<u32>(0u,1u);}
 let sign=input.w&0x80000000u;var magnitude=input;if(sign!=0u){magnitude=prefix_neg(magnitude);}
 let mh=prefix_high(magnitude);var power=mh-dh;
 if(power>=0){if(prefix_compare(magnitude,prefix_shl(divisorBase,u32(power)))<0){power=power-1;}}
 else{if(prefix_compare(prefix_shl(magnitude,u32(-power)),divisorBase)<0){power=power-1;}}
 var exponent=power+quantum;
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 let unit=max(exponent-23,-149);let shift=unit-quantum;
 if(shift>=128||shift<=-128||mh+max(0,-shift)>125||dh+max(0,shift)+23>125){return vec2<u32>(0u);}
 var remainder=magnitude;var divisor=divisorBase;
 if(shift<0){remainder=prefix_shl(magnitude,u32(-shift));}else{divisor=prefix_shl(divisorBase,u32(shift));}
 var mantissa=0u;
 let candidate=prefix_divide_fast(remainder,divisor);
 if(candidate.accepted!=0u){remainder=candidate.remainder;mantissa=candidate.quotient;}else{
 for(var bit=23;bit>=0;bit=bit-1){let term=prefix_shl(divisor,u32(bit));
  if(prefix_compare(remainder,term)>=0){remainder=prefix_sub(remainder,term);mantissa=mantissa|(1u<<u32(bit));}}
 }
 let comparison=prefix_compare(prefix_shl(remainder,1u),divisor);
 if(comparison>0||(comparison==0&&(mantissa&1u)!=0u)){mantissa=mantissa+1u;}
 if(mantissa>=0x1000000u){mantissa=mantissa>>1u;exponent=exponent+1;}
 if(exponent>=128){return vec2<u32>(sign|0x7f800000u,1u);}
 var rawExponent=0u;if(exponent>=-126){rawExponent=u32(exponent+127);}
 if(rawExponent==0u&&mantissa>=0x800000u){rawExponent=1u;}
 return vec2<u32>(sign|(rawExponent<<23u)|(mantissa&0x7fffffu),1u);
}
