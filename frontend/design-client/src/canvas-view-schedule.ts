import type { CanvasCamera } from './canvas-camera'
import type { Editor } from './engine'

/** Publish a parked zoom before a same-zoom pan is folded into that frame.
 *  Wheel input keeps one pending camera. A trackpad pan that arrives before
 *  the zoom frame commits used to replace that camera, so the surface saw
 *  only the final pose. The cold zoom-out pin then treated the whole jump as
 *  its base and the retained picture never slid with the pan. The caller
 *  flushes the zoom render before the pan is committed. A zoom-only burst
 *  and a pan that is already at the committed zoom stay on the coalesced path. */
export function scheduleCanvasView(
  editor: Pick<Editor, 'effectiveView' | 'state' | 'cameraCommitPending' | 'flushPendingView' | 'setViewCoalesced'>,
  next: CanvasCamera,
  flush: (run: () => void) => void,
  leadingPan = true,
) {
  const parked = editor.effectiveView()
  const committed = editor.state.view
  const finite = [next.x, next.y, next.zoom, parked.x, parked.y, parked.zoom, committed.x, committed.y, committed.zoom].every(Number.isFinite)
  const sameZoomPan = next.zoom === parked.zoom && (next.x !== parked.x || next.y !== parked.y)
  if (finite && editor.cameraCommitPending() && sameZoomPan && parked.zoom !== committed.zoom) {
    // Two flushes: the zoom render has to install the pin before the pan
    // render slides it. One combined snapshot would keep the old picture fixed.
    flush(() => { editor.flushPendingView() })
    flush(() => { editor.setViewCoalesced(next, leadingPan && next.zoom === editor.effectiveView().zoom) })
    return
  }
  editor.setViewCoalesced(next, leadingPan && next.zoom === editor.effectiveView().zoom)
}
