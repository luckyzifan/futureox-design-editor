import { fullSampleCoverage, HORIZONTAL_FILTER_CACHE_BYTES } from './gpu/horizontal-filter-cache'
import { exactBlendLattice } from './gpu/effect-region'
import { sceneScale } from './gpu/scene-index'
import { intersect, type GpuScene } from './gpu/types'
import { tileOverlapsViewport, type ViewportRect } from './tile-scheduler'
import type { RasterTile, TileFillPriority } from './tile-cache'

export type FilterColumnSupport = { sourceScale: number; sourceRows: number }

/** Scheduling evidence from the actual compiled packet, never an authored
 * AABB guess. This does not certify a cache hit: final upload finiteness,
 * memory admission and exact source identity remain renderer decisions. */
export function compiledFilterColumnSupport(scene: GpuScene, tile: RasterTile): FilterColumnSupport | undefined {
  const bounded = typeof scene.displayFilterRadiusLimit === 'number' &&
    Number.isFinite(scene.displayFilterRadiusLimit) && scene.displayFilterRadiusLimit > 0 && scene.displayFilterRadiusLimit <= 32
  if (!scene.floatCompositing || !scene.coherentSamples || !scene.integratedBlur || scene.displayFilters && !bounded ||
      scene.interactionRetained || scene.softwareRaster || !exactBlendLattice([scene.extent])) return
  const sourceScale = scene.view.zoom / tile.zoom
  if (sourceScale !== 1 && sourceScale !== 2) return
  for (const n of Object.values(scene.nodes)) {
    if (n.opacity <= 0 || n.children.length || n.passthrough || n.clip || n.mask || n.maskId ||
        n.strokes.length || n.previewSource || !n.fill.area || !n.fill.count) continue
    const effects = n.effects.filter(effect => effect.visible), fills = n.fills.filter(paint => paint.visible)
    if (effects.length !== 1 || effects[0].kind !== 'blur' || effects[0].gradientBlur ||
        fills.length !== 1 || fills[0].kind !== 'image' || !fills[0].image ||
        fills[0].blend !== 'normal' || fills[0].opacity !== 1 ||
        n.fills.some(paint => paint.kind !== 'image' && paint.kind !== 'solid')) continue
    const radius = effects[0].radius * sceneScale(n.matrix)
    if (!(radius >= 64 && radius <= 2048)) continue
    const output = intersect(n.rect, scene.extent)
    // Partial clipped output columns can change their x/w at the next tile.
    if (output.x !== scene.extent.x || output.y !== scene.extent.y ||
        output.w !== scene.extent.w || output.h !== scene.extent.h) continue
    const reach = Math.ceil(radius) + 1
    const input = intersect(n.rect, { x: output.x - reach, y: output.y - reach,
      w: output.w + 2 * reach, h: output.h + 2 * reach })
    if (!exactBlendLattice([input]) || input.w > 8192 || input.h > 8192 ||
        output.w * input.h * 16 > HORIZONTAL_FILTER_CACHE_BYTES ||
        !fullSampleCoverage(n.fill, scene.curves, input)) continue
    return { sourceScale, sourceRows: input.h }
  }
}

export function validTileFillPriorities(value: unknown, length: number): value is TileFillPriority[] {
  return Array.isArray(value) && value.length === length &&
    value.every(priority => priority === 0 || priority === 1 || priority === 2)
}

/** Tiles never move; only original indices do. chooseNext locks one slot
 * before PrepareAhead.start, whose producer/consumer use that same index. */
export class FilterTileOrder {
  private indices: number[]
  private chosenThrough = -1
  constructor(private tiles: readonly RasterTile[], private priorities?: readonly TileFillPriority[],
    private viewport?: ViewportRect) {
    this.indices = tiles.map((_, index) => index)
  }
  indexAt(position: number) { return this.indices[position] }
  chooseNext(position: number, support?: FilterColumnSupport) {
    const next = position + 1
    if (position <= this.chosenThrough || !support || !Number.isFinite(support.sourceRows) || support.sourceRows <= 0 ||
        (support.sourceScale !== 1 && support.sourceScale !== 2) || !this.priorities || !this.viewport ||
        this.priorities.length !== this.tiles.length || next >= this.indices.length) {
      this.chosenThrough = Math.max(this.chosenThrough, position)
      return { index: this.indices[next], changed: false, deltaY: 0 }
    }
    this.chosenThrough = position
    const current = this.tiles[this.indices[position]], firstIndex = this.indices[next], tier = this.priorities[firstIndex]
    if (current.prefetch || !tileOverlapsViewport(current, this.viewport) ||
        this.tiles[firstIndex].prefetch || !tileOverlapsViewport(this.tiles[firstIndex], this.viewport))
      return { index: firstIndex, changed: false, deltaY: 0 }
    const candidates: { position: number; index: number; y: number }[] = []
    for (let at = next; at < this.indices.length; at++) {
      const index = this.indices[at], tile = this.tiles[index]
      // A priority/visibility boundary is a barrier, never a search skip.
      if (this.priorities[index] !== tier || tile.prefetch || !tileOverlapsViewport(tile, this.viewport)) break
      if (tile.x === current.x && tile.width === current.width && tile.height === current.height &&
          Object.is(tile.zoom, current.zoom) && Object.is(tile.phaseX ?? 0, current.phaseX ?? 0) &&
          Object.is(tile.phaseY ?? 0, current.phaseY ?? 0))
        candidates.push({ position: at, index, y: tile.y })
    }
    if (!candidates.length) return { index: firstIndex, changed: false, deltaY: 0 }
    const below = candidates.filter(candidate => candidate.y > current.y), above = candidates.filter(candidate => candidate.y < current.y)
    // Visit the nearer endpoint first when starting in the middle of a column.
    // Reaching that endpoint before reversing avoids the longest back-jump.
    const low = Math.min(...candidates.map(candidate => candidate.y)), high = Math.max(...candidates.map(candidate => candidate.y))
    const direction = above.length && below.length
      ? current.y - low <= high - current.y ? above : below : candidates
    const chosen = [...direction].sort((a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y) || a.index - b.index)[0]
    const deltaY = chosen.y - current.y
    if (Math.abs(deltaY) * support.sourceScale >= support.sourceRows)
      return { index: firstIndex, changed: false, deltaY: 0 }
    if (chosen.position !== next) this.indices.splice(next, 0, this.indices.splice(chosen.position, 1)[0])
    return { index: chosen.index, changed: chosen.position !== next, deltaY }
  }
}
