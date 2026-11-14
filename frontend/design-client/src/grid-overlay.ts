import type { DesignDocument, LayoutGrid } from './model'
import { apply, worldMatrix } from './geometry'
import { authored_grid_spans_json, layout_grid_tracks_json, layout_grid_frame_json } from './generated/design-kernel/design_kernel'
export type GridAxisSpans = {
  axis: { cutoff: number; stride: number; roundedSectionSize: number; unroundedSectionSize: number }
  spans: { start: number; end: number }[]
}
export function gridAxisSpans(tracks: number[]): GridAxisSpans {
  const [axis, spans] = JSON.parse(layout_grid_tracks_json(JSON.stringify(tracks)))
  return { axis, spans }
}
export function gridOverlayRectangles(doc: DesignDocument, frameId: string) {
  const frame = doc.nodes[frameId]
  if (frame?.layout?.mode !== 'grid' || !frame.children.length) return []
  const { cols, rows, padding } = JSON.parse(layout_grid_frame_json(JSON.stringify(doc), frameId)) as {
    cols: GridAxisSpans['spans']; rows: GridAxisSpans['spans']; padding: number[]
  }
  const matrix = worldMatrix(doc, frameId)
  const out = []
  for (const row of rows) for (const col of cols) {
    const x=padding[3]+col.start, y=padding[0]+row.start
    const width=col.end-col.start, height=row.end-row.start
    const points=[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}].map(p=>apply(matrix,p))
    const left=Math.min(...points.map(p=>p.x)), top=Math.min(...points.map(p=>p.y))
    out.push({x:left,y:top,width:Math.max(...points.map(p=>p.x))-left,height:Math.max(...points.map(p=>p.y))-top,points})
  }
  return out
}
/** Authored layout-grid bands (Sketch grid/layout dicts, Figma layoutGrids):
 * lit track rectangles from the same kernel section predicate, packed on
 * the CPU through the wasm entry. Columns/rows produce axis bands; uniform
 * produces the cell grid on both axes. */
export function layoutGridRectangles(grid: LayoutGrid, frameId: string, doc: DesignDocument) {
  const frame = doc.nodes[frameId]
  if (!frame || !grid.visible) return []
  const matrix = worldMatrix(doc, frameId)
  const rect = (x: number, y: number, width: number, height: number) => {
    const points = [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ].map((p) => apply(matrix, p))
    const left = Math.min(...points.map((p) => p.x)),
      top = Math.min(...points.map((p) => p.y))
    return {
      x: left,
      y: top,
      width: Math.max(...points.map((p) => p.x)) - left,
      height: Math.max(...points.map((p) => p.y)) - top,
      points,
    }
  }
  const spans = (extent: number) =>
    JSON.parse(authored_grid_spans_json(JSON.stringify(grid), extent)) as GridAxisSpans['spans']
  const legacyMargin = grid.sectionSize === undefined && grid.alignment === undefined ? grid.margin : 0
  if (grid.axis === 'column')
    return spans(frame.width).map(s => rect(s.start, legacyMargin, s.end - s.start, frame.height - 2 * legacyMargin))
  if (grid.axis === 'row')
    return spans(frame.height).map(s => rect(legacyMargin, s.start, frame.width - 2 * legacyMargin, s.end - s.start))
  const cells = []
  const cols = spans(frame.width), rows = spans(frame.height)
  // A full set of small squares is bounded independently from stripes.
  if (cols.length * rows.length > 4096) return []
  for (const row of rows) for (const col of cols)
    cells.push(rect(col.start, row.start, col.end - col.start, row.end - row.start))
  return cells
}
