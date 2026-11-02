/** Only coordinate-field addressing changes. Gradient values, interpolation,
 * full output geometry and the original paint/normal-over arithmetic remain. */
export function gradientWindowSource(source:string) {
  const address='var address:vec2<i32>=vec2<i32>(floor(p-u(0).xy));'
  if(source.indexOf(address)<0||source.indexOf(address)!==source.lastIndexOf(address))
    throw Error('Gradient field addressing contract changed')
  return source.replace(address,address+'\n if(u(47).x>0.5){address=vec2<i32>(floor(p-u(0).xy-u(47).yz));}')
}
