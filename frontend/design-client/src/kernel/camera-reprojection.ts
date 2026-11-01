import type { CanvasCamera } from '../canvas-camera'
import { frameTransform } from './presentation'
import type { ResidentAcknowledgement } from './resident-presentation'

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
  private gaps: HTMLDivElement[] = []
  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement) {}

  update(backing: ResidentAcknowledgement | undefined, view: CanvasCamera, width: number, height: number, allowed: boolean) {
    const active = !!backing && allowed && (backing.view.x !== view.x || backing.view.y !== view.y ||
      backing.view.zoom !== view.zoom || backing.width !== width || backing.height !== height)
    const transform = active ? frameTransform(view, backing.view) : undefined
    const key = JSON.stringify([active, transform, width, height, backing?.width, backing?.height])
    const changed = key !== this.key; this.key = key
    this.canvas.style.width = `${active ? backing.width : width}px`
    this.canvas.style.height = `${active ? backing.height : height}px`
    this.canvas.style.transformOrigin = '0 0'
    this.canvas.style.transform = transform ? `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` : ''
    this.canvas.style.imageRendering = transform && transform.scale > 1 ? 'pixelated' : ''
    this.canvas.dataset.cameraReprojected = String(active)
    this.canvas.dataset.projectedCamera = JSON.stringify(active ? view : backing?.view || view)
    this.gaps.forEach(gap => { gap.style.display = 'none' })
    if (active) {
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
          background: '#fff' })
      })
    }
    return { active, changed }
  }
  dispose() { this.gaps.forEach(gap => gap.remove()); this.gaps = []; this.canvas.style.transform = ''; this.canvas.style.imageRendering = '' }
}
