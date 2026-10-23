import { renderFailureFields } from './render-failure-telemetry'

export type PreviewTile = { x: number; y: number; width: number; height: number }
export type PreviewPixels = Uint8Array | Float32Array

/** Only the compiler's classified aggregate program admission is spatially
 * retriable. Unknown text, device loss, and per-path work failures stay errors. */
export function isAnalyticProgramBudget(error: unknown) {
  const failure = renderFailureFields(error)
  return failure.failureCategory === 3 && failure.failureCode === 94
}

/** Remember allocation failures only within one unchanged rendering contract.
 * Reusing a smaller exact region changes scheduling, never density or math.
 * A difficult region may conservatively split an easier neighbour as well. */
export class PreviewAdmission {
  private failed: {width:number;height:number}[] = []
  shouldSplit(tile: PreviewTile) {
    return Math.max(tile.width,tile.height)>64 && this.failed.some(size=>
      tile.width>=size.width && tile.height>=size.height)
  }
  observe(error: unknown, tile: PreviewTile) {
    const message=String(error)
    if (/device lost|GPU device|has been lost|设备已丢失/i.test(message) ||
        !/GPU surface budget exceeded|GPU 表面内存预算超限/.test(message) && !isAnalyticProgramBudget(error) ||
        Math.max(tile.width,tile.height)<=64) return
    this.failed=this.failed.filter(size=>size.width<tile.width||size.height<tile.height)
    if(!this.failed.some(size=>size.width<=tile.width&&size.height<=tile.height))
      this.failed.push({width:tile.width,height:tile.height})
    if(this.failed.length>16)this.failed.shift()
  }
}

/** Assemble a complete frame privately. Only integer screen offsets change the
 * camera; the kernel retains world coordinates and each tile's filter halo. */
export async function renderPreviewRegions(
  width: number,
  height: number,
  rasterize: (tile: PreviewTile) => Promise<void>,
  side = 256,
  admission = new PreviewAdmission(),
  checkpoint?: () => Promise<void>,
) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 4_100_000 ||
    !Number.isSafeInteger(side) ||
    side < 64 ||
    side > 1024
  )
    throw new Error('Invalid preview tile dimensions')
  let tiles = 0
  let attempts = 0
  async function draw(tile: PreviewTile): Promise<void> {
    // Check before every recursive region, including learned budget splits.
    // Only completed regions yield; a caller never interleaves GPU encoders.
    await checkpoint?.()
    if (++attempts > 2048) throw new Error('Preview tile work budget exceeded')
    const split = async () => {
      const splitX=tile.width>=tile.height,first=Math.floor((splitX?tile.width:tile.height)/2)
      await draw({...tile,...(splitX?{width:first}:{height:first})})
      await draw({...tile,...(splitX?{x:tile.x+first,width:tile.width-first}:{y:tile.y+first,height:tile.height-first})})
    }
    if(admission.shouldSplit(tile)){await split();return}
    try {
      await rasterize(tile)
    } catch (error) {
      const message = String(error)
      // A lost device can only be recovered by a full GPU-stack rebuild, so it
      // must propagate without splitting — even when the message also carries a
      // budget string from the same failed frame. Non-lost admission failures
      // split; the split re-entry re-creates only renderer-level state and
      // reuses the parked (non-lost) device and its compiled pipelines.
      if (
        /device lost|GPU device|has been lost|设备已丢失/i.test(message) ||
        !/GPU surface budget exceeded|GPU 表面内存预算超限|Invalid GPU viewport/.test(message) && !isAnalyticProgramBudget(error) ||
        Math.max(tile.width, tile.height) <= 64
      )
        throw error
      if (import.meta.env.DEV)
        console.debug(
          `DESIGN_PREVIEW_SPLIT ${JSON.stringify({ x: tile.x, y: tile.y, width: tile.width, height: tile.height })}`,
        )
      admission.observe(error,tile)
      await split()
      return
    }
    tiles++
  }
  for (let y = 0; y < height; y += side)
    for (let x = 0; x < width; x += side)
      await draw({ x, y, width: Math.min(side, width - x), height: Math.min(side, height - y) })
  return { tiles }
}

export async function renderPreviewTiles(width: number, height: number,
  rasterize: (tile: PreviewTile) => Promise<PreviewPixels>, side = 256, admission?: PreviewAdmission, checkpoint?: () => Promise<void>) {
  let pixels: PreviewPixels | undefined
  const { tiles } = await renderPreviewRegions(width, height, async tile => {
    const source = await rasterize(tile)
    if (source.length !== tile.width * tile.height * 4) throw new Error('Invalid preview tile readback')
    pixels ??= source instanceof Float32Array ? new Float32Array(width * height * 4) : new Uint8Array(width * height * 4)
    if (source instanceof Float32Array !== pixels instanceof Float32Array) throw new Error('Preview tile precision changed')
    for (let y = 0; y < tile.height; y++) pixels.set(
      source.subarray(y * tile.width * 4, (y + 1) * tile.width * 4), ((tile.y + y) * width + tile.x) * 4)
  }, side, admission, checkpoint)
  return { pixels: pixels!, tiles }
}

/** Display-only budget splitting keeps GPU-produced bitmaps on the display
 * path. Exact integer blits preserve sampling; no pixel readback or decoding
 * takes place. Failed assemblies never publish a partial frame. */
export async function renderBitmapPreviewTiles(width: number, height: number,
  rasterize: (tile: PreviewTile) => Promise<ImageBitmap>, side = 256, admission?: PreviewAdmission, checkpoint?: () => Promise<void>) {
  let canvas: OffscreenCanvas | undefined
  try {
    const { tiles } = await renderPreviewRegions(width, height, async tile => {
      const bitmap = await rasterize(tile)
      try {
        if (bitmap.width !== tile.width || bitmap.height !== tile.height) throw new Error('Invalid preview tile bitmap')
        canvas ??= new OffscreenCanvas(width, height)
        const context = canvas.getContext('2d', { colorSpace: 'srgb' })
        if (!context) throw new Error('Canvas bitmap assembly unavailable')
        context.imageSmoothingEnabled = false
        context.drawImage(bitmap, tile.x, tile.y)
      } finally { bitmap.close() }
    }, side, admission, checkpoint)
    return { bitmap: canvas!.transferToImageBitmap(), tiles }
  } finally { if (canvas) { canvas.width = 1; canvas.height = 1 } }
}
