/** Device-pixel cells of a settled zoom-focus capture.
 * The whole viewport is one native-density capture. The kernel still rejects
 * an extent above its existing 16,777,216-pixel surface budget. `split` is the
 * previous fallback: 1024px columns and 960,000px cells, used only after that
 * rejection. Viewports of at most 524,288 pixels were never split. */
export type ZoomFocusCaptureRegion = { x: number; y: number; width: number; height: number }

export function zoomFocusCaptureRegions(
  originX: number, originY: number, width: number, height: number, split: boolean,
): ZoomFocusCaptureRegion[] {
  if (!split || width * height <= 524288) return [{ x: originX, y: originY, width, height }]
  const columns = Math.ceil(width / 1024)
  const cellWidth = Math.ceil(width / columns)
  const rows = Math.ceil(cellWidth * height / 960_000)
  const cellHeight = Math.ceil(height / rows)
  const regions: ZoomFocusCaptureRegion[] = []
  for (let dy = 0; dy < height; dy += cellHeight) {
    for (let dx = 0; dx < width; dx += cellWidth) {
      regions.push({
        x: originX + dx, y: originY + dy,
        width: Math.min(cellWidth, width - dx), height: Math.min(cellHeight, height - dy),
      })
    }
  }
  return regions
}
