/** Certified finite, fully covered image samples only. Multiplication by one
 * preserves all finite bits; the original zero canonicalization precedes the
 * quarter. Dividing by four changes the exponent, except at gradual underflow,
 * where the one/two discarded bits still use round-to-nearest-even. */
export const imageTableQuarterWgsl = `
fn imageTableQuarterBits(bits:u32)->u32 {
 let magnitude=bits&0x7fffffffu;
 if(magnitude==0u){return 0u;}
 let sign=bits&0x80000000u;let exponent=(bits>>23u)&255u;
 if(exponent>2u){return bits-0x01000000u;}
 let mantissa=(bits&0x7fffffu)|select(0u,0x800000u,exponent!=0u);
 let shift=select(2u,1u,exponent==2u);
 let quotient=mantissa>>shift;let tail=mantissa&((1u<<shift)-1u);let half=1u<<(shift-1u);
 return sign|(quotient+select(0u,1u,tail>half||(tail==half&&(quotient&1u)!=0u)));
}
`
