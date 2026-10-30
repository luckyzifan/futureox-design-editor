/** Screen-only variant of the shared compositor. Geometry, color encoding,
 * blend equations and sampling coordinates stay unchanged. Only bilinear
 * reduction and basic binary32 operations use the GPU's native arithmetic.
 * The unmodified source remains the exact/export/HDR/desktop program. */
export function displayArithmeticSource(source: string, nativeDivision = true): string {
  const replace = (name: string, body: string) => { source = replaceWgslBody(source, name, body) }
  replace('addRN', 'return a+b;')
  replace('mulRN', 'return a*b;')
  if(nativeDivision){
    replace('divideRN', 'return a/b;')
    replace('sqrtRN', 'return sqrt(a);')
  }
  replace('bsCorner4', 'return a;')
  replace('bsBilinear4', 'return mix(mix(a,b,k.x),mix(c,d,k.x),k.y);')
  replace('bsBilinearChannelAlpha', 'let v=mix(mix(a,b,k.x),mix(c,d,k.x),k.y);return vec2<f32>(v[channel],v.w);')
  return source
}

/** Host-specific adapters keep the shared native/WebGL shader source intact. */
export function replaceWgslBody(source: string, name: string, body: string): string {
    const marker = `fn ${name}(`, start = source.indexOf(marker)
    if (start < 0 || source.indexOf(marker, start + marker.length) >= 0) throw Error(`Unexpected compositor function ${name}`)
    const begin = source.indexOf('{', start)
    let depth = 1, end = begin + 1
    while (end < source.length && depth) {
      if (source[end] === '{') depth++
      else if (source[end] === '}') depth--
      end++
    }
    if (depth) throw Error(`Incomplete compositor function ${name}`)
    return source.slice(0, begin + 1) + body + source.slice(end - 1)
}
