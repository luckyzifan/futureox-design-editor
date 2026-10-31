import type { CanvasCamera } from '../../canvas-camera'
import type { CompositeItem, TilePlacement } from './tile-compositor'
import type { RasterTile } from '../tile-cache'
type Box = { left: number; top: number; right: number; bottom: number }
/** One pixel ownership rule for the scissor AND its quad. A float quad cut at
 * the tile core can rasterize just short of an integer scissor at a half-pixel
 * boundary. Project the owned pixel rectangle back into the original texture
 * instead; gutters remain available for filtering, without overlapping draws. */
export function compositeRasterQuad(p: TilePlacement, clip: Box, width: number, height: number, dpr: number) {
  const w = Math.max(1, Math.ceil(width * dpr)), h = Math.max(1, Math.ceil(height * dpr))
  const sx = w / width, sy = h / height
  // Equivalent edges calculated by neighbouring tiles can differ in the last
  // double bit. Canonicalize that noise before assigning a pixel centre.
  const edge = (value: number, scale: number) => Math.ceil(value * scale - 0.5 - 1e-7)
  const x = Math.max(0, edge(clip.left, sx)), y = Math.max(0, edge(clip.top, sy))
  const right = Math.min(w, edge(clip.right, sx)), bottom = Math.min(h, edge(clip.bottom, sy))
  if (right <= x || bottom <= y) return null
  const left = x / sx, top = y / sy, pw = (right - x) / sx, ph = (bottom - y) / sy
  return { x, y, width: right - x, height: bottom - y,
    box: [left, top, pw, ph] as const,
    uv: [(left - p.left) / p.width, (top - p.top) / p.height, pw / p.width, ph / p.height] as const }
}
export function compositePlacement(item: { tile: RasterTile; placement?: TilePlacement }, view: CanvasCamera): TilePlacement {
  const tile = item.tile,
    s = view.zoom / tile.zoom
  return (
    item.placement || {
      left: (tile.x - (tile.phaseX || 0)) * s + view.x,
      top: (tile.y - (tile.phaseY || 0)) * s + view.y,
      width: tile.width * s,
      height: tile.height * s,
    }
  )
}
/** Keep disjoint fragments by reference. Allocate a replacement list only
 * when an occluder really cuts one; tiled resident grids otherwise allocate
 * two short-lived arrays for every non-overlapping tile pair. The comparison,
 * fragment order and arithmetic stay identical to the original subtraction. */
const subtract = (fragments: Box[], b: Box): Box[] => {
  let pieces: Box[] | undefined
  for (let index = 0; index < fragments.length; index++) {
    const a = fragments[index],
      left = Math.max(a.left, b.left),
      right = Math.min(a.right, b.right),
      top = Math.max(a.top, b.top),
      bottom = Math.min(a.bottom, b.bottom)
    if (left >= right || top >= bottom) {
      pieces?.push(a)
      continue
    }
    pieces ??= fragments.slice(0, index)
    if (a.top < top) pieces.push({ ...a, bottom: top })
    if (bottom < a.bottom) pieces.push({ ...a, top: bottom })
    if (a.left < left) pieces.push({ left: a.left, right: left, top, bottom })
    if (right < a.right) pieces.push({ left: right, right: a.right, top, bottom })
  }
  return pieces ?? fragments
}
/** Old density layers supply holes only. Repainting every historical zoom
 * texture under an opaque newer tile wastes fill rate during camera motion. */
export function compositeDrawPlan(
  items: readonly CompositeItem[],
  view: CanvasCamera,
  width: number,
  height: number,
) {
  const covered: Box[] = [],
    draws: { item: CompositeItem; placement: TilePlacement; clip: Box }[] = []
  const ordered = items
    .filter((i) => i.active)
    // Cache/LRU order can change on a pan without any new pixels. Equal-level
    // overlapping phases must keep the same winner until a real replacement
    // arrives, rather than alternately exposing their antialiasing samples.
    .sort((a, b) => a.layer - b.layer || a.tile.zoom - b.tile.zoom || a.tile.serial - b.tile.serial)
  for (let i = ordered.length - 1; i >= 0; i--) {
    const item = ordered[i],
      p = compositePlacement(item, view),
      // Production tiles carry a 512px core plus one filtering sample per
      // edge. Viewport captures explicitly opt out with gutter: 0.
      g = item.gutter ?? 1,
      sx = p.width / item.tile.width,
      sy = p.height / item.tile.height
    const clip = item.clip
    const box = {
      left: Math.max(0, p.left + sx * g, clip?.left ?? -Infinity),
      top: Math.max(0, p.top + sy * g, clip?.top ?? -Infinity),
      right: Math.min(width, p.left + p.width - sx * g, clip ? clip.left + clip.width : Infinity),
      bottom: Math.min(height, p.top + p.height - sy * g, clip ? clip.top + clip.height : Infinity),
    }
    if (box.left >= box.right || box.top >= box.bottom) continue
    let fragments = [box]
    for (const occluder of covered) {
      fragments = subtract(fragments, occluder)
      if (!fragments.length) break
    }
    for (const clip of fragments) draws.push({ item, placement: p, clip })
    if (!item.blend) covered.push(box)
  }
  return draws.reverse()
}
