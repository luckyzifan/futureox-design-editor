import type {CanvasCamera} from '../canvas-camera'
import {canvasRasterPlan,canvasRasterPhaseMatches,nativeTileMotionScale} from './canvas-raster-plan'
import {planTilesWithPrefetchRim} from './tile-plan-aligned'
import {tileComputationDependsOnCamera,tileComputationKey,periodicComputationCamera} from './tile-computation-key'
import {panPrefetch} from './pan-prefetch'
import type {RasterTile} from './tile-cache'

export const SOURCE_PREFETCH_BUDGET={tiles:8,bytes:8*514*514*4} as const

/** Source-revision-owned demand. Required coverage and optional warm pixels
 * have separate sets; neither residency nor a frame receipt lives here. */
export class SourceViewportPlanner {
  private readonly demands:Array<{key:readonly number[];value:ReturnType<SourceViewportPlanner['compute']>}|undefined>=[undefined,undefined]
  private previous?:CanvasCamera
  private direction?:{previous:CanvasCamera;view:CanvasCamera}
  private accepted?:{view:CanvasCamera;dpr:number;raster:ReturnType<typeof canvasRasterPlan>}
  constructor(private readonly rasterProfile:string,private readonly colorManaged:boolean){}
  /** Only a completed native presentation establishes the lattice to retain
   * through a pan. Speculative settled plans must not replace this receipt. */
  presented(view:CanvasCamera,dpr:number,width:number,height:number){
    if(this.accepted?.dpr===dpr&&this.accepted.view.x===view.x&&this.accepted.view.y===view.y&&this.accepted.view.zoom===view.zoom)return
    this.accepted={view:{...view},dpr,raster:canvasRasterPlan(view,dpr,width,height,{rasterProfile:this.rasterProfile,exactPhase:true})}
    this.demands[1]=undefined
  }
  plan(view:CanvasCamera,dpr:number,width:number,height:number,moving:boolean){
    const key=[view.x,view.y,view.zoom,dpr,width,height,Number(moving)]
    const slot=moving?1:0,previous=this.demands[slot]
    if(previous?.key.every((v,i)=>Object.is(v,key[i])))return previous.value
    if(this.previous && (this.previous.x!==view.x || this.previous.y!==view.y || this.previous.zoom!==view.zoom)) {
      this.direction=this.previous.zoom===view.zoom?{previous:this.previous,view:{...view}}:undefined
    }
    this.previous={...view}
    const value=this.compute(view,dpr,width,height,moving)
    this.demands[slot]={key,value};return value
  }
  private compute(view:CanvasCamera,ratio:number,width:number,height:number,moving:boolean){
    let raster=canvasRasterPlan(view,ratio,width,height,{rasterProfile:this.rasterProfile,exactPhase:!moving,
      samplingScale:moving?nativeTileMotionScale(view,ratio,width,height):undefined})
    const bounds={x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom}
    const options={rasterProfile:this.rasterProfile}
    const dependent=tileComputationDependsOnCamera(options,this.colorManaged)
    const accepted=this.accepted
    // Translation does not change sampling density. Keep the last presented
    // fractional lattice while panning instead of switching to phase zero and
    // a zoom rung, then repainting the same viewport again on pointer release.
    // Screen-anchored byte dithering still owns its original camera semantics.
    if(moving&&!dependent&&accepted?.dpr===ratio&&accepted.view.zoom===view.zoom&&
      [-view.x,width-view.x,-view.y,height-view.y].every(value=>Math.abs(value*ratio)<4_000_000))raster=accepted.raster
    const computationCamera=periodicComputationCamera(raster.camera,options,this.colorManaged)
    const addressed=planTilesWithPrefetchRim(bounds,raster.scale,256,raster.phase,
      import.meta.env.VITE_DESIGN_SOURCE_PREFETCH==='0'?0:1)
    const rekey=(tile:RasterTile)=>({...tile,key:tileComputationKey(tile,computationCamera,dependent)})
    const tiles=addressed.viewport.map(rekey),rim=addressed.rim.map(rekey)
    const directional=this.direction?.view.zoom===view.zoom
      ?panPrefetch(rim,this.direction.previous,this.direction.view,bounds,SOURCE_PREFETCH_BUDGET):[]
    // Directionless idle frames warm both horizontal neighbours first. No
    // enlargement of the viewport plan, raster batch or GPU working budget.
    const horizontal=(tile:RasterTile)=>{
      const y=(tile.y+(tile.gutter??1)-(tile.phaseY??0))/tile.zoom
      const bottom=(tile.y+tile.height-(tile.gutter??1)-(tile.phaseY??0))/tile.zoom
      return y<bounds.y+bounds.height && bottom>bounds.y
    }
    const center={x:(bounds.x+bounds.width/2)*raster.scale,y:(bounds.y+bounds.height/2)*raster.scale}
    const idle=rim.slice().sort((a,b)=>Number(horizontal(b))-Number(horizontal(a)) ||
      Math.hypot(a.x+a.width/2-center.x,a.y+a.height/2-center.y)-Math.hypot(b.x+b.width/2-center.x,b.y+b.height/2-center.y))
    let bytes=0
    const prefetch=(directional.length?directional:idle).filter(tile=>{
      const cost=tile.width*tile.height*4
      if(bytes+cost>SOURCE_PREFETCH_BUDGET.bytes)return false
      bytes+=cost;return true
    }).slice(0,SOURCE_PREFETCH_BUDGET.tiles)
    return {ratio,raster,tiles,keys:new Set(tiles.map(tile=>tile.key)),prefetch,prefetchKeys:new Set(prefetch.map(tile=>tile.key)),
      exact:canvasRasterPhaseMatches(view,ratio,raster.scale,raster.phase)}
  }
}
