import { exactBucketScale } from './tile-cache'
import { paintDamageRects, type PaintDamage } from './paint-damage'

/** CPU display routing. The WASM bridge returns JSON text, including "null".
 * Keep damage-aware assembly available to ordinary unmanaged documents. */
export type CpuFrameKernel = {
  color_settings(): string
  render_rgba(options: string): Uint8Array
  assemble_tiled_rgba(options: string, damage: string): Uint8Array
}

export function renderCpuFrame(
  kernel: CpuFrameKernel,
  options: string,
  damage: PaintDamage | undefined,
): Uint8Array {
  const parsed = JSON.parse(options) as {
    pixelPreview?: number; rasterProfile?: string; view: { x: number; y: number; zoom: number }
  }
  // The existing CPU tile assembler resamples between its density buckets and
  // rounds camera translation. Use it for exact aligned analytic frames only;
  // a fractional settled camera must retain the ordinary renderer's samples.
  const aligned = (!parsed.rasterProfile || parsed.rasterProfile === 'analytic') &&
    exactBucketScale(parsed.view.zoom) === parsed.view.zoom &&
    Number.isInteger(parsed.view.x) && Number.isInteger(parsed.view.y)
  if (!aligned || parsed.pixelPreview || JSON.parse(kernel.color_settings()) !== null)
    return kernel.render_rgba(options)
  const damageJson = !damage || damage.full ? null : paintDamageRects(damage)
  return kernel.assemble_tiled_rgba(options, JSON.stringify(damageJson))
}
