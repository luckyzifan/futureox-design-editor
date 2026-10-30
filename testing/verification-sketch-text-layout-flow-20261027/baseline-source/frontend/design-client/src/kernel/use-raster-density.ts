import { useLayoutEffect, useRef, useState } from 'react'
import { InteractionDensity } from './interaction-density'

/** Density, not camera translation, owns the two-frame Figma debounce.
 * Keep the last rendered pixels reprojected while a new density is pending.
 * A new document/backend starts immediately and never inherits queued work. */
export function useRasterDensity(density: number, identity: string): number {
  const queue = useRef(new InteractionDensity(density))
  const owner = useRef(identity)
  const [published, setPublished] = useState(density)
  useLayoutEffect(() => {
    if (owner.current !== identity) {
      queue.current = new InteractionDensity(density); owner.current = identity
      setPublished(density)
    }
    const state = queue.current
    if (state.queue(density, performance.now())) setPublished(state.value)
    let frame: number | undefined
    const tick = () => {
      if (state.frame(performance.now())) setPublished(state.value)
      if (state.pending) frame = requestAnimationFrame(tick)
    }
    if (state.pending) frame = requestAnimationFrame(tick)
    return () => { if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [density, identity])
  // The same render that sees a large jump can already plan the new density.
  // The layout effect publishes it for subsequent frames and clears the queue.
  return owner.current !== identity || density > published * 1.5 || density < published * .5 ? density : published
}
