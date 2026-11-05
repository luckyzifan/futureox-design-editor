import type {CanvasCamera} from '../canvas-camera'
import type {SourceCanvasBox,SourceCanvasSnapshot} from '../desktop'
import {sourcePageClip} from '../source-opening-preview'

export type OverviewMaterial = SourceCanvasBox & {materialKey?:string;previewScale?:number}
type Source = Pick<SourceCanvasSnapshot,'owner'|'revision'|'pageId'|'rasterProfile'|'colorManaged'|'materialKeys'>
type Frame = {canvas:HTMLCanvasElement;clip:HTMLDivElement;view:CanvasCamera;width:number;height:number;
  source:Source;materials:readonly OverviewMaterial[];dpr:number;complete:boolean}

/** The old display bitmap, detached from its revoked render client. No new
 * pixel allocation or editing capability crosses a material scope change. */
export class SourceOverviewHandoff {
  private frame?:Frame
  hold(canvas:HTMLCanvasElement,parent:HTMLDivElement,view:CanvasCamera,width:number,height:number,source:Source,materials:readonly OverviewMaterial[],dpr:number,complete=false){
    if(!materials.some(b=>b.materialKey))return false
    this.clear()
    const clip=document.createElement('div')
    Object.assign(clip.style,{position:'absolute',inset:'0',pointerEvents:'none',overflow:'hidden'})
    clip.className='source-overview-handoff';clip.setAttribute('aria-hidden','true')
    canvas.className='source-overview-pixels';canvas.removeAttribute('aria-label')
    parent.prepend(clip);clip.append(canvas)
    this.frame={canvas,clip,view,width,height,source,materials,dpr,complete}
    return true
  }
  project(source:Source|undefined,materials:readonly OverviewMaterial[]|undefined,view:CanvasCamera,width:number,height:number,dpr:number){
    const old=this.frame
    if(!old)return
    if(!source||source.owner.documentId!==old.source.owner.documentId||source.owner.sessionEpoch!==old.source.owner.sessionEpoch||
       source.revision!==old.source.revision||source.rasterProfile!==old.source.rasterProfile||
       source.colorManaged!==old.source.colorManaged||dpr!==old.dpr){this.clear();return}
    // Different source pages can share one overview. Hide this one existing
    // bitmap on a detour; only a new owner/revision or replacement retires it.
    if(!materials||source.pageId!==old.source.pageId){
      old.clip.style.clipPath='inset(100%)';old.clip.style.visibility='hidden';old.clip.style.zIndex='';return
    }
    const keys=new Set(materials.map(b=>b.materialKey))
    const shared=old.materials.filter(b=>b.materialKey&&keys.has(b.materialKey))
    old.clip.style.clipPath=sourcePageClip(shared,view,width,height)??''
    // On a rapid A -> B -> A the old complete A bitmap is often still here.
    // Let it show through the loading container once the immutable material
    // scope and device footprint match. It never issues a new ready receipt.
    const previous=old.source.materialKeys,now=source.materialKeys
    const restored=old.complete&&!!previous?.length&&previous.length===now?.length&&previous.every((key,i)=>key===now[i])&&
      shared.length>0&&old.view.zoom===view.zoom&&old.width===width&&old.height===height&&
      Math.abs(view.x-old.view.x)*dpr<1e-6&&Math.abs(view.y-old.view.y)*dpr<1e-6
    old.clip.style.visibility=restored?'visible':''
    old.clip.style.zIndex=restored?'1':''
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
