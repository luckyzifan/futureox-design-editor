import { tilesCoverBounds, type RasterTile } from './tile-cache'
import { previewCameraScaleWithinLimit } from './tile-preview'
import type { CanvasCamera } from '../canvas-camera'
import type { ResidentAcknowledgement } from './resident-presentation'

/** The worker reserves this optional browser bitmap in the display ledger. */
export const NAVIGATION_BACKING_BYTES = 1024 * 1024
export const MAX_NAVIGATION_GAPS = 64
export type ScreenRect = { x: number; y: number; width: number; height: number }
export type CameraWindow = { view: CanvasCamera; width: number; height: number }

function project(frame: CameraWindow, target: CameraWindow): ScreenRect {
  const scale = target.view.zoom / frame.view.zoom
  return { x: target.view.x - frame.view.x * scale, y: target.view.y - frame.view.y * scale,
    width: frame.width * scale, height: frame.height * scale }
}

function screenBounds(area: ScreenRect, view: CanvasCamera): ScreenRect {
  return { x: area.x*view.zoom + view.x, y: area.y*view.zoom + view.y,
    width: area.width*view.zoom, height: area.height*view.zoom }
}

function intersect(a: ScreenRect, b: ScreenRect): ScreenRect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const width = Math.min(a.x + a.width, b.x + b.width) - x
  const height = Math.min(a.y + a.height, b.y + b.height) - y
  if (width > 1e-6 && height > 1e-6) return { x, y, width, height }
}

function contains(a: ScreenRect, b: ScreenRect) {
  return a.x <= b.x + 1e-6 && a.y <= b.y + 1e-6 &&
    a.x + a.width >= b.x + b.width - 1e-6 && a.y + a.height >= b.y + b.height - 1e-6
}

function screen(target: CameraWindow): ScreenRect {
  return { x: 0, y: 0, width: target.width, height: target.height }
}

/** Uncovered parts of the target, including physical scissors the GPU actually
 * filled with the navigation background. Authored white is never inferred. */
function missing(frame: ResidentAcknowledgement, target: CameraWindow): ScreenRect[] | undefined {
  const viewport = screen(target), rect = project(frame, target), inside = intersect(viewport, rect)
  if (!inside) return [viewport]
  const right = inside.x + inside.width, bottom = inside.y + inside.height
  const gaps = [
    { x: 0, y: 0, width: inside.x, height: target.height },
    { x: right, y: 0, width: target.width - right, height: target.height },
    { x: inside.x, y: 0, width: inside.width, height: inside.y },
    { x: inside.x, y: bottom, width: inside.width, height: target.height - bottom },
  ].filter(gap => gap.width > 0 && gap.height > 0)
  if (frame.preview) {
    if (!frame.previewGaps || frame.previewGaps.length > MAX_NAVIGATION_GAPS) return
    const scale = target.view.zoom / (frame.view.zoom * frame.dpr)
    for (const gap of frame.previewGaps) {
      const area = intersect(inside, { x: rect.x + gap.x * scale, y: rect.y + gap.y * scale,
        width: gap.width * scale, height: gap.height * scale })
      if (area) gaps.push(area)
    }
  }
  return gaps
}

function missingOnPage(frame: ResidentAcknowledgement, target: CameraWindow, bounds: ScreenRect) {
  const page = screenBounds(bounds,target.view)
  return missing(frame,target)?.flatMap(hole => intersect(hole,page) ?? [])
}

export function keepCompleteCameraBacking(backing: ResidentAcknowledgement | undefined, next: ResidentAcknowledgement,
  allowed: boolean, zooming = false, target?: CameraWindow, history?: CameraWindow) {
  if (!allowed || !backing || backing.preview || backing.interaction || next.interaction) return false
  // A fit or zoom-out past 2× still owns the last complete picture. A preview
  // or a frame with gaps is not the closer replacement, so it must not punch
  // rectangles through that picture. A gap-free frame may replace it only when
  // that frame covers the live viewport. A narrow crop from another camera
  // must not become the picture, and an older crop must not cover a wider one.
  if (!previewCameraScaleWithinLimit(backing.view.zoom, next.view.zoom)) {
    if (next.preview || (next.previewGaps?.length ?? 0) > 0) return true
    if (!target) return false
    return !contains(project(next, target), screen(target))
  }
  if (!target) return !!next.preview || zooming && next.view.zoom > backing.view.zoom
  const old = intersect(screen(target), project(backing, target))
  if (!old) return false
  const fallback = history && project(history, target)
  if (next.preview) {
    const holes = missing(next, target)
    if (!holes) return true
    // Keep good pixels until every lost part can be supplied by the wider
    // backing. Newly rendered strips outside the old frame may publish now.
    return holes.some(hole => {
      const loss = intersect(old, hole)
      return !!loss && !(fallback && contains(fallback, loss))
    })
  }
  const live = screen(target)
  const nextCovers = contains(project(next, target), live)
  const oldCovers = contains(old, live)
  // A late coarser bitmap must not snap back over a picture that still covers
  // this camera. Continuous zoom stays inside the 2× window, so the old
  // "any higher zoom is a narrow crop" rule also dropped covering sharper
  // frames and left the previous bitmap stretched for the whole gesture.
  if (next.view.zoom < backing.view.zoom && oldCovers) return true
  if (fallback && contains(fallback, old)) return false
  return !nextCovers && (zooming && next.view.zoom > backing.view.zoom || oldCovers)
}

/** One small, wider image of this content revision. Only show it through
 * measured holes, never through intentionally transparent document pixels. */
export class NavigationBacking {
  private surface?: HTMLCanvasElement
  private clip?: HTMLDivElement
  private scope?: object
  private boundsKey = ''
  private generation = 0
  private lastClip = ''
  private atlas?: {bounds: ScreenRect; covered: Map<number, ScreenRect>; complete: boolean}
  private tried = new Set<number>()
  private copying = false
  private granted = false
  private lastCapture = ''
  private mappedFrame = 0
  get completeFrame() { return !this.atlas || this.atlas.complete ? this.frame : undefined }
  frame?: CameraWindow

  constructor(private host: HTMLElement) {}

  bind(scope?: object) {
    if (this.scope === scope) return
    this.scope = scope
    this.granted = false
    this.boundsKey = ''
    this.generation++
    this.frame = undefined
    this.atlas = undefined
    this.tried.clear()
    this.lastCapture = ''
    this.hide()
    if (this.surface) { this.surface.width = 0; this.surface.height = 0 }
  }

  private useBounds(bounds: ScreenRect) {
    const key = [bounds.x,bounds.y,bounds.width,bounds.height].join('/')
    if (this.boundsKey && this.boundsKey !== key) {
      this.generation++
      this.frame = undefined
      this.atlas = undefined
      this.tried.clear()
      this.lastCapture = ''
      this.hide()
    }
    this.boundsKey = key
  }

  private prepareSurface(w: number, h: number) {
    if (!this.clip) {
      this.clip = document.createElement('div')
      this.clip.dataset.cameraHistory = 'true'
      this.clip.setAttribute('aria-hidden', 'true')
      this.clip.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;display:none'
      this.surface = document.createElement('canvas')
      this.surface.setAttribute('aria-hidden', 'true')
      this.surface.style.cssText = 'position:absolute;transform-origin:0 0;image-rendering:auto'
      this.clip.append(this.surface)
      this.host.append(this.clip)
    }
    const canvas = this.surface!
    if (canvas.width !== w || canvas.height !== h) { canvas.width = 1; canvas.height = h; canvas.width = w }
    return canvas.getContext('2d')
  }

  capture(source: HTMLCanvasElement, frame: ResidentAcknowledgement, page?: ScreenRect) {
    if (this.granted && frame.navigationBackingBytes !== NAVIGATION_BACKING_BYTES) {
      const scope=this.scope
      this.bind(undefined)
      this.bind(scope)
    }
    this.granted = frame.navigationBackingBytes === NAVIGATION_BACKING_BYTES
    if (!this.granted || !this.scope || frame.gpuOverlay || frame.preview || frame.interaction ||
        !source.width || !source.height) return
    if (page) {
      this.useBounds(page)
      const region = {x:-frame.view.x/frame.view.zoom,y:-frame.view.y/frame.view.zoom,
        width:frame.width/frame.view.zoom,height:frame.height/frame.view.zoom}
      const key = JSON.stringify(region)
      if (this.lastCapture === key) return
      if (this.paintRegion(source,page,region,0,-1-this.mappedFrame%16)) {
        this.lastCapture=key
        this.mappedFrame++
      }
      return
    }
    if (this.atlas) return
    if (this.frame) {
      const old = project(this.frame, frame), next = screen(frame)
      // Keep the widest known camera through both directions of a wheel burst.
      if (intersect(old, next) && (!contains(next, old) || contains(old, next))) return
    }
    const ratio = Math.min(1, 1024 / Math.max(source.width, source.height),
      Math.sqrt(NAVIGATION_BACKING_BYTES / (4 * source.width * source.height)))
    const w = Math.max(1, Math.floor(source.width * ratio)), h = Math.max(1, Math.floor(source.height * ratio))
    const ctx = this.prepareSurface(w, h)
    if (!ctx) return
    ctx.globalCompositeOperation = 'copy'
    ctx.drawImage(source, 0, 0, w, h)
    this.frame = { view: { ...frame.view }, width: frame.width, height: frame.height }
    this.lastClip = ''
  }

  private paintRegion(source: ImageBitmap | HTMLCanvasElement, bounds: ScreenRect, region: ScreenRect, gutter: number, id: number) {
    if (!intersect(region,bounds) || bounds.width <= 0 || bounds.height <= 0) return false
    const scale = Math.min(1024 / Math.max(bounds.width,bounds.height),
      Math.sqrt(NAVIGATION_BACKING_BYTES/(4*bounds.width*bounds.height)))
    const width = Math.max(1,Math.floor(bounds.width*scale)), height = Math.max(1,Math.floor(bounds.height*scale))
    const ctx = this.prepareSurface(width,height)
    if (!ctx) return false
    if (!this.atlas) {
      ctx.clearRect(0,0,width,height)
      this.atlas = {bounds,covered:new Map(),complete:false}
      this.frame = {view:{x:-bounds.x,y:-bounds.y,zoom:1},width:bounds.width,height:bounds.height}
    }
    const sx=width/bounds.width, sy=height/bounds.height
    const left=Math.round((region.x-bounds.x)*sx), top=Math.round((region.y-bounds.y)*sy)
    const w=Math.round((region.x+region.width-bounds.x)*sx)-left, h=Math.round((region.y+region.height-bounds.y)*sy)-top
    if (w <= 0 || h <= 0) return false
    ctx.globalCompositeOperation='source-over'
    ctx.clearRect(left,top,w,h)
    ctx.drawImage(source,gutter,gutter,source.width-2*gutter,source.height-2*gutter,left,top,w,h)
    this.atlas.covered.set(id,region)
    if (contains(region,bounds)) this.atlas.complete = true
    this.lastClip=''
    return true
  }

  /** Only the immutable source capability can seed this atlas. Draw behind
   * acquired viewport pixels and keep the existing one-MiB grant. */
  seed(scope: object, bounds: ScreenRect, bitmap: ImageBitmap | HTMLCanvasElement, scale: number, frame?: ResidentAcknowledgement) {
    if (this.scope !== scope) return false
    if (frame) this.granted = frame.navigationBackingBytes === NAVIGATION_BACKING_BYTES
    if (!this.granted || !Number.isFinite(scale) || scale <= 0 ||
        bitmap.width !== Math.min(256,Math.ceil(bounds.width*scale)) || bitmap.height !== Math.min(256,Math.ceil(bounds.height*scale)) ||
        bitmap.width > 256 || bitmap.height > 256) return false
    this.useBounds(bounds)
    const ratio = Math.min(1024 / Math.max(bounds.width,bounds.height),
      Math.sqrt(NAVIGATION_BACKING_BYTES/(4*bounds.width*bounds.height)))
    const width = Math.max(1,Math.floor(bounds.width*ratio)),height = Math.max(1,Math.floor(bounds.height*ratio))
    const ctx = this.prepareSurface(width,height)
    if (!ctx) return false
    ctx.save()
    try {
      // An equally sized canvas may still contain the preceding revision.
      if (!this.atlas) ctx.clearRect(0,0,width,height)
      ctx.globalCompositeOperation='destination-over'
      ctx.drawImage(bitmap,0,0,bounds.width*scale,bounds.height*scale,0,0,width,height)
    } finally { ctx.restore() }
    this.atlas ??= {bounds,covered:new Map(),complete:true}
    this.atlas.complete = true
    this.atlas.covered.set(0,bounds)
    this.frame={view:{x:-bounds.x,y:-bounds.y,zoom:1},width:bounds.width,height:bounds.height}
    this.lastClip=''
    return true
  }

  /** Copy already-rasterized page tiles while the display worker is available.
   * Their own raster origins, phases and gutters position the content. The
   * atlas extent sets the scale only; unpopulated sections never cover a gap. */
  warm(bounds: ScreenRect | undefined, tiles: readonly (RasterTile & {gpuTile?:number})[],
    copy: (id: number, consume: (bitmap: ImageBitmap) => void) => Promise<void>, refresh: () => void) {
    if (!this.granted || !this.scope || !bounds || bounds.width <= 0 || bounds.height <= 0 ||
        ![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)) return
    this.useBounds(bounds)
    if (this.copying) return
    const generation = this.generation
    if (this.tried.size >= 64) {
      const resident = new Set(tiles.map(tile=>tile.gpuTile))
      for (const id of this.tried) if (!resident.has(id)) {
        this.tried.delete(id)
        this.atlas?.covered.delete(id)
      }
    }
    const candidates = tiles.filter(t => t.gpuTile && !this.tried.has(t.gpuTile) && t.width <= 514 && t.height <= 514 &&
      t.zoom > 0 && Math.max(bounds.width,bounds.height)*t.zoom <= 4096)
    if (!candidates.length || this.tried.size >= 64) return
    const tile = candidates[0], id = tile.gpuTile!, scope = this.scope
    const gutter = tile.gutter ?? 1
    const region = { x:(tile.x + gutter - (tile.phaseX ?? 0)) / tile.zoom,
      y:(tile.y + gutter - (tile.phaseY ?? 0)) / tile.zoom,
      width:(tile.width-2*gutter)/tile.zoom, height:(tile.height-2*gutter)/tile.zoom }
    this.tried.add(id)
    this.copying = true
    let copied = false
    void copy(id, bitmap => {
      if (this.scope !== scope || this.generation !== generation || bitmap.width !== tile.width || bitmap.height !== tile.height || !intersect(region,bounds)) return
      copied = this.paintRegion(bitmap,bounds,region,gutter,id)
    }).catch(() => {
      // A busy worker or a declined reservation can be retried on the next
      // presentation. Do not start another copy in the failing callback.
      if (this.generation === generation) this.tried.delete(id)
    }).finally(() => {
      this.copying=false
      if (this.scope && (copied || this.generation!==generation)) refresh()
    })
  }

  private coverage(target: CameraWindow): ScreenRect[] {
    if (!this.frame) return []
    if (!this.atlas || this.atlas.complete) return [project(this.frame,target)]
    return Array.from(this.atlas.covered.values(), area => screenBounds(area,target.view))
  }

  /** A shrinking viewport crop may reveal real artwork. Only a matching page
   * preview or actual submitted pixels can supply those parts of the page. */
  coversPage(backing: ResidentAcknowledgement, target: CameraWindow, bounds: ScreenRect) {
    const required = missingOnPage(backing,target,bounds)
    if (!required) return false
    if (!required.length) return true
    const coverage = this.coverage(target)
    if (!coverage.length) return false
    if (coverage.length === 1) return required.every(rect => contains(coverage[0],rect))
    const tiles = coverage.map((rect,index) => ({...rect,key:String(index),zoom:1,gutter:0}))
    return required.every(rect => tilesCoverBounds(tiles,rect))
  }

  canProject(backing: ResidentAcknowledgement, target: CameraWindow, bounds: ScreenRect) {
    const required = missingOnPage(backing,target,bounds)
    if (!required) return false
    // The unchanged crop alone is not a wider backing. Allow motion as soon
    // as cached world pixels can actually appear in a newly exposed area.
    return !required.length || this.coverage(target).some(region=>required.some(hole=>intersect(region,hole)))
  }

  canAdvance(previous: ResidentAcknowledgement, next: ResidentAcknowledgement, target: CameraWindow, bounds: ScreenRect) {
    if (this.coversPage(next,target,bounds)) return true
    if (!this.canProject(previous,target,bounds)) return false
    const page = intersect(screen(target),screenBounds(bounds,target.view))
    const holes = missingOnPage(next,target,bounds)
    // The GPU and browser can supply different parts of a sparse page. Keep
    // the last frame if the candidate supplies no actual page pixels at all.
    return !!page && !!holes && holes.reduce((sum,r)=>sum+r.width*r.height,0) < page.width*page.height
  }

  show(backing: ResidentAcknowledgement, target: CameraWindow) {
    if (!this.frame || !this.clip || !this.surface) return
    const rect = project(this.frame, target)
    // A far atlas is blurry, not a reason to leave the hole blank. Camera
    // reprojection hides this layer once a closer covering image exists.
    const holes = missing(backing, target)
    const covered = this.coverage(target)
    const repairs = holes?.flatMap(hole => covered.flatMap(region => intersect(region,hole) ?? []))
    if (!repairs?.length) { this.hide(); return }
    const path = repairs.map(({x,y,width,height}) => `M${x} ${y}h${width}v${height}h${-width}Z`).join(' ')
    const key = [rect.x,rect.y,rect.width,rect.height,path].join('/')
    if (key === this.lastClip) return
    this.lastClip = key
    this.surface.style.width = `${this.surface.width}px`
    this.surface.style.height = `${this.surface.height}px`
    this.surface.style.transform = `matrix(${rect.width/this.surface.width},0,0,${rect.height/this.surface.height},${rect.x},${rect.y})`
    this.clip.style.clipPath = `path("${path}")`
    this.clip.style.display = 'block'
  }

  hide() {
    if (this.clip) this.clip.style.display = 'none'
    this.lastClip = ''
  }
  dispose() {
    this.bind(undefined)
    this.clip?.remove()
    if (this.surface) { this.surface.width = 0; this.surface.height = 0 }
    this.surface = undefined; this.clip = undefined; this.frame = undefined
  }
}
