/** Gesture-time adaptive capture density, after the Figma viewer tile
 * scheduler (figma-wasm-analysis GLUE-JS-MINING §2.4): when required pixels
 * exceed the budget, divide the density by 2^ceil(log4(ratio)) — no fixed
 * zoom ladder — so nearby zoom inputs keep one stable capture lattice and do
 * not recompile on every step. Steady-state density demand that fits the
 * budget is never reduced.
 *
 * This is the transient interaction lane only: it changes what a still-moving
 * gesture capture rasterizes at, never the settled exact tiles, exports or
 * the low-zoom reduced tier. Strict opt-in until whole-editor acceptance. */
export const INTERACTION_ADAPTIVE_DENSITY_BUDGET = 8_000_000

export function interactionAdaptiveDensityEnabled() {
  return import.meta.env.VITE_DESIGN_INTERACTION_ADAPTIVE_DENSITY === '1'
}

/** Returns the capture scale for this gesture sample. Unchanged full density
 * whenever the flag is off, the gesture is not active, the low-zoom reduced
 * tier already applies, or demand fits the budget. */
export function interactionAdaptiveScale(residentScale: number, bounds: { width: number; height: number },
  active: boolean, reduced: boolean) {
  if (reduced || !active || !interactionAdaptiveDensityEnabled()) return residentScale
  const demand = bounds.width * bounds.height * residentScale * residentScale
  if (demand <= INTERACTION_ADAPTIVE_DENSITY_BUDGET) return residentScale
  // 4^ceil(log4(ratio)) >= ratio, so the first divisor already lands within
  // the budget; the extra halving keeps parity with the viewer's integer-tile
  // fallback for degenerate dimensions.
  const divisor = Math.pow(2, Math.ceil(Math.log(demand / INTERACTION_ADAPTIVE_DENSITY_BUDGET) / Math.log(4)))
  let scale = residentScale / divisor
  if (bounds.width * bounds.height * scale * scale > INTERACTION_ADAPTIVE_DENSITY_BUDGET)
    scale = residentScale / (divisor * 2)
  return Number.isFinite(scale) && scale > 0 ? scale : residentScale
}
