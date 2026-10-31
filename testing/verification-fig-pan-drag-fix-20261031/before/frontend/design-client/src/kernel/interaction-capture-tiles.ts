import { TILE_SIDE, type RasterTile } from './tile-cache'

/** Exact-density tiles preserve the original camera and world pixel lattice.
 * A gutter is rendered, then excluded from composition. No sample reduction. */
export function interactionCaptureTiles(x:number,y:number,width:number,height:number,scale:number):RasterTile[] {
  if (![x,y,width,height].every(Number.isSafeInteger) || width<1 || height<1 || !Number.isFinite(scale) || scale<=0)
    throw Error('Invalid exact interaction extent')
  if (Math.ceil(width/TILE_SIDE)*Math.ceil(height/TILE_SIDE)>256) throw Error('Exact interaction tile budget exceeded')
  const tiles:RasterTile[]=[]
  for(let top=0;top<height;top+=TILE_SIDE)for(let left=0;left<width;left+=TILE_SIDE)
    tiles.push({key:`interaction:${x+left}:${y+top}:${scale}`,x:x+left-1,y:y+top-1,
      width:Math.min(TILE_SIDE,width-left)+2,height:Math.min(TILE_SIDE,height-top)+2,zoom:scale,gutter:1})
  return tiles
}
export function recoverableInteractionBudget(error:unknown) {
  return /GPU (?:表面内存预算超限|surface budget exceeded|analytic interval program budget exceeded)|Invalid GPU (?:tile )?viewport/.test(String(error))
}
