import type { Bounds, Matrix } from './model'

// Display-only formatting for the on-canvas W×H chip. Two decimal places match
// the selection chip in Figma and drop float noise such as 20.6079998016.
// Authored geometry and Inspector metrics stay exact; this never writes back.
const dimensionFormat = new Intl.NumberFormat('en-US', { useGrouping: false, minimumFractionDigits: 0, maximumFractionDigits: 2 })
export function formatLogicalDimension(value: number): string {
  return Number.isFinite(value) ? dimensionFormat.format(Object.is(value, -0) ? 0 : value) : '—'
}
/** Preserve the established selection/Inspector unit contract: single geometry
 * uses local axes times world-basis axis magnitudes (never a rotated world AABB).
 * Groups measure their children in group axes; multi-selection uses its aggregate.
 * Changing ancestor-scale semantics requires a coordinated property/resize change. */
export function selectionSizeLabel(local: Pick<Bounds, 'width'|'height'> | null, aggregate: Pick<Bounds, 'width'|'height'>, basis?: Matrix): string {
  const width = local ? local.width * (basis ? Math.hypot(basis[0],basis[1]) : 1) : aggregate.width
  const height = local ? local.height * (basis ? Math.hypot(basis[2],basis[3]) : 1) : aggregate.height
  return `${formatLogicalDimension(width)} × ${formatLogicalDimension(height)}`
}
