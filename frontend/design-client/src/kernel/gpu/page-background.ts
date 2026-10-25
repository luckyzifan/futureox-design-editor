import type { GpuScene,Rect } from './types'
import type { CanvasCamera } from '../../canvas-camera'
const contentOwner=Symbol('compiled-content-owner')
export function bindContentOwner(scene:GpuScene,owner:object){Object.defineProperty(scene,contentOwner,{value:owner,enumerable:true})}
export type PageBackgroundProof={owner:object;view:CanvasCamera;bounds:readonly (readonly number[])[];pixel?:[number,number]}
/** A sampled output texel, not a JS color conversion, supplies the exact
 * uniform page background. Unknown/background-dependent display tiers decline. */
export function pageBackgroundSource(scene:GpuScene):Omit<PageBackgroundProof,'pixel'>|undefined{
  const owner=(scene as unknown as Record<symbol,object>)[contentOwner], bounds=scene.pagePaintRects
  if(!owner||!bounds||scene.transparent||scene.grid||scene.checkerboard||scene.resolve||scene.presentation||scene.softwareRaster)return
  if(bounds.some(b=>b.length!==4||!b.every(Number.isFinite)||b[0]>b[2]||b[1]>b[3]))return
  return {owner,view:{...scene.view},bounds:bounds.map(b=>b.slice())}
}
export function pageBackgroundProof(source:Omit<PageBackgroundProof,'pixel'>,output:Rect,width:number,height:number):PageBackgroundProof{
  const {owner,view,bounds}=source
  for(const [x,y] of [[0,0],[width-1,0],[0,height-1],[width-1,height-1],
    [Math.floor(width/2),0],[0,Math.floor(height/2)],[width-1,Math.floor(height/2)],[Math.floor(width/2),height-1]]){
    const px=output.x+x,py=output.y+y
    if(bounds.every(b=>px+1<=b[0]||py+1<=b[1]||px>=b[2]||py>=b[3]))
      return {owner,view,bounds,pixel:[(x+.5)/width,(y+.5)/height]}
  }
  return source
}
export function backgroundPaintRects(proof:PageBackgroundProof,view:CanvasCamera,dpr:number,width:number,height:number){
  // Only constant background is certified here. Reprojected content keeps
  // the existing compositor's samples and independent phase-quality result.
  // Translation of conservative support is rounded outwards, never inwards.
  if(view.zoom*dpr!==proof.view.zoom)return
  const dx=view.x*dpr-proof.view.x,dy=view.y*dpr-proof.view.y
  if(!Number.isFinite(dx)||!Number.isFinite(dy)||Math.abs(dx)>16_000_000||Math.abs(dy)>16_000_000)return
  return proof.bounds.map(b=>{
    const x=Math.max(0,Math.floor(b[0]+dx)),y=Math.max(0,Math.floor(b[1]+dy))
    const right=Math.min(width,Math.ceil(b[2]+dx)),bottom=Math.min(height,Math.ceil(b[3]+dy))
    return {x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)}
  }).filter(b=>b.width>0&&b.height>0)
}
