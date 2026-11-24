/** Display-only multiresolution Gaussian prototype (default off).
 *
 * The generic Gaussian executor convolves every device texel with O(device
 * radius) rational taps. At high camera zoom x DPR the device radius grows
 * with the view, so both the working surfaces and the encoded pass pixels
 * explode even though the authored blur is unchanged. This recipe keeps the
 * authored sigma, support and effect order, but executes the separable box
 * approximation on a coarser work lattice:
 *
 *   1. anti-alias prefilter + downsample the already-resolved source surface
 *      (the existing mode-75 cascaded 2x2 area average, one level per halving),
 *   2. run the unchanged box blur at the proportionally reduced sigma
 *      (sigma / factor, NOT a device-resolution radius),
 *   3. bilinearly reconstruct back to the original device lattice (mode 74).
 *
 * Only the display execution changes. The exact/export/readback rational
 * accumulator, HDR values, authored radius, halo and composition lattice are
 * never touched: a readback or non-present frame fails the admission below and
 * keeps the original full-density operator. The reduced sigma floor keeps the
 * blurred field smooth enough that bilinear reconstruction stays inside the
 * frozen SDR display gate; it is a display approximation, never an exact claim.
 */

/** Reduced sigma is kept in [32, 64) so the reconstructed field is smooth on
 * the device lattice. Mirrors the shipped source-detail LOD level selection. */
export const MULTIRES_BLUR_REDUCED_SIGMA = 32
/** The generic box lane admits sigma up to 512 per box; the regional lane up
 * to 1024. The prototype only needs the ordinary display range. */
export const MULTIRES_BLUR_MIN_SIGMA = 48
export const MULTIRES_BLUR_MAX_SIGMA = 16384
export const MULTIRES_BLUR_MAX_LEVELS = 8

/** Number of halving levels for a device sigma, or undefined when the sigma is
 * outside the display prototype range. Pure policy: no scene/driver authority. */
export function multiresBlurLevels(sigma: number, maxLevels = MULTIRES_BLUR_MAX_LEVELS): number | undefined {
  if (!Number.isFinite(sigma) || sigma < MULTIRES_BLUR_MIN_SIGMA || sigma > MULTIRES_BLUR_MAX_SIGMA) return undefined
  if (!Number.isInteger(maxLevels) || maxLevels < 1) return undefined
  const levels = Math.floor(Math.log2(sigma / MULTIRES_BLUR_REDUCED_SIGMA))
  if (levels < 1) return undefined
  return Math.min(maxLevels, levels)
}

/** Launch gate for the display-only capability. Both the worker scene intent
 * and the real render(readback,present) boundary must agree; a reused scene
 * object can never admit this on an export/readback frame. Mirrors the strict
 * canvas-blur display eligibility without the source-detail-tile requirement. */
export function multiresDisplayBlurEligible(
  enabled: boolean,
  scene: { softwareRaster?: boolean },
  driver: { name?: string; managed?: boolean; hdr?: boolean; displayMath?: boolean },
  readback: boolean, present: boolean,
): boolean {
  return enabled && !readback && present && driver.name === 'webgpu' && driver.managed === true &&
    !driver.hdr && !driver.displayMath && !scene.softwareRaster
}