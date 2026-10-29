import type {CanvasCamera} from '../../src/canvas-camera'
import {canvasRasterPlan,canvasRasterPhaseMatches,nativeTileMotionScale} from '../../src/kernel/canvas-raster-plan'
import {planTilesAligned} from '../../src/kernel/tile-plan-aligned'
import {tileComputationDependsOnCamera,tileComputationKey} from '../../src/kernel/tile-computation-key'

/** A source revision owns one planner. Pixel receipts and texture residency are
 * deliberately absent: the same demand remains valid as tiles arrive/retire.
 * Memoization never certifies a frame or skips a document/source transition.
 */
export class SourceViewportPlanner {
  private readonly demands:Array<{key:readonly number[];value:ReturnType<SourceViewportPlanner['compute']>}|undefined>=[undefined,undefined]
  constructor(private readonly rasterProfile:string,private readonly colorManaged:boolean){}
  plan(view:CanvasCamera,dpr:number,width:number,height:number,moving:boolean){
    const key=[view.x,view.y,view.zoom,dpr,width,height,Number(moving)]
    const slot=moving?1:0,previous=this.demands[slot]
    if(previous?.key.every((v,i)=>Object.is(v,key[i])))return previous.value
    const value=this.compute(view,dpr,width,height,moving)
    this.demands[slot]={key,value};return value
  }
  private compute(view:CanvasCamera,ratio:number,width:number,height:number,moving:boolean){
    const raster=canvasRasterPlan(view,ratio,width,height,{rasterProfile:this.rasterProfile,exactPhase:!moving,
      samplingScale:moving?nativeTileMotionScale(view,ratio,width,height):undefined})
    const bounds={x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom}
    const dependent=tileComputationDependsOnCamera({rasterProfile:this.rasterProfile},this.colorManaged)
    const addressed=planTilesAligned(bounds,raster.scale,256,raster.phase)
    const tiles=addressed
      .map(tile=>({...tile,key:tileComputationKey(tile,raster.camera,dependent)}))
    return {ratio,raster,tiles,keys:new Set(tiles.map(tile=>tile.key)),
      exact:canvasRasterPhaseMatches(view,ratio,raster.scale,raster.phase)}
  }
}
