import { replaceWgslBody } from './display-arithmetic'

/** WebGPU transport may factor exact coordinate metadata into two rows.
 * The sampler and its arithmetic are unchanged, including in the HDR tier. */
export function imageCoordinateSource(source: string): string {
  const addressed=replaceWgslBody(source,'linearImageTexel',`
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(u(2).zw))){return vec4<f32>(0);}
 let v=textureLoad(sourceB,q,0);
 if(u(4).x==2.&&u(7).x==3.&&u(51).w==1.){
  let b=vec4<i32>(round(v*255.));let row=i32(u(2).w);
  let a=sourceTableWord(b.a,row+1);
  return vec4<f32>(mulRN4(vec4<f32>(sourceTableWord(b.r,row),sourceTableWord(b.g,row),sourceTableWord(b.b,row),1.),vec4<f32>(a)).rgb,a);
 }
 return v;
 `)
  return `fn sourceTableWord(index:i32,row:i32)->f32{
 let bits=vec4<u32>(round(textureLoad(sourceB,vec2<i32>(index,row),0)*255.));
 return bitcast<f32>(bits.r|(bits.g<<8u)|(bits.b<<16u)|(bits.a<<24u));
}\n`+replaceWgslBody(addressed, 'linearImage', `
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
