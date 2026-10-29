/** Canvas-only reduction of the kernel's original motion/zoom tap tables.
 * Coordinates, sample counts, support and output resolution stay intact.
 * Extended-range/nonfinite neighbours use the original exact shader. */
export const canvasSpatialBlurWgsl = `
fn canvasUnitPixel(value:vec4<f32>)->bool {
 let bits=bitcast<vec4<u32>>(value);let magnitude=bits&vec4<u32>(0x7fffffffu);
 let canonical=select(bits,vec4<u32>(0u),magnitude==vec4<u32>(0u));
 return all(canonical<=vec4<u32>(0x3f800000u));
}
struct CanvasBlurSample {value:vec4<f32>,valid:bool}
fn canvasBlurSample(point:vec2<f32>,fraction:vec2<f32>)->CanvasBlurSample {
 let a=coverage_at_A(point,u(1));let b=coverage_at_A(point+vec2<f32>(1,0),u(1));
 let c=coverage_at_A(point+vec2<f32>(0,1),u(1));let d=coverage_at_A(point+vec2<f32>(1,1),u(1));
 if(!canvasUnitPixel(a)||!canvasUnitPixel(b)||!canvasUnitPixel(c)||!canvasUnitPixel(d)){
  return CanvasBlurSample(vec4<f32>(0),false);
 }
 return CanvasBlurSample(mix(mix(a,b,fraction.x),mix(c,d,fraction.x),fraction.y),true);
}
@fragment fn canvasMotionBlur(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let header=motionKernelTap(0u);
 var sum=vec4<f32>(0);var correction=vec4<f32>(0);
 for(var i=0u;i<u32(header.x);i=i+1u){
  let tap=motionKernelTap(1u+2u*i);let weight=motionKernelTap(2u+2u*i).x;
  let sample=canvasBlurSample(p+tap.xy,tap.zw);
  if(!sample.valid){return motionBlurPixel(p);}
  let value=sample.value*weight-correction;let next=sum+value;
  correction=(next-sum)-value;sum=next;
 }
 return clamp(sum/header.y,vec4<f32>(0),vec4<f32>(1));
}
@fragment fn canvasZoomBlur(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let header=motionKernelTap(0u);
 let count=min(64u,u32(header.x));if(count!=64u){return zoomBlurPixel(p);}
 let pixel=vec2<u32>(floor(p-u(1).xy));
 var sum=vec4<f32>(0);var correction=vec4<f32>(0);
 for(var tap=0u;tap<count;tap=tap+1u){
  let x=motionKernelTap(1u+pixel.x*64u+tap);let y=motionKernelTap(u32(header.w)+pixel.y*64u+tap);
  let q=u(1).xy+vec2<f32>(x.x,y.x)+0.5;
  let sample=canvasBlurSample(q,vec2<f32>(x.y,y.y));
  if(!sample.valid){return zoomBlurPixel(p);}
  let value=sample.value-correction;let next=sum+value;
  correction=(next-sum)-value;sum=next;
 }
 return clamp(sum/64.,vec4<f32>(0),vec4<f32>(1));
}
`
