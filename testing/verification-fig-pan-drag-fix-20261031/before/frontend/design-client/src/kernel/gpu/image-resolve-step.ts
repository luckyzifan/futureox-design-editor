/** The finite-input specialization preserves the old paint -> normal-over-zero
 * -> quarter/left-to-right resolve boundaries. Source B must be a certified
 * immutable finite upload; source A is the original physical coverage texture.
 * Unknown/atlas/nonfinite sources retain the existing three-pass sequence. */
export const IMAGE_RESOLVE_STEP_MODE = 51
export const imageResolveStepWgsl = `
fn imageResolveFinite(image:vec4<f32>,coverage:f32,previous:vec4<f32>,sample:u32)->vec4<f32>{
 let paint=mulRN4(image,vec4<f32>(1.));
 let covered=mulRN4(paint,vec4<f32>(coverage));
 // At the original integer-centre normal pass, finite zero-weight
 // neighbours cannot replace the centre. bsCorner4 still canonicalizes -0.
 var sampled=covered;
 for(var channel=0u;channel<4u;channel=channel+1u){
  let bits=bitcast<u32>(covered[channel]);
  if((bits&0x7fffffffu)==0u){sampled[channel]=0.;}
 }
 var src=mulRN4(sampled,vec4<f32>(1.));
 // Preserve normal-over-transparent's alpha gate, including a zero-alpha
 // HDR colour that is not numerically zero in RGB.
 if(src.a<=0.){src=vec4<f32>(0.);}
 let quarter=mulRN4(src,vec4<f32>(0.25));
 if(sample==0u){return quarter;}
 return addRN4(previous,quarter);
}
@fragment fn exactImageResolveStep(@builtin(position) position:vec4<f32>)->@location(0) vec4<f32>{
 let p=position.xy+u(0).xy;let sample=u32(u(4).y);
 var previous=vec4<f32>(0.);
 if(sample!=0u){previous=at(sourceC,p,u(3));}
 return imageResolveFinite(linearImage(p),at(sourceA,p,u(1)).a,previous,sample);
}
`
