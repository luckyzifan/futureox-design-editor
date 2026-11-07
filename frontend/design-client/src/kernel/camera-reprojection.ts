import type { CanvasCamera } from '../canvas-camera'
import { frameTransform } from './presentation'
import type { ResidentAcknowledgement } from './resident-presentation'

import { NavigationBacking, type ScreenRect } from './navigation-backing'
export { keepCompleteCameraBacking } from './navigation-backing'

/** Main-thread ownership makes image replacement and CSS camera publication
 * atomic. A worker-owned live canvas must never use this reprojection path. */
export function atomicPresentationContext(canvas:HTMLCanvasElement) {
  if(import.meta.env.VITE_DESIGN_CAMERA_REPROJECTION==='0'||typeof OffscreenCanvas==='undefined'||typeof ImageBitmapRenderingContext==='undefined')return null
  return canvas.getContext('bitmaprenderer')
}
export function consumePresentationBitmap(context:ImageBitmapRenderingContext,canvas:HTMLCanvasElement,bitmap:ImageBitmap) {
  if(canvas.width!==bitmap.width)canvas.width=bitmap.width
  if(canvas.height!==bitmap.height)canvas.height=bitmap.height
  context.transferFromImageBitmap(bitmap)
}

/** The browser compositor can move an already accepted canvas even when its
 * raster worker is busy. This owns no texture and certifies no new pixels.
 * Callers must first prove the same document/page/session/display contract. */
export class CameraReprojection {
  private key = ''
  private displayedBacking?: ResidentAcknowledgement
  private gaps: HTMLDivElement[] = []
  private zoom?:number
  private size=''
  private zoomTimer?:ReturnType<typeof setTimeout>
  zooming=false
  readonly history: NavigationBacking
  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement,private zoomSettled?:()=>void) { this.history = new NavigationBacking(host) }

  update(backing: ResidentAcknowledgement | undefined, view: CanvasCamera, width: number, height: number, allowed: boolean, bounds?: ScreenRect, hasUnderlay=false) {
    const size=`${width}/${height}`
    const sameSize = size===this.size
    if(!allowed||!backing||!sameSize){clearTimeout(this.zoomTimer);this.zoomTimer=undefined;this.zooming=false;this.zoom=undefined}
    this.size=size
    if(allowed&&backing){
      if(this.zoom!==undefined&&this.zoom!==view.zoom){
        // Preserve the wide immutable basis across wheel reversals. Two quiet
        // animation frames can occur between individual wheel events; accepting
        // a narrow crop there makes the next zoom-out expose a white rectangle.
        this.zooming=true;clearTimeout(this.zoomTimer)
        this.zoomTimer=setTimeout(()=>{this.zoomTimer=undefined;this.zooming=false;this.zoomSettled?.()},80)
      }
      this.zoom=view.zoom
    }
    if (allowed && backing && bounds && !hasUnderlay && view.zoom < backing.view.zoom &&
        !this.history.canProject(backing,{view,width,height},bounds)) {
      // Preserve the last visible camera if the overview is still cold or its
      // budget was declined. Warming a tile or accepting a frame retries it.
      if (this.displayedBacking === backing && sameSize) return {active:false,changed:false}
      view = backing.view
    }
    this.displayedBacking = backing
    const active = !!backing && allowed && (backing.view.x !== view.x || backing.view.y !== view.y ||
      backing.view.zoom !== view.zoom || backing.width !== width || backing.height !== height)
    const transform = active ? frameTransform(view, backing.view) : undefined
    const key = JSON.stringify([active, transform, width, height, backing?.width, backing?.height])
    const changed = key !== this.key; this.key = key
    this.canvas.style.width = `${active ? backing.width : width}px`
    this.canvas.style.height = `${active ? backing.height : height}px`
    this.canvas.style.transformOrigin = '0 0'
    this.canvas.style.transform = transform ? `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` : ''
    this.canvas.style.imageRendering = ''
    this.canvas.dataset.cameraReprojected = String(active)
    this.canvas.dataset.projectedCamera = JSON.stringify(active ? view : backing?.view || view)
    this.gaps.forEach(gap => { gap.style.display = 'none' })
    if (active && !hasUnderlay) {
      const scale = view.zoom / backing.view.zoom
      const left = Math.max(0, Math.min(width, view.x - backing.view.x * scale))
      const top = Math.max(0, Math.min(height, view.y - backing.view.y * scale))
      const right = Math.max(left, Math.min(width, view.x - backing.view.x * scale + backing.width * scale))
      const bottom = Math.max(top, Math.min(height, view.y - backing.view.y * scale + backing.height * scale))
      const boxes = [[0,0,left,height],[right,0,width-right,height],[left,0,right-left,top],[left,bottom,right-left,height-bottom]]
      boxes.forEach(([x,y,w,h],i) => {
        if (!w || !h) return
        const gap = this.gaps[i] ??= this.host.insertBefore(document.createElement('div'), this.canvas)
        gap.setAttribute('aria-hidden', 'true')
        Object.assign(gap.style, { display: 'block', position: 'absolute', pointerEvents: 'none',
          left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`,
          background: '#f5f5f5' })
      })
    }
    if (allowed && backing) this.history.show(backing, {view, width, height})
    else this.history.hide()
    return { active, changed }
  }
  dispose() { this.history.dispose(); clearTimeout(this.zoomTimer);this.zoomTimer=undefined;this.zooming=false;this.gaps.forEach(gap => gap.remove()); this.gaps = []; this.canvas.style.transform = ''; this.canvas.style.imageRendering = '' }
}
