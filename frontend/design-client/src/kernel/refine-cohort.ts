/** Quiet native-source scheduling. Interactive motion stays on the small
 * pipeline so a reversal can abort before the next tile. A stopped large
 * viewport may occupy the same eight-tile cohort the settled overview
 * already uses, so preparation keeps overlapping the GPU across the screen. */
export const SETTLED_SOURCE_COHORT = 8

export function sourceRasterBatchLimit(input: {
  overviewMode: boolean
  optional: boolean
  moving: boolean
  rasterScale: number
  nodes: number
  pipelineTiles: number
}) {
  const quiet = !input.optional && !input.moving && input.rasterScale > 0 && input.rasterScale <= 1
  if (quiet && (input.overviewMode || input.nodes >= 3000)) return SETTLED_SOURCE_COHORT
  return input.pipelineTiles
}

/** The overview dense-paint admission, also for a stopped full-artboard
 * cohort. Zoom above 1, exports, HDR and motion keep the ordinary draws. */
export function sourceDensePaintRequested(input: {
  enabled: boolean
  sourceSnapshot: boolean
  channel: string
  renderIntent: string | undefined
  tileOwner: boolean
  zoom: number
  backend: string
  rasterProfile: string | undefined
  hdr: boolean
  reference: boolean
  png: boolean
  readback: boolean
  exportFormat: boolean
  exportRegion: boolean
  pixelPreview: boolean
  animation: boolean
  materialOverview: boolean
  settledCohort: boolean
}) {
  return input.enabled && (input.materialOverview || input.settledCohort) && input.sourceSnapshot &&
    input.channel === 'canvas' && input.renderIntent === 'preview' && input.tileOwner &&
    input.zoom <= 1 && input.backend === 'webgpu' && input.rasterProfile === 'figmaSubpixel' &&
    !input.hdr && !input.reference && !input.png && !input.readback && !input.exportFormat &&
    !input.exportRegion && !input.pixelPreview && !input.animation
}

/** A cold large page or a high zoom must not raster every coarse tile before
 * the first exact one. The nearest tile still covers the focal area. Callers
 * pass device-pixel tiles; centers are compared in world space. */
export function leadingCoarseTiles<T extends { x: number; y: number; width: number; height: number; zoom: number }>(
  tiles: readonly T[],
  input: { nodes: number; zoom: number; centerX: number; centerY: number },
): readonly T[] {
  if (tiles.length <= 1) return tiles
  const heavy = input.nodes >= 3000 || (Number.isFinite(input.zoom) && input.zoom >= 2)
  if (!heavy) return tiles
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]
    if (!(tile.zoom > 0)) continue
    const dx = (tile.x + tile.width / 2) / tile.zoom - input.centerX
    const dy = (tile.y + tile.height / 2) / tile.zoom - input.centerY
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return [tiles[best]]
}
