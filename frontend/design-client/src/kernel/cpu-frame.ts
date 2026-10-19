import type { PaintDamage } from './paint-damage'

export type CpuFrameKernel = {
  color_settings(): string
  render_rgba(options: string): Uint8Array
  assemble_tiled_rgba(options: string, damage: string): Uint8Array
}

/** Exact CPU display until the WASM tiled API shares the native preparation
 * page/options/revision-damage ownership contract. Merely checking integer
 * camera alignment cannot prove that old tiles belong to this page/frame.
 * This deliberately trades CPU cache throughput for correct pixels. */
export function renderCpuFrame(
  kernel: CpuFrameKernel,
  options: string,
  _damage: PaintDamage | undefined,
): Uint8Array {
  return kernel.render_rgba(options)
}
