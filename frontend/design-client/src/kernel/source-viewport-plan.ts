import {fixedMaterialTiles,materialBandGrid,materialTiles,MOVING_DETAIL_CORE,type MaterialBandGrid} from './source-display-band'
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

/** Only a physically acknowledged, gap-free backing can stand in for an
 * intermediate zoom rung while the exact settled view gets the raster slot.
 * This is containment for display continuity, never a native-ready receipt. */
export function backingCoversSettledSource(backing:ResidentAcknowledgement|undefined,
  target:{view:CanvasCamera;width:number;height:number},dpr:number){
  if(!backing || backing.preview || backing.previewGaps?.length || backing.dpr!==dpr ||
      backing.width!==target.width || backing.height!==target.height)return false
  const ratio=backing.view.zoom/target.view.zoom
  const left=backing.view.x-target.view.x*ratio,top=backing.view.y-target.view.y*ratio
  return ratio>0 && ratio<=1 && left>=-1e-6 && top>=-1e-6 &&
    left+target.width*ratio<=backing.width+1e-6 && top+target.height*ratio<=backing.height+1e-6
}

/** Publish a sharper tile during a zoom without losing any old visible
 * texture. The presenter has already certified physical coverage. */
export function improvesSourceZoom(previous:ResidentAcknowledgement|undefined, next:ResidentAcknowledgement,
  target:{view:CanvasCamera;width:number;height:number}, tiles:Iterable<RasterTile & {gpuTile?:number}>, previousTiles?:Iterable<RasterTile & {gpuTile?:number}>){
  if(!previous||next.preview||next.dpr!==previous.dpr||previous.width!==target.width||previous.height!==target.height||
      next.width!==target.width||next.height!==target.height||
      next.view.zoom<previous.view.zoom||next.view.zoom>target.view.zoom||
      (next.view.zoom===previous.view.zoom && (next.view.x!==previous.view.x||next.view.y!==previous.view.y)))return false
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
  // A projected frame's camera can already be finer than the texels it
  // displays. Compare against its actual retained tiles at this location.
  return current.some(t=>!former.some(f=>same(f,t)) &&
    (former.length>0 || t.zoom>previous.view.zoom*previous.dpr) &&
    sourceTileBringsDetail(t,target.view,target,former))
}

/** A moving view may mix native texture densities only when the entire current
 * viewport is covered and at least one visible region gains source detail. */
export function coveredSourceDetail<T extends RasterTile & {used: number}>(
  cached: Iterable<T>, target: {view: CanvasCamera; width: number; height: number}, previous: RasterTile[], wholeTier=false,
): T[] | undefined {
  const {view,width,height}=target
  const visible=[...cached].filter(tile=>tileIntersectsView(tile,view,target)).sort((a,b)=>a.zoom-b.zoom||a.used-b.used)
  const world={x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom}
  if(wholeTier){
    const tier=completeSourceTier(visible,world)
    return tier?.some(t=>sourceTileBringsDetail(t,view,target,previous))?tier:undefined
  }
  if(!visible.some(tile=>sourceTileBringsDetail(tile,view,target,previous)))return
  // Prefer an already complete finest lattice. A pending overscan tile can
  // still prevent terminal readiness. The presenter verifies physical cover.
  const finest=visible[visible.length-1]
  const tier=visible.filter(t=>t.zoom===finest.zoom)
  if(tier.length<visible.length && tier.every(t=>(t.phaseX??0)===(finest.phaseX??0)&&(t.phaseY??0)===(finest.phaseY??0)) &&
      tilesCoverBounds(tier,world))return tier
  return tilesCoverBounds(visible,world)?visible:undefined
}

function completeSourceTier<T extends RasterTile>(tiles:T[],world:{x:number;y:number;width:number;height:number}):T[]|undefined {
  const tiers=new Map<string,T[]>()
  for(const tile of tiles){
    const key=[tile.zoom,tile.phaseX??0,tile.phaseY??0].join('/')
    const tier=tiers.get(key)
    if(tier)tier.push(tile);else tiers.set(key,[tile])
  }
  return [...tiers.values()].sort((a,b)=>b[0].zoom-a[0].zoom).find(tier=>tilesCoverBounds(tier,world))
}

/** During an outward wheel gesture finer resident source pixels can already
 * cover the new view. Their physical presentation is still a preview until
 * the exact requested sampling phase has its own receipt. */
export function retainedZoomOut<T extends RasterTile & {used:number}>(cache:Iterable<T>,view:CanvasCamera,
  size:{width:number;height:number}, dpr:number,wholeTier=false):T[]|undefined {
  const scale=view.zoom*dpr
  const visible=[...cache].filter(t=>t.zoom>=scale&&tileIntersectsView(t,view,size))
  if(!visible.length)return
  const bounds={x:-view.x/view.zoom,y:-view.y/view.zoom,width:size.width/view.zoom,height:size.height/view.zoom}
  if(wholeTier)return completeSourceTier(visible,bounds)
  if(tilesCoverBounds(visible,bounds,scale))return visible.sort((a,b)=>a.zoom-b.zoom||a.used-b.used)
}

/** Reproject an already completed return view while exact work continues.
 * Wheel roundtrips can differ by a few float scroll-input bits. Limit the
 * density difference to less than 1/256 device pixel over the whole viewport.
 * This never satisfies native demand or skips the current exact raster. */
export function retainedSourceReturn<T extends RasterTile & {used:number}>(cache:Iterable<T>,view:CanvasCamera,
  size:{width:number;height:number},dpr:number,wholeTier=false):T[]|undefined {
  const pixels=Math.max(size.width,size.height)*dpr
  if(!Number.isFinite(pixels)||pixels<=0)return
  return retainedZoomOut(cache,view,size,dpr*(1-1/(256*Math.max(1,pixels))),wholeTier)
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
  private zoomFocus?:{x:number;y:number}
  private inwardRung=0
  private coverageRetry?:{view:CanvasCamera;ratio:number;width:number;height:number}
  private direction?:{previous:CanvasCamera;view:CanvasCamera}
  private accepted?:{view:CanvasCamera;dpr:number;raster:ReturnType<typeof canvasRasterPlan>}
  private readonly bandGrids=new Map<string,MaterialBandGrid>()
  constructor(private readonly rasterProfile:string,private readonly colorManaged:boolean, private readonly material=false,private readonly overview=false){}
  focus(view:CanvasCamera,width:number,height:number){
    const focus=this.zoomFocus
    if(focus&&focus.x*view.zoom+view.x>=0&&focus.x*view.zoom+view.x<width&&focus.y*view.zoom+view.y>=0&&focus.y*view.zoom+view.y<height)return focus
    return {x:(width/2-view.x)/view.zoom,y:(height/2-view.y)/view.zoom}
  }
  /** A physical gap or rejected display band retries the same native density
   * on the established, uncropped tile lattice before any lower tier. */
  retryNativeCoverage(view:CanvasCamera,ratio:number,width:number,height:number){
    const old=this.coverageRetry
    if(old&&old.view.x===view.x&&old.view.y===view.y&&old.view.zoom===view.zoom&&old.ratio===ratio&&old.width===width&&old.height===height)return false
    this.coverageRetry={view:{...view},ratio,width,height}
    this.demands[0]=this.demands[1]=undefined
    return true
  }
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
  plan(view:CanvasCamera,dpr:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=false,window?:{x:number;y:number;width:number;height:number}){
    const retry=this.coverageRetry
    if(retry&&(retry.view.x!==view.x||retry.view.y!==view.y||retry.view.zoom!==view.zoom||retry.ratio!==dpr||retry.width!==width||retry.height!==height))this.coverageRetry=undefined
    if(this.previous && (this.previous.x!==view.x || this.previous.y!==view.y || this.previous.zoom!==view.zoom)) {
      this.zoomingOut=view.zoom<this.previous.zoom
      if(this.zoomingOut)this.inwardRung=0
      this.zoomingIn=view.zoom>this.previous.zoom
      if(this.zoomingIn){
        const delta=view.zoom-this.previous.zoom
        this.zoomFocus={x:(this.previous.x-view.x)/delta,y:(this.previous.y-view.y)/delta}
      }
      this.direction=this.previous.zoom===view.zoom?{previous:this.previous,view:{...view}}:undefined
    }
    this.previous={...view}
    const key=[view.x,view.y,view.zoom,dpr,width,height,Number(moving),Number(this.zoomingOut),ceiling??0,Number(continuousZoom),window?.x??0,window?.y??0,window?.width??width,window?.height??height]
    const slot=moving?1:0,previous=this.demands[slot]
    if(previous?.key.every((v,i)=>Object.is(v,key[i])))return previous.value
    const value=this.compute(view,dpr,width,height,moving,ceiling,continuousZoom,window)
    this.demands[slot]={key,value};return value
  }
  private compute(view:CanvasCamera,ratio:number,width:number,height:number,moving:boolean,ceiling?:number,continuousZoom=false,window?:{x:number;y:number;width:number;height:number}){
    const reduced=moving && this.zoomingOut && allowsReducedSampling(view.zoom)
    const native=view.zoom*ratio
    const panBands=!!this.direction && this.material && this.colorManaged && this.rasterProfile==='figmaSubpixel'
    const nativeLattice=!moving || this.zoomingIn&&!continuousZoom || panBands
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
    let viewport=addressed.viewport,bandGrid:MaterialBandGrid|undefined
    if(!this.coverageRetry&&this.material&&this.colorManaged&&this.rasterProfile==='figmaSubpixel'){
      if(nativeLattice&&raster.scale>=8){
        const slot=[raster.scale,ratio,width,height].join('/')
        bandGrid=this.bandGrids.get(slot)
        if(!bandGrid){
          bandGrid=materialBandGrid(bounds,raster.scale,raster.phase)
          if(this.bandGrids.size>=16)this.bandGrids.delete(this.bandGrids.keys().next().value!)
          this.bandGrids.set(slot,bandGrid)
        }
        viewport=fixedMaterialTiles(bounds,raster.scale,raster.phase,bandGrid)??viewport
      }
      else if(moving&&this.zoomingIn&&continuousZoom&&raster.scale>=2&&view.zoom*ratio<8)
        viewport=materialTiles(bounds,raster.scale,raster.phase,MOVING_DETAIL_CORE,this.zoomFocus)??viewport
    }
    if(!bandGrid&&!this.coverageRetry&&nativeLattice&&this.colorManaged&&raster.scale>=8&&this.rasterProfile==='figmaSubpixel'){
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
    // Catalogue bounds only change order. Dropping tiles outside a material
    // window left screen-aligned holes: at 25% the art can cover less than
    // 80% of the viewport, the omitted lattice never gets scheduled, and the
    // presenter then paints those gaps as page background through the
    // isometric faces. A declined coverage retry still asks for the full set.
    if(window&&this.overview&&!this.coverageRetry&&raster.scale<8){
      const clipped={...view,x:view.x-window.x,y:view.y-window.y}
      const hits:typeof viewport=[],rest:typeof viewport=[]
      for(const tile of viewport)(tileIntersectsView(tile,clipped,window)?hits:rest).push(tile)
      if(hits.length&&rest.length)viewport=[...hits,...rest]
    }
    const tiles=viewport.map(rekey)
    let rim=addressed.rim.map(rekey)
    if(bandGrid){
      const pad=256/raster.scale,keys=new Set(viewport.map(t=>t.key))
      const neighbours=this.direction && import.meta.env.VITE_DESIGN_SOURCE_PREFETCH!=='0' &&
        fixedMaterialTiles({x:bounds.x-pad,y:bounds.y-pad,width:bounds.width+2*pad,height:bounds.height+2*pad},raster.scale,raster.phase,bandGrid)
      rim=neighbours?neighbours.filter(t=>!keys.has(t.key)).map(t=>({...rekey(t),prefetch:true})):[]
    }
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
    const prefetch=(this.material&&!this.direction?[]:directional.length?directional:idle).filter(tile=>{
      const cost=tile.width*tile.height*4
      if(bytes+cost>SOURCE_PREFETCH_BUDGET.bytes)return false
      bytes+=cost;return true
    }).slice(0,SOURCE_PREFETCH_BUDGET.tiles)
    return {ratio,raster,tiles,keys:new Set(tiles.map(tile=>tile.key)),prefetch,prefetchKeys:new Set(prefetch.map(tile=>tile.key)),
      exact:canvasRasterPhaseMatches(view,ratio,raster.scale,raster.phase)}
  }
}
