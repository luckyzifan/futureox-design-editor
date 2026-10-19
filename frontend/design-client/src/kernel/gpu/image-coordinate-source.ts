import { replaceWgslBody } from './display-arithmetic'

/** WebGPU transport may factor exact coordinate metadata into two rows.
 * The sampler and its arithmetic are unchanged, including in the HDR tier. */
export function imageCoordinateSource(source: string): string {
  return replaceWgslBody(source, 'linearImage', `
 let pixel=vec2<i32>(floor(p-u(0).xy));var grid:vec4<f32>;
 if(textureLoad(sourceD,vec2<i32>(0),0).w<0.){
  let x=textureLoad(sourceD,vec2<i32>(pixel.x,0),0);let y=textureLoad(sourceD,vec2<i32>(pixel.y,1),0);
  if(x.z==0.||y.z==0.){return vec4<f32>(0);}
  grid=vec4<f32>(x.x,y.x,x.y,y.y);
 }else{grid=textureLoad(sourceD,pixel,0);}
 let q:vec2<i32>=vec2<i32>(grid.xy);
 return bsBilinear4(linearImageTexel(q),linearImageTexel(q+vec2<i32>(1,0)),linearImageTexel(q+vec2<i32>(0,1)),linearImageTexel(q+vec2<i32>(1,1)),grid.zw,u32(u(63).w),u32(u(63).z));
`)
}
