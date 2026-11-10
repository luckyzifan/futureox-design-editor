import type { CanvasCamera } from '../canvas-camera'
import type { RasterTile } from './tile-cache'

/** Same-zoom pan heading. A step against the previous step flips `reversed`.
 * Continuing that heading keeps the flag, so the whole return yields trailing
 * refine work. Another reversal restores the forward heading. Zoom changes
 * pass no step and clear both. Tile keys are not part of this state. */
export function nextPanHeading(travel: { x: number; y: number } | undefined, step: { x: number; y: number } | undefined, reversed: boolean) {
  if (!step || !(step.x || step.y)) return { travel: undefined, reversed: false }
  const flipped = !!travel && travel.x * step.x + travel.y * step.y < 0
  return { travel: { x: step.x, y: step.y }, reversed: flipped ? !reversed : reversed }
}

/** Warm the edge a pan is approaching while its pixels are still offscreen.
 * Keep a small bounded set; zoom changes and directionless frames do not guess. */
export function panPrefetch(tiles: RasterTile[], previous: CanvasCamera | undefined, view: CanvasCamera,
  viewport: { x: number; y: number; width: number; height: number },
  budget = { tiles: 8, bytes: 8 * 514 * 514 * 4 }) {
  if(!Number.isSafeInteger(budget.tiles)||budget.tiles<0||!Number.isSafeInteger(budget.bytes)||budget.bytes<0)
    throw Error('Invalid pan prefetch budget')
  if (!previous || previous.zoom !== view.zoom) return []
  const dx = view.x - previous.x, dy = view.y - previous.y
  if (!dx && !dy) return []
  const right = viewport.x + viewport.width, bottom = viewport.y + viewport.height
  const candidates = tiles.filter(tile => {
    if(!tile.prefetch)return false
    const g = tile.gutter ?? 1, x = (tile.x + g - (tile.phaseX || 0)) / tile.zoom,
      y = (tile.y + g - (tile.phaseY || 0)) / tile.zoom,
      r = (tile.x + tile.width - g - (tile.phaseX || 0)) / tile.zoom,
      b = (tile.y + tile.height - g - (tile.phaseY || 0)) / tile.zoom
    const leadingX = dx > 0 ? r <= viewport.x + 1e-7 : dx < 0 && x >= right - 1e-7
    const leadingY = dy > 0 ? b <= viewport.y + 1e-7 : dy < 0 && y >= bottom - 1e-7
    return leadingX && b > viewport.y && y < bottom || leadingY && r > viewport.x && x < right || leadingX && leadingY
  })
  // Predict priority inside the existing rim, never a display pose. Clamp the
  // two-sample lookahead to half a viewport and retain both count/byte budgets.
  const x=viewport.x+viewport.width/2-Math.max(-viewport.width/2,Math.min(viewport.width/2,dx*2/view.zoom))
  const y=viewport.y+viewport.height/2-Math.max(-viewport.height/2,Math.min(viewport.height/2,dy*2/view.zoom))
  const distance=(tile:RasterTile)=>Math.hypot((tile.x+tile.width/2-(tile.phaseX||0))/tile.zoom-x,
    (tile.y+tile.height/2-(tile.phaseY||0))/tile.zoom-y)
  candidates.sort((a,b)=>distance(a)-distance(b))
  const selected:RasterTile[]=[]
  let bytes=0
  for(const tile of candidates){
    const cost=tile.width*tile.height*4
    if(selected.length>=Math.min(8,budget.tiles))break
    if(bytes+cost>budget.bytes)continue
    selected.push(tile);bytes+=cost
  }
  return selected
}
