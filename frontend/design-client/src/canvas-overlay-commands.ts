import type { Bounds, DesignDocument, Matrix, Point } from './model'
import { apply, type SceneEntry } from './geometry'
import { DISTANCE_PILL_FONT_SIZE, DISTANCE_PILL_TEXT, spacingDiagram, type Measurement, type SpacingPill } from './canvas-measurements'
import { selectionSizeLabel } from './selection-size-label'
import { SIZE_PILL_TEXT } from './selection-blue'
import type { CanvasLabel } from './kernel/gpu/canvas-labels'
import type { CanvasOverlay } from './kernel/gpu/canvas-overlay'
import { fitFrameTitle, frameChromeLabel, FRAME_TITLE_SIZE } from './page-frame-chrome'
import type { UiMode } from './interface-preference'

export type CanvasOverlayContext = {
  document: DesignDocument
  pageId: string
  epoch: number
  /** UI render dependencies, not a document/geometry revision. */
  uiIdentity: string
  selectionIdentity?: string
  commands: Omit<CanvasOverlay,'measurements' | 'labels'> & { measurements: Measurement[]; labels: CanvasLabel[] }
}
export type CanvasOverlayInputs = {
  document: DesignDocument; pageId: string; epoch: number
  tool: string; pixelGrid: boolean; canTransform: boolean
  selected: readonly SceneEntry[]; owners: string[]; frameTitles: readonly SceneEntry[]
  localSelection: Bounds | null; selectionCorners: Point[]; selectionBox: Bounds
  /** Multi-selection whose layers share one rotation. Size uses this box. */
  orientedFrame?: { box: Bounds; basis: Matrix } | null
  measurementTarget: { id: string; bounds: Bounds } | null
  /** Guide, anchor, or other diagrams that are not a second layer box. */
  directMeasurement?: { lines: Measurement[]; pills: SpacingPill[] } | null
  zoom?: number
  uiMode?: UiMode
}

/** One command producer for Canvas and capture-ownership tests. Geometry is
 * deliberately separate from UI identity: only a complete captured document
 * can supply old geometry, and only identical UI dependencies can borrow it.
 * A measurement target is picked in the displayed scene, not the authored
 * scene. Its identity AND displayed bounds therefore belong to this contract.
 * Never infer that two targets are equivalent from their endpoints alone. */
export { selectionChromeChipWidth } from './canvas-measurements'

export function canvasOverlayCommands(input: CanvasOverlayInputs): CanvasOverlayContext {
  const { document, selected, owners, frameTitles, localSelection, selectionCorners, selectionBox, measurementTarget } = input
  const showSelection = !!selected.length && !['vector','width','pencil','brush','marker','washi-tape'].includes(input.tool)
  const selectedIds = new Set(showSelection ? selected.map(entry => entry.id) : [])
  const zoom = Number.isFinite(input.zoom) && (input.zoom ?? 0) > 0 ? input.zoom! : 1
  const labels: CanvasLabel[] = frameTitles.flatMap(entry => {
    const node = document.nodes[entry.id]
    const chrome = frameChromeLabel(node, selectedIds.has(entry.id))
    const text = input.uiMode === 'figma' && chrome.kind === 'frame-title'
      ? fitFrameTitle(node.name, Math.floor(node.width * zoom) - 4)
      : node.name
    return text ? [{anchor: apply(entry.matrix,{x:0,y:0}), offset:chrome.offset,
      basis:entry.matrix.slice(0,4) as [number,number,number,number], text, size:FRAME_TITLE_SIZE,
      color:chrome.color, kind:chrome.kind, ...(chrome.chip ? {chip:chrome.chip} : {}), owners:[...entry.ancestors,entry.id]}] : []
  })
  const titleIdentity = labels.map(label => [label.owners, label.text, label.color, label.kind, label.chip])
  const selectionIdentity = showSelection ? [owners, input.canTransform] : null
  const selectionName = showSelection && selected.length === 1 ? document.nodes[selected[0].id]?.name ?? '' : ''
  const targetIdentity = measurementTarget ? [measurementTarget.id, measurementTarget.bounds.x, measurementTarget.bounds.y,
    measurementTarget.bounds.width, measurementTarget.bounds.height] : null
  const sizeLocal = input.orientedFrame?.box ?? localSelection
  const sizeBasis = input.orientedFrame?.basis ?? selected[0]?.matrix
  const sizeText = showSelection ? selectionSizeLabel(sizeLocal, selectionBox, sizeBasis) : ''
  // Tenths of a degree. A frozen overlay identity kept the W×H chip on the
  // pre-rotation box while the glyphs turned. Prefix 4 also retires labels
  // from before the warm pill frame.
  const spin = selected[0]?.matrix ? Math.round(Math.atan2(selected[0].matrix[1], selected[0].matrix[0]) * 1800) / 10 : 0
  const direct = input.directMeasurement
  const directIdentity = direct ? [
    direct.lines.map(line => [line.from.x, line.from.y, line.to.x, line.to.y, line.dash ? 1 : 0, line.role ?? '']),
    direct.pills.map(pill => [pill.text, pill.anchor.x, pill.anchor.y, pill.offset.x, pill.offset.y]),
  ] : null
  const diagram = direct ?? (measurementTarget ? spacingDiagram(selectionBox, measurementTarget.bounds, zoom) : { lines: [] as Measurement[], pills: [] })
  const measurements = diagram.lines
  const crispMeasurements = input.uiMode === 'figma' && measurements.length > 0
  const uiIdentity = JSON.stringify([5, input.pixelGrid, selectionIdentity, selectionName, sizeText, spin, titleIdentity,
    targetIdentity, Math.round(zoom * 100) / 100, ...(directIdentity ? [directIdentity] : []), crispMeasurements])
  // Mac Figma does not draw a layer name above an ordinary shape. Frame and
  // section titles are the names on the canvas. The chip under the box is the size.
  if(showSelection) labels.push({anchor:{x:selectionBox.x+selectionBox.width/2,y:selectionBox.y+selectionBox.height},offset:{x:0,y:21},
    text:sizeText,size:10,color:SIZE_PILL_TEXT,centered:true,kind:'selection-size',frame:'accent',owners})
  for (const pill of diagram.pills) {
    labels.push({ anchor: pill.anchor, offset: pill.offset, text: pill.text,
      size: DISTANCE_PILL_FONT_SIZE, color: DISTANCE_PILL_TEXT, centered: true, kind: 'measurement', frame: 'measure' })
  }
  return {document,pageId:input.pageId,epoch:input.epoch,uiIdentity,
    selectionIdentity:selectionIdentity ? JSON.stringify(selectionIdentity) : undefined,
    commands:{pixelGrid:input.pixelGrid,labels,measurements,...(crispMeasurements ? { crispMeasurements } : {}),
    transforms:Object.fromEntries(owners.map(id=>[id,document.nodes[id].transform])),
    selection:showSelection?{corners:selectionCorners,handles:input.canTransform,owners}:undefined}}
}

/** A late ACK for the same document must not hide a newer UI state. */
export function canvasGpuOverlayOwnsUi(presented: {gpuOverlay?: boolean; gpuOverlayIdentity?: string} | null | undefined,
  current: Pick<CanvasOverlayContext,'uiIdentity'>, scopeMatches: boolean): boolean {
  return scopeMatches && !!presented?.gpuOverlay && presented.gpuOverlayIdentity === current.uiIdentity
}
