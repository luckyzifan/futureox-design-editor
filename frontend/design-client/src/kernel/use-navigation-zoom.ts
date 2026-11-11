import { useLayoutEffect, useRef, useState } from 'react'
import type { CanvasCamera } from '../canvas-camera'
import { NavigationZoom, type NavigationZoomOptions, type NavigationZoomSample } from './navigation-zoom'

export function useNavigationZoom(view: CanvasCamera, identity: string, enabled: boolean,
  includeTranslation = false, pointerHeld = false, sampleOnFrame = false, adaptiveQuiet: NavigationZoomOptions['adaptiveQuiet'] = false) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  enabled = enabled && visible
  const state = useRef(new NavigationZoom(view, { includeTranslation, sampleOnFrame, adaptiveQuiet })), owner = useRef(identity),
    translationOwner = useRef(includeTranslation), schedulingOwner = useRef(sampleOnFrame), quietOwner = useRef(adaptiveQuiet)
  const [published, setPublished] = useState<NavigationZoomSample>(state.current.sample)
  useLayoutEffect(() => {
    if (owner.current !== identity || translationOwner.current !== includeTranslation ||
        schedulingOwner.current !== sampleOnFrame || quietOwner.current !== adaptiveQuiet || !enabled) {
      state.current = new NavigationZoom(view, { includeTranslation, sampleOnFrame, adaptiveQuiet }); owner.current = identity
      translationOwner.current = includeTranslation; schedulingOwner.current = sampleOnFrame; quietOwner.current = adaptiveQuiet
    }
    const current = state.current
    let live = true
    const owns = () => live && state.current === current && owner.current === identity &&
      translationOwner.current === includeTranslation && schedulingOwner.current === sampleOnFrame && quietOwner.current === adaptiveQuiet
    const publish = (sample: NavigationZoomSample) => {
      if (owns()) setPublished(old => old === sample ? old : sample)
    }
    publish(current.update(view, performance.now(), pointerHeld))
    let handle: number | undefined
    const tick = () => {
      if (!owns()) return
      publish(current.frame(performance.now()))
      if (current.active) handle = requestAnimationFrame(tick)
    }
    if (enabled && current.active) handle = requestAnimationFrame(tick)
    return () => { live = false; if (handle !== undefined) cancelAnimationFrame(handle) }
  }, [view.x, view.y, view.zoom, identity, enabled, includeTranslation, pointerHeld, sampleOnFrame, adaptiveQuiet])
  const sameOwner = owner.current === identity && translationOwner.current === includeTranslation &&
    schedulingOwner.current === sampleOnFrame && quietOwner.current === adaptiveQuiet
  // The input render must suppress exact work before its layout effect
  // publishes the first sampled preview of this gesture.
  const released = includeTranslation && state.current.pointerHeld && !pointerHeld
  const active = enabled && sameOwner && !released &&
    (published.active || state.current.inputChanged(view) || includeTranslation && pointerHeld)
  return { suspended: !visible, pendingAgeMs: enabled ? state.current.pendingAge(performance.now()) : 0, active,
    panEnabled: enabled && includeTranslation,
    sample: active && published.active ? published : undefined }
}
