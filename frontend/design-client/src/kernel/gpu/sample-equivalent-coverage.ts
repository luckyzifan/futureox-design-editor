import type { PathMesh } from './types'

/** A bounded sufficient proof for the existing binary interval shader. Span
 * bytes alone are insufficient: each phase uses a different eighth-pixel X
 * location. Compare the shader's actual inclusive integer coverage runs. */
export function identicalSampleCoverage(path: PathMesh, curves: readonly number[] | Float32Array | undefined): boolean {
  const area = path.area, r = path.rect
  if (!curves || !area || !path.count || path.sampleCount !== 4 ||
      ![r.x, r.y, r.w, r.h, area.first, area.count].every(Number.isSafeInteger) ||
      r.w < 1 || r.h < 1 || r.w > 8192 || r.h > 8192 || area.first < 0 ||
      area.count < 1 + r.h * 4 || area.count > 262144 || (area.first + area.count) * 4 > curves.length) return false
  const begin = area.first * 4, end = (area.first + area.count) * 4
  if (curves[begin] !== 3 || curves[begin + 1] !== 1 || curves[begin + 2] !== r.w || curves[begin + 3] !== r.h) return false
  const bits = new DataView(new ArrayBuffer(4)), offsets = [.375, .875, .125, .625]
  const pair = (at: number): [number, number] | undefined => {
    const words = [curves[at], curves[at + 1], curves[at + 2], curves[at + 3]]
    if (words.some(word => !Number.isInteger(word) || word < 0 || word > 65535)) return
    const result: [number, number] = [(words[0] | words[1] << 16) >>> 0, (words[2] | words[3] << 16) >>> 0]
    if ((result[1] & 0x7ff00000) === 0x7ff00000) return
    return result
  }
  // This is area.wgsl sampleBits/compare64, including signed-zero ordering.
  // Every input is already a binary32 program word; preserve its subtraction.
  const sample = (offset: number, upper: number): [number, number] | undefined => {
    if (!Number.isFinite(upper) || Math.fround(upper) !== upper) return
    bits.setFloat32(0, Math.fround(offset - upper), true)
    const raw = bits.getUint32(0, true), mantissa = raw & 0x7fffff, exponent = raw >>> 23 & 255
    if (exponent === 255) return
    return [(mantissa << 29) >>> 0,
      ((raw & 0x80000000) | (exponent + 896) << 20 | mantissa >>> 3) >>> 0]
  }
  const compare = (a: readonly number[], b: readonly number[]) => {
    if (a[0] === b[0] && a[1] === b[1]) return 0
    const negative = a[1] >>> 31, other = b[1] >>> 31
    if (negative !== other) return negative ? -1 : 1
    let less = a[1] < b[1] || a[1] === b[1] && a[0] < b[0]
    if (negative) less = !less
    return less ? -1 : 1
  }
  let spanWork = 0
  for (let row = 0; row < r.h; row++) {
    let reference: number[] | undefined
    for (let phase = 0; phase < 4; phase++) {
      const record = begin + 4 + (row * 4 + phase) * 4
      const first = curves[record], count = curves[record + 1]
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || count < 0 ||
          first < 0 || count && first < 1 + r.h * 4 || begin + (first + count * 3) * 4 > end) return false
      spanWork += count
      if (spanWork > 262144) return false
      const runs: number[] = []
      let previousLo = -Infinity, previousHi = -Infinity
      for (let span = 0; span < count; span++) {
        const at = begin + (first + span * 3) * 4
        let lo = curves[at], hi = curves[at + 1]
        if (![lo, hi].every(Number.isSafeInteger) || Math.abs(lo) > 1048576 || Math.abs(hi) > 1048576 ||
            hi < lo || lo < previousLo || hi < previousHi) return false
        previousLo = lo; previousHi = hi
        const left = pair(at + 4), right = pair(at + 8)
        const leftSample = sample(offsets[phase], curves[at + 2]), rightSample = sample(offsets[phase], curves[at + 3])
        if (!left || !right || !leftSample || !rightSample) return false
        if (compare(leftSample, left) < 0) lo++
        if (compare(rightSample, right) >= 0) hi--
        lo = Math.max(0, lo); hi = Math.min(r.w - 1, hi)
        if (lo > hi) continue
        if (runs.length && lo <= runs[runs.length - 1] + 1) {
          runs[runs.length - 2] = Math.min(runs[runs.length - 2], lo)
          runs[runs.length - 1] = Math.max(runs[runs.length - 1], hi)
        } else runs.push(lo, hi)
      }
      if (reference && (reference.length !== runs.length || reference.some((value, i) => value !== runs[i]))) return false
      reference = runs
    }
  }
  return true
}
