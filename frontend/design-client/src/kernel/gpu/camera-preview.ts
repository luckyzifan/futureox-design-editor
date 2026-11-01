import { physicalCoverageGaps } from './physical-coverage'
import type { PixelContentProof } from './page-background'

export type CameraPreview = { anchor: number }
type Row = { x: number; y: number; width: number; height: number; blend?: boolean; content?: PixelContentProof }

/** A live texture proves content identity, not that unseen pixels are empty.
 * Gaps are explicitly pending preview pixels. They never certify native or
 * terminal coverage, even when the placeholder happens to match the page. */
export function cameraPreviewCoverage(anchor: PixelContentProof | undefined, rows: readonly Row[], width: number, height: number) {
  if (!anchor?.owner || !anchor.contract || rows.some(row => row.blend ||
      row.content?.owner !== anchor.owner || row.content.contract !== anchor.contract)) return
  const gaps = physicalCoverageGaps(rows, width, height)
  return { gaps, pendingPixels: gaps.reduce((sum, gap) => sum + gap.width * gap.height, 0) }
}

// User-requested white canvas background. Its preview coverage remains explicit
// in the receipt even when its color happens to match exact page pixels.
export const cameraPreviewShader = `
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4<f32> {
 let p=array<vec2<f32>,3>(vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));
 return vec4(p[i],0.,1.);
}
@fragment fn fragment(@builtin(position) p:vec4<f32>)->@location(0) vec4<f32> {
 return vec4(1.,1.,1.,1.);
}`
