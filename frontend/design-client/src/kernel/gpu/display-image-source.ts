import { replaceWgslBody } from './display-arithmetic'

/** Separate screen pipeline/cache identity. This never changes authored values,
 * coverage geometry, sample phases, the generic compositor or exact filters. */
export const DISPLAY_IMAGE_SOURCE_MATH = 'native-finite-image-v1'

const names = ['displayImageLerp4', 'displayImageBilinear4', 'displayImageMul4', 'displayImageAdd4',
  'displayImageLinear', 'displayImageResolveFinite'] as const

function readFunction(source: string, name: string) {
  const marker = `fn ${name}(`, start = source.indexOf(marker)
  if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw Error(`Unexpected display image function ${name}`)
  const open = source.indexOf('{', start)
  if (open < 0) throw Error(`Incomplete display image function ${name}`)
  let end = open + 1, depth = 1
  while (end < source.length && depth) {
    if (source[end] === '{') depth++
    else if (source[end] === '}') depth--
    end++
  }
  if (depth) throw Error(`Incomplete display image function ${name}`)
  return { definition: source.slice(start, end), body: source.slice(open + 1, end - 1) }
}

const nativeMath = `
// Screen-only finite image arithmetic. Driver admission must prove an actual
// immutable nonnegative opaque upload with raw exponents <=127. Out-of-image
// texels still come from the original zero-padded linearImageTexel helper.
fn displayImageLerp4(a:vec4<f32>,b:vec4<f32>,t:f32)->vec4<f32>{
 if(t==0.){return a;}if(t==1.){return b;}
 return a*(1.-t)+b*t;
}
fn displayImageBilinear4(a:vec4<f32>,b:vec4<f32>,c:vec4<f32>,d:vec4<f32>,k:vec2<f32>,wordLimit:u32,termCount:u32)->vec4<f32>{
 return displayImageLerp4(displayImageLerp4(a,b,k.x),displayImageLerp4(c,d,k.x),k.y);
}
fn displayImageMul4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return a*b;}
fn displayImageAdd4(a:vec4<f32>,b:vec4<f32>)->vec4<f32>{return a+b;}
`

/** Build an independent mode51 screen pipeline from the complete managed
 * compositor AFTER imageCoordinateSource/scalarCoverageSource have run.
 *
 * The driver must select this only with screen intent plus its private actual
 * upload proof (finite/nonnegative RGB, exact opaque alpha, exponent <=127)
 * and renderer-proven four-phase full coverage. Unsupported cases select the
 * original pipeline. There is deliberately no large exact-sampler fallback in
 * this fragment, and this generator grants no texture certificate itself.
 *
 * All original function definitions except exactImageResolveStep stay intact.
 * Cloning the existing addressed/image-resolve bodies preserves axes/dense
 * addressing, contain margins, u51 origin, alpha gate and sample ordering.
 */
export function displayImageSource(source: string): string {
  for (const name of names) if (source.includes(`fn ${name}(`)) throw Error('Display image source already specialized')
  const fragment = readFunction(source, 'exactImageResolveStep')
  const linear = readFunction(source, 'linearImage')
  const resolve = readFunction(source, 'imageResolveFinite')
  readFunction(source, 'linearImageTexel')
  if (!linear.body.includes('floor(p-u(51).xy)') || !linear.body.includes('textureLoad(sourceD,') ||
      (linear.body.match(/\bbsBilinear4\(/g) || []).length !== 1 ||
      (fragment.body.match(/\blinearImage\(/g) || []).length !== 1 ||
      (fragment.body.match(/\bimageResolveFinite\(/g) || []).length !== 1 ||
      !fragment.body.includes('sample=u32(u(4).y)') || !fragment.body.includes('if(sample!=0u)') ||
      !resolve.body.includes('if(src.a<=0.)') || !resolve.body.includes('if(sample==0u)') ||
      !resolve.body.includes('bitcast<u32>(covered[channel])') || !resolve.body.includes('vec4<f32>(0.25)'))
    throw Error('Unsupported addressed image-resolve contract')
  const nativeLinear = linear.definition.replace('fn linearImage(', 'fn displayImageLinear(')
    .replace(/\bbsBilinear4\(/g, 'displayImageBilinear4(')
  const nativeResolve = resolve.definition.replace('fn imageResolveFinite(', 'fn displayImageResolveFinite(')
    .replace(/\bmulRN4\(/g, 'displayImageMul4(').replace(/\baddRN4\(/g, 'displayImageAdd4(')
  if (/\b(?:\w*RN\w*|bs\w+)\(/.test(nativeResolve) || /\bbs\w+\(/.test(nativeLinear))
    throw Error('Unsupported exact arithmetic in private image fragment')
  const body = fragment.body.replace(/\blinearImage\(/g, 'displayImageLinear(')
    .replace(/\bimageResolveFinite\(/g, 'displayImageResolveFinite(')
  return replaceWgslBody(source, 'exactImageResolveStep', body) + nativeMath + '\n' + nativeLinear + '\n' + nativeResolve + '\n'
}
