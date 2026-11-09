import type { CanvasCamera } from './canvas-camera'
import type { SourceCanvasBox, SourceCanvasItem, SourceCanvasSnapshot } from './desktop'
import type { ResidentAcknowledgement } from './kernel/resident-presentation'
import { previewCameraScaleWithinLimit } from './kernel/tile-preview'

export type SourceNativeCoverage = {
  source: SourceCanvasSnapshot
  frame: ResidentAcknowledgement
  regions: readonly SourceCanvasBox[]
}

/** A complete bitmap of one selected material does not acknowledge its page's
 * other thumbnails. Early opening-material snapshots have the same boundary. */
export function acceptedSourceNativeRegions(source: SourceCanvasSnapshot,
  regions: readonly (SourceCanvasBox & { materialKey?: string })[] | undefined,
  items: readonly SourceCanvasItem[], pageId?: string,
  materialBoxes?: readonly (SourceCanvasBox & { materialKey?: string })[]) {
  if (source.materialKeys) {
    // Opening thumbnails keep their original keys across a native rebind.
    // Only current catalogue boxes or the actual ACK carry current authority.
    const keys = new Set(source.materialKeys)
    return (regions ?? materialBoxes ?? []).filter(box =>
      box.materialKey !== undefined && keys.has(box.materialKey))
  }
  if (source.openingMaterial !== undefined) {
    const item = items[source.openingMaterial]
    return item && (!pageId || item.pageId === pageId) ? [item.placed] : []
  }
  return regions ?? items.filter(item => !pageId || item.pageId === pageId).map(item => item.placed)
}

/** Only accepted native pixels open holes in the upper thumbnail/pasteboard
 * layer. A pan cannot expose pixels beyond the acknowledged bitmap footprint. */
export function visibleSourceNativeRegions(coverage: SourceNativeCoverage | undefined,
  source: SourceCanvasSnapshot | undefined, view: CanvasCamera, hidden: boolean) {
  if (!coverage || !source || hidden || coverage.source.token !== source.token ||
      coverage.source.revision !== source.revision ||
      coverage.source.owner.documentId !== source.owner.documentId ||
      coverage.source.owner.sessionEpoch !== source.owner.sessionEpoch ||
      !previewCameraScaleWithinLimit(coverage.frame.view.zoom, view.zoom)) return []
  const { frame } = coverage, zoom = frame.view.zoom
  const left = -frame.view.x / zoom, top = -frame.view.y / zoom
  const right = left + frame.width / zoom, bottom = top + frame.height / zoom
  return coverage.regions.flatMap(box => {
    const x = Math.max(left, box.x), y = Math.max(top, box.y)
    const r = Math.min(right, box.x + box.width), b = Math.min(bottom, box.y + box.height)
    return r > x && b > y ? [{ x, y, width: r - x, height: b - y }] : []
  })
}
