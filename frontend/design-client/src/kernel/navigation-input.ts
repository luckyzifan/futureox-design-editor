import { wheelDeltaPixels, type CanvasCamera, type CanvasSize } from '../canvas-camera'
import type { NavigationJournal } from './navigation-journal'

type Wheel = { deltaX: number; deltaY: number; deltaMode: number }
type Sink = { enabled(): boolean; record(event: Wheel, size: CanvasSize, view: CanvasCamera, pinch: boolean): void }
const sinks = new WeakMap<object, Set<Sink>>()
/** Canvas identity scopes input to its renderer; never retain DOM events. */
export function bindNavigationInput(owner: object, sink: Sink) {
  let group = sinks.get(owner)
  if (!group) sinks.set(owner, group = new Set())
  group.add(sink)
  return () => { group.delete(sink); if (!group.size) sinks.delete(owner) }
}
export function recordNavigationInput(owner: object, event: Wheel, size: CanvasSize, view: CanvasCamera, pinch: boolean) {
  for (const sink of sinks.get(owner) || []) {
    // Optional diagnostics must never reject an otherwise accepted gesture.
    try { if (sink.enabled()) sink.record(event, size, view, pinch) } catch { /* Diagnostic sink unavailable. */ }
  }
}
/** Accepted-handler CPU observation, not device timestamp or input-to-photon.
 * One latest scalar camera only; the journal and terminal bound their output. */
export class NavigationInputTrace implements Sink {
  private sequence = 0
  private latest: { view: CanvasCamera; inputSequence: number; inputAt: number; inputTimeOrigin: number; generation: number } | undefined
  constructor(private journal: NavigationJournal,
    private terminal: { enabled: boolean; record(event: string, values: Record<string, number>): void },
    private now = () => performance.now(), private origin = () => performance.timeOrigin) {}
  enabled() { return this.journal.recording || this.terminal.enabled }
  reset() { this.latest = undefined }
  record(event: Wheel, size: CanvasSize, view: CanvasCamera, pinch: boolean) {
    if (!this.enabled()) return
    const delta = wheelDeltaPixels({ deltaX: event.deltaX, deltaY: event.deltaY, deltaMode: event.deltaMode, shiftKey: false }, size)
    const values = { inputSequence: ++this.sequence, inputAt: this.now(), inputTimeOrigin: this.origin(),
      inputKind: pinch ? 2 : 1, deltaMode: event.deltaMode, deltaX: delta.x, deltaY: delta.y,
      x: view.x, y: view.y, zoom: view.zoom }
    this.latest = { view, inputSequence: values.inputSequence, inputAt: values.inputAt,
      inputTimeOrigin: values.inputTimeOrigin, generation: this.journal.generation }
    this.journal.record(1, values)
    this.terminal.record('camera-input', values)
  }
  // Identity proves this is the accepted camera, not an equal-valued camera
  // restored on another page or a different programmatic navigation.
  correlation(view: CanvasCamera): Record<string, number> {
    const last = this.latest
    if (!this.enabled() || !last || (this.journal.recording && last.generation !== this.journal.generation) ||
      last.view !== view) return {}
    return { inputSequence: last.inputSequence, inputAt: last.inputAt, inputTimeOrigin: last.inputTimeOrigin,
      inputAgeMs: Math.max(0, this.now() - last.inputAt) }
  }
}
