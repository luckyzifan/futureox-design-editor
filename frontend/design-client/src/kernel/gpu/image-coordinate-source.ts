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
