import { CpuStage, measureCpuStage } from './cpu-stage-diagnostics'
import { recoverInteractionPreview } from './kernel/interaction-preview-recovery'
import { selectionSizeLabel } from './selection-size-label'
import { canvasOverlayCommands, canvasGpuOverlayOwnsUi } from './canvas-overlay-commands'
import { recordCanvasGrid } from './kernel/grid-measurements'
import { canvasActions, CanvasAction, ActionSource, ActionOutcome, ActionReason, modifierBits, type ActionReasonCode, type ActionOutcomeCode } from './canvas-action-diagnostics'
import { actionGeometry, compareActionGeometry } from './canvas-action-geometry'
import { recordNavigationInput } from './kernel/navigation-input'
import { desktopPet } from './desktop-pet'
import { nudgePreference } from './nudge-preference'
import { createKeyboardNudgeGesture } from './keyboard-nudge-gesture'
import { isDimensionNudgeCommand, nudgeSelectionDimensions } from './canvas-workflow-shortcuts'
import { canvasMarqueeSelection } from './canvas-selection-workflows'
import { CanvasSceneSnapshots } from './canvas-scene-snapshots'
import { StartupPreview } from './StartupPreview'
import type { StartupPreview as StartupPixels, PreviewPixels } from './startup-preview'
import { CanvasEditPreview, type RetainedMoveControl } from './CanvasEditPreview'
import { CanvasScrollbars } from './CanvasScrollbars'
import { supportsEditPreview } from './edit-preview'
import { resizedNode, resizeGestureAxes } from './selection-properties'
import {cancelToolActivation} from './tool-activation'
import {selectionHandles, selectionRotation, smallSelectionInterior} from './selection-handles'
import {selectionScaleFrame} from './selection-scale'
import {CanvasLayoutHandles} from './CanvasLayoutHandles'
import {CanvasSmartSelection} from './CanvasSmartSelection'
import {pixelGridPathData} from './pixel-grid'
import {CanvasGuides} from './CanvasGuides'
import {worldGuides} from './ruler-guides'
import {createSmartGuidesIndex, placedSmartGuides, type SmartGuideSegment, type SmartSnapResult} from './canvas-smart-guides'
import {useCanvasColorPicker} from './canvas-color-picker'
import { captureContentPlane } from './kernel/content-plane'
import { useUtilityTools, translateVertices } from './utility-tools'
import { resolveShortcut, shortcutPlatform } from './shortcut-profiles'
import { shortcutPreference } from './shortcut-preference'
import { dispatchEditorShortcut, shortcutTargetOwnsKeyboard } from './editor-shortcuts'
import { createPortal } from 'react-dom'
import { gridOverlayRectangles, layoutGridRectangles } from './grid-overlay'
import { canvasDropFrame, insideParentFrame } from './canvas-drop'
import { dispatchEditorCommand } from './editor-commands'
import { pendingOperationEpoch, registerPendingEdit, pendingEditsChanged } from './pending-edits'
import { lockedSelectionIds } from './canvas-menu-model'
import { modalOwnsKeyboard } from './modal-keyboard'
import { ViewControls } from './ViewControls'
import { CanvasTextEditor } from './TextEditor'
import { createBox, forcedPixelSnap, resizeInBasis, snapMove, selectionLocalBounds } from './canvas-view'
import { fitBounds, isNativePinch, revealInView, screenToWorld, worldToScreen, zoomAt, zoomStep, type CanvasCamera } from './canvas-camera'
import { WheelCameraGesture } from './wheel-camera-gesture'
import { desktopBridge,type LocalPeer } from './desktop'
import {
  kernelLayout,
  kernelStrokeHandles,
  initializePicking,
  kernelBounds,
  kernelSnapPoint,
  kernelHitWorld,
  kernelFillWorld,
  kernelSvgPaths,
  type StrokeHandle,
} from './kernel/picking'
import { profileTopology } from './stroke-profile'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor, Tool } from './engine'
import { KernelSurface, type PresentedFrame } from './kernel/Surface'
import { NativeSourceSurface, type NativeSourceStatus } from './kernel/NativeSourceSurface'
import type { SourceCanvasSnapshot } from './desktop'
import type { GpuMoveControl, InteractionProps } from './kernel/interaction-layers'
import {
  type Point,
  type Bounds,
  type Matrix,
  type DesignNode,
  type Network,
  uid,
  paint,
  node,
} from './model'
import {
  apply,
  inverse,
  translate,
  multiply,
  worldMatrix,
  type ParentMap,
  scene,
  SpatialIndex,
  unionBounds,
  boxPoints,
  contains,
  bounds,
  matrixString,
  networkD,
  toNetwork,
  edgeD,
  distance,
  lerp,
  pointInContours,
  segmentDistance,
} from './geometry'
import { splitEdge } from './vector'
import { imageData } from './persistence'
import { cropImageNode, imageNaturalSize } from './image-crop'
import { PencilInput, freehandNode, type PencilSettings, type FreehandTool } from './freehand'
import { NumberField } from './fields'
import { createShapeSeed, resolveShapeCreation, creationPointCount, type ShapeCreationKind, type ShapeCreationSeed } from './shape-creation'
import { CanvasContextMenu } from './CanvasContextMenu'
import { editableNetwork } from './editable-network'
import { dragThresholdPassed, selectedGroupDragIntent, selectedChildDragIntent, selectionPointerDown, frameTitleHit } from './canvas-pointer-intent'
import { moveCanvasFeedback, concealCanvasFeedback, restoreCanvasFeedbackVisibility } from './canvas-move-feedback'
import { interactivePath } from './selection-hierarchy'
import { presentedPenVertex, remapPointerAnchor } from './canvas-published-input'
import { canvasLayerFeedback } from './canvas-layer-feedback'
type TextEditEntry = { id: string; session: number; page: string; token: number }
type Drag = {
  renderFallbackCount?: number
  actionSamples?: number
  actionToken?: number
  actionRevision?: number
  actionBefore?: number[]
  actionProposal?: number[]
  actionResolved?: number[]
  actionSelection?: number

  pointerId: number
  session: number
  page: string
  kind: 'pan' | 'zoom' | 'move' | 'scale' | 'resize' | 'rotate' | 'pivot' | 'marquee' | 'create' | 'vertex' | 'handle' | 'width' | 'parameter' | 'crop'
  start: Point
  screen: Point
  view: CanvasCamera
  ids: string[]
  matrices: Record<string, Matrix>
  box: { x: number; y: number; width: number; height: number }
  basis?: Matrix
  localBox?: Bounds
  handle?: number
  node?: DesignNode
  sizes?: Record<
    string,
    {
      width: number
      height: number
      transform: Matrix
      sizing: DesignNode['sizing']
      network?: Network
    }
  >
  vertex?: string
  vertices?: string[]
  edge?: string
  control?: 'c1' | 'c2'
  widthHandle?: StrokeHandle
  widthSide?: 'left' | 'right'
  widthIndex?: number
  additive?: boolean
  sketchMarquee?: boolean
  forcedMarquee?: boolean
  marqueeIgnoreId?: string | null
  originSelection: string[]
  clickSelection?: string[] | null
  moved?: boolean
  duplicating?: boolean
  originalIds?: string[]
  sourceParents?: ParentMap
  sourceDocument?: import('./model').DesignDocument
  sourceEntries?: Readonly<ReturnType<typeof scene>>
  parentMatrices?: Record<string, Matrix>
  pickIndex?: SpatialIndex
  layoutPointerOrigin?: Point
  creationSeed?: ShapeCreationSeed
  creationTool?: Tool
  parameter?: 'points' | 'innerRadius' | 'arcStart' | 'arcSweep' | 'arcInner' | 'cornerRadius'
  pointer?: Point
  screenDistance?: number
  modifiers?: { shift: boolean; alt: boolean }
  lastInput?: React.PointerEvent
  lastScreen?: Point
  lastModifiers?: { shift: boolean; alt: boolean; ctrl: boolean; meta: boolean }
  sampledMovement?: boolean
  rotationDegrees?: number
  rotationCenter?: Point
  originalPivot?: Point
}
type Pen = {
  session: number
  page: string
  id?: string
  network: Network
  last: string | null
  first: string | null
  outgoing?: Point
}
const emptyBox = { x: 0, y: 0, width: 0, height: 0 }
/** Presentation signal: progressive tile commits that keep the camera,
 * document, page and epoch stable (idle refinement) must not re-render the
 * whole canvas tree — only meaningful display changes notify subscribers,
 * while the snapshot stays current for the next render from any other cause. */
class PresentedSignal {
  private listeners = new Set<() => void>()
  private cached: { frame: PresentedFrame | null } = { frame: null }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.cached
  set = (frame: PresentedFrame | null) => {
    const previous = this.cached.frame
    this.cached = { frame }
    if (frame === previous) return
    const stable =
      !!previous &&
      !!frame &&
      previous.view.x === frame.view.x &&
      previous.view.y === frame.view.y &&
      previous.view.zoom === frame.view.zoom &&
      previous.document === frame.document &&
      previous.pageId === frame.pageId &&
      previous.epoch === frame.epoch &&
      previous.gpuOverlay === frame.gpuOverlay &&
      previous.gpuOverlayIdentity === frame.gpuOverlayIdentity &&
      previous.gpuOverlayCapture === frame.gpuOverlayCapture &&
      !!previous.preview === !!frame.preview
    if (stable) return
    this.listeners.forEach((listener) => listener())
  }
}
export function Canvas({ editor, peers = [], zoomControlsTarget, compactChrome = false, startupPreview, loading = false, onCapturePreview, nativeSource, onNativeSourceStatus, onOpenSourcePoint }: {
  editor: Editor; peers?:LocalPeer[]; zoomControlsTarget?: HTMLElement | null; compactChrome?: boolean
  startupPreview?: StartupPixels; loading?: boolean
  nativeSource?:SourceCanvasSnapshot
  onNativeSourceStatus?:(status:NativeSourceStatus)=>void
  onOpenSourcePoint?:(point:Point)=>void
  onCapturePreview?: (document: import('./model').DesignDocument, version: number, pixels: PreviewPixels) => Promise<void>
}) {
  const canvasChromeSelector = 'button,input,select,textarea,[contenteditable="true"],.canvas-controls,.canvas-scrollbars,.pencil-controls,.rich-text-editor'
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot)
  const retainedMove = useRef<RetainedMoveControl|null>(null)
  const gpuMove = useRef<GpuMoveControl | null>(null)
  const [gpuReadyRevision, gpuReadyChanged] = useState(0)
  const interactionReady = useMemo(() => () => gpuReadyChanged(value => value + 1), [])
  const gpuMovedOverlays = useRef(new Map<SVGElement, string>())
  const restoreGpuOverlays = () => {
    for (const [element, transform] of gpuMovedOverlays.current) element.style.transform = transform
    gpuMovedOverlays.current.clear()
  }
  const fallbackMove = useRef<{ document: typeof state.doc; epoch: number; pageId: string; ids: string[] } | null>(null)
  const fallbackHiddenOverlays = useRef(new Map<SVGElement, string>())
  const clearFallbackMove = () => {
    fallbackMove.current = null
    restoreCanvasFeedbackVisibility(fallbackHiddenOverlays.current)
  }
  const presentedRef = useRef<PresentedSignal | null>(null)
  presentedRef.current ??= new PresentedSignal()
  const presentedSignal = presentedRef.current
  const syncFallbackMove = (frame: PresentedFrame | null = presentedSignal.getSnapshot().frame) => {
    const pending = fallbackMove.current
    if (!pending) return
    if (pending.epoch !== editor.sessionGeneration || pending.pageId !== editor.state.page ||
        pending.ids.length !== editor.state.selection.length || pending.ids.some((id, index) => id !== editor.state.selection[index])) {
      clearFallbackMove()
      return
    }
    if (frame && !frame.preview && frame.epoch === pending.epoch && frame.pageId === pending.pageId && frame.document === pending.document) {
      clearFallbackMove()
      return
    }
    if (host.current) concealCanvasFeedback(host.current, pending.ids, fallbackHiddenOverlays.current)
  }
  const awaitFallbackMove = () => {
    fallbackMove.current = { document: editor.state.doc, epoch: editor.sessionGeneration, pageId: editor.state.page, ids: [...editor.state.selection] }
    syncFallbackMove()
  }
  const recordPresentation = useCallback((frame: PresentedFrame | null) => {
    editor.observeCanvasPresentation(frame)
    presentedSignal.set(frame)
    syncFallbackMove(frame)
  }, [editor, presentedSignal])
  const presented = useSyncExternalStore(presentedSignal.subscribe, presentedSignal.getSnapshot).frame
  const presentationScopeMatches = presented?.epoch === editor.sessionGeneration &&
    presented.pageId === state.page && presented.document.id === state.doc.id
  const gpuPreviewAvailable = !!gpuMove.current?.covers(state.doc, state.selection, state.view)
  const vectorPreviewSupport = useMemo(() => ({ document: state.doc, pageId: state.page,
    supported: !gpuPreviewAvailable && supportsEditPreview(state.doc, state.page) }), [state.doc, state.page, gpuPreviewAvailable])
  const vectorPreviewSupported = vectorPreviewSupport.supported
  const editPreviewSupported = gpuPreviewAvailable || vectorPreviewSupported || !!retainedMove.current?.covers(state.doc, state.selection, state.view)
  const editPreviewVisible = presentationScopeMatches &&
    (gpuPreviewAvailable && !!gpuMove.current?.isActive() || editPreviewSupported && presented.document !== state.doc)
  const editInputAt = useRef(0)
  const displayView = editPreviewVisible && !gpuPreviewAvailable ? state.view : presentationScopeMatches ? presented.view : state.view
  const displayViewRef = useRef(displayView)
  displayViewRef.current = displayView
  // Coalesced camera writes live on the editor (see Editor.setViewCoalesced)
  // so every entry point — wheel, zoom buttons, commands — observes
  // one consistent pending camera. Gestures flush synchronously on completion.
  const flushView = () => {
    editor.flushPendingView()
  }
  const discardPendingView = () => {
    editor.discardPendingView()
  }
  const scheduleView = (next: typeof state.view) => {
    editor.setViewCoalesced(next, next.zoom===editor.effectiveView().zoom&&import.meta.env.VITE_DESIGN_LEADING_PAN_INPUT!=='0')
  }
  /** Base camera for incremental wheel math: the pending write when one is
   * coalesced, otherwise the committed editor view. */
  const pendingBase = () => editor.effectiveView()
  useLayoutEffect(() => discardPendingView(), [editor, editor.sessionGeneration, state.page])
  const host = useRef<HTMLDivElement>(null)
  const pendingBoardMove = useRef<Parameters<Editor['preview']>|null>(null)
  useLayoutEffect(() => {
    if (fallbackMove.current?.epoch === editor.sessionGeneration && fallbackMove.current.pageId === state.page)
      fallbackMove.current.document = state.doc
    syncFallbackMove()
  }, [state.doc, state.selection, state.page, editor.sessionGeneration, presented])
  useEffect(() => editor.subscribe(() => {
    if (!editor.interactionActive) {
      if (fallbackMove.current) {
        fallbackMove.current.document = editor.state.doc
        syncFallbackMove()
      } else clearFallbackMove()
      retainedMove.current?.restore(); gpuMove.current?.end(editor.state.doc); restoreGpuOverlays(); pendingBoardMove.current = null
    }
  }), [editor])
  useEffect(() => {
    if (!import.meta.env.DEV || !host.current) return
    const element = host.current
    let raf = 0, previous = 0, active = false, intervals: number[] = []
    let samples: { at: number; frames: number; uploads: number; samples: number; moves: number }[] = []
    const sample = (at: number) => {
      const data = element.querySelector<HTMLElement>('.kernel-compositor')?.dataset
      if (data && samples.length < 600) samples.push({ at, frames: Number(data.compositorFrames || 0),
        uploads: Number(data.compositorUploads || 0), samples: Number(data.interactionSamples || 0), moves: Number(data.interactionMoves || 0) })
    }
    const tick = (now: number) => {
      if (!active) return
      if (previous && intervals.length < 600) intervals.push(now - previous)
      sample(now); previous = now; raf = requestAnimationFrame(tick)
    }
    const start = () => {
      cancelAnimationFrame(raf); active = true; previous = 0; intervals = []; samples = []; sample(performance.now())
      raf = requestAnimationFrame(tick)
    }
    const finish = () => {
      if (!active) return
      active = false; cancelAnimationFrame(raf)
      const sorted = [...intervals].sort((a,b) => a-b)
      element.dataset.frameTrace = JSON.stringify({ kind: 'main-thread-rAF', visible: !window.document.hidden,
        frames: intervals.length, p50: sorted[Math.floor(sorted.length * .5)] || 0,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] || 0,
        over25ms: intervals.filter(ms => ms > 25).length, intervals, compositor: samples })
    }
    element.addEventListener('pointerdown', start)
    window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish)
    return () => {
      cancelAnimationFrame(raf); element.removeEventListener('pointerdown', start)
      window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish)
    }
  }, [])
  const colorPick=useCanvasColorPicker(editor,host)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [size, setSize] = useState({ width: 1000, height: 800 })
  // A saved preview may cover the untouched bootstrap document before restore,
  // but an edit, navigation or replacement immediately ends that exception.
  const startupOwner = useRef({ document: state.doc, pageId: state.page, session: editor.sessionGeneration })
  const startupDocument = useRef<{ document: import('./model').DesignDocument; session: number; preview: StartupPixels } | undefined>(undefined)
  const [startupConsumed, setStartupConsumed] = useState(false)
  const sameStartup = startupPreview?.documentId === state.doc.id && startupPreview.pageId === state.page
  if (sameStartup && !startupDocument.current) startupDocument.current = {
    document: state.doc, session: editor.sessionGeneration, preview: startupPreview!,
  }
  const exactCurrent = presentationScopeMatches && presented.document === state.doc && !presented.preview && !editPreviewVisible
  useEffect(() => {
    if (!exactCurrent || editor.historyBackend !== 'uninitialized') return
    const document = state.doc, session = editor.sessionGeneration
    const warm = () => {
      try { editor.warmEditingHistory(document, session) }
      catch (error) { console.warn('[editing-history] 预热未完成', error) }
    }
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(warm)
      return () => cancelIdleCallback(handle)
    }
    const timer = setTimeout(warm, 100)
    return () => clearTimeout(timer)
  }, [exactCurrent, state.doc, editor, editor.sessionGeneration])
  useEffect(() => { if (sameStartup && exactCurrent) setStartupConsumed(true) }, [sameStartup, exactCurrent])
  const untouchedStartup = state.doc === startupOwner.current.document && state.page === startupOwner.current.pageId &&
    editor.sessionGeneration === startupOwner.current.session
  const showStartup = !!startupPreview && !startupConsumed &&
    (loading && untouchedStartup || sameStartup && startupDocument.current?.document === state.doc &&
      startupDocument.current.session === editor.sessionGeneration && startupDocument.current.preview === startupPreview)
  useEffect(() => {
    if (loading || !onCapturePreview || !exactCurrent || state.grid || state.checkerboard || state.pixelPreview || editor.interactionActive) return
    let cancelled = false
    const snapshot = state.doc, version = state.version
    const timer = setTimeout(async () => {
      const canvas = host.current?.querySelector<HTMLCanvasElement>('.kernel-compositor')
      if (!canvas || !canvas.width || !canvas.height || editor.state.doc !== snapshot || editor.interactionActive) return
      let captured:Awaited<ReturnType<typeof captureContentPlane>>
      try{captured=await captureContentPlane(canvas)}catch(error){console.debug('[startup-preview] content capture unavailable',error);return}
      if(cancelled||editor.state.doc!==snapshot||captured.frame&&(captured.frame.document!==snapshot||captured.frame.view.x!==state.view.x||captured.frame.view.y!==state.view.y||captured.frame.view.zoom!==state.view.zoom)){captured.bitmap.close();return}
      // Idle complete frames only: camera motion never performs a readback.
      const scratch = window.document.createElement('canvas')
      const scale = Math.min(1, 1024 / Math.max(canvas.width, canvas.height))
      scratch.width = Math.max(1, Math.round(canvas.width * scale)); scratch.height = Math.max(1, Math.round(canvas.height * scale))
      const context = scratch.getContext('2d')
      if (!context) {captured.bitmap.close();return}
      const background = snapshot.pages.find(p => p.id === state.page)?.background || '#eeeff3'
      context.fillStyle = background; context.fillRect(0, 0, scratch.width, scratch.height)
      context.drawImage(captured.bitmap, 0, 0, scratch.width, scratch.height);captured.bitmap.close()
      scratch.toBlob(image => {
        if (cancelled || !image || image.size > 1_048_576 || editor.state.doc !== snapshot) return
        void onCapturePreview(snapshot, version, { image, pageId: state.page, view: { ...state.view },
          width: size.width, height: size.height, background }).catch(error => console.warn('[startup-preview] 保存预览失败', error))
      }, 'image/webp', .85)
    }, 600)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [loading, onCapturePreview, exactCurrent, state.doc, state.version, state.page, state.view, state.grid, state.checkerboard, state.pixelPreview, size.width, size.height, editor])
  const [textEntry, setTextEntry] = useState<TextEditEntry | null>(null)
  const textEntryOwner = useRef<TextEditEntry | null>(null), textEntrySequence = useRef(0)
  function ownsTextEntry(entry: TextEditEntry | null) {
    return !!entry && textEntryOwner.current === entry &&
      entry.session === editor.sessionGeneration && entry.page === editor.state.page
  }
  function setTextEdit(id: string | null) {
    // A bubbled double-click on the active rich-text surface re-enters the same
    // node. Keep its draft/DOM; a closed or different entry still gets a token.
    if (id && textEntryOwner.current?.id === id && ownsTextEntry(textEntryOwner.current)) return
    const entry = id ? { id, session: editor.sessionGeneration, page: editor.state.page, token: ++textEntrySequence.current } : null
    textEntryOwner.current = entry
    setTextEntry(entry)
  }
  // Reject a stale entry during render, before its textarea can mount/autofocus
  // in a replacement document. Passive cleanup alone is too late.
  const textEdit = ownsTextEntry(textEntry) ? textEntry!.id : null
  const [textPreview,setTextPreview]=useState<DesignNode|null>(null)
  const textAction = useRef<{ token: number; revision: number } | null>(null)
  useEffect(() => {
    const entry = textEntryOwner.current
    if (entry && !ownsTextEntry(entry)) setTextEdit(null)
  }, [editor.sessionGeneration, state.page])
  const [geometryReady, setGeometryReady] = useState(false)
  useEffect(() => {
    let alive = true
    initializePicking()
      .then(() => {
        if (alive) setGeometryReady(true)
      })
      .catch((error) => editor.notify(String(error)))
    return () => {
      alive = false
    }
  }, [editor])
  const drag = useRef<Drag | null>(null)
  const guideIndex = useRef<{ drag: Drag; rulers: boolean | undefined; ids: string;
    index: ReturnType<typeof createSmartGuidesIndex> } | null>(null)
  const releaseGuideIndex = () => { guideIndex.current?.index?.free(); guideIndex.current = null }
  useEffect(() => releaseGuideIndex, [])
  useEffect(() => { if (!editor.interactionActive) releaseGuideIndex() }, [editor.interactionActive, editor.sessionGeneration, state.page])
  const actionTrace = useMemo(() => canvasActions(editor), [editor])
  useEffect(() => {
    if (!textEdit || !actionTrace.enabled) return
    const record = { token: actionTrace.begin(CanvasAction.text, ActionSource.unknown, {targetCount: 1, routeSupported: true}), revision: editor.state.version }
    textAction.current = record
    return () => {
      actionTrace.finish(record.token, ActionOutcome.observed, ActionReason.unobserved, {routeSupported: true})
      if (textAction.current === record) textAction.current = null
    }
  }, [textEdit, actionTrace, editor])
  const beginDragTrace = (d: Drag, event: React.PointerEvent) => {
    if (!actionTrace.enabled) return
    const supported = ['move', 'resize', 'scale', 'rotate'].includes(d.kind)
    d.actionRevision = editor.state.version; d.actionSelection = editor.state.selection.length
    d.actionBefore = supported ? actionGeometry(editor.state.doc, d.ids) : undefined
    d.actionToken = actionTrace.begin(CanvasAction[d.kind], ActionSource.pointer, {
      modifiers: modifierBits(event), targetCount: d.ids.length, selectionBefore: editor.state.selection.length,
      lockedCount: d.ids.filter(id => editor.state.doc.nodes[id]?.locked).length,
      geometrySupported: !!d.actionBefore, snapEnabled: editor.state.snapPixels || editor.state.snap,
    })
  }
  const resizeWithTrace = (d: Drag, ...args: Parameters<typeof resizeInBasis>) => {
    const result = measureCpuStage(CpuStage.proposal, () => resizeInBasis(...args))
    if (d.actionToken) {
      const unsnapped = args[7] ? resizeInBasis(args[0], args[1], args[2], args[3], args[4], args[5], args[6], false) : result
      const unconstrained = args[5] || args[6] ? resizeInBasis(args[0], args[1], args[2], args[3], args[4], false, false, false) : unsnapped
      actionTrace.sample(d.actionToken, { snapChanged: compareActionGeometry(unsnapped, result) === 2, constraintEnabled: args[5] || args[6], constraintChanged: compareActionGeometry(unconstrained, unsnapped) === 2, intentResolvedComparison: compareActionGeometry(unsnapped, result) })
    }
    return result
  }
  const finishDragTrace = (d: Drag | null, outcome?: ActionOutcomeCode, reason: ActionReasonCode = ActionReason.none) => {
    if (!d?.actionToken) return
    const committed = editor.state.version !== d.actionRevision
    const geometry = d.actionBefore ? actionGeometry(editor.state.doc, d.ids) : undefined
    actionTrace.finish(d.actionToken, outcome ?? (committed ? ActionOutcome.committed : ActionOutcome.unchanged), reason, {
      committedChanged: committed, selectionAfter: editor.state.selection.length,
      selectionChanged: editor.state.selection.length !== d.actionSelection,
      proposalResolvedComparison: compareActionGeometry(d.actionProposal, d.actionResolved),
      resolvedCommittedComparison: compareActionGeometry(d.actionResolved, geometry),
      geometrySupported: !!geometry, thresholdPassed: !!d.moved,
    })
    d.actionToken = undefined
  }
  const queuedMove = useRef<{ event: React.PointerEvent; at: number } | null>(null)
  const moveFrame = useRef<number | null>(null)
  const moveCallback = useRef<(event: React.PointerEvent) => void>(() => {})
  const queuedInputAt = useRef(0)
  const cancelQueuedMove = () => {
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
    moveFrame.current = null; queuedMove.current = null; queuedInputAt.current = 0
  }
  useLayoutEffect(() => {
    const previous = drag.current
    if (previous && (previous.session !== editor.sessionGeneration || previous.page !== state.page)) {
      // The replacement document owns its own transaction. Retire only the
      // obsolete pointer/preview owner, never cancel the new editor state.
      cancelQueuedMove(); drag.current = null; pendingBoardMove.current = null
      restoreGpuOverlays(); retainedMove.current?.restore(); setPanning(false); setRubber(null); clearMoveGuides()
      if (host.current?.hasPointerCapture(previous.pointerId)) host.current.releasePointerCapture(previous.pointerId)
    }
    return cancelQueuedMove
  }, [editor, editor.sessionGeneration, state.page])
  const queuePointerMove = (event: React.PointerEvent) => actionTrace.cpu.run(CpuStage.pointerQueue, () => queuePointerMoveImpl(event), drag.current?.actionToken)
  const queuePointerMoveImpl = (event: React.PointerEvent) => {
    const active = drag.current
    const hover = !active && !pencil.current && !utility.active()
    // These previews are functions of the captured gesture baseline and latest
    // pointer. Pen construction (vertex without a node), freehand and utility
    // tools accumulate samples and must continue receiving every input event.
    const latestOnly = active && (['move','resize','scale','rotate','parameter','handle','width','crop','marquee','zoom'].includes(active.kind) ||
      active.kind === 'vertex' && !!active.node)
    if (!hover && !latestOnly) { moveCallback.current(event); return }
    if (active && event.pointerId !== active.pointerId) return
    const session = editor.sessionGeneration, page = editor.state.page
    queuedMove.current = { event, at: performance.now() }
    if (moveFrame.current === null) moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null
      const next = queuedMove.current; queuedMove.current = null
      const valid = active ? drag.current === active && active.pointerId === next?.event.pointerId
        : !drag.current && !pencil.current && !utility.active()
      if (next && valid && session === editor.sessionGeneration && page === editor.state.page) {
        queuedInputAt.current = next.at; moveCallback.current(next.event); queuedInputAt.current = 0
      }
    })
  }
  const origin = useRef({visible:false,point:{x:.5,y:.5}})
  const [,refreshOrigin] = useState(0)
  const setOrigin=(point:Point,visible=origin.current.visible)=>{origin.current={point,visible};refreshOrigin(v=>v+1)}
  useLayoutEffect(()=>{setOrigin({x:.5,y:.5},false)},[editor.sessionGeneration,state.page,state.selection.join(',')])
  const originWorld=()=>{
    const frame=selectionScaleFrame(editor.state.doc,editor.state.page,editor.topSelection())
    return apply(frame.basis,{x:frame.box.x+frame.box.width*origin.current.point.x,y:frame.box.y+frame.box.height*origin.current.point.y})
  }
  const originFromWorld=(p:Point)=>{
    const frame=selectionScaleFrame(editor.state.doc,editor.state.page,editor.topSelection()),local=apply(inverse(frame.basis),p)
    return {x:(local.x-frame.box.x)/Math.max(frame.box.width,1e-10),y:(local.y-frame.box.y)/Math.max(frame.box.height,1e-10)}
  }
  const pencil = useRef<{
    actionToken?: number
    actionRevision?: number
    input: PencilInput
    id: string
    settings: PencilSettings
    tool: FreehandTool
    session: number
    page: string
    zoom: number
    map: (p: { clientX: number; clientY: number }) => Point
  } | null>(null)
  const pencilFrame = useRef<number | null>(null)
  const [pencilPreview, setPencilPreview] = useState<DesignNode | null>(null)
  const [shapePreview, setShapePreview] = useState<DesignNode | null>(null)
  const drawingPreview = pencilPreview || shapePreview
  function cancelPencil(recordCancellation = true) {
    if (pencil.current?.actionToken && recordCancellation) actionTrace.finish(pencil.current.actionToken, ActionOutcome.cancelled, ActionReason.unobserved)
    if (pencil.current) editor.cancel()
    if (pencilFrame.current !== null) cancelAnimationFrame(pencilFrame.current)
    pencilFrame.current = null
    pencil.current = null
    setPencilPreview(null)
  }
  function pencilPreviewFrame() {
    pencilFrame.current = null
    const draft = pencil.current
    if (!draft) return
    try {
      setPencilPreview(freehandNode(draft.id, draft.input.samples, draft.settings, draft.zoom, draft.tool))
    } catch (error) {
      cancelPencil()
      editor.notify(String(error))
    }
  }
  useLayoutEffect(() => {
    const stroke=pencil.current
    if(!stroke || stroke.tool!==state.tool || stroke.session!==editor.sessionGeneration || stroke.page!==state.page)cancelPencil()
    const creation=drag.current
    if(!creation || creation.kind!=='create' || creation.creationTool!==state.tool || creation.session!==editor.sessionGeneration || creation.page!==state.page){
      setShapePreview(null)
      if(creation?.kind==='create'){editor.cancel();drag.current=null;setRubber(null)}
    }
  }, [state.page, state.doc.id, state.tool])
  useEffect(
    () => () => {
      if (pencilFrame.current !== null) cancelAnimationFrame(pencilFrame.current)
    },
    [],
  )
  const [cropRect, setCropRect] = useState<typeof emptyBox | null>(null)
  useEffect(() => setCropRect(null), [state.page, state.doc.id, state.tool])
  const [rubber, setRubber] = useState<typeof emptyBox | null>(null)
  type MoveGuides = { x?: SmartGuideSegment; y?: SmartGuideSegment; surface?:boolean }
  const [guides, setGuides] = useState<MoveGuides>({})
  const guidePoses = useRef(new Map<number, { drag: Drag; document: import('./model').DesignDocument; control:GpuMoveControl; guides: MoveGuides }>())
  const guideDocuments = useRef(new WeakMap<import('./model').DesignDocument, { drag: Drag; guides: MoveGuides }>())
  function showMoveGuides(next: MoveGuides) {
    const same = (a?: SmartGuideSegment, b?: SmartGuideSegment) => a === b || !!a && !!b &&
      a.axis === b.axis && a.position === b.position && a.start === b.start && a.end === b.end
    setGuides(old => old.surface === next.surface && same(old.x, next.x) && same(old.y, next.y) ? old : next)
  }
  function clearMoveGuides() {
    guidePoses.current.clear(); guideDocuments.current = new WeakMap(); showMoveGuides({})
  }
  useLayoutEffect(() => {
    const gesture = drag.current
    if (!editor.interactionActive || !gesture || gesture.kind !== 'move' ||
        gesture.session !== editor.sessionGeneration || gesture.page !== state.page) clearMoveGuides()
  }, [editor, editor.interactionActive, editor.sessionGeneration, state.page, state.tool])
  useLayoutEffect(() => {
    if (!presented || pendingBoardMove.current) return
    const sample = guideDocuments.current.get(presented.document)
    if (sample && sample.drag === drag.current) showMoveGuides(sample.guides)
  }, [presented])
  function restoreCancelledMarqueeSelection(draft: Drag | null) {
    // Marquee has no document transaction: pointerdown may already have cleared
    // the selection, so Editor.cancel() alone cannot restore it. Never publish
    // the old selection into a replacement session or a different page.
    if (draft?.kind !== 'marquee' || draft.session !== editor.sessionGeneration ||
        draft.page !== editor.state.page) return
    const doc = editor.state.doc, parents = editor.parentMap(doc)
    editor.select(draft.originSelection.filter(id => {
      if (!doc.nodes[id]) return false
      let parent = parents.get(id)
      while (parent && doc.nodes[parent]) parent = parents.get(parent)
      return parent === draft.page
    }))
  }
  useLayoutEffect(() => {
    const previous = drag.current
    if (!previous || (previous.session === editor.sessionGeneration && previous.page === state.page)) return
    // Loading another document resets the engine transaction. Never restore the
    // old snapshot over that new document. A same-session page switch cancels it.
    if (previous.session === editor.sessionGeneration) editor.cancel()
    finishDragTrace(drag.current, ActionOutcome.cancelled, ActionReason.staleSession)
    drag.current = null
    if (host.current?.hasPointerCapture(previous.pointerId)) host.current.releasePointerCapture(previous.pointerId)
    setRubber(null)
    clearMoveGuides()
    setShapePreview(null)
  }, [editor, editor.sessionGeneration, state.page])
  const hover = state.hover
  // Client coordinates survive sidebar resizing; convert against the current
  // canvas rectangle when a new presented snapshot becomes pickable.
  const hoverPoint = useRef<Point | null>(null)
  const navigationUntil = useRef(0)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refreshHover = useRef<() => void>(() => {})
  const suspendNavigationHover = () => {
    desktopPet.navigate()
    navigationUntil.current = performance.now() + 150
    editor.hoverLayer(null, 'canvas')
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => { hoverTimer.current = null; navigationUntil.current = 0; refreshHover.current() }, 150)
  }
  useEffect(() => () => { if (hoverTimer.current !== null) clearTimeout(hoverTimer.current) }, [])
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; worldPoint: Point; candidates: { id: string; name: string; locked: boolean }[] } | null>(null)
  useEffect(() => setContextMenu(null), [state.page, editor.sessionGeneration])
  const [pen, setPen] = useState<Pen | null>(null)
  const penRef = useRef(pen)
  penRef.current = pen
  useEffect(() => registerPendingEdit(editor, {
    dirty: () => !!penRef.current?.network.vertices.length,
    commit: () => {
      if (drag.current || pencil.current || utility.active()) return false
      finishPen()
      return !penRef.current
    },
  }), [editor])
  useEffect(() => {
    const draft = penRef.current
    if (draft && (draft.session !== editor.sessionGeneration || draft.page !== state.page)) {
      penRef.current = null; setPen(null); drag.current = null; pendingEditsChanged(editor)
    }
  }, [editor, editor.sessionGeneration, state.page])
  const [cursor, setCursor] = useState<Point | null>(null)
  const cursorPoint = useRef<Point | null>(null)
  const [measureKeys,setMeasureKeys]=useState({alt:false,deep:false})
  const wheelModifiers = useRef({ ctrl: false, meta: false })
  const space = useRef(false)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const marqueeHeld = useRef(false)
  const [marqueeKeyHeld, setMarqueeKeyHeld] = useState(false)
  useLayoutEffect(() => {
    marqueeHeld.current = false; setMarqueeKeyHeld(false)
  }, [editor, editor.sessionGeneration, state.page])
  const [panning, setPanning] = useState(false)
  useEffect(() => { if (panning) desktopPet.navigate(true); return () => { if (panning) desktopPet.releaseNavigation() } }, [panning])
  useEffect(() => () => desktopPet.stopNavigation(), [])
  const sceneSnapshots = useRef<CanvasSceneSnapshots | null>(null)
  sceneSnapshots.current ??= new CanvasSceneSnapshots()
  const snapshots = sceneSnapshots.current
  snapshots.begin(editor, editor.sessionGeneration, state.page, geometryReady)
  const currentScene = snapshots.currentScene(state.doc, state.page)
  const entries = currentScene.entries
  const gridFrameId = state.selection.length === 1 && state.doc.nodes[state.selection[0]]?.kind === 'frame' &&
    state.doc.nodes[state.selection[0]].layout?.mode === 'grid' ? state.selection[0] : undefined
  // This publication also changes when the picking/font geometry epoch changes.
  const solvedGridRectangles = useMemo(() => gridFrameId ? gridOverlayRectangles(state.doc, gridFrameId) : [],
    [state.doc, gridFrameId, currentScene])
  const interactionScene = useMemo(() => snapshots.borrowCurrentScene(state.doc, state.page, editor.sessionGeneration),
    [snapshots, currentScene, state.doc, state.page, editor, editor.sessionGeneration, geometryReady])
  useLayoutEffect(() => editor.bindPublishedScene(interactionScene), [editor, interactionScene])
  const gpuInteraction = useMemo<InteractionProps>(() => ({ document: state.doc, selection: state.selection,
    readinessRevision:gpuReadyRevision,
    active: editor.interactionActive, gestureKind: drag.current?.kind, epoch: editor.sessionGeneration, control: gpuMove, onReady: interactionReady,
    onPreviewFailed: failure => {
      recoverInteractionPreview(failure, { editor, pending: () => pendingBoardMove.current,
        gesture: () => drag.current as { kind: string; ids: string[]; duplicating?: boolean } | null,
        sequence: () => gpuMove.current?.inputSequence?.() || 0,
        clearPending: () => { pendingBoardMove.current = null },
        restoreRetained: () => retainedMove.current?.restore(), end: () => gpuMove.current?.end(editor.state.doc),
        restoreOverlays: restoreGpuOverlays })
    },
    onPosePresented: pose => {
      const gesture = drag.current
      if (!pendingBoardMove.current || !gesture || !['move', 'rotate', 'scale'].includes(gesture.kind) ||
          pose.epoch !== editor.sessionGeneration || pose.document !== editor.state.doc ||
          pose.control && pose.control !== gpuMove.current) return
      if (host.current) moveCanvasFeedback(host.current, gesture.ids, pose.offset, gpuMovedOverlays.current)
      const guides = guidePoses.current.get(pose.sequence)
      showMoveGuides(guides?.drag === gesture && guides.document === pose.document && guides.control === gpuMove.current ? guides.guides : {})
      for (const sequence of guidePoses.current.keys()) if (sequence <= pose.sequence) guidePoses.current.delete(sequence)
      if (gesture.actionToken) actionTrace.sample(gesture.actionToken, { posePresentedSequence: pose.sequence, poseLatencyMs: Math.round(pose.latencyMs) })
    },
    scene: interactionScene }),
    [state.doc, state.selection, editor.interactionActive, editor.sessionGeneration, interactionReady, interactionScene, drag.current?.kind,gpuReadyRevision])
  const sliceEntries = useMemo(() => entries.filter(entry => state.doc.nodes[entry.id].kind === 'slice'),
    [entries, state.doc])
  const lastOpenedSession = useRef(editor.sessionGeneration)
  useLayoutEffect(() => {
    const session = editor.sessionGeneration
    if (lastOpenedSession.current === session) return
    if(editor.preservedViewSession===session){lastOpenedSession.current=session;return}
    const roots = entries.filter((entry) => entry.depth === 0)
    if (!roots.length) {
      lastOpenedSession.current = session
      return
    }
    const width = host.current?.clientWidth || size.width
    const height = host.current?.clientHeight || size.height
    if (width <= 0 || height <= 0) return
    lastOpenedSession.current = session
    editor.set({
      view: fitBounds(unionBounds(roots.map((entry) => entry.bounds)), { width, height }, { maxZoom: 1 }),
    })
  }, [editor, editor.sessionGeneration, entries, size.width, size.height])
  const reveal = useSyncExternalStore(editor.subscribeReveal, editor.revealSnapshot)
  useLayoutEffect(() => {
    if (!reveal) return
    if (reveal.session !== editor.sessionGeneration || reveal.documentId !== state.doc.id || reveal.pageId !== state.page ||
      !reveal.ids.some(id => state.selection.includes(id))) {
      editor.consumeReveal(reveal.nonce)
      return
    }
    const width = host.current?.clientWidth || 0
    const height = host.current?.clientHeight || 0
    if (width <= 0 || height <= 0) return
    const ids = new Set(reveal.ids)
    const matched = entries.filter((entry) => ids.has(entry.id))
    // Consume even hidden/missing targets: later edits must never replay an
    // old selection's camera request. A zero-sized viewport may retry above.
    editor.consumeReveal(reveal.nonce)
    // Apply the parked wheel camera first: dropping it here silently rolled
    // back the user's last zoom/pan when they clicked a layer-panel row.
    flushView()
    if (!matched.length) return
    const next = revealInView(
      editor.state.view,
      unionBounds(matched.map((entry) => entry.bounds)),
      { width, height },
    )
    if (next) editor.set({ view: next })
  }, [reveal, editor, entries, state.doc.id, state.page, state.selection, editor.sessionGeneration, size.width, size.height])
  const index = currentScene.index
  const displayedSnapshot = useMemo(() => presentationScopeMatches ? editPreviewVisible
    ? { ...presented!, document: state.doc, view: displayView, preview: true } : presented : null,
    [presentationScopeMatches, editPreviewVisible, presented, state.doc, displayView])
  const displayedIndex = snapshots.displayedScene(displayedSnapshot?.document, displayedSnapshot?.pageId)?.index ?? null
  const displayedHit = (point: Point, deep = false, eligible?: (node:DesignNode)=>boolean) => displayedSnapshot && displayedIndex
    ? editor.hit(point, deep, displayedIndex, displayViewRef.current.zoom, displayedSnapshot,eligible) : null
  const displayedHoverHit = (point: Point) => displayedSnapshot && displayedIndex
    ? editor.hoverHit(point, displayedIndex, displayViewRef.current.zoom, displayedSnapshot) : null
  refreshHover.current = () => {
    const client = hoverPoint.current, rect = host.current?.getBoundingClientRect()
    const point = client && rect ? { x: client.x - rect.left, y: client.y - rect.top } : null
    editor.hoverLayer(point && rect && point.x >= 0 && point.y >= 0 && point.x < rect.width && point.y < rect.height &&
      performance.now() >= navigationUntil.current && !textEdit && displayedSnapshot && !drag.current && !pencil.current && !space.current &&
      ['select', 'multiselect', 'scale', 'vector', 'width'].includes(editor.state.tool)
      ? displayedHoverHit(screenToWorld(displayedSnapshot.view, point)) : null, 'canvas')
  }
  // Navigation changes the content below a stationary pointer. Suppress hover
  // through wheel momentum, then pick once; do not churn between leaf/frame
  // targets or refresh the Layers panel on every presented camera sample.
  const hoverView = useRef(state.view)
  useLayoutEffect(() => {
    const previous = hoverView.current; hoverView.current = state.view
    if (previous.x !== state.view.x || previous.y !== state.view.y || previous.zoom !== state.view.zoom) suspendNavigationHover()
    else refreshHover.current()
  }, [editor, state.view, presented, displayedIndex, textEdit, state.tool])
  const selection = useMemo(() => new Set(state.selection), [state.selection])
  const selectionFeedback = useMemo(() => canvasLayerFeedback(state.doc, state.page, state.selection, editor.parentMap(state.doc)),
    [editor, state.doc, state.version, state.page, state.selection])
  const selected = useMemo(() => {
    const ids = new Set(selectionFeedback.ids)
    return entries.filter(e => ids.has(e.id))
  }, [entries, selectionFeedback])
  const looseSelectionBox = useMemo(() => unionBounds(selected.map(e => e.bounds)), [selected])
  const zoom = displayView.zoom
  const resizeNode = selected.length === 1 ? state.doc.nodes[selected[0].id] : null
  const canOrient = !!resizeNode
  const localSelection = useMemo(() => canOrient ? selectionLocalBounds(state.doc, resizeNode!.id) : null,
    [state.doc, resizeNode?.id, canOrient, geometryReady])
  const selectionCorners = useMemo(() => localSelection
    ? boxPoints(localSelection).map((p) => apply(selected[0].matrix, p))
    : boxPoints(looseSelectionBox), [localSelection, selected, looseSelectionBox])
  // Editing positions follow the oriented selection rectangle. The curve's
  // tighter world-space outline remains available to picking and culling.
  const selectionBox = useMemo(() => bounds(selectionCorners), [selectionCorners])
  const measurementTarget = measureKeys.alt && !drag.current && cursor && selected.length && state.tool==='select'
    ? displayedHit(cursor,measureKeys.deep,n=>!selection.has(n.id)) : null
  const measurementBounds = measurementTarget && displayedSnapshot
    ? displayedIndex?.entries.find(e=>e.id===measurementTarget)?.bounds : null
  const transformHandles = useMemo(() => selectionHandles(selectionCorners, zoom), [selectionCorners, zoom])
  const ownedDrag = drag.current?.session === editor.sessionGeneration && drag.current.page === state.page
    ? drag.current : null
  const capturedTransform = !!ownedDrag && ['move', 'resize', 'scale', 'rotate', 'pivot', 'parameter'].includes(ownedDrag.kind)
  // New controls must describe the displayed document. Keep the existing
  // control DOM through its owned preview transaction so capture survives.
  // Pixels lagging an edit (refinement in flight) no longer block gestures:
  // hit-testing runs against the displayed snapshot, mutations against the
  // live document, so the user can keep working while tiles re-render.
  const canTransform = capturedTransform || (['select','multiselect','scale'].includes(state.tool) && !spaceHeld && !textEdit &&
    !selectionFeedback.readOnly && !!displayedSnapshot)
  const frameTitles = useMemo(() => entries.filter(e => {
    const n=state.doc.nodes[e.id]
    return ['frame','section'].includes(n.kind) && (e.depth===0||selection.has(e.id)) &&
      ((!n.instance&&!n.instanceOrigin)||selection.has(e.id))
  }), [entries,state.doc,selection])
  const overlay = useMemo(() => canvasOverlayCommands({
    document:state.doc,pageId:state.page,epoch:editor.sessionGeneration,tool:state.tool,pixelGrid:state.pixelGrid,
    canTransform,selected,owners:selectionFeedback.ids,frameTitles,localSelection,selectionCorners,selectionBox,
    measurementTarget:measurementTarget&&measurementBounds?{id:measurementTarget,bounds:measurementBounds}:null,
  }), [state.doc,state.page,state.tool,state.pixelGrid,editor.sessionGeneration,frameTitles,canTransform,selected,
    measurementTarget,measurementBounds,selectionCorners,selectionBox,localSelection,selectionFeedback])
  const measurements = overlay.commands.measurements || []
  const gpuOverlay = canvasGpuOverlayOwnsUi(presented,overlay,presentationScopeMatches)
  const pixelGridPath = useMemo(
    () => pixelGridPathData(displayView, size.width, size.height, state.pixelGrid),
    [state.pixelGrid, displayView.x, displayView.y, displayView.zoom, size.width, size.height],
  )
  useLayoutEffect(() => {
    if (!actionTrace.enabled) return
    // Count already-rendered overlays; never re-run layout or log their geometry.
    recordCanvasGrid(editor, {gridKind: 2, gridVisible: Number(!!pixelGridPath && (!gpuOverlay||presented?.gpuPixelGrid===false)), gridSpacingClass: displayView.zoom >= 4 ? 2 : 1,
      gridStale: Number(displayView.x !== state.view.x || displayView.y !== state.view.y || displayView.zoom !== state.view.zoom), gridRedrawReason: 0})
    if (editor.interactionActive) return
    const cells = host.current?.querySelectorAll('[data-testid="layout-grid-cell"]').length || 0
    const bands = host.current?.querySelectorAll('[data-testid="authored-layout-grid-band"]').length || 0
    recordCanvasGrid(editor, {gridKind: 3, gridVisible: Number(cells > 0), gridCount: cells, gridRedrawReason: 0})
    recordCanvasGrid(editor, {gridKind: 4, gridVisible: Number(bands > 0), gridCount: bands, gridRedrawReason: 0})
  }, [editor, actionTrace.enabled, pixelGridPath, gpuOverlay, displayView, state.view, state.doc, state.selection])
  useEffect(() => {
    const observer = new ResizeObserver(([e]) =>
      setSize({ width: e.contentRect.width, height: e.contentRect.height }),
    )
    observer.observe(host.current!)
    return () => observer.disconnect()
  }, [])
  const screenPoint = (e: { clientX: number; clientY: number }) => {
    const b = host.current!.getBoundingClientRect()
    return { x: e.clientX - b.left, y: e.clientY - b.top }
  }
  const world = (e: { clientX: number; clientY: number }) => {
    return screenToWorld(displayViewRef.current, screenPoint(e))
  }
  const utility=useUtilityTools(editor,state.tool,displayedHit,displayView.zoom)
  const previewFonts=useMemo(()=>utility.preview?.fonts?{...state.doc.fonts,...utility.preview.fonts}:state.doc.fonts,[state.doc.fonts,utility.preview?.fonts])
  const renderedDocument=useMemo(()=>{
    if(textPreview&&state.doc.nodes[textPreview.id])return kernelLayout({...state.doc,nodes:{...state.doc.nodes,[textPreview.id]:textPreview}})
    if(utility.preview){const preview=utility.preview;return kernelLayout({...state.doc,schemaVersion:Math.max(10,state.doc.schemaVersion) as typeof state.doc.schemaVersion,fonts:previewFonts,nodes:{...state.doc.nodes,...Object.fromEntries(preview.nodes.map(n=>[n.id,n]))},pages:state.doc.pages.map(p=>p.id===state.page?{...p,children:[...p.children,preview.root]}:p)})}
    return !drawingPreview?state.doc:{...state.doc,schemaVersion:drawingPreview.kind==='slice'?Math.max(10,state.doc.schemaVersion) as typeof state.doc.schemaVersion:state.doc.schemaVersion,nodes:{...state.doc.nodes,[drawingPreview.id]:drawingPreview},pages:state.doc.pages.map(p=>p.id===state.page?{...p,children:[...p.children,drawingPreview.id]}:p)}
  },[state.doc,state.page,drawingPreview,utility.preview,textPreview,previewFonts])
  const exactOverlayMatches = editPreviewVisible || (presentationScopeMatches && presented.document === renderedDocument)
  const [refineDocument, setRefineDocument] = useState(renderedDocument)
  // Without a retained edit preview there is no alternate current content.
  // Submit the current document immediately, not after an effect/timer turn.
  const surfaceDocument = !editPreviewSupported ? renderedDocument :
    refineDocument.id === renderedDocument.id && refineDocument.pages.some(page => page.id === state.page) ? refineDocument : renderedDocument
  const refineOverview = snapshots.refineOverview(surfaceDocument, state.page)
  const editBaseDocument = useRef(renderedDocument)
  if (ownedDrag?.sourceDocument) editBaseDocument.current = ownedDrag.sourceDocument
  else if (!editPreviewVisible) editBaseDocument.current = renderedDocument
  useEffect(() => {
    if (!editPreviewSupported) { setRefineDocument(renderedDocument); return }
    if (editor.interactionActive) return
    // A retained GPU surface already keeps the committed pose visible while
    // exact rendering is prepared. It needs no SVG paint/coalescing delay.
    if (gpuPreviewAvailable) { setRefineDocument(renderedDocument); return }
    // Give the current edit one paint opportunity before serializing a large
    // exact worker request. Rapid edits coalesce to the newest document.
    const timer = setTimeout(() => setRefineDocument(renderedDocument), 80)
    return () => clearTimeout(timer)
  }, [renderedDocument, editPreviewSupported, gpuPreviewAvailable, editor.interactionActive])
  function zoomCanvas(command: 'zoomIn' | 'zoomOut' | 'zoom100') {
    if (drag.current || pencil.current || utility.active()) return
    flushView()
    const view = editor.state.view
    const zoom = command === 'zoom100' ? 1 : zoomStep(view.zoom, command === 'zoomIn' ? 1 : -1)
    editor.set({ view: zoomAt(view, zoom, editor.pointerScreen || { x: (host.current?.clientWidth || size.width) / 2, y: (host.current?.clientHeight || size.height) / 2 }) })
  }
  useEffect(() => desktopBridge()?.onCommand((command) => {
    if (editor.state.busy || (typeof document !== 'undefined' && shortcutTargetOwnsKeyboard(document.activeElement))) return
    if (command === 'zoomIn' || command === 'zoomOut' || command === 'zoom100') zoomCanvas(command)
  }), [editor])
  function finishPen() {
    const p = penRef.current
    if (!p) return
    penRef.current = null
    setPen(null)
    pendingEditsChanged(editor)
    if (p.session !== editor.sessionGeneration || p.page !== editor.state.page) return
    if (p.network.edges.length) {
      if (p.id)
        editor.update(
          [p.id],
          (n) => {
            n.network = p.network
            delete n.vectorGeometry
          },
          '编辑矢量网络',
        )
      else {
        const temp = node('vector', 0, 0, 1, 1)
        temp.network = p.network
        const b = kernelBounds(temp) || bounds(p.network.vertices)
        const g = structuredClone(p.network)
        g.vertices.forEach((v) => {
          v.x -= b.x
          v.y -= b.y
        })
        g.edges.forEach((e) => {
          for (const c of [e.c1, e.c2])
            if (c) {
              c.x -= b.x
              c.y -= b.y
            }
        })
        editor.add(
          'vector',
          { ...b, width: Math.max(b.width, 1), height: Math.max(b.height, 1) },
          undefined,
          g,
        )
      }
    }
    editor.set({ tool: 'select' })
  }
  useEffect(() => {
    const nudge = createKeyboardNudgeGesture(editor)
    const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || shortcutTargetOwnsKeyboard(e.target) || e.getModifierState?.('AltGraph')) { nudge.finish(); return }
      if (nudge.active && e.key === 'Escape') { e.preventDefault(); if (!e.repeat) nudge.finish(true); return }
      if (nudge.active && !arrows.includes(e.key) && !['Shift', 'Alt', 'Control', 'Meta'].includes(e.key)) nudge.finish()
      if(e.key==='Escape')cancelToolActivation(editor)
      const shortcutContext = { profile: shortcutPreference.getSnapshot(), platform: shortcutPlatform(), desktop: !!desktopBridge() }
      const shortcut = resolveShortcut(e, shortcutContext)
      if (e.repeat && !shortcut?.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) { if (shortcut) e.preventDefault(); return }
      if(['Alt','Meta','Control'].includes(e.key)) {
        setMeasureKeys({alt:e.altKey,deep:e.metaKey||e.ctrlKey})
        if (e.altKey) setCursor(cursorPoint.current)
      }
      if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key) && replayDragModifiers(e)) return
      if(utility.active() && e.key!=='Escape'){e.preventDefault();return}
      // X is a momentary selection override, never a persistent tool switch.
      // Keep it out of text/IME/modal handling and don't toggle on repeats.
      if (shortcutContext.profile === 'sketch-like' && e.key.toLowerCase() === 'x' &&
          !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
          !drag.current && !pencil.current && !penRef.current && !editor.interactionActive && !editor.state.busy) {
        e.preventDefault(); marqueeHeld.current = true; setMarqueeKeyHeld(true); return
      }
      if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === host.current) {
        e.preventDefault()
        if (drag.current || pencil.current || editor.interactionActive || editor.state.busy) return
        const rect = host.current!.getBoundingClientRect(), view = editor.flushPendingView(), bounds = editor.selectionBounds()
        const center = bounds ? worldToScreen(view, { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }) : { x: rect.width / 2, y: rect.height / 2 }
        const anchor = { x: Math.max(8, Math.min(center.x, rect.width - 8)), y: Math.max(8, Math.min(center.y, rect.height - 8)) }
        const parents = editor.parentMap()
        setContextMenu({ x: rect.left + anchor.x, y: rect.top + anchor.y, worldPoint: screenToWorld(view, anchor), candidates: editor.state.selection.map(id => ({ id, name: editor.state.doc.nodes[id].name, locked: !interactivePath(editor.state.doc, editor.state.page, id, false, parents).length })) })
        return
      }
      const mod = e.metaKey || e.ctrlKey
      if(!mod&&e.shiftKey&&e.code==='KeyR'&&!drag.current){e.preventDefault();editor.set({rulers:!editor.state.rulers});return}
      if(e.altKey&&!mod&&e.code==='KeyR'&&!drag.current&&editor.topSelection().length){e.preventDefault();setOrigin(origin.current.point,!origin.current.visible);return}
      const creation = drag.current
      if (creation?.kind === 'create' && creation.creationSeed) {
        if (['Shift', 'Alt'].includes(e.key)) {
          updateCreation(creation, { shift: e.shiftKey, alt: e.altKey })
          return
        }
        if (['polygon', 'star'].includes(creation.creationSeed.kind) && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault()
          creation.creationSeed.points = creationPointCount(creation.creationSeed.points, e.key === 'ArrowUp' ? 1 : -1)
          updateCreation(creation, creation.modifiers!)
          return
        }
        if (e.key !== 'Escape' && e.code !== 'Space') return
      }
      if ((drag.current || pencil.current) && !['Escape', 'Shift', 'Alt'].includes(e.key) && e.code !== 'Space' &&
          !(pencil.current && mod && e.key.toLowerCase() === 'z')) {
        e.preventDefault()
        return
      }
      const mac = /Mac|iPhone|iPad/.test(navigator.platform)
      if (e.ctrlKey && e.key.toLowerCase() === 'p' && (mac || e.altKey)) {
        e.preventDefault()
        const s = editor.state
        editor.set({ pixelPreview: s.pixelPreview ? 0 : s.lastPixelPreview })
        return
      }
      if (mod && e.code === 'Quote') {
        e.preventDefault()
        if (e.shiftKey) editor.set({ snapPixels: !editor.state.snapPixels })
        else editor.set({ pixelGrid: !editor.state.pixelGrid })
        return
      }
      if (pencil.current && mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        cancelPencil()
        return
      }
      if (e.code === 'Space' && !mod && !e.altKey) {
        space.current = true
        setSpaceHeld(true)
        e.preventDefault()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelQueuedMove()
        marqueeHeld.current = false; setMarqueeKeyHeld(false)
        const cancelOnly = !!drag.current || !!pencil.current || !!penRef.current || editor.state.tool !== 'select'
        flushView()
        cancelPencil()
        setShapePreview(null)
        if(drag.current?.kind==='pivot'&&drag.current.originalPivot)setOrigin(drag.current.originalPivot)
        const cancelledDraft = drag.current
        editor.cancel()
        finishDragTrace(cancelledDraft, ActionOutcome.cancelled, ActionReason.escape)
        drag.current = null
        setPanning(false)
        setRubber(null)
        clearMoveGuides()
        setPen(null)
        penRef.current = null
        pendingEditsChanged(editor)
        editor.set({ tool: 'select', editingVertex: null })
        if (!cancelOnly && !(shortcutContext.profile === 'sketch-like' &&
            !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && editor.selectParent())) editor.clearSelection()
        editor.hoverLayer(null, 'canvas')
        // Restore last: select() publishes synchronously and may adopt a new
        // session or gesture. No old-owner cleanup may follow that notification.
        restoreCancelledMarqueeSelection(cancelledDraft)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) {
          if (penRef.current) finishPen()
          editor.set({ tool: 'select', editingVertex: null })
          editor.selectParent()
          return
        }
        if (editor.state.tool === 'vector') {
          editor.set({ tool: 'select', editingVertex: null })
          return
        }
        if (penRef.current) {
          finishPen()
          return
        }
        if (editor.selectChildren()) return
        if (editor.state.selection.length === 1) {
          const selected = editor.state.doc.nodes[editor.state.selection[0]]
          if (!editor.topSelection().includes(selected.id)) return
          if (selected.kind === 'text') setTextEdit(selected.id)
          else if (!['frame', 'section', 'group'].includes(selected.kind)) editor.set({ tool: 'vector', editingVertex: null })
        }
        return
      }
      if (e.key === 'Tab' && !mod && !e.altKey && editor.state.selection.length &&
        e.target === host.current) {
        e.preventDefault()
        if (penRef.current) { finishPen(); return }
        editor.selectSibling(e.shiftKey ? -1 : 1)
        return
      }
      if (penRef.current && !['Shift', 'Alt', 'Control', 'Meta'].includes(e.key) && e.code !== 'Space') finishPen()
      if (shortcut && isDimensionNudgeCommand(shortcut.command)) {
        e.preventDefault()
        if (['select', 'scale'].includes(editor.state.tool) && editor.topSelection().length) {
          const command = shortcut.command
          nudge.step(e, '键盘调整图层尺寸', () => nudgeSelectionDimensions(editor, command, true))
        }
        return
      }
      if (shortcut && !(shortcut.command === 'delete' && editor.state.tool === 'vector' && editor.state.editingVertex)) {
        nudge.finish()
        void dispatchEditorShortcut(editor, e, shortcutContext)
        return
      }
      if (!mod && !e.altKey && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault()
        if (editor.state.tool === 'vector' && editor.state.editingVertex) {
          const vertices = new Set(editor.state.editingVertices?.length?editor.state.editingVertices:[editor.state.editingVertex])
          editor.update(
            editor.state.selection,
            (n) => {
              if (!n.network) { n.network = editableNetwork(n); delete n.vectorGeometry; n.kind = 'vector'; delete n.arc; delete n.cornerRadius }
              if (n.network) {
                n.network.vertices = n.network.vertices.filter((p) => !vertices.has(p.id))
                n.network.edges = n.network.edges.filter((e) => !vertices.has(e.from) && !vertices.has(e.to))
                if(n.network.filledFaces){const edges=new Set(n.network.edges.map(e=>e.id));n.network.filledFaces=n.network.filledFaces.filter(f=>f.every(id=>edges.has(id)))}
              }
            },
            '删除矢量节点',
          )
          editor.set({ editingVertex: null, editingVertices:[] })
        } else editor.remove()
      } else if (!mod && !e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        if (editor.state.busy || (editor.interactionActive && !nudge.active)) return
        const preference = nudgePreference.getSnapshot(), amount = e.shiftKey ? preference.big : preference.small
        if (editor.state.tool === 'vector' && editor.state.editingVertex) {
          const vertices=editor.state.editingVertices?.length?editor.state.editingVertices:[editor.state.editingVertex]
          nudge.step(e, '微移矢量节点', () => editor.update(editor.topSelection(), n => {
            const inv = inverse(worldMatrix(editor.state.doc, n.id))
            const dx = e.key === 'ArrowLeft' ? -amount : e.key === 'ArrowRight' ? amount : 0
            const dy = e.key === 'ArrowUp' ? -amount : e.key === 'ArrowDown' ? amount : 0
            const delta = { x: inv[0] * dx + inv[2] * dy, y: inv[1] * dx + inv[3] * dy }
            if (!n.network) { n.network = editableNetwork(n); delete n.vectorGeometry; n.kind = 'vector'; delete n.arc; delete n.cornerRadius }
            n.network=translateVertices(n.network,vertices,delta)
          }, '微移矢量节点'))
        } else if (!editor.state.selection.length) {
          // Fold any parked wheel camera first so the nudge starts from what
          // the user currently sees, not the pre-gesture committed camera.
          const view = editor.flushPendingView(), amount = e.shiftKey ? 100 : 20
          editor.set({ view: { ...view, x: view.x + (e.key === 'ArrowLeft' ? amount : e.key === 'ArrowRight' ? -amount : 0),
            y: view.y + (e.key === 'ArrowUp' ? amount : e.key === 'ArrowDown' ? -amount : 0) } })
        } else if (editor.topSelection().length) nudge.step(e, '微移图层', () => editor.transformSelection(
          translate(
            e.key === 'ArrowLeft' ? -amount : e.key === 'ArrowRight' ? amount : 0,
            e.key === 'ArrowUp' ? -amount : e.key === 'ArrowDown' ? amount : 0,
          ),
          '微移图层',
        ))
      }
    }
    const up = (e: KeyboardEvent) => {
      nudge.release(e.key)
      if (e.code === 'KeyX' || e.key.toLowerCase() === 'x') { marqueeHeld.current = false; setMarqueeKeyHeld(false) }
      if(['Alt','Meta','Control'].includes(e.key))setMeasureKeys({alt:e.altKey,deep:e.metaKey||e.ctrlKey})
      if (['Shift', 'Alt', 'Control', 'Meta'].includes(e.key) && replayDragModifiers(e)) return
      if (e.code === 'Space') { space.current = false; setSpaceHeld(false) }
      if (drag.current?.kind === 'create' && ['Shift', 'Alt'].includes(e.key))
        updateCreation(drag.current, { shift: e.shiftKey, alt: e.altKey })
    }
    const blur = () => {
      desktopPet.stopNavigation()
      nudge.finish()
      cancelQueuedMove()
      wheelModifiers.current = { ctrl: false, meta: false }
      setMeasureKeys({alt:false,deep:false})
      if(drag.current?.kind==='pivot'&&drag.current.originalPivot)setOrigin(drag.current.originalPivot)
      flushView()
      cancelPencil()
      setShapePreview(null)
      space.current = false
      marqueeHeld.current = false; setMarqueeKeyHeld(false)
      setSpaceHeld(false); setPanning(false)
      editor.cancel()
      finishDragTrace(drag.current, ActionOutcome.cancelled, ActionReason.sessionEnd)
      drag.current = null
      setRubber(null)
      hoverPoint.current = null
      editor.hoverLayer(null, 'canvas')
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    const releaseMarquee = () => { marqueeHeld.current = false; setMarqueeKeyHeld(false) }
    const visibility = () => { if (document.hidden) { releaseMarquee(); nudge.finish() } }
    const focus = (e: FocusEvent) => { if (e.target !== host.current) nudge.finish(); if (shortcutTargetOwnsKeyboard(e.target)) releaseMarquee() }
    const pointer = () => { nudge.finish() }
    const unsubscribeNudge = nudgePreference.subscribe(() => { nudge.finish() })
    const unsubscribeProfile = shortcutPreference.subscribe(() => {
      nudge.finish()
      if (shortcutPreference.getSnapshot() !== 'sketch-like') releaseMarquee()
    })
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('focusin', focus)
    window.addEventListener('pointerdown', pointer, true)
    return () => {
      nudge.dispose()
      unsubscribeNudge()
      window.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('focusin', focus)
      unsubscribeProfile()
    }
  }, [editor])
  useEffect(() => {
    const el = host.current!
    const wheelGesture=new WheelCameraGesture()
    let wheelScope=''
    const wheel = (e: WheelEvent) => {
      if (pencil.current || (drag.current && drag.current.kind !== 'pan')) {
        e.preventDefault()
        return
      }
      if ((e.target as HTMLElement).closest('.canvas-controls')) return
      e.preventDefault()
      hoverPoint.current = { x: e.clientX, y: e.clientY }
      suspendNavigationHover()
      // Coalesced base: wheel deltas are incremental, so accumulate against
      // the pending write instead of the last committed editor view.
      const v = pendingBase()
      // A native Chromium pinch synthesizes ctrlKey without a physical Ctrl
      // keydown. Track keyboard modifiers separately so Ctrl/⌘+wheel keeps
      // its mouse-wheel step instead of being magnified as a pinch.
      const pinch = isNativePinch(e, wheelModifiers.current)
      const wheelSize = { width: el.clientWidth, height: el.clientHeight }
      const scope=`${editor.sessionGeneration}/${editor.state.page}`
      if(scope!==wheelScope){wheelGesture.reset();wheelScope=scope}
      const next = wheelGesture.update(v, e, wheelSize, screenPoint(e), editor.state.scrollWheelZoom, pinch)
      if (drag.current?.kind === 'pan') {
        const d = drag.current
        // Retain the pointer displacement already consumed by this gesture.
        d.view = { ...next, x: d.view.x + next.x - v.x, y: d.view.y + next.y - v.y }
      }
      recordNavigationInput(editor, e, wheelSize, next, pinch)
      scheduleView(next)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    const modifiers = (e: KeyboardEvent) => { wheelModifiers.current = { ctrl: e.ctrlKey, meta: e.metaKey } }
    window.addEventListener('keydown', modifiers, true)
    window.addEventListener('keyup', modifiers, true)
    return () => {
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('keydown', modifiers, true)
      window.removeEventListener('keyup', modifiers, true)
    }
  }, [editor,nativeSource,presentedSignal])
  function fitView(onlySelection = false) {
    if (pencil.current || drag.current) return
    flushView()
    if(nativeSource){editor.set({view:fitBounds(nativeSource.bounds,size)});return}
    const relevant = onlySelection ? selected : entries.filter((e) => e.depth === 0)
    if (!relevant.length) return
    const b = unionBounds(relevant.map((e) => e.bounds))
    editor.set({ view: fitBounds(b, size) })
  }
  function updateCreation(d: Drag, modifiers: { shift: boolean; alt: boolean }) {
    if (!d.creationSeed || !d.pointer) return
    d.modifiers = modifiers
    // Both the exact kernel preview and the committed object use this same
    // geometry. An in-progress drawing never enters the saved document.
    const result = resolveShapeCreation(d.creationSeed, {
      anchor: d.start, pointer: d.pointer, screenDistance: d.screenDistance || 0,
      ...modifiers, snap: editor.state.snapPixels || ['frame', 'section'].includes(d.creationSeed.kind),
    })
    setShapePreview(result.node)
    setRubber(result.bounds)
    return result.node
  }
  function start(
    e: React.PointerEvent,
    kind?: Drag['kind'],
    handle?: number,
    nodeId?: string,
    vertex?: string,
    edgeId?: string,
    control?: 'c1' | 'c2',
  ) {
    // React portals bubble through Canvas even when their DOM lives in a
    // sidebar. Only physical canvas targets can adopt the displayed camera.
    const target = e.target as Element
    if (!host.current?.contains(target) || target.closest('button,input,select,textarea,[contenteditable="true"],.canvas-controls,.canvas-scrollbars,.pencil-controls,.rich-text-editor')) return
    if ((kind === 'resize' || kind === 'rotate') && state.tool === 'select' &&
        smallSelectionInterior(selectionCorners, displayViewRef.current.zoom,
          screenToWorld(displayViewRef.current, screenPoint(e)))) kind = 'move'
    if (textEdit) {
      actionTrace.event(CanvasAction.pointer, ActionSource.pointer, ActionOutcome.blocked, ActionReason.editingText)
      host.current?.focus({ preventScroll: true })
      return
    }
    if (e.button === 0 && e.ctrlKey && /Mac|iPhone|iPad/.test(navigator.platform)) return
    const navigation = e.button === 1 || space.current || editor.state.tool === 'hand'
    if ((!navigation && (editor.state.busy || !geometryReady)) || (e.button !== 0 && e.button !== 1)) {
      actionTrace.event(CanvasAction.pointer, ActionSource.pointer, ActionOutcome.blocked, editor.state.busy ? ActionReason.busy : !geometryReady ? ActionReason.notReady : ActionReason.unsupported)
      return
    }
    if (pencil.current || drag.current || !e.isPrimary) { actionTrace.event(CanvasAction.pointer, ActionSource.pointer, ActionOutcome.blocked, ActionReason.wrongOwner); return }
    if (kind && !displayedSnapshot) { actionTrace.event(CanvasAction.pointer, ActionSource.pointer, ActionOutcome.blocked, ActionReason.notReady); return }
    if (nodeId && !editor.topSelection().includes(nodeId)) { actionTrace.event(CanvasAction.pointer, ActionSource.pointer, ActionOutcome.blocked, editor.state.doc.nodes[nodeId]?.locked ? ActionReason.locked : ActionReason.noTarget); return }
    e.preventDefault()
    host.current!.focus({ preventScroll: true })
    // A pending revision must not drop the next gesture. Creation uses the
    // displayed camera; selection uses the displayed snapshot and live IDs.
    // A different page/session is a separate loading boundary, never a target.
    if (!displayedSnapshot && editor.state.tool !== 'hand' && !space.current && e.button !== 1) return
    // Handles stop propagation and bypass the host's pointerdown handler.
    // Retire the hover frame before its ownership is replaced by this drag.
    cancelQueuedMove()
    host.current!.setPointerCapture(e.pointerId)
    actionTrace.event(CanvasAction.grab, ActionSource.pointer, ActionOutcome.observed, ActionReason.none, { modifiers: modifierBits(e), lockedCount: actionTrace.enabled ? editor.state.selection.filter(id => editor.state.doc.nodes[id]?.locked).length : 0 })
    const capturedView = { ...displayViewRef.current }
    const p = screenToWorld(capturedView, screenPoint(e)),
      screen = screenPoint(e),
      s = editor.state
    if (navigation) {
      // Navigation needs no selection bounds, hierarchy walk or editable
      // snapshot. Keep it responsive while geometry/refinement is pending.
      drag.current = { pointerId: e.pointerId, session: editor.sessionGeneration, page: s.page,
        kind: 'pan', start: p, screen, view: editor.flushPendingView(), ids: [], matrices: {}, box: emptyBox, originSelection: s.selection }
      beginDragTrace(drag.current, e)
      setPanning(true); editor.hoverLayer(null, 'canvas')
      return
    }
    // Deliberately no camera pull-back: when the displayed camera lags the
    // committed one (refinement in flight), overwriting state.view with the
    // displayed camera silently rolled back the user's zoom. Gestures work in
    // displayed space; the surface catches the committed camera up on its own.
    if (!space.current && e.button===0 && !kind && utility.start(e,p,capturedView.zoom)) { if(!utility.active()&&host.current?.hasPointerCapture(e.pointerId))host.current.releasePointerCapture(e.pointerId); return }
    if (['pencil', 'brush', 'marker', 'washi-tape'].includes(s.tool) && !space.current && e.button === 0 && !kind) {
      const tool = s.tool as FreehandTool
      if (e.metaKey || e.ctrlKey) {
        const hit = displayedHit(p, true)
        const stroke = hit && displayedSnapshot?.document.nodes[hit]?.strokes.find(stroke => stroke.paint.visible)
        if (stroke && stroke.paint.kind === 'solid' && /^#[0-9a-f]{6}$/i.test(stroke.paint.color)) {
          editor.set({ [tool]: { ...s[tool], width: Math.max(0.5, Math.min(200, stroke.width)), color: stroke.paint.color } })
          editor.notify('已取样描边颜色与宽度')
        } else editor.notify('请点击带有纯色描边的图层取样')
        return
      }
      const rect = host.current!.getBoundingClientRect(),
        view = { ...displayViewRef.current }
      const map = (event: { clientX: number; clientY: number }) =>
        screenToWorld(view, { x: event.clientX - rect.left, y: event.clientY - rect.top })
      const input = new PencilInput(e.pointerId, s[tool].pressure)
      input.append([e.nativeEvent], map)
      editor.begin(tool === 'pencil' ? '绘制铅笔路径' : '绘制画笔路径')
      pencil.current = { actionToken: actionTrace.begin(CanvasAction.create, ActionSource.pointer, {routeSupported:true,geometrySupported:false}), actionRevision:editor.state.version, input, map, id: uid(), settings: { ...s[tool] }, tool, zoom: view.zoom, session:editor.sessionGeneration, page:s.page }
      pencilFrame.current = requestAnimationFrame(pencilPreviewFrame)
      return
    }
    if (s.tool === 'pen' && !space.current && e.button === 0 && !kind) {
      let draft = penRef.current
      const continuingDraft = !!draft
      const selectedNode = s.selection.length === 1 ? s.doc.nodes[s.selection[0]] : null
      if (!draft && selectedNode?.network && editor.topSelection().includes(selectedNode.id))
        draft = {
          session: editor.sessionGeneration, page: s.page,
          id: selectedNode.id,
          network: structuredClone(selectedNode.network),
          last: null,
          first: null,
        }
      if (!draft)
        draft = {
          session: editor.sessionGeneration, page: s.page,
          network: { vertices: [], edges: [], fillRule: 'evenodd' },
          last: null,
          first: null,
        }
      const anchor = s.snapPixels && !e.ctrlKey ? kernelSnapPoint(p) : p
      const local = draft.id ? apply(inverse(worldMatrix(s.doc, draft.id)), anchor) : anchor
      const shown = draft.id && !continuingDraft ? displayedSnapshot?.document.nodes[draft.id] : null
      const near = draft.id && !continuingDraft
        ? shown?.network ? presentedPenVertex(draft.network, shown.network, worldMatrix(displayedSnapshot!.document, draft.id), anchor, zoom) : undefined
        : presentedPenVertex(draft.network, draft.network, draft.id ? worldMatrix(s.doc, draft.id) : [1, 0, 0, 1, 0, 0], anchor, zoom)
      const v = near || { id: uid(), ...local }
      if (!near) draft.network.vertices.push(v)
      if (
        draft.last &&
        draft.last !== v.id &&
        !draft.network.edges.some((edge) => edge.from === draft!.last && edge.to === v.id)
      ) {
        draft.network.edges.push({
          id: uid(),
          from: draft.last,
          to: v.id,
          ...(draft.outgoing ? { c1: draft.outgoing } : {}),
        })
      }
      draft = { ...draft, last: v.id, first: draft.first || v.id, outgoing: undefined }
      setPen(draft)
      penRef.current = draft
      pendingEditsChanged(editor)
      drag.current = {
        pointerId: e.pointerId,
        session: editor.sessionGeneration, page: s.page,
        kind: 'vertex',
        start: local,
        screen,
        view: capturedView,
        ids: [],
        matrices: {},
        box: emptyBox,
        vertex: v.id,
        originSelection: [],
      }
      beginDragTrace(drag.current, e)
      return
    }
    if (e.button === 0 && !space.current && !kind && s.tool === 'crop') {
      const top = editor.topSelection()
      const target = top.length === 1 ? editor.state.doc.nodes[top[0]] : null
      if (!target || !target.fills.some((f) => f.kind === 'image' && f.visible && f.image)) {
        editor.notify('裁切需要选中一个包含图片填充的图层')
        return
      }
      if (target.network) {
        editor.notify('矢量图层请先转换为矩形图片后再裁切')
        return
      }
      drag.current = {
        pointerId: e.pointerId,
        session: editor.sessionGeneration, page: s.page,
        kind: 'crop',
        start: p,
        screen,
        view: capturedView,
        ids: [target.id],
        matrices: { [target.id]: worldMatrix(editor.state.doc, target.id) },
        box: emptyBox,
        node: structuredClone(target),
        originSelection: s.selection,
      }
      beginDragTrace(drag.current, e)
      setCropRect(null)
      return
    }
    let dragKind = kind === 'resize' && s.tool === 'scale' ? 'scale' as const : kind || 'move',
      ids = editor.topSelection()
    let clickSelection: string[] | null = null
    if (e.button === 1 || space.current || s.tool === 'hand') { dragKind = 'pan'; setPanning(true); editor.hoverLayer(null, 'canvas') }
    else if (kind === 'marquee') { ids = []; setRubber({ ...p, width: 0, height: 0 }) }
    else if(!kind&&s.tool==='zoom'){dragKind='zoom';setRubber({...p,width:0,height:0})}
    else if (!kind && !['select', 'multiselect', 'scale', 'vector', 'width'].includes(s.tool)) {
      dragKind = 'create'
      ids = []
      setRubber({ ...p, width: 0, height: 0 })
    } else if (!kind) {
      const titleId = ['select','multiselect','scale'].includes(s.tool)
        ? target.closest('[data-frame-title]')?.getAttribute('data-frame-title') : null
      const title = frameTitleHit(s.doc,s.page,titleId)
      if(titleId&&!title){host.current?.releasePointerCapture(e.pointerId);return}
      const hit = title || (displayedSnapshot && displayedIndex
        ? editor.selectionHit(p, e.metaKey || e.ctrlKey || s.tool === 'vector', displayedIndex, displayViewRef.current.zoom, displayedSnapshot) : null)
      const selectedNode = s.selection.length === 1 && ids.length === 1 ? s.doc.nodes[ids[0]] : null
      const intentOptions = { inside: pointInContours(p, [selectionCorners]), deep: e.metaKey || e.ctrlKey || s.tool === 'vector',
        additive: e.shiftKey || s.tool === 'multiselect',
        readOnly: selectionFeedback.readOnly || !['select', 'scale'].includes(s.tool) }
      const groupIntent = selectedGroupDragIntent(selectedNode, hit, intentOptions) ||
        selectedChildDragIntent(selectedNode, hit, selected.find(entry => entry.id === selectedNode?.id)?.ancestors || [], intentOptions)
      const containerHit=hit&&selected.length>1&&selected.every(entry=>entry.ancestors.includes(hit))
      const gap = (!hit||containerHit) && ids.length>1 && !e.metaKey && !e.ctrlKey && ['select','scale'].includes(s.tool) && contains(selectionBox,p)
      const intent = groupIntent || selectionPointerDown(s.selection, gap?null:hit, e.shiftKey || s.tool==='multiselect',!!gap)
      const selectionChanged = actionTrace.enabled && (s.selection.length !== intent.selection.length || s.selection.some((id, i) => id !== intent.selection[i]))
      if (actionTrace.enabled) actionTrace.event(CanvasAction.hitTest, ActionSource.pointer, ActionOutcome.observed, ActionReason.none, {
        hitCount: hit ? 1 : 0, hitDepth: hit ? entries.find(entry => entry.id === hit)?.ancestors.length || 0 : 0,
        modifiers: modifierBits(e), lockedCount: hit && s.doc.nodes[hit]?.locked ? 1 : 0,
      })
      editor.select(intent.selection)
      actionTrace.event(CanvasAction.selection, ActionSource.pointer, selectionChanged ? ActionOutcome.observed : ActionOutcome.unchanged, ActionReason.none, {
        selectionBefore: s.selection.length, selectionAfter: editor.state.selection.length, selectionChanged,
        resolvedCommittedComparison: editor.state.selection.length === intent.selection.length && editor.state.selection.every((id,i) => id === intent.selection[i]) ? 1 : 2,
      })
      clickSelection = intent.clickSelection
      if (hit || groupIntent || (gap&&!e.shiftKey)) {
        ids = editor.topSelection()
      } else {
        dragKind = 'marquee'
        setRubber({ ...p, width: 0, height: 0 })
      }
    }
    const sourceDocument=editor.state.doc,sourceParents=editor.parentMap(sourceDocument)
    const sourceEntries=sourceDocument===state.doc?entries:scene(sourceDocument,s.page)
    const matrices = Object.fromEntries(ids.map((id) => [id, worldMatrix(sourceDocument, id,sourceParents)]))
    const selectedIds = new Set(ids)
    const currentBox = unionBounds(
      sourceEntries
        .filter((v) => selectedIds.has(v.id))
        .map((v) => v.bounds),
    )
    drag.current = {
      pointerId: e.pointerId,
      session: editor.sessionGeneration, page: s.page,
      kind: dragKind,
      creationTool: s.tool,
      start: p,
      screen,
      view: dragKind === 'pan' ? editor.flushPendingView() : capturedView,
      ids,
      originalIds: [...ids], sourceDocument, sourceParents, sourceEntries,
      parentMatrices: Object.fromEntries(ids.map(id=>[id,worldMatrix(sourceDocument,sourceParents.get(id)!,sourceParents)])),
      matrices,
      sizes: Object.fromEntries(
        ids.map((id) => {
          const n = editor.state.doc.nodes[id]
          return [
            id,
            {
              width: n.width,
              height: n.height,
              transform: [...n.transform] as Matrix,
              sizing: n.sizing,
              network: n.network,
            },
          ]
        }),
      ),
      box: currentBox,
      basis:
        ['resize', 'scale', 'rotate'].includes(dragKind) && ids.length === 1 && canOrient
          ? matrices[ids[0]]
          : undefined,
      localBox:
        ['resize', 'scale', 'rotate'].includes(dragKind) && ids.length === 1 && canOrient
          ? localSelection || undefined
          : undefined,
      handle,
      ...(['rotate','pivot'].includes(dragKind)?{rotationCenter:originWorld(),originalPivot:{...origin.current.point}}:{}),
      node: nodeId ? { ...structuredClone(s.doc.nodes[nodeId]), ...(['vertex', 'handle'].includes(dragKind) ? { network: editableNetwork(s.doc.nodes[nodeId]) } : {}) } : undefined,
      vertex,
      vertices:vertex?(s.editingVertices?.includes(vertex)?[...s.editingVertices]:e.shiftKey?[...new Set([...(s.editingVertices||[]),vertex])]:[vertex]):undefined,
      edge: edgeId,
      control,
      additive: e.shiftKey || s.tool==='multiselect',
      ...(dragKind === 'marquee' ? {
        sketchMarquee: shortcutPreference.getSnapshot() === 'sketch-like',
        forcedMarquee: kind === 'marquee',
        // Sketch's forced marquee ignores its starting layer and reaches
        // nested content without requiring an additional deep-select chord.
        marqueeIgnoreId: kind === 'marquee' ? displayedHit(p, true) : null,
      } : {}),
      originSelection: [...s.selection],
      clickSelection, moved: false,
      lastScreen: screen,
      lastModifiers: { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey },
      ...(dragKind === 'move' && ids.length === 1 && displayedSnapshot?.document.nodes[ids[0]] ? {
        layoutPointerOrigin: remapPointerAnchor(worldMatrix(displayedSnapshot.document, ids[0]), matrices[ids[0]], p),
      } : {}),
      ...(dragKind === 'marquee' && displayedIndex ? { pickIndex: displayedIndex } : {}),
      ...(dragKind === 'create' ? {
        creationSeed: createShapeSeed(s.tool as ShapeCreationKind), creationTool:s.tool, pointer: p,
        screenDistance: 0, modifiers: { shift: e.shiftKey, alt: e.altKey },
      } : {}),
    }
    beginDragTrace(drag.current, e)
    if (dragKind === 'create') editor.begin('绘制形状')
    if (['move', 'resize', 'scale', 'rotate', 'vertex', 'handle'].includes(dragKind))
      editor.begin(
        {
          move: '移动图层',
          resize: '缩放图层',
          scale: '等比缩放图层',
          rotate: '旋转图层',
          vertex: '移动矢量节点',
          handle: '调整贝塞尔曲线',
        }[dragKind as 'move'],
      )
    if (vertex) editor.set({ editingVertex: vertex, editingVertices:drag.current?.vertices||[vertex] })
  }
  function move(e: React.PointerEvent) {
    return actionTrace.cpu.run(CpuStage.pointerMove, () => moveImpl(e), drag.current?.actionToken, actionTrace.enabled && queuedInputAt.current ? performance.now() - queuedInputAt.current : undefined)
  }
  function moveImpl(e: React.PointerEvent) {
    editInputAt.current = queuedInputAt.current || performance.now()
    if (!drag.current && !pencil.current && !utility.active() && e.target instanceof Element &&
      (!host.current?.contains(e.target) || e.target.closest(canvasChromeSelector))) {
      hoverPoint.current = null; editor.pointerLocation = null; editor.pointerScreen = null; editor.hoverLayer(null, 'canvas'); return
    }
    editor.pointerScreen=screenPoint(e)
    editor.pointerLocation=world(e)
    if (utility.move(e,world(e))) return
    if (pencil.current) {
      const draft = pencil.current
      if (e.pointerId !== draft.input.pointerId) return
      try {
        const events = e.nativeEvent.getCoalescedEvents?.() || []
        draft.input.append(events.length ? events : [e.nativeEvent], draft.map, false, e.shiftKey)
        if (pencilFrame.current === null)
          pencilFrame.current = requestAnimationFrame(pencilPreviewFrame)
      } catch (error) {
        cancelPencil()
        editor.notify(String(error))
      }
      return
    }
    if (drag.current && drag.current.pointerId !== e.pointerId) return
    if (drag.current && (drag.current.session !== editor.sessionGeneration || drag.current.page !== editor.state.page)) return
    const p = drag.current && drag.current.kind !== 'pan' ? screenToWorld(drag.current.view, screenPoint(e)) : world(e)
    hoverPoint.current = { x: e.clientX, y: e.clientY }
    cursorPoint.current = p
    // Plain hover is represented by the editor's stable hit id. Only tools
    // that draw a pointer-position overlay need a React coordinate update.
    if (penRef.current || drag.current?.kind === 'rotate' || e.altKey && editor.state.tool === 'select')
      setCursor(previous => previous?.x === p.x && previous.y === p.y ? previous : p)
    const d = drag.current
    if (!d) {
      setMeasureKeys(previous=>previous.alt===e.altKey&&previous.deep===(e.metaKey||e.ctrlKey)?previous:{alt:e.altKey,deep:e.metaKey||e.ctrlKey})
      editor.hoverLayer(performance.now() >= navigationUntil.current && !textEdit && !space.current && ['select', 'multiselect', 'scale', 'vector', 'width'].includes(editor.state.tool)
        // Hover identifies the visible object, independently of the entered
        // selection hierarchy. Imported wrapper groups can otherwise put the
        // only outline outside the viewport and hide the text under the cursor.
        ? displayedHoverHit(p) : null, 'canvas')
      return
    }
    d.lastInput = e
    d.lastScreen = screenPoint(e)
    d.lastModifiers = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey }
    d.sampledMovement ||= d.lastScreen.x !== d.screen.x || d.lastScreen.y !== d.screen.y
    if (d.actionToken) actionTrace.sample(d.actionToken, { inputSamples: d.actionSamples = (d.actionSamples || 0) + 1, motionObserved: !!d.sampledMovement, modifiers: modifierBits(e) })
    if(d.kind==='pivot'){setOrigin(originFromWorld(p),true);return}
    if (d.kind === 'parameter' && d.node) {
      if (!d.sampledMovement) return
      if (d.parameter?.startsWith('arc')) {
        const local = apply(inverse(d.matrices[d.node.id]), p)
        const origin = apply(inverse(d.matrices[d.node.id]), d.start)
        const unit = (point: Point) => ({ x: (point.x - d.node!.width / 2) / (d.node!.width / 2), y: (point.y - d.node!.height / 2) / (d.node!.height / 2) })
        const at = unit(local), from = unit(origin)
        const arc = { startAngle: 0, sweepAngle: Math.PI * 2, innerRadius: 0, ...d.node.arc }
        let delta = Math.atan2(at.y, at.x) - Math.atan2(from.y, from.x)
        delta = Math.atan2(Math.sin(delta), Math.cos(delta))
        if (e.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * Math.PI / 12
        if (d.parameter === 'arcStart') arc.startAngle += delta
        if (d.parameter === 'arcSweep') arc.sweepAngle = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, arc.sweepAngle + delta))
        if (d.parameter === 'arcInner') arc.innerRadius = Math.max(0, Math.min(1, arc.innerRadius + Math.hypot(at.x, at.y) - Math.hypot(from.x, from.y)))
        editor.preview({ [d.node.id]: { arc } }); return
      }
      if (d.parameter === 'cornerRadius') {
        editor.preview({ [d.node.id]: { cornerRadius: Math.max(0, (d.node.cornerRadius ?? 0) + (d.screen.y - screenPoint(e).y) / d.view.zoom) } }); return
      }
      if (d.parameter === 'points') {
        editor.preview({ [d.node.id]: { points: creationPointCount(d.node.points, Math.round((d.screen.y - screenPoint(e).y) / 12)) } })
      } else {
        const local = apply(inverse(d.matrices[d.node.id]), p)
        const dx = (local.x - d.node.width / 2) / (d.node.width / 2)
        const dy = (local.y - d.node.height / 2) / (d.node.height / 2)
        editor.preview({ [d.node.id]: { innerRadius: Math.max(0.01, Math.min(0.99, Math.hypot(dx, dy))) } })
      }
      return
    }
    if (d.kind === 'width' && d.node && d.widthHandle && d.widthSide) {
      const local = apply(inverse(d.matrices[d.node.id]), p),
        origin = apply(inverse(d.matrices[d.node.id]), d.start),
        h = d.widthHandle
      const strokes = structuredClone(d.node.strokes),
        st = strokes[d.widthIndex!]
      const factor = (st.width / 2) * (st.align === 'center' ? 1 : 2)
      const value = Math.max(
        0,
        Math.min(
          4,
          st.widthProfile![h.index][d.widthSide] +
            (((local.x - origin.x) * h.normal.x + (local.y - origin.y) * h.normal.y) *
              (d.widthSide === 'left' ? 1 : -1)) /
              Math.max(0.0001, factor),
        ),
      )
      const point = st.widthProfile![h.index]
      point[d.widthSide] = value
      if (e.shiftKey) point[d.widthSide === 'left' ? 'right' : 'left'] = value
      const ps = st.widthProfile!
      if (
        profileTopology(d.node).closed &&
        ps[0].position === 0 &&
        ps.at(-1)!.position === 1 &&
        h.index === 0
      )
        ps[ps.length - 1] = { ...ps[0], position: 1 }
      editor.preview({ [d.node.id]: { strokes } })
      return
    }
    if (penRef.current && d.kind === 'vertex' && !d.node) {
      const pen = structuredClone(penRef.current)
      const local = pen.id ? apply(inverse(worldMatrix(editor.state.doc, pen.id)), p) : p
      const v = pen.network.vertices.find((v) => v.id === d.vertex)!
      if (distance(local, d.start) > 2 / zoom) {
        pen.outgoing = { x: v.x + local.x - d.start.x, y: v.y + local.y - d.start.y }
        const previous = pen.network.edges.find((edge) => edge.to === v.id)
        if (previous) previous.c2 = { x: 2 * v.x - pen.outgoing.x, y: 2 * v.y - pen.outgoing.y }
        setPen(pen)
        penRef.current = pen
      }
      return
    }
    if (d.kind === 'pan') {
      const now = screenPoint(e)
      scheduleView({ ...d.view, x: d.view.x + now.x - d.screen.x, y: d.view.y + now.y - d.screen.y })
      return
    }
    if (d.kind === 'crop' && d.node) {
      const live = editor.state.doc.nodes[d.node.id]
      if (!live) return
      const clampLocal = (point: Point) => {
        const local = apply(inverse(d.matrices[d.node!.id]), point)
        return { x: Math.max(0, Math.min(live.width, local.x)), y: Math.max(0, Math.min(live.height, local.y)) }
      }
      setCropRect(createBox(clampLocal(d.start), clampLocal(p), false))
      return
    }
    if (d.kind === 'create' || d.kind === 'marquee' || d.kind==='zoom') {
      if (d.kind === 'create') {
        d.pointer = p
        d.screenDistance = Math.max(d.screenDistance || 0, distance(screenPoint(e), d.screen))
        updateCreation(d, { shift: e.shiftKey, alt: e.altKey })
      } else setRubber(createBox(d.start, p, false))
      return
    }
    if (d.kind === 'vertex' || d.kind === 'handle') {
      if (!d.node?.network) return
      const screen = screenPoint(e)
      if (screen.x === d.screen.x && screen.y === d.screen.y) {
        const originalNetwork = d.sizes?.[d.node.id]?.network
        if (editor.state.doc.nodes[d.node.id].network !== originalNetwork)
          editor.preview({ [d.node.id]: { ...d.node, network: originalNetwork } })
        return
      }
      const n = d.node,
        network = structuredClone(n.network)!
      const pointer =
        d.kind === 'vertex' && editor.state.snapPixels && !e.ctrlKey ? kernelSnapPoint(p) : p
      const local = apply(inverse(worldMatrix(editor.state.doc, n.id)), pointer),
        start = apply(inverse(worldMatrix(editor.state.doc, n.id)), d.start),
        delta = { x: local.x - start.x, y: local.y - start.y }
      if (d.kind === 'vertex' && delta.x === 0 && delta.y === 0) return
      if (d.kind === 'vertex') {
        Object.assign(network,translateVertices(network,d.vertices||[d.vertex!],delta))
      } else {
        const edge = network.edges.find((edge) => edge.id === d.edge)!
        if (edge[d.control!]?.x === local.x && edge[d.control!]?.y === local.y) return
        edge[d.control!] = local
      }
      // A real point edit replaces precise render curves, never adds a second
      // authority. d.node retains the authored curves for return-to-origin.
      editor.preview({ [n.id]: { network, vectorGeometry: undefined, kind: 'vector', arc: undefined, cornerRadius: undefined } })
      return
    }
    let transform: Matrix = translate(p.x - d.start.x, p.y - d.start.y)
    let moveGuides: MoveGuides = {}
    if (d.kind !== 'move') clearMoveGuides()
    if (d.kind === 'move') {
      d.moved = dragThresholdPassed(d.screen, screenPoint(e), !!d.moved)
      if (d.actionToken) actionTrace.sample(d.actionToken, { thresholdPassed: !!d.moved })
      if (!d.moved) return
      if (e.altKey !== !!d.duplicating) {
        try {
          d.ids = editor.moveDuplication(e.altKey, d.originalIds || d.ids)
          d.duplicating = e.altKey
          // Duplication changes topology; share one fresh map for this sample.
          const parents = editor.parentMap()
          d.matrices = Object.fromEntries(d.ids.map(id => [id, worldMatrix(editor.state.doc, id, parents)]))
          d.parentMatrices = Object.fromEntries(d.ids.map(id=>[id,worldMatrix(editor.state.doc,parents.get(id)!,parents)]))
          d.layoutPointerOrigin = undefined
        } catch (error) {
          editor.notify(String(error)); editor.cancel(); finishDragTrace(drag.current, ActionOutcome.rejected, ActionReason.validation); drag.current = null; return
        }
      }
      const layoutPointer = d.layoutPointerOrigin ? {
        x: d.layoutPointerOrigin.x + p.x - d.start.x,
        y: d.layoutPointerOrigin.y + p.y - d.start.y,
      } : p
      const free = d.ids.some(id => !insideParentFrame(d.sourceDocument || editor.state.doc, id, p, d.sourceParents))
      if (!d.duplicating) editor.previewFreeMove(d.ids, free)
      if (!free && !d.duplicating && d.ids.length === 1 && editor.previewLayoutOrder(d.ids[0], layoutPointer)) {
        clearMoveGuides()
        return
      }
      let dx = p.x - d.start.x,
        dy = p.y - d.start.y
      const horizontal = Math.abs(dx) > Math.abs(dy),
        moveAxes = { x: !e.shiftKey || horizontal, y: !e.shiftKey || !horizontal }
      if (!moveAxes.x) dx = 0
      if (!moveAxes.y) dy = 0
      let guidedX = false,
        guidedY = false
      let snapResult: SmartSnapResult | undefined
      if (editor.state.snap && !e.ctrlKey) {
        const targetKey=d.ids.join(',')
        if (!guideIndex.current || guideIndex.current.drag!==d ||
            guideIndex.current.rulers!==editor.state.rulers || guideIndex.current.ids!==targetKey) {
          releaseGuideIndex()
        // Moving previews cannot move the gesture's own snap targets. Retain
        // the original world envelopes until the gesture/duplicate set changes.
        const targetEntries=d.sourceEntries||entries,targetDocument=d.sourceDocument||editor.state.doc
        const movingIds = new Set(d.ids)
        // The kernel owns candidate collection and best-delta selection over
        // the dragged world rect; the canvas only supplies sibling rects
        // (every other on-page entry, ruler guides included as zero-width/
        // zero-height rectangles) and applies the returned correction.
        const others = targetEntries.filter(
          (v) => !movingIds.has(v.id) && !v.ancestors.some((id) => movingIds.has(id)),
        )
        const movingEntry = targetEntries.find((v) => v.id === (d.originalIds?.[0]||d.ids[0])),
          parentId = d.ids.length === 1 ? movingEntry?.ancestors.at(-1) : undefined,
          parent = parentId ? targetEntries.find((v) => v.id === parentId)?.bounds : undefined
        const siblings = others.map((v) => v.bounds)
        if(editor.state.rulers){
          const moving=new Set(targetEntries.filter(v=>movingIds.has(v.id)||v.ancestors.some(id=>movingIds.has(id))).map(v=>v.id))
          for(const guide of worldGuides(targetDocument,editor.state.page,targetEntries)){
            if(moving.has(guide.owner))continue
            if(Math.abs(guide.to.x-guide.from.x)<1e-9)siblings.push({x:guide.from.x,y:Math.min(guide.from.y,guide.to.y),width:0,height:Math.abs(guide.to.y-guide.from.y)})
            if(Math.abs(guide.to.y-guide.from.y)<1e-9)siblings.push({x:Math.min(guide.from.x,guide.to.x),y:guide.from.y,width:Math.abs(guide.to.x-guide.from.x),height:0})
          }
        }
          guideIndex.current={drag:d,rulers:editor.state.rulers,ids:targetKey,index:createSmartGuidesIndex(parent,siblings)}
        }
        const snap: SmartSnapResult = guideIndex.current?.index?.snap(
          { x: d.box.x + dx, y: d.box.y + dy, width: d.box.width, height: d.box.height }, 6 / d.view.zoom,
        ) ?? {dx:0,dy:0,guides:[null,null]}
        snapResult = snap
        // Shift constrains both the correction and the guide shown for it.
        const gx = moveAxes.x ? snap.guides[0] : null,
          gy = moveAxes.y ? snap.guides[1] : null
        if (gx) dx += snap.dx
        if (gy) dy += snap.dy
        guidedX = !!gx
        guidedY = !!gy
      }
      const force = d.ids.some((id) => forcedPixelSnap(editor.state.doc.nodes[id]))
      const snapped = snapMove(
        d.box,
        { x: dx, y: dy },
        force || (editor.state.snapPixels && !e.ctrlKey),
        { x: moveAxes.x && (force || !guidedX), y: moveAxes.y && (force || !guidedY) },
      )
      // Pixel-forced objects can override a fractional alignment. The line
      // must describe the final transform, not the discarded snap proposal.
      moveGuides = placedSmartGuides(snapResult, { x:d.box.x+snapped.x, y:d.box.y+snapped.y, width:d.box.width, height:d.box.height },
        { x:moveAxes.x && snapped.x === dx, y:moveAxes.y && snapped.y === dy })
      if (d.actionToken) actionTrace.sample(d.actionToken, {
        snapChanged: snapped.x !== dx || snapped.y !== dy || guidedX || guidedY,
        constraintEnabled: e.shiftKey, constraintChanged: !moveAxes.x && p.x !== d.start.x || !moveAxes.y && p.y !== d.start.y,
        intentResolvedComparison: snapped.x === p.x - d.start.x && snapped.y === p.y - d.start.y ? 1 : 2,
      })
      transform = translate(snapped.x, snapped.y)
    } else if (d.kind === 'rotate') {
      const center = d.rotationCenter || (
        d.basis && d.localBox
          ? apply(d.basis, {
              x: d.localBox.x + d.localBox.width / 2,
              y: d.localBox.y + d.localBox.height / 2,
            })
          : { x: d.box.x + d.box.width / 2, y: d.box.y + d.box.height / 2 })
      const initial = d.ids.length === 1 ? Math.atan2(d.matrices[d.ids[0]][1],d.matrices[d.ids[0]][0]) * 180 / Math.PI : 0
      const rotation = selectionRotation(center,d.start,p,initial,e.shiftKey)
      transform = rotation.matrix
      d.rotationDegrees = rotation.degrees
    } else if (d.kind === 'resize' || d.kind === 'scale') {
      if (d.basis && d.localBox) {
        const n = editor.state.doc.nodes[d.ids[0]]
        transform = resizeWithTrace(d,
          d.basis,
          d.localBox,
          d.start,
          p,
          d.handle || 0,
          d.kind === 'scale' || (!e.ctrlKey && (!!n.constrainProportions || e.shiftKey)),
          e.altKey,
          d.kind !== 'scale' && (forcedPixelSnap(n) || (editor.state.snapPixels && !e.ctrlKey)),
        )
      } else {
        const anchor = boxPoints(d.box)[((d.handle || 0) + 2) % 4]
        const box = { x: 0, y: 0, width: d.box.width, height: d.box.height }
        const basis: Matrix = [1, 0, 0, 1, d.box.x, d.box.y]
        transform = resizeWithTrace(d,
          basis,
          box,
          d.start,
          p,
          d.handle || 0,
          d.kind === 'scale' || (e.shiftKey && !e.ctrlKey),
          e.altKey,
          d.kind !== 'scale' && editor.state.snapPixels && !e.ctrlKey,
        )
      }
    }
    const parents = d.kind === 'move' && d.sourceParents || editor.parentMap(),
      patches: Record<string, Partial<DesignNode>> = {}
    for (const id of d.ids) {
      const parent = d.kind === 'move' && d.parentMatrices?.[id] || worldMatrix(editor.state.doc, parents.get(id)!, parents)
      patches[id] = { transform: multiply(inverse(parent), multiply(transform, d.matrices[id])) }
      if (d.kind === 'resize') {
        const original = d.sourceDocument?.nodes[id]
        if (original) {
          const proportional = !e.ctrlKey && (e.shiftKey || !!d.basis && !!original.constrainProportions)
          const axes = resizeGestureAxes(d.handle ?? 0, proportional, d.basis ? undefined : d.matrices[id])
          patches[id] = resizedNode(original, patches[id].transform!, axes)
        }
      }
    }
    if (d.actionToken && d.actionBefore) {
      d.actionProposal = actionGeometry(editor.state.doc, d.ids, patches)
      actionTrace.sample(d.actionToken, { proposalChanged: compareActionGeometry(d.actionBefore, d.actionProposal) === 2 })
    }
    const placement = d.kind==='move'?{ids:d.ids,point:p,
      force:/Mac|iPhone|iPad/.test(navigator.platform)?e.metaKey:e.ctrlKey,preserveParent:space.current}:undefined
    const movePreview=placement?editor.canvasMovePreview(patches,placement):undefined
    const retainsParents = !placement || movePreview!.retainsParents
    // Independent complete boards can follow the pointer on the compositor.
    // Keep one final authored mutation, using the same snapping/placement math.
    // Overlap, reparenting and Option-copy immediately use the regular path.
    if ((d.kind === 'move' && retainsParents && !d.duplicating && !e.altKey ||
        d.kind === 'rotate' || d.kind === 'scale') && patches) {
      const offset = gpuMove.current?.apply(editor.state.doc, movePreview?.patches||patches, d.actionToken ? actionTrace.token(d.actionToken) : undefined,
        [moveGuides.x,moveGuides.y].filter((guide):guide is SmartGuideSegment=>!!guide))
      if (offset) {
        clearFallbackMove(); retainedMove.current?.restore()
        moveGuides = { ...moveGuides, surface:gpuMove.current?.guidesInSurface?.() === true }
        if (gpuMove.current?.feedbackPending?.()) {
          const sequence = gpuMove.current.inputSequence?.() || 0
          guidePoses.current.set(sequence, { drag:d, document:editor.state.doc, control:gpuMove.current, guides:moveGuides })
          while (guidePoses.current.size > 128) guidePoses.current.delete(guidePoses.current.keys().next().value!)
        } else { guidePoses.current.clear(); showMoveGuides(moveGuides) }
        if (!gpuMove.current?.feedbackPending?.() && host.current) moveCanvasFeedback(host.current, d.ids, offset, gpuMovedOverlays.current)
        if (d.actionToken) actionTrace.sample(d.actionToken, { renderRouteCode: 1, poseSubmittedSequence: gpuMove.current?.inputSequence?.() || 0 })
        pendingBoardMove.current = [patches, placement]
        return
      }
      if(d.actionToken) actionTrace.sample(d.actionToken,{renderRouteCode:gpuMove.current?2:3,renderFallbackCount:d.renderFallbackCount=Math.min(1e9,(d.renderFallbackCount||0)+1)})
      if (d.actionToken && gpuMove.current?.previewFailure?.())
        actionTrace.sample(d.actionToken, { poseFallbackReason: gpuMove.current.previewFailure() })
    }
    if (d.kind === 'move' && retainsParents && !d.duplicating && !e.altKey && d.ids.length === 1 &&
      retainedMove.current?.apply(editor.state.doc, d.ids[0], (movePreview?.patches||patches)[d.ids[0]].transform!)) {
      gpuMove.current?.end(editor.state.doc); restoreGpuOverlays()
      clearFallbackMove()
      guidePoses.current.clear(); showMoveGuides(moveGuides)
      if(d.actionToken)actionTrace.sample(d.actionToken,{renderRouteCode:4})
      pendingBoardMove.current = [patches, placement]
      return
    }
    // A document preview is still the same gesture. Its renderer adopts the
    // new topology while holding the last complete picture. Ending here would
    // briefly expose the old page, then start a second capture on the next move.
    if (d.kind === 'move' && gpuMove.current?.previewFailure?.()) gpuMove.current.end(editor.state.doc)
    if (pendingBoardMove.current) { pendingBoardMove.current = null; retainedMove.current?.restore() }
    editor.preview(patches,placement)
    guidePoses.current.clear()
    guideDocuments.current.set(editor.state.doc, { drag:d, guides:moveGuides })
    if (geometryReady && !gpuPreviewAvailable && vectorPreviewSupported) showMoveGuides(moveGuides)
    if (d.kind === 'move' && !(geometryReady && !gpuPreviewAvailable && vectorPreviewSupported)) awaitFallbackMove()
    else clearFallbackMove()
    restoreGpuOverlays()
    if (host.current) host.current.dataset.inputTiming = JSON.stringify(editor.lastPreviewTiming)
  }
  moveCallback.current = move
  function end(e: React.PointerEvent) {
    return actionTrace.cpu.run(CpuStage.pointerUp, () => endImpl(e), drag.current?.actionToken)
  }
  function endImpl(e: React.PointerEvent) {
    if (utility.end(e,world(e))) { if(host.current?.hasPointerCapture(e.pointerId))host.current.releasePointerCapture(e.pointerId); return }
    if (pencil.current) {
      const draft = pencil.current
      if (e.pointerId !== draft.input.pointerId) return
      try {
        draft.input.append([e.nativeEvent], draft.map, true, e.shiftKey)
        const n = freehandNode(draft.id, draft.input.samples, draft.settings, draft.zoom, draft.tool)
        cancelPencil(false)
        if (n.opacity > 0) editor.addFreehand(n)
        if (draft.actionToken) actionTrace.finish(draft.actionToken, editor.state.version !== draft.actionRevision ? ActionOutcome.committed : ActionOutcome.unchanged, ActionReason.none)
      } catch (error) {
        if (draft.actionToken) actionTrace.finish(draft.actionToken, ActionOutcome.rejected, ActionReason.validation)
        editor.notify(String(error))
      }
      cancelPencil()
      if (host.current?.hasPointerCapture(e.pointerId))
        host.current.releasePointerCapture(e.pointerId)
      return
    }
    const d = drag.current
    if (!d) return
    if (e.pointerId !== d.pointerId) return
    if (d.session !== editor.sessionGeneration || d.page !== editor.state.page) {
      cancelQueuedMove(); drag.current = null; pendingBoardMove.current = null
      restoreGpuOverlays(); retainedMove.current?.restore(); setPanning(false); setRubber(null); clearMoveGuides()
      if (host.current?.hasPointerCapture(e.pointerId)) host.current.releasePointerCapture(e.pointerId)
      return
    }
    cancelQueuedMove()
    const release = screenPoint(e), last = d.lastScreen || d.screen, modifiers = d.lastModifiers
    measureCpuStage(CpuStage.releaseFlush, () => {
      // Every gesture must consume the release position when a final move was
      // coalesced or absent. A no-motion handle click must remain a no-op.
      const changedModifiers = modifiers && (modifiers.shift !== e.shiftKey || modifiers.alt !== e.altKey ||
        modifiers.ctrl !== e.ctrlKey || modifiers.meta !== e.metaKey)
      if (d.kind !== 'create' && (d.kind === 'move' || release.x !== last.x || release.y !== last.y ||
        (changedModifiers && d.sampledMovement))) move(e)
      const pending = pendingBoardMove.current
      if (pending) {
        pendingBoardMove.current = null; retainedMove.current?.restore()
        editor.preview(...pending)
      }
    })
    if (d.actionToken && d.actionBefore) d.actionResolved = actionGeometry(editor.state.doc, d.ids)
    // Coalesced camera writes land synchronously before the gesture unwinds.
    flushView()
    drag.current = null
    setPanning(false)
    if (host.current?.hasPointerCapture(e.pointerId))
      host.current.releasePointerCapture(e.pointerId)
    if (penRef.current && d.kind === 'vertex' && !d.node) { finishDragTrace(d, ActionOutcome.observed, ActionReason.unobserved); return }
    if (d.kind === 'create') {
      d.pointer = screenToWorld(d.view, screenPoint(e))
      d.screenDistance = Math.max(d.screenDistance || 0, distance(screenPoint(e), d.screen))
      const n = updateCreation(d, { shift: e.shiftKey, alt: e.altKey })!
      editor.cancel()
      editor.change(`创建${n.name}`, document => {
        document.nodes[n.id] = n
        const page = document.pages.find(page => page.id === editor.state.page)!
        page.children.push(n.id)
        if (!space.current && n.kind!=='slice') {
          const center = apply(n.transform,{x:n.width/2,y:n.height/2})
          const parent = canvasDropFrame(document,page.id,[n.id],center,e.metaKey || e.ctrlKey)
          if (parent) {
            page.children.splice(page.children.indexOf(n.id),1)
            document.nodes[parent].children.push(n.id)
            document.nodes[n.id].transform=multiply(inverse(worldMatrix(document,parent)),n.transform)
          }
        }
      }, [n.id])
      if (n.kind === 'text') setTextEdit(n.id)
      setShapePreview(null)
      editor.set({ tool: 'select' })
    } else if(d.kind==='zoom') {
      const area=createBox(d.start,screenToWorld(d.view,release),false)
      editor.set({view:area.width*d.view.zoom>=3&&area.height*d.view.zoom>=3
        ?fitBounds(area,{width:size.width,height:size.height},{padding:0})
        :zoomAt(d.view,zoomStep(d.view.zoom,e.altKey?-1:1),release)})
    } else if (d.kind === 'marquee') {
      // React's rubber-band state may still describe the previous move. The
      // committed selection uses the owner's actual final coordinates.
      const area = createBox(d.start, screenToWorld(d.view, release), false)
      const deep = d.forcedMarquee || (d.sketchMarquee
        ? shortcutPlatform() === 'mac' ? e.metaKey : e.ctrlKey : e.metaKey || e.ctrlKey)
      // Use release-time modifiers and the original selection, not the last
      // coalesced move or an earlier preview (which would toggle repeatedly).
      const additive = d.sketchMarquee ? e.shiftKey || d.creationTool === 'multiselect' : !!d.additive
      editor.select(canvasMarqueeSelection(editor.state.doc, editor.state.page, d.originSelection,
        (d.pickIndex || index).query(area), area, { deep: !!deep, contained: !!d.sketchMarquee && e.altKey,
          additive, toggle: !!d.sketchMarquee && additive, ignoreId: d.marqueeIgnoreId }))
    } else if(d.kind==='pivot') {
      // The origin is an editing handle, not document geometry or undo state.
    } else if ((d.kind === 'vertex' || d.kind === 'handle') &&
        release.x === d.screen.x && release.y === d.screen.y) {
      // Restoring a derived network can leave optional own-properties with
      // undefined values. The unchanged pointer gesture owns no authored edit;
      // restore its original snapshot and redo branch instead of committing
      // that representational difference as an empty history entry.
      editor.cancel()
      finishDragTrace(d, ActionOutcome.cancelled, ActionReason.none)
    } else if (d.kind === 'move' && !d.moved) {
      editor.cancel()
      finishDragTrace(d, ActionOutcome.cancelled, ActionReason.belowThreshold)
      if (d.clickSelection !== null && d.clickSelection !== undefined) editor.select(d.clickSelection)
    } else if (d.kind === 'crop') {
      const target = d.node
      const live = target && editor.state.doc.nodes[target.id]
      setCropRect(null)
      if (target && live) {
        const clampLocal = (point: Point) => {
          const local = apply(inverse(d.matrices[target.id]), point)
          return { x: Math.max(0, Math.min(live.width, local.x)), y: Math.max(0, Math.min(live.height, local.y)) }
        }
        const rect = createBox(clampLocal(d.start), clampLocal(screenToWorld(d.view, release)), false)
        if (rect.width >= 1 && rect.height >= 1) void applyCrop(target.id, rect)
        else editor.notify('裁切区域过小，未应用')
      }
    } else {
      if(d.kind==='move')gpuMove.current?.releaseInput?.()
      const notice = d.kind === 'move' ? editor.finishCanvasMove(screenToWorld(d.view, release), /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey, /Mac|iPhone|iPad/.test(navigator.platform) && e.ctrlKey, space.current) : undefined
      const commitResult = editor.commit()
      if(d.kind==='rotate'&&d.rotationCenter)setOrigin(originFromWorld(d.rotationCenter))
      if (notice) editor.notify(notice)
      if (d.kind === 'move' && d.duplicating && d.ids.every(id => editor.state.doc.nodes[id]))
        editor.rememberDuplication(commitResult, d.ids, new Map(d.ids.map(id => [id, d.matrices[id]])))
    }
    gpuMove.current?.end(editor.state.doc)
    restoreGpuOverlays()
    finishDragTrace(d, ['pan','zoom','pivot','marquee'].includes(d.kind) ? ActionOutcome.observed : d.kind === 'crop' ? ActionOutcome.unsupported : undefined, d.kind === 'crop' ? ActionReason.unobserved : ActionReason.none)
    setRubber(null)
    clearMoveGuides()
  }
  async function applyCrop(id: string, rect: Bounds) {
    const generation = editor.sessionGeneration
    const version = editor.state.version, page = editor.state.page, epoch = pendingOperationEpoch(editor)
    try {
      const source = editor.state.doc.nodes[id]
      const fill = source?.fills.find((f) => f.kind === 'image' && f.visible && f.image)
      if (!source || !fill?.image) return
      const natural = !fill.transform && fill.fit !== 'stretch' ? await imageNaturalSize(fill.image) : undefined
      if (!mounted.current || editor.sessionGeneration !== generation || editor.state.version !== version || editor.state.page !== page || pendingOperationEpoch(editor) !== epoch) return
      const live = editor.state.doc.nodes[id]
      const liveFill = live?.fills.find((f) => f.kind === 'image' && f.visible && f.image)
      if (!live || !liveFill) return
      const result = cropImageNode({ width: live.width, height: live.height, transform: live.transform }, liveFill, rect, natural)
      editor.update(
        [id],
        (n) => {
          n.transform = result.transform
          n.width = result.width
          n.height = result.height
          const target = n.fills.find((f) => f.kind === 'image' && f.visible && f.image)
          if (target) target.transform = result.fillTransform
        },
        '裁切图片',
      )
    } catch (error) {
      editor.notify(error instanceof Error ? error.message : String(error))
    }
  }
  const vectorNode = useMemo(() => {
    const n = state.tool === 'vector' && state.selection.length === 1 ? state.doc.nodes[state.selection[0]] : null
    try{return n && editor.topSelection().includes(n.id) && !['frame', 'section', 'group', 'text'].includes(n.kind) ? { ...n, network: editableNetwork(n) } : null}catch{return null}
  }, [state.tool, state.selection, state.doc])
  useEffect(()=>{
    if(state.tool!=='vector'||state.selection.length!==1||vectorNode)return
    const n=state.doc.nodes[state.selection[0]]
    if(n?.vectorGeometry){try{editableNetwork(n)}catch(error){editor.set({tool:'select'});editor.notify(String(error))}}
  },[state.tool,state.selection,state.doc,vectorNode,editor])
  const widthNode =
    state.tool === 'width' && state.selection.length === 1
      ? state.doc.nodes[state.selection[0]]
      : null
  const widthHandles = useMemo(
    () =>
      widthNode?.strokes[state.widthStroke]?.widthProfile?.length
        ? kernelStrokeHandles(widthNode, state.widthStroke)
        : [],
    [widthNode, state.widthStroke],
  )
  function replayDragModifiers(event: KeyboardEvent) {
    const active = drag.current
    if (!active || !['move', 'resize', 'scale', 'rotate', 'parameter', 'width', 'handle', 'vertex'].includes(active.kind) ||
        active.kind === 'vertex' && !active.node) return false
    // A key can arrive before the first animation frame. Consume that latest
    // owner sample now, so an older queued modifier state cannot overwrite it.
    const input = queuedMove.current?.event || active.lastInput
    if (!input || input.pointerId !== active.pointerId) return false
    cancelQueuedMove()
    move({ ...input, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey })
    return true
  }
  function startWidth(e: React.PointerEvent, h: StrokeHandle, side: 'left' | 'right') {
    if (!widthNode || !editor.topSelection().includes(widthNode.id) || e.button !== 0 || !e.isPrimary || drag.current || pencil.current) return
    if (!displayedSnapshot) return
    if (e.ctrlKey && /Mac|iPhone|iPad/.test(navigator.platform)) return
    cancelQueuedMove()
    e.stopPropagation()
    e.preventDefault()
    host.current!.setPointerCapture(e.pointerId)
    actionTrace.event(CanvasAction.grab, ActionSource.pointer, ActionOutcome.observed, ActionReason.none, { modifiers: modifierBits(e) })
    editor.begin('调整描边宽度')
    drag.current = {
      pointerId: e.pointerId,
      session: editor.sessionGeneration, page: state.page,
      kind: 'width',
      start: world(e),
      screen: screenPoint(e),
      view: { ...displayViewRef.current },
      ids: [widthNode.id],
      matrices: { [widthNode.id]: worldMatrix(state.doc, widthNode.id) },
      box: selectionBox,
      node: structuredClone(widthNode),
      originSelection: state.selection,
      widthHandle: h,
      widthSide: side,
      widthIndex: state.widthStroke,
    }
  }
  async function drop(e: React.DragEvent) {
    e.preventDefault()
    if (!displayedSnapshot || !geometryReady) return
    const p = world(e)
    const generation = editor.sessionGeneration, page = editor.state.page, epoch = pendingOperationEpoch(editor)
    let pageChanged = false
    const unsubscribe = editor.subscribe(() => { if (editor.state.page !== page) pageChanged = true })
    const maxPixels = editor.state.doc.colorManagement ? 8_388_608 : 16_777_216
    const current = () => mounted.current && !pageChanged && pendingOperationEpoch(editor) === epoch && editor.sessionGeneration === generation && editor.state.page === page
    try {
      const componentId = e.dataTransfer.getData('application/x-forma-component')
      if (componentId) {
        editor.insertComponent(componentId, p)
        return
      }
      for (const file of e.dataTransfer.files) {
        if (!current()) return
        const image = await imageData(file, maxPixels)
        if (!current()) return
        if (image.resized)
          editor.notify(`图片超过 ${Math.floor(maxPixels / 1e4)} 万像素预算，已降采样至 ${image.width}×${image.height}`)
        const k = Math.min(1, 600 / image.width, 600 / image.height)
        const id = editor.add('rectangle', {
          ...p,
          width: image.width * k,
          height: image.height * k,
        })
        editor.update(
          [id],
          { name: file.name, fills: [{ ...paint('#ffffff', 'image'), image: image.data }] },
          '导入图片',
        )
      }
    } catch (error) {
      if (current()) editor.notify(String(error))
    } finally {
      unsubscribe()
    }
  }
  return (
    <div
      ref={host}
      id="design-canvas-view"
      tabIndex={-1}
      role="application"
      aria-label="设计画布编辑器"
      className={`canvas canvas-${state.tool}${state.tool==='zoom'&&measureKeys.alt?' canvas-zoom-out':''}${spaceHeld ? ' canvas-space-held' : ''}${panning ? ' canvas-panning' : ''}${ownedDrag?.kind==='move'&&ownedDrag.moved?' canvas-object-dragging':''}`}
      data-testid="canvas" aria-busy={state.busy}
      data-creation-kind={shapePreview?.kind}
      data-transform-gesture={drag.current?.kind}
      style={marqueeKeyHeld ? { cursor: 'crosshair' } : drag.current?.kind==='rotate'?{cursor:transformHandles[drag.current.handle ?? 0]?.rotateCursor}:undefined}
      onPointerDownCapture={e => {
        // Capture before transform/layout handles, so held X cannot resize or
        // move an existing selection. Canvas controls keep their own input.
        if (!marqueeHeld.current || shortcutPreference.getSnapshot() !== 'sketch-like' ||
            drag.current || pencil.current || utility.active() || space.current || editor.state.tool === 'hand' ||
            e.button !== 0 || !(e.target instanceof Element) || !host.current?.contains(e.target) ||
            e.target.closest(canvasChromeSelector) || shortcutTargetOwnsKeyboard(e.target)) return
        cancelQueuedMove(); start(e, 'marquee'); e.stopPropagation()
      }}
      onPointerDown={(e) => { if (!drag.current) cancelQueuedMove(); start(e) }}
      onPointerMoveCapture={e => {
        // Scrollbar gestures stop propagation. Clear a previous canvas
        // target before that boundary, including any queued hover sample.
        if (!drag.current && !pencil.current && !utility.active() && e.target instanceof Element && e.target.closest(canvasChromeSelector)) {
          cancelQueuedMove(); hoverPoint.current = null; editor.pointerLocation = null; editor.pointerScreen = null; editor.hoverLayer(null, 'canvas')
        }
      }}
      onPointerMove={queuePointerMove}
      onPointerLeave={() => {
        if (!drag.current) { cancelQueuedMove(); cursorPoint.current = null; setCursor(null) }
        editor.pointerLocation = null; editor.pointerScreen = null; hoverPoint.current = null; editor.hoverLayer(null, 'canvas')
      }}
      onPointerUp={end}
      onPointerCancel={(e) => {
        utility.cancel(e.pointerId)
        // A late cancel from a retired pointer must not cancel a replacement
        // editor transaction after session/page cleanup has dropped its drag.
        if (!pencil.current && !drag.current) return
        if (pencil.current && e.pointerId !== pencil.current.input.pointerId) return
        if (drag.current && e.pointerId !== drag.current.pointerId) return
        desktopPet.stopNavigation()
        cancelQueuedMove()
        if(drag.current?.kind==='pivot'&&drag.current.originalPivot)setOrigin(drag.current.originalPivot)
        flushView()
        cancelPencil()
        setShapePreview(null)
        const cancelledDraft = drag.current
        editor.cancel()
        finishDragTrace(cancelledDraft, ActionOutcome.cancelled, ActionReason.pointerCancel)
        drag.current = null
        setPanning(false)
        setRubber(null)
        restoreCancelledMarqueeSelection(cancelledDraft)
      }}
      onLostPointerCapture={(e) => {
        if(utility.active())utility.cancel(e.pointerId)
        if (pencil.current?.input.pointerId === e.pointerId) cancelPencil()
        if (drag.current?.pointerId === e.pointerId) {
          desktopPet.stopNavigation()
          cancelQueuedMove()
          if(drag.current.kind==='pivot'&&drag.current.originalPivot)setOrigin(drag.current.originalPivot)
          flushView()
          const cancelledDraft = drag.current
          editor.cancel(); finishDragTrace(cancelledDraft, ActionOutcome.cancelled, ActionReason.lostCapture); drag.current = null; setPanning(false); setShapePreview(null); setRubber(null); clearMoveGuides()
          restoreCancelledMarqueeSelection(cancelledDraft)
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={drop}
      onContextMenu={e => {
        if (!host.current?.contains(e.target as Node)) return
        if (shortcutTargetOwnsKeyboard(e.target)) return
        e.preventDefault()
        if (drag.current || pencil.current || !geometryReady || !displayedSnapshot || !displayedIndex) return
        host.current?.focus({ preventScroll: true })
        const point = world(e)
        const shown = displayedSnapshot.document, parents = editor.parentMap(), shownParents = editor.parentMap(shown)
        const candidates = displayedIndex.query({ x: point.x - 3 / zoom, y: point.y - 3 / zoom, width: 6 / zoom, height: 6 / zoom }).reverse().filter(entry => {
          if (!interactivePath(editor.state.doc, editor.state.page, entry.id, true, parents).length) return false
          const n = shown.nodes[entry.id]
          return kernelHitWorld(n, point, entry.matrix, zoom) && !entry.ancestors.some(id => {
            const parent = shown.nodes[id]
            return parent.clip && !kernelFillWorld(parent, point, worldMatrix(shown, id, shownParents), zoom)
          })
        }).map(entry => ({ id: entry.id, name: editor.state.doc.nodes[entry.id].name,
          locked: entry.locked || !interactivePath(editor.state.doc, editor.state.page, entry.id, false, parents).length }))
        const hit = (candidates[0]?.locked ? candidates[0].id : displayedHit(point)) || candidates[0]?.id
        if (hit && !editor.state.selection.includes(hit)) editor.select([hit])
        else if (!hit) editor.select([])
        setContextMenu({ x: e.clientX, y: e.clientY, worldPoint: point, candidates })
      }}
      onDoubleClick={(e) => {
        if(nativeSource){
          if(e.target instanceof Element&&e.target.closest(canvasChromeSelector))return
          if(e.button===0)onOpenSourcePoint?.(screenToWorld(editor.flushPendingView(),{x:e.clientX-e.currentTarget.getBoundingClientRect().left,y:e.clientY-e.currentTarget.getBoundingClientRect().top}))
          return
        }
        if (!displayedSnapshot || !displayedIndex) return
        if (['pencil', 'brush', 'marker', 'washi-tape', 'hand'].includes(editor.state.tool) || space.current) return
        if (penRef.current) {
          finishPen()
          return
        }
        const text = displayedHit(world(e), true)
        if (text && editor.state.doc.nodes[text]?.kind === 'text') {
          editor.select([text])
          setTextEdit(text)
          return
        }
        const result = editor.selectDeeper(world(e), displayedIndex, displayViewRef.current.zoom, displayedSnapshot)
        if (!result || result.changed) return
        const id = result.id
        if (!editor.topSelection().includes(id)) return
        const n = state.doc.nodes[id]
        // Instance interiors are derived from the master component (imported
        // .fig material is mostly instances). The deep-select chain stops at
        // the instance boundary, so point the user at detach instead of a
        // silent no-op.
        if (n.instance)
          editor.notify('实例内容由主组件派生：右键“分离实例”后即可编辑子元素', { key: 'instanceDetachHint' })
        if (n.kind === 'text') {
          setTextEdit(id)
        } else if (!['frame', 'section', 'group'].includes(n.kind)) {
          editor.set({ tool: 'vector', editingVertex: null })
        }
      }}
    >
      {state.tool==='eyedropper' && <div className="canvas-color-pick-hint" role="status" style={colorPick?{left:Math.max(8,Math.min(size.width-360,colorPick.x+18)),top:Math.max(8,Math.min(size.height-38,colorPick.y+18))}:undefined}>
        {colorPick&&<><span style={{background:colorPick.color}}/>{colorPick.label} · </>}{state.selection.length?'点击取色':'点击复制颜色'} · Tab 格式 · Esc 取消
      </div>}
      {state.tool==='eyedropper'&&colorPick&&<div className="canvas-color-pick-point" data-testid="color-sample-point" style={{left:colorPick.x,top:colorPick.y}}/>}
      {drag.current?.kind==='rotate' && drag.current.rotationDegrees!==undefined && cursor && <div
        className="canvas-rotation-hint" role="status" data-testid="rotation-feedback"
        style={{left:cursor.x*zoom+displayView.x+18,top:cursor.y*zoom+displayView.y+18}}>
        {Number(drag.current.rotationDegrees.toFixed(2))}°
      </div>}
      {contextMenu && <CanvasContextMenu editor={editor} {...contextMenu} onEditText={() => {
        if (editor.state.selection.length === 1) setTextEdit(editor.state.selection[0])
      }} onClose={() => { setContextMenu(null); host.current?.focus({ preventScroll: true }) }} />}
      {textEdit && state.doc.nodes[textEdit] && (
        <CanvasTextEditor
          viewport={size}
          onPreview={setTextPreview}
          key={`${textEntry!.session}:${textEntry!.token}:${textEdit}`}
          isCurrent={() => ownsTextEntry(textEntry)}
          document={state.doc}
          node={state.doc.nodes[textEdit]}
          editor={editor}
          matrix={multiply(
            [displayView.zoom, 0, 0, displayView.zoom, displayView.x, displayView.y],
            worldMatrix(state.doc, textEdit),
          )}
          onClose={(restoreCanvasFocus = false) => {
            // Pending commits and external blur must not steal another field's
            // focus. An old text session also cannot close/focus a replacement.
            if (!ownsTextEntry(textEntry)) return
            const ownsFocus = host.current?.querySelector('.rich-text-editor')?.contains(document.activeElement)
            setTextEdit(null)
            if (restoreCanvasFocus && ownsFocus) host.current?.focus({ preventScroll: true })
          }}
        />
      )}
      <CanvasLayoutHandles editor={editor} view={displayView} size={size} visible={exactOverlayMatches}/>
      <CanvasSmartSelection editor={editor} view={displayView} size={size} visible={exactOverlayMatches}/>
      <CanvasGuides editor={editor} view={displayView} size={size} intercept={e=>{
        if(!canTransform||e.button!==0)return false
        const p=world(e)
        for(const h of transformHandles){
          if(pointInContours(p,[h.resizePoints])){start(e,'resize',h.index);return true}
          if(state.tool!=='scale'&&pointInContours(p,[h.rotatePoints])){start(e,'rotate',h.index);return true}
          if(segmentDistance(p,h.point,h.next)*zoom<4){start(e,'resize',h.index+4);return true}
        }
        return false
      }}/>
      {nativeSource?<NativeSourceSurface source={nativeSource} view={state.view} width={size.width} height={size.height} onStatus={onNativeSourceStatus}/>:<KernelSurface
        navigationInputOwner={editor}
        panGestureActive={panning}
        overlay={overlay}
        interaction={gpuInteraction}
        onPresentation={recordPresentation}
        overview={refineOverview}
        presentationEpoch={editor.sessionGeneration}
        document={surfaceDocument}
        interactionPreview={editPreviewVisible}
        pageId={state.page}
        width={size.width}
        height={size.height}
        view={state.view}
        grid={state.grid}
        checkerboard={state.checkerboard}
        pixelPreview={state.pixelPreview}
      />}
      {!nativeSource&&showStartup && <StartupPreview preview={startupPreview!} view={state.view} loading={loading} width={size.width} height={size.height}/>}
      {geometryReady && !gpuPreviewAvailable && <CanvasEditPreview document={renderedDocument} baseDocument={editBaseDocument.current} selection={state.selection} pageId={state.page}
        vectorSupport={vectorPreviewSupport} captureFrame={presented} epoch={editor.sessionGeneration} scene={interactionScene}
        vectorSupported={vectorPreviewSupported} sourceHost={host} control={retainedMove} canCapture={!state.grid && !state.checkerboard && !!presentationScopeMatches && presented.document === state.doc && !presented.preview}
        view={displayView} size={size} visible={!!editPreviewVisible} inputAt={editInputAt.current}/>}
      {editPreviewVisible && <span className="canvas-edit-status" role="status">编辑预览 · 正在细化</span>}
      {['pencil', 'brush', 'marker', 'washi-tape'].includes(state.tool) && (
        <div
          className="pencil-controls"
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <NumberField
            label="笔宽"
            value={state[(state.tool as FreehandTool)].width}
            min={0.5}
            max={200}
            step={0.5}
            onChange={(width) => { const tool = (state.tool as FreehandTool); editor.set({ [tool]: { ...state[tool], width } }) }}
          />
          <NumberField
            label="平滑"
            value={state[(state.tool as FreehandTool)].smoothing}
            min={0.1}
            max={5}
            step={0.1}
            onChange={(smoothing) => { const tool = (state.tool as FreehandTool); editor.set({ [tool]: { ...state[tool], smoothing } }) }}
          />
          <input
            type="color"
            aria-label="画笔颜色"
            value={state[(state.tool as FreehandTool)].color}
            onChange={(e) => { const tool = (state.tool as FreehandTool); editor.set({ [tool]: { ...state[tool], color: e.target.value } }) }}
          />
          <label>
            <input
              type="checkbox"
              checked={state[(state.tool as FreehandTool)].pressure}
              disabled={state.tool !== 'brush'}
              onChange={(e) =>
                editor.set({ brush: { ...state.brush, pressure: e.target.checked } })
              }
            />
            笔压
          </label>
          <small>鼠标 / 触控笔绘制 · Esc 取消 · V 选择</small>
        </div>
      )}
      <svg
        className="stage"
        width={size.width}
        height={size.height}
        style={{ position: 'relative', zIndex: 3, background: 'transparent' }}
      >
        <title>设计画布</title>
        {pixelGridPath && (!gpuOverlay||presented?.gpuPixelGrid===false) && (
          <g transform={`translate(${displayView.x} ${displayView.y}) scale(${zoom})`}>
            {/* Camera chrome, not presented-pixel content: the pixel grid
                stays visible while the rendered frame catches up with a
                zoom or pan, which is exactly when Figma's grid shows. */}
            <path
              d={pixelGridPath}
              fill="none"
              stroke="#5b5872"
              strokeOpacity={0.16}
              strokeWidth={1 / zoom}
              shapeRendering="crispEdges"
              pointerEvents="none"
              data-testid="pixel-grid"
            />
          </g>
        )}
        <g transform={`translate(${displayView.x} ${displayView.y}) scale(${zoom})`}
          visibility={exactOverlayMatches || ownedDrag?.kind === 'width' ? 'visible' : 'hidden'}>
          {sliceEntries.map(e=><g key={e.id} pointerEvents="none" transform={matrixString(e.matrix)}>
            <rect x={0} y={0} width={state.doc.nodes[e.id].width} height={state.doc.nodes[e.id].height} fill="none" stroke="#f09625" strokeWidth={1/zoom} strokeDasharray={`${4/zoom} ${4/zoom}`} />
            <text x={0} y={-5/zoom} fontSize={11/zoom} fill="#c56e00">{state.doc.nodes[e.id].name}</text>
          </g>)}
          {utility.overlay}
          {utility.pins}
          {peers.filter(p=>p.documentId===state.doc.id&&p.pageId===state.page).flatMap(p=>entries.filter(e=>p.selection.includes(e.id)).map(e=><rect key={`${p.id}:${e.id}`} data-peer-selection={e.id} x={e.bounds.x} y={e.bounds.y} width={e.bounds.width} height={e.bounds.height} fill="none" stroke="#a355e8" strokeWidth={1.5/zoom} pointerEvents="none"/>))}
          {peers.filter(p=>p.documentId===state.doc.id&&p.pageId===state.page&&p.cursor).map(p=><g key={p.id} data-peer-id={p.id} pointerEvents="none" transform={`translate(${p.cursor![0]} ${p.cursor![1]}) scale(${1/zoom})`}><path d="M0 0 L0 16 L5 11 L10 21 L14 19 L9 9 L16 8 Z" fill="#a355e8" stroke="white"/><text x={16} y={24} fontSize={11} fill="#8b3ccd">{p.name}</text></g>)}
          {widthNode &&
            widthHandles.map((h) => {
              const st = widthNode.strokes[state.widthStroke],
                p = st.widthProfile![h.index]
              const m = worldMatrix(state.doc, widthNode.id),
                factor = (st.width / 2) * (st.align === 'center' ? 1 : 2)
              const center = apply(m, h.point)
              const ends = (['left', 'right'] as const).map((side) => {
                const sign = side === 'left' ? 1 : -1
                const normal = {
                  x: m[0] * h.normal.x + m[2] * h.normal.y,
                  y: m[1] * h.normal.x + m[3] * h.normal.y,
                }
                // Keep zero-width tips separately draggable at every zoom.
                const width =
                  Math.max(
                    p[side] * factor,
                    8 / zoom / Math.max(1e-9, Math.hypot(normal.x, normal.y)),
                  ) * sign
                return {
                  side,
                  ...apply(m, {
                    x: h.point.x + h.normal.x * width,
                    y: h.point.y + h.normal.y * width,
                  }),
                }
              })
              return (
                <g key={`${h.contour}-${h.index}`}>
                  <line
                    x1={ends[0].x}
                    y1={ends[0].y}
                    x2={ends[1].x}
                    y2={ends[1].y}
                    stroke="#c64186"
                    strokeWidth={1.5 / zoom}
                    pointerEvents="none"
                  />
                  <circle
                    cx={center.x}
                    cy={center.y}
                    r={2 / zoom}
                    fill="#c64186"
                    pointerEvents="none"
                  />
                  {ends.map((end) => (
                    <circle
                      key={end.side}
                      data-testid={`width-${h.contour}-${h.index}-${end.side}`}
                      cx={end.x}
                      cy={end.y}
                      r={5 / zoom}
                      fill="white"
                      stroke="#c64186"
                      strokeWidth={1.5 / zoom}
                      style={{ cursor: 'crosshair' }}
                      onPointerDown={(e) => startWidth(e, h, end.side)}
                    />
                  ))}
                </g>
              )
            })}
          {frameTitles
            .map((e) => (
              <g key={e.id} data-frame-title-owner={e.id}>
              <text
                data-frame-title={e.id}
                opacity={gpuOverlay ? 0 : 1}
                transform={matrixString(e.matrix)}
                y={-12 / zoom}
                fontSize={11 / zoom}
                fill="#73778b"
                pointerEvents="all"
                style={{cursor:e.locked?'default':state.tool==='hand'||spaceHeld?'grab':'move'}}
              >
                {state.doc.nodes[e.id].name}
              </text>
              </g>
            ))}
          {(() => {
            // Layout-grid section highlight: solved tracks through the
            // kernel's section predicate, drawn as alternating cells.
            if (selection.size !== 1) return null
            const frame = state.doc.nodes[[...selection][0]]
            if (!frame || frame.kind !== 'frame' || frame.layout?.mode !== 'grid') return null
            return solvedGridRectangles.map((r, i) => (
              <polygon key={`grid-cell-${i}`} points={r.points.map(p => `${p.x},${p.y}`).join(" ")}
                fill="#0d99ff14" stroke="#0d99ff55" strokeWidth={1} vectorEffect="non-scaling-stroke"
                pointerEvents="none" data-testid="layout-grid-cell" />
            ))
          })()}
          {(() => {
            // Authored layout grid overlay (Sketch grid/layout dicts, Figma
            // layoutGrids): lit bands packed by the same wasm section
            // predicate, tinted with the grid's own color and opacity.
            if (selection.size !== 1) return null
            const frame = state.doc.nodes[[...selection][0]]
            if (!frame || frame.kind !== 'frame' || !frame.layoutGrid?.visible) return null
            const rects = layoutGridRectangles(frame.layoutGrid, frame.id, state.doc)
            const tint = `${frame.layoutGrid.color.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, frame.layoutGrid.opacity)) * 255).toString(16).padStart(2, '0')}`
            return rects.map((r, i) => (
              <polygon key={`layout-grid-${i}`} points={r.points.map(p => `${p.x},${p.y}`).join(" ")}
                fill={tint} pointerEvents="none" data-testid="authored-layout-grid-band" />
            ))
          })()}
          {hover &&
            !selection.has(hover) &&
            !drag.current &&
            (() => {
              const e = entries.find((v) => v.id === hover)
              const n = state.doc.nodes[hover]
              const path = e && n && !['text', 'group', 'section'].includes(n.kind) ? kernelSvgPaths(n) : null
              if (e && path && (path.stroke || path.fill)) return <path data-testid="canvas-hover-outline" data-node-id={hover}
                d={path.stroke || path.fill} transform={matrixString(e.matrix)} fill="none" stroke="#0d99ff"
                strokeWidth={1} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              return e ? (
                <polygon
                  data-testid="canvas-hover-outline"
                  data-node-id={hover}
                  points={boxPoints({
                    x: 0,
                    y: 0,
                    width: state.doc.nodes[hover].width,
                    height: state.doc.nodes[hover].height,
                  })
                    .map((p) => {
                      const v = apply(e.matrix, p)
                      return `${v.x},${v.y}`
                    })
                    .join(' ')}
                  fill="none"
                  stroke="#0d99ff"
                  strokeWidth={1 / zoom}
                  pointerEvents="none"
                />
              ) : null
            })()}
        </g>
        {/* Selection is document feedback, not part of the raster result.
            Keep it above tiles and responsive while that result refines. */}
        <g transform={`translate(${displayView.x} ${displayView.y}) scale(${zoom})`}>
          {!!selected.length && !['vector', 'width', 'pencil', 'brush', 'marker', 'washi-tape'].includes(state.tool) && (
            <g className="selection" data-selection-readonly={selectionFeedback.readOnly}>
              <polygon
                data-testid="canvas-selection-outline"
                opacity={gpuOverlay ? 0 : 1}
                points={selectionCorners.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke="#0d99ff"
                strokeWidth={1.3 / zoom}
                pointerEvents="none"
              />
              {canTransform && transformHandles.map(h => <line key={`edge-${h.index}`} data-testid={`resize-edge-${h.index}`}
                x1={h.point.x} y1={h.point.y} x2={h.next.x} y2={h.next.y}
                stroke="transparent" strokeWidth={8/zoom} pointerEvents="stroke" style={{cursor:h.edgeCursor}}
                onPointerDown={e=>{e.stopPropagation();start(e,'resize',h.index+4)}} />)}
              {canTransform && state.tool!=='scale' && transformHandles.map(h => <polygon key={`rotate-${h.index}`}
                data-testid={`rotate-corner-${h.index}`} data-anchor-x={h.rotateAnchor.x} data-anchor-y={h.rotateAnchor.y}
                points={h.rotatePoints.map(p=>`${p.x},${p.y}`).join(' ')} fill="transparent" pointerEvents="all"
                style={{cursor:h.rotateCursor}} onPointerDown={e=>{e.stopPropagation();start(e,'rotate',h.index)}} />)}
              {canTransform && transformHandles.map((h, i) => (
                <polygon
                  key={i}
                  data-testid={`resize-${i}`}
                  opacity={gpuOverlay ? 0 : 1}
                  points={h.resizePoints.map(p=>`${p.x},${p.y}`).join(' ')}
                  fill="white"
                  stroke="#0d99ff"
                  strokeWidth={1 / zoom}
                  pointerEvents={canTransform?'all':'none'}
                  style={{ cursor: h.resizeCursor }}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    start(e, 'resize', i)
                  }}
                />
              ))}
              {canTransform&&origin.current.visible&&(()=>{const p=drag.current?.kind==='rotate'?drag.current.rotationCenter!:originWorld();return <g
                data-testid="rotation-origin" transform={`translate(${p.x} ${p.y}) scale(${1/zoom})`} style={{cursor:'move'}}
                onPointerDown={e=>{e.stopPropagation();start(e,'pivot')}} onDoubleClick={e=>{e.stopPropagation();setOrigin({x:.5,y:.5},true)}}>
                <circle r={10} fill="transparent" pointerEvents="all"/><circle r={5} fill="white" stroke="#0d99ff" strokeWidth={1}/>
                <path d="M-9 0H9 M0 -9V9" fill="none" stroke="#0d99ff" strokeWidth={1}/><title>拖动旋转中心 · 双击复位 · ⌥R 显示/隐藏</title>
              </g>})()}
              {canTransform && state.tool !== 'scale' && selected.length === 1 && ['ellipse', 'polygon', 'star'].includes(state.doc.nodes[selected[0].id].kind) && !state.doc.nodes[selected[0].id].network && (() => {
                const n = state.doc.nodes[selected[0].id]
                const angle = Math.PI / n.points - Math.PI / 2
                const arc = n.arc ?? { startAngle: 0, sweepAngle: Math.PI * 2, innerRadius: 0 }
                const onEllipse = (angle: number, radius: number) => ({ x: n.width / 2 + Math.cos(angle) * n.width / 2 * radius, y: n.height / 2 + Math.sin(angle) * n.height / 2 * radius })
                const handles: { field: NonNullable<Drag['parameter']>; point: Point; label: string }[] = n.kind === 'ellipse' ? [
                  { field: 'arcStart', point: onEllipse(arc.startAngle, 0.85), label: '拖动调整圆弧起始角' },
                  { field: 'arcSweep', point: onEllipse(arc.startAngle + arc.sweepAngle, 1), label: '拖动调整圆弧扫过角' },
                  { field: 'arcInner', point: onEllipse(arc.startAngle + arc.sweepAngle / 2, Math.max(0.15, arc.innerRadius)), label: '拖动调整圆环内径' },
                ] : [
                  { field: 'cornerRadius', point: { x: n.width / 2, y: Math.min(n.height / 3, 12 + (n.cornerRadius ?? 0)) }, label: '拖动调整顶点圆角' },
                  { field: 'points', point: { x: n.width, y: n.height / 2 }, label: '拖动调整顶点数量' },
                  ...(n.kind === 'star' ? [{ field: 'innerRadius' as const,
                    point: { x: n.width / 2 + Math.cos(angle) * n.width / 2 * n.innerRadius, y: n.height / 2 + Math.sin(angle) * n.height / 2 * n.innerRadius },
                    label: '拖动调整星形内半径' }] : []),
                ]
                return handles.map(({ field, point, label }) => {
                  const p = apply(selected[0].matrix, point)
                  return <circle key={field} data-testid={`shape-${field}-handle`} data-node-id={n.id} cx={p.x} cy={p.y} r={5 / zoom}
                    fill="white" stroke="#0d99ff" strokeWidth={1 / zoom} style={{ cursor: field === 'points' ? 'ns-resize' : 'crosshair' }}
                    onPointerDown={e => {
                      e.stopPropagation(); start(e, 'parameter', undefined, n.id)
                      if (drag.current?.kind === 'parameter') { drag.current.parameter = field; editor.begin(label) }
                    }}><title>{label}</title></circle>
                })
              })()}
              <text
                opacity={gpuOverlay ? 0 : 1}
                x={selectionBox.x + selectionBox.width / 2}
                y={selectionBox.y + selectionBox.height + 21 / zoom}
                textAnchor="middle"
                fontSize={10 / zoom}
                fill="#0d99ff"
              >
                {selectionSizeLabel(localSelection, selectionBox, selected[0]?.matrix)}
              </text>
            </g>
          )}
        </g>
        <g transform={`translate(${displayView.x} ${displayView.y}) scale(${zoom})`}
          visibility={exactOverlayMatches || !!ownedDrag ? 'visible' : 'hidden'}>
          {vectorNode?.network && (
            <g transform={matrixString(worldMatrix(state.doc, vectorNode.id))}>
              {vectorNode.network.edges.map((edge) => (
                <React.Fragment key={edge.id}>
                  <path
                    d={edgeD(vectorNode.network!, edge)}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={12 / zoom}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      if (!displayedSnapshot ||
                          e.button !== 0 || !e.isPrimary || drag.current || pencil.current ||
                          (e.ctrlKey && /Mac|iPhone|iPad/.test(navigator.platform))) return
                      if (e.altKey)
                        editor.update(
                          [vectorNode.id],
                          (n) => {
                            if (!n.network) { n.network = editableNetwork(n); delete n.vectorGeometry; n.kind = 'vector'; delete n.arc; delete n.cornerRadius }
                            splitEdge(n.network!, edge.id)
                          },
                          '分割路径段',
                        )
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      if (!displayedSnapshot ||
                          e.button !== 0 || drag.current || pencil.current || !editor.topSelection().includes(vectorNode.id)) return
                      editor.update(
                        [vectorNode.id],
                        (n) => {
                          if (!n.network) { n.network = editableNetwork(n); delete n.vectorGeometry; n.kind = 'vector'; delete n.arc; delete n.cornerRadius }
                          splitEdge(n.network!, edge.id)
                        },
                        '分割路径段',
                      )
                    }}
                  />
                  {(['c1', 'c2'] as const).map((control) => {
                    const p = edge[control],
                      v = vectorNode.network!.vertices.find(
                        (v) => v.id === (control === 'c1' ? edge.from : edge.to),
                      )!
                    return (
                      p && (
                        <g key={control}>
                          <line
                            x1={v.x}
                            y1={v.y}
                            x2={p.x}
                            y2={p.y}
                            stroke="#99ceff"
                            strokeWidth={1 / zoom}
                          />
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r={3.5 / zoom}
                            fill="white"
                            stroke="#0d99ff"
                            strokeWidth={1 / zoom}
                            onPointerDown={(e) => {
                              e.stopPropagation()
                              start(
                                e,
                                'handle',
                                undefined,
                                vectorNode.id,
                                undefined,
                                edge.id,
                                control,
                              )
                            }}
                          />
                        </g>
                      )
                    )
                  })}
                </React.Fragment>
              ))}
              {vectorNode.network.vertices.map((v) => (
                <rect
                  key={v.id}
                  data-testid="vector-anchor"
                  data-node-id={vectorNode.id}
                  x={v.x - 4 / zoom}
                  y={v.y - 4 / zoom}
                  width={8 / zoom}
                  height={8 / zoom}
                  fill={(state.editingVertices?.includes(v.id) || state.editingVertex === v.id) ? '#0d99ff' : 'white'}
                  stroke="#0d99ff"
                  strokeWidth={1 / zoom}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    start(e, 'vertex', undefined, vectorNode.id, v.id)
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    if (!displayedSnapshot ||
                        e.button !== 0 || drag.current || pencil.current || !editor.topSelection().includes(vectorNode.id)) return
                    editor.update(
                      [vectorNode.id],
                      (n) => {
                        if (!n.network) { n.network = editableNetwork(n); delete n.vectorGeometry; n.kind = 'vector'; delete n.arc; delete n.cornerRadius }
                        for (const edge of n.network!.edges) {
                          if (edge.from === v.id) {
                            const to = n.network!.vertices.find((p) => p.id === edge.to)!
                            edge.c1 = lerp(v, to, 0.33)
                          }
                          if (edge.to === v.id) {
                            const from = n.network!.vertices.find((p) => p.id === edge.from)!
                            edge.c2 = lerp(v, from, 0.33)
                          }
                        }
                      },
                      '转换为曲线节点',
                    )
                  }}
                />
              ))}
            </g>
          )}
          {cropRect && drag.current?.kind === 'crop' && drag.current.node && state.doc.nodes[drag.current.node.id] && (
            <g
              data-testid="crop-overlay"
              transform={matrixString(worldMatrix(state.doc, drag.current.node.id))}
              pointerEvents="none"
            >
              <path
                d={`M0 0H${state.doc.nodes[drag.current.node.id].width}V${state.doc.nodes[drag.current.node.id].height}H0Z M${cropRect.x} ${cropRect.y}h${cropRect.width}v${cropRect.height}h${-cropRect.width}Z`}
                fillRule="evenodd"
                fill="#00000066"
              />
              <rect {...cropRect} fill="none" stroke="#ffffff" strokeWidth={1 / zoom} />
            </g>
          )}
          {rubber && (
            <g><rect
              {...rubber}
              fill={drag.current?.kind === 'marquee' ? '#0d99ff19' : 'none'}
              stroke="#0d99ff"
              strokeWidth={1 / zoom}
              strokeDasharray={
                drag.current?.kind === 'marquee' ? undefined : `${4 / zoom} ${3 / zoom}`
              }
              pointerEvents="none"
            />{drag.current?.kind === 'create' && <text x={rubber.x + rubber.width / 2} y={rubber.y + rubber.height + 18 / zoom}
              textAnchor="middle" fontSize={11 / zoom} fill="#0d99ff" pointerEvents="none" data-testid="creation-dimensions" data-width={rubber.width} data-height={rubber.height}>
              {Number(rubber.width.toFixed(2))} × {Number(rubber.height.toFixed(2))}
            </text>}</g>
          )}
          {measurements.map((m,i)=><g key={`measurement-${i}`} data-testid="canvas-measurement" pointerEvents="none" opacity={gpuOverlay?0:1}>
            <line x1={m.from.x} y1={m.from.y} x2={m.to.x} y2={m.to.y} stroke="#f24822" strokeWidth={1/zoom}/>
            <text x={(m.from.x+m.to.x)/2+4/zoom} y={(m.from.y+m.to.y)/2-5/zoom} fontSize={11/zoom} fill="#f24822" paintOrder="stroke" stroke="#fff" strokeWidth={2/zoom}>{Number(m.distance.toFixed(2))}</text>
          </g>)}
          {!guides.surface && guides.x && (
            <line
              x1={guides.x.position}
              x2={guides.x.position}
              y1={guides.x.start}
              y2={guides.x.end}
              stroke="#ed6996"
              strokeWidth={1 / zoom}
            />
          )}{' '}
          {!guides.surface && guides.y && (
            <line
              y1={guides.y.position}
              y2={guides.y.position}
              x1={guides.y.start}
              x2={guides.y.end}
              stroke="#ed6996"
              strokeWidth={1 / zoom}
            />
          )}
          {pen && (
            <g
              transform={pen.id ? matrixString(worldMatrix(state.doc, pen.id)) : undefined}
              pointerEvents="none"
            >
              <path d={networkD(pen.network)} fill="none" stroke="#0d99ff" strokeWidth={2 / zoom} />
              {pen.network.vertices.map((v) => (
                <circle
                  key={v.id}
                  cx={v.x}
                  cy={v.y}
                  r={4 / zoom}
                  fill="white"
                  stroke="#0d99ff"
                  strokeWidth={1 / zoom}
                />
              ))}
              {pen.last &&
                cursor &&
                (() => {
                  const from = pen.network.vertices.find((v) => v.id === pen.last)!,
                    to = pen.id ? apply(inverse(worldMatrix(state.doc, pen.id)), cursor) : cursor
                  return (
                    <path
                      d={`M${from.x} ${from.y} L${to.x} ${to.y}`}
                      stroke="#0d99ff"
                      strokeWidth={1 / zoom}
                      strokeDasharray={`${4 / zoom} ${4 / zoom}`}
                    />
                  )
                })()}
            </g>
          )}
        </g>
      </svg>
      {selectionFeedback.message && <div role="status" data-testid="canvas-selection-reason"
        style={{position:'absolute',left:12,top:12,zIndex:4,pointerEvents:'none',padding:'5px 8px',borderRadius:4,background:'#ffffffeb',color:'#616675',fontSize:11}}>
        {selectionFeedback.message}
      </div>}
      <div className="canvas-caption">
        <span className="status-dot" />
        自由画布<span>拖入图片 · 双击编辑矢量 · 空格拖动画布</span>
      </div>
      {pen && (
        <div className="pen-hint">
          点击添加节点，拖动创建曲线；点击已有节点可连接分支。
          <button
            onClick={(e) => {
              e.stopPropagation()
              finishPen()
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            完成 ↵
          </button>
        </div>
      )}
      <CanvasScrollbars editor={editor} entries={entries} view={state.view} size={size} onPanGestureChange={setPanning} contentBounds={nativeSource?.bounds}/>
      {zoomControlsTarget ? createPortal(<ViewControls editor={editor} size={size} fit={fitView} compact />, zoomControlsTarget) : <ViewControls editor={editor} size={size} fit={fitView} compact={compactChrome} />}
    </div>
  )
}
