import type { DesignDocument, Matrix } from '../../model'
import { isolatedSrgbBoard } from '../page-translation'
import { DISPLAY_TEXTURE_BUDGET } from './display-budget'
import type { Driver, GpuScene, Rect } from './types'

type Point = { x: number; y: number }
type Anchor = { id: number; origin: Point; support: Rect; captured: Rect; bytes: number }
type Replay = { anchor: Anchor; from: Rect; to: Point }
type Device = Required<Pick<Driver, 'saveClippedBackground' | 'saveClippedRegion' | 'copyClippedPose' | 'releasePresented'>>

function contains(outer: Rect, inner: Rect) {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
}
function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
function insideViewport(r: Rect, width: number, height: number): Rect {
  const x = Math.max(0, r.x), y = Math.max(0, r.y)
  return { x, y, w: Math.min(width, r.x + r.w) - x, h: Math.min(height, r.y + r.h) - y }
}

/** Stores native page pixels for a single clipped translation session.
 * Keep a stationary backing and the actual covered rectangle of each pose.
 * The GPU copies texels only when the requested pose shares the device lattice. */
export class ClippedPhaseReplay {
  private anchors: Anchor[] = []
  private background?: number
  private bytes = 0
  private constructor(
    private readonly device: Device, readonly id: string,
    private readonly width: number, private readonly height: number,
    private readonly output: Rect, private readonly view: GpuScene['view'],
    private readonly stationary: readonly Rect[],
    private readonly viewport: { width: number; height: number; x: number; y: number; zoom: number; dpr: number },
  ) {}

  static create(device: Driver, scene: GpuScene, document: DesignDocument, pageId: string, id: string,
    viewport: ClippedPhaseReplay['viewport'], signal: AbortSignal) {
    const output = scene.output
    if (!device.saveClippedBackground || !device.saveClippedRegion || !device.copyClippedPose || !device.releasePresented ||
        device.hdr || device.displayMath || scene.colorManagement || scene.gestureSoftEffects || scene.linearRetainedCapture ||
        scene.transparent || scene.grid || scene.checkerboard || scene.resolve || scene.presentation || scene.softwareRaster ||
        !output || signal.aborted || !scene.roots.includes(id) ||
        !isolatedSrgbBoard(document, pageId, id) || !scene.nodes[id]) return
    const { x, y, zoom, dpr, width, height } = viewport
    if (output.w !== Math.ceil(width * dpr) || output.h !== Math.ceil(height * dpr) ||
        output.x !== scene.view.x - x * dpr || output.y !== scene.view.y - y * dpr ||
        zoom * dpr !== scene.view.zoom ||
        ![output.x,output.y,output.w,output.h].every(Number.isSafeInteger) ||
        output.w <= 0 || output.h <= 0) return
    const node = document.nodes[id]
    const box = (left: number, top: number, w: number, h: number) => {
      const px = left * scene.view.zoom + scene.view.x - output.x
      const py = top * scene.view.zoom + scene.view.y - output.y
      const bx = Math.floor(px) - 2, by = Math.floor(py) - 2
      return { x: bx, y: by, w: Math.ceil(px + w * scene.view.zoom) + 2 - bx,
        h: Math.ceil(py + h * scene.view.zoom) + 2 - by }
    }
    const stationary = document.pages.find(page => page.id === pageId)!.children
      .filter(key => key !== id && document.nodes[key]?.visible)
      .map(key => {
        const r = document.nodes[key]
        return box(r.transform[4], r.transform[5], r.width, r.height)
      })
    if ([node.width,node.height,...stationary.flatMap(r=>Object.values(r))]
        .some(v=>!Number.isSafeInteger(v) || Math.abs(v)>1_000_000)) return
    const result = new ClippedPhaseReplay(device as Device, id, node.width, node.height,
      { ...output }, { ...scene.view }, stationary, { ...viewport })
    signal.addEventListener('abort', () => result.clear(), { once: true })
    return result
  }

  sameViewport(frame: { view: GpuScene['view']; width: number; height: number; dpr: number } | undefined) {
    const v = this.viewport
    return !!frame && frame.width === v.width && frame.height === v.height && frame.dpr === v.dpr &&
      frame.view.x === v.x && frame.view.y === v.y && frame.view.zoom === v.zoom
  }

  private pose(transform: Matrix) {
    if (transform[0] !== 1 || transform[1] !== 0 || transform[2] !== 0 || transform[3] !== 1 ||
        ![transform[4], transform[5]].every(Number.isFinite)) return
    // Authored origins are fractional during a drag. Placement below accepts
    // only whole physical shifts, so a fractional origin still copies the
    // exact sample lattice; requiring an integer document transform excluded
    // every real pointer pose from the cache.
    const origin = { x: transform[4], y: transform[5] }
    const left = origin.x * this.view.zoom + this.view.x - this.output.x
    const top = origin.y * this.view.zoom + this.view.y - this.output.y
    if (Math.abs(left) > 1_000_000 || Math.abs(top) > 1_000_000) return
    const x = Math.floor(left) - 2, y = Math.floor(top) - 2
    const support = { x, y, w: Math.ceil(left + this.width * this.view.zoom) + 2 - x,
      h: Math.ceil(top + this.height * this.view.zoom) + 2 - y }
    const captured = insideViewport(support, this.output.w, this.output.h)
    if (captured.w <= 0 || captured.h <= 0 || this.stationary.some(r => overlaps(captured, r))) return
    return { origin, support, captured }
  }

  private placement(anchor: Pick<Anchor, 'origin' | 'support' | 'captured'>,
    target: Pick<Anchor, 'origin' | 'support' | 'captured'>) {
    const dx = (target.origin.x - anchor.origin.x) * this.view.zoom
    const dy = (target.origin.y - anchor.origin.y) * this.view.zoom
    if (!Number.isSafeInteger(dx) || !Number.isSafeInteger(dy) ||
        target.support.x !== anchor.support.x + dx || target.support.y !== anchor.support.y + dy ||
        target.support.w !== anchor.support.w || target.support.h !== anchor.support.h) return
    const read = { ...target.captured, x: target.captured.x - dx, y: target.captured.y - dy }
    if (!contains(anchor.captured, read)) return
    return { from: { ...read, x: read.x - anchor.captured.x, y: read.y - anchor.captured.y },
      to: { x: target.captured.x, y: target.captured.y } }
  }

  find(transform: Matrix): Replay | undefined {
    if (this.background === undefined) return
    const target = this.pose(transform)
    if (!target) return
    for (let i = this.anchors.length - 1; i >= 0; i--) {
      const anchor = this.anchors[i], placement = this.placement(anchor,target)
      if (placement) return { anchor, ...placement }
    }
  }

  /** When a phase needs new native pixels, put the board as far inside the
   * same capture as this lattice permits. Returning towards the viewport
   * edge can then reuse samples that a capture at the pointer would omit. */
  representative(transform: Matrix): Matrix | undefined {
    const target = this.pose(transform)
    if (!target || this.background === undefined) return
    const zoom = this.view.zoom
    const period = [1,2,3,4,5,6,7,8].find(value => Number.isSafeInteger(value * zoom))
    if (period === undefined) return
    const step = period * zoom
    const offset = (start: number, length: number, limit: number) => {
      const end = start + length
      if (start >= 0 && end <= limit) return 0
      if (length <= limit) return start < 0 ? Math.ceil(-start / step) : -Math.ceil((end - limit) / step)
      if (start >= step) return -Math.floor(start / step)
      if (end <= limit - step) return Math.floor((limit - end) / step)
      return 0
    }
    const x = offset(target.support.x,target.support.w,this.output.w)
    const y = offset(target.support.y,target.support.h,this.output.h)
    if (!x && !y) return
    const representative: Matrix = [1,0,0,1,transform[4] + x*period,transform[5] + y*period]
    const anchor = this.pose(representative)
    if (anchor && this.placement(anchor,target)) return representative
  }

  record(slot: number, transform: Matrix) {
    const pose = this.pose(transform)
    if (!pose || this.find(transform)) return
    if (this.background === undefined) {
      const { w,h } = this.output
      const sample = [[0,0],[w-1,0],[0,h-1],[w-1,h-1],[Math.floor(w/2),0],[0,Math.floor(h/2)]]
        .map(([x,y])=>({x,y,w:1,h:1}))
        .find(pixel=>!overlaps(pixel,pose.support)&&this.stationary.every(r=>!overlaps(pixel,r)))
      if (!sample) return
      this.background = this.device.saveClippedBackground(slot, pose.captured, sample)
      if (this.background === undefined) return
      this.bytes = w * h * 4
    }
    const bytes = pose.captured.w * pose.captured.h * 4
    while (this.anchors.length && (this.anchors.length >= 25 || this.bytes + bytes > DISPLAY_TEXTURE_BUDGET / 2)) {
      const oldest = this.anchors.shift()!
      this.bytes -= oldest.bytes
      this.device.releasePresented([oldest.id])
    }
    const id = this.device.saveClippedRegion(slot, pose.captured)
    if (id === undefined) return
    this.bytes += bytes
    this.anchors.push({ id, ...pose, bytes })
  }

  show(replay: Replay) {
    if (this.background === undefined || !this.anchors.includes(replay.anchor)) return
    const slot = this.device.copyClippedPose(this.background, replay.anchor.id, replay.from, replay.to)
    if (slot === undefined) return
    this.anchors.splice(this.anchors.indexOf(replay.anchor), 1)
    this.anchors.push(replay.anchor)
    return slot
  }

  private clear() {
    this.device.releasePresented([
      ...(this.background === undefined ? [] : [this.background]),
      ...this.anchors.map(frame=>frame.id),
    ])
    this.background = undefined
    this.anchors = []
    this.bytes = 0
  }
}
