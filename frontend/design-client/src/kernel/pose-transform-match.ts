/** Same authored transform, including values that differ only by a rounding
 * ulp well below a visible affine step. NaN still matches only NaN. */
export function poseTransformMatches(left: readonly number[] | undefined, right: readonly number[] | undefined) {
  if (!left || !right || left.length !== right.length || left.length < 6) return false
  return left.every((value, index) => {
    const other = right[index]!
    return Object.is(value, other) || (Number.isFinite(value) && Number.isFinite(other) && Math.abs(value - other) <= 1e-9)
  })
}
