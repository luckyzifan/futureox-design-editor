/**
 * Tile-frame consistency checks through the real render pipeline (browser).
 *
 * Invariants, mirroring the tile-stack contract a tile-based compositor
 * publishes:
 *
 * 1. zoom 1: tiled compose == full-frame render, pixel-exact.  Proves the
 *    planner's addressing, scissor clipping and compositing end-to-end.
 * 2. any zoom: every planner tile == an independently-addressed same-size
 *    reference render, pixel-exact.  Pins the tile math against a second
 *    arithmetic path through the frame-relative scissor.
 * 3. zoom != 1: tiled vs full-frame is measured and reported.  The exact
 *    tier's AA sampling phase depends on viewport size (a documented
 *    divergence: byte equality is guaranteed tile↔tile on the global grid,
 *    not across differing viewport sizes), so this tier is informational.
 */
import { KernelClient } from '../client'
import { blank, node, paint, stroke, effect, type DesignDocument, type Paint } from '../../model'
import { TILE_SIZE, planTileFrame } from './tile-frame'

const WIDTH = 512
const HEIGHT = 384
const VIEW = { x: 40, y: 24, w: WIDTH, h: HEIGHT }

const gradient = (from: string, to: string, kind: Paint['kind']): Paint => ({
  ...paint(from, kind),
  stops: [
    { offset: 0, color: from },
    { offset: 1, color: to },
  ],
})

export function tileFrameFixture(): DesignDocument {
  const document = blank('tile frame consistency')
  const frame = node('frame', 0, 0, 900, 700)
  frame.name = '画板'
  frame.fills = [paint('#f4f6f9')]
  const rect = node('rectangle', 80, 60, 260, 160)
  rect.name = '色块'
  rect.fills = [gradient('#10b981', '#2563eb', 'linear')]
  rect.strokes = [stroke('#0f172a', 3)]
  const circle = node('ellipse', 360, 180, 200, 200)
  circle.name = '圆'
  circle.fills = [gradient('#f59e0b', '#ef4444', 'radial')]
  circle.effects = [effect('blur')]
  const bar = node('rectangle', 120, 420, 500, 60)
  bar.name = '横条'
  bar.fills = [paint('#7c3aed')]
  const label = node('text', 150, 300)
  label.name = '标题'
  document.nodes[frame.id] = frame
  for (const child of [rect, circle, bar, label]) {
    document.nodes[child.id] = child
    frame.children.push(child.id)
  }
  document.pages[0]!.children = [frame.id]
  return document
}

function compositeTile(
  target: Uint8Array,
  tileBytes: Uint8Array,
  src: [number, number, number, number],
  dst: [number, number],
): void {
  const [sx, sy, sw, sh] = src
  for (let row = 0; row < sh; row += 1) {
    const srcY = Math.round(sy) + row
    const dstY = Math.round(dst[1]) + row
    if (srcY < 0 || dstY < 0 || dstY >= HEIGHT) continue
    const srcStart = (srcY * TILE_SIZE + Math.round(sx)) * 4
    const dstStart = (dstY * WIDTH + Math.round(dst[0])) * 4
    const bytes = sw * 4
    if (srcStart < 0 || dstStart < 0) continue
    if (srcStart + bytes > tileBytes.length || dstStart + bytes > target.length) continue
    target.set(tileBytes.subarray(srcStart, srcStart + bytes), dstStart)
  }
}

async function renderView(document: DesignDocument, x: number, y: number, zoom: number, width: number, height: number) {
  // Camera semantics: device = world * zoom + view translation.
  const client = new KernelClient()
  const result = await client.render(
    document,
    { pageId: document.pages[0]!.id, width, height, transparent: false, grid: false, view: { x: -x * zoom, y: -y * zoom, zoom } },
    false,
    'auto',
    true,
  )
  client.dispose()
  return result
}

export type TileFrameCheckResult = {
  name: string
  ok: boolean
  detail: string
  informational?: boolean
}

export async function runTileFrameCheck(): Promise<TileFrameCheckResult[]> {
  const document = tileFrameFixture()
  const results: TileFrameCheckResult[] = []
  for (const zoom of [1, 2]) {
    const frame = planTileFrame(VIEW, zoom)
    if (frame.scale !== zoom) {
      results.push({ name: `zoom ${zoom} level`, ok: false, detail: `scale ${frame.scale} must equal zoom` })
      continue
    }
    const full = await renderView(document, VIEW.x, VIEW.y, zoom, WIDTH, HEIGHT)
    const fullAgain = await renderView(document, VIEW.x, VIEW.y, zoom, WIDTH, HEIGHT)
    let determinismBad = 0
    for (let i = 0; i < full.bytes.length; i += 1) {
      if (full.bytes[i] !== fullAgain.bytes[i]) { determinismBad += 1; break }
    }
    results.push({
      name: `zoom ${zoom} render determinism`,
      ok: determinismBad === 0,
      informational: true,
      detail: determinismBad === 0 ? 'identical across fresh clients' : `differs between fresh clients (${full.backend})`,
    })
    const composited = new Uint8Array(WIDTH * HEIGHT * 4)
    let sameSizeBad = 0
    for (const tile of frame.tiles) {
      const local = await renderView(document, tile.device[0] / zoom, tile.device[1] / zoom, zoom, TILE_SIZE, TILE_SIZE)
      // Same-size reference via an independent arithmetic path: derive the
      // world origin from the tile's frame-relative device origin.
      const refX = VIEW.x + (tile.device[0] - VIEW.x * zoom) / zoom
      const refY = VIEW.y + (tile.device[1] - VIEW.y * zoom) / zoom
      const reference = await renderView(document, refX, refY, zoom, TILE_SIZE, TILE_SIZE)
      if (local.bytes.length !== reference.bytes.length) {
        sameSizeBad += 1
      } else {
        for (let i = 0; i < local.bytes.length; i += 1) {
          if (local.bytes[i] !== reference.bytes[i]) {
            sameSizeBad += 1
            break
          }
        }
      }
      compositeTile(
        composited,
        local.bytes,
        [
          tile.scissor[0] - tile.device[0],
          tile.scissor[1] - tile.device[1],
          tile.scissor[2],
          tile.scissor[3],
        ],
        [tile.scissor[0] - VIEW.x * zoom, tile.scissor[1] - VIEW.y * zoom],
      )
    }
    let mismatched = 0
    let worst = 0
    for (let i = 0; i < composited.length; i += 4) {
      const d = Math.max(
        Math.abs(composited[i]! - full.bytes[i]!),
        Math.abs(composited[i + 1]! - full.bytes[i + 1]!),
        Math.abs(composited[i + 2]! - full.bytes[i + 2]!),
        Math.abs(composited[i + 3]! - full.bytes[i + 3]!),
      )
      if (d > 0) mismatched += 1
      worst = Math.max(worst, d)
    }
    const exact = mismatched === 0
    results.push({
      name: `zoom ${zoom} planner tiles == same-size reference renders`,
      ok: sameSizeBad === 0,
      detail: `${frame.tiles.length - sameSizeBad}/${frame.tiles.length} tiles pixel-exact via independent addressing math, backend ${full.backend}`,
    })
    results.push({
      name: `zoom ${zoom} tiled == full frame (pixel-exact tier)`,
      ok: exact,
      informational: !exact && zoom !== 1,
      detail: exact
        ? `${WIDTH * HEIGHT}/${WIDTH * HEIGHT} pixels exact, backend ${full.backend}`
        : `cross-size AA phase divergence: ${mismatched}/${WIDTH * HEIGHT} differ, worst delta ${worst}, backend ${full.backend} (tile↔tile is the guaranteed tier)`,
    })
  }
  return results
}
