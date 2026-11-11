import type {GpuScene} from './types'
/** Reserved after the synthetic coverage/batch diagnostic modes. */
export const GRADIENT_PAINT_OVER_MODE = 65

/** Cost screening, never pixel authority. Avoid preparing/dispatching a new
 * pipeline for a single tiny opportunity in an otherwise expensive scene.
 * Runtime coverage, colour, field-resource and lattice proofs still apply. */
export function gradientFusionWorthwhile(scene:GpuScene, singlePlane = false):boolean {
 let count=0
 const bounded=(color:string)=>{
  const decoded=scene.colors?.[color]
  if(decoded)return decoded.every(v=>Number.isFinite(Math.fround(v))&&v>=0&&v<=1)
  return /^#[\da-f]{6}$/i.test(color)
 }
 for(const n of Object.values(scene.nodes)){
  if(!n.rect||!n.fill||!n.strokes)continue
  if(n.rect.w*n.rect.h>262144||!Object.values(n.rect).every(v=>Number.isInteger(v)&&Math.abs(v)<=1048576))continue
  for(const {path,paint}of [{path:n.fill,paint:undefined},...n.strokes.map(s=>({path:s.path,paint:s.align==='center'?s.paint:undefined}))]){
   if(singlePlane){
    if(!path.count)continue
   }else{
    if(path.sampleCount!==4||!path.area)continue
    const header=scene.curves?.[path.area.first*4];if(header!==3&&header!==4&&header!==5)continue
   }
   for(const p of paint?[paint]:path===n.fill?n.fills:[]){
    if(p.visible&&p.blend==='normal'&&['linear','radial','angular','diamond'].includes(p.kind)&&p.opacity>=0&&p.opacity<=1&&
      p.stops.length<=64&&bounded(p.color)&&p.stops.every(s=>bounded(s.color))&&++count>=2)return true
   }
  }
 }
 return false
}

/** Exact uploaded fields must not introduce NaN through a zero-weight neighbour
 * of the removed paint texture. Validate once at upload, not on every draw. */
export function gradientFieldMaximumStop(values:Float32Array):number|undefined {
 if(!values.length||values.length%4)return
 let maximum=-1
 for(let i=0;i<values.length;i+=4){
  const x=values[i],y=values[i+1],weight=values[i+2]
  if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(weight)||!Number.isFinite(values[i+3]))return
  if(x<0)continue
  if(!Number.isInteger(x)||!Number.isInteger(y)||y<0||x>=64||y>=64||weight<0||weight>1)return
  maximum=Math.max(maximum,x,y)
 }
 return maximum
}

// The field is the ORIGINAL kernel-produced field, not a new gradient formula.
// u(9) keeps its original paint rectangle while u(0) is the output rectangle.
// Source slots: A=coverage, B=stop table or clip, C=destination, D=field.
// Admission proves finite paint/coverage so integer-centre readback of the
// former RGBA32F intermediate only canonicalizes signed zeros. Every multiply,
// interpolation and source-over still uses the original RNE operations.
export const gradientPaintOverWgsl = `
fn fusedGradientValue(p:vec2<f32>)->vec4<f32>{
 let bounds=u(9);
 if(any(p<bounds.xy)||any(p>=bounds.xy+bounds.zw)){return vec4<f32>(0);}
 var address=vec2<i32>(floor(p-bounds.xy));
 let dimensions=vec2<i32>(textureDimensions(sourceD,0));
 if(dimensions.x==1&&bounds.z>1.){address.x=0;}
 if(dimensions.y==1&&bounds.w>1.){address.y=0;}
 let grid=textureLoad(sourceD,address,0);
 var color:vec4<f32>;
 if(grid.x<0.){color=mulRN4(vec4<f32>(u(7).yzw,1.),vec4<f32>(u(60).y));}
 else{
  let left=linearGradientStop(u32(grid.x));color=left;
  if(grid.x!=grid.y){let right=linearGradientStop(u32(grid.y));color=addRN4(left,mulRN4(addRN4(right,-left),vec4<f32>(grid.z)));}
 }
 let painted=mulRN4(color,vec4<f32>(u(8).x));
 let covered=mulRN4(painted,vec4<f32>(at(sourceA,p,u(1)).a));
 let bits=bitcast<vec4<u32>>(covered);
 return bitcast<vec4<f32>>(select(bits,vec4<u32>(0),(bits&vec4<u32>(0x7fffffffu))==vec4<u32>(0)));
}
@fragment fn exactGradientPaintOver(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;
 var opacity=1.;if(u(4).w>0.5){opacity=mulRN(opacity,at(sourceB,p,u(2)).a);}
 return over(integerSample(sourceC,p,u(3)),mulRN4(fusedGradientValue(p),vec4<f32>(opacity)),0);
}
`
