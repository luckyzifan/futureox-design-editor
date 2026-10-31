import type { DesignDocument } from '../../model'
import { equalValue } from '../../document-patch'
import type { GpuScene } from './types'
import type { ResidentFrame } from './resident-presenter'
import { compositeDrawPlan, compositePlacement } from './composite-draw-plan'

/** Admission for committing the native-density frame already displayed by a
 * validated integer translation. This is canvas residency, never an export or
 * an exact-tile-cache certificate. Changed content, density reduction, stale
 * input and incomplete coverage all take the normal compiler path. */
export function canCommitResidentFrame(scene: GpuScene, document: DesignDocument,
  next: DesignDocument, frame: ResidentFrame, input: { sequence: number; owner?: string } | undefined) {
  if (!input || frame.input?.sequence !== input.sequence || frame.input.owner !== input.owner || !frame.interaction ||
      scene.softwareRaster || scene.grid || scene.checkerboard || !equalValue(document, next) ||
      Math.abs(scene.view.zoom / (frame.view.zoom * frame.dpr) - 1) > 1e-8) return false
  for (const node of Object.values(scene.nodes)) {
    const source = node.previewSource
    if (source && [node.matrix[4] - source.matrix[4], node.matrix[5] - source.matrix[5]]
      .some(delta => Math.abs(delta - Math.round(delta)) > 1e-7)) return false
    // A preview-only blur activation change is not a settled display frame.
    if (node.effects.some(effect => effect.kind === 'blur' && effect.radius === 0) &&
        next.nodes[node.id]?.effects.some(effect => effect.visible && effect.kind === 'blur' && effect.radius > 0)) return false
  }
  // The draw planner only reads geometry; resident handles intentionally carry
  // no CPU byte payload.
  const draws = compositeDrawPlan(frame.items as unknown as Parameters<typeof compositeDrawPlan>[0], frame.view, frame.width, frame.height)
  let area = 0
  for (const { item, clip } of draws) {
    const p = compositePlacement(item, frame.view)
    if (item.blend || item.tile.width / p.width < frame.dpr * .999 || item.tile.height / p.height < frame.dpr * .999) return false
    area += (clip.right - clip.left) * (clip.bottom - clip.top)
  }
  return Math.abs(area - frame.width * frame.height) <= Math.max(1, area) * 1e-8
}
