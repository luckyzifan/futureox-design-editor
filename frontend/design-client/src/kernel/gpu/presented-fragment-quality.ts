import { physicalCoverage } from './physical-coverage'

export type PresentedFragment = {
  x: number; y: number; width: number; height: number
  sourceWidth: number; sourceHeight: number
  uv: readonly [number, number, number, number]
  blend?: boolean
}

/** Diagnostics of the actual clipped GPU draws, in physical display pixels.
 * The fractions retain the existing 96-point meaning; the two complete gates
 * inspect every physical rectangle, and maxUpscale inspects every fragment.
 * A transparent draw cannot prove coverage and an undersampled blended layer
 * cannot borrow its background's sharpness. This does not inspect texture
 * alpha/content, prove effect fidelity, or make a physical-display FPS claim. */
export function presentedFragmentQuality(fragments: readonly PresentedFragment[], width: number, height: number) {
  const integer = (value: number) => Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-7
  const rows = fragments.map(row => {
    const dx = row.sourceWidth * row.uv[2] / row.width, dy = row.sourceHeight * row.uv[3] / row.height
    const density = Number.isFinite(dx) && Number.isFinite(dy) ? Math.max(0, Math.min(dx, dy)) : 0
    return { ...row, density, native: density >= 1 - 1e-10,
      phase: Math.abs(dx - 1) < 1e-10 && Math.abs(dy - 1) < 1e-10 &&
        integer(row.uv[0] * row.sourceWidth) && integer(row.uv[1] * row.sourceHeight) }
  })
  let maxUpscale = 1
  for (const row of rows) maxUpscale = Math.max(maxUpscale, row.density > 0 ? 1 / row.density : Number.MAX_SAFE_INTEGER)
  const complete = physicalCoverage(rows, width, height)
  // Non-blended fragments have already been clipped against later opaque
  // draws. A surviving coarse blend contributes above them somewhere, even
  // when none of the sparse diagnostic points happens to cross that region.
  complete.nativeCoverageComplete &&= !rows.some(row => row.blend && !row.native)
  let covered = 0, sharp = 0, phaseMatched = 0
  for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
    const px = (x + .5) * width / 12, py = (y + .5) * height / 8
    let coverage = false, native = false, phase = false
    for (const row of rows) {
      if (px < row.x || px >= row.x + row.width || py < row.y || py >= row.y + row.height) continue
      if (!row.blend) { coverage = true; native = row.native; phase = row.phase }
      else { native &&= row.native; phase &&= row.phase }
    }
    if (coverage) { covered++; if (native) sharp++; if (phase) phaseMatched++ }
  }
  return { coverage: covered / 96, sharpCoverage: sharp / 96, nativePhaseCoverage: phaseMatched / 96, maxUpscale, ...complete }
}
