import type {CanvasCamera} from '../canvas-camera'
import type {SourceCanvasBox} from '../desktop'

// sourcePageClip exposes this same margin around each packed material.
export const MATERIAL_MARGIN = 32

/** Quantize the visible clip outwards to prioritize native tiles. This hint
 * does not change the computation camera, pixel phase or compositor coverage. */
export function sourceOverviewWindow(boxes:readonly SourceCanvasBox[]|undefined,view:CanvasCamera,width:number,height:number,dpr:number,prior?:SourceCanvasBox){
  if(!boxes?.length||!Number.isInteger(dpr)||dpr<1||width<=0||height<=0)return
  let left=width,top=height,right=0,bottom=0
  for(const b of boxes){
    const x=(b.x-MATERIAL_MARGIN)*view.zoom+view.x,y=(b.y-MATERIAL_MARGIN)*view.zoom+view.y
    const r=(b.x+b.width+MATERIAL_MARGIN)*view.zoom+view.x,t=(b.y+b.height+MATERIAL_MARGIN)*view.zoom+view.y
    if(r<=0||t<=0||x>=width||y>=height)continue
    left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,r);bottom=Math.max(bottom,t)
  }
  if(right<=left||bottom<=top)return
  if(prior&&prior.x+prior.width<=width&&prior.y+prior.height<=height&&
    prior.x<=Math.max(0,left-1)&&prior.y<=Math.max(0,top-1)&&
    prior.x+prior.width>=Math.min(width,right+1)&&prior.y+prior.height>=Math.min(height,bottom+1))return prior
  const grid=64
  const x=Math.max(0,Math.floor((left-grid)/grid)*grid),y=Math.max(0,Math.floor((top-grid)/grid)*grid)
  const w=Math.min(width,Math.ceil((right+grid)/grid)*grid)-x,h=Math.min(height,Math.ceil((bottom+grid)/grid)*grid)-y
  if(w*h<width*height*.8)return {x,y,width:w,height:h}
}
