/** Exact mode22 indexes textureLoad with floor after three binary32 operations
 * (pixel+origin, integer tap, source-origin subtraction). A fractional global
 * origin is safe only when their worst-case rounding cannot cross a texel edge.
 * This is an index proof; it grants no color/range/kernel certificate. */
function halfUlp(maximum: number) {
  return maximum === 0 ? 2 ** -150 : 2 ** (Math.floor(Math.log2(maximum)) - 24)
}
export function prefixSamplingGeometry(base: Float32Array, radius: number, allowClamped = false, maximumRadius: 2048 | 4096 = 2048) {
  if ((maximumRadius!==2048&&maximumRadius!==4096) || !(base instanceof Float32Array) || !(base.buffer instanceof ArrayBuffer) || base.length !== 256 ||
      !Number.isFinite(radius) || radius < 1 || radius > (import.meta.env.VITE_DESIGN_LARGE_SHADOW_TENT === '1' ? 4096 : maximumRadius) ||
      ![base[0], base[1], base[4], base[5]].every(v => Number.isFinite(v) && Math.abs(v) <= 1048576) ||
      ![base[2], base[3], base[6], base[7]].every(v => Number.isSafeInteger(v) && v > 0 && v <= 16384) ||
      (base[37] !== 0 && base[37] !== 1) || (base[38] !== 0 && base[38] !== 1) || base[38] === 1 && !allowClamped) return
  const reach = Math.ceil(radius) + 1, offsets: number[] = []
  for (let coordinate = 0; coordinate < 2; coordinate++) {
    const output = base[coordinate], source = base[4 + coordinate]
    const extent = base[2 + coordinate], sourceExtent = base[6 + coordinate]
    const delta = output - source, offset = Math.round(delta)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + extent > sourceExtent) return
    // Include both tap endpoints even on the cross axis: this deliberately
    // overestimates, so one proof covers scan, scalar fallback and clamp edges.
    const global = Math.max(Math.abs(output - reach), Math.abs(output + extent + reach),
      Math.abs(source), Math.abs(source + sourceExtent))
    const local = sourceExtent + reach * 2 + 4
    if (global > 1048576 || Math.abs(delta - offset) + 2 * halfUlp(global) + halfUlp(local) >= .5) return
    offsets.push(offset)
  }
  const axis = base[37], padding = base[38] === 1 ? reach : 0
  const length = base[6 + axis] + padding * 2
  if (length > 16384) return
  return { length, padding, offset: offsets[axis] + padding, crossOffset: offsets[1 - axis] }
}
