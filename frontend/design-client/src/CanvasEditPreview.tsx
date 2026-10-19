import { memo, useLayoutEffect, useRef, useMemo, useState, type RefObject } from 'react'
import { captureBoardFrame, retainedBoardPlan, retainedBoardOffset, retainedBoardTransformOffset } from './retained-board-preview'
import type { DesignDocument, Matrix } from './model'
import type { CanvasCamera, CanvasSize } from './canvas-camera'
import { Scene } from './Renderer'
import { movePreviewPlan, movePreviewOffset, retainedSvgMove } from './edit-preview'
import { matrixString } from './geometry'
import { useDevicePixelRatio } from './kernel/presentation'
import { retainedCaptureMatches, retainedPixelOffset } from './edit-preview-pixels'
const EditScene = memo(Scene)
export type RetainedMoveControl = { apply(document: DesignDocument, id: string, transform: Matrix): boolean; covers(document: DesignDocument, selection: string[], view: CanvasCamera): boolean; restore(): void }

/** Warm immutable paths before the first gesture, then update the browser's
 * composited vector scene at input cadence while the exact worker catches up.
 * This is explicitly transient and never used for export or exact readiness. */
export const CanvasEditPreview = memo(function CanvasEditPreview({ document, baseDocument, selection, pageId, view, size, visible, inputAt, sourceHost, canCapture, control, vectorSupported }:
  { document: DesignDocument; baseDocument: DesignDocument; selection: string[]; pageId: string; view: CanvasCamera; size: CanvasSize; visible: boolean; inputAt: number; sourceHost: RefObject<HTMLDivElement|null>; canCapture: boolean; control: RefObject<RetainedMoveControl|null>; vectorSupported: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const samples = useRef<number[]>([])
  const directSamples = useRef<number[]>([])
  const pixelRatio = useDevicePixelRatio()
  const [retained, setRetained] = useState<{ plan: NonNullable<ReturnType<typeof retainedBoardPlan>>; pixels: NonNullable<ReturnType<typeof captureBoardFrame>>; view: CanvasCamera; size: CanvasSize } | null>(null)
  const retainedHost = useRef<HTMLDivElement>(null)
  const movedOverlays = useRef(new Map<SVGElement, string>())
  const movedDefinitions = useRef(new Map<SVGElement, string>())
  const vectorHost = useRef<SVGSVGElement>(null)
  const svgPlan = useMemo(() => vectorSupported ? retainedSvgMove(baseDocument, pageId, selection) : null,
    [baseDocument, pageId, selection.join(','), vectorSupported])
  const boardPlanCache = useRef<{ document: DesignDocument; pageId: string; selection: string; plan: ReturnType<typeof retainedBoardPlan> } | null>(null)
  useLayoutEffect(() => {
    if (visible || !canCapture || !sourceHost.current) return
    // The 2D snapshot is sRGB8; it cannot retain managed/HDR presentation.
    const cached = boardPlanCache.current, selected = selection.join(',')
    const plan = cached?.document === document && cached.pageId === pageId && cached.selection === selected
      ? cached.plan : !document.colorManagement ? retainedBoardPlan(document, pageId, selection) : null
    boardPlanCache.current = { document, pageId, selection: selected, plan }
    if (host.current) host.current.dataset.retainPlan = plan ? JSON.stringify(plan.box) : 'ineligible'
    const pixels = plan && captureBoardFrame(sourceHost.current, plan.box, view)
    setRetained(plan && pixels ? { plan, pixels, view, size } : null)
  }, [document, pageId, selection.join(','), view.x, view.y, view.zoom, size.width, size.height, pixelRatio, visible, canCapture])
  const retainedCurrent = retained && !document.colorManagement && retainedCaptureMatches(retained, view, size, pixelRatio) ? retained : null
  const retainedDocumentOffset = useMemo(() => retainedCurrent ? retainedBoardOffset(retainedCurrent.plan, document) : null, [retainedCurrent, document])
  const retainedOffset = retainedCurrent && selection.length === 1 && retainedCurrent.plan.id === selection[0]
    ? retainedPixelOffset(retainedDocumentOffset, view.zoom, pixelRatio) : null
  const hasContent = !!retainedOffset || vectorSupported
  // Layout cleanup runs after child DOM mutations. Read the current visibility
  // instead of restoring the previous render's value over the new exact frame.
  const currentVisibility = useRef(false)
  currentVisibility.current = visible && hasContent
  useLayoutEffect(() => {
    let validatedDocument = document, validatedOffset = retainedDocumentOffset
    const offsetFor = (current: DesignDocument) => {
      if (current !== validatedDocument) {
        validatedDocument = current
        validatedOffset = retained ? retainedBoardOffset(retained.plan, current) : null
      }
      return validatedOffset
    }
    const restore = () => {
      for (const [element, transform] of movedDefinitions.current) element.setAttribute('transform', transform)
      movedDefinitions.current.clear()
      for (const [element, transform] of movedOverlays.current) element.style.transform = transform
      movedOverlays.current.clear()
      if (host.current) { host.current.style.visibility = currentVisibility.current ? 'visible' : 'hidden'; host.current.dataset.directMove = 'false' }
    }
    control.current = {
      restore,
      covers(current, selected, camera) {
        return !!retained && !current.colorManagement && selected.length === 1 && selected[0] === retained.plan.id &&
          retainedCaptureMatches(retained, camera, size, pixelRatio) &&
          retainedPixelOffset(offsetFor(current), camera.zoom, pixelRatio) !== null
      },
      apply(current, id, transform) {
        const started = performance.now()
        if (!host.current) return false
        let offset: { x: number; y: number } | null = null
        if (retainedCurrent && retainedOffset && id === retainedCurrent.plan.id && retainedHost.current && offsetFor(current)) {
          offset = retainedPixelOffset(retainedBoardTransformOffset(retainedCurrent.plan, transform), view.zoom, pixelRatio)
          if (offset) retainedCurrent.pixels.foreground.style.transform = `translate(${offset.x * view.zoom}px,${offset.y * view.zoom}px)`
        }
        if (!offset && svgPlan?.id === id && current === svgPlan.source && vectorHost.current &&
          transform.slice(0, 4).every((value, i) => value === current.nodes[id].transform[i])) {
          const definition = vectorHost.current.querySelector<SVGElement>(`[data-edit-node="${CSS.escape(id)}"]`)
          if (!definition) return false
          if (!movedDefinitions.current.has(definition)) movedDefinitions.current.set(definition, definition.getAttribute('transform') || '')
          definition.setAttribute('transform', matrixString(transform))
          const old = current.nodes[id].transform, parent = svgPlan.parentMatrix
          const dx = transform[4] - old[4], dy = transform[5] - old[5]
          offset = { x: parent[0] * dx + parent[2] * dy, y: parent[1] * dx + parent[3] * dy }
          host.current.dataset.directMoveKind = 'svg'
        }
        if (!offset) return false
        host.current.style.visibility = 'visible'; host.current.dataset.directMove = 'true'
        const elements = sourceHost.current?.querySelectorAll<SVGElement>('[data-testid="canvas-selection-outline"],[data-testid^="resize-"],[data-testid^="rotate-"],[data-testid="rotation-origin"]') || []
        for (const element of elements) {
          if (!movedOverlays.current.has(element)) movedOverlays.current.set(element, element.style.transform)
          element.style.transform = `translate(${offset.x}px,${offset.y}px)`
        }
        directSamples.current.push(performance.now() - started)
        directSamples.current = directSamples.current.slice(-60)
        host.current.dataset.directMoveSamples = JSON.stringify(directSamples.current)
        return true
      },
    }
    return () => { restore(); control.current = null }
  }, [retained, retainedCurrent, document, retainedDocumentOffset, retainedOffset?.x, retainedOffset?.y, visible, view.zoom, size.width, size.height, pixelRatio, control, sourceHost, svgPlan])
  useLayoutEffect(() => {
    if (!retained || !retainedHost.current || !retainedOffset) return
    const { background, foreground, crop, width, height } = retained.pixels
    background.style.cssText = `position:absolute;inset:0;width:${width}px;height:${height}px`
    foreground.style.cssText = `position:absolute;left:${crop.x}px;top:${crop.y}px;width:${crop.width}px;height:${crop.height}px;will-change:transform;transform:translate(${retainedOffset.x * view.zoom}px,${retainedOffset.y * view.zoom}px)`
    if (background.parentElement !== retainedHost.current) retainedHost.current.replaceChildren(background, foreground)
  }, [retained, retainedOffset?.x, retainedOffset?.y, view.zoom])
  const plan = useMemo(() => movePreviewPlan(baseDocument, pageId, selection), [baseDocument, pageId, selection.join(',')])
  const offset = useMemo(() => plan && movePreviewOffset(plan, document), [plan, document])
  const viewport = useMemo(() => ({ x: -view.x / view.zoom, y: -view.y / view.zoom,
    width: size.width / view.zoom, height: size.height / view.zoom }), [view.x, view.y, view.zoom, size.width, size.height])
  // Keep a padded culling window stable through camera gestures. Otherwise
  // warming a retained selection would rebuild the hidden SVG on every pan.
  const retainedViewport = useRef<{ document: DesignDocument; page: string; box: typeof viewport } | null>(null)
  const cached = retainedViewport.current
  if (!cached || cached.document !== baseDocument || cached.page !== pageId ||
    viewport.x < cached.box.x || viewport.y < cached.box.y ||
    viewport.x + viewport.width > cached.box.x + cached.box.width ||
    viewport.y + viewport.height > cached.box.y + cached.box.height) {
    retainedViewport.current = { document: baseDocument, page: pageId,
      box: { x: viewport.x - viewport.width * .25, y: viewport.y - viewport.height * .25, width: viewport.width * 1.5, height: viewport.height * 1.5 } }
  }
  useLayoutEffect(() => {
    if (!visible || !host.current) return
    const elapsed = inputAt ? performance.now() - inputAt : 0
    host.current.dataset.domReadyMs = elapsed.toFixed(2)
    if (inputAt && elapsed < 5000) { samples.current.push(elapsed); samples.current = samples.current.slice(-60) }
    host.current.dataset.domSamples = JSON.stringify(samples.current)
    const frame = requestAnimationFrame(() => {
      if (host.current) host.current.dataset.frameReadyMs = inputAt ? (performance.now() - inputAt).toFixed(2) : '0'
    })
    return () => cancelAnimationFrame(frame)
  }, [document, visible, inputAt])
  const layer = (doc: DesignDocument, foreground = false) => <svg width={size.width} height={size.height}
    style={{ position:'absolute', inset:0, overflow:'visible', ...(foreground ? { willChange:'transform', transform:`translate(${offset!.x * view.zoom}px, ${offset!.y * view.zoom}px)` } : {}) }}>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}><EditScene doc={doc} pageId={pageId} viewport={offset ? undefined : viewport} exporting/></g>
  </svg>
  return <div ref={host} data-testid="canvas-edit-preview" data-active={String(visible && hasContent)} data-can-capture={String(canCapture)} data-layered={String(!!offset)} data-retained-board={String(!!retainedOffset)} aria-hidden="true"
    style={{ position: 'absolute', inset: 0, overflow:'hidden', pointerEvents: 'none', visibility: visible && hasContent ? 'visible' : 'hidden',
      background: document.pages.find(p => p.id === pageId)?.background || '#ffffff' }}>
    {retainedOffset ? <div ref={retainedHost}/> : svgPlan && document === baseDocument ?
      <svg ref={vectorHost} width={size.width} height={size.height} style={{position:'absolute',inset:0,overflow:'visible'}}>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}><EditScene doc={baseDocument} pageId={pageId} viewport={retainedViewport.current!.box} retainedNodeId={svgPlan.id} exporting/></g>
      </svg> : vectorSupported && visible &&
      (offset ? <>{layer(plan!.background)}{layer(plan!.foreground, true)}</> : layer(document))}
  </div>
})
