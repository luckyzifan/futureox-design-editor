import type {RasterTile} from './tile-cache'

export const MATERIAL_BAND=960
export const MOVING_DETAIL_CORE=160
/** Ordinary GPU tile, including the one-pixel gutter. Wider source bands are
 * one capture; the settled lattice uses this side instead of waiting on the
 * last wide band. */
export const ORDINARY_SOURCE_TILE=514
const PAN_STRIP=256
type Span={start:number;end:number}
export type MaterialBandGrid={x:Span;y:Span}
type Bounds={x:number;y:number;width:number;height:number}
type Phase={x:number;y:number}

export function materialBandGrid(b:Bounds,zoom:number,phase:Phase):MaterialBandGrid {
  const span=(origin:number,length:number,p:number)=>({
    start:Math.floor((origin*zoom+p)/64)*64,end:Math.ceil(((origin+length)*zoom+p)/64)*64,
  })
  return {x:span(b.x,b.width,phase.x),y:span(b.y,b.height,phase.y)}
}

// The first view uses wide, cropped bands. Their edges stay in world space.
// Two narrow strips at each edge make a short pan cheap. Farther away the
// grid resumes wide bands so crossing the canvas diagonally stays bounded.
function bands(left:number,right:number,grid:Span):Span[] {
  const cells:Span[]=[]
  for(let point=left;point<right;){
    const inside=point>=grid.start && point<grid.end
    let anchor=grid.start,step=MATERIAL_BAND
    if(!inside){
      const leftSide=point<grid.start,edge=leftSide?grid.start:grid.end
      const outer=edge+(leftSide?-2:2)*PAN_STRIP
      const near=leftSide?point>=outer:point<outer
      anchor=near?edge:outer
      step=near?PAN_STRIP:MATERIAL_BAND
    }
    const start=anchor+Math.floor((point-anchor)/step)*step
    const end=inside?Math.min(grid.end,start+step):start+step
    if(end<=point||cells.length===256)return []
    cells.push({start,end});point=end
  }
  return cells
}

export function fixedMaterialTiles(b:Bounds,zoom:number,phase:Phase,grid:MaterialBandGrid) {
  const xs=bands(b.x*zoom+phase.x,(b.x+b.width)*zoom+phase.x,grid.x)
  const ys=bands(b.y*zoom+phase.y,(b.y+b.height)*zoom+phase.y,grid.y)
  if(!xs.length||!ys.length||xs.length*ys.length>256)return
  const cx=(b.x+b.width/2)*zoom+phase.x,cy=(b.y+b.height/2)*zoom+phase.y
  const tiles:RasterTile[]=[]
  for(const y of ys)for(const x of xs)tiles.push({
    key:[zoom,phase.x,phase.y,'source-band',x.start,y.start,x.end,y.end].join(':'),
    x:x.start-1,y:y.start-1,width:x.end-x.start+2,height:y.end-y.start+2,zoom,gutter:1,phaseX:phase.x,phaseY:phase.y,
  })
  const distance=(t:RasterTile)=>Math.hypot(t.x+t.width/2-cx,t.y+t.height/2-cy)
  return tiles.sort((a,b)=>distance(a)-distance(b))
}

/** Keep full device coordinates and the one-texel gutter. Settled bands can
 * share a visible preparation neighbourhood. During zoom the smaller tiles
 * first refine the source point under the wheel. */
export function materialTiles(bounds:{x:number;y:number;width:number;height:number},zoom:number,phase:{x:number;y:number},
  side:number,focus?:{x:number;y:number}){
  const left=bounds.x*zoom+phase.x,top=bounds.y*zoom+phase.y,right=left+bounds.width*zoom,bottom=top+bounds.height*zoom
  const alignment=side===MATERIAL_BAND?64:side
  const startX=Math.floor(left/alignment)*alignment,startY=Math.floor(top/alignment)*alignment
  if(Math.ceil((right-startX)/side)*Math.ceil((bottom-startY)/side)>256)return
  const centerX=focus?Math.min(right,Math.max(left,focus.x*zoom+phase.x)):(left+right)/2
  const centerY=focus?Math.min(bottom,Math.max(top,focus.y*zoom+phase.y)):(top+bottom)/2
  const tiles:RasterTile[]=[]
  for(let y=startY;y<bottom;y+=side){
    for(let x=startX;x<right;x+=side){
      tiles.push({key:[zoom,phase.x,phase.y,'source',side,x,y].join(':'),x:x-1,y:y-1,
        width:side+2,height:side+2,zoom,gutter:1,phaseX:phase.x,phaseY:phase.y})
    }
  }
  const distance=(t:RasterTile)=>Math.hypot(t.x+1+side/2-centerX,t.y+1+side/2-centerY)
  return tiles.sort((a,b)=>distance(a)-distance(b))
}

/** A source-detail capture wider than an ordinary tile used to take the
 * present fast path. That path does not observe cancellation until the whole
 * capture returns, so the last band stays refining and holds the raster owner
 * after the camera has moved. The recovery grid is the same sample density. */
export function sourceBandDefersWholePresent(sourceDetail:boolean,width:number,height:number){
  return sourceDetail===true&&(width>ORDINARY_SOURCE_TILE||height>ORDINARY_SOURCE_TILE)
}

/** Some wide bands are already cached and at least one wide band is not.
 * An empty cohort still uses the wide plan for the first pixels. A missing
 * ordinary tile is not this handoff. */
export function incompleteWideBandCohort(tiles:readonly {width:number;height:number;cached:boolean}[]){
  if(tiles.length<2)return false
  const missing=tiles.filter(tile=>!tile.cached)
  if(!missing.length||missing.length===tiles.length)return false
  return missing.every(tile=>tile.width>ORDINARY_SOURCE_TILE||tile.height>ORDINARY_SOURCE_TILE)
}
