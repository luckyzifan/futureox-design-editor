/** Pixel-grid geometry for the canvas overlay — the Figma ⌘' grid.
 *
 * Figma's pixel grid appears automatically once the camera reaches 400%
 * (four screen pixels per canvas pixel) and is drawn by the presentation
 * layer, never rasterised into content tiles — a grid baked into
 * bucket-rasterised tiles would blur under the in-bucket display resample.
 * The path produced here lives in world coordinates inside the overlay
 * SVG's camera transform (`css = world * zoom − view`), one hairline per
 * world integer, so it stays aligned at any zoom while the rendered frame
 * catches up.
 */

/** Figma's documented appearance threshold: 400% zoom. */
export const PIXEL_GRID_MIN_ZOOM = 4

/** Segment caps: the grid never emits more path data than this, so huge
 * viewports at the threshold zoom stay cheap to rebuild per camera change. */
const MAX_VERTICAL_SEGMENTS = 4096
const MAX_TOTAL_SEGMENTS = 8192

export type CameraView = { x: number; y: number; zoom: number }

/** Whether the pixel grid is visible at this zoom. */
export function pixelGridVisible(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= PIXEL_GRID_MIN_ZOOM
}

/** SVG path data for the pixel grid covering the `width` × `height` CSS
 * viewport under `view`, or '' when hidden (toggle off or below threshold).
 * Lines sit on world integers: `ceil(world₀)` through `floor(world₁)`. */
export function pixelGridPathData(
  view: CameraView,
  width: number,
  height: number,
  enabled: boolean,
): string {
  if (!enabled || !pixelGridVisible(view.zoom)) return ''
  const { x: vx, y: vy, zoom } = view
  if (!(zoom > 0) || !(width > 0) || !(height > 0)) return ''
  const x0 = -vx / zoom
  const y0 = -vy / zoom
  const x1 = x0 + width / zoom
  const y1 = y0 + height / zoom
  const segments: string[] = []
  for (let x = Math.ceil(x0); x <= Math.floor(x1) && segments.length < MAX_VERTICAL_SEGMENTS; x++)
    segments.push(`M${x},${y0}V${y1}`)
  for (let y = Math.ceil(y0); y <= Math.floor(y1) && segments.length < MAX_TOTAL_SEGMENTS; y++)
    segments.push(`M${x0},${y}H${x1}`)
  return segments.join('')
}
