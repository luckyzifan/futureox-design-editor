import { replaceWgslBody } from './display-arithmetic'

/** WebGPU transport may factor exact coordinate metadata into two rows.
 * Straight RGBA8 decoding stays in the shared linearImageTexel, including the
 * sRGB table selected by u(51).w. This rewrite does not enable u(46).w. */
export function imageCoordinateSource(source: string): string {
  if(!source.includes('fn sourceTableWord(')||!source.includes('u(51).w==1.'))throw Error('Straight image decode is missing from the shared shader')
  return replaceWgslBody(source, 'linearImage', `
 let pixel=vec2<i32>(floor(p-u(51).xy));var grid:vec4<f32>;
 if(textureLoad(sourceD,vec2<i32>(0),0).w<0.){
  let x=textureLoad(sourceD,vec2<i32>(pixel.x,0),0);let y=textureLoad(sourceD,vec2<i32>(pixel.y,1),0);
  if(x.z==0.||y.z==0.){return vec4<f32>(0);}
  grid=vec4<f32>(x.x,y.x,x.y,y.y);
 }else{grid=textureLoad(sourceD,pixel,0);}
 let q:vec2<i32>=vec2<i32>(grid.xy);
 let a=linearImageTexel(q);let b=linearImageTexel(q+vec2<i32>(1,0));
 let c=linearImageTexel(q+vec2<i32>(0,1));let d=linearImageTexel(q+vec2<i32>(1,1));
 if(u(51).z==1.){
  return mix(mix(a,b,grid.z),mix(c,d,grid.z),grid.w);
 }
 return bsBilinear4(a,b,c,d,grid.zw,u32(u(63).w),u32(u(63).z));
`)
}
/** Hosted managed WebGPU samples straight RGBA8 as rgba8uint. textureLoad
 * returns the stored bytes, so the sRGB table words do not depend on an
 * unorm round trip. u(46).w stays clear. */
export function hostedByteImageSource(source: string): string {
  if(source.includes('var sourceBytes:'))throw Error('Hosted byte image binding is already installed')
  const declaration='@group(0) @binding(2) var sourceB:texture_2d<f32>;'
  if(!source.includes('fn hostedStraightByteImage(')||!source.includes('u(51).w==1.')||source.indexOf(declaration)<0||source.indexOf(declaration)!==source.lastIndexOf(declaration))
    throw Error('Hosted byte image entry is missing')
  const replaced=replaceWgslBody(source.replace(declaration, declaration+'\n@group(0) @binding(6) var sourceBytes:texture_2d<u32>;'), 'linearImageTexel', `
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(2).zw))){return vec4<f32>(0);}
 if(u(51).w==1.){
  let texel=textureLoad(sourceBytes,q,0);let row=i32(u(2).w);
  let a=hostedByteWord(texel.a,row+1);
  return vec4<f32>(mulRN4(vec4<f32>(hostedByteWord(texel.r,row),hostedByteWord(texel.g,row),hostedByteWord(texel.b,row),1.),vec4<f32>(a)).rgb,a);
 }
 return textureLoad(sourceB,q,0);
`)
  return replaced+`
fn hostedByteWord(channel:u32,row:i32)->f32{
 let bits=textureLoad(sourceBytes,vec2<i32>(i32(channel),row),0);
 return bitcast<f32>(bits.r|(bits.g<<8u)|(bits.b<<16u)|(bits.a<<24u));
}
`
}
