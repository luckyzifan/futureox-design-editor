/** Pass order for the variable-radius backdrop tent.
 * Matches the CPU filter: run the axis the radius changes along first.
 * `a` and `b` are the composite-field coefficients. An exact tie stays
 * horizontal then vertical. */
export function progressiveBackdropAxes(a: number, b: number): readonly [0 | 1, 0 | 1] {
  return Math.abs(b) > Math.abs(a) ? [1, 0] : [0, 1]
}
