/** R32F coverage stores exactly the same f32 value formerly repeated in four
 * channels. Expand at the sampling boundary, including bilinear neighbours;
 * no quantization or reduced raster density is involved. Bits 4..7 denote
 * immutable transparent inputs with independently retained logical bounds.
 * Bits 8..11 address one-texel uniform colors after the original bounds check.
 * The format mask must
 * not overlap the paint transform at 244..250 or fixed precision at 252..255. */
export const SCALAR_COVERAGE_UNIFORM = 251
export function scalarCoverageSource(source: string): string {
  const names=['at','smp','smpIndex','smpBytesIndex','smpBytes','integerSample']
  const originals=new Map<string,string>()
  for(const name of names){
    const start=source.indexOf(`fn ${name}(tex:texture_2d<f32>,`)
    if(start<0){if(name==='at'||name==='smp')throw Error(`Missing coverage sampler ${name}`);continue}
    let end=source.indexOf('{',start),depth=1
    while(depth&&++end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--}
    if(depth)throw Error('Unterminated coverage sampler')
    originals.set(name,source.slice(start,end+1))
  }
  const specialized=(name:string,slot:string)=>`coverage_${name}_${slot}`
  const replaceCalls=(code:string,slot:string)=>{
    for(const name of names)code=code.replaceAll(`${name}(source${slot},`,`${specialized(name,slot)}(`)
    return code
  }
  let helpers=''
  for(const [index,slot] of ['A','B','C','D'].entries()){
    source=replaceCalls(source,slot)
    for(const [name,original] of originals){
      let code=original.replace(`fn ${name}(tex:texture_2d<f32>,`,`fn ${specialized(name,slot)}(`)
        .replace(/\btex\b/g,`source${slot}`)
      if(name==='at') {
        const flags=`u32(u(${Math.floor(SCALAR_COVERAGE_UNIFORM/4)}).${'xyzw'[SCALAR_COVERAGE_UNIFORM%4]})`
        code=code.replace('{',`{if((${flags}&${1<<(index+4)}u)!=0u){return vec4<f32>(0);}`)
          .replace(`return textureLoad(source${slot},q,0);`,
            `let value=textureLoad(source${slot},select(q,vec2<i32>(0),(${flags}&${1<<(index+8)}u)!=0u),0);return select(value,vec4<f32>(value.r),(${flags}&${1<<index}u)!=0u);`)
      }
      helpers+='\n'+replaceCalls(code,slot)
    }
  }
  return source+helpers
}
