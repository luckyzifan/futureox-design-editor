import type { Bounds, Matrix } from './model'

// Display-only formatting: never writes rounded values back to authored geometry.
// Twelve significant digits suppress transform floating-point noise while retaining
// fractional design units. This is not device/DPR or raster-output pixel size.
const dimensionFormat = new Intl.NumberFormat('en-US', { useGrouping: false, maximumSignificantDigits: 12 })
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
