import type { Bounds } from '../model'
import type { CanvasCamera } from '../canvas-camera'

type Viewport = { view: CanvasCamera; width: number; height: number; dpr: number }
type Frame = { revision: number; bounds: Bounds; keys: ReadonlySet<string>; bytes: number; native?: Viewport }

/** Keep the widest completed view as a bounded coverage layer. Ordinary LRU
 * favours recently magnified tiles, which can evict every pixel needed by the
 * next zoom-out. Reserve at most one third of the existing display budget;
 * the incoming and displayed detail frames keep the remaining allowance. */
export class CoverageRetention {
  private frame?: Frame

  retain(next: Frame, budget: number) {
    this.trim(next.revision, budget)
    if (!next.keys.size || next.bytes > budget / 3) return
    const previous = this.frame
    if (previous && previous.bounds.width * previous.bounds.height >= next.bounds.width * next.bounds.height) return
    this.frame = { ...next, keys: new Set(next.keys) }
  }

  trim(revision: number, budget: number) {
    if (this.frame && (this.frame.revision !== revision || this.frame.bytes > budget / 3)) this.frame = undefined
  }

  has(key: string) { return this.frame?.keys.has(key) === true }
  nativeKeys(revision: number, view: CanvasCamera, width: number, height: number, dpr: number) {
    const frame = this.frame, native = frame?.native
    if (frame?.revision === revision && native?.width === width && native.height === height &&
        native.dpr === dpr && native.view.x === view.x && native.view.y === view.y && native.view.zoom === view.zoom)
      return frame.keys
  }
  clear() { this.frame = undefined }
}
