import type { Bounds } from '../model'
import type { CanvasCamera } from '../canvas-camera'

type Viewport = { view: CanvasCamera; width: number; height: number; dpr: number }
type Frame = { revision: number; bounds: Bounds; keys: ReadonlySet<string>; bytes: number; native?: Viewport }
const sameViewport = (a: Viewport | undefined, view: CanvasCamera, width: number, height: number, dpr: number) =>
  a?.width === width && a.height === height && a.dpr === dpr &&
  a.view.x === view.x && a.view.y === view.y && a.view.zoom === view.zoom

/** Keep the widest completed view as a bounded coverage layer. Ordinary LRU
 * favours recently magnified tiles, which can evict every pixel needed by the
 * next zoom-out. Reserve at most one third of the existing display budget;
 * the incoming and displayed detail frames keep the remaining allowance. */
export class CoverageRetention {
  private frame?: Frame
  private recentNative: Frame[] = []

  retain(next: Frame, budget: number) {
    this.trim(next.revision, budget)
    if (!next.keys.size || next.bytes > budget / 3) return
    const previous = this.frame
    const wider = !previous || previous.bounds.width * previous.bounds.height < next.bounds.width * next.bounds.height
    if (!wider && !next.native) return
    const stored = { ...next, keys: new Set(next.keys) }
    if (wider) this.frame = stored
    if (next.native) {
      const { view, width, height, dpr } = next.native
      // Remember recently acknowledged cameras for a return if their tiles
      // survive the ordinary LRU. Only the widest frame pins cache entries.
      this.recentNative = [stored, ...this.recentNative.filter(old => !sameViewport(old.native, view, width, height, dpr))].slice(0, 2)
    }
  }

  trim(revision: number, budget: number) {
    if (this.frame && (this.frame.revision !== revision || this.frame.bytes > budget / 3)) this.frame = undefined
    this.recentNative = this.recentNative.filter(frame => frame.revision === revision && frame.bytes <= budget / 3)
  }

  has(key: string) { return this.frame?.keys.has(key) === true }
  nativeKeys(revision: number, view: CanvasCamera, width: number, height: number, dpr: number) {
    return [...this.recentNative, this.frame].find(frame => frame?.revision === revision &&
      sameViewport(frame.native, view, width, height, dpr))?.keys
  }
  clear() { this.frame = undefined; this.recentNative = [] }
}
