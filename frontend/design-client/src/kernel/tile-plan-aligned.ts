import { raster_tile_addresses_json } from '../generated/design-kernel/design_kernel'
import { TILE_SIDE, type RasterTile } from './tile-cache'
import { tileViewportDistance } from './tile-scheduler'
/** The Rust tile stack owns production addressing, including exact fractional
 * camera phase. Rendering retains the existing one-pixel gutters and order. */
export function planTilesAligned(bounds: {x:number;y:number;width:number;height:number}, zoom:number, limit=256, phase={x:0,y:0}): RasterTile[] {
  const addresses=JSON.parse(raster_tile_addresses_json(new Float64Array([bounds.x,bounds.y,bounds.width,bounds.height]),zoom,limit,new Float64Array([phase.x,phase.y]))) as [number,number][]
  const cx=(bounds.x+bounds.width/2)*zoom,cy=(bounds.y+bounds.height/2)*zoom
  const half=TILE_SIDE/2
  return addresses.map(([x,y])=>({key:`${zoom}:${phase.x}:${phase.y}:${x}:${y}`,x:x*TILE_SIDE-1,y:y*TILE_SIDE-1,width:TILE_SIDE+2,height:TILE_SIDE+2,gutter:1,zoom,phaseX:phase.x,phaseY:phase.y})).sort((a,b)=>Math.hypot(a.x+half-cx,a.y+half-cy)-Math.hypot(b.x+half-cx,b.y+half-cy))
}

export const DEFAULT_TILE_PREFETCH_RINGS = 1
/** Upper clamp for the host override: the plan limit (<= 256 tiles) already
 * bounds how much of a wider rim can ever be scheduled; the clamp only keeps
 * address enumeration bounded. */
export const MAX_TILE_PREFETCH_RINGS = 4

export type TilePrefetchRimPlan = {
  /** Exactly the planTilesAligned result for these arguments (same objects,
   * same order); completion semantics never depend on the rim. */
  viewport: RasterTile[]
  /** Rings of tiles around the viewport set, nearest ring first, each marked
   * `prefetch` so the fill scheduler routes it through the off-screen budget
   * branch (never the on-screen exemption). */
  rim: RasterTile[]
  /** Rim tiles dropped because the plan limit (the resident-cache-derived
   * tile allowance) had no room left after the viewport tiles. */
  cacheLimitSkipped: number
}

export function planTilesWithPrefetchRim(
  bounds: { x: number; y: number; width: number; height: number },
  zoom: number,
  limit = 256,
  phase = { x: 0, y: 0 },
  rings?: number,
): TilePrefetchRimPlan {
  const viewport = planTilesAligned(bounds, zoom, limit, phase)
  if (rings === undefined) return viewportHeightPrefetch(viewport, bounds, zoom, limit, phase)
  if (!Number.isFinite(rings) || rings < 1 || !viewport.length)
    return { viewport, rim: [], cacheLimitSkipped: 0 }
  const ringCount = Math.min(Math.floor(rings), MAX_TILE_PREFETCH_RINGS)
  // Addresses recover exactly from the planned geometry (x = addr*TILE_SIDE-1
  // is integer arithmetic; the key is not parsed because callers rekey).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const inViewport = new Set<string>()
  for (const tile of viewport) {
    const ax = (tile.x + 1) / TILE_SIDE, ay = (tile.y + 1) / TILE_SIDE
    inViewport.add(`${ax}:${ay}`)
    if (ax < minX) minX = ax
    if (ax > maxX) maxX = ax
    if (ay < minY) minY = ay
    if (ay > maxY) maxY = ay
  }
  const ranked: { tile: RasterTile; ring: number }[] = []
  for (let ay = minY - ringCount; ay <= maxY + ringCount; ay++)
    for (let ax = minX - ringCount; ax <= maxX + ringCount; ax++) {
      if (inViewport.has(`${ax}:${ay}`)) continue
      const ring = Math.max(
        ax < minX ? minX - ax : ax > maxX ? ax - maxX : 0,
        ay < minY ? minY - ay : ay > maxY ? ay - maxY : 0,
      )
      ranked.push({
        ring,
        tile: {
          key: `${zoom}:${phase.x}:${phase.y}:${ax}:${ay}`,
          x: ax * TILE_SIDE - 1,
          y: ay * TILE_SIDE - 1,
          width: TILE_SIDE + 2,
          height: TILE_SIDE + 2,
          gutter: 1,
          zoom,
          phaseX: phase.x,
          phaseY: phase.y,
          prefetch: true,
        },
      })
    }
  ranked.sort((a, b) => a.ring - b.ring || a.tile.y - b.tile.y || a.tile.x - b.tile.x)
  const allowance = Math.max(0, limit - viewport.length)
  const kept = ranked.slice(0, allowance)
  return {
    viewport,
    rim: kept.map((entry) => entry.tile),
    cacheLimitSkipped: ranked.length - kept.length,
  }
}

/** Host override for the prefetch rim width (whole tile rings). localStorage
 * is optional and absent in non-browser hosts; missing or invalid values keep
 * the default (`Number(null)` is 0, so the raw string is checked first — an
 * absent key must never read as "rings 0"). 0 restores the pre-rim behaviour
 * exactly. */
export function tilePrefetchRingsFromHost(): number | undefined {
  try {
    const raw = localStorage.getItem('forma.render.tilePrefetchRings')
    if (raw !== null && raw.trim() !== '') {
      const rings = Number(raw)
      if (Number.isSafeInteger(rings) && rings >= 0)
        return Math.min(rings, MAX_TILE_PREFETCH_RINGS)
    }
  } catch {
    /* Storage is optional; the product default applies. */
  }
  // No override: Figma drawOnScreenTiles expands every edge by viewport.height().
  return undefined
}

/** Exact viewer prefetch extent, with bounded enumeration. A nearest-first
 * frontier visits only the cache allowance plus its boundary, rather than
 * allocating every candidate in a very tall/wide expanded viewport. */
function viewportHeightPrefetch(viewport: RasterTile[], bounds: { x: number; y: number; width: number; height: number },
  zoom: number, limit: number, phase: { x: number; y: number }): TilePrefetchRimPlan {
  if (!viewport.length || bounds.height <= 0) return { viewport, rim: [], cacheLimitSkipped: 0 }
  const pad = bounds.height
  const x0 = Math.floor(((bounds.x - pad) * zoom + phase.x) / TILE_SIDE)
  const y0 = Math.floor(((bounds.y - pad) * zoom + phase.y) / TILE_SIDE)
  const x1 = Math.ceil(((bounds.x + bounds.width + pad) * zoom + phase.x) / TILE_SIDE)
  const y1 = Math.ceil(((bounds.y + bounds.height + pad) * zoom + phase.y) / TILE_SIDE)
  const total = (x1 - x0) * (y1 - y0) - viewport.length
  const allowance = Math.max(0, limit - viewport.length)
  const visited = new Set(viewport.map(t => `${(t.x + 1) / TILE_SIDE}:${(t.y + 1) / TILE_SIDE}`))
  const queue: { tile: RasterTile; distance: number; x: number; y: number }[] = []
  const add = (x: number, y: number) => {
    const key = `${x}:${y}`
    if (x < x0 || x >= x1 || y < y0 || y >= y1 || visited.has(key)) return
    visited.add(key)
    const tile: RasterTile = { key: `${zoom}:${phase.x}:${phase.y}:${x}:${y}`, x: x * TILE_SIDE - 1,
      y: y * TILE_SIDE - 1, width: TILE_SIDE + 2, height: TILE_SIDE + 2, gutter: 1, zoom,
      phaseX: phase.x, phaseY: phase.y, prefetch: true }
    const item = { tile, distance: tileViewportDistance(tile, bounds), x, y }
    let lo = 0, hi = queue.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1, b = queue[mid]
      const cmp = item.distance - b.distance || item.y - b.y || item.x - b.x
      if (cmp < 0) hi = mid; else lo = mid + 1
    }
    queue.splice(lo, 0, item)
  }
  for (const t of viewport) {
    const x = (t.x + 1) / TILE_SIDE, y = (t.y + 1) / TILE_SIDE
    add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1)
  }
  const rim: RasterTile[] = []
  while (rim.length < allowance && queue.length) {
    const item = queue.shift()!
    rim.push(item.tile)
    add(item.x - 1, item.y); add(item.x + 1, item.y); add(item.x, item.y - 1); add(item.x, item.y + 1)
  }
  return { viewport, rim, cacheLimitSkipped: total - rim.length }
}
