import { useLayoutEffect, useRef, useState } from 'react'
import type { CanvasCamera } from '../canvas-camera'
import { NavigationZoom, type NavigationZoomSample } from './navigation-zoom'

export function useNavigationZoom(view: CanvasCamera, identity: string, enabled: boolean,
  includeTranslation = false, pointerHeld = false) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  enabled = enabled && visible
  const state = useRef(new NavigationZoom(view, { includeTranslation })), owner = useRef(identity),
    translationOwner = useRef(includeTranslation)
  const [published, setPublished] = useState<NavigationZoomSample>(state.current.sample)
  useLayoutEffect(() => {
    if (owner.current !== identity || translationOwner.current !== includeTranslation || !enabled) {
      state.current = new NavigationZoom(view, { includeTranslation }); owner.current = identity
      translationOwner.current = includeTranslation
    }
    const current = state.current
    const publish = (sample: NavigationZoomSample) => setPublished(old => old === sample ? old : sample)
    publish(current.update(view, performance.now(), pointerHeld))
    let handle: number | undefined
    const tick = () => {
      publish(current.frame(performance.now()))
      if (current.active) handle = requestAnimationFrame(tick)
    }
    if (enabled && current.active) handle = requestAnimationFrame(tick)
    return () => { if (handle !== undefined) cancelAnimationFrame(handle) }
  }, [view.x, view.y, view.zoom, identity, enabled, includeTranslation, pointerHeld])
  const sameOwner = owner.current === identity && translationOwner.current === includeTranslation
  // The input render must suppress exact work before its layout effect
  // publishes the first sampled preview of this gesture.
  const released = includeTranslation && state.current.pointerHeld && !pointerHeld
  const active = enabled && sameOwner && !released &&
    (published.active || state.current.inputChanged(view) || includeTranslation && pointerHeld)
  return { suspended: !visible, pendingAgeMs: enabled ? state.current.pendingAge(performance.now()) : 0, active,
    panEnabled: enabled && includeTranslation,
    sample: active && published.active ? published : undefined }
}
