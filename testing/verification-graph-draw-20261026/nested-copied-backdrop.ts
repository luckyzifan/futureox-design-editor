/** A raw backdrop snapshot defers the original integer-copy sampler until its
 * only consumer. Nine original texels reproduce both positive-neighbour
 * sampling boundaries, including NaN priority and signed-zero normalization. */
const kernel = `
fn copiedBackdropTexel(tex:texture_2d<f32>,q:vec2<i32>)->vec4<f32>{
 if(any(q<vec2<i32>(0))||any(q>=vec2<i32>(textureDimensions(tex,0)))){return vec4<f32>(0);}
 return textureLoad(tex,q,0);
}
fn copiedBackdropInside(q:vec2<i32>,size:vec2<i32>)->bool{return all(q>=vec2<i32>(0))&&all(q<size);}
fn copiedBackdropSample(tex:texture_2d<f32>,p:vec2<f32>,r:vec4<f32>)->vec4<f32>{
 let q=vec2<i32>(floor(p-r.xy));let size=vec2<i32>(r.zw);
 let a=copiedBackdropTexel(tex,q);let b=copiedBackdropTexel(tex,q+vec2<i32>(1,0));
 let c=copiedBackdropTexel(tex,q+vec2<i32>(0,1));let d=copiedBackdropTexel(tex,q+vec2<i32>(1,1));
 let e=copiedBackdropTexel(tex,q+vec2<i32>(2,0));let f=copiedBackdropTexel(tex,q+vec2<i32>(2,1));
 let g=copiedBackdropTexel(tex,q+vec2<i32>(0,2));let h=copiedBackdropTexel(tex,q+vec2<i32>(1,2));
 let i=copiedBackdropTexel(tex,q+vec2<i32>(2,2));
 var ca=vec4<f32>(0);var cb=vec4<f32>(0);var cc=vec4<f32>(0);var cd=vec4<f32>(0);
 if(copiedBackdropInside(q,size)){ca=bsCorner4(a,b,c,d);}
 if(copiedBackdropInside(q+vec2<i32>(1,0),size)){cb=bsCorner4(b,e,d,f);}
 if(copiedBackdropInside(q+vec2<i32>(0,1),size)){cc=bsCorner4(c,d,g,h);}
 if(copiedBackdropInside(q+vec2<i32>(1,1),size)){cd=bsCorner4(d,f,h,i);}
 return bsCorner4(ca,cb,cc,cd);
}
`

export function copiedBackdropShader(source:string) {
  const clone=(name:string,input:string)=>{
    const start=source.indexOf(`@fragment fn ${name}(`),end=source.indexOf('\n@fragment fn ',start+1)
    if(start<0||end<0)throw Error('Missing exact backdrop compositor entry')
    const original=source.slice(start,end),needle=`integerSample(${input}`
    if(original.split(needle).length!==2)throw Error('Changed exact backdrop sampler contract')
    return original.replace(`fn ${name}(`,`fn ${name}CopiedBackdrop(`).replace(needle,`copiedBackdropSample(${input}`)
  }
  return source+kernel+clone('exactNormalCorner','sourceB,')+'\n'+clone('exactSolidPaintOver','sourceA,')
}
