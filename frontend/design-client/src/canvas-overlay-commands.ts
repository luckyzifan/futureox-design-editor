import type { Bounds, DesignDocument, Point } from './model'
import { apply, type SceneEntry } from './geometry'
import { DISTANCE_PILL_TEXT, spacingDiagram, type Measurement } from './canvas-measurements'
import { selectionSizeLabel } from './selection-size-label'
import { SELECTION_BLUE, SIZE_PILL_TEXT } from './selection-blue'
import type { CanvasLabel } from './kernel/gpu/canvas-labels'
import type { CanvasOverlay } from './kernel/gpu/canvas-overlay'
import { frameChromeLabel } from './page-frame-chrome'

export type CanvasOverlayContext = {
  document: DesignDocument
  pageId: string
  epoch: number
  /** UI render dependencies, not a document/geometry revision. */
  uiIdentity: string
  commands: Omit<CanvasOverlay,'measurements' | 'labels'> & { measurements: Measurement[]; labels: CanvasLabel[] }
}
export type CanvasOverlayInputs = {
  document: DesignDocument; pageId: string; epoch: number
  tool: string; pixelGrid: boolean; canTransform: boolean
  selected: readonly SceneEntry[]; owners: string[]; frameTitles: readonly SceneEntry[]
  localSelection: Bounds | null; selectionCorners: Point[]; selectionBox: Bounds
  measurementTarget: { id: string; bounds: Bounds } | null
  zoom?: number
}

/** One command producer for Canvas and capture-ownership tests. Geometry is
 * deliberately separate from UI identity: only a complete captured document
 * can supply old geometry, and only identical UI dependencies can borrow it.
 * A measurement target is picked in the displayed scene, not the authored
 * scene. Its identity AND displayed bounds therefore belong to this contract.
 * Never infer that two targets are equivalent from their endpoints alone. */
/** Screen-pixel width of a selection chip. CJK counts as one em; Latin is narrower. */
export function selectionChromeChipWidth(text: string, size: number) {
  let em = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    em += code > 0xff ? 1 : code <= 0x20 ? 0.34 : 0.58
  }
  return Math.max(size * 0.5, em * size)
}

export function canvasOverlayCommands(input: CanvasOverlayInputs): CanvasOverlayContext {
  const { document, selected, owners, frameTitles, localSelection, selectionCorners, selectionBox, measurementTarget } = input
  const showSelection = !!selected.length && !['vector','width','pencil','brush','marker','washi-tape'].includes(input.tool)
  const selectedIds = new Set(showSelection ? selected.map(entry => entry.id) : [])
  const titleIdentity = frameTitles.map(entry => {
    const chrome = frameChromeLabel(document.nodes[entry.id], selectedIds.has(entry.id))
    return [entry.id, document.nodes[entry.id].name, selectedIds.has(entry.id) ? 1 : 0, chrome.kind, chrome.chip ?? '', [...entry.ancestors, entry.id]]
  })
  const selectionIdentity = showSelection ? [owners, input.canTransform] : null
  const selectionName = showSelection && selected.length === 1 ? document.nodes[selected[0].id]?.name ?? '' : ''
  const targetIdentity = measurementTarget ? [measurementTarget.id, measurementTarget.bounds.x, measurementTarget.bounds.y,
    measurementTarget.bounds.width, measurementTarget.bounds.height] : null
  const sizeText = showSelection ? selectionSizeLabel(localSelection, selectionBox, selected[0]?.matrix) : ''
  // Tenths of a degree. A frozen overlay identity kept the W×H chip on the
  // pre-rotation box while the glyphs turned. Prefix 4 also retires labels
  // from before the warm pill frame.
  const spin = selected[0]?.matrix ? Math.round(Math.atan2(selected[0].matrix[1], selected[0].matrix[0]) * 1800) / 10 : 0
  const zoom = Number.isFinite(input.zoom) && (input.zoom ?? 0) > 0 ? input.zoom! : 1
  const uiIdentity = JSON.stringify([4, input.pixelGrid, selectionIdentity, selectionName, sizeText, spin, titleIdentity, targetIdentity, Math.round(zoom * 100) / 100])
  const diagram = measurementTarget ? spacingDiagram(selectionBox, measurementTarget.bounds, zoom) : { lines: [] as Measurement[], pills: [] }
  const measurements = diagram.lines
  const labels: CanvasLabel[] = frameTitles.map(entry => {
    const node = document.nodes[entry.id]
    const chrome = frameChromeLabel(node, selectedIds.has(entry.id))
    return {anchor: apply(entry.matrix,{x:0,y:0}), offset:chrome.offset,
      basis:entry.matrix.slice(0,4) as [number,number,number,number], text:node.name, size:11,
      color:chrome.color, kind:chrome.kind, ...(chrome.chip ? {chip:chrome.chip} : {}), owners:[...entry.ancestors,entry.id]}
  })
  const titled = new Set(frameTitles.map(entry => entry.id))
  // Sit above the top edge, clear of the corner rotate marks.
  if (showSelection && selected.length === 1 && selectionName && !titled.has(selected[0].id))
    labels.push({ anchor: { x: selectionBox.x, y: selectionBox.y }, offset: { x: 0, y: -24 },
      text: selectionName, size: 11, color: SELECTION_BLUE, kind: 'selection-name', frame: 'pill', owners })
  if(showSelection) labels.push({anchor:{x:selectionBox.x+selectionBox.width/2,y:selectionBox.y+selectionBox.height},offset:{x:0,y:21},
    text:sizeText,size:10,color:SIZE_PILL_TEXT,centered:true,kind:'selection-size',frame:'accent',owners})
  for (const pill of diagram.pills) {
    labels.push({ anchor: pill.anchor, offset: pill.offset, text: pill.text,
      size: 11, color: DISTANCE_PILL_TEXT, centered: true, kind: 'measurement', frame: 'measure' })
  }
  return {document,pageId:input.pageId,epoch:input.epoch,uiIdentity,commands:{pixelGrid:input.pixelGrid,labels,measurements,
    transforms:Object.fromEntries(owners.map(id=>[id,document.nodes[id].transform])),
    selection:showSelection?{corners:selectionCorners,handles:input.canTransform,owners}:undefined}}
}

/** A late ACK for the same document must not hide a newer UI state. */
export function canvasGpuOverlayOwnsUi(presented: {gpuOverlay?: boolean; gpuOverlayIdentity?: string} | null | undefined,
  current: Pick<CanvasOverlayContext,'uiIdentity'>, scopeMatches: boolean): boolean {
  return scopeMatches && !!presented?.gpuOverlay && presented.gpuOverlayIdentity === current.uiIdentity
}
