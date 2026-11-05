import type {CanvasCamera} from '../canvas-camera'
import type {SourceCanvasBox,SourceCanvasSnapshot} from '../desktop'
import {sourcePageClip} from '../source-opening-preview'

export type OverviewMaterial = SourceCanvasBox & {materialKey?:string;previewScale?:number}
type Source = Pick<SourceCanvasSnapshot,'owner'|'revision'|'pageId'|'rasterProfile'|'colorManaged'>
type Frame = {canvas:HTMLCanvasElement;clip:HTMLDivElement;view:CanvasCamera;width:number;height:number;
  source:Source;materials:readonly OverviewMaterial[];dpr:number}

/** The old display bitmap, detached from its revoked render client. No new
 * pixel allocation or editing capability crosses a material scope change. */
export class SourceOverviewHandoff {
  private frame?:Frame
  hold(canvas:HTMLCanvasElement,parent:HTMLDivElement,view:CanvasCamera,width:number,height:number,source:Source,materials:readonly OverviewMaterial[],dpr:number){
    if(!materials.some(b=>b.materialKey))return false
    this.clear()
    const clip=document.createElement('div')
    Object.assign(clip.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'})
    clip.className='source-overview-handoff';clip.setAttribute('aria-hidden','true')
    canvas.className='source-overview-pixels';canvas.removeAttribute('aria-label')
    parent.prepend(clip);clip.append(canvas)
    this.frame={canvas,clip,view,width,height,source,materials,dpr}
    return true
  }
  project(source:Source|undefined,materials:readonly OverviewMaterial[]|undefined,view:CanvasCamera,width:number,height:number,dpr:number){
    const old=this.frame
    if(!old)return
    if(!source||!materials||source.owner.documentId!==old.source.owner.documentId||source.owner.sessionEpoch!==old.source.owner.sessionEpoch||
       source.revision!==old.source.revision||source.pageId!==old.source.pageId||source.rasterProfile!==old.source.rasterProfile||
       source.colorManaged!==old.source.colorManaged||dpr!==old.dpr){this.clear();return}
    const keys=new Set(materials.map(b=>b.materialKey))
    const shared=old.materials.filter(b=>b.materialKey&&keys.has(b.materialKey))
    old.clip.style.clipPath=sourcePageClip(shared,view,width,height)??''
    const scale=view.zoom/old.view.zoom
    Object.assign(old.canvas.style,{width:old.width+'px',height:old.height+'px',transformOrigin:'0 0',
      transform:`translate(${view.x-old.view.x*scale}px,${view.y-old.view.y*scale}px) scale(${scale})`})
  }
  clear(){
    if(!this.frame)return
    this.frame.canvas.width=1;this.frame.canvas.height=1
    this.frame.clip.remove();this.frame=undefined
  }
}
