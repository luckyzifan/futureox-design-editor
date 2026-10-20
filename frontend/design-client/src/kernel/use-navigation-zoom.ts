import { useLayoutEffect, useRef, useState } from 'react'
import type { CanvasCamera } from '../canvas-camera'
import { NavigationZoom, type NavigationZoomSample } from './navigation-zoom'

export function useNavigationZoom(view: CanvasCamera, identity: string, enabled: boolean) {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])
  enabled = enabled && visible
  const state = useRef(new NavigationZoom(view)), owner = useRef(identity)
  const [published, setPublished] = useState<NavigationZoomSample>(state.current.sample)
  useLayoutEffect(() => {
    if (owner.current !== identity || !enabled) {
      state.current = new NavigationZoom(view); owner.current = identity
    }
    const current = state.current
    const publish = (sample: NavigationZoomSample) => setPublished(old => old === sample ? old : sample)
    publish(current.update(view, performance.now()))
    let handle: number | undefined
    const tick = () => {
      publish(current.frame(performance.now()))
      if (current.active) handle = requestAnimationFrame(tick)
    }
    if (enabled && current.active) handle = requestAnimationFrame(tick)
    return () => { if (handle !== undefined) cancelAnimationFrame(handle) }
  }, [view.x, view.y, view.zoom, identity, enabled])
  const sameOwner = owner.current === identity
  // The input render must suppress exact work before its layout effect
  // publishes the first sampled preview of this gesture.
  return { suspended: !visible, pendingAgeMs: enabled ? state.current.pendingAge(performance.now()) : 0, active: enabled && sameOwner && (published.active || state.current.zoom !== view.zoom),
    sample: enabled && sameOwner && published.active ? published : undefined }
}
