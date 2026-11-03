import type {CanvasCamera} from '../canvas-camera'
import {canvasRasterPlan,canvasRasterPhaseMatches,nativeTileMotionScale} from './canvas-raster-plan'
import {allowsReducedSampling} from './render-quality'
import {tileLevel,tilesCoverBounds} from './tile-cache'
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
  target:{view:CanvasCamera;width:number;height:number}, tiles:Iterable<RasterTile & {gpuTile?:number}>, previousTiles?:Iterable<RasterTile & {gpuTile?:number}>){
  if(!previous||next.preview||next.dpr!==previous.dpr||next.width!==target.width||next.height!==target.height||
      next.view.zoom<=previous.view.zoom||next.view.zoom>target.view.zoom)return false
  // A newer wheel event may already have arrived. An immutable frame can
  // advance if its world rectangle still covers the entire current viewport.
  const ratio=next.view.zoom/target.view.zoom
  const left=next.view.x-target.view.x*ratio,top=next.view.y-target.view.y*ratio
  if(left< -1e-6||top< -1e-6||left+target.width*ratio>next.width+1e-6||top+target.height*ratio>next.height+1e-6)return false
  const entries=[...tiles],prior=new Set(previous.ids),shown=new Set(next.ids)
  const former=(previousTiles?[...previousTiles]:entries).filter(t=>t.gpuTile!==undefined&&prior.has(t.gpuTile))
  const current=entries.filter(t=>t.gpuTile!==undefined&&shown.has(t.gpuTile))
  if(previous.ids.some(id=>!former.some(t=>t.gpuTile===id)))return false
  const same=(a:typeof entries[number],b:typeof entries[number])=>a.gpuTile===b.gpuTile&&a.key===b.key
  if(former.some(t=>!current.some(c=>same(c,t))&&sourceTileBringsDetail(t,target.view,target,current)))return false
  return current.some(t=>!former.some(f=>same(f,t))&&t.zoom>previous.view.zoom*previous.dpr&&
    sourceTileBringsDetail(t,target.view,target,former))
}

export function sourceTileBringsDetail(tile:RasterTile,view:CanvasCamera,size:{width:number;height:number},resident:Iterable<RasterTile>){
  const box=(t:RasterTile)=>{
    const g=t.gutter??1,x=(t.x+g-(t.phaseX??0))/t.zoom,y=(t.y+g-(t.phaseY??0))/t.zoom
    return [x,y,x+(t.width-2*g)/t.zoom,y+(t.height-2*g)/t.zoom]
  }
  const b=box(tile),x=Math.max(b[0],-view.x/view.zoom),y=Math.max(b[1],-view.y/view.zoom),
    right=Math.min(b[2],(size.width-view.x)/view.zoom),bottom=Math.min(b[3],(size.height-view.y)/view.zoom)
  if(right<=x||bottom<=y)return false
  return !tilesCoverBounds([...resident],{x,y,width:right-x,height:bottom-y},tile.zoom)
}

/** A scheduling hint from already displayed source pixels. Sample the visible
 * material, so one tiny high-density tile cannot set the whole view's rung. */
export function visibleSourceDensity(tiles:Iterable<RasterTile>, view:CanvasCamera, size:{width:number;height:number},
  bounds:{x:number;y:number;width:number;height:number}){
  const left=Math.max(bounds.x,-view.x/view.zoom),top=Math.max(bounds.y,-view.y/view.zoom)
  const right=Math.min(bounds.x+bounds.width,(size.width-view.x)/view.zoom)
  const bottom=Math.min(bounds.y+bounds.height,(size.height-view.y)/view.zoom)
  if(left>=right||top>=bottom)return 0
  const samples=[[.2,.2],[.8,.2],[.5,.5],[.2,.8],[.8,.8]].map(([x,y])=>({x:left+(right-left)*x,y:top+(bottom-top)*y,scale:0}))
  for(const tile of tiles){
    const g=tile.gutter??1
    for(const point of samples){
      const x=point.x*tile.zoom+(tile.phaseX??0),y=point.y*tile.zoom+(tile.phaseY??0)
      if(x>=tile.x+g&&x<tile.x+tile.width-g&&y>=tile.y+g&&y<tile.y+tile.height-g)point.scale=Math.max(point.scale,tile.zoom)
    }
  }
  return Math.min(...samples.map(p=>p.scale))
}

/** Source-revision-owned demand. Required coverage and optional warm pixels
 * have separate sets; neither residency nor a frame receipt lives here. */
export class SourceViewportPlanner {
  private readonly demands:Array<{key:readonly number[];value:ReturnType<SourceViewportPlanner['compute']>}|undefined>=[undefined,undefined]
  private previous?:CanvasCamera
  private zoomingOut=false
  private zoomingIn=false
  private visibleDensity=0
  private inwardRung=0
  private direction?:{previous:CanvasCamera;view:CanvasCamera}
  private accepted?:{view:CanvasCamera;dpr:number;raster:ReturnType<typeof canvasRasterPlan>}
  constructor(private readonly rasterProfile:string,private readonly colorManaged:boolean){}
  /** Only a completed native presentation establishes the lattice to retain
   * through a pan. Speculative settled plans must not replace this receipt. */
  presented(view:CanvasCamera,dpr:number,width:number,height:number){
    this.inwardRung=0
    this.visibleDensity=view.zoom*dpr
    if(this.accepted?.dpr===dpr&&this.accepted.view.x===view.x&&this.accepted.view.y===view.y&&this.accepted.view.zoom===view.zoom)return
    this.accepted={view:{...view},dpr,raster:canvasRasterPlan(view,dpr,width,height,{rasterProfile:this.rasterProfile,exactPhase:true})}
    this.demands[1]=undefined
  }
  presentedDetail(scale:number){
    if(scale>this.visibleDensity){this.visibleDensity=scale;this.demands[1]=undefined;return true}
    return false
  }
  plan(view:CanvasCamera,dpr:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=false){
    if(this.previous && (this.previous.x!==view.x || this.previous.y!==view.y || this.previous.zoom!==view.zoom)) {
      this.zoomingOut=view.zoom<this.previous.zoom
      if(this.zoomingOut)this.inwardRung=0
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
  private compute(view:CanvasCamera,ratio:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=false){
    const reduced=moving && this.zoomingOut && allowsReducedSampling(view.zoom)
    const native=view.zoom*ratio
    const nativeLattice=!moving || this.zoomingIn&&!continuousZoom
    let scale=reduced ? Math.min(native,tileLevel(native/2)) : !nativeLattice ? nativeTileMotionScale(view,ratio,width,height) : undefined
    if(moving&&continuousZoom&&this.zoomingIn&&this.visibleDensity>0&&native>this.visibleDensity){
      // Keep one drawable lattice in flight across wheel events. A new camera
      // changes the visible tiles without restarting refinement at a new scale.
      if(this.inwardRung<=this.visibleDensity||this.inwardRung>native*1.2||native>this.inwardRung*8){
        const next=2**(Math.floor(Math.log2(this.visibleDensity)*2+1e-9)/2+.5)
        this.inwardRung=Math.min(nativeTileMotionScale(view,ratio,width,height),Math.max(next,2**Math.floor(Math.log2(native/4))))
      }
      scale=this.inwardRung
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
