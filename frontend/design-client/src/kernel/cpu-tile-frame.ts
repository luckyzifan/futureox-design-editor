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

/** Same pressure classes the kernel retries as a degraded display.
 * One tile can keep the page color; it must not fail the whole board. */
export function cpuDisplayPressure(error: unknown) {
  return /Compositing memory budget exceeded|Combined filter dependency halo exceeds 2048 device pixels|Combined zoom source dependency halo exceeds 2048 device pixels|Zoom source filter halo exceeds 2048 device pixels|Frame compositing work budget exceeded|Layer surface exceeds 16 million pixels|Gaussian sigma must be in/.test(String(error))
}

export function solidDisplayTile(width: number, height: number, pixel: readonly [number, number, number, number]) {
  const bytes = new Uint8Array(width * height * 4)
  for (let i = 0; i < bytes.length; i += 4) {
    bytes[i] = pixel[0]
    bytes[i + 1] = pixel[1]
    bytes[i + 2] = pixel[2]
    bytes[i + 3] = pixel[3]
  }
  return bytes
}
