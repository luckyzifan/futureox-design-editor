export const VARIABLE_FILTER_REACH = 64
export const VARIABLE_FILTER_LANES = 64

/** The original filters supply the ramp, clamp, coefficients and reduction.
 * Specialize just their source-A taps for the compute entry point. Keep the
 * original fragment module available for the exact and unsupported paths. */
export function variableFilterSource(source: string, format: 'rgba32float' | 'rgba8unorm') {
  const patchFunction = (source: string, signature: string, specialize: (body: string) => string) => {
    const start = source.indexOf(signature)
    if (start < 0) throw Error(`Missing variable filter function: ${signature}`)
    const body = source.indexOf('{', start)
    if (body < 0) throw Error(`Invalid variable filter function: ${signature}`)
    let last = body, depth = 0
    do {
      const character = source[last++]
      if (character === '{') depth++
      if (character === '}') depth--
    } while (depth > 0 && last < source.length)
    const original = source.slice(start, last)
    const specialized = specialize(original)
    if (depth || original === specialized) throw Error(`Missing variable filter taps: ${signature}`)
    return source.slice(0, start) + specialized + source.slice(last)
  }
  const cached = (body: string) => body.replaceAll('at(sourceA,', 'variableTap(')
  let specialized = patchFunction(source, 'fn progressiveSample(', cached)
  specialized = patchFunction(specialized, 'fn sketchBlurBox(', cached)
  // The fragment entry point cannot reference the compute workgroup cache.
  specialized = patchFunction(specialized, '@fragment fn fragment(', () => '')
  return specialized + `
@group(0) @binding(7) var variableOutput:texture_storage_2d<${format},write>;
var<workgroup> variableLine:array<vec4<f32>,${VARIABLE_FILTER_LANES + 2 * VARIABLE_FILTER_REACH}>;
var<private> variableHorizontal:bool;
var<private> variableFirst:i32;
var<private> variableCount:i32;
var<private> variableCross:i32;

fn variableTap(point:vec2<f32>,bounds:vec4<f32>)->vec4<f32>{
 let q=vec2<i32>(floor(point-bounds.xy));
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(bounds.zw))){return vec4<f32>(0.);}
 let along=select(q.y,q.x,variableHorizontal)-variableFirst;
 let cross=select(q.x,q.y,variableHorizontal);
 if(along>=0&&along<variableCount&&cross==variableCross){return variableLine[along];}
 return textureLoad(sourceA,q,0);
}

@compute @workgroup_size(${VARIABLE_FILTER_LANES})
fn variableFilter(@builtin(workgroup_id) group:vec3<u32>,@builtin(local_invocation_index) lane:u32){
 let sketch=u(4).x==64.;
 variableHorizontal=select(u(11).x,u(11).y,sketch)<0.5;
 let base=i32(group.x)*${VARIABLE_FILTER_LANES};
 let halo=i32(u(12).z);
 variableFirst=base-halo;
 variableCount=${VARIABLE_FILTER_LANES}+2*halo;
 variableCross=i32(group.y);
 let size=vec2<i32>(u(1).zw);
 let length=select(size.y,size.x,variableHorizontal);
 let crossLength=select(size.x,size.y,variableHorizontal);
 for(var slot=lane;slot<u32(variableCount);slot+=${VARIABLE_FILTER_LANES}u){
  let along=variableFirst+i32(slot);
  if(along>=0&&along<length&&variableCross<crossLength){
   let q=select(vec2<i32>(variableCross,along),vec2<i32>(along,variableCross),variableHorizontal);
   variableLine[slot]=textureLoad(sourceA,q,0);
  }else{variableLine[slot]=vec4<f32>(0.);}
 }
 workgroupBarrier();
 let along=base+i32(lane);
 if(along>=length||variableCross>=crossLength){return;}
 let q=select(vec2<i32>(variableCross,along),vec2<i32>(along,variableCross),variableHorizontal);
 let point=(vec2<f32>(q)+0.5)+u(0).xy;
 var value:vec4<f32>;
 if(sketch){value=sketchBlurBox(point);}else{value=progressiveTent(point);}
 ${format === 'rgba8unorm' ? 'value=round(clamp(value,vec4<f32>(0.),vec4<f32>(1.))*255.)/255.;' : ''}
 textureStore(variableOutput,q,value);
}`
}
