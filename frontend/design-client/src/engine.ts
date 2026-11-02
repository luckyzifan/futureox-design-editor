import { CpuStage, measureCpuStage } from './cpu-stage-diagnostics'
import type { CanvasSceneBorrow } from './canvas-scene-snapshots'
import { PreviewLayout } from './kernel/preview-layout'
import { TranslationPreviewPlan } from './kernel/translation-preview'
import type { OperationStatus, MessagePresentation } from './operation-status-messages'
import { prepareBooleanCreate, applyBooleanCreate } from './commands/boolean-command'
import { applyDuplication, prepareDuplication, canContinueDuplication, type DuplicationRepeat } from './commands/duplication-command'
import { prepareLayoutAdd, applyLayoutAdd, prepareLayoutRemove, applyLayoutRemove, layoutCommandAdmission } from './commands/layout-command'
import { reportPostcommitSubscriberError } from './postcommit-subscriber-error'
import { SelectionCommandError, prepareSelectionArrangement, prepareSelectionWrap, configureSelectionWrapper,
  applySelectionWrap, prepareSelectionUnwrap, applySelectionUnwrap } from './commands/selection-command'
import { applyTransformPlan } from './commands/apply-plan'
import { canvasActions } from './canvas-action-diagnostics'
import { validColor } from './color'
import { clearWholeTextRunColor } from './text'
import type { SolidFillTarget, SolidFillDraft, PropertyPreviewLease, PropertyPreviewResult, PropertyPreviewBoundary } from './property-preview'
import { beginEditorAction } from './editor-action-route'
import { CanvasAction, ActionSource, ActionOutcome, ActionReason, closeCanvasActions } from './canvas-action-diagnostics'
import { gestureCategory, patchCategory, type OperationCategory } from './canvas-operation-diagnostics'
import { createCanvasOperationDiagnostics } from './canvas-operation-terminal'
import { hasSchema15Features } from './schema-features'
import { expandRepeats, repeatSourceId } from './repeat-transforms'
import * as ComponentSlots from './component-slots'
import { previewLayoutSuggestion, applyLayoutSuggestion, type LayoutSuggestionPreview } from './layout-suggestions'
import { interfacePreference } from './interface-preference'
import { CameraState, savedCamera } from './camera-state'
import { hasGradientBlur,hasLocalTools,hasRulerGuides,hasLayoutGrids,hasImageAdjusts,hasPatternTiles } from './model'
import { canDeletePage, userPages } from './fig-document'
import { inferred_layout_json } from './generated/design-kernel/design_kernel'
import { prepareSelectionScale } from './selection-scale'
import { canvasDropFrame, canvasMoveKeepsContainer, containingFrame, createCanvasDropIndex, type CanvasDropIndex } from './canvas-drop'
import { duplicateGraph, type GraphCopy } from './duplicate-graph'
import { appendDocument } from './append-document'
import { commitPendingEdits } from './pending-edits'
import { cloneValue, produceDraft } from './draft'
import { validStroke, validProfiles } from './stroke-profile'
import { remapDesignDependencies } from './design-system'
import { pruneAnimations } from './animation'
import { prunePrototypeReferences } from './prototype'
import { applyClipboardSemantics, captureClipboardSemantics, clipboardDependencyNodes, hasClipboardSemantics } from './clipboard-semantics'
import { editableNetwork } from './editable-network'
import { defaultPencil, defaultBrush, defaultMarker, defaultTape, type PencilSettings } from './freehand'
import { wrappedInsertion } from './layout-order'
import { isEmptyLeafAlphaMask } from './mask-coverage'
import { deeperSelectionHit, interactivePath, marqueeScope, navigateSelection, shallowSelectionHit } from './selection-hierarchy'
import * as Components from './components'
import type { ComponentProperty } from './model'
import {
  type DesignDocument,
  type DesignNode,
  type Kind,
  type Point,
  type Matrix,
  type Network,
  type Effect,
  type Paint,
  type Stroke,
  uid,
  node,
  paint,
  blank,
  demo,
  container,
  maskChild,
  validateDocument,
  hasSchema17Features,
  hasSchema18Features,
  hasSchema19Features,
  hasSchema20Features,
  hasLocalVariableModes,
  hasStrokeMarkers,
  hasLayerExports,
  validateStructure,
  identity,
  defaultLayout,
  defaultSizing,
  type AutoLayout,
} from './model'
import {
  allParents,
  worldMatrix,
  multiply,
  inverse,
  translate,
  apply,
  scene,
  unionBounds,
  boxPoints,
  bounds,
  contours,
  contoursToNetwork,
  toNetwork,
  SpatialIndex,
  type SceneEntry,
  type ParentMap,
  preciseHit,
  contains,
  pointInContours,
} from './geometry'
import type { BooleanOp } from './vector'
import { pathNetwork } from './path-network'
import {
  kernelSvgPaths,
  kernelBounds,
  kernelHitWorld,
  kernelFillWorld,
  kernelLayout,
  invalidateGeometry,
  prepareDocumentForEditing,
  activateDocumentFonts,
  renewComponentResolution,
  pickingGeometryEpoch,
} from './kernel/picking'
import { proveLocalEdit } from './local-edit-proof'
import { shareDocument, documentPatch, produceDocumentDraft, type EditResult } from './document-patch'
import { createEditingHistory } from './kernel/graph-history'
import { ensurePreparedDocument, takePreparedDocument, preparedDocumentEncoding, forgetPreparedDocumentEncoding } from './prepared-document'
function applyInferredFrame(doc: DesignDocument, id: string, inferred: {direction:string;gap:number|null;padding:[number,number,number,number];bannerChildren:string[];flowOrder:string[]}) {
  if (inferred.direction !== 'horizontal' && inferred.direction !== 'vertical') return
  const n=doc.nodes[id]
  n.layout={...defaultLayout(),...n.layout,mode:inferred.direction,gap:inferred.gap??0,padding:inferred.padding}
  for(const child of inferred.bannerChildren) doc.nodes[child].sizing={...defaultSizing(),...doc.nodes[child].sizing,absolute:true}
  const flow=new Set(inferred.flowOrder);let at=0
  n.children=n.children.map(id=>flow.has(id)?inferred.flowOrder[at++]:id)
}

export type Tool =
  | import('./board-tools').BoardTool
  | 'text-path' | 'offset-path' | 'multiselect' | 'paint-bucket' | 'comments' | 'annotate'
  | 'measure' | 'vector-lasso' | 'bend' | 'cut' | 'eraser' | 'eyedropper'
  | 'slice'
  | 'select'
  | 'scale'
  | 'hand'
  | 'zoom'
  | 'frame'
  | 'section'
  | 'rectangle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'pencil'
  | 'brush' | 'marker' | 'washi-tape'
  | 'vector'
  | 'width'
  | 'text'
  | 'eraser'
  | 'eyedropper'
  | 'bucket'
  | 'measure'
  | 'slice'
  | 'crop'
  | 'comment'
export type View = { x: number; y: number; zoom: number }
export type PickSnapshot = { document: DesignDocument; pageId: string }
export type EditorState = {
  commentSelection?: string
  commentDraft?: {position:Point;nodeId?:string;kind:'comment'|'annotation'}
  doc: DesignDocument
  page: string
  selection: string[]
  hover: string | null
  hoverSource: 'canvas' | 'layers' | null
  tool: Tool
  view: View
  scrollWheelZoom: boolean
  checkerboard: boolean
  grid: boolean
  snap: boolean
  snapPixels: boolean
  pixelGrid: boolean
  rulers?: boolean
  pixelPreview: 0 | 1 | 2
  lastPixelPreview: 1 | 2
  message: string
  messagePresentation?: MessagePresentation
  busy: boolean
  widthStroke: number
  pencil: PencilSettings
  brush: PencilSettings
  /** 油漆桶当前颜色；吸管在未选中图层时取样到这里。 */
  bucket: { color: string }
  marker: PencilSettings
  'washi-tape': PencilSettings
  renamingLayer: string | null
  editingVertices?: string[]
  editingVertex: string | null
  version: number
}
/** Internal audit receipt, not replay authorization. The normalized document is
 * borrowed under the editor's immutable-snapshot contract; callers must not mutate it. */
export type CommittedEditReceipt = Readonly<{
  document: DesignDocument; documentId: string; session: number; revision: number; pageId: string
  selection: readonly string[]; canUndo: boolean; canRedo: boolean
}>
type History = { doc: DesignDocument; page: string; selection: string[]; label: string }
class GeometryCancelled extends Error {}
export type EditorEditEvent = { documentId: string; session: number; revision: number; source: 'user' | 'automation'; kind: 'edit' | 'undo' | 'redo'; summary: string }
export class Editor {
  private mutationRestriction?:string
  /** A navigation-only view may share camera/chrome without pretending that
   * its small UI document owns every cold source node. */
  setMutationRestriction(message?:string){this.mutationRestriction=message}
  private publishedScene?: CanvasSceneBorrow
  /** Borrow Canvas's two existing slots; no extra geometry/history cache. */
  bindPublishedScene(borrow: CanvasSceneBorrow | undefined) {
    this.publishedScene = borrow
    return () => { if (this.publishedScene === borrow) this.publishedScene = undefined }
  }
  // Published documents are immutable snapshots. Keep topology and clip/mask
  // transforms with that snapshot, never with a mutable edit draft or a point.
  private pickContexts = new WeakMap<DesignDocument, { nodes: DesignDocument['nodes']; pages: DesignDocument['pages']; version?: number; parents: Map<string, string>; matrices: Map<string, Matrix> }>()
  private pickContext(document: DesignDocument) {
    const version = document === this.state.doc ? this.state.version : undefined
    let context = this.pickContexts.get(document)
    if (!context || context.nodes !== document.nodes || context.pages !== document.pages ||
      (version !== undefined && context.version !== version)) {
      context = { nodes: document.nodes, pages: document.pages, version, parents: allParents(document), matrices: new Map() }
      this.pickContexts.set(document, context)
    }
    return context
  }
  /** Published editor/panel snapshots only. Mutable edit drafts must use
   * allParents so in-place hierarchy edits cannot reuse an earlier index. */
  parentMap(document = this.state.doc): ParentMap { return this.pickContext(document).parents }
  readonly operationDiagnostics = createCanvasOperationDiagnostics()
  private diagnosticOperation: number | null = null
  observeCanvasPresentation(frame: { document: object; pageId: string; epoch: number; preview?: boolean } | null) {
    // A stale frame or an interaction reprojection cannot certify current authored state.
    if (!frame || frame.document !== this.state.doc || frame.epoch !== this.sessionGeneration || frame.pageId !== this.state.page || this.interactionActive) return
    this.operationDiagnostics.acknowledge(frame.epoch, this.state.version, frame.document, frame.pageId, !!frame.preview)
  }
  lastPreviewTiming = { prepareMs: 0, layoutMs: 0, publishMs: 0 }
  pointerLocation:Point|null=null
  pointerScreen:Point|null=null
  preservedViewSession=-1
  state: EditorState
  private listeners = new Set<() => void>()
  private revealListeners = new Set<() => void>()
  private revealSerial = 0
  private revealRequest: { ids: string[]; nonce: number; session: number; documentId: string; pageId: string } | null = null
  private undoStack: Omit<History, 'doc'>[] = []
  private redoStack: Omit<History, 'doc'>[] = []
  private historyCore: ReturnType<typeof createEditingHistory> | null = null
  private transaction: (History & { placement?: { document:DesignDocument; ids:string[]; point:Point; force:boolean; preserveParent:boolean }; movePreview?: {source:DesignDocument;document:DesignDocument;published:DesignDocument;key:string;parents:ParentMap;epoch:object;translation:TranslationPreviewPlan}; dropIndex?: CanvasDropIndex; placementSizing?: Map<string, DesignNode['sizing']>; flow?: { base: DesignDocument; sizing: Map<string, DesignNode['sizing']> }; previewBase?: DesignDocument; copy?: { document: DesignDocument; roots: string[]; originals: string[]; flowSizing: Map<string, DesignNode['sizing']> } }) | null = null
  private propertyPreview: {
    lease: PropertyPreviewLease; history: History; session: number; revision: number
    targets: readonly SolidFillTarget[]; document: DesignDocument; draft: SolidFillDraft
    valid: boolean; trace: number
    settlement?: Readonly<{ document: DesignDocument; revision: number }>
  } | null = null
  // Internal reentrancy guard, not a capability exposed to UI callbacks.
  private propertyPreviewWrite = 0
  /** Persistence must use authored state, never an uncommitted property preview. */
  get authoredDocument() {
    const owner = this.propertyPreview
    // A replaced document is never masked by a stale lease. A newer selection
    // alone does not promote our own uncommitted preview to authored content.
    return owner && this.transaction === owner.history && this.state.doc === owner.document &&
      this.sessionGeneration === owner.session && this.state.version === owner.revision ? owner.history.doc : this.state.doc
  }
  get propertyPreviewActive() { return this.propertyPreview !== null }
  private repeatedDuplicate: (DuplicationRepeat & { document: DesignDocument; session: number; revision: number; pageId: string }) | null = null
  private clipboard: {
    nodes: Record<string, DesignNode>
    roots: string[]
    document: DesignDocument
    selection?: string[]
    placements?: Record<string, { transform: Matrix; outsideX: boolean; outsideY: boolean }>
    /** Internal capability; never accepted from serialized clipboard payloads. */
    sourceSession?: number
  } | null = null
  private readonly cameraState = new CameraState(undefined, () => interfacePreference.getSnapshot().rememberViewport)
  private releaseCameraLifecycle: (() => void) | undefined
  restoredCamera = false
  private saveCamera = () => {
    this.cameraState.remember(this.state.doc.id, this.state.page, this.effectiveView())
    this.cameraState.flush()
  }
  private sessionEpoch = 0
  get sessionGeneration() { return this.sessionEpoch }
  get interactionActive() { return this.transaction !== null }
  private duplicateOffset = 24
  private disposed = false
  private geometryJob: { cancel: () => void } | null = null
  constructor(doc = demo()) {
    doc = kernelLayout(doc)
    this.state = {
      doc,
      page: userPages(doc)[0].id,
      selection: [],
      hover: null,
      hoverSource: null,
      tool: 'select', commentSelection:undefined, commentDraft:undefined,
      view: { x: 30, y: 35, zoom: 1 },
      scrollWheelZoom: (() => {
        try { return typeof window !== 'undefined' && window.localStorage.getItem('forma-scroll-wheel-zoom') === 'true' }
        catch { return false }
      })(),
      grid: false,
      checkerboard: false,
      snap: true,
      snapPixels: true,
      pixelGrid: true,
      pixelPreview: 0,
      lastPixelPreview: 1,
      message: '就绪',
      busy: false,
      widthStroke: 0,
      pencil: defaultPencil(),
      brush: defaultBrush(),marker:defaultMarker(),'washi-tape':defaultTape(),
      bucket: { color: '#000000' },
      editingVertex: null, editingVertices: [],
      renamingLayer: null,
      version: 0,
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' &&
        typeof window.removeEventListener === 'function') {
      const remove = window.removeEventListener.bind(window)
      window.addEventListener('pagehide', this.saveCamera)
      this.releaseCameraLifecycle = () => remove('pagehide', this.saveCamera)
    }
  }
  private committedEditReceipts = new WeakMap<object, CommittedEditReceipt>()
  /** Only this editor's actual change/undo/redo result can resolve a receipt.
   * Copies/JSON never carry receipt authority; this grants no mutation permission. */
  committedEditReceipt(result: unknown): CommittedEditReceipt | undefined {
    return result !== null && typeof result === 'object' ? this.committedEditReceipts.get(result) : undefined
  }
  private editListeners = new Set<(event: EditorEditEvent) => void>()
  subscribeEdits = (fn: (event: EditorEditEvent) => void) => {
    this.editListeners.add(fn)
    return () => { this.editListeners.delete(fn) }
  }
  private publishEdit(kind: EditorEditEvent['kind'], summary: string, source: EditorEditEvent['source'] = 'user',
    identity?: Readonly<Pick<EditorEditEvent, 'documentId' | 'session' | 'revision'>>) {
    const owner = identity ?? { documentId: this.state.doc.id, session: this.sessionGeneration, revision: this.state.version }
    const event: EditorEditEvent = { ...owner, source, kind, summary: (source === 'automation' ? (kind === 'edit' ? 'API 文档修改' : kind === 'undo' ? 'API 撤销' : 'API 重做') : summary).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || '编辑' }
    for (const listener of this.editListeners) { try { listener({ ...event }) } catch { /* An audit sink must never undo or reject an editor commit. */ } }
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  snapshot = () => this.state
  subscribeReveal = (fn: () => void) => {
    this.revealListeners.add(fn)
    return () => {
      this.revealListeners.delete(fn)
    }
  }
  revealSnapshot = () => this.revealRequest
  /** Panel-originated camera request: bring these ids into view. The canvas
   * owns the viewport size and applies the minimal pan; canvas clicks never
   * emit this, so selecting on-canvas keeps the camera perfectly still. */
  requestReveal(ids: string[]) {
    if (this.disposed) return
    const unique = [...new Set(ids)].filter((id) => !!this.state.doc.nodes[id])
    if (!unique.length) return
    this.revealRequest = {
      ids: unique, nonce: ++this.revealSerial, session: this.sessionGeneration,
      documentId: this.state.doc.id, pageId: this.state.page,
    }
    for (const fn of this.revealListeners) fn()
  }
  consumeReveal(nonce: number) {
    if (this.revealRequest?.nonce !== nonce) return false
    this.revealRequest = null
    for (const fn of this.revealListeners) fn()
    return true
  }
  private panelState: Omit<EditorState, 'view'> | undefined
  private panelPublishedAt = 0
  /** Panels do not consume the camera. Preserve their immutable snapshot during
   * navigation so a pointer sample does not rebuild the layer tree/inspector. */
  panelSnapshot = () => {
    const { view: _view, ...next } = this.state
    // Full layer/Inspector trees must not compete with every pointer sample.
    // Keep coordinates fresh at a bounded cadence; release/undo publishes now.
    if (this.transaction && this.panelState && next.page === this.panelState.page &&
      next.selection === this.panelState.selection && next.tool === this.panelState.tool &&
      next.doc.id === this.panelState.doc.id && performance.now() - this.panelPublishedAt < 80) return this.panelState
    if (!this.panelState || (Object.keys(next) as (keyof typeof next)[])
      .some(key => next[key] !== this.panelState![key])) { this.panelState = next; this.panelPublishedAt = performance.now() }
    return this.panelState
  }
  set(patch: Partial<EditorState>) { this.setState(patch) }
  /** Only accepted commit publications opt into this notification-error channel.
   * Public set and all failures before the listener loop retain throwing behavior. */
  private setState(patch: Partial<EditorState>, onSubscriberError?: (error: unknown) => void) {
    let propertyNavigationCurrent: (() => boolean) | undefined
    if (this.propertyPreview && !this.propertyPreviewWrite) {
      if (patch.doc && patch.doc !== this.state.doc) {
        // An externally adopted snapshot supersedes the lease. Never restore its
        // base over the newer document or selection, including a same-id load.
        this.retirePropertyPreview(ActionReason.superseded)
      } else if ((patch.page !== undefined && patch.page !== this.state.page) ||
        (patch.selection !== undefined && JSON.stringify(patch.selection) !== JSON.stringify(this.state.selection))) {
        const owner = this.propertyPreview, before = this.state, session = this.sessionGeneration
        const selection = JSON.stringify(before.selection)
        // A legitimate color commit replaces its preview root and may advance
        // one revision. Only that private settlement receipt can authorize the
        // old navigation intent; synchronous subscribers cannot substitute a
        // newer document/session, revision or navigation state.
        propertyNavigationCurrent = () => {
          const expected = owner.settlement ?? { document: before.doc, revision: before.version }
          return !this.disposed && !this.transaction && !this.propertyPreview && this.sessionGeneration === session &&
            this.state.doc === expected.document && this.state.version === expected.revision &&
            this.state.page === before.page && JSON.stringify(this.state.selection) === selection &&
            (patch.page === undefined || this.state.doc.pages.some(page => page.id === patch.page)) &&
            (patch.selection === undefined || patch.selection.every(id => !!this.state.doc.nodes[id])) &&
            // An explicitly supplied old root/version cannot undo the commit
            // while applying what was otherwise a navigation-only change.
            (patch.doc === undefined || patch.doc === expected.document) &&
            (patch.version === undefined || patch.version === expected.revision)
        }
        if (!this.settleOwnedPropertyPreview('navigation') || !propertyNavigationCurrent()) return
      }
    }
    if (patch.doc && this.propertyPreview && this.propertyPreviewWrite) this.propertyPreview.document = patch.doc
    // Pure navigation must not unmount an invalid or composing document input.
    // Document mutations have already updated history and are fenced at their UI boundary.
    if (!patch.doc && ((patch.page !== undefined && patch.page !== this.state.page) ||
      (patch.selection !== undefined && JSON.stringify(patch.selection) !== JSON.stringify(this.state.selection)))) {
      const before = this.state, session = this.sessionGeneration, transaction = this.transaction
      const selection = JSON.stringify(before.selection)
      if (!commitPendingEdits(this)) return
      // Ordinary text/property input may legitimately advance the authored root
      // and revision. It must not carry an older navigation intent into a load
      // or overwrite navigation performed by a synchronous commit subscriber.
      if (this.disposed || this.sessionGeneration !== session || this.state.doc.id !== before.doc.id ||
        this.state.page !== before.page || JSON.stringify(this.state.selection) !== selection ||
        this.transaction !== transaction ||
        (this.state.doc !== before.doc && ((patch.page !== undefined && !this.state.doc.pages.some(page => page.id === patch.page)) ||
          (patch.selection !== undefined && !patch.selection.every(id => !!this.state.doc.nodes[id]))))) return
    }
    if (propertyNavigationCurrent && !propertyNavigationCurrent()) return
    // A direct camera write supersedes any coalesced wheel write still parked
    // in this frame — otherwise the rAF commit would silently roll the caller's
    // zoom back to the pre-click wheel camera.
    const navigationChanged = (patch.page !== undefined && patch.page !== this.state.page) ||
      (patch.doc !== undefined && patch.doc.id !== this.state.doc.id)
    if (navigationChanged) {
      this.cameraState.remember(this.state.doc.id, this.state.page, this.effectiveView())
      this.discardPendingView()
      if (patch.view === undefined) {
        const doc = patch.doc || this.state.doc
        const page = patch.page || this.state.page
        const saved = this.cameraState.recall(doc.id, doc.pages.map(p => p.id), page, interfacePreference.getSnapshot().rememberViewport)
        patch = { ...patch, view: saved?.view || { x: 40, y: 40, zoom: 1 } }
      }
    }
    if (patch.view !== undefined) {
      this.discardPendingView()
      patch={...patch,view:savedCamera(patch.view)||this.state.view}
    }
    const next = { ...this.state, ...patch }
    // Explicit raw messages supersede presentation tags even when text is equal.
    // Selection/camera updates do not shorten the existing notification lifetime.
    if (Object.prototype.hasOwnProperty.call(patch, 'message') &&
        !Object.prototype.hasOwnProperty.call(patch, 'messagePresentation')) next.messagePresentation = undefined
    if(next.page!==this.state.page||next.doc.id!==this.state.doc.id){this.pointerLocation=null;this.pointerScreen=null}
    if (next.page !== this.state.page || (next.hover && patch.doc &&
      !interactivePath(next.doc, next.page, next.hover, next.hoverSource === 'layers').length)) {
      next.hover = null
      next.hoverSource = null
    }
    if (next.doc !== this.state.doc || next.version !== this.state.version)
      forgetPreparedDocumentEncoding(this.state.doc)
    this.state = next
    if (patch.view !== undefined || navigationChanged)
      this.cameraState.remember(next.doc.id, next.page, next.view)
    // Notification callbacks do not inherit the internal preview capability.
    const propertyWrite = this.propertyPreviewWrite
    this.propertyPreviewWrite = 0
    try { for (const fn of this.listeners) fn() }
    catch (error) { if (onSubscriberError) onSubscriberError(error); else throw error }
    finally { this.propertyPreviewWrite = propertyWrite }
  }
  private publishCommittedState(patch: Partial<EditorState>) {
    let failure: { error: unknown } | undefined
    this.setState(patch, error => { failure = { error } })
    return failure
  }
  notify(message: string, status?: OperationStatus) {
    this.set({ message, messagePresentation: status ? { raw: message, status: { ...status } } : undefined })
  }
  setScrollWheelZoom(enabled: boolean) {
    this.set({ scrollWheelZoom: enabled })
    try { if (typeof window !== 'undefined') window.localStorage.setItem('forma-scroll-wheel-zoom', String(enabled)) }
    catch { /* Navigation still works when optional preference storage is unavailable. */ }
  }
  // ---- Coalesced camera writes -------------------------------------------
  // Wheel/trackpad streams exceed display rate and every editor.set re-renders
  // the whole canvas tree, so the camera parks one pending write per frame.
  // Every reader — zoom buttons, keyboard commands, reveal — must
  // see the same pending camera, or their writes race the rAF commit and get
  // silently rolled back. That is why the pending state lives on the editor
  // instead of one component.
  private pendingView: EditorState['view'] | null = null
  private pendingFrame: number | null = null
  /** Effective camera: the pending write when one is parked, else committed. */
  effectiveView(): EditorState['view'] {
    return this.pendingView || this.state.view
  }
  /** Optionally publish the first pan input immediately, then retain only
   * one latest camera per animation frame until the burst becomes idle. */
  setViewCoalesced(next: EditorState['view'], leading = false) {
    if (this.disposed) return
    this.pendingView = savedCamera(next)||this.effectiveView()
    if (this.pendingFrame !== null) return
    const commit=(view:EditorState['view'])=>{
      const session=this.sessionGeneration,doc=this.state.doc,page=this.state.page
      this.set({view})
      // set() deliberately clears parked cameras. A synchronous subscriber
      // may also navigate/load/queue a newer view; never overwrite its owner.
      if(leading&&!this.disposed&&this.sessionGeneration===session&&this.state.doc===doc&&this.state.page===page&&
          this.pendingFrame===null&&this.pendingView===null&&this.state.view.x===view.x&&this.state.view.y===view.y&&this.state.view.zoom===view.zoom)
        this.pendingFrame=requestAnimationFrame(flush)
    }
    const flush=()=>{
      this.pendingFrame = null
      const pending = this.pendingView
      this.pendingView = null
      if(pending)commit(pending)
    }
    if(leading){const pending=this.pendingView;this.pendingView=null;commit(pending)}
    else this.pendingFrame=requestAnimationFrame(flush)
  }
  /** Commit a parked camera write now; returns the committed view. */
  flushPendingView(): EditorState['view'] {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame)
      this.pendingFrame = null
    }
    const pending = this.pendingView
    this.pendingView = null
    if (pending) this.set({ view: pending })
    return this.state.view
  }
  /** Drop a parked write without committing (document/page switch). */
  discardPendingView() {
    if (this.pendingFrame !== null) {
      cancelAnimationFrame(this.pendingFrame)
      this.pendingFrame = null
    }
    this.pendingView = null
  }
  get historyOperationMode(){return this.historyCore?.mode||'uninitialized'}
  get historyFrameBytes(){return this.historyCore?.frameBytes||0}
  get historyBackend() { return this.historyCore ? 'graph-api' : 'uninitialized' }
  /** Build the read-only initial graph after first display, so the first
   * pointer release only applies its op batch. Never adopt a stale session or
   * initialize from an in-progress transaction. */
  warmEditingHistory(document: DesignDocument, session: number) {
    if (this.disposed || this.transaction || this.historyCore || this.state.doc !== document || this.sessionEpoch !== session) return false
    this.historyCore = createEditingHistory(document)
    return true
  }
  get canUndo() {
    return this.propertyPreviewActive || this.undoStack.length > 0
  }
  get canRedo() {
    return this.redoStack.length > 0
  }
  private history(label: string): History {
    return {
      doc: this.state.doc,
      page: this.state.page,
      selection: [...this.state.selection],
      label,
    }
  }
  private push(h: History, after: DesignDocument, source: EditorEditEvent['source'] = 'user'): EditResult | undefined {
    if (!this.historyCore) this.historyCore = createEditingHistory(h.doc)
    const revision = this.historyCore.revision
    // Provenance is supplied by the trusted editor route, never document data.
    // Rust calls the automation source "ai"; the UI/audit contract calls it
    // "automation". Do not change undo policy or grant authority from this tag.
    const result = this.historyCore.apply(revision, after, { source: source === 'automation' ? 'ai' : 'user' })
    renewComponentResolution(result.document)
    if (result.revision === revision) return
    this.undoStack.push({ page: h.page, selection: h.selection, label: h.label })
    this.undoStack = this.undoStack.slice(-result.undoDepth)
    this.redoStack = []
    const repeat = this.repeatedDuplicate
    this.repeatedDuplicate = repeat && repeat.document === h.doc && repeat.session === this.sessionGeneration &&
      repeat.revision === this.state.version && canContinueDuplication(h.doc, result.document, repeat)
      ? { ...repeat, document: result.document, revision: this.state.version + 1 } : null
    return result
  }
  change(
    label: string,
    fn: (d: DesignDocument) => void,
    selection?: string[],
    draftIds?: string[],
    source: EditorEditEvent['source'] = 'user',
    diagnosticCategory: OperationCategory = 'other',
    // Trusted local admission after materialization, before history/publication.
    admitResolved?: (document: DesignDocument) => void,
  ) {
    if(this.mutationRestriction){this.notify(this.mutationRestriction);return {status:'rejected' as const,revision:this.state.version,message:this.mutationRestriction}}
    if (!this.propertyPreviewWrite && !this.settleOwnedPropertyPreview('edit'))
      return { status: 'rejected' as const, revision: this.state.version, message: '请先完成颜色输入' }
    const before = this.history(label)
    // Rebuild each color draft from the immutable lease base. Reverting an edit
    // also restores text-run colors and instance overrides, with no hidden diff.
    if (this.propertyPreviewWrite && this.propertyPreview) before.doc = this.propertyPreview.history.doc
    const operation = this.diagnosticOperation ?? this.operationDiagnostics.begin(this.sessionGeneration, this.state.version, diagnosticCategory, draftIds?.length ?? selection?.length ?? this.state.selection.length)
    const finish = (outcome: 'committed' | 'unchanged' | 'rejected') => { if (!this.transaction) this.operationDiagnostics.finish(operation, outcome, this.sessionGeneration, this.state.version, this.state.doc, this.state.page) }
    try {
      // Finalize only the authored mutation before inspecting topology. This
      // keeps the check on plain structurally shared records and prevents any
      // component/connector/layout walk from observing an invalid tree.
      const authored = produceDocumentDraft(before.doc, draft => { fn(draft as DesignDocument) })
      const local = proveLocalEdit(before.doc, authored)
      if (!local) validateStructure(authored)
      const components = !local && Object.values(before.doc.nodes).some(
        n => n.component || n.instance || n.instanceOrigin || n.componentSet,
      )
      const componentScope = components ? Components.propertyEditScope(before.doc, authored) : undefined
      let detached = false
      const d = local ? authored : produceDraft(authored, (draft) => {
        draft.schemaVersion = Math.max(2, draft.schemaVersion) as 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10
        if (draft.schemaVersion < 15 && hasSchema15Features(authored)) draft.schemaVersion = 15
        if(draft.schemaVersion < 16 && Object.values(authored.nodes).some(n=>n.vectorGeometry))draft.schemaVersion=16
        if(draft.schemaVersion < 17 && hasSchema17Features(authored))draft.schemaVersion=17
        if(draft.schemaVersion < 18 && hasSchema18Features(authored))draft.schemaVersion=18
        if(draft.schemaVersion < 20 && hasSchema20Features(authored))draft.schemaVersion=20
        if(draft.schemaVersion < 19 && hasSchema19Features(authored))draft.schemaVersion=19
        draft.rasterProfile ??= before.doc.rasterProfile || (draft.colorManagement ? 'figma' : 'analytic')
        // Before component/dependency cleanup, only root schema/profile fields
        // have changed. Inspect finalized authored nodes here to avoid creating
        // Immer proxies for every untouched node during legacy admission.
        // Schema promotion is monotonic. Once a version is supported, scanning
        // every Immer node again cannot change it. Full validation still runs
        // after dependency cleanup and authoritative layout below.
        if (draft.schemaVersion < 4 && (
          draft.designSystem ||
          draft.prototype ||
          Object.values(authored.nodes).some(
            (n) =>
              n.booleanOperation ||
              n.maskType ||
              n.textRuns?.some((r) => r.color || r.link || r.underline || r.strikethrough) ||
              n.textStyle?.paragraphSpacing ||
              n.textStyle?.paragraphIndent ||
              n.textStyle?.align === 'justify' ||
              n.fills.some((p) => p.transform || p.kind === 'angular' || p.kind === 'diamond') ||
              n.strokes.some(
                (s) =>
                  s.paint.transform || s.paint.kind === 'angular' || s.paint.kind === 'diamond',
              ),
          )
        ))
          draft.schemaVersion = Math.max(draft.schemaVersion, 4) as 4 | 5 | 6 | 7 | 8 | 9 | 10
        if (draft.schemaVersion < 5 && (
          Object.values(authored.nodes).some((n) => n.effects.some((e) => e.glass || e.texture)) ||
          draft.animations?.some((c) =>
            c.tracks.some((t) =>
              t.keyframes.some((k) => k.value.effects.some((e) => e.glass || e.texture)),
            ),
          ) ||
          Object.values(draft.designSystem?.styles || {}).some(
            (s) =>
              s.kind === 'effect' &&
              Array.isArray(s.value) &&
              s.value.some((e) => e?.glass || e?.texture),
          )
        ))
          draft.schemaVersion = Math.max(draft.schemaVersion, 5) as 5 | 6 | 7 | 8 | 9 | 10
        detached = !!(components && !componentScope && Components.detachMissing(before.doc, draft as DesignDocument))
        if (components) Components.captureOverrides(before.doc, draft as DesignDocument, componentScope)
        if (draft.schemaVersion < 6 && hasLocalVariableModes(draft as DesignDocument)) draft.schemaVersion = Math.max(draft.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
        if (draft.schemaVersion < 7 && (Object.values(draft.nodes).some(n => n.arc || n.cornerRadius || n.constrainProportions) ||
          draft.animations?.some(c => c.tracks.some(t => t.keyframes.some(k => k.value.arc || k.value.cornerRadius))))) draft.schemaVersion = Math.max(7, draft.schemaVersion) as 7 | 8 | 9 | 10
        if (draft.schemaVersion < 9 && hasGradientBlur(draft as DesignDocument)) draft.schemaVersion = Math.max(9,draft.schemaVersion) as 9 | 10
        if(draft.schemaVersion < 10 && hasLocalTools(draft as DesignDocument))draft.schemaVersion=Math.max(10,draft.schemaVersion) as DesignDocument['schemaVersion'];if(draft.schemaVersion < 11 && hasRulerGuides(draft as DesignDocument))draft.schemaVersion=Math.max(11,draft.schemaVersion) as DesignDocument['schemaVersion'];if(draft.schemaVersion < 12 && hasLayoutGrids(draft as DesignDocument))draft.schemaVersion=Math.max(12,draft.schemaVersion) as DesignDocument['schemaVersion'];if(draft.schemaVersion < 13 && hasImageAdjusts(draft as DesignDocument))draft.schemaVersion=Math.max(13,draft.schemaVersion) as DesignDocument['schemaVersion'];if(draft.schemaVersion < 14 && hasPatternTiles(draft as DesignDocument))draft.schemaVersion=Math.max(14,draft.schemaVersion) as DesignDocument['schemaVersion']
        for(const n of Object.values(draft.nodes))if(n.connector)for(const e of [n.connector.from,n.connector.to])if(e.nodeId&&!draft.nodes[e.nodeId]){const old=before.doc.nodes[e.nodeId];if(old&&e.anchor)e.point=apply(worldMatrix(before.doc,e.nodeId),{x:old.width*e.anchor.x,y:old.height*e.anchor.y});delete e.nodeId;delete e.anchor}
        if(draft.reviews) {
          draft.reviews=draft.reviews.filter(r=>draft.pages.some(p=>p.id===r.pageId))
          for(const r of draft.reviews)if(r.nodeId&&!draft.nodes[r.nodeId]){if(before.doc.nodes[r.nodeId])r.position=apply(worldMatrix(before.doc,r.nodeId),r.position);delete r.nodeId}
        }
        if (draft.schemaVersion < 8 && (hasStrokeMarkers(draft as DesignDocument) || hasLayerExports(draft as DesignDocument))) draft.schemaVersion = Math.max(8,draft.schemaVersion) as 8 | 9 | 10
        pruneAnimations(draft as DesignDocument)
        prunePrototypeReferences(before.doc, draft as DesignDocument)
      })
      for (const n of local ? local.ids.map(id => d.nodes[id]) : Object.values(d.nodes))
        if (n !== before.doc.nodes[n.id]) invalidateGeometry(n)
      // Layout-independent edits still restore the correct native font owner.
      if (local) activateDocumentFonts(d)
      const resolved = shareDocument(before.doc, local ? d : kernelLayout(d, before.doc))
      for (const n of local ? local.ids.map(id => resolved.nodes[id]) : Object.values(resolved.nodes))
        if ((n.pathOffset || n.vectorBrush) && n !== before.doc.nodes[n.id]) kernelBounds(n)
      if (!local) validateStructure(resolved)
      validateDocument(resolved)
      admitResolved?.(resolved)
      if (resolved === before.doc) { finish('unchanged'); return { status: 'unchanged' as const, revision: this.state.version } }
      if (this.transaction) {
        this.transaction.previewBase = resolved
        this.set({ doc: resolved, selection: selection ?? this.state.selection.filter(id => !!resolved.nodes[id]), message: label })
        return { status: 'preview' as const, revision: this.state.version }
      }
      const committed = this.push(before, resolved, source)
      if (!committed) { finish('unchanged'); return { status: 'unchanged' as const, revision: this.state.version } }
      const editIdentity = { documentId: committed.document.id, session: this.sessionGeneration, revision: this.state.version + 1 }
      const committedPage = this.state.page
      const result = { status: 'committed' as const, revision: editIdentity.revision }
      const committedSelection = selection ?? this.state.selection.filter((id) => !!committed.document.nodes[id])
      this.committedEditReceipts.set(result, Object.freeze({ ...editIdentity, document: committed.document, pageId: committedPage,
        selection: Object.freeze([...committedSelection]), canUndo: this.canUndo, canRedo: this.canRedo }))
      const notificationFailure = this.publishCommittedState({
        doc: committed.document,
        selection: committedSelection,
        version: editIdentity.revision,
        message: detached ? `${label}（相关实例已分离）` : label,
      })
      this.operationDiagnostics.finish(operation, 'committed', editIdentity.session, editIdentity.revision, committed.document, committedPage)
      this.publishEdit('edit', label, source, editIdentity)
      if (notificationFailure) reportPostcommitSubscriberError(notificationFailure.error)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.notify(message)
      finish('rejected')
      return { status: 'rejected' as const, revision: this.state.version, message }
    }
  }
  /** Acquire only after earlier input drafts settle; never borrow a pointer tx. */
  acquirePropertyPreview(targets: readonly SolidFillTarget[]): PropertyPreviewLease | null {
    if (this.disposed || this.state.busy || this.transaction || !commitPendingEdits(this)) return null
    if (this.transaction || !targets.length || targets.length > 1000) return null
    const seen = new Set<string>(), parents = allParents(this.state.doc)
    for (const target of targets) {
      if (target.kind !== 'solid-fill' || !Number.isSafeInteger(target.fillIndex) || target.fillIndex < 0 ||
        !this.state.selection.includes(target.nodeId)) return null
      const key = JSON.stringify([target.nodeId, target.fillIndex])
      if (seen.has(key)) return null
      seen.add(key)
      let at = target.nodeId
      while (parents.has(at) && this.state.doc.nodes[at]) at = parents.get(at)!
      if (at !== this.state.page || !this.propertyTargetCurrent(this.state.doc, target)) return null
    }
    const lease = Object.freeze({}) as PropertyPreviewLease
    const history = this.history('修改填充颜色和不透明度')
    const trace = canvasActions(this).begin(CanvasAction.propertyInput, ActionSource.properties,
      { fieldFamily: 9, inputPhase: 2, targetCount: targets.length, selectionBefore: this.state.selection.length })
    this.diagnosticOperation = this.operationDiagnostics.begin(this.sessionGeneration, this.state.version, 'other', targets.length)
    this.transaction = history
    this.propertyPreview = { lease, history, trace, session: this.sessionGeneration, revision: this.state.version,
      targets: targets.map(target => Object.freeze({ ...target })), document: this.state.doc, draft: {}, valid: true }
    return lease
  }
  private propertyTargetCurrent(document: DesignDocument, target: SolidFillTarget) {
    const n = document.nodes[target.nodeId], p = n?.fills[target.fillIndex]
    return !!n && n.kind !== 'slice' && p?.kind === 'solid' && p.id === target.fillId &&
      !n.styleRefs?.fills && !Object.keys(n.bindings ?? {}).some(path =>
        path === 'fills' || path === `fills.${target.fillIndex}` || path.startsWith(`fills.${target.fillIndex}.`))
  }
  isPropertyPreviewCurrent(lease: PropertyPreviewLease): boolean {
    const owner = this.propertyPreview
    return !!owner && owner.lease === lease && !this.disposed && this.transaction === owner.history &&
      this.sessionGeneration === owner.session && this.state.version === owner.revision &&
      this.state.doc === owner.document && this.state.page === owner.history.page &&
      JSON.stringify(this.state.selection) === JSON.stringify(owner.history.selection) &&
      owner.targets.every(target => this.propertyTargetCurrent(this.state.doc, target))
  }
  setPropertyPreviewValidity(lease: PropertyPreviewLease, valid: boolean): boolean {
    if (!this.isPropertyPreviewCurrent(lease)) return false
    this.propertyPreview!.valid = valid
    return true
  }
  previewProperty(lease: PropertyPreviewLease, patch: SolidFillDraft): PropertyPreviewResult {
    if (!this.isPropertyPreviewCurrent(lease)) return 'stale'
    const owner = this.propertyPreview!
    if (Object.keys(patch).some(key => key !== 'color' && key !== 'opacity') ||
      (patch.color !== undefined && !validColor(patch.color, !!owner.history.doc.colorManagement)) ||
      (patch.opacity !== undefined && (!Number.isFinite(patch.opacity) || patch.opacity < 0 || patch.opacity > 1))) {
      owner.valid = false
      canvasActions(this).sample(owner.trace, { inputValid: false })
      return 'rejected'
    }
    const previousDraft = owner.draft, draft = { ...owner.draft, ...patch }
    owner.draft = draft
    owner.valid = true
    this.propertyPreviewWrite++
    try {
      const changed = owner.targets.some(target => {
        const p = owner.history.doc.nodes[target.nodeId].fills[target.fillIndex]
        return (draft.color !== undefined && draft.color !== p.color) || (draft.opacity !== undefined && draft.opacity !== p.opacity)
      })
      let result: ReturnType<Editor['change']> | undefined
      if (!changed) {
        this.transaction!.previewBase = undefined
        if (this.state.doc !== owner.history.doc) this.set({ doc: owner.history.doc })
      } else result = this.change('修改填充颜色和不透明度', document => {
        for (const target of owner.targets) {
          const n = document.nodes[target.nodeId], p = n.fills[target.fillIndex]
          if (draft.color !== undefined && p.color !== draft.color) { p.color = draft.color; clearWholeTextRunColor(n) }
          if (draft.opacity !== undefined) p.opacity = draft.opacity
        }
      })
      if (this.propertyPreview !== owner || !this.isPropertyPreviewCurrent(lease)) return 'stale'
      if (result?.status === 'rejected') { owner.draft = previousDraft; owner.valid = false; return 'rejected' }
      owner.draft = draft
      owner.valid = true
      canvasActions(this).sample(owner.trace, { inputValid: true, resolvedChanged: changed })
      if (this.diagnosticOperation !== null) this.operationDiagnostics.preview(this.diagnosticOperation, true)
      return changed ? 'preview' : 'unchanged'
    } finally { this.propertyPreviewWrite-- }
  }
  /** Settle only this narrow property lease; never commits arbitrary gestures. */
  settleOwnedPropertyPreview(_boundary: PropertyPreviewBoundary): boolean {
    const owner = this.propertyPreview
    if (!owner) return true
    const result = this.commitProperty(owner.lease)
    if (result === 'committed' || result === 'unchanged') return true
    if (result === 'stale') { this.cancelProperty(owner.lease); return !this.propertyPreview }
    this.notify('颜色输入尚未完成或已失效，请完成输入或取消后重试')
    return false
  }
  commitProperty(lease: PropertyPreviewLease): PropertyPreviewResult {
    if (!this.isPropertyPreviewCurrent(lease)) return 'stale'
    const owner = this.propertyPreview!
    if (!owner.valid) return 'blocked'
    const matches = (document: DesignDocument) => owner.targets.every(target => {
      const n = document.nodes[target.nodeId], base = owner.history.doc.nodes[target.nodeId]
      const p = n?.fills[target.fillIndex], original = base.fills[target.fillIndex]
      return this.propertyTargetCurrent(document, target) &&
        p.color === (owner.draft.color ?? original.color) && p.opacity === (owner.draft.opacity ?? original.opacity) &&
        n.opacity === base.opacity && JSON.stringify(n.bindings) === JSON.stringify(base.bindings) &&
        JSON.stringify(n.styleRefs) === JSON.stringify(base.styleRefs)
    })
    if (!matches(this.state.doc)) { owner.valid = false; return 'rejected' }
    // Validate/apply before retiring the capability. History failures keep a
    // recoverable draft open; they cannot masquerade as a successful commit.
    let committed: EditResult | undefined, document: DesignDocument
    try {
      validateDocument(this.state.doc)
      document = shareDocument(owner.history.doc, this.state.doc)
      committed = document !== owner.history.doc ? this.push(owner.history, document) : undefined
    } catch {
      owner.valid = false
      this.notify('颜色提交失败，输入已保留，请重试或取消')
      return 'rejected'
    }
    const operation = this.diagnosticOperation
    this.propertyPreview = null
    this.transaction = null
    this.diagnosticOperation = null
    const finalDocument = committed?.document ?? document
    const verified = matches(finalDocument), changed = !!committed
    const finalRevision = owner.revision + Number(changed)
    owner.settlement = { document: finalDocument, revision: finalRevision }
    // State subscribers may synchronously load another session. Preserve the
    // committed edit's identity without changing notification/audit ordering.
    const editIdentity = { documentId: finalDocument.id, session: owner.session, revision: finalRevision }
    const notificationFailure = this.publishCommittedState({ doc: finalDocument, version: finalRevision, message: owner.history.label })
    if (operation !== null) this.operationDiagnostics.finish(operation, changed ? 'committed' : 'unchanged',
      owner.session, owner.revision + Number(changed), finalDocument, owner.history.page)
    if (changed) this.publishEdit('edit', owner.history.label, 'user', editIdentity)
    canvasActions(this).finish(owner.trace, !verified ? ActionOutcome.rejected : changed ? ActionOutcome.committed : ActionOutcome.unchanged,
      verified ? ActionReason.none : ActionReason.validation,
      { fieldFamily: 9, inputPhase: 6, inputValid: verified, committedChanged: changed,
        intentResolvedComparison: verified ? 1 : 2, resolvedCommittedComparison: verified ? 1 : 2,
        selectionAfter: this.state.selection.length })
    if (notificationFailure) reportPostcommitSubscriberError(notificationFailure.error)
    return !verified ? 'rejected' : changed ? 'committed' : 'unchanged'
  }
  cancelProperty(lease: PropertyPreviewLease): PropertyPreviewResult {
    const owner = this.propertyPreview
    if (!owner || owner.lease !== lease) return 'stale'
    // A stale capability must not roll back another transaction or a newer doc.
    if (!this.isPropertyPreviewCurrent(lease)) {
      const restoreOwnPreview = this.transaction === owner.history && this.state.doc === owner.document &&
        this.sessionGeneration === owner.session && this.state.version === owner.revision
      this.retirePropertyPreview(ActionReason.superseded)
      // Preserve a newer external selection/page; only remove our exact pixels.
      if (restoreOwnPreview) this.set({ doc: owner.history.doc,
        selection: this.state.selection.filter(id => !!owner.history.doc.nodes[id]) })
      return 'stale'
    }
    this.propertyPreview = null
    this.propertyPreviewWrite++
    try { this.cancel() } finally { this.propertyPreviewWrite-- }
    canvasActions(this).finish(owner.trace, ActionOutcome.cancelled, ActionReason.escape,
      { fieldFamily: 9, inputPhase: 7, committedChanged: false,
        resolvedCommittedComparison: this.state.doc === owner.history.doc ? 1 : 2 })
    return 'unchanged'
  }
  private retirePropertyPreview(reason: typeof ActionReason[keyof typeof ActionReason]) {
    const owner = this.propertyPreview
    if (!owner) return
    this.propertyPreview = null
    if (this.transaction === owner.history) {
      this.transaction = null
      if (this.diagnosticOperation !== null) this.operationDiagnostics.finish(this.diagnosticOperation, 'cancelled', this.sessionGeneration, this.state.version)
      this.diagnosticOperation = null
    }
    canvasActions(this).finish(owner.trace, ActionOutcome.cancelled, reason, { fieldFamily: 9, inputPhase: 7 })
  }
  begin(label: string) {
    if (!this.settleOwnedPropertyPreview('edit')) return
    if (!this.transaction) {
      const history = this.history(label)
      this.diagnosticOperation = this.operationDiagnostics.begin(this.sessionGeneration, this.state.version, gestureCategory(label), this.state.selection.length)
      this.transaction = history
    }
  }
  preview(patches: Record<string, Partial<DesignNode>>, move?: { ids:string[]; point:Point; force:boolean; preserveParent:boolean }) {
    return canvasActions(this).cpu.run(CpuStage.preview, () => this.previewCore(patches, move))
  }
  private previewLayout?: PreviewLayout
  private previewCore(patches: Record<string, Partial<DesignNode>>, move?: { ids:string[]; point:Point; force:boolean; preserveParent:boolean }) {
    if (this.propertyPreview && !this.propertyPreviewWrite) return false
    const previewStarted = performance.now()
    const previewOwner=this.transaction
    const base = this.transaction?.previewBase || this.transaction?.doc || this.state.doc
    if(move){
      const cached=this.cachedMovePreview(patches,move)
      if(cached){
        const document=produceDocumentDraft(this.state.doc,draft=>{for(const id of move.ids)draft.nodes[id].transform=cached.patches[id].transform!})
        const published=performance.now();this.set({doc:document})
        if(this.transaction===previewOwner&&previewOwner?.movePreview&&this.state.doc===document){
          previewOwner.movePreview.published=document
          previewOwner.placement={...move,ids:[...move.ids],point:{...move.point},document}
        }
        if(this.diagnosticOperation!==null)this.operationDiagnostics.preview(this.diagnosticOperation,true)
        this.lastPreviewTiming={prepareMs:published-previewStarted,layoutMs:0,publishMs:performance.now()-published}
        return true
      }
    }
    if (!move && this.transaction) {
      if (this.previewLayout?.base !== base) this.previewLayout = new PreviewLayout(base)
      try {
        const resolved = measureCpuStage(CpuStage.previewLayout, () => this.previewLayout!.prepare(patches))
        if (resolved) {
          for (const id of Object.keys(documentPatch(base, resolved).nodes)) {
            const n = resolved.nodes[id]
            if (n && (n.pathOffset || n.vectorBrush)) kernelBounds(n)
          }
          const published = performance.now()
          measureCpuStage(CpuStage.previewPublish, () => this.set({ doc: resolved }))
          if (this.diagnosticOperation !== null) this.operationDiagnostics.preview(this.diagnosticOperation, true)
          this.lastPreviewTiming = { prepareMs:0, layoutMs:published-previewStarted, publishMs:performance.now()-published }
          return true
        }
      } catch (error) {
        if (this.diagnosticOperation !== null) this.operationDiagnostics.preview(this.diagnosticOperation, false)
        this.notify(error instanceof Error ? error.message : String(error)); return false
      }
    }
    const nodes = { ...base.nodes }
    for (const [id, patch] of Object.entries(patches)) nodes[id] = { ...nodes[id], ...patch }
    try {
      const visible = measureCpuStage(CpuStage.previewPrepare, () => {
        const candidate = { ...base, nodes }
        // Ordinary pointer patches preserve the published tree. Explicit
        // topology/ID edits must be checked before any dependency traversal.
        if (Object.entries(patches).some(([id, patch]) => !base.nodes[id] ||
            Object.hasOwn(patch, 'children') || Object.hasOwn(patch, 'id')))
          validateStructure(candidate)
        Components.captureOverrides(base, candidate)
        if (candidate.schemaVersion < 6 && hasLocalVariableModes(candidate)) candidate.schemaVersion = Math.max(candidate.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
        if (candidate.schemaVersion < 7 && Object.values(candidate.nodes).some(n => n.arc || n.cornerRadius || n.constrainProportions)) candidate.schemaVersion = Math.max(7, candidate.schemaVersion) as 7 | 8 | 9 | 10
        if (candidate.schemaVersion < 9 && hasGradientBlur(candidate)) candidate.schemaVersion = Math.max(9,candidate.schemaVersion) as 9 | 10
        if(candidate.schemaVersion < 10 && hasLocalTools(candidate))candidate.schemaVersion=Math.max(10,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 11 && hasRulerGuides(candidate as DesignDocument))candidate.schemaVersion=Math.max(11,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 12 && hasLayoutGrids(candidate as DesignDocument))candidate.schemaVersion=Math.max(12,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 13 && hasImageAdjusts(candidate as DesignDocument))candidate.schemaVersion=Math.max(13,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 14 && hasPatternTiles(candidate as DesignDocument))candidate.schemaVersion=Math.max(14,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 15 && hasSchema15Features(candidate))candidate.schemaVersion=15;if(candidate.schemaVersion < 16 && Object.values(candidate.nodes).some(n=>n.vectorGeometry))candidate.schemaVersion=16;if(candidate.schemaVersion < 17 && hasSchema17Features(candidate))candidate.schemaVersion=17;if(candidate.schemaVersion < 18 && hasSchema18Features(candidate))candidate.schemaVersion=18;if(candidate.schemaVersion < 20 && hasSchema20Features(candidate))candidate.schemaVersion=20;if(candidate.schemaVersion < 19 && hasSchema19Features(candidate))candidate.schemaVersion=19
        if (candidate.schemaVersion < 8 && (hasStrokeMarkers(candidate) || hasLayerExports(candidate))) candidate.schemaVersion = Math.max(8,candidate.schemaVersion) as 8 | 9 | 10
        const visible=move?this.movePreviewDocument(candidate,move.ids,move.point,move.force,move.preserveParent):candidate
        if (visible !== candidate) validateStructure(visible)
        return visible
      })
      const layoutStarted = performance.now()
      const resolved=measureCpuStage(CpuStage.previewLayout, () => kernelLayout(visible,this.state.doc,true))
      const resolvedEpoch=pickingGeometryEpoch()
      // A failed derived offset must never become the React scene. Scene/hit
      // queries are synchronous: publishing it first can unmount the editor.
      measureCpuStage(CpuStage.previewBounds, () => {
        for(const n of Object.values(resolved.nodes))
          if((n.pathOffset||n.vectorBrush)&&n!==this.state.doc.nodes[n.id])kernelBounds(n)
      })
      const published = performance.now()
      measureCpuStage(CpuStage.previewPublish, () => this.set({ doc: resolved }))
      if(this.transaction===previewOwner&&previewOwner&&this.state.doc===resolved)
        previewOwner.placement=move?{...move,ids:[...move.ids],point:{...move.point},document:resolved}:undefined
      if(move&&this.transaction===previewOwner&&previewOwner&&this.state.doc===resolved&&resolvedEpoch===pickingGeometryEpoch()&&move.ids.length===1&&!previewOwner.copy&&!previewOwner.flow&&
          Object.keys(patches).length===1&&Object.keys(patches[move.ids[0]]||{}).every(key=>key==='transform')){
        const plan=this.movePlacement({ ...base,nodes },move.ids,move.point,move.force,move.preserveParent)
        previewOwner.movePreview={source:base,document:resolved,published:resolved,key:plan.key,parents:allParents(resolved),epoch:resolvedEpoch,translation:new TranslationPreviewPlan(resolved,move.ids)}
      }
      if (this.diagnosticOperation !== null) this.operationDiagnostics.preview(this.diagnosticOperation, true)
      this.lastPreviewTiming = { prepareMs: layoutStarted - previewStarted, layoutMs: published - layoutStarted, publishMs: performance.now() - published }
      return true
    } catch (error) {
      if (this.diagnosticOperation !== null) this.operationDiagnostics.preview(this.diagnosticOperation, false)
      this.notify(error instanceof Error ? error.message : String(error))
      return false
    }
  }
  commit() {
    this.previewLayout = undefined
    return canvasActions(this).cpu.run(CpuStage.commit, () => this.commitCore())
  }
  private commitCore() {
    if (this.propertyPreview && !this.propertyPreviewWrite) return
    if (!this.transaction) return
    const before = this.transaction
    const operation = this.diagnosticOperation
    this.diagnosticOperation = null
    const finish = (outcome: 'committed' | 'unchanged' | 'rejected') => { if (operation !== null) this.operationDiagnostics.finish(operation, outcome, this.sessionGeneration, this.state.version, this.state.doc, this.state.page) }
    this.transaction = null
    try {
      measureCpuStage(CpuStage.commitValidate, () => validateDocument(this.state.doc))
    } catch (error) {
      finish('rejected')
      this.set({ doc: before.doc, selection: before.selection, message: String(error) })
      return
    }
    try {
      const doc = measureCpuStage(CpuStage.commitShare, () => shareDocument(before.doc, this.state.doc))
      const committed = doc !== before.doc ? measureCpuStage(CpuStage.commitHistory, () => this.push(before, doc)) : undefined
      if (committed) {
        const editIdentity = { documentId: committed.document.id, session: this.sessionGeneration, revision: this.state.version + 1 }
        const committedPage = this.state.page
        const result = { status: 'committed' as const, revision: editIdentity.revision }
        this.committedEditReceipts.set(result, Object.freeze({ ...editIdentity, document: committed.document, pageId: committedPage,
          selection: Object.freeze([...this.state.selection]), canUndo: this.canUndo, canRedo: this.canRedo }))
        const notificationFailure = measureCpuStage(CpuStage.commitPublish, () => this.publishCommittedState({ doc: committed.document, version: editIdentity.revision, message: before.label }))
        if (operation !== null) this.operationDiagnostics.finish(operation, 'committed', editIdentity.session, editIdentity.revision, committed.document, committedPage)
        this.publishEdit('edit', before.label, 'user', editIdentity)
        if (notificationFailure) reportPostcommitSubscriberError(notificationFailure.error)
        return result
      } else { if (doc !== this.state.doc) this.set({ doc }); finish('unchanged') }
    } catch (error) {
      finish('rejected')
      this.set({ doc: before.doc, selection: before.selection, message: String(error) })
    }
  }
  cancel() {
    this.previewLayout = undefined
    if (this.propertyPreview) { this.cancelProperty(this.propertyPreview.lease); return }
    if (this.transaction) {
      const h = this.transaction
      if (this.diagnosticOperation !== null) this.operationDiagnostics.finish(this.diagnosticOperation, 'cancelled', this.sessionGeneration, this.state.version)
      this.diagnosticOperation = null
      this.transaction = null
      this.set({ doc: h.doc, selection: h.selection })
    }
  }
  undo(source: EditorEditEvent['source'] = 'user') {
    if(this.mutationRestriction){this.notify(this.mutationRestriction);return}
    this.repeatedDuplicate = null
    // First Undo only cancels the owned draft, not the preceding authored edit.
    if (this.propertyPreview) { this.cancelProperty(this.propertyPreview.lease); return }
    const action = beginEditorAction(this, CanvasAction.undo, ActionSource.unknown, 228)
    try {
    this.cancel()
    const h = this.undoStack.at(-1)
    if (!h) return
    const operation = this.operationDiagnostics.begin(this.sessionGeneration, this.state.version, 'undo', this.state.selection.length)
    let doc: DesignDocument
    try {
      doc = this.historyCore!.undo().document
    } catch (error) {
      this.operationDiagnostics.finish(operation, 'rejected', this.sessionGeneration, this.state.version)
      this.notify(String(error))
      return
    }
    this.undoStack.pop()
    this.redoStack.push({ page: this.state.page, selection: this.state.selection, label: h.label })
    const editIdentity = { documentId: doc.id, session: this.sessionGeneration, revision: this.state.version + 1 }
    const result = { status: 'committed' as const, revision: editIdentity.revision }
    this.committedEditReceipts.set(result, Object.freeze({ ...editIdentity, document: doc, pageId: h.page,
      selection: Object.freeze([...h.selection]), canUndo: this.canUndo, canRedo: this.canRedo }))
    const notificationFailure = this.publishCommittedState({
      ...h,
      doc,
      tool: 'select', commentSelection:undefined, commentDraft:undefined,
      editingVertex: null, editingVertices: [],
      version: editIdentity.revision,
      message: `撤销：${h.label}`,
    })
    this.operationDiagnostics.finish(operation, 'committed', editIdentity.session, editIdentity.revision, doc, h.page)
    this.publishEdit('undo', h.label, source, editIdentity)
    if (notificationFailure) reportPostcommitSubscriberError(notificationFailure.error)
    return result
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  redo(source: EditorEditEvent['source'] = 'user') {
    if(this.mutationRestriction){this.notify(this.mutationRestriction);return}
    this.repeatedDuplicate = null
    if (!this.settleOwnedPropertyPreview('edit')) return
    const action = beginEditorAction(this, CanvasAction.redo, ActionSource.unknown, 229)
    try {
    this.cancel()
    const h = this.redoStack.at(-1)
    if (!h) return
    const operation = this.operationDiagnostics.begin(this.sessionGeneration, this.state.version, 'redo', this.state.selection.length)
    let doc: DesignDocument
    try {
      doc = this.historyCore!.redo().document
    } catch (error) {
      this.operationDiagnostics.finish(operation, 'rejected', this.sessionGeneration, this.state.version)
      this.notify(String(error))
      return
    }
    this.redoStack.pop()
    this.undoStack.push({ page: this.state.page, selection: this.state.selection, label: h.label })
    const editIdentity = { documentId: doc.id, session: this.sessionGeneration, revision: this.state.version + 1 }
    const result = { status: 'committed' as const, revision: editIdentity.revision }
    this.committedEditReceipts.set(result, Object.freeze({ ...editIdentity, document: doc, pageId: h.page,
      selection: Object.freeze([...h.selection]), canUndo: this.canUndo, canRedo: this.canRedo }))
    const notificationFailure = this.publishCommittedState({
      ...h,
      doc,
      tool: 'select', commentSelection:undefined, commentDraft:undefined,
      editingVertex: null, editingVertices: [],
      version: editIdentity.revision,
      message: `重做：${h.label}`,
    })
    this.operationDiagnostics.finish(operation, 'committed', editIdentity.session, editIdentity.revision, doc, h.page)
    this.publishEdit('redo', h.label, source, editIdentity)
    if (notificationFailure) reportPostcommitSubscriberError(notificationFailure.error)
    return result
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  load(value: unknown, preserveView=false) {
    if (this.disposed) return false
    if (!this.settleOwnedPropertyPreview('navigation') || !commitPendingEdits(this)) return false
    const previous=this.state
    const previousView = this.effectiveView()
    const prepared = ensurePreparedDocument(value), encoding = preparedDocumentEncoding(prepared)
    const doc = takePreparedDocument(prepared)!
    this.cameraState.remember(previous.doc.id, previous.page, previousView)
    const saved = !preserveView && interfacePreference.getSnapshot().rememberViewport
      ? this.cameraState.recall(doc.id, doc.pages.map(p => p.id)) : undefined
    this.restoredCamera = !!saved
    this.operationDiagnostics.endSession()
    this.diagnosticOperation = null
    this.sessionEpoch++
    this.repeatedDuplicate = null
    const adoptedSession = this.sessionEpoch, adoptedVersion = this.state.version + 1
    if (this.revealRequest) this.consumeReveal(this.revealRequest.nonce)
    this.preservedViewSession=(preserveView || saved)?this.sessionEpoch:-1
    this.geometryJob?.cancel()
    this.undoStack = []
    this.redoStack = []
    this.historyCore?.free()
    this.historyCore = null
    this.transaction = null
    this.set({
      doc,
      page:saved?.pageId || (preserveView&&doc.pages.some(p=>p.id===previous.page)?previous.page:doc.pages[0].id),
      selection:preserveView?previous.selection.filter(id=>!!doc.nodes[id]):[],
      hover: null,
      hoverSource: null,
      tool: 'select', commentSelection:undefined, commentDraft:undefined,
      view:saved?.view || (preserveView?previousView:{x:40,y:40,zoom:1}),
      version: adoptedVersion,
      message: '设计已打开',
      busy: false,
    })
    encoding?.bindCurrent(doc, () => !this.disposed && this.state.doc === doc &&
      this.state.version === adoptedVersion && this.sessionEpoch === adoptedSession)
    return true
  }
  newDocument() {
    const action = beginEditorAction(this, CanvasAction.newDocument, ActionSource.unknown, 230)
    try {
    if (this.load(blank())) action.result(ActionOutcome.observed)
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  select(ids: string[]) {
    const action = beginEditorAction(this, CanvasAction.selection, ActionSource.unknown, 201)
    try {
    this.set({ selection: [...new Set(ids)], editingVertex: null, editingVertices:[],
      // Selection changes the entered hierarchy. The old canvas hit can now
      // refer to an ancestor; do not leave that outline behind a deeper select.
      ...(this.state.hoverSource === 'canvas' ? { hover: null, hoverSource: null } : {}),
    })
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  clearSelection() { this.select([]) }
  hoverLayer(id: string | null, source: 'canvas' | 'layers' = 'canvas') {
    if (id === null && this.state.hoverSource !== source) return
    if (id === this.state.hover && source === this.state.hoverSource) return
    if (id && !interactivePath(this.state.doc, this.state.page, id, source === 'layers', this.pickContext(this.state.doc).parents).length) id = null
    if (this.state.hover === id && this.state.hoverSource === (id ? source : null)) return
    this.set({ hover: id, hoverSource: id ? source : null })
  }
  private navigateSelection(action: 'children' | 'parent' | 'next' | 'previous') {
    const ids = navigateSelection(this.state.doc, this.state.page, this.state.selection, action, this.parentMap())
    if (!ids) return false
    this.select(ids)
    return ids.length === this.state.selection.length && ids.every((id, i) => id === this.state.selection[i])
  }
  selectChildren() { return this.navigateSelection('children') }
  selectParent() { return this.navigateSelection('parent') }
  selectSibling(direction: 1 | -1) { return this.navigateSelection(direction === 1 ? 'next' : 'previous') }
  selectDeeper(point: Point, index?: SpatialIndex, zoom = this.state.view.zoom, snapshot?: PickSnapshot): { id: string; changed: boolean } | null {
    const hit = this.hit(point, true, index, zoom, snapshot)
    if (!hit) return null
    const document = snapshot?.document || this.state.doc, page = snapshot?.pageId || this.state.page
    const parents = this.parentMap(document)
    const candidate = deeperSelectionHit(document, this.state.selection, hit, interactivePath(document, page, hit, false, parents), parents)
    const id = interactivePath(this.state.doc, this.state.page, candidate, false, this.parentMap()).length ? candidate : hit
    const changed = this.state.selection.length !== 1 || this.state.selection[0] !== id
    this.select([id])
    return this.state.selection.length === 1 && this.state.selection[0] === id ? { id, changed } : null
  }
  topSelection(allowLocked = false) {
    if (!this.state.selection.length) return []
    const parents = this.pickContext(this.state.doc).parents,
      ids = new Set(this.state.selection)
    return this.state.selection.filter((id) => {
      if (!this.state.doc.nodes[id] || (!allowLocked && this.state.doc.nodes[id].locked)) return false
      let p = parents.get(id)
      while (p) {
        if (!allowLocked && this.state.doc.nodes[p]?.locked) return false
        if (ids.has(p)) return false
        p = parents.get(p)
      }
      return true
    })
  }
  entries() {
    const entries = this.publishedScene?.entriesFor(this.state.doc, this.state.page, this.sessionGeneration)
    return entries ? [...entries] : scene(this.state.doc, this.state.page)
  }
  selectionBounds() {
    const ids = new Set(this.topSelection())
    return unionBounds(
      this.entries()
        .filter((e) => ids.has(e.id))
        .map((e) => e.bounds),
    )
  }
  /** Ordinary canvas press and hover share one target. Container movement is
   * explicit (existing selection or title); unopened ancestors must not replace
   * the child that the pointer just identified. Native clipping/lock/foreground
   * board checks remain in hit(). Legacy hierarchy navigation still uses hit(). */
  selectionHit(p: Point, deep = false, index?: SpatialIndex, zoom = this.state.view.zoom, snapshot?: PickSnapshot): string | null {
    if (deep) return this.hit(p, true, index, zoom, snapshot)
    return this.hoverHit(p,index,zoom,snapshot)
  }
  /** Hover identifies the smallest eligible object within the front board,
   * independently of the hierarchy used by click/drag selection. */
  hoverHit(p: Point, index?: SpatialIndex, viewZoom = this.state.view.zoom, snapshot?: PickSnapshot): string | null {
    const hit=this.hit(p,true,index,viewZoom,snapshot,undefined,'smallest')
    if(!hit)return null
    const document=snapshot?.document||this.state.doc,page=snapshot?.pageId||this.state.page,parents=this.pickContext(document).parents
    const path=interactivePath(document,page,hit,false,parents),selected=new Set(this.state.selection)
    return path.find(id=>selected.has(id)&&(container(document.nodes[id])||document.nodes[id].component||document.nodes[id].instance||document.nodes[id].componentSet))||hit
  }
  hit(p: Point, deep = false, index?: SpatialIndex, viewZoom = this.state.view.zoom, snapshot?: PickSnapshot, eligible?: (node:DesignNode)=>boolean, priority: 'paint-order' | 'smallest' = 'paint-order'): string | null {
    const authored = snapshot?.document || this.state.doc,
      d = expandRepeats(authored),
      page = snapshot?.pageId || this.state.page,
      entries = (d === authored ? index : undefined) || new SpatialIndex(scene(d, page)),
      tol = 5 / viewZoom
    // Hit the pixels actually on screen while a later frame is rendering. The
    // visible target must still be editable in the current document and page.
    if (page !== this.state.page || d.id !== this.state.doc.id) return null
    const liveParents = d !== this.state.doc ? this.pickContext(this.state.doc).parents : undefined
    const live = (id: string) => !liveParents || !!interactivePath(this.state.doc, this.state.page, repeatSourceId(d, id), false, liveParents).length
    // Exclusions depend on the query point and density; topology and world
    // matrices depend only on the immutable document, not the camera.
    const excluded = new Map<string, boolean>()
    const { parents, matrices } = this.pickContext(d)
    const matrixFor = (id: string): Matrix => {
      const cached = matrices.get(id)
      if (cached) return cached
      const parent = parents.get(id),
        n = d.nodes[id]
      const matrix = n
        ? multiply(parent && d.nodes[parent] ? matrixFor(parent) : identity(), n.transform)
        : identity()
      matrices.set(id, matrix)
      return matrix
    }
    const blocks = (id: string): boolean => {
      const cached = excluded.get(id)
      if (cached !== undefined) return cached
      const a = d.nodes[id],
        mask = maskChild(d, a)
      // Group/text constraints retain their existing bounding-shape proxy here;
      // full text/group mask alpha requires a separate compositing contract.
      const legacyShape = (n: DesignNode) => !n.network && (n.kind === 'group' || n.kind === 'text')
      const clipped =
        a.clip &&
        (legacyShape(a)
          ? !contains(
              { x: 0, y: 0, width: a.width, height: a.height },
              apply(inverse(matrixFor(id)), p),
            )
          : !kernelFillWorld(a, p, matrixFor(id), viewZoom))
      const masked =
        !clipped &&
        !!mask &&
        (mask.opacity <= 0 ||
          isEmptyLeafAlphaMask(mask) ||
          (legacyShape(mask)
            ? !pointInContours(apply(inverse(matrixFor(mask.id)), p), contours(mask))
            : !kernelFillWorld(mask, p, matrixFor(mask.id), viewZoom)))
      const result = clipped || masked
      excluded.set(id, result)
      return result
    }
    let hovered: SceneEntry | undefined, hoverOwner: string | undefined
    const owner = (entry: SceneEntry) => entry.ancestors.find(id => d.nodes[id].kind === 'frame') ||
      (d.nodes[entry.id].kind === 'frame' ? entry.id :
        entry.ancestors.find(id => d.nodes[id].kind === 'section') || entry.ancestors[0] || entry.id)
    const area = (entry: SceneEntry) => Math.max(0, entry.bounds.width) * Math.max(0, entry.bounds.height)
    for (const e of entries
      .query({ x: p.x - tol, y: p.y - tol, width: tol * 2, height: tol * 2 })
      .reverse()) {
      const n = d.nodes[e.id]
      if (e.locked || n.kind === 'group' || !live(e.id) || (eligible&&!eligible(n))) continue
      if (priority === 'smallest' && hovered) {
        // Do not select through a foreground board. Within that board, a
        // descendant beats its parent; siblings use area, then paint order.
        if (owner(e) !== hoverOwner || hovered.ancestors.includes(e.id)) continue
        if (!e.ancestors.includes(hovered.id) && area(e) >= area(hovered)) continue
      }
      if (e.ancestors.some(blocks)) continue
      if (!kernelHitWorld(n, p, e.matrix, viewZoom)) continue
      if (priority === 'smallest') { hovered = e; hoverOwner ??= owner(e); continue }
      if (deep) return repeatSourceId(d, e.id)
      const candidate = shallowSelectionHit(d, this.state.selection, e.id, [...e.ancestors, e.id], parents)
      return repeatSourceId(d, live(candidate) ? candidate : e.id)
    }
    return hovered ? repeatSourceId(d, hovered.id) : null
  }
  add(
    kind: Kind,
    b: { x: number; y: number; width: number; height: number },
    parent?: string,
    network?: Network,
  ) {
    const action = beginEditorAction(this, CanvasAction.create, ActionSource.unknown, 202)
    try {
    const n = node(kind, b.x, b.y, Math.max(1, b.width), Math.max(1, b.height))
    if (network) n.network = network
    this.change(
      `创建${n.name}`,
      (d) => {
        d.nodes[n.id] = n
        ;(parent && d.nodes[parent]
          ? d.nodes[parent].children
          : d.pages.find((p) => p.id === this.state.page)!.children
        ).push(n.id)
      },
      [n.id],
    )
    return n.id
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  addFreehand(n: DesignNode) {
    const action = beginEditorAction(this, CanvasAction.create, ActionSource.unknown, 203)
    try {
    this.change(
      '绘制铅笔路径',
      (d) => {
        d.nodes[n.id] = cloneValue(n)
        d.pages.find((p) => p.id === this.state.page)!.children.push(n.id)
        validateDocument(d)
      },
      [n.id],
    )
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  update(
    ids: string[],
    patch: Partial<DesignNode> | ((n: DesignNode) => void),
    label = '修改属性',
    source?: 'properties',
  ) {
    // Pointer previews are aggregated by their gesture owner, not logged per update.
    const commandCode = typeof patch !== 'function' && Object.hasOwn(patch, 'locked') ? 241 : typeof patch !== 'function' && Object.hasOwn(patch, 'visible') ? 242 : 240
    const action = this.interactionActive ? undefined : beginEditorAction(this, CanvasAction.layer, source === 'properties' ? ActionSource.properties : ActionSource.unknown, commandCode)
    try {
    const result = this.change(
      label,
      (d) => {
        for (const id of ids) {
          const n = d.nodes[id]
          if (n) {
            if (n.locked && source !== 'properties' && !['切换锁定', '切换可见性', '重命名图层'].includes(label)) continue
            if (typeof patch === 'function') patch(n)
            else Object.assign(n, patch)
            if (!n.strokes.every(validStroke) || !validProfiles(n))
              throw new Error('描边参数无效，请检查宽度控制点、虚线或闭合接缝')
          }
        }
      },
      undefined,
      ids,
      'user',
      (label === '编辑文字' || label === '编辑富文本') ? 'text' : patchCategory(patch),
    )
    if (result?.status === 'rejected') action?.result(ActionOutcome.rejected, ActionReason.validation)
    } finally { action?.finish() }
  }
  /** The property panel can edit a layer selected explicitly in the layer tree.
   * Canvas gestures keep update()'s existing lock protection. */
  updateProperties(ids: string[], patch: Partial<DesignNode> | ((n: DesignNode) => void), label = '修改属性') {
    this.update(ids, patch, label, 'properties')
  }
  remove() {
    const action = beginEditorAction(this, CanvasAction.delete, ActionSource.unknown, 204)
    try {
    this.removeNodes(this.topSelection(), '删除图层', [])
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  /** Explicit-id deletion for canvas tools (eraser). Locked layers and layers
   * under a locked ancestor are skipped, matching selection-based delete. */
  removeNodes(ids: string[], label = '删除图层', selection?: string[]) {
    const action = beginEditorAction(this, CanvasAction.delete, ActionSource.unknown, 205)
    try {
    this.change(
      label,
      (d) => {
        const parents = allParents(d)
        const del = (id: string) => {
          d.nodes[id]?.children.forEach(del)
          delete d.nodes[id]
        }
        for (const id of ids) {
          let blocked = !d.nodes[id] || d.nodes[id].locked
          let current = parents.get(id)
          // Page ids appear as parents of root layers; they are not lockable nodes.
          while (!blocked && current && d.nodes[current]) {
            blocked = d.nodes[current].locked
            current = parents.get(current)
          }
          if (blocked) continue
          const p = parents.get(id)
          const list = d.nodes[p || '']?.children || d.pages.find((v) => v.id === p)?.children
          if (list) list.splice(list.indexOf(id), 1)
          del(id)
        }
      },
      selection,
    )
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  previewSuggestedLayout(frameId = this.topSelection()[0]): LayoutSuggestionPreview {
    return { ...previewLayoutSuggestion(this.state.doc, frameId), revision: this.state.version }
  }
  applySuggestedLayout(preview: LayoutSuggestionPreview, suggestionId: string) {
    // Validate before opening history; the callback revalidates after pending edits.
    const current = this.previewSuggestedLayout(preview.frameId)
    if (current.revision !== preview.revision || current.fingerprint !== preview.fingerprint) throw new Error('Layout preview is stale; preview again before applying')
    if (!current.suggestions.some(s => s.id === suggestionId)) throw new Error('Unknown layout suggestion')
    const result = this.change('应用建议布局', doc => { applyLayoutSuggestion(doc, preview.frameId, preview.fingerprint, suggestionId) })
    if (result.status === 'rejected') throw new Error(result.message)
    return result
  }
  autoLayout(requestedMode?: AutoLayout['mode'], selected?: readonly string[]) {
    const originalDocument = this.state.doc.id, originalSession = this.sessionGeneration
    if (!commitPendingEdits(this) || !this.settleOwnedPropertyPreview('edit')) return
    if (this.state.doc.id !== originalDocument || this.sessionGeneration !== originalSession) throw new Error('Layout command document was superseded')
    const ids = [...(selected ?? this.state.selection)], state = { fresh: true }
    if (!ids.length) return
    const documentId = this.state.doc.id, session = this.sessionGeneration, revision = this.state.version
    const assertOwner = (doc: DesignDocument) => {
      if (doc.id !== documentId || this.sessionGeneration !== session || this.state.version !== revision) throw new Error('Layout command owner was superseded')
    }
    if (requestedMode === undefined) {
      // Preserve the established inference input geometry, including its 16-unit
      // wrapper outset. This strategy is not the explicit MCP add intent.
      const admitted = layoutCommandAdmission(this.state.doc, ids), roots = admitted.ids
      if (roots.some(id => this.state.doc.nodes[id].booleanOperation || this.state.doc.nodes[id].mask)) throw new Error('Boolean and mask containers require dedicated operations')
      if (roots.length === 1 && container(this.state.doc.nodes[roots[0]])) {
        const result = this.change('设置自动布局', doc => {
          assertOwner(doc); layoutCommandAdmission(doc, ids)
          const inferred = JSON.parse(inferred_layout_json(JSON.stringify(doc), roots[0]))
          const target = doc.nodes[roots[0]]
          target.kind = 'frame'; target.layout = { ...defaultLayout(), ...target.layout, mode: 'horizontal' }
          applyInferredFrame(doc, target.id, inferred)
        })
        if (result.status === 'rejected') throw new Error(result.message)
        return result
      }
      const parent = admitted.parents.get(roots[0])!
      if (roots.some(id => admitted.parents.get(id) !== parent)) throw new Error('请先选中同一容器中的图层')
      const chosen = new Set(roots), box = unionBounds(this.entries().filter(entry => chosen.has(entry.id)).map(entry => entry.bounds)),
        pm = worldMatrix(this.state.doc, parent), frame = node('frame', 0, 0, Math.max(1, box.width + 32), Math.max(1, box.height + 32))
      frame.name = '自动布局'; frame.fills = []; frame.clip = false
      frame.layout = defaultLayout(); frame.sizing = { ...defaultSizing(), width: 'hug', height: 'hug' }
      frame.transform = multiply(inverse(pm), translate(box.x - 16, box.y - 16))
      const result = this.change('创建自动布局', doc => {
        assertOwner(doc); layoutCommandAdmission(doc, ids)
        const siblings = doc.nodes[parent]?.children || doc.pages.find(page => page.id === parent)!.children
        const at = Math.min(...roots.map(id => siblings.indexOf(id))), world = multiply(pm, frame.transform)
        frame.children = [...roots].sort((a, b) => {
          const x = apply(inverse(world), apply(worldMatrix(doc, a), { x: 0, y: 0 })), y = apply(inverse(world), apply(worldMatrix(doc, b), { x: 0, y: 0 }))
          return x.x - y.x
        })
        for (const id of roots) {
          doc.nodes[id].transform = multiply(inverse(world), worldMatrix(doc, id))
          const index = siblings.indexOf(id); if (index >= 0) siblings.splice(index, 1)
        }
        doc.nodes[frame.id] = frame
        applyInferredFrame(doc, frame.id, JSON.parse(inferred_layout_json(JSON.stringify(doc), frame.id)))
        siblings.splice(at, 0, frame.id)
      }, [frame.id])
      if (result.status === 'rejected') throw new Error(result.message)
      return result
    }
    if (requestedMode === 'none') {
      prepareLayoutRemove(this.state.doc, ids, state)
      const result = this.change('移除自动布局', doc => { assertOwner(doc); applyLayoutRemove(doc, prepareLayoutRemove(doc, ids, state)) }, ids)
      if (result.status === 'rejected') throw new Error(result.message)
      return result
    }
    const options = { mode: requestedMode === 'vertical' ? 'vertical' as const : 'horizontal' as const }
    const initial = prepareLayoutAdd(this.state.doc, ids, options, state)
    const wrapperId = initial.wrapper?.id
    const result = this.change('设置自动布局', doc => {
      assertOwner(doc)
      const plan = prepareLayoutAdd(doc, ids, { ...options, ...(wrapperId ? { id: wrapperId } : {}) }, state)
      applyLayoutAdd(doc, plan)
      if (requestedMode === 'grid') doc.nodes[plan.target].layout!.mode = 'grid'
    }, [initial.target])
    if (result.status === 'rejected') throw new Error(result.message)
    return result
  }
  previewLayoutOrder(id: string, point: Point): boolean {
    const base = this.transaction?.previewBase || this.transaction?.doc || this.state.doc,
      // This is the published immutable gesture baseline, not the mutable
      // candidate constructed below. Reuse its existing topology index.
      parents = this.parentMap(base),
      parent = parents.get(id),
      p = base.nodes[parent || ''],
      n = base.nodes[id]
    if (!p?.layout || p.layout.mode === 'none' || n.sizing?.absolute) return false
    const cursor = apply(inverse(worldMatrix(base, p.id, parents)), point),
      axis = p.layout.mode === 'vertical' ? 1 : 0
    const flow = p.children.filter(
      (child) => child !== id && base.nodes[child].visible && !base.nodes[child].sizing?.absolute,
    )
    let before: string | undefined
    if (p.layout.mode === 'grid' || p.layout.wrap)
      before = wrappedInsertion(this.state.doc.nodes, flow, cursor, axis)
    else
      before = flow.find((child) => {
        const c = this.state.doc.nodes[child]
        return (
          (axis ? cursor.y : cursor.x) < c.transform[axis + 4] + (axis ? c.height : c.width) / 2
        )
      })
    const children = p.children.filter((child) => child !== id)
    const at = before ? children.indexOf(before) : children.length
    children.splice(at, 0, id)
    try {
      const candidate = { ...base, nodes: { ...base.nodes, [p.id]: { ...p, children } } }
      Components.captureOverrides(base, candidate)
      if (candidate.schemaVersion < 6 && hasLocalVariableModes(candidate)) candidate.schemaVersion = Math.max(candidate.schemaVersion, 6) as 6 | 7 | 8 | 9 | 10
      if (candidate.schemaVersion < 7 && Object.values(candidate.nodes).some(n => n.arc || n.cornerRadius || n.constrainProportions)) candidate.schemaVersion = Math.max(7, candidate.schemaVersion) as 7 | 8 | 9 | 10
      if (candidate.schemaVersion < 9 && hasGradientBlur(candidate)) candidate.schemaVersion = Math.max(9,candidate.schemaVersion) as 9 | 10
      if(candidate.schemaVersion < 10 && hasLocalTools(candidate))candidate.schemaVersion=Math.max(10,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 11 && hasRulerGuides(candidate as DesignDocument))candidate.schemaVersion=Math.max(11,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 12 && hasLayoutGrids(candidate as DesignDocument))candidate.schemaVersion=Math.max(12,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 13 && hasImageAdjusts(candidate as DesignDocument))candidate.schemaVersion=Math.max(13,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 14 && hasPatternTiles(candidate as DesignDocument))candidate.schemaVersion=Math.max(14,candidate.schemaVersion) as DesignDocument['schemaVersion'];if(candidate.schemaVersion < 15 && hasSchema15Features(candidate))candidate.schemaVersion=15;if(candidate.schemaVersion < 16 && Object.values(candidate.nodes).some(n=>n.vectorGeometry))candidate.schemaVersion=16;if(candidate.schemaVersion < 17 && hasSchema17Features(candidate))candidate.schemaVersion=17;if(candidate.schemaVersion < 18 && hasSchema18Features(candidate))candidate.schemaVersion=18;if(candidate.schemaVersion < 20 && hasSchema20Features(candidate))candidate.schemaVersion=20;if(candidate.schemaVersion < 19 && hasSchema19Features(candidate))candidate.schemaVersion=19
      if (candidate.schemaVersion < 8 && (hasStrokeMarkers(candidate) || hasLayerExports(candidate))) candidate.schemaVersion = Math.max(8,candidate.schemaVersion) as 8 | 9 | 10
      this.set({ doc: kernelLayout(candidate) })
    } catch (error) {
      this.notify(String(error))
    }
    return true
  }
  createComponent() {
    const ids = this.topSelection()
    let root = ''
    this.change('创建主组件', (d) => {
      root = Components.createMain(d, ids, this.state.page)
    })
    if (this.state.doc.nodes[root]?.component) this.select([root])
    return root
  }
  insertComponent(componentId: string, position?: Point, parent?: string) {
    let id = ''
    const v = this.state.view,
      p = position || { x: (160 - v.x) / v.zoom, y: (140 - v.y) / v.zoom }
    this.change('插入组件实例', (d) => {
      id = Components.insertInstance(d, componentId, this.state.page, p, parent)
    })
    if (this.state.doc.nodes[id]?.instance) this.select([id])
    return id
  }
  detachInstance(id = this.state.selection[0]) {
    const owner = Components.instanceOwner(this.state.doc, id)
    if (owner) this.change('分离实例', (d) => Components.detach(d, owner))
  }
  resetInstance(id = this.state.selection[0]) {
    this.change('重置实例覆盖', (d) => Components.resetInstance(d, id))
  }
  swapInstance(id: string, target: string) {
    this.change('替换组件实例', (d) => Components.swapInstance(d, id, target))
  }
  declareComponentSlot(targetId: string, name: string) {
    this.change('声明内容插槽', d => { ComponentSlots.declareSlot(d, targetId, name) })
  }
  removeComponentSlot(componentId: string, slotId: string) {
    this.change('移除内容插槽', d => ComponentSlots.removeSlot(d, componentId, slotId))
  }
  assignComponentSlot(instanceId: string, slotId: string, roots: string[] | null) {
    this.change('设置插槽内容', d => ComponentSlots.assignSlot(d, instanceId, slotId, roots))
  }
  setComponentProperty(id: string, key: string, value: string | boolean) {
    this.change('修改组件属性', (d) => Components.setProperty(d, id, key, value))
  }
  exposeComponentProperty(target: string, kind: ComponentProperty['kind'], name: string) {
    this.change('定义组件属性', (d) => Components.defineProperty(d, target, kind, name))
  }
  addVariant(id = this.state.selection[0]) {
    let created = ''
    this.change('添加组件变体', (d) => {
      created = Components.addVariant(d, id, this.state.page)
    })
    if (this.state.doc.nodes[created]?.component) this.select([created])
    return created
  }
  combineVariants() {
    let id = ''
    this.change('创建组件集', (d) => {
      id = Components.variantSet(d, this.topSelection(), this.state.page)
    })
    if (this.state.doc.nodes[id]?.componentSet) this.select([id])
  }
  switchVariant(id: string, axis: string, value: string) {
    this.change('切换组件变体', (d) => Components.switchVariant(d, id, axis, value))
  }
  addVariantAxis(setId: string, name: string) {
    this.change('添加变体属性', (d) => {
      const set = d.nodes[setId]
      if (
        !set?.componentSet ||
        !name.trim() ||
        ['__proto__', 'constructor', 'prototype'].includes(name)
      )
        throw new Error('变体属性名称无效')
      for (const id of set.children) {
        const variants = d.nodes[id].component!.variants
        if (Object.hasOwn(variants, name)) throw new Error('变体属性已存在')
        variants[name] = '默认'
      }
    })
  }
  goToMain(id = this.state.selection[0]) {
    const n = this.state.doc.nodes[id],
      owner = n?.instance
        ? n
        : this.state.doc.nodes[Components.instanceOwner(this.state.doc, id) || '']
    const target = owner?.instance?.componentId
    if (!target || !this.state.doc.nodes[target]) return
    const parents = allParents(this.state.doc)
    let page = target
    while (parents.has(page)) page = parents.get(page)!
    this.switchPage(page)
    this.select([target])
    const m = worldMatrix(this.state.doc, target)
    this.set({ view: { x: 60 - m[4], y: 60 - m[5], zoom: 1 } })
  }
  /** Page topology must never be folded into a captured gesture's preview base.
   * Match PageList admission, and recheck after flushing recoverable input. */
  private admitPageMutation() {
    if (this.interactionActive || this.state.busy) return false
    return commitPendingEdits(this) && !this.interactionActive && !this.state.busy
  }
  addPage() {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 210)
    try {
    const session = this.sessionGeneration, documentId = this.state.doc.id
    const ownsDocument = () => this.sessionGeneration === session && this.state.doc.id === documentId
    if (!this.admitPageMutation() || !ownsDocument()) { action.result(ActionOutcome.blocked, this.interactionActive || this.state.busy ? ActionReason.busy : ActionReason.validation); return false }
    const p = {
      id: uid(),
      name: `页面 ${this.state.doc.pages.length + 1}`,
      children: [],
      background: '#eeeff3',
    }
    const result = this.change(
      '新建页面',
      (d) => {
        d.pages.push(p)
      },
      [],
    )
    if (result.status !== 'committed') return false
    if (!ownsDocument() || !this.state.doc.pages.some(page => page.id === p.id)) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return false }
    this.set({ page: p.id })
    return ownsDocument() && this.state.page === p.id
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  reorderPage(id: string, before?: string) {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 211)
    try {
    const session = this.sessionGeneration, documentId = this.state.doc.id
    const ownsDocument = () => this.sessionGeneration === session && this.state.doc.id === documentId
    if (!this.admitPageMutation() || !ownsDocument()) { action.result(ActionOutcome.blocked, this.interactionActive || this.state.busy ? ActionReason.busy : ActionReason.validation); return false }
    if (!this.state.doc.pages.some(page => page.id === id) || id === before) return false
    const result = this.change('调整页面顺序', d => {
      const at = d.pages.findIndex(page => page.id === id), [page] = d.pages.splice(at, 1)
      const target = before ? d.pages.findIndex(page => page.id === before) : d.pages.length
      if (target < 0) throw new Error('目标页面已不存在')
      d.pages.splice(target, 0, page)
    })
    return result.status === 'committed' && ownsDocument()
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  duplicatePage(id = this.state.page) {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 212)
    try {
    const session = this.sessionGeneration, documentId = this.state.doc.id
    const ownsDocument = () => this.sessionGeneration === session && this.state.doc.id === documentId
    if (!this.admitPageMutation() || !ownsDocument()) { action.result(ActionOutcome.blocked, this.interactionActive || this.state.busy ? ActionReason.busy : ActionReason.validation); return false }
    const source = this.state.doc, page = source.pages.find(value => value.id === id)
    if (!page) return false
    const content = this.copyGraph(page.children), copied = { ...cloneValue(page), id: uid(), name: `${page.name} 副本`.slice(0, 200), children: [] as string[] }
    const result = this.change('复制页面', d => {
      d.pages.splice(d.pages.findIndex(value => value.id === id) + 1, 0, copied)
      duplicateGraph(d, content, { page: copied.id })
    }, [])
    if (result.status !== 'committed') return false
    if (!ownsDocument() || !this.state.doc.pages.some(page => page.id === copied.id)) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return false }
    this.set({ page: copied.id })
    return ownsDocument() && this.state.page === copied.id
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  removePage() {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 213)
    try {
    const session = this.sessionGeneration, documentId = this.state.doc.id
    const ownsDocument = () => this.sessionGeneration === session && this.state.doc.id === documentId
    if (!this.admitPageMutation() || !ownsDocument()) { action.result(ActionOutcome.blocked, this.interactionActive || this.state.busy ? ActionReason.busy : ActionReason.validation); return false }
    if (!canDeletePage(this.state.doc, this.state.page)) {
      this.notify('至少保留一个页面')
      return false
    }
    const page = this.state.page
    const result = this.change(
      '删除页面',
      (d) => {
        const p = d.pages.find((p) => p.id === page)!
        const del = (id: string) => {
          d.nodes[id].children.forEach(del)
          delete d.nodes[id]
        }
        p.children.forEach(del)
        d.pages = d.pages.filter((p) => p.id !== page)
      },
      [],
    )
    if (result.status !== 'committed') return false
    if (!ownsDocument()) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return false }
    this.set({ page: userPages(this.state.doc)[0].id })
    return ownsDocument()
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  switchPage(page: string) {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 214)
    try {
    const session = this.sessionGeneration, documentId = this.state.doc.id
    const ownsDocument = () => this.sessionGeneration === session && this.state.doc.id === documentId
    if (!this.state.doc.pages.some(value => value.id === page)) { action.result(ActionOutcome.blocked, ActionReason.noTarget); return false }
    if (!commitPendingEdits(this) || !this.settleOwnedPropertyPreview('navigation')) { action.result(ActionOutcome.blocked, ActionReason.validation); return false }
    // Draft commit callbacks may replace the document. Revalidate before rollback.
    if (!ownsDocument()) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return false }
    if (!this.state.doc.pages.some(value => value.id === page)) { action.result(ActionOutcome.blocked, ActionReason.noTarget); return false }
    this.cancel()
    // Cancellation publishes synchronously; a subscriber can adopt a new session
    // or remove the target. Never carry the old navigation across that boundary.
    if (!ownsDocument() || !this.state.doc.pages.some(value => value.id === page)) { action.result(ActionOutcome.cancelled, ActionReason.superseded); return false }
    this.repeatedDuplicate = null
    this.set({ page, selection: [], editingVertex: null })
    return ownsDocument() && this.state.page === page
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  renamePage(name: string) {
    const action = beginEditorAction(this, CanvasAction.page, ActionSource.unknown, 215)
    try {
    if (name.trim())
      this.change('重命名页面', (d) => {
        d.pages.find((p) => p.id === this.state.page)!.name = name.trim()
      })
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  group(mask = false, booleanOperation?: BooleanOp, kind: 'group' | 'frame' = 'group') {
    const action = beginEditorAction(this, CanvasAction.group, ActionSource.unknown, 220)
    try {
      if (this.state.busy || this.interactionActive || !commitPendingEdits(this)) return
      if (!this.state.selection.length) return
      const base = this.state.doc, session = this.sessionGeneration, revision = this.state.version
      if (booleanOperation) {
        const plan = prepareBooleanCreate(base, this.state.selection, { operation: booleanOperation }, { fresh: true }, 'existing-fill')
        if (mask && plan.wrap.ids.length < 2) throw new SelectionCommandError('invalid_params', 'Mask grouping requires at least two nodes')
        return this.change(mask ? '创建蒙版' : kind === 'frame' ? '创建选区画板' : '编组', draft => {
          if (this.state.doc !== base || this.sessionGeneration !== session || this.state.version !== revision)
            throw new SelectionCommandError('superseded', 'Selection owner changed before boolean grouping')
          if (mask) draft.nodes[plan.wrap.ids[0]].mask = true
          applyBooleanCreate(draft, plan)
        }, [plan.wrapper.id])
      }
      const plan = prepareSelectionWrap(base, this.state.selection, { fresh: true })
      if (mask && plan.ids.length < 2) throw new SelectionCommandError('invalid_params', 'Mask grouping requires at least two nodes')
      const group = node(kind, 0, 0, plan.width, plan.height)
      configureSelectionWrapper(group, plan)
      group.name = mask ? '蒙版组' : kind === 'frame' ? '画板' : '编组'
      return this.change(mask ? '创建蒙版' : kind === 'frame' ? '创建选区画板' : '编组', draft => {
        if (this.state.doc !== base || this.sessionGeneration !== session || this.state.version !== revision)
          throw new SelectionCommandError('superseded', 'Selection owner changed before grouping')
        if (mask) draft.nodes[plan.ids[0]].mask = true
        applySelectionWrap(draft, plan, group)
      }, [group.id])
    } catch (error) {
      action.result(ActionOutcome.rejected, ActionReason.validation)
      if (error instanceof SelectionCommandError) { this.notify(error.message); return { status: 'rejected' as const, code: error.code, revision: this.state.version } }
      throw error
    } finally { action.finish() }
  }
  ungroup() {
    const action = beginEditorAction(this, CanvasAction.ungroup, ActionSource.unknown, 221)
    try {
      if (this.state.busy || this.interactionActive || !commitPendingEdits(this)) return
      if (!this.state.selection.length) return
      const base = this.state.doc, session = this.sessionGeneration, revision = this.state.version
      const plan = prepareSelectionUnwrap(base, this.state.selection, { fresh: true }), selection = plan.entries.flatMap(entry => entry.children)
      return this.change('解除编组', draft => {
        if (this.state.doc !== base || this.sessionGeneration !== session || this.state.version !== revision)
          throw new SelectionCommandError('superseded', 'Selection owner changed before ungrouping')
        applySelectionUnwrap(draft, plan)
      }, selection)
    } catch (error) {
      action.result(ActionOutcome.rejected, ActionReason.validation)
      if (error instanceof SelectionCommandError) { this.notify(error.message); return { status: 'rejected' as const, code: error.code, revision: this.state.version } }
      throw error
    } finally { action.finish() }
  }
  reparent(id: string, parent: string, before?: string) { this.reparentMany([id], parent, before) }
  reparentMany(ids: string[], parent: string, before?: string) {
    const action = beginEditorAction(this, CanvasAction.layer, ActionSource.unknown, 222)
    try {
    ids = [...new Set(ids)]
    const d = this.state.doc, parents = allParents(d), selected = new Set(ids)
    const roots = ids.filter(id => {
      if (!d.nodes[id] || d.nodes[id].locked) return false
      let p = parents.get(id)
      while (p) { if (selected.has(p) || d.nodes[p]?.locked) return false; p = parents.get(p) }
      return true
    })
    if (!roots.length || (d.nodes[parent] ? !container(d.nodes[parent]) || d.nodes[parent].locked : !d.pages.some(p => p.id === parent))) return
    let ancestor: string | undefined = parent
    while (ancestor) {
      if (roots.includes(ancestor)) { this.notify('不能将图层放入自身的后代'); return }
      ancestor = parents.get(ancestor)
    }
    const transforms = new Map(roots.map(id => [id, worldMatrix(d, id)])), pm = inverse(worldMatrix(d, parent))
    this.change('移动图层层级', next => {
      for (const id of roots) {
        const old = parents.get(id)!
        const list = next.nodes[old]?.children || next.pages.find(p => p.id === old)!.children
        list.splice(list.indexOf(id), 1)
      }
      const list = next.nodes[parent]?.children || next.pages.find(p => p.id === parent)!.children
      const at = before ? list.indexOf(before) : -1
      list.splice(at < 0 ? list.length : at, 0, ...roots)
      for (const id of roots) {
        next.nodes[id].transform = multiply(pm, transforms.get(id)!)
        if (next.nodes[id].constraints) next.nodes[id].constraints = { ...next.nodes[id].constraints!, referenceWidth: null, referenceHeight: null }
      }
    }, roots)
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  reorder(direction: 'front' | 'back' | 'forward' | 'backward') {
    const action = beginEditorAction(this, CanvasAction.layer, ActionSource.unknown, 223)
    try {
    const ids = this.topSelection()
    this.change('调整图层顺序', (d) => {
      const parents = allParents(d)
      for (const parent of new Set(ids.map((id) => parents.get(id)!))) {
        const list = d.nodes[parent]?.children || d.pages.find((p) => p.id === parent)!.children
        const selected = list.filter((id) => ids.includes(id))
        if (direction === 'front' || direction === 'back') {
          const other = list.filter((id) => !ids.includes(id))
          list.splice(
            0,
            list.length,
            ...(direction === 'front' ? [...other, ...selected] : [...selected, ...other]),
          )
        } else {
          const order = direction === 'forward' ? [...list].reverse() : [...list]
          for (const id of order.filter((id) => ids.includes(id))) {
            const i = list.indexOf(id),
              j = i + (direction === 'forward' ? 1 : -1)
            if (j >= 0 && j < list.length && !ids.includes(list[j]))
              [list[i], list[j]] = [list[j], list[i]]
          }
        }
      }
    })
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  private copyGraph(roots: string[], source = this.state.doc): GraphCopy {
    const nodes: Record<string, DesignNode> = {}
    const visit = (id: string) => {
      nodes[id] = cloneValue(source.nodes[id])
      nodes[id].children.forEach(visit)
    }
    roots.forEach(visit)
    roots.forEach((id) => {
      nodes[id].transform = worldMatrix(source, id)
    })
    for (const root of roots) {
      const original = nodes[root],
        origin = original.instanceOrigin
      if (!origin) continue
      if (original.instance) {
        // A generated nested root includes template/override modes. On lifting
        // it to an authored root retain only its source placement selections;
        // the instance specification and lifted overrides supply the defaults.
        original.variableModes = cloneValue(source.nodes[origin.source]?.variableModes)
        if (!original.variableModes) delete original.variableModes
        const outer = source.nodes[origin.owner].instance!
        for (const [k, v] of Object.entries(outer.overrides))
          if (k === origin.key || k.startsWith(origin.key + '/'))
            original.instance.overrides[
              k === origin.key ? '$root' : k.slice(origin.key.length + 1)
            ] = {
              ...original.instance.overrides[
                k === origin.key ? '$root' : k.slice(origin.key.length + 1)
              ],
              ...cloneValue(v),
            }
        delete original.instanceOrigin
        for (const n of Object.values(nodes))
          if (
            n.instanceOrigin?.owner === origin.owner &&
            n.instanceOrigin.key.startsWith(origin.key + '/')
          )
            n.instanceOrigin = {
              ...n.instanceOrigin,
              owner: root,
              key: n.instanceOrigin.key.slice(origin.key.length + 1),
            }
      } else {
        const clear = (id: string) => {
          const n = nodes[id]
          delete n.instanceOrigin
          delete n.instance
          delete n.componentKey
          n.children.forEach(clear)
        }
        clear(root)
      }
    }
    return { nodes, roots, document: source }
  }
  copy() {
    if (!this.settleOwnedPropertyPreview('export')) return
    const graph = this.copyGraph(this.topSelection(true)), parents=allParents(graph.document)
    const placements=Object.fromEntries(graph.roots.map(id=> {
      const n=graph.document.nodes[id],parent=graph.document.nodes[parents.get(id)!]
      const b=bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(p=>apply(n.transform,p)))
      return [id,{transform:cloneValue(n.transform),outsideX:!!parent&&(b.x<0||b.x+b.width>parent.width),outsideY:!!parent&&(b.y<0||b.y+b.height>parent.height)}]
    }))
    this.clipboard = { ...graph, placements, sourceSession: this.sessionEpoch }
    this.duplicateOffset = 24
    this.notify('已复制图层')
  }
  exportClipboard(cut = false): string | null {
    if (!this.settleOwnedPropertyPreview('export')) return null
    if (cut && this.topSelection(true).some(id => !this.topSelection().includes(id)))
      throw new Error('锁定图层可复制；剪切前请先解锁')
    this.copy()
    const content = this.clipboard
    if (!content?.roots.length) return null
    const semantics = captureClipboardSemantics(content.document, Object.values(content.nodes), content.roots, { cut })
    // Export selected nodes plus reachable component/font/style dependencies,
    // never unrelated pages or the whole source document to the OS clipboard.
    const document = blank('剪贴板')
    document.schemaVersion = content.document.schemaVersion
    document.colorManagement = cloneValue(content.document.colorManagement)
    document.rasterProfile = content.document.rasterProfile
    const ids = new Map(Object.keys(content.nodes).map(id => [id, id]))
    const dependencies = Components.importClipboardDependencies(document, content.document, clipboardDependencyNodes(Object.values(content.nodes), semantics), ids)
    for (const [id, original] of Object.entries(content.nodes)) {
      const n = cloneValue(original)
      Components.remapReferences(n, dependencies.nodeIds, content.document)
      remapDesignDependencies(n, dependencies.designSystem)
      document.nodes[id] = n
    }
    document.pages[0].children = [...content.roots]
    const exportedRoots = applyClipboardSemantics(document, content.document, content.roots, dependencies.nodeIds, dependencies.designSystem, semantics, document.pages[0].id, 0)
    try {
      const prepared = prepareDocumentForEditing(document)
      return JSON.stringify({ format: 'forma-nodes', version: 1, document: prepared, roots: content.roots.map(id => exportedRoots.get(id)!), selection: content.roots, placements: Object.fromEntries(content.roots.map(id=>[exportedRoots.get(id)!,{...content.placements?.[id],transform:exportedRoots.get(id)===id?content.placements?.[id]?.transform:identity()}])) })
    } finally { activateDocumentFonts(this.state.doc) }
  }
  importClipboard(source: string) {
    if (new TextEncoder().encode(source).byteLength > 32 * 1024 * 1024) throw new Error('剪贴板超过 32 MiB')
    const value = JSON.parse(source)
    if (value?.format !== 'forma-nodes' || value.version !== 1 || !Array.isArray(value.roots) ||
        !value.roots.length || value.roots.some((id: unknown) => typeof id !== 'string')) throw new Error('不支持的图层剪贴板')
    try {
      const document = prepareDocumentForEditing(value.document)
      const roots = [...new Set(value.roots as string[])]
      if (roots.some(id => !document.pages.some(p => p.children.includes(id)))) throw new Error('剪贴板根图层无效')
      const nodes: Record<string, DesignNode> = {}
      const visit = (id: string) => { nodes[id] = cloneValue(document.nodes[id]); nodes[id].children.forEach(visit) }
      roots.forEach(visit)
      if (value.selection !== undefined && (!Array.isArray(value.selection) || !value.selection.length || value.selection.some((id: unknown) => typeof id !== 'string' || !nodes[id]))) throw new Error('剪贴板选择图层无效')
      let placements: Record<string, { transform: Matrix; outsideX: boolean; outsideY: boolean }> | undefined
      if (value.placements !== undefined) {
        if (!value.placements || typeof value.placements!=='object' || Array.isArray(value.placements) || Object.keys(value.placements).some(id=>!roots.includes(id))) throw new Error('剪贴板位置无效')
        for (const placement of Object.values(value.placements) as any[]) {
          if(!placement || !Array.isArray(placement.transform) || placement.transform.length!==6 || placement.transform.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>1e7) ||
            typeof placement.outsideX!=='boolean' || typeof placement.outsideY!=='boolean') throw new Error('剪贴板位置无效')
          inverse(placement.transform)
        }
        placements=cloneValue(value.placements)
      }
      this.clipboard = { nodes, roots, document, placements, selection: value.selection ? [...new Set(value.selection as string[])] : undefined }
      this.duplicateOffset = 24
    } finally { activateDocumentFonts(this.state.doc) }
  }
  pasteToSelection(replace = false) {
    const action = beginEditorAction(this, CanvasAction.paste, ActionSource.unknown, 225)
    try {
    if (!this.clipboard || this.interactionActive) return
    const content=this.clipboard, before=this.state.doc, parents=allParents(before), selected=this.topSelection()
    if(this.topSelection(true).length!==selected.length) {this.notify('粘贴目标包含锁定图层，请先解锁');return}
    const targets=replace?selected:selected.length && selected.every(id=>container(before.nodes[id]) && !content.roots.includes(id)) ? selected
      : selected.length===1 && before.nodes[parents.get(selected[0])!]? [parents.get(selected[0])!] : []
    if(!targets.length){if(replace)this.notify('请选择要替换的图层');else this.paste(true);return}
    for(const target of targets) {
      for(let id:string|undefined=target;id && before.nodes[id];id=parents.get(id)) {
        const n=before.nodes[id]
        if(n.locked || n.instanceOrigin || (n.instance && (!replace || id!==target))){this.notify('不能向锁定图层或组件实例内部粘贴新结构');return}
      }
    }
    if(replace) {
      const removed:DesignNode[]=[]
      const visit=(id:string)=>{removed.push(before.nodes[id]);before.nodes[id].children.forEach(visit)}
      targets.forEach(visit)
      try{captureClipboardSemantics(before,removed,targets,{cut:true})}catch(error){this.notify(String(error));return}
    }
    this.begin(replace?'粘贴替换':'粘贴到选中容器')
    const selection:string[]=[]
    try {
      for(const target of targets) {
        const page=this.state.doc.pages.find(p=>p.id===this.state.page)!,existing=new Set(page.children)
        this.paste(true)
        const roots=this.state.doc.pages.find(p=>p.id===this.state.page)!.children.filter(id=>!existing.has(id))
        if(!roots.length)throw new Error(this.state.message || '未能粘贴图层')
        const destination=replace?parents.get(target)!:target,box=before.nodes[target]
        this.change('放置粘贴图层',d=> {
          const currentPage=d.pages.find(p=>p.id===this.state.page)!
          currentPage.children=currentPage.children.filter(id=>!roots.includes(id))
          const list=d.nodes[destination]?.children || d.pages.find(p=>p.id===destination)!.children
          const at=replace?list.indexOf(target):-1
          list.splice(at<0?list.length:at,0,...roots)
          for(const [i,id] of roots.entries()) {
            const source=content.roots[i],placement=content.placements?.[source]
            if(placement)d.nodes[id].transform=cloneValue(placement.transform)
          }
          const measure=(id:string,parent:Matrix): import('./model').Bounds => {
            const n=d.nodes[id],matrix=multiply(parent,n.transform)
            if(n.kind==='group' && n.children.length) return unionBounds(n.children.map(id=>measure(id,matrix)))
            return (n.network?kernelBounds(n,matrix):null) || bounds(boxPoints({x:0,y:0,width:n.width,height:n.height}).map(p=>apply(matrix,p)))
          }
          const localBounds=unionBounds(roots.map(id=>measure(id,identity())))
          const targetBounds=replace?bounds(boxPoints({x:0,y:0,width:box.width,height:box.height}).map(p=>apply(box.transform,p))):null
          const outsideX=content.roots.some(id=>content.placements?.[id]?.outsideX),outsideY=content.roots.some(id=>content.placements?.[id]?.outsideY)
          const dx=targetBounds?targetBounds.x-localBounds.x:!outsideX&&(localBounds.x<0||localBounds.x+localBounds.width>box.width)?(box.width-localBounds.width)/2-localBounds.x:0
          const dy=targetBounds?targetBounds.y-localBounds.y:!outsideY&&(localBounds.y<0||localBounds.y+localBounds.height>box.height)?(box.height-localBounds.height)/2-localBounds.y:0
          for(const id of roots) {
            const n=d.nodes[id];n.transform[4]+=dx;n.transform[5]+=dy
            if(replace){n.constraints=cloneValue(box.constraints);n.sizing=cloneValue(box.sizing)}
          }
        },roots)
        if(!roots.every(id=>allParents(this.state.doc).get(id)===destination))throw new Error(this.state.message)
        selection.push(...roots)
      }
      if(replace){this.select(targets);this.remove();if(targets.some(id=>this.state.doc.nodes[id]))throw new Error('替换目标无法删除')}
      this.select(selection);this.commit()
    } catch(error){this.cancel();this.notify(error instanceof Error?error.message:String(error))}
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  appendDocument(source: DesignDocument) {
    const action = beginEditorAction(this, CanvasAction.import, ActionSource.unknown, 227)
    try {
    if (this.interactionActive) throw new Error('请结束当前操作后追加导入')
    const prepared = prepareDocumentForEditing(source)
    let roots: string[] = []
    this.change('追加导入文件', draft => { roots = appendDocument(draft, prepared, this.state.page) })
    if (!roots.length || roots.some(id => !this.state.doc.nodes[id])) throw new Error(this.state.message || '追加导入失败')
    this.select(roots)
    return roots
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  paste(inPlace = false, position?: Point) {
    const action = beginEditorAction(this, CanvasAction.paste, ActionSource.unknown, 226)
    try {
    if (!this.clipboard) return
    if (position && (!Number.isFinite(position.x) || !Number.isFinite(position.y))) {
      this.notify('粘贴位置无效'); return
    }
    const content = this.clipboard
    const offset = inPlace ? 0 : this.duplicateOffset
    let delta = { x: offset, y: offset }
    if (position) {
      // Copied roots already carry world transforms, and imported roots are
      // page children. Use the same transformed geometry bounds as selection.
      const box = unionBounds(content.roots.map((id) => {
        const n = content.nodes[id]
        return (n.network ? kernelBounds(n, n.transform) : null) ||
          bounds(boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).map((point) => apply(n.transform, point)))
      }))
      delta = { x: position.x - box.x, y: position.y - box.y }
    }
    const internal = content.sourceSession === this.sessionEpoch && content.document.id === this.state.doc.id
    let semantics: ReturnType<typeof captureClipboardSemantics>
    try { semantics = captureClipboardSemantics(content.document, Object.values(content.nodes), content.roots, { external: !internal }) }
    catch (error) { this.notify(error instanceof Error ? error.message : String(error)); return }
    if (content.roots.length === 1 && content.nodes[content.roots[0]].component && !hasClipboardSemantics(semantics)) {
      const source = content.nodes[content.roots[0]]
      let created = ''
      this.change('粘贴组件实例', (d) => {
        const componentId = Components.importDefinitions(d, content.document, source.id)
        created = Components.insertInstance(d, componentId, this.state.page, {
          x: source.transform[4] + delta.x,
          y: source.transform[5] + delta.y,
        })
        if (position) d.nodes[created].transform = multiply(translate(delta.x, delta.y), source.transform)
      })
      if (this.state.doc.nodes[created]?.instance) this.select([created])
      if (!inPlace && !position) this.duplicateOffset += 24
      return
    }
    const ids = new Map(Object.keys(content.nodes).map((id) => [id, uid()]))
    const roots = content.roots.map((id) => ids.get(id)!)
    this.change(
      '粘贴图层',
      (d) => {
        const dependencies = Components.importClipboardDependencies(
          d,
          content.document,
          clipboardDependencyNodes(Object.values(content.nodes), semantics),
          ids,
        )
        for (const [id, source] of Object.entries(content.nodes)) {
          const n = cloneValue(source)
          Components.remapReferences(n, dependencies.nodeIds, content.document)
          remapDesignDependencies(n, dependencies.designSystem)
          if (n.instanceOrigin && source.instanceOrigin)
            n.instanceOrigin.owner = ids.get(source.instanceOrigin.owner) || n.instanceOrigin.owner
          n.id = ids.get(id)!
          n.children = n.children.map((c) => ids.get(c)!)
          if (content.roots.includes(id))
            n.transform = multiply(
              translate(delta.x, delta.y),
              n.transform,
            )
          d.nodes[n.id] = n
        }
        d.pages.find((p) => p.id === this.state.page)!.children.push(...roots)
        applyClipboardSemantics(d, content.document, content.roots, dependencies.nodeIds, dependencies.designSystem, semantics, this.state.page, delta, { internal })
      },
      content.selection?.map(id => ids.get(id)!) || roots,
    )
    if (!inPlace && !position) this.duplicateOffset += 24
    } catch (error) { action.result(ActionOutcome.rejected, ActionReason.validation); throw error }
    finally { action.finish() }
  }
  /** Re-evaluate Option during a move without publishing intermediate history. */
  moveDuplication(enabled: boolean, originals: string[]): string[] {
    const transaction = this.transaction
    if (!transaction) return originals
    if (enabled && !transaction.copy) {
      const content = this.copyGraph(originals, transaction.doc)
      let roots: string[] = []
      const flowSizing = new Map<string, DesignNode['sizing']>()
      const document = produceDraft(transaction.doc, draft => {
        roots = duplicateGraph(draft as DesignDocument, content, { wrapAnimated: true }).roots
        const parents = allParents(draft as DesignDocument)
        for (const id of roots) {
          const n = draft.nodes[id], parent = draft.nodes[parents.get(id)!]
          if (parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute) {
            flowSizing.set(id, cloneValue(n.sizing))
            // Keep the source flow stationary while its copy follows the
            // pointer. Restore the original sizing policy on release.
            n.sizing = { ...defaultSizing(), ...n.sizing, absolute: true, width: 'fixed', height: 'fixed' }
          }
        }
      })
      transaction.copy = { document: kernelLayout(document), roots, originals: [...originals], flowSizing }
    }
    transaction.flow = undefined
    transaction.dropIndex = undefined
    transaction.placementSizing = undefined
    transaction.previewBase = enabled ? transaction.copy!.document : undefined
    const roots = enabled ? transaction.copy!.roots : originals
    this.set({ doc: transaction.previewBase || transaction.doc, selection: [...roots] })
    return roots
  }
  previewFreeMove(ids: string[], free: boolean) {
    const transaction = this.transaction
    if (!transaction) return
    if (!free && transaction.flow) {
      transaction.previewBase = transaction.flow.base
      transaction.flow = undefined
      this.set({ doc: transaction.previewBase }); return
    }
    if (!free || transaction.flow) return
    const base = transaction.previewBase || transaction.doc, parents = (transaction.dropIndex ??= createCanvasDropIndex(base,this.state.page)).parents
    // Read-only eligibility must precede the Immer draft. Merely reading
    // draft.nodes prepares a shallow copy of the entire node dictionary,
    // even when a free-frame drag has no flow sizing to change.
    const eligible=ids.filter(id=>{
      const n=base.nodes[id],parent=base.nodes[parents.get(id)!]
      return parent?.layout&&parent.layout.mode!=='none'&&!n.sizing?.absolute
    })
    if(!eligible.length)return
    const sizing = new Map<string, DesignNode['sizing']>()
    const document = produceDraft(base, draft => {
      for (const id of eligible) {
        const n = draft.nodes[id], parent = draft.nodes[parents.get(id)!]
        if (parent?.layout && parent.layout.mode !== 'none' && !n.sizing?.absolute) {
          sizing.set(id, cloneValue(n.sizing))
          n.sizing = { ...defaultSizing(), ...n.sizing, absolute: true, width: 'fixed', height: 'fixed' }
        }
      }
    })
    if (!sizing.size) return
    transaction.flow = { base, sizing }
    transaction.previewBase = kernelLayout(document)
    this.set({ doc: transaction.previewBase })
  }
  previewMoveParent(ids: string[], point: Point, force = false, preserveParent = false) {
    const next=this.movePreviewDocument(this.state.doc,ids,point,force,preserveParent)
    if(next!==this.state.doc)this.set({doc:kernelLayout(next)})
  }
  /** Retained pixels cannot represent a changed clipping/parent boundary.
   * Query the transaction's original hierarchy, like previewCore does, without
   * constructing or laying out a document on every compositor-only sample. */
  canvasMovePreservesParents(ids: string[], point: Point, force = false, preserveParent = false): boolean {
    const tx=this.transaction
    if(!tx)return true
    const base=tx.previewBase||tx.doc,index=tx.dropIndex??=createCanvasDropIndex(base,this.state.page)
    return this.movePlacement(base,ids,point,force,preserveParent,index).moving.length===0
  }
  /** Read-only projection for a move query, never published, serialized or
   * admitted as a document. The fixed gesture index supplies complete topology. */
  private moveQuery(base:DesignDocument,patches:Record<string,Partial<DesignNode>>,ids:readonly string[]){
    if(ids.length>1)return {...base,nodes:{...base.nodes,...Object.fromEntries(Object.entries(patches).map(([id,p])=>[id,{...base.nodes[id],...p}]))}}
    const nodes=Object.create(base.nodes) as DesignDocument['nodes']
    for(const [id,patch] of Object.entries(patches))Object.defineProperty(nodes,id,{value:{...base.nodes[id],...patch},enumerable:true})
    return {...base,nodes}
  }
  private cachedMovePreview(patches:Record<string,Partial<DesignNode>>,move:{ids:string[];point:Point;force:boolean;preserveParent:boolean}){
    const tx=this.transaction,cache=tx?.movePreview,source=tx?.previewBase||tx?.doc
    if(!tx||!cache||source!==cache.source||cache.published!==this.state.doc||tx.page!==this.state.page||
        cache.epoch!==pickingGeometryEpoch()||tx.copy||tx.flow||move.ids.length!==1||
        Object.keys(patches).length!==move.ids.length||move.ids.some(id=>!source.nodes[id]||!patches[id]?.transform||Object.keys(patches[id]).some(key=>key!=='transform')))return
    const index=tx.dropIndex??=createCanvasDropIndex(source,this.state.page),query=this.moveQuery(source,patches,move.ids)
    const plan=this.movePlacement(query,move.ids,move.point,move.force,move.preserveParent,index)
    if(plan.key!==cache.key)return
    const poses:Record<string,Partial<DesignNode>>={}
    for(const id of move.ids){
      // Preserve the original inverse/parent/world multiplication order from
      // movePreviewDocument. Do not algebraically cancel matrices or use the
      // last pointer sample as the next base.
      const transform=plan.moving.includes(id)?multiply(inverse(worldMatrix(cache.document,cache.parents.get(id)!,cache.parents)),worldMatrix(query,id,index.parents)):patches[id].transform!
      poses[id]={transform}
    }
    if(!cache.translation.accepts(poses))return
    return {patches:poses}
  }
  canvasMovePreview(patches:Record<string,Partial<DesignNode>>,move:{ids:string[];point:Point;force:boolean;preserveParent:boolean}){
    const cached=this.cachedMovePreview(patches,move)
    if(cached)return {patches:cached.patches,retainsParents:true}
    const tx=this.transaction;if(!tx)return {patches,retainsParents:true}
    const base=tx.previewBase||tx.doc,index=tx.dropIndex??=createCanvasDropIndex(base,this.state.page)
    const plan=this.movePlacement(this.moveQuery(base,patches,move.ids),move.ids,move.point,move.force,move.preserveParent,index)
    const current=this.parentMap()
    const retainsParents=plan.moving.length===0&&move.ids.every(id=>current.get(id)===index.parents.get(id))
    if(retainsParents&&base===this.state.doc&&!tx.copy&&!tx.flow&&move.ids.length===1){
      // GPU-only movement has not published a preview document yet. Seed the
      // same validated translation plan from the already resolved source so
      // pointer-up need not resolve every component/layout island again.
      const translation=new TranslationPreviewPlan(base,move.ids)
      if(translation.accepts(patches))tx.movePreview={source:base,document:base,published:base,key:plan.key,
        parents:current,epoch:pickingGeometryEpoch(),translation}
    }
    return {patches,retainsParents}
  }
  private movePlacement(source:DesignDocument,ids:string[],point:Point,force:boolean,preserveParent:boolean,index?:CanvasDropIndex){
    const tx=this.transaction
    index??=tx?(tx.dropIndex??=createCanvasDropIndex(tx.previewBase||tx.doc,this.state.page)):createCanvasDropIndex(source,this.state.page)
    const parents=index.parents
    const retained=tx&&!preserveParent?this.retainContainedMoveParents(source,ids,point,force):null
    const frame=tx&&!preserveParent&&!retained?canvasDropFrame(source,this.state.page,ids,point,force,index):undefined,target=frame||this.state.page
    let moving=tx&&!preserveParent&&!retained?ids.filter(id=>!canvasMoveKeepsContainer(source,id,force,parents)&&(frame?containingFrame(source,id,parents)!==frame:!!containingFrame(source,id,parents))&&parents.get(id)!==target):[]
    const animated=new Set(source.animations?.flatMap(c=>c.tracks.map(t=>t.nodeId))||[])
    if(moving.some(id=>{for(let at:string|undefined=id;at&&source.nodes[at];at=parents.get(at))if(animated.has(at)||source.nodes[at].instanceOrigin||(at!==id&&source.nodes[at].instance))return true;return false}))moving=[]
    return {parents,target,moving,retained,key:JSON.stringify(ids.map(id=>[id,moving.includes(id)?target:parents.get(id)]))}
  }
  /** Narrow observed contract: separate free-frame leaves that remain wholly in
   * their own original frames must not all adopt the frame under one pointer.
   * Other placement intents (including groups, overlap and auto layout) retain
   * the existing drop path. A null result means this exception is inapplicable. */
  private retainContainedMoveParents(source: DesignDocument, ids: string[], point: Point, force: boolean): DesignDocument | null {
    const tx = this.transaction
    if (!tx || force || tx.copy || ids.length < 2 || source.id !== tx.doc.id || this.state.page !== tx.page) return null
    const original = allParents(tx.doc), current = allParents(source), roots = new Set(ids)
    if (roots.size !== ids.length) return null
    const frames = new Set<string>(), worlds = new Map<string, Matrix>()
    const animated = new Set(source.animations?.flatMap(clip => clip.tracks.map(track => track.nodeId)) || [])
    for (const id of ids) {
      const n = source.nodes[id], before = tx.doc.nodes[id], parent = original.get(id)
      const frame = parent && source.nodes[parent]
      if (!n || !before || container(n) || n.children.length || !frame || frame.kind !== 'frame' ||
          original.get(frame.id) !== tx.page || current.get(frame.id) !== tx.page || roots.has(frame.id) ||
          (frame.layout && frame.layout.mode !== 'none') || frame.instance || frame.instanceOrigin ||
          n.instance || n.instanceOrigin || animated.has(id) || animated.has(frame.id) ||
          !interactivePath(source, tx.page, id, false, current).length ||
          !interactivePath(source, tx.page, frame.id, false, current).length) return null
      const world = worldMatrix(source, id, current), frameWorld = worldMatrix(source, frame.id, current)
      const local = multiply(inverse(frameWorld), world)
      // Absolute local-coordinate tolerance only absorbs affine roundoff; it is
      // not a center-only hit test or a screen-pixel containment expansion.
      const epsilon = 1e-7
      if (boxPoints({ x: 0, y: 0, width: n.width, height: n.height }).some(corner => {
        const p = apply(local, corner)
        return !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -epsilon || p.y < -epsilon ||
          p.x > frame.width + epsilon || p.y > frame.height + epsilon
      })) return null
      frames.add(frame.id); worlds.set(id, world)
    }
    if (frames.size < 2) return null
    const boxes = [...frames].map(id => {
      const frame = source.nodes[id], world = worldMatrix(source, id, current)
      return bounds(boxPoints({ x: 0, y: 0, width: frame.width, height: frame.height }).map(p => apply(world, p)))
    })
    // Conservative AABB separation deliberately leaves rotated-overlap intent
    // undecided, even where the exact frame polygons might be disjoint.
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return null
    }
    const target = canvasDropFrame(source, tx.page, ids, point)
    if (!target || !frames.has(target)) return null
    const moving = ids.filter(id => current.get(id) !== original.get(id))
    if (!moving.length) return source
    // A caller may supply a visible reparented preview. Restore the transaction's
    // original membership, not that transient parent map, while keeping world pose.
    return produceDraft(source, draft => {
      for (const id of moving) {
        const parent = current.get(id)!, list = draft.nodes[parent]?.children || draft.pages.find(p => p.id === parent)!.children
        list.splice(list.indexOf(id), 1)
      }
      for (const frameId of frames) {
        const order = tx.doc.nodes[frameId].children, list = draft.nodes[frameId].children
        for (const id of order.filter(id => moving.includes(id))) {
          const following = order.slice(order.indexOf(id) + 1).find(sibling => list.includes(sibling))
          list.splice(following === undefined ? list.length : list.indexOf(following), 0, id)
          draft.nodes[id].transform = multiply(inverse(worldMatrix(source, frameId, current)), worlds.get(id)!)
          const constraints = tx.doc.nodes[id].constraints
          if (constraints && draft.nodes[id].constraints) draft.nodes[id].constraints = {
            ...draft.nodes[id].constraints!, referenceWidth: constraints.referenceWidth, referenceHeight: constraints.referenceHeight,
          }
        }
      }
    })
  }
  private movePreviewDocument(source: DesignDocument, ids: string[], point: Point, force: boolean, preserveParent: boolean): DesignDocument {
    const tx=this.transaction
    if(!tx || preserveParent)return source
    const plan=this.movePlacement(source,ids,point,force,preserveParent)
    const retained = plan.retained
    if (retained) return retained
    const {parents,target,moving}=plan
    if(!moving.length)return source
    const worlds=new Map(moving.map(id=>[id,worldMatrix(source,id,parents)])),basis=inverse(worldMatrix(source,target,parents))
    const next=produceDraft(source,d=> {
      for(const id of moving) {
        const old=parents.get(id)!,list=d.nodes[old]?.children || d.pages.find(p=>p.id===old)!.children
        list.splice(list.indexOf(id),1)
        const destination=d.nodes[target]?.children || d.pages.find(p=>p.id===target)!.children
        destination.push(id);d.nodes[id].transform=multiply(basis,worlds.get(id)!)
        if(d.nodes[id].constraints)d.nodes[id].constraints={...d.nodes[id].constraints!,referenceWidth:null,referenceHeight:null}
        if(d.nodes[target]?.layout && d.nodes[target].layout!.mode!=='none') {
          tx.placementSizing??=new Map()
          if(!tx.placementSizing.has(id))tx.placementSizing.set(id,cloneValue(d.nodes[id].sizing))
          d.nodes[id].sizing={...defaultSizing(),...d.nodes[id].sizing,absolute:true,width:'fixed',height:'fixed'}
        }
      }
    })
    // The next pointer sample starts again from previewBase. Only this visible
    // draft is reparented, keeping matrices independent of pointer event count.
    return next
  }
  finishCanvasMove(point: Point, force = false, absolute = false, preserveParent = false) {
    const transaction = this.transaction
    if (!transaction) return
    const roots = this.topSelection(), session = this.sessionGeneration, page = this.state.page
    const retained = preserveParent ? null : this.retainContainedMoveParents(this.state.doc, roots, point, force)
    if (retained && retained !== this.state.doc) {
      this.set({ doc: retained })
      // Publication can synchronously load another document or start a new
      // gesture. Never feed this old drop point into that owner's layout/order.
      if (this.transaction !== transaction || this.sessionGeneration !== session ||
          this.state.page !== page || this.state.doc !== retained) return
    }
    const doc = this.state.doc, parents = this.parentMap(doc)
    // Canvas flushes the release pose through preview before finishing. Commit
    // that exact placement, rather than hit-testing its already reparented tree
    // again (layout can resize targets and change which overlapping frame wins).
    const receipt=transaction.placement
    const previewed=receipt?.document===doc&&receipt.force===force&&receipt.preserveParent===preserveParent&&
      receipt.point.x===point.x&&receipt.point.y===point.y&&receipt.ids.length===roots.length&&
      receipt.ids.every((id,i)=>id===roots[i])
    const frame = previewed ? undefined : canvasDropFrame(doc, this.state.page, roots, point, force)
    const target = frame || this.state.page
    const relocating = previewed || preserveParent || retained ? [] : roots.filter(id => {
      const currentFrame = containingFrame(doc,id,parents)
      return !canvasMoveKeepsContainer(doc,id,force,parents)&&
        (frame ? currentFrame !== frame : !!currentFrame) && parents.get(id) !== target
    })
    const originalParents=transaction.dropIndex?.parents||allParents(transaction.previewBase||transaction.doc)
    const placed=previewed?roots.filter(id=>originalParents.get(id)!==parents.get(id)):relocating
    const animated = new Set(doc.animations?.flatMap(c=>c.tracks.map(t=>t.nodeId)) || [])
    const blocked = relocating.some(id => {
      for (let at: string|undefined=id;at && doc.nodes[at];at=parents.get(at))
        if (animated.has(at) || doc.nodes[at].instanceOrigin || (at!==id && doc.nodes[at].instance)) return true
      return false
    })
    if (!blocked && relocating.length) this.reparentMany(relocating,target)
    const restore = new Map([...(transaction.placementSizing || []), ...(transaction.flow?.sizing || []), ...(transaction.copy?.flowSizing || [])])
    if (restore.size || (absolute && placed.length)) this.change('完成图层放置', draft=> {
      for (const [id,sizing] of restore) if (draft.nodes[id]) {
        if (sizing) draft.nodes[id].sizing=cloneValue(sizing);else delete draft.nodes[id].sizing
      }
      if (absolute) for (const id of placed) draft.nodes[id].sizing={...defaultSizing(),...draft.nodes[id].sizing,absolute:true}
    })
    transaction.previewBase = this.state.doc
    transaction.flow = undefined
    transaction.placementSizing = undefined
    for (const id of [...roots].reverse()) {
      this.previewLayoutOrder(id,point)
      transaction.previewBase = this.state.doc
    }
    return blocked ? '动画或实例内部图层的层级已保留；请选择完整的动画容器或实例移动' : undefined
  }
  finishMoveDuplication(point: Point) {
    const transaction = this.transaction, copy = transaction?.copy
    if (!transaction || !copy?.flowSizing.size) return
    const document = produceDraft(this.state.doc, draft => {
      for (const [id, sizing] of copy.flowSizing) {
        if (sizing) draft.nodes[id].sizing = cloneValue(sizing)
        else delete draft.nodes[id].sizing
      }
    })
    transaction.previewBase = kernelLayout(document)
    this.set({ doc: transaction.previewBase })
    for (const id of [...copy.flowSizing.keys()].reverse()) {
      this.previewLayoutOrder(id, point)
      transaction.previewBase = this.state.doc
    }
  }
  /** Read-only command facts for the shared Core planner, not request authority. */
  duplicationRepeat(): DuplicationRepeat | null {
    const repeat = this.repeatedDuplicate
    if (!repeat || repeat.document !== this.state.doc || repeat.session !== this.sessionGeneration ||
      repeat.revision !== this.state.version || repeat.pageId !== this.state.page) return null
    return { roots: [...repeat.roots], reference: new Map([...repeat.reference].map(([id, matrix]) => [id, [...matrix] as Matrix])) }
  }
  /** Seed only from this Editor's actual accepted commit and current owner.
   * A copied/JSON/foreign receipt cannot publish context into a newer session. */
  rememberDuplication(result: unknown, roots: readonly string[], reference: ReadonlyMap<string, Matrix>, publishedPage?: string) {
    const receipt = this.committedEditReceipt(result), pageId = publishedPage ?? receipt?.pageId
    if (!receipt || this.state.doc !== receipt.document || this.sessionGeneration !== receipt.session ||
      this.state.version !== receipt.revision || this.state.page !== pageId || !roots.length ||
      roots.length !== this.state.selection.length || !roots.every((id, i) => this.state.selection[i] === id &&
        !!receipt.document.nodes[id] && reference.get(id)?.every(Number.isFinite))) return false
    const parents = allParents(receipt.document)
    if (!roots.every(id => { let at = id; while (parents.has(at)) at = parents.get(at)!; return at === pageId })) return false
    this.repeatedDuplicate = { document: receipt.document, session: receipt.session, revision: receipt.revision,
      pageId: pageId!, roots: [...roots], reference: new Map(roots.map(id => [id, [...reference.get(id)!] as Matrix])) }
    return true
  }
  duplicate() {
    const action = beginEditorAction(this, CanvasAction.duplicate, ActionSource.unknown, 224)
    try {
      if (this.state.busy || this.interactionActive || !commitPendingEdits(this) || !this.settleOwnedPropertyPreview('edit')) return
      if (this.state.busy || this.interactionActive || !this.state.selection.length) return
      const base = this.state.doc, session = this.sessionGeneration, revision = this.state.version
      const plan = prepareDuplication(base, this.state.selection, { kind: 'default' },
        { fresh: true, singleStep: true, mutable: false, repeat: this.duplicationRepeat() })
      const selected: string[] = []
      let reference = new Map<string, Matrix>()
      const result = this.change('创建副本', draft => {
        if (this.state.doc !== base || this.sessionGeneration !== session || this.state.version !== revision)
          throw new SelectionCommandError('superseded', 'Duplicate owner changed before commit')
        const created = applyDuplication(draft, plan)
        for (const id of created.roots) selected.push(id)
        reference = created.reference
      }, selected)
      this.rememberDuplication(result, selected, reference)
      return result
    } catch (error) {
      action.result(ActionOutcome.rejected, ActionReason.validation)
      if (error instanceof SelectionCommandError) { this.notify(error.message); return { status: 'rejected' as const, code: error.code, revision: this.state.version } }
      throw error
    } finally { action.finish() }
  }
  scaleSelection(factor: number, anchor = 4): boolean {
    if (this.state.busy || this.interactionActive) return false
    const ids = this.state.selection
    if (!ids.length) return false
    try {
      const { transforms } = prepareSelectionScale(this.state.doc, this.state.page, ids, factor, anchor)
      if (factor === 1) return true
      const before = this.state.doc
      this.change('等比缩放图层', doc => { for (const [id, transform] of Object.entries(transforms)) doc.nodes[id].transform = transform })
      return this.state.doc !== before
    } catch (error) { this.notify(String(error)); return false }
  }
  transformSelection(m: Matrix, label = '变换图层') {
    const ids = this.topSelection(),
      parents = allParents(this.state.doc)
    this.change(label, (d) => {
      for (const id of ids) {
        const p = worldMatrix(d, parents.get(id)!, parents)
        d.nodes[id].transform = multiply(
          inverse(p),
          multiply(m, worldMatrix(this.state.doc, id, parents)),
        )
      }
    })
  }
  align(axis: 'x' | 'y', mode: 'start' | 'center' | 'end' | 'distribute') {
    if (this.state.busy || this.interactionActive || !commitPendingEdits(this)) return
    if (!this.state.selection.length) return
    try {
      const base = this.state.doc, session = this.sessionGeneration, revision = this.state.version
      const plan = prepareSelectionArrangement(base, this.state.selection, axis, mode, { fresh: true })
      if (!plan.patches.length) return { status: 'unchanged' as const, revision }
      return this.change(mode === 'distribute' ? '等距分布' : '对齐图层', draft => {
        if (this.state.doc !== base || this.sessionGeneration !== session || this.state.version !== revision)
          throw new SelectionCommandError('superseded', 'Selection owner changed before alignment')
        applyTransformPlan(draft, plan.patches)
      })
    } catch (error) {
      if (error instanceof SelectionCommandError) { this.notify(error.message); return { status: 'rejected' as const, code: error.code, revision: this.state.version } }
      throw error
    }
  }
  convert() {
    const ids = this.topSelection()
    this.update(
      ids,
      (n) => {
        if (!container(n) && n.kind !== 'text') {
          n.network = editableNetwork(n)
          delete n.vectorGeometry
          n.kind = 'vector'
          delete n.arc
          delete n.cornerRadius
        }
      },
      '转换为矢量',
    )
  }
  async geometry(operation: BooleanOp | 'outline' | 'divide') {
    if (this.disposed) return
    if (['union', 'subtract', 'intersect', 'exclude'].includes(operation)) {
      this.group(false, operation as BooleanOp)
      return
    }
    const ids = this.topSelection(),
      d = this.state.doc
    if ((operation !== 'outline' && ids.length < 2) || !ids.length) return
    if (ids.some((id) => container(d.nodes[id]) || d.nodes[id].kind === 'text')) {
      this.notify('请选择形状或矢量图层')
      return
    }
    if (this.state.busy) return
    const parents = allParents(d),
      parent = parents.get(ids[0])!
    if (ids.some((id) => parents.get(id) !== parent)) {
      this.notify('几何运算需要选择同一容器内的图层')
      return
    }
    const siblings = d.nodes[parent]?.children || d.pages.find((p) => p.id === parent)!.children
    ids.sort((a, b) => siblings.indexOf(a) - siblings.indexOf(b))
    const position = Math.min(...ids.map((id) => siblings.indexOf(id)))
    const parentMatrix = worldMatrix(d, parent, parents)
    const outlineStyles = ids.flatMap((id) =>
      d.nodes[id].strokes
        .filter((s) => s.visible && s.width > 0)
        .map((s) => ({ node: d.nodes[id], paint: s.paint })),
    )
    if (operation === 'outline' && !outlineStyles.length) {
      this.notify('所选图层没有可轮廓化的描边')
      return
    }
    const before = d, epoch = this.sessionEpoch
    const current = () => !this.disposed && this.sessionEpoch === epoch
    this.set({ busy: true, message: '正在计算几何…' })
    try {
      if (!current()) return
      const payload = {
        operation,
        nodes: ids.map((id) => ({ ...d.nodes[id], transform: worldMatrix(d, id) })),
      }
      const results = await this.runGeometry(payload)
      if (!current()) return
      if (this.state.doc !== before) throw new Error('文档已发生变化，请重新执行几何操作')
      if (operation === 'outline') {
        // Keep every source at its original sibling position. Its fill/strokes
        // form one compositing layer, so opacity/effects must be applied once.
        const parts = new Map(ids.map((id) => [id, [] as DesignNode[]]))
        for (const id of ids) {
          const source = d.nodes[id]
          if (source.fills.some((p) => p.visible)) {
            const fill = cloneValue(source)
            fill.id = uid()
            fill.name += ' / 填充'
            fill.strokes = []
            // Outline is a baked geometry conversion, including effective paint.
            delete fill.bindings; delete fill.styleRefs
            delete fill.booleanOperation; fill.children = []
            parts.get(id)!.push(fill)
          }
        }
        for (const [index, contours] of results.entries()) {
          if (!contours.length) continue
          const { node: source, paint } = outlineStyles[index]
          // Bake the contour in source-local space so its original transform
          // still scales/rotates effects after conversion.
          const toLocal = inverse(worldMatrix(d, source.id, parents))
          const localContours = contours.map((ps) => ps.map((p) => ({
            x: toLocal[0] * p.x + toLocal[2] * p.y + toLocal[4],
            y: toLocal[1] * p.x + toLocal[3] * p.y + toLocal[5],
          })))
          const box = bounds(localContours.flat())
          const outline = node('vector', box.x, box.y, Math.max(0.01, box.width), Math.max(0.01, box.height))
          outline.name = source.name + ' / 描边轮廓'
          outline.network = contoursToNetwork(localContours.map((ps) => ps.map((p) => ({ x: p.x - box.x, y: p.y - box.y }))))
          outline.fills = [cloneValue(paint)]
          outline.strokes = []
          outline.transform = multiply(source.transform, outline.transform)
          parts.get(source.id)!.push(outline)
        }
        const roots = new Map<string, DesignNode[]>()
        const additions: DesignNode[] = []
        for (const id of ids) {
          const source = d.nodes[id], children = parts.get(id)!
          if (children.length > 1 || (children.length && source.effects.some((e) => e.visible))) {
            // Effects sample the original shape, not the union of outlined
            // strokes. Keep its exact primitive/path on the paint-free wrapper.
            const primitive = source.kind === 'rectangle' && !source.network
            const group = node(primitive ? 'frame' : 'group', 0, 0, source.width, source.height)
            group.clip = false
            group.radii = cloneValue(source.radii); group.smoothing = source.smoothing
            if (!primitive) {
              const paths = kernelSvgPaths(source)
              if (!paths) throw new Error('几何内核尚未就绪')
              group.network = source.network ? cloneValue(source.network) : pathNetwork(paths.fill)
            }
            group.name = source.name
            group.transform = cloneValue(source.transform)
            group.opacity = source.opacity
            group.blend = source.blend
            group.effects = cloneValue(source.effects)
            group.visible = source.visible
            group.locked = source.locked
            group.mask = source.mask; group.maskType = source.maskType
            group.variableModes = cloneValue(source.variableModes)
            group.sizing = cloneValue(source.sizing); group.constraints = cloneValue(source.constraints)
            group.fills = []; group.strokes = []
            group.children = children.map((child) => child.id)
            for (const child of children) {
              child.transform = multiply(inverse(source.transform), child.transform)
              child.opacity = 1; child.blend = 'normal'; child.effects = []
              child.mask = false; delete child.maskType
              delete child.sizing; delete child.constraints
            }
            additions.push(group, ...children)
            roots.set(id, [group])
          } else {
            for (const child of children) {
              child.opacity = source.opacity; child.blend = source.blend
              child.effects = cloneValue(source.effects)
              child.visible = source.visible; child.locked = source.locked
              child.mask = source.mask; child.maskType = source.maskType
              child.sizing = cloneValue(source.sizing); child.constraints = cloneValue(source.constraints)
            }
            additions.push(...children)
            roots.set(id, children)
          }
        }
        this.change('矢量几何运算', (next) => {
          const remove = (id: string) => {
            for (const child of next.nodes[id]?.children || []) remove(child)
            delete next.nodes[id]
          }
          const list = next.nodes[parent]?.children || next.pages.find((p) => p.id === parent)!.children
          for (const id of ids) {
            const at = list.indexOf(id)
            list.splice(at, 1, ...roots.get(id)!.map((n) => n.id))
            remove(id)
          }
          for (const n of additions) next.nodes[n.id] = n
        }, ids.flatMap((id) => roots.get(id)!.map((n) => n.id)))
        return
      }
      const replacements: DesignNode[] = []
      for (const result of results) {
        if (!result.length) continue
        const box = bounds(result.flat())
        const n = node(
          'vector',
          box.x,
          box.y,
          Math.max(0.01, box.width),
          Math.max(0.01, box.height),
        )
        n.name =
          operation === 'divide'
            ? '构建区域'
            : (
                  {
                    union: '联合',
                    subtract: '减去顶层',
                    intersect: '交集',
                    exclude: '排除交集',
                  } as const
                )[operation]
        n.network = contoursToNetwork(
          result.map((ps) => ps.map((p) => ({ x: p.x - box.x, y: p.y - box.y }))),
        )
        n.fills = cloneValue(
          d.nodes[ids[0]].fills,
        )
        n.strokes = cloneValue(d.nodes[ids[0]].strokes)
        n.opacity = d.nodes[ids[0]].opacity
        n.blend = d.nodes[ids[0]].blend
        n.effects = cloneValue(d.nodes[ids[0]].effects)
        n.transform = multiply(inverse(parentMatrix), n.transform)
        replacements.push(n)
      }
      this.change(
        '矢量几何运算',
        (next) => {
          const parents = allParents(next)
          for (const id of ids) {
            const parent = parents.get(id)!
            const list =
              next.nodes[parent]?.children || next.pages.find((p) => p.id === parent)!.children
            list.splice(list.indexOf(id), 1)
            delete next.nodes[id]
          }
          const list =
            next.nodes[parent]?.children || next.pages.find((p) => p.id === parent)!.children
          for (const n of replacements) {
            next.nodes[n.id] = n
          }
          list.splice(position, 0, ...replacements.map((n) => n.id))
        },
        replacements.map((n) => n.id),
      )
    } catch (e) {
      if (current() && !(e instanceof GeometryCancelled)) {
        this.notify(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (current()) this.set({ busy: false })
    }
  }
  private runGeometry(payload: unknown): Promise<Point[][][]> {
    if (this.disposed) return Promise.reject(new GeometryCancelled())
    this.geometryJob?.cancel()
    const worker = new Worker(new URL('./kernel/geometry-worker.ts', import.meta.url), {
      type: 'module',
    })
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        worker.onmessage = null
        worker.onerror = null
        worker.terminate()
        if (this.geometryJob === job) this.geometryJob = null
      }
      const finish = (settle: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        settle()
      }
      const job = { cancel: () => finish(() => reject(new GeometryCancelled())) }
      this.geometryJob = job
      const timer = setTimeout(() => {
        finish(() => reject(new Error('几何运算超时，原图层已保留')))
      }, 15000)
      worker.onmessage = (e) => {
        if (e.data.error) finish(() => reject(new Error(e.data.error)))
        else finish(() => resolve(e.data.results))
      }
      worker.onerror = (e) => {
        finish(() => reject(new Error(e.message)))
      }
      try {
        worker.postMessage(payload)
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }
  dispose() {
    if (this.disposed) return
    forgetPreparedDocumentEncoding(this.state.doc)
    this.saveCamera()
    this.releaseCameraLifecycle?.()
    this.releaseCameraLifecycle = undefined
    if (this.propertyPreview) this.cancelProperty(this.propertyPreview.lease)
    this.disposed = true
    closeCanvasActions(this)
    this.operationDiagnostics.close()
    this.diagnosticOperation = null
    this.sessionEpoch++
    this.geometryJob?.cancel()
    this.discardPendingView()
    this.listeners.clear()
    this.editListeners.clear()
    this.revealRequest = null
    this.revealListeners.clear()
  }
}
