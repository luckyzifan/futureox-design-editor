import type { CanvasCamera } from '../../canvas-camera'
import type { CompositeItem } from './tile-compositor'

/** Spatial sampling of the *presented* tile stack, not the requested plan.
 * sharpCoverage is the legacy density-only metric, not an exactness claim.
 * nativePhaseCoverage additionally requires one-to-one device sampling and an
 * aligned pixel origin; neither metric certifies color/effect fidelity. */
export function presentationQuality(
  items: readonly CompositeItem[],
  view: CanvasCamera,
  width: number,
  height: number,
  dpr: number,
) {
  const ordered = items
    .filter((item) => item.active)
    .sort((a, b) => a.layer - b.layer || a.tile.zoom - b.tile.zoom)
  let covered = 0,
    sharp = 0,
    phaseMatched = 0,
    maxUpscale = 1
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 12; column++) {
      const x = ((column + 0.5) * width) / 12,
        y = ((row + 0.5) * height) / 8
      let density = 0, nativePhase = false
      for (const { tile, placement, clip, gutter = 1 } of ordered) {
        if (
          clip &&
          (x < clip.left ||
            x >= clip.left + clip.width ||
            y < clip.top ||
            y >= clip.top + clip.height)
        )
          continue
        const scale = view.zoom / tile.zoom
        const box = placement || {
          left: (tile.x - (tile.phaseX || 0)) * scale + view.x,
          top: (tile.y - (tile.phaseY || 0)) * scale + view.y,
          width: tile.width * scale,
          height: tile.height * scale,
        }
        const sx = box.width / tile.width,
          sy = box.height / tile.height
        if (
          x >= box.left + gutter * sx &&
          x < box.left + box.width - gutter * sx &&
          y >= box.top + gutter * sy &&
          y < box.top + box.height - gutter * sy
        ) {
          density = Math.min(1 / sx, 1 / sy) / dpr
          const dx = Math.ceil(width * dpr) / width, dy = Math.ceil(height * dpr) / height
          const integer = (value: number) => Number.isFinite(value) && Math.abs(value - Math.round(value)) < 1e-7
          nativePhase = Math.abs(sx * dx - 1) < 1e-10 && Math.abs(sy * dy - 1) < 1e-10 &&
            integer(box.left * dx) && integer(box.top * dy)
        }
      }
      if (density > 0) {
        covered++
        if (density >= 0.999) sharp++
        if (nativePhase) phaseMatched++
        maxUpscale = Math.max(maxUpscale, 1 / density)
      }
    }
  return { coverage: covered / 96, sharpCoverage: sharp / 96, nativePhaseCoverage: phaseMatched / 96, maxUpscale }
}
