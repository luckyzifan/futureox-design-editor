/** Exact binary32 identities, not a native-float precision tier. Special
 * values, underflow/overflow and all non-power-of-two products keep the
 * original integer round-to-nearest-even implementation. */
export function exactArithmeticIdentities(source:string){
 const insert=(marker:string,body:string)=>{
  if(source.indexOf(marker)<0||source.indexOf(marker)!==source.lastIndexOf(marker))throw Error('Missing exact arithmetic entry')
  source=source.replace(marker,marker+body)
 }
 insert('fn addRN(a:f32,b:f32)->f32{',`
 let identityA=bitcast<u32>(a);let identityB=bitcast<u32>(b);
 let magnitudeA=identityA&0x7fffffffu;let magnitudeB=identityB&0x7fffffffu;
 if(magnitudeA<0x7f800000u&&magnitudeB<0x7f800000u&&(magnitudeA==0u||magnitudeB==0u)){
  if(magnitudeA==0u&&magnitudeB==0u){return bitcast<f32>(identityA&identityB&0x80000000u);}
  return bitcast<f32>(select(identityA,identityB,magnitudeA==0u));
 }
`)
 insert('fn mulRN(a:f32,b:f32)->f32{',`
 let identityA=bitcast<u32>(a);let identityB=bitcast<u32>(b);
 let exponentA=(identityA>>23u)&255u;let exponentB=(identityB>>23u)&255u;
 if(exponentA>0u&&exponentA<255u&&exponentB>0u&&exponentB<255u){
  let exponent=i32(exponentA)+i32(exponentB)-127;
  if(exponent>0&&exponent<255){
   let sign=(identityA^identityB)&0x80000000u;
   if((identityB&0x7fffffu)==0u){return bitcast<f32>(sign|(u32(exponent)<<23u)|(identityA&0x7fffffu));}
   if((identityA&0x7fffffu)==0u){return bitcast<f32>(sign|(u32(exponent)<<23u)|(identityB&0x7fffffu));}
  }
 }
`)
 return source
}
