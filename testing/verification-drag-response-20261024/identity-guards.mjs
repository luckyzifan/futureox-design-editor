// Test-only candidate. No floating estimate or changed rounding: finite +/-0
// addition, finite +/-1 products, and exactly representable normal power-of-two
// products return their proven IEEE bits. All other cases keep original math.
export function identityShader(source){
 const add=' var aa=bitcast<u32>(a);var bb=bitcast<u32>(b);'
 const mul=' if(ae==255u||be==255u){return a*b;}'
 if(source.split(add).length!==2||source.split(mul).length!==2)throw Error('Arithmetic helper identity changed')
 return source.replace(add,add+`
 let az=aa&0x7fffffffu;let bz=bb&0x7fffffffu;
 if(az<0x7f800000u&&bz<0x7f800000u){
  if(az==0u){return bitcast<f32>(select(bb,aa&bb,bz==0u));}
  if(bz==0u){return bitcast<f32>(aa);}
 }
`).replace(mul,mul+`
 let az=aa&0x7fffffffu;let bz=bb&0x7fffffffu;
 if(bz==0x3f800000u){return bitcast<f32>(aa^(bb&0x80000000u));}
 if(az==0x3f800000u){return bitcast<f32>(bb^(aa&0x80000000u));}
 if(ae>0u&&be>0u){
  let exponent=i32(ae)+i32(be)-127;
  if(exponent>0&&exponent<255){
   if((bb&0x7fffffu)==0u){return bitcast<f32>(sign|(u32(exponent)<<23u)|(aa&0x7fffffu));}
   if((aa&0x7fffffu)==0u){return bitcast<f32>(sign|(u32(exponent)<<23u)|(bb&0x7fffffu));}
  }
 }
`)
}
