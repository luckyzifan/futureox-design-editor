import { useLayoutEffect, useRef, useState } from 'react'

export const SHARP_ZOOM_QUIET_MS = 100

/** Keep the native-density zoom bucket stable across ordinary wheel gaps.
 * The first changed render is active immediately: this timer never delays
 * raster work and never selects a reduced-resolution preview. Only the final
 * exact phase waits for a complete quiet interval, measured monotonically. */
export function useSharpZoomActivity(zoom: number, identity: string): boolean {
  const current = useRef({ identity, zoom, changedAt: -Infinity, active: false })
  const [published, setPublished] = useState({ identity, active: false })
  useLayoutEffect(() => {
    if (current.current.identity !== identity) {
      current.current = { identity, zoom, changedAt: -Infinity, active: false }
      setPublished({ identity, active: false })
      return
    }
    const state = current.current
    if (!Object.is(state.zoom, zoom)) {
      state.zoom = zoom; state.changedAt = performance.now(); state.active = true
      setPublished({ identity, active: true })
    }
    if (!state.active) return
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    const settle = () => {
      if (!live || current.current !== state) return
      const remaining = SHARP_ZOOM_QUIET_MS - (performance.now() - state.changedAt)
      if (remaining > 0) { timer = setTimeout(settle, remaining); return }
      state.active = false
      setPublished({ identity, active: false })
    }
    timer = setTimeout(settle, Math.max(0, SHARP_ZOOM_QUIET_MS - (performance.now() - state.changedAt)))
    return () => { live = false; if (timer !== undefined) clearTimeout(timer) }
  }, [zoom, identity])
  // Read the previous committed input before the effect publishes this one.
  // Returning to an older zoom during a burst remains active until its own
  // quiet interval; changing document/backend ownership starts a fresh state.
  return current.current.identity === identity &&
    (!Object.is(current.current.zoom, zoom) || published.identity === identity && published.active)
}
