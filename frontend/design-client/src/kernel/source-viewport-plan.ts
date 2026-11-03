import type {CanvasCamera} from '../canvas-camera'
import {canvasRasterPlan,canvasRasterPhaseMatches,nativeTileMotionScale} from './canvas-raster-plan'
import {allowsReducedSampling} from './render-quality'
import {tileLevel} from './tile-cache'
import {planTilesWithPrefetchRim} from './tile-plan-aligned'
import {tileComputationDependsOnCamera,tileComputationKey,periodicComputationCamera} from './tile-computation-key'
import {panPrefetch} from './pan-prefetch'
import type {RasterTile} from './tile-cache'
import {tileIntersectsView} from './tile-preview'
import type {ResidentAcknowledgement} from './resident-presentation'

export const SOURCE_PREFETCH_BUDGET={tiles:8,bytes:8*514*514*4} as const

/** Publish a sharper tile during a zoom without losing any old visible
 * texture. The presenter has already certified physical coverage. */
export function improvesSourceZoom(previous:ResidentAcknowledgement|undefined, next:ResidentAcknowledgement,
  target:{view:CanvasCamera;width:number;height:number}, tiles:Iterable<RasterTile & {gpuTile?:number}>){
  if(!previous||next.preview||next.view.zoom<=previous.view.zoom||next.width!==target.width||next.height!==target.height||
      next.view.zoom!==target.view.zoom||next.view.x!==target.view.x||next.view.y!==target.view.y)return false
  const surviving=new Set(next.ids), prior=new Set(previous.ids.filter(id=>!surviving.has(id)))
  let sharper=false
  for(const tile of tiles){
    if(tile.gpuTile===undefined)continue
    if(!tileIntersectsView(tile,target.view,target)){prior.delete(tile.gpuTile);continue}
    if(surviving.has(tile.gpuTile)&&tile.zoom>previous.view.zoom*previous.dpr)sharper=true
  }
  return sharper&&!prior.size
}

export function sourceTileBringsDetail(tile:RasterTile,view:CanvasCamera,size:{width:number;height:number},resident:Iterable<RasterTile>){
  const box=(t:RasterTile)=>{
    const g=t.gutter??1,x=(t.x+g-(t.phaseX??0))/t.zoom,y=(t.y+g-(t.phaseY??0))/t.zoom
    return [x,y,x+(t.width-2*g)/t.zoom,y+(t.height-2*g)/t.zoom]
  }
  const b=box(tile),x=Math.max(b[0],-view.x/view.zoom),y=Math.max(b[1],-view.y/view.zoom),
    right=Math.min(b[2],(size.width-view.x)/view.zoom),bottom=Math.min(b[3],(size.height-view.y)/view.zoom)
  if(right<=x||bottom<=y)return false
  for(const t of resident){
    if(t.zoom<tile.zoom)continue
    const r=box(t)
    if(r[0]<=x&&r[1]<=y&&r[2]>=right&&r[3]>=bottom)return false
  }
  return true
}

/** Source-revision-owned demand. Required coverage and optional warm pixels
 * have separate sets; neither residency nor a frame receipt lives here. */
export class SourceViewportPlanner {
  private readonly demands:Array<{key:readonly number[];value:ReturnType<SourceViewportPlanner['compute']>}|undefined>=[undefined,undefined]
  private previous?:CanvasCamera
  private zoomingOut=false
  private zoomingIn=false
  private visibleDensity=0
  private direction?:{previous:CanvasCamera;view:CanvasCamera}
  private accepted?:{view:CanvasCamera;dpr:number;raster:ReturnType<typeof canvasRasterPlan>}
  constructor(private readonly rasterProfile:string,private readonly colorManaged:boolean){}
  /** Only a completed native presentation establishes the lattice to retain
   * through a pan. Speculative settled plans must not replace this receipt. */
  presented(view:CanvasCamera,dpr:number,width:number,height:number){
    this.visibleDensity=view.zoom*dpr
    if(this.accepted?.dpr===dpr&&this.accepted.view.x===view.x&&this.accepted.view.y===view.y&&this.accepted.view.zoom===view.zoom)return
    this.accepted={view:{...view},dpr,raster:canvasRasterPlan(view,dpr,width,height,{rasterProfile:this.rasterProfile,exactPhase:true})}
    this.demands[1]=undefined
  }
  presentedDetail(scale:number){
    if(scale>this.visibleDensity){this.visibleDensity=scale;this.demands[1]=undefined;return true}
    return false
  }
  plan(view:CanvasCamera,dpr:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=true){
    if(this.previous && (this.previous.x!==view.x || this.previous.y!==view.y || this.previous.zoom!==view.zoom)) {
      this.zoomingOut=view.zoom<this.previous.zoom
      this.zoomingIn=view.zoom>this.previous.zoom
      this.direction=this.previous.zoom===view.zoom?{previous:this.previous,view:{...view}}:undefined
    }
    this.previous={...view}
    const key=[view.x,view.y,view.zoom,dpr,width,height,Number(moving),Number(this.zoomingOut),ceiling??0,Number(continuousZoom)]
    const slot=moving?1:0,previous=this.demands[slot]
    if(previous?.key.every((v,i)=>Object.is(v,key[i])))return previous.value
    const value=this.compute(view,dpr,width,height,moving,ceiling,continuousZoom)
    this.demands[slot]={key,value};return value
  }
  private compute(view:CanvasCamera,ratio:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=true){
    const reduced=moving && this.zoomingOut && allowsReducedSampling(view.zoom)
    const native=view.zoom*ratio
    const nativeLattice=!moving || this.zoomingIn&&!continuousZoom
    let scale=reduced ? Math.min(native,tileLevel(native/2)) : !nativeLattice ? nativeTileMotionScale(view,ratio,width,height) : undefined
    if(moving&&continuousZoom&&this.zoomingIn&&this.visibleDensity>0&&native>=this.visibleDensity*4){
      // A large jump can cross many density levels in a single wheel burst.
      // Every new inward rung has more real source samples than the last
      // displayed rung. The stopped camera goes directly to native density.
      scale=Math.min(native,Math.max(this.visibleDensity*2,2**Math.floor(Math.log2(native/4))))
    }
    let raster=canvasRasterPlan(view,ratio,width,height,{rasterProfile:this.rasterProfile,exactPhase:nativeLattice,
      samplingScale:ceiling===undefined?scale:Math.min(ceiling,scale??view.zoom*ratio)})
    const bounds={x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom}
    const options={rasterProfile:this.rasterProfile}
    const dependent=tileComputationDependsOnCamera(options,this.colorManaged)
    const accepted=this.accepted
    // Translation does not change sampling density. Keep the last presented
    // fractional lattice while panning instead of switching to phase zero and
    // a zoom rung, then repainting the same viewport again on pointer release.
    // Screen-anchored byte dithering still owns its original camera semantics.
    if(ceiling===undefined&&moving&&!dependent&&accepted?.dpr===ratio&&accepted.view.zoom===view.zoom&&
      [-view.x,width-view.x,-view.y,height-view.y].every(value=>Math.abs(value*ratio)<4_000_000))raster=accepted.raster
    // Keep the device-space filter halo and its 1/8-pixel samples representable
    // on distant source pages. World tile addresses and fractional AA phase
    // stay unchanged. Adjacent tiles share a stable integer translation.
    if(!dependent && this.colorManaged){
      const left=bounds.x*raster.scale,top=bounds.y*raster.scale
      const right=left+bounds.width*raster.scale,bottom=top+bounds.height*raster.scale
      if([left+raster.camera.x,right+raster.camera.x,top+raster.camera.y,bottom+raster.camera.y].some(v=>Math.abs(v)>983040)){
        const local=(center:number,phase:number)=>65536-Math.floor(center/32768)*32768+phase
        raster={...raster,camera:{x:local((left+right)/2,raster.phase.x),y:local((top+bottom)/2,raster.phase.y),zoom:raster.scale}}
      }
    }
    const computationCamera=periodicComputationCamera(raster.camera,options,this.colorManaged)
    const addressed=planTilesWithPrefetchRim(bounds,raster.scale,256,raster.phase,
      import.meta.env.VITE_DESIGN_SOURCE_PREFETCH==='0'?0:1)
    const rekey=(tile:RasterTile)=>({...tile,key:tileComputationKey(tile,computationCamera,dependent)})
    let viewport=addressed.viewport
    if(nativeLattice&&this.colorManaged&&raster.scale>=8&&this.rasterProfile==='figmaSubpixel'){
      // Edge tiles often cover less than half a GPU surface on a Retina
      // viewport. Keep a stable 64-device-pixel rim and the original AA
      // gutter. Crops have their own texture identity and world placement.
      const unit=64
      const l=Math.floor((bounds.x*raster.scale+raster.phase.x)/unit)*unit
      const t=Math.floor((bounds.y*raster.scale+raster.phase.y)/unit)*unit
      const r=Math.ceil(((bounds.x+bounds.width)*raster.scale+raster.phase.x)/unit)*unit
      const b=Math.ceil(((bounds.y+bounds.height)*raster.scale+raster.phase.y)/unit)*unit
      viewport=viewport.map(tile=>{
        const g=tile.gutter??1,x=Math.max(l,tile.x+g)-g,y=Math.max(t,tile.y+g)-g
        const w=Math.min(r,tile.x+tile.width-g)+g-x,h=Math.min(b,tile.y+tile.height-g)+g-y
        if(w<=2*g||h<=2*g||x===tile.x&&y===tile.y&&w===tile.width&&h===tile.height)return tile
        return {...tile,x,y,width:w,height:h,key:[tile.key,'crop',x,y,w,h].join('/')}
      })
    }
    const tiles=viewport.map(rekey),rim=addressed.rim.map(rekey)
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
