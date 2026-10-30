import type { Bounds, DesignDocument, Point } from './model'
import { apply, type SceneEntry } from './geometry'
import { measureBounds, type Measurement } from './canvas-measurements'
import { selectionSizeLabel } from './selection-size-label'
import type { CanvasLabel } from './kernel/gpu/canvas-labels'
import type { CanvasOverlay } from './kernel/gpu/canvas-overlay'

export type CanvasOverlayContext = {
  document: DesignDocument
  pageId: string
  epoch: number
  /** UI render dependencies, not a document/geometry revision. */
  uiIdentity: string
  commands: Omit<CanvasOverlay,'measurements'> & { measurements: Measurement[] }
}
export type CanvasOverlayInputs = {
  document: DesignDocument; pageId: string; epoch: number
  tool: string; pixelGrid: boolean; canTransform: boolean
  selected: readonly SceneEntry[]; owners: string[]; frameTitles: readonly SceneEntry[]
  localSelection: Bounds | null; selectionCorners: Point[]; selectionBox: Bounds
  measurementTarget: { id: string; bounds: Bounds } | null
}

/** One command producer for Canvas and capture-ownership tests. Geometry is
 * deliberately separate from UI identity: only a complete captured document
 * can supply old geometry, and only identical UI dependencies can borrow it.
 * A measurement target is picked in the displayed scene, not the authored
 * scene. Its identity AND displayed bounds therefore belong to this contract.
 * Never infer that two targets are equivalent from their endpoints alone. */
export function canvasOverlayCommands(input: CanvasOverlayInputs): CanvasOverlayContext {
  const { document, selected, owners, frameTitles, localSelection, selectionCorners, selectionBox, measurementTarget } = input
  const showSelection = !!selected.length && !['vector','width','pencil','brush','marker','washi-tape'].includes(input.tool)
  const titleIdentity = frameTitles.map(entry => [entry.id, document.nodes[entry.id].name, [...entry.ancestors, entry.id]])
  const selectionIdentity = showSelection ? [owners, input.canTransform] : null
  const targetIdentity = measurementTarget ? [measurementTarget.id, measurementTarget.bounds.x, measurementTarget.bounds.y,
    measurementTarget.bounds.width, measurementTarget.bounds.height] : null
  const uiIdentity = JSON.stringify([1, input.pixelGrid, selectionIdentity, titleIdentity, targetIdentity])
  const measurements = measurementTarget ? measureBounds(selectionBox, measurementTarget.bounds) : []
  const labels: CanvasLabel[] = frameTitles.map(entry => ({anchor: apply(entry.matrix,{x:0,y:0}), offset:{x:0,y:-12},
    basis:entry.matrix.slice(0,4) as [number,number,number,number], text:document.nodes[entry.id].name, size:11,color:'#73778b',owners:[...entry.ancestors,entry.id]}))
  if(showSelection) labels.push({anchor:{x:selectionBox.x+selectionBox.width/2,y:selectionBox.y+selectionBox.height},offset:{x:0,y:21},
    text:selectionSizeLabel(localSelection,selectionBox,selected[0]?.matrix),size:10,color:'#0d99ff',centered:true,owners})
  for(const m of measurements) labels.push({anchor:{x:(m.from.x+m.to.x)/2,y:(m.from.y+m.to.y)/2},offset:{x:4,y:-5},
    text:String(Number(m.distance.toFixed(2))),size:11,color:'#f24822',halo:true})
  return {document,pageId:input.pageId,epoch:input.epoch,uiIdentity,commands:{pixelGrid:input.pixelGrid,labels,measurements,
    transforms:Object.fromEntries(owners.map(id=>[id,document.nodes[id].transform])),
    selection:showSelection?{corners:selectionCorners,handles:input.canTransform,owners}:undefined}}
}

/** A late ACK for the same document must not hide a newer UI state. */
export function canvasGpuOverlayOwnsUi(presented: {gpuOverlay?: boolean; gpuOverlayIdentity?: string} | null | undefined,
  current: Pick<CanvasOverlayContext,'uiIdentity'>, scopeMatches: boolean): boolean {
  return scopeMatches && !!presented?.gpuOverlay && presented.gpuOverlayIdentity === current.uiIdentity
}
