import type { CanvasCamera } from '../canvas-camera'
import { frameTransform } from './presentation'
import type { ResidentAcknowledgement } from './resident-presentation'

function covers(backing: ResidentAcknowledgement, target: {view:CanvasCamera;width:number;height:number}) {
  const scale=target.view.zoom/backing.view.zoom,x=target.view.x-backing.view.x*scale,y=target.view.y-backing.view.y*scale
  return x<=1e-7&&y<=1e-7&&x+backing.width*scale>=target.width-1e-7&&y+backing.height*scale>=target.height-1e-7
}
export function keepCompleteCameraBacking(backing: ResidentAcknowledgement | undefined, next: ResidentAcknowledgement, allowed: boolean,
  zooming=false,target?:{view:CanvasCamera;width:number;height:number}) {
  return allowed && !!backing && !backing.preview && !backing.interaction && !next.interaction &&
    (!!next.preview || zooming&&next.view.zoom>backing.view.zoom || !!target&&covers(backing,target)&&!covers(next,target))
}

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
  private zoom?:number
  private size=''
  private zoomTimer?:ReturnType<typeof setTimeout>
  zooming=false
  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement,private zoomSettled?:()=>void) {}

  update(backing: ResidentAcknowledgement | undefined, view: CanvasCamera, width: number, height: number, allowed: boolean) {
    const size=`${width}/${height}`
    if(!allowed||!backing||size!==this.size){clearTimeout(this.zoomTimer);this.zoomTimer=undefined;this.zooming=false;this.zoom=undefined}
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
  dispose() { clearTimeout(this.zoomTimer);this.zoomTimer=undefined;this.zooming=false;this.gaps.forEach(gap => gap.remove()); this.gaps = []; this.canvas.style.transform = ''; this.canvas.style.imageRendering = '' }
}
