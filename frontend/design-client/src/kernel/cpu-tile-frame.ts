import type { RasterTile } from './tile-cache'

export type CpuTileFrame = {
  pageId: string
  width: number
  height: number
  view: { x: number; y: number; zoom: number }
  [key: string]: unknown
}

/** Device crop that matches the GPU tile's `gpuViewport` origin.
 * The CPU renderer has no viewport crop, so the camera shifts until the
 * tile's device origin is (0, 0). */
export function cpuTileFrameOptions(frame: CpuTileFrame, tile: Pick<RasterTile, 'x' | 'y' | 'width' | 'height' | 'zoom'>): CpuTileFrame {
  const originX = tile.x + Math.floor(frame.view.x)
  const originY = tile.y + Math.floor(frame.view.y)
  return {
    ...frame,
    width: tile.width,
    height: tile.height,
    view: {
      x: frame.view.x - originX,
      y: frame.view.y - originY,
      zoom: tile.zoom,
    },
    gpuViewport: undefined,
    tileViewport: undefined,
    prepareViewport: undefined,
    captureViewport: undefined,
  }
}

/** Recoverable pressure on a CPU display tile. Exact callers still receive the error. */
export function cpuDisplayPressure(error: unknown) {
  return /Compositing memory budget exceeded|Combined filter dependency halo exceeds 2048 device pixels|Combined zoom source dependency halo exceeds 2048 device pixels|Zoom source filter halo exceeds 2048 device pixels|Frame compositing work budget exceeded|Layer surface exceeds 16 million pixels|Gaussian sigma must be in/.test(String(error))
}

/** Only the display caller may retry at a lower density. Keep the authored
 * effects and world origin, and return the actual density with the samples.
 * An empty result represents a gap; it owns no pixels. */
export async function sampleCpuTile(frame: CpuTileFrame, render: (options: CpuTileFrame) => Promise<Uint8Array>,
  current: () => boolean, preview: boolean) {
  let reason = ''
  for (const divisor of [1,2,4]) {
    if (!current()) throw Error('PREVIEW_CANCELLED')
    const width=Math.ceil(frame.width/divisor), height=Math.ceil(frame.height/divisor)
    const view={x:frame.view.x/divisor,y:frame.view.y/divisor,zoom:frame.view.zoom/divisor}
    if (divisor > 1 && view.zoom < .001) break
    try {
      const bytes = await render(divisor === 1 ? frame : {...frame,width,height,view})
      if (bytes.byteLength !== width*height*4) throw Error('CPU tile byte count mismatch')
      return {bytes,width,height,divisor,reason}
    } catch (error) {
      if (!preview || !cpuDisplayPressure(error)) throw error
      reason=String(error)
    }
  }
  return {bytes:new Uint8Array(0),width:0,height:0,divisor:0,reason}
}

/** Device colors for world outside the page. Both sit under RGB 240 and are
 *  neither the unpainted workspace gray nor a flat white clear, so a pan
 *  strip is a coverage field rather than an empty fill. */
export const PASTEBOARD_COVERAGE = ['#e6e8ec', '#dde0e6'] as const

export function pasteboardCoverageColor(x: number, y: number, cell = 8) {
  const safe = cell > 0 ? cell : 8
  return ((Math.floor(x / safe) ^ Math.floor(y / safe)) & 1) ? PASTEBOARD_COVERAGE[1] : PASTEBOARD_COVERAGE[0]
}

/** Device origin for a native-size byte blit, including negative coordinates. */
export function cpuTileBlitOrigin(dx: number, dy: number) {
  return { x: Math.floor(dx), y: Math.floor(dy) }
}
