import { prototypeFrameView } from './prototype'
import { animation_plan_sample_json } from './generated/design-kernel/design_kernel'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesignDocument } from './model'
import { KernelSurface } from './kernel/Surface'
import { KernelClient } from './kernel/client'
import { desktopBridge } from './desktop'
import {
  encodeDesktopFrames,
  MOTION_PREVIEW_FPS,
  motionPreviewTimes,
  useVideoEncodeAvailable,
} from './motion-video'
import { kernelLayout } from './kernel/picking'
import { allParents, scene } from './geometry'
import { createAnimationBakeSession, kernelBakeRevision, type KernelAnimationBakeSession } from './kernel/bake-session'
import { initialPrototype, prototypeEase, prototypeEvent, prototypeDocument, type Interaction } from './prototype'
import { animatePrototypeScroll } from './prototype-scroll'
import { framesNeedLightweightMotion, lightenPrototypeMotion, reducedMotionRequested, startTransitionClock } from './prototype-motion'
import { modalKeyDown, useModalOwnership } from './modal-keyboard'
import { downloadAsset, prototypeTitle, useProfessionalDialogText } from './professional-dialog-messages'

export function PrototypePlayer({
  document: source,
  onClose,
}: {
  document: DesignDocument
  onClose: () => void
}) {
  const { locale, tr } = useProfessionalDialogText()
  const [state, setState] = useState(() => initialPrototype(source)),
    [error, setError] = useState(''),
    [exporting, setExporting] = useState(false),
    [videoAsset, setVideoAsset] = useState<{ url: string; name: string } | null>(null)
  const videoReady = useVideoEncodeAvailable()
  const scroll = useRef<HTMLDivElement>(null),
    snapshot = useRef(source),
    backdrop = useRef<HTMLDivElement>(null),
    closeButton = useRef<HTMLButtonElement>(null),
    exportingRef = useRef(false)
  const [scrollPosition, setScrollPosition] = useState({ left: 0, top: 0 })
  exportingRef.current = exporting
  useModalOwnership(backdrop, closeButton)
  snapshot.current = source
  // Preview deliberately owns an immutable design version and temporary values.
  const [progress, setProgress] = useState(1)
  const transition = state.transition
  const lightweight = !!state.transitionFallback || (!!transition && framesNeedLightweightMotion(snapshot.current, transition.from, transition.to))
  useLayoutEffect(() => {
    const crossfade = lightweight || state.transitionStyle === 'dissolve' || !!state.transitionStyle?.startsWith('slide-')
    if ((!transition && !crossfade) || !state.transitionMs || reducedMotionRequested()) { setProgress(1); return }
    setProgress(0)
    return startTransitionClock(state.transitionMs, setProgress)
  }, [lightweight, transition, state.transitionMs, state.transitionSerial, state.transitionStyle, state.transitionFallback])
  const valuesKey = JSON.stringify([state.values, state.modeValues])
  const settled = useMemo(() => kernelLayout(prototypeDocument(source, state)), [source, valuesKey])
  // One bake per (document, from, to) transition through the kernel's stateful
  // bake session (plan cache + in-flight mutex); per-frame ticks only sample.
  // The stateless per-frame sampler below stays as the fallback when the
  // kernel module or the binding is unavailable.
  const [bake, setBake] = useState<{ document: DesignDocument; transition: typeof transition; session: KernelAnimationBakeSession } | null>(null)
  // A render of the next transition must never sample the previous (possibly
  // already freed) WASM session before its effect installs the new owner.
  const bakeSession = bake?.document === settled && bake.transition === transition ? bake.session : null
  useEffect(() => {
    if (!transition || !state.transitionMs || lightweight) { setBake(null); return }
    const session = createAnimationBakeSession()
    if (!session) { setBake(null); return }
    try {
      const json = JSON.stringify(settled)
      session.bake(json, json, transition.from, transition.to, kernelBakeRevision(settled))
    } catch {
      session.free()
      setBake(null)
      return
    }
    setBake({ document: settled, transition, session })
    // free() drops the session's guard, releasing the frame pair.
    return () => session.free()
  }, [settled, transition, state.transitionMs, lightweight])
  const sampled = useMemo(() => {
    try {
      if (!transition || !state.transitionMs || lightweight) return { document: settled, error: '' }
      // Time remains [0,1]; eased position may overshoot. The kernel clamps
      // opacity and dimensions independently, preserving spring movement.
      const eased = prototypeEase(state.transitionEasing, progress)
      const parsed = JSON.parse(bakeSession
        ? bakeSession.sample_json(eased)
        : animation_plan_sample_json(JSON.stringify(settled),transition.from,transition.to,eased)) as DesignDocument
      // Open interval only. Endpoints stay on the authored document so glass
      // and blur settle at their saved values. The cap is a preview composite,
      // not a document edit and not a raster-budget change.
      const document = progress > 0 && progress < 1 ? lightenPrototypeMotion(parsed) : progress < 1 ? parsed : settled
      return { document, error: '' }
    }
    catch { return { document: settled, error: '' } }
  }, [settled,transition,progress,bakeSession,lightweight,state.transitionEasing,state.transitionMs])
  const doc = sampled.document
  const current = state.current,
    n = doc.nodes[current],
    parents = allParents(doc)
  const page =
    doc.pages.find((p) => {
      let id = current
      while (parents.has(id)) id = parents.get(id)!
      return p.id === id
    }) || doc.pages[0]
  const entries = scene(doc, page.id),
    entry = entries.find((e) => e.id === current)!
  const descendants = new Set<string>()
  const visit = (id: string) => {
    descendants.add(id)
    doc.nodes[id].children.forEach(visit)
  }
  visit(current)
  const frame = entry?.bounds || { x: 0, y: 0, width: n.width, height: n.height }
  const overflow = n.prototypeOverflow
  const scrollX = overflow === 'horizontal' || overflow === 'both'
  const scrollY = overflow === 'vertical' || overflow === 'both'
  const zoom = Math.min(1, 900 / Math.max(1, frame.width), overflow === undefined ? 1 : 720 / Math.max(1, frame.height))
  const width = Math.ceil(frame.width * zoom)
  const height = Math.min(720, Math.ceil(frame.height * zoom))
  // Keep the renderer viewport-sized. Only the scroll spacer grows with
  // the visible descendants, and clipped nested frames constrain that growth.
  let contentRight = frame.x + frame.width
  let contentBottom = frame.y + frame.height
  if (scrollX || scrollY) {
    const bounds = new Map(entries.map(e => [e.id, e.bounds]))
    for (const layer of entries) {
      if (!layer.ancestors.includes(current)) continue
      let right = layer.bounds.x + layer.bounds.width
      let bottom = layer.bounds.y + layer.bounds.height
      for (const parent of layer.ancestors.slice(layer.ancestors.indexOf(current) + 1)) {
        const clip = bounds.get(parent)
        if (clip && doc.nodes[parent].clip) {
          right = Math.min(right, clip.x + clip.width)
          bottom = Math.min(bottom, clip.y + clip.height)
        }
      }
      contentRight = Math.max(contentRight, right)
      contentBottom = Math.max(contentBottom, bottom)
    }
  }
  const contentWidth = scrollX ? Math.ceil((contentRight - frame.x) * zoom) : width
  const contentHeight = scrollY ? Math.ceil((contentBottom - frame.y) * zoom)
    : overflow === undefined ? Math.ceil(frame.height * zoom) : height
  const slideProgress = prototypeEase(state.transitionEasing, progress)
  const slideOffset = state.transitionStyle?.startsWith('slide-') && progress < 1
    ? `${state.transitionStyle==='slide-left'?-(1-slideProgress)*100:state.transitionStyle==='slide-right'?(1-slideProgress)*100:0}%,${state.transitionStyle==='slide-top'?-(1-slideProgress)*100:state.transitionStyle==='slide-bottom'?(1-slideProgress)*100:0}%` : '0%,0%'
  const previous = useMemo(()=> {
    if (!state.transitionFrom || !settled.nodes[state.transitionFrom]) return undefined
    const view=prototypeFrameView(settled,state.transitionFrom)
    return {...view,entry:scene(view.document,view.pageId).find(e=>e.id===state.transitionFrom)}
  }, [settled,state.transitionFrom])
  const previousScroll = useRef({ left: 0, top: 0 })
  const dispatch = (id: string, trigger: Interaction['trigger'], only?: Interaction) => {
    try {
      previousScroll.current = { left: scroll.current?.scrollLeft ?? 0, top: scroll.current?.scrollTop ?? 0 }
      setState(prototypeEvent(settled, state, id, trigger, only))
      setError('')
    } catch (e) {
      setError(String(e))
    }
  }
  useLayoutEffect(() => {
    if (!state.navigation) return
    const point = state.navigation.preserveScroll ? previousScroll.current : { left: 0, top: 0 }
    const element = scroll.current
    if (!element) return
    element.scrollTo({ left: scrollX ? point.left : 0, top: scrollY || overflow === undefined ? point.top : 0, behavior: 'instant' })
    setScrollPosition({ left: element.scrollLeft, top: element.scrollTop })
  }, [state.navigation?.serial, overflow, scrollX, scrollY])
  useEffect(() => {
    const timers: number[] = []
    for (const [id, events] of Object.entries(doc.prototype?.interactions || {}))
      if (descendants.has(id))
        for (const e of events)
          if (e.trigger === 'after-delay')
            timers.push(window.setTimeout(() => dispatch(id, e.trigger, e), e.delayMs || 0))
    return () => timers.forEach(clearTimeout)
  }, [current])
  useEffect(() => {
    if (state.scrollTarget) {
      const target = entries.find((e) => e.id === state.scrollTarget)
      const element=scroll.current
      if (target && element) {
        const cancel=animatePrototypeScroll(element,{
          left: scrollX ? (target.bounds.x - frame.x) * zoom : 0,
          top: scrollY || overflow === undefined ? (target.bounds.y - frame.y) * zoom : 0,
        },state.transitionMs,state.transitionEasing)
        const interrupt=()=>cancel()
        for(const event of ['wheel','touchstart','pointerdown'])element.addEventListener(event,interrupt,{passive:true})
        return ()=>{cancel();for(const event of ['wheel','touchstart','pointerdown'])element.removeEventListener(event,interrupt)}
      }
    }
  }, [state.scrollTarget, state.current, state.scrollRequest])
  // Hide unrelated roots/siblings while retaining definitions for component resolution.
  const visibleDoc = useMemo(() => prototypeFrameView(doc, current, scrollX || scrollY).document, [doc, current, scrollX, scrollY])
  useEffect(() => () => {
    if (videoAsset) URL.revokeObjectURL(videoAsset.url)
  }, [videoAsset])
  async function exportTransition(format: 'mp4' | 'webm') {
    const bridge = desktopBridge()?.videoEncode
    if (!bridge || !transition || !state.transitionMs) {
      setError('需要一次智能动画过渡。滑动仍是界面位移，不进入 FFmpeg。')
      return
    }
    const client = new KernelClient()
    setExporting(true)
    try {
      const times = motionPreviewTimes(state.transitionMs)
      const destination = prototypeFrameView(settled, transition.to)
      const box = scene(destination.document, destination.pageId).find(entry => entry.id === transition.to)?.bounds
        || { x: 0, y: 0, width: settled.nodes[transition.to]?.width || 1, height: settled.nodes[transition.to]?.height || 1 }
      const fitted = Math.min(960 / Math.max(1, box.width), 540 / Math.max(1, box.height), 1)
      const width = Math.max(2, Math.ceil(box.width * fitted))
      const height = Math.max(2, Math.ceil(box.height * fitted))
      const camera = { x: -box.x * fitted, y: -box.y * fitted, zoom: fitted }
      const settledJson = JSON.stringify(settled)
      const frames: Uint8Array[] = []
      for (const timeMs of times) {
        const progress = Math.min(1, timeMs / Math.max(1, state.transitionMs))
        const eased = prototypeEase(state.transitionEasing, progress)
        const sampled = JSON.parse(animation_plan_sample_json(settledJson, transition.from, transition.to, eased)) as DesignDocument
        const view = prototypeFrameView(sampled, transition.to)
        const rendered = await client.render(view.document, {
          pageId: view.pageId,
          width,
          height,
          view: camera,
          grid: false,
          transparent: false,
          rasterProfile: source.rasterProfile || 'analytic',
        }, true)
        frames.push(rendered.bytes)
      }
      const encoded = await encodeDesktopFrames(bridge, { format, fps: MOTION_PREVIEW_FPS, frames })
      setVideoAsset({
        url: URL.createObjectURL(new Blob([encoded.bytes], { type: encoded.mime })),
        name: `prototype-transition.${format}`,
      })
      setError('')
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError))
    } finally {
      client.dispose()
      setExporting(false)
    }
  }
  return (
    <div ref={backdrop} className="feature-backdrop" onKeyDown={event => modalKeyDown(event, () => { if (!exportingRef.current) onClose() })}>
      <div className="prototype-player" data-transition-progress={progress} data-transition-ms={state.transitionMs} data-transition-easing={state.transitionEasing || 'linear'} data-transition-kind={transition ? 'smart' : lightweight ? 'fade' : state.transitionStyle === 'dissolve' ? 'dissolve' : state.transitionStyle?.startsWith('slide-') ? 'slide' : 'none'} data-animation-plan={lightweight ? 'opacity' : transition ? (bakeSession ? "kernel-baked" : "kernel") : "none"} role="dialog" aria-modal="true" aria-label={tr('交互原型预览')} tabIndex={-1}>
        <header>
          <strong>{prototypeTitle(n.name, locale)}</strong>
          <button type="button" onClick={() => { setVideoAsset(null); setState(initialPrototype(snapshot.current)); setError(''); scroll.current?.scrollTo(0, 0); setScrollPosition({ left: 0, top: 0 }) }}>
            {tr('重新开始')}
          </button>
          <button
            type="button"
            onClick={() =>
              dispatch(current, 'click', { trigger:'click', actions:[{kind:'back',durationMs:state.transitionMs}] })
            }
          >
            {tr('返回')}
          </button>
          <button ref={closeButton} type="button" onClick={onClose}>
            {tr('关闭预览')}
          </button>
          {videoReady && (
            <>
              <button type="button" disabled={exporting || !transition} title={transition ? tr('用打包的 FFmpeg 编码这次智能动画') : tr('先触发一次智能动画过渡')} onClick={() => void exportTransition('mp4')}>
                {tr('导出过渡 MP4')}
              </button>
              <button type="button" disabled={exporting || !transition} title={transition ? tr('用打包的 FFmpeg 编码这次智能动画') : tr('先触发一次智能动画过渡')} onClick={() => void exportTransition('webm')}>
                {tr('导出过渡 WebM')}
              </button>
            </>
          )}
          {videoAsset && <a href={videoAsset.url} download={videoAsset.name}>{downloadAsset(videoAsset.name, locale)}</a>}
        </header>
        {error && <p role="alert">{tr(error)}</p>}
        <div style={{ position: 'relative' }}>
          <div
            ref={scroll}
            data-testid="prototype-scroll"
            data-overflow={overflow ?? 'legacy'}
            tabIndex={scrollX || scrollY ? 0 : undefined}
            onScroll={event => setScrollPosition({ left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop })}
            style={{
              overflowX: scrollX ? 'auto' : 'hidden',
              overflowY: scrollY || overflow === undefined ? 'auto' : 'hidden',
              width,
              height,
              position: 'relative',
              background: '#fff',
            }}
          >
            {previous?.entry && progress<1 && (lightweight || state.transitionStyle?.startsWith('slide-') || state.transitionStyle === 'dissolve') && <div key={state.transitionFrom} aria-hidden="true" style={{position:'absolute',inset:0,pointerEvents:'none',opacity:state.transitionStyle==='dissolve'?1-slideProgress:lightweight?1-progress:1}}>
              <StillFrame document={previous.document} pageId={previous.pageId} width={Math.ceil(frame.width*zoom)} height={Math.ceil(frame.height*zoom)} x={-previous.entry.bounds.x*zoom} y={-previous.entry.bounds.y*zoom} zoom={zoom}/>
            </div>}
            <div
              key={current}
              style={{
                position: 'relative',
                width: contentWidth,
                height: contentHeight,
                transform: `translate(${slideOffset})`,
                opacity: state.transitionStyle === 'dissolve' && progress < 1 ? slideProgress : lightweight && progress < 1 ? progress : 1,
                background: '#fff',
              }}
            >
              <div style={{ position: 'absolute', left: scrollPosition.left, top: scrollPosition.top, pointerEvents: 'none' }}>
                <StillFrame
                  document={visibleDoc}
                  pageId={page.id}
                  width={width}
                  height={height}
                  x={-frame.x * zoom - scrollPosition.left}
                  y={-frame.y * zoom - scrollPosition.top}
                  zoom={zoom}
                />
              </div>
              {entries
                .filter((e) => descendants.has(e.id) && doc.prototype?.interactions[e.id]?.length)
                .map((e) => {
                  return (
                    <button
                      type="button"
                      key={e.id}
                      aria-label={doc.nodes[e.id].name || tr('交互区域')}
                      className="prototype-hotspot"
                      style={{
                        position: 'absolute',
                        left: (e.bounds.x - frame.x) * zoom,
                        top: (e.bounds.y - frame.y) * zoom,
                        width: Math.max(1, e.bounds.width * zoom),
                        height: Math.max(1, e.bounds.height * zoom),
                        zIndex: 2,
                      }}
                      disabled={state.overlays.length > 0 || progress < 1}
                      onClick={() => dispatch(e.id, 'click')}
                      onPointerEnter={() => dispatch(e.id, 'hover')}
                      onPointerLeave={() => dispatch(e.id, 'leave')}
                    />
                  )
                })}
            </div>
          </div>
          {state.overlays.map((id, index) => {
            const position = state.overlayPositions?.[index]
            const box = entries.find(e => e.id === id)?.bounds || doc.nodes[id]
            const origin = position?.origin || 'center', padding = (position?.padding || 0) * zoom
            const left = origin === 'manual' ? (position?.x || 0) * zoom : origin.endsWith('left') ? padding : origin.endsWith('right')
              ? frame.width * zoom - box.width * zoom - padding : (frame.width - box.width) * zoom / 2
            const top = origin === 'manual' ? (position?.y || 0) * zoom : origin.startsWith('top') ? padding : origin.startsWith('bottom')
              ? height - box.height * zoom - padding : (height - box.height * zoom) / 2
            return (
            <div
              key={`${id}-${index}`}
              style={{
                position: 'absolute',
                inset: 0,
                background: position?.background === false ? 'transparent' : '#0005',
                zIndex: index + 1,
              }}
            >
              <div style={{ position: 'absolute', left, top }}><Overlay doc={doc} id={id} zoom={zoom} dispatch={dispatch} /></div>
            </div>
          )})}
        </div>
      </div>
    </div>
  )
}

const StillFrame = memo(function StillFrame({ document, pageId, width, height, x, y, zoom }: {
  document: DesignDocument
  pageId: string
  width: number
  height: number
  x: number
  y: number
  zoom: number
}) {
  return <KernelSurface document={document} pageId={pageId} width={width} height={height} view={{ x, y, zoom }} grid={false} />
})

function Overlay({
  doc,
  id,
  zoom,
  dispatch,
}: {
  doc: DesignDocument
  id: string
  zoom: number
  dispatch: (id: string, trigger: Interaction['trigger'], only?: Interaction) => void
}) {
  const { tr } = useProfessionalDialogText()
  const parents = allParents(doc)
  let pageId = id
  while (parents.has(pageId)) pageId = parents.get(pageId)!
  const entries = scene(doc, pageId),
    box = entries.find((e) => e.id === id)!.bounds,
    nodes = { ...doc.nodes },
    children = new Set<string>()
  const visit = (id: string) => {
    children.add(id)
    doc.nodes[id].children.forEach(visit)
  }
  visit(id)
  let at = id
  while (parents.has(at)) {
    const parent = parents.get(at)!,
      siblings = nodes[parent]?.children || doc.pages.find((p) => p.id === parent)!.children
    for (const sibling of siblings)
      if (sibling !== at) nodes[sibling] = { ...nodes[sibling], visible: false }
    at = parent
  }
  useEffect(() => {
    const timers: number[] = []
    for (const target of children)
      for (const e of doc.prototype?.interactions[target] || [])
        if (e.trigger === 'after-delay')
          timers.push(window.setTimeout(() => dispatch(target, e.trigger, e), e.delayMs || 0))
    return () => timers.forEach(clearTimeout)
  }, [id])
  return (
    <div
      className="prototype-overlay"
      style={{
        position: 'relative',
        width: box.width * zoom,
        height: box.height * zoom,
        background: 'white',
        boxShadow: '0 8px 40px #0005',
      }}
    >
      <KernelSurface
        document={{ ...doc, nodes }}
        pageId={pageId}
        width={Math.ceil(box.width * zoom)}
        height={Math.ceil(box.height * zoom)}
        view={{ x: -box.x * zoom, y: -box.y * zoom, zoom }}
        grid={false}
      />
      {entries
        .filter((e) => children.has(e.id) && doc.prototype?.interactions[e.id]?.length)
        .map((e) => {
          const m = e.matrix
          return (
            <button
              type="button"
              key={e.id}
              className="prototype-hotspot"
              aria-label={doc.nodes[e.id].name || tr('弹层交互')}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: doc.nodes[e.id].width,
                height: doc.nodes[e.id].height,
                transformOrigin: '0 0',
                transform: `matrix(${m[0] * zoom},${m[1] * zoom},${m[2] * zoom},${m[3] * zoom},${(m[4] - box.x) * zoom},${(m[5] - box.y) * zoom})`,
              }}
              onClick={() => dispatch(e.id, 'click')}
              onPointerEnter={() => dispatch(e.id, 'hover')}
              onPointerLeave={() => dispatch(e.id, 'leave')}
            />
          )
        })}
    </div>
  )
}
