import { MAX_PREVIEW_SCALE_RATIO } from './tile-preview'

/** One continuous zoom-in lattice. `previous` is the scale already in flight,
 * or 0 when none has been chosen. `shown` is the density of the picture on
 * screen. `motion` is the current camera's ordinary motion scale.
 * A half-octave step from a fit density near one device pixel stays near that
 * density. It is not twice the picture, so a finished tile cannot replace the
 * stretched GPU preview, and the 8× restart never arrives on the way to a few
 * hundred percent. Once the live camera has left the preview ratio, that
 * coarse rung gives way to the current motion lattice. A rung that can already
 * replace the picture stays put until the usual 1.2× / 8× bounds. */
export function continuousZoomInScale(input: {
  shown: number
  native: number
  previous: number
  motion: number
}) {
  const { shown, native, motion } = input
  const previous = input.previous
  const pastPreview = native > shown * MAX_PREVIEW_SCALE_RATIO
  const cannotReplace = previous + 1e-9 < shown * MAX_PREVIEW_SCALE_RATIO
  if (!(previous <= shown || previous > native * 1.2 || native > previous * 8 || (pastPreview && cannotReplace)))
    return previous
  const step = 2 ** (Math.floor(Math.log2(shown) * 2 + 1e-9) / 2 + .5)
  const quarter = 2 ** Math.floor(Math.log2(native / 4))
  return Math.min(motion, Math.max(step, quarter, pastPreview ? motion : 0))
}
