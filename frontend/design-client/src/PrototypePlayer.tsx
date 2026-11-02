import { prototypeFrameView } from './prototype'
import { animation_plan_sample_json } from './generated/design-kernel/design_kernel'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DesignDocument } from './model'
import { KernelSurface } from './kernel/Surface'
import { kernelLayout } from './kernel/picking'
import { allParents, scene } from './geometry'
import { createAnimationBakeSession, kernelBakeRevision, type KernelAnimationBakeSession } from './kernel/bake-session'
import { initialPrototype, prototypeEase, prototypeEvent, prototypeDocument, type Interaction } from './prototype'
import { animatePrototypeScroll } from './prototype-scroll'

export function PrototypePlayer({
  document: source,
  onClose,
}: {
  document: DesignDocument
  onClose: () => void
}) {
  const [state, setState] = useState(() => initialPrototype(source)),
    [error, setError] = useState('')
  const scroll = useRef<HTMLDivElement>(null),
    snapshot = useRef(source)
  // Preview deliberately owns an immutable design version and temporary values.
  const [progress, setProgress] = useState(1)
  const transition = state.transition
  useLayoutEffect(() => {
    if ((!transition && !state.transitionStyle?.startsWith('slide-')) || !state.transitionMs) { setProgress(1); return }
    setProgress(0)
    const start = performance.now()
    let request = 0
    const tick = (now: number) => {
      const t = Math.max(0, Math.min(1, (now-start)/state.transitionMs))
      setProgress(t)
      if (t < 1) request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [transition, state.transitionMs, state.transitionSerial, state.transitionStyle])
  const valuesKey = JSON.stringify([state.values, state.modeValues])
  const settled = useMemo(() => kernelLayout(prototypeDocument(snapshot.current, state)), [valuesKey])
  // One bake per (document, from, to) transition through the kernel's stateful
  // bake session (plan cache + in-flight mutex); per-frame ticks only sample.
  // The stateless per-frame sampler below stays as the fallback when the
  // kernel module or the binding is unavailable.
  const [bake, setBake] = useState<{ document: DesignDocument; transition: typeof transition; session: KernelAnimationBakeSession } | null>(null)
  // A render of the next transition must never sample the previous (possibly
  // already freed) WASM session before its effect installs the new owner.
  const bakeSession = bake?.document === settled && bake.transition === transition ? bake.session : null
  useEffect(() => {
    if (!transition || !state.transitionMs) { setBake(null); return }
    const session = createAnimationBakeSession()
    if (!session) { setBake(null); return }
    try {
      const json = JSON.stringify(settled)
      session.bake(json, json, transition.from, transition.to, kernelBakeRevision(settled))
    } catch (error) {
      session.free()
      setBake(null)
      setError(`原型动画准备失败：${String(error)}`)
      return
    }
    setBake({ document: settled, transition, session })
    // free() drops the session's guard, releasing the frame pair.
    return () => session.free()
  }, [settled, transition, state.transitionMs])
  const sampled = useMemo(() => {
    try {
      if (!transition || !state.transitionMs) return { document: settled, error: '' }
      // Time remains [0,1]; eased position may overshoot. The kernel clamps
      // opacity and dimensions independently, preserving spring movement.
      const eased = prototypeEase(state.transitionEasing, progress)
      return { document: progress < 1
        ? JSON.parse(bakeSession
          ? bakeSession.sample_json(eased)
          : animation_plan_sample_json(JSON.stringify(settled),transition.from,transition.to,eased)) as DesignDocument
        : settled, error: '' }
    }
    catch (error) { return { document: settled, error: `原型过渡失败：${String(error)}` } }
  }, [settled,transition,progress,bakeSession])
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
  const zoom = Math.min(1, 900 / Math.max(1, frame.width)),
    height = Math.min(720, frame.height * zoom)
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
    scroll.current?.scrollTo({ ...point, behavior: 'instant' })
  }, [state.navigation?.serial])
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
          left: (target.bounds.x - frame.x) * zoom,
          top: (target.bounds.y - frame.y) * zoom,
        },state.transitionMs,state.transitionEasing)
        const interrupt=()=>cancel()
        for(const event of ['wheel','touchstart','pointerdown'])element.addEventListener(event,interrupt,{passive:true})
        return ()=>{cancel();for(const event of ['wheel','touchstart','pointerdown'])element.removeEventListener(event,interrupt)}
      }
    }
  }, [state.scrollTarget, state.current, state.scrollRequest])
  // Hide unrelated roots/siblings while retaining definitions for component resolution.
  const visibleDoc = useMemo(() => prototypeFrameView(doc,current).document, [doc,current])
  return (
    <div className="feature-backdrop">
      <div className="prototype-player" data-transition-progress={progress} data-transition-ms={state.transitionMs} data-transition-easing={state.transitionEasing || 'linear'} data-transition-kind={transition ? 'smart' : state.transitionStyle?.startsWith('slide-') ? 'slide' : 'none'} data-animation-plan={transition ? (bakeSession ? "kernel-baked" : "kernel") : "none"} role="dialog" aria-label="交互原型预览">
        <header>
          <strong>原型 · {n.name}</strong>
          <button type="button" onClick={() => { setState(initialPrototype(snapshot.current)); setError(''); scroll.current?.scrollTo(0, 0) }}>
            重新开始
          </button>
          <button
            type="button"
            onClick={() =>
              dispatch(current, 'click', { trigger:'click', actions:[{kind:'back',durationMs:state.transitionMs}] })
            }
          >
            返回
          </button>
          <button type="button" onClick={onClose}>
            关闭预览
          </button>
        </header>
        {(error || sampled.error) && <p role="alert">{error || sampled.error}</p>}
        <div style={{ position: 'relative' }}>
          <div
            ref={scroll}
            data-testid="prototype-scroll"
            style={{
              overflow: 'auto',
              width: frame.width * zoom,
              height,
              position: 'relative',
              background: '#fff',
            }}
          >
            {previous?.entry && state.transitionStyle?.startsWith('slide-') && progress<1 && <div key={state.transitionFrom} aria-hidden="true" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
              <KernelSurface document={previous.document} pageId={previous.pageId} width={Math.ceil(frame.width*zoom)} height={Math.ceil(frame.height*zoom)} view={{x:-previous.entry.bounds.x*zoom,y:-previous.entry.bounds.y*zoom,zoom}} grid={false}/>
            </div>}
            <div
              key={current}
              style={{
                position: 'relative',
                width: frame.width * zoom,
                height: frame.height * zoom,
                transform: `translate(${slideOffset})`,
                background: '#fff',
              }}
            >
              <KernelSurface
                document={visibleDoc}
                pageId={page.id}
                width={Math.ceil(frame.width * zoom)}
                height={Math.ceil(frame.height * zoom)}
                view={{ x: -frame.x * zoom, y: -frame.y * zoom, zoom }}
                grid={false}
              />
              {entries
                .filter((e) => descendants.has(e.id) && doc.prototype?.interactions[e.id]?.length)
                .map((e) => {
                  const m = e.matrix
                  return (
                    <button
                      type="button"
                      key={e.id}
                      aria-label={doc.nodes[e.id].name || '交互区域'}
                      className="prototype-hotspot"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: doc.nodes[e.id].width,
                        height: doc.nodes[e.id].height,
                        transformOrigin: '0 0',
                        transform: `matrix(${m[0] * zoom},${m[1] * zoom},${m[2] * zoom},${m[3] * zoom},${(m[4] - frame.x) * zoom},${(m[5] - frame.y) * zoom})`,
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
              aria-label={doc.nodes[e.id].name || '弹层交互'}
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
