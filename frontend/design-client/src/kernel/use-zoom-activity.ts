import { useLayoutEffect, useRef, useState } from 'react'
import { FrameDebouncedValue } from './frame-debounced-value'
import type { CanvasCamera } from '../canvas-camera'

/** Figma's two stable frame rule chooses when to leave the transient display
 * tier. Unlike density admission, this signal does not periodically settle
 * during a still-changing gesture. */
function useActivity(value: number | string, identity: string) {
  const state = useRef(new FrameDebouncedValue<number | string>(2)),
    owner = useRef(identity)
  const [settled, setSettled] = useState({ value, identity })
  useLayoutEffect(() => {
    if (owner.current !== identity) {
      state.current.clear()
      owner.current = identity
    }
    if (state.current.queue(value)) setSettled({ value, identity })
    let frame: number | undefined
    const tick = () => {
      if (state.current.onFrame()) setSettled({ value: state.current.value!, identity })
      if (state.current.pending) frame = requestAnimationFrame(tick)
    }
    if (state.current.pending) frame = requestAnimationFrame(tick)
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [value, identity])
  return settled.identity === identity && settled.value !== value
}
export const useZoomActivity = (zoom: number, identity: string) => useActivity(zoom, identity)
export const useCameraActivity = (view: CanvasCamera, identity: string) =>
  useActivity(`${view.x}/${view.y}/${view.zoom}`, identity)
