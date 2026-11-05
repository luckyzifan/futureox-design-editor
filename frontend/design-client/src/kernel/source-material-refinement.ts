import type {CanvasCamera} from '../canvas-camera'
import type {OverviewMaterial} from './source-overview-handoff'
import {MATERIAL_MARGIN} from './source-overview-window'
import {tilesCoverBounds,type RasterTile} from './tile-cache'
import type {ScreenRect} from './navigation-backing'

type Viewport={view:CanvasCamera;width:number;height:number}
type Region={material:OverviewMaterial;pixels:ScreenRect;world:ScreenRect}
const intersects=(a:ScreenRect,b:ScreenRect)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height

/** Round out to the actual physical pixel edges of the CSS material clip. */
export function materialRegions(materials:readonly OverviewMaterial[],p:Viewport,dpr:number):Region[]{
  const {view:v}=p
  const worldX=(x:number)=>(x/dpr-v.x)/v.zoom,worldY=(y:number)=>(y/dpr-v.y)/v.zoom
  return materials.flatMap(material=>{
    if(!material.materialKey)return []
    const b=material,left=Math.max(0,Math.floor(((b.x-MATERIAL_MARGIN)*v.zoom+v.x)*dpr))
    const top=Math.max(0,Math.floor(((b.y-MATERIAL_MARGIN)*v.zoom+v.y)*dpr))
    const right=Math.min(Math.ceil(p.width*dpr),Math.ceil(((b.x+b.width+MATERIAL_MARGIN)*v.zoom+v.x)*dpr))
    const bottom=Math.min(Math.ceil(p.height*dpr),Math.ceil(((b.y+b.height+MATERIAL_MARGIN)*v.zoom+v.y)*dpr))
    if(right<=left||bottom<=top)return []
    return [{material,pixels:{x:left,y:top,width:right-left,height:bottom-top},
      world:{x:worldX(left),y:worldY(top),width:worldX(right)-worldX(left),height:worldY(bottom)-worldY(top)}}]
  })
}

export function completeMaterialRegions(regions:Region[],tiles:RasterTile[],scale:number,physicalGaps:readonly ScreenRect[]=[]){
  return regions.filter(r=>!physicalGaps.some(gap=>intersects(r.pixels,gap))&&tilesCoverBounds(tiles,r.world,scale))
}

/** A regional handoff must keep detail that still projects into the new view. */
export function retainsVisibleMaterials(previous:readonly OverviewMaterial[]|undefined,ready:Region[],p:Viewport,dpr:number){
  if(!previous?.length)return true
  const keys=new Set(ready.map(r=>r.material.materialKey))
  return materialRegions(previous,p,dpr).every(r=>keys.has(r.material.materialKey))
}

/** Finish the artwork around the zoom anchor before filling unrelated corners.
 * Every requested tile keeps its original key, gutter and complete support. */
export function orderMaterialTiles<T extends RasterTile>(missing:T[],regions:Region[],focus:{x:number;y:number}){
  if(missing.length<2||!regions.length)return missing
  const distance=(r:Region)=>Math.hypot(Math.max(r.world.x-focus.x,0,focus.x-r.world.x-r.world.width),
    Math.max(r.world.y-focus.y,0,focus.y-r.world.y-r.world.height))
  const result:T[]=[],seen=new Set<string>()
  const ranked=regions.map(region=>({region,d:distance(region),tiles:missing.filter(t=>{
    const g=t.gutter??1
    return intersects({x:(t.x+g-(t.phaseX??0))/t.zoom,y:(t.y+g-(t.phaseY??0))/t.zoom,
      width:(t.width-2*g)/t.zoom,height:(t.height-2*g)/t.zoom},region.world)
  })})).filter(r=>r.tiles.length).sort((a,b)=>a.d-b.d||a.tiles.length-b.tiles.length)
  for(const {tiles} of ranked)for(const tile of tiles)if(!seen.has(tile.key)){seen.add(tile.key);result.push(tile)}
  return [...result,...missing.filter(t=>!seen.has(t.key))]
}

// A provisional material scope may produce the complete visible artwork in
// a small set of crops. Keep the global sampling camera and a real gutter.
export function focalMaterialTiles(materials:readonly OverviewMaterial[],p:Viewport,dpr:number,phase:{x:number;y:number}):RasterTile[]|undefined{
  const zoom=p.view.zoom*dpr,ox=phase.x-p.view.x*dpr,oy=phase.y-p.view.y*dpr
  if(!Number.isSafeInteger(ox)||!Number.isSafeInteger(oy)||materials.length>2)return
  const tiles:RasterTile[]=[]
  for(const {pixels:r} of materialRegions(materials,p,dpr)){
    for(let y=r.y;y<r.y+r.height;y+=512)for(let x=r.x;x<r.x+r.width;x+=512){
      const w=Math.min(512,r.x+r.width-x),h=Math.min(512,r.y+r.height-y)
      const left=x+ox-1,top=y+oy-1
      tiles.push({key:[zoom,phase.x,phase.y,'material-focus',left,top,w,h].join(':'),x:left,y:top,
        width:w+2,height:h+2,zoom,phaseX:phase.x,phaseY:phase.y,gutter:1})
    }
  }
  return tiles.length&&tiles.length<=32?tiles:undefined
}
