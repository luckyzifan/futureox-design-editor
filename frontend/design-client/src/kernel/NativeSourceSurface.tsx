import {materialRegions,completeMaterialRegions,orderMaterialTiles,focalMaterialTiles,retainsVisibleMaterials} from './source-material-refinement'
import {sourcePageClip} from '../source-opening-preview'
import {useLayoutEffect,useMemo,useRef} from 'react'
import {SourceOverviewHandoff,type OverviewMaterial} from './source-overview-handoff'
import {sourceOverviewWindow} from './source-overview-window'
import {desktopBridge,type SourceCanvasSnapshot} from '../desktop'
import {navigationOverview,nearOverviewTiles,overviewWarmBatch} from './navigation-overview'
import {NAVIGATION_BACKING_BYTES} from './navigation-backing'
import type {CanvasCamera} from '../canvas-camera'
import {KernelClient,backendPreference,renderExecutionPolicy,type TileResult} from './client'
import {canvasSamplingProfile} from './render-policy'
import {SourceViewportPlanner,backingCoversSettledSource,coveredSourceDetail,retainedZoomOut,retainedSourceReturn,improvesSourceZoom,visibleSourceDensity} from './source-viewport-plan'
import {retainInFlightTile,selectCoverageStack} from './coverage-stack'
import {prioritizeUncoveredTiles} from './coverage-priority'
import {tileBatchPrepareViewport} from './tile-prepare-viewport'
import {tileIntersectsView, tilePlacementAtView} from './tile-preview'
import {cpuTileBlitOrigin} from './cpu-tile-frame'
import {SourceRenderWork} from './source-render-work'
import {sourceTileRetirement,rememberSourceTier} from './source-tile-retirement'
import {SourceQualityLadder,sourceRasterLimit} from './source-quality-ladder'
import { outwardInteractionScale } from './interaction-adaptive-density'
import {useDevicePixelRatio} from './presentation'
import type {ResidentAcknowledgement} from './resident-presentation'
import type {ResidentFrame} from './gpu/resident-presenter'
import type {RasterTile} from './tile-cache'
import {createRenderDiagnostics,PREFIX} from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import {CameraReprojection,atomicPresentationContext,consumePresentationBitmap} from './camera-reprojection'

export type NativeSourceStatus={phase:'loading'|'refining'|'ready'|'limited'|'error';done:number;total:number;error?:string}
type Props={hover?:import('../source-hover-detail').SourceHoverHub;overviewBoxes?:readonly OverviewMaterial[];hidden?:boolean;parked?:boolean;panGestureActive?:boolean;underlay?:import('../source-opening-preview').SourceThumbnailCoverage;clipPath?:string;source?:SourceCanvasSnapshot;warm?:boolean;wheelView?:CanvasCamera;view:CanvasCamera;width:number;height:number;
  onStatus?:(status:NativeSourceStatus)=>void;onPresented?:(frame:ResidentAcknowledgement,complete:boolean)=>void}
type Placement=RasterTile & {gpuTile:number}
type Tile=TileResult&{serial:number;used:number;lastSubmission:number;placement?:Placement}
// One raster owner plus at most one speculative preparation in the existing
// worker. A larger batch is unnecessary and would extend cancellation work.
const SOURCE_PIPELINE_TILES=2
const SOURCE_QUIET_MS=32
// Wheel events can arrive several display frames apart. Keep advancing the
// active zoom ladder between events instead of repeatedly settling a gesture.
const SOURCE_WHEEL_QUIET_MS=100

/** Same native compiler/GPU/presenter, with source ownership in place of a
 * whole JS document. Tiles and camera submissions stay outside React state. */
export function NativeSourceSurface(props:Props){
  const dpr=useDevicePixelRatio()
  const profile=useMemo(()=>props.source&&canvasSamplingProfile(renderExecutionPolicy,props.source.rasterProfile,backendPreference(),props.source.colorManaged),[props.source?.rasterProfile,props.source?.colorManaged])
  const priorityWindow=useRef<ReturnType<typeof sourceOverviewWindow>>(undefined)
  const crop=profile==='figmaSubpixel'&&props.source?.colorManaged?sourceOverviewWindow(props.overviewBoxes,props.view,props.width,props.height,dpr,priorityWindow.current):undefined
  priorityWindow.current=crop
  const outer=useRef<HTMLDivElement>(null)
  const handoff=useMemo(()=>new SourceOverviewHandoff(),[])
  const host=useRef<HTMLDivElement>(null),latest=useRef(props),wake=useRef<()=>void>(()=>{})
  const mounted=useRef(false),parked=useRef<{client:KernelClient;owner:string}|undefined>(undefined)
  const warming=useRef<KernelClient|undefined>(undefined)
  const outsideScope=!!props.source?.materialKeys&&props.overviewBoxes?.some(b=>b.materialKey)&&!materialRegions(props.overviewBoxes,props,dpr).length
  const park=!!props.parked||!!outsideScope
  const density=useRef(dpr);density.current=dpr;latest.current=park?{...props,parked:true}:props
  useLayoutEffect(()=>{
    mounted.current=true
    return ()=>{mounted.current=false;handoff.clear();warming.current?.dispose();warming.current=undefined;parked.current?.client.dispose();parked.current=undefined}
  },[])
  useLayoutEffect(()=>{
    if(!latest.current.source){
      if(latest.current.warm&&!warming.current&&!parked.current&&!renderExecutionPolicy.cpuOnly&&!renderExecutionPolicy.hdrCompositing&&backendPreference()!=='webgl2'){
        const client=new KernelClient();warming.current=client
        void client.prepareSourceDisplay().catch(()=>{if(warming.current===client){warming.current=undefined;client.dispose()}})
      }
      return
    }
    if(latest.current.width<=0||latest.current.height<=0)return
    const source=latest.current.source,owner=JSON.stringify([source.owner,source.revision,source.rasterProfile,source.colorManaged])
    if(parked.current&&parked.current.owner!==owner){parked.current.client.dispose();parked.current=undefined}
    const client=parked.current?.client??warming.current??new KernelClient(),element=document.createElement('canvas'),badge=document.createElement('span')
    parked.current=undefined;warming.current=undefined
    const diagnostics=createRenderDiagnostics({enabled:window.coreDesktop?.renderDiagnostics===true,session:Math.floor(Math.random()*1e12),sink:record=>console.log(PREFIX+JSON.stringify(record))})
    const profile=canvasSamplingProfile(renderExecutionPolicy,source.rasterProfile,backendPreference(),source.colorManaged)
    const overviewMode=!!latest.current.overviewBoxes
    const planner=new SourceViewportPlanner(profile,source.colorManaged,!!source.materialKeys,overviewMode)
    const quality=new SourceQualityLadder()
    let overview: ReturnType<typeof navigationOverview>
    element.className='kernel-compositor native-source-content'
    element.setAttribute('aria-label','全源画板')
    Object.assign(element.style,{position:'absolute',inset:'0',pointerEvents:'none'})
    host.current!.append(element)
    const bitmapContext=renderExecutionPolicy.cpuOnly ? null : atomicPresentationContext(element)
    const projection=new CameraReprojection(element,host.current!,()=>schedulePaint())
    projection.history.bind(source)
    let backing:ResidentAcknowledgement|undefined,completeBacking:ResidentAcknowledgement|undefined
    let shownMaterials:readonly OverviewMaterial[]|undefined
    let partialMaterials:readonly OverviewMaterial[]|undefined
    let startupPreview: {scale:number} | undefined
    const project=()=>{
      const p=latest.current
      if (startupPreview && !backing) {
        // The host PNG occupies the ordinary display canvas until its first
        // worker bitmap. Only real GPU acknowledgements can mark it ready.
        const zoom=p.view.zoom/startupPreview.scale
        element.style.width=element.width*zoom+'px'
        element.style.height=element.height*zoom+'px'
        element.style.transformOrigin='0 0'
        element.style.transform='translate('+(p.view.x+source.bounds.x*p.view.zoom)+'px,'+(p.view.y+source.bounds.y*p.view.zoom)+'px)'
        return {active:true,changed:true}
      }
      return projection.update(backing,p.view,p.width,p.height,!!bitmapContext,source.bounds,
        !!backing && !!p.underlay?.current?.(p.view,p.width,p.height))
    }
    badge.className='kernel-status';badge.setAttribute('role','status');badge.setAttribute('aria-label','完整画板显示状态')
    Object.assign(badge.style,{position:'absolute',right:'14px',top:'var(--kernel-status-top, 12px)',fontSize:'11px',color:'#7b8190',zIndex:'5'})
    outer.current!.append(badge)
    const prefix=crypto.randomUUID(),cache=new Map<string,Tile>(),retired=new Map<number,number>()
    // A displayed bitmap can outlive evicted GPU tiles. Its geometry remains
    // needed to prove the next zoom frame preserves all visible detail.
    const submittedPlacements=new Map<number,{tiles:Placement[];wheel:boolean;outward:boolean;mixed:boolean;regions?:OverviewMaterial[];view:CanvasCamera;width:number;height:number;dpr:number}>()
    const recentNative=new Map<number,Set<string>>()
    const returnReuse=import.meta.env.VITE_DESIGN_SOURCE_RETURN_REUSE!=='0'
    let deferredOutward='',wheelInterval=SOURCE_WHEEL_QUIET_MS
    let backingTiles:Placement[]=[]
    let alive=true,initialized=false,running=false,failed=false,frameHandle=0,idleTimer:ReturnType<typeof setTimeout>|undefined
    let rejectedCamera:CanvasCamera|undefined
    let prefetchReady=''
    let seededOverview=false, nativeTileMs=0, lastInputAt=performance.now(), optionalNotBefore=0
    let optionalTimer:ReturnType<typeof setTimeout>|undefined
    let previewRequested=false, previewGeneration=0, previewTimer: ReturnType<typeof setTimeout> | undefined
    const skippedPrefetch=new Set<string>()
    const poseKey=()=>{const p=latest.current;return [p.view.x,p.view.y,p.view.zoom,p.width,p.height,density.current].join('/')}
    let qualityPose=poseKey()
    const demandKey=()=>[poseKey(),moving,quality.scale].join('/')
    let suspended=document.visibilityState==='hidden'
    let moving=false,serial=0,submission=0,acknowledged=0,tick=0,lastStatus='',lastStatusAt=-Infinity
    let lastZoom=latest.current.view.zoom,zoomingIn=false,lastZoomAt=-Infinity,continuousZoom=false
    let priorView=latest.current.view,panHeld=!!latest.current.panGestureActive
    const workQueue=new SourceRenderWork<RasterTile>(overviewMode?8:SOURCE_PIPELINE_TILES)
    let wanted:{id:string;sequence:number;view:CanvasCamera;width:number;height:number;dpr:number;scale:number;complete:boolean;mixed:boolean;demand:string;ids:Set<number>}|undefined
    const hover=latest.current.hover
    const pick:NonNullable<import('../source-hover-detail').SourceHoverHub['pick']>=(item,point,zoom,deep)=>{
      const p=latest.current
      const allowed=alive&&initialized&&p.source?.token===source.token&&!p.parked&&!p.hidden&&!p.panGestureActive&&!moving&&
        (!!backing||renderExecutionPolicy.cpuOnly)&&zoom===p.view.zoom&&
        (!source.materialKeys||source.materialKeys.includes(item.key))&&(!shownMaterials||shownMaterials.some(m=>m.materialKey===item.key))
      if(!allowed)return
      return client.pickSource(source.token,{documentId:source.owner.documentId,stageId:source.stageId,rootId:item.id,point,zoom,deep})
    }
    if(hover){hover.pick=pick;hover.refresh?.()}
    const emit=(status:NativeSourceStatus)=>{
      if(!alive)return
      const signature=`${status.phase}/${status.done}/${status.total}/${status.error??''}`,now=performance.now()
      // A single visible decoded board is enough to keep routine status quiet.
      // Reprojection and final receipts separately require full coverage.
      const p=latest.current
      badge.style.opacity=p.overviewBoxes&&status.phase!=='error'&&status.phase!=='limited'&&
        (backing||p.underlay?.current?.(p.view,p.width,p.height,'any'))?'0':''
      if(signature===lastStatus)return
      if(status.phase==='refining'&&lastStatus.startsWith('refining/')&&now-lastStatusAt<120)return
      lastStatus=signature;lastStatusAt=now
      const cpu=renderExecutionPolicy.cpuOnly
      badge.textContent=status.phase==='ready'?(source.openingMaterial!==undefined?'素材清晰 · 源文件仍在索引':cpu?'CPU · 已显示':'WebGPU · 清晰'):status.phase==='limited'?'当前倍率为预览精度':status.phase==='error'?'画板绘制未完成':status.phase==='loading'?'正在准备完整画板…':`正在绘制 ${status.done} / ${status.total}`
      badge.title=status.error??'当前视口完成全部瓦片与采样密度校验后显示清晰'
      diagnostics.record('viewport-state',{state:status.phase==='loading'?0:status.phase==='refining'?1:status.phase==='ready'?2:3,
        previewTiles:status.done,count:status.total,zoom:latest.current.view.zoom,dpr:density.current,
        width:latest.current.width,height:latest.current.height,sceneReady:initialized?1:0,finalComplete:status.phase==='ready'?1:0})
      if(status.phase==='ready'||status.phase==='error')diagnostics.flush()
      latest.current.onStatus?.(status)
      if(status.phase==='ready')hover?.refresh?.()
    }
    const fail=(error:unknown)=>{
      failed=true
      previewGeneration++;previewRequested=false;clearTimeout(previewTimer)
      const message=error instanceof Error?error.message:String(error)
      rejectedCamera=sourceRasterLimit(error)||/Invalid tile request|Invalid GPU (tile )?viewport|Invalid canvas raster density|Invalid Figma raster options|Figma sampling exceeds/.test(message)
        ?{...latest.current.view}:undefined
      emit({phase:'error',done:0,total:0,error:message})
    }
    const plan=(motion=moving)=>{
      const p=latest.current
      const planned=planner.plan(p.view,density.current,p.width,p.height,motion,quality.scale,continuousZoom,priorityWindow.current)
      if(source.viewportSubset&&p.overviewBoxes?.length&&planned.exact&&quality.scale===undefined&&
        source.colorManaged&&profile==='figmaSubpixel'&&planned.raster.scale<=1){
        const focus=focalMaterialTiles(p.overviewBoxes,p,density.current,planned.raster.phase)
        if(focus)return {...planned,p,tiles:focus,keys:new Set(focus.map(t=>t.key)),prefetch:[],prefetchKeys:new Set<string>(),focal:true}
      }
      return {...planned,p,focal:false}
    }
    const outwardCover=()=>source.materialKeys&&source.colorManaged&&profile==='figmaSubpixel'&&moving&&continuousZoom&&!zoomingIn&&backing&&bitmapContext&&
      deferredOutward!==demandKey()
      ?retainedZoomOut(cache.values(),latest.current.view,latest.current,density.current,backing.view.zoom*density.current>=8):undefined
    const requestOverview = async () => {
      const bridge = desktopBridge()?.largeDocument
      if (source.materialKeys || !alive || failed || previewRequested || !bitmapContext || !bridge?.canvasPreview || source.nodes<20000) return
      const generation=previewGeneration
      previewRequested = true
      try {
        const result = await bridge.canvasPreview({owner:source.owner,expectedRevision:source.revision,token:source.token})
        if (!alive || failed || generation!==previewGeneration) return
        if (result.status !== 'ok') return
        if (result.phase === 'pending') {
          previewTimer = setTimeout(()=>{ previewRequested=false; if(alive) void requestOverview() },250)
        } else if (result.phase === 'ready') {
          const bytes = Uint8Array.from(atob(result.png),c=>c.charCodeAt(0))
          const bitmap = await createImageBitmap(new Blob([bytes],{type:'image/png'}))
          try {
            if (!alive || failed || generation!==previewGeneration || bitmap.width!==result.width || bitmap.height!==result.height) return
            if (!backing) {
              consumePresentationBitmap(bitmapContext,element,bitmap)
              startupPreview={scale:result.scale}
              project()
              element.dataset.sourcePreview='overview'
              badge.textContent='源文件预览 · 正在精修'
            } else if (projection.history.seed(source,source.bounds,bitmap,result.scale)) {
              seededOverview=true
              project(); schedulePaint()
            } else previewRequested=false
          } finally { bitmap.close() }
        }
      } catch { /* A failed optional thumbnail leaves native tile rendering available. */ }
    }
    void requestOverview()
    const release=()=>{
      const ids:number[]=[]
      for(const[id,after]of retired)if(after<=acknowledged){ids.push(id);retired.delete(id)}
      client.releasePresented(ids)

    }
    const retire=(tile:Tile)=>{
      tile.bitmap?.close()
      if([...cache.values()].some(other=>other!==tile&&other.gpuTile===tile.gpuTile))return
      if(tile.gpuTile)retired.set(tile.gpuTile,Math.max(retired.get(tile.gpuTile)??0,tile.lastSubmission))
    }
    const cpuRepairs = new Set<string>()
    let repairDemand = '', repairTimer: ReturnType<typeof setTimeout> | undefined
    let cpuScratch: HTMLCanvasElement | undefined
    let cpuContext:CanvasRenderingContext2D|null=null
    if(renderExecutionPolicy.cpuOnly){
      try{cpuContext=element.getContext('2d',{alpha:false})||element.getContext('2d')}catch{cpuContext=null}
    }
    const paintCpu=()=>{
      const {p,tiles,exact}=plan()
      if (!cpuContext) throw Error('CPU 显示画布不可用')
      const dpr=density.current
      const pixelWidth=Math.max(1,Math.ceil(p.width*dpr)),pixelHeight=Math.max(1,Math.ceil(p.height*dpr))
      if(cpuContext&&(element.width!==pixelWidth||element.height!==pixelHeight)){element.width=pixelWidth;element.height=pixelHeight}
      if(cpuContext){
        cpuContext.setTransform(1,0,0,1,0,0)
        cpuContext.fillStyle='#ffffff'
        cpuContext.fillRect(0,0,element.width,element.height)
        const visible=[...cache.values()].filter(tile=>tile.cpuDivisor!==0 && tileIntersectsView(tile,p.view,p))
          .sort((a,b)=>a.zoom/(a.cpuDivisor||1)-b.zoom/(b.cpuDivisor||1)||a.used-b.used)
        for(const tile of visible){
          tile.used=++tick
          const place=tilePlacementAtView(tile,p.view), divisor=tile.cpuDivisor || 1
          const dx=place.left*dpr,dy=place.top*dpr,dw=place.width*dpr,dh=place.height*dpr
          const sw=tile.width/divisor,sh=tile.height/divisor
          if(tile.bitmap)cpuContext.drawImage(tile.bitmap,0,0,sw,sh,dx,dy,dw,dh)
          else if(tile.bytes?.length===Math.ceil(sw)*Math.ceil(sh)*4){
            const iw=Math.ceil(sw), ih=Math.ceil(sh)
            const pixels=new ImageData(new Uint8ClampedArray(tile.bytes),iw,ih)
            if (divisor===1 && Math.abs(dw-iw)<0.5 && Math.abs(dh-ih)<0.5) {
              const origin=cpuTileBlitOrigin(dx,dy)
              cpuContext.putImageData(pixels,origin.x,origin.y)
              continue
            }
            cpuScratch ??= document.createElement('canvas')
            cpuScratch.width=iw;cpuScratch.height=ih
            const ctx=cpuScratch.getContext('2d')
            if (!ctx) throw Error('CPU 瓦片不可用')
            ctx.putImageData(pixels,0,0)
            cpuContext.drawImage(cpuScratch,0,0,sw,sh,dx,dy,dw,dh)
          }
        }
      }
      const keys=new Set(tiles.map(tile=>tile.key))
      const keep=Math.max(32,tiles.length*3)
      for(const tile of [...cache.values()].sort((a,b)=>a.used-b.used)){
        if(cache.size<=keep)break
        if(keys.has(tile.key) || overview?.tiles.some(base=>base.key===tile.key))continue
        cache.delete(tile.key);retire(tile)
      }
      const done=tiles.filter(tile=>cache.has(tile.key) && (cache.get(tile.key)?.cpuDivisor ?? 1)===1).length
      const complete=exact && done===tiles.length && tiles.length>0
      emit(complete?{phase:'ready',done,total:tiles.length}:{phase:'refining',done,total:tiles.length})
      if (!moving && !complete && done<tiles.length && tiles.every(tile=>cache.has(tile.key)) && repairDemand!==demandKey()) {
        clearTimeout(repairTimer)
        repairDemand=demandKey()
        repairTimer=setTimeout(()=>{
          if (!alive || suspended || moving || repairDemand!==demandKey()) return
          for(const tile of tiles) if ((cache.get(tile.key)?.cpuDivisor ?? 1)!==1) cpuRepairs.add(tile.key)
          void run()
        },180)
      }
    }
    const paint=()=>{
      frameHandle=0
      if(!alive||!initialized||failed||suspended||latest.current.parked)return
      if(renderExecutionPolicy.cpuOnly){try{paintCpu()}catch(error){fail(error)};return}
      try{
        const {p,ratio,tiles,keys,exact,raster,focal}=plan(),done=tiles.filter(tile=>cache.has(tile.key)).length
        const complete=done===tiles.length&&exact&&!focal
        if(window.coreDesktop?.renderDiagnostics){
          element.dataset.sourceDemandScale=String(raster.scale)
          element.dataset.sourceDemandZoom=String(p.view.zoom)
          element.dataset.sourceMoving=String(moving)
        }
        project()
        // This is an evictable history allowance, never a source-size refusal.
        const keep=Math.max(32,tiles.length*3)
        const preferLast=import.meta.env.VITE_DESIGN_SOURCE_RETURN_PRIORITY!=='0' && moving &&
          !!p.overviewBoxes && !!source.materialKeys && raster.scale<=1
        const wider=returnReuse&&p.view.zoom*density.current>=2
          ?[...recentNative].sort((a,b)=>a[0]-b[0])[0]?.[1]:undefined
        for(const tile of cache.size>keep?sourceTileRetirement(cache.values(),recentNative.values(),preferLast,wider):[]){
          if(cache.size<=keep)break
          if(keys.has(tile.key) || overview?.tiles.some(base=>base.key===tile.key))continue
          cache.delete(tile.key);retire(tile)
        }
        release()
        const wheel=!!(source.materialKeys && backing && !partialMaterials && bitmapContext && quality.scale===undefined &&
          (moving&&continuousZoom&&zoomingIn || overviewMode&&exact&&p.view.zoom>=backing.view.zoom))
        const refining=done<tiles.length
        // A zoom-out can already be covered by the native return
        // cohort plus newly arrived edge tiles. Present that complete mosaic
        // while the current phase refines; its receipt stays preview-only.
        const returned=returnReuse&&refining&&source.materialKeys&&backing&&bitmapContext&&!partialMaterials&&
          !zoomingIn&&backing.view.zoom>p.view.zoom&&quality.scale===undefined
          ?retainedSourceReturn(cache.values(),p.view,p,ratio,p.view.zoom*ratio>=8):undefined
        // A zoom-out must not wait for the whole target lattice. Publish the
        // coarse overview together with any sharper residents as soon as that
        // union covers the viewport; until then the previous image stays.
        const continuityCover=()=>{
          const shown=backing
          if(!bitmapContext||!shown||zoomingIn||!moving)return
          const resident=[...cache.values()].filter(tile=>tile.gpuTile&&tile.placement)
          const stack=selectCoverageStack(resident,p.view,p,48)
          if(!stack?.some(tile=>tile.zoom+1e-9<shown.view.zoom*shown.dpr))return
          return stack
        }
        const stored=refining?outwardCover()??returned??continuityCover():undefined
        let visible:Tile[],partialTiles:Tile[]|undefined,regions:OverviewMaterial[]|undefined
        if((refining||focal)&&done&&exact&&p.overviewBoxes?.length&&bitmapContext&&(!backing||partialMaterials||focal)){
          const ready=tiles.flatMap(tile=>{const entry=cache.get(tile.key);return entry?[entry]:[]})
          const certified=completeMaterialRegions(materialRegions(p.overviewBoxes,p,ratio),ready,raster.scale)
          if(certified.length&&retainsVisibleMaterials(partialMaterials,certified,p,ratio)){
            regions=certified.map(r=>r.material);partialTiles=ready
          }
        }
        if(focal&&!partialTiles){emit({phase:'refining',done,total:tiles.length});return}
        if(partialTiles){visible=partialTiles}
        else if(stored){visible=stored}
        else if(refining && wheel){
          // An immutable lower rung can cover the rest of the new viewport.
          // Submit only a complete mosaic with genuinely sharper source pixels.
          const mosaic=coveredSourceDetail(cache.values(),p,backingTiles,p.view.zoom*ratio>=8)
          if(!mosaic){emit({phase:'refining',done,total:tiles.length});return}
          visible=mosaic
        }else{
          if(!tiles.length || refining){emit({phase:'refining',done,total:tiles.length});return}
          visible=tiles.map(tile=>cache.get(tile.key)!)
        }
        const demand=demandKey(), ids=new Set(visible.map(tile=>tile.gpuTile!))
        const previous=wanted
        if(regions&&previous?.demand===demand){
          const last=submittedPlacements.get(previous.sequence)?.regions??partialMaterials
          if(last&&last.length===regions.length&&last.every(old=>regions!.some(r=>r.materialKey===old.materialKey)))return
        }
        if(previous?.demand===demand && previous.complete===complete && previous.mixed===refining && previous.scale===raster.scale &&
            previous.ids.size===ids.size && [...ids].every(tile=>previous.ids.has(tile)))return
        const sequence=++submission,id=`${prefix}:${sequence}`
        for(const tile of visible){tile.lastSubmission=sequence;tile.used=++tick}
        submittedPlacements.set(sequence,{tiles:visible.map(t=>t.placement!),wheel,outward:!!stored,mixed:refining,regions,view:{...p.view},width:p.width,height:p.height,dpr:ratio})
        if(submittedPlacements.size>32)submittedPlacements.delete(submittedPlacements.keys().next().value!)
        const items:ResidentFrame['items']=visible.map(tile=>({active:true,layer:exact&&keys.has(tile.key)?4:1,
          tile:{key:tile.key,serial:tile.serial,gpuTile:tile.gpuTile!,x:tile.x,y:tile.y,width:tile.width,height:tile.height,zoom:tile.zoom,phaseX:tile.phaseX,phaseY:tile.phaseY}}))
        wanted={id,sequence,view:{...p.view},width:p.width,height:p.height,dpr:ratio,scale:raster.scale,complete,mixed:refining,demand,ids}
        // The presenter independently checks actual textures and physical coverage.
        emit({phase:'refining',done,total:tiles.length})
        client.present({presentationId:id,view:p.view,width:p.width,height:p.height,dpr:ratio,items,allowBackground:!refining,...(regions?{cameraPreview:{anchor:visible[0].gpuTile!}}:{})})
      }catch(error){fail(error)}
    }
    const schedulePaint=()=>{if(alive&&!frameHandle)frameHandle=requestAnimationFrame(paint)}
    const receive=(tile:TileResult)=>{
      if(!alive){tile.bitmap?.close();if(tile.gpuTile)client.releasePresented([tile.gpuTile]);return}
      if(tile.gpuTile==null&&!(renderExecutionPolicy.cpuOnly&&(tile.bitmap||tile.bytes?.length||tile.cpuDivisor===0))){tile.bitmap?.close();throw Error('完整源画布尚未取得 GPU 显示纹理')}
      const {key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}=tile
      const placement=gpuTile==null?undefined:{key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}
      const old=cache.get(tile.key)
      const sameGpu=old!=null&&old.gpuTile!=null&&old.gpuTile===tile.gpuTile
      if(old&&!sameGpu)retire(old)
      if(tile.gpuTile!=null)retired.delete(tile.gpuTile)
      cache.set(tile.key,{...tile,placement,serial:sameGpu&&old?old.serial:++serial,used:++tick,lastSubmission:sameGpu&&old?old.lastSubmission:0})
      if(!tile.prefetch && plan().tiles.every(t=>cache.has(t.key))){
        cancelAnimationFrame(frameHandle)
        paint()
      }else if(!tile.prefetch || tileIntersectsView(tile,latest.current.view,latest.current))schedulePaint()
    }
    const updateWorkDemand=()=>{
      if(workQueue.current?.pending.size){
        const next=plan()
        // Returning to an exact, fully resident viewport leaves no missing
        // pixel for this batch to repair. Its old density may still be within
        // the ordinary 2x reuse window, but finishing it only delays later
        // input. Cancel preview work without retiring any accepted texture.
        const covered=next.exact&&next.tiles.every(tile=>cache.has(tile.key) && (cache.get(tile.key)?.cpuDivisor ?? 1)===1)
        // Completed tiles no longer hold the batch's camera lease. Cancel if
        // either remaining tile would delay the current viewport with old work.
        const optional=[...workQueue.current.pending.values()].every(tile=>tile.prefetch===true)
        const missing=next.tiles.some(tile=>!cache.has(tile.key))
        workQueue.demand(covered&&!optional,tile=>{
          if(overview?.tiles.some(base=>base.key===tile.key))return !moving && !missing
          if(tile.prefetch)return next.keys.has(tile.key)||!missing&&next.prefetchKeys.has(tile.key)
          return retainInFlightTile(tile,next.p.view,next.p,cache.values(),next.keys,next.prefetchKeys,zoomingIn&&continuousZoom,next.raster.scale)
        })
      }
    }
    const run=async()=>{
      if(!alive||!initialized||running||failed||suspended||latest.current.parked)return
      running=true
      try{
        while(alive&&!failed&&!suspended&&!latest.current.parked){
          const {p,ratio,raster,tiles,prefetch}=plan(),missing=tiles.filter(tile=>!cache.has(tile.key)||cpuRepairs.has(tile.key))
          const optional=missing.length===0
          if(!optional&&outwardCover()){schedulePaint();break}
          if(optional && source.materialKeys && (moving||!prefetch.length))break
          if(optional&&prefetchReady!==demandKey()){schedulePaint();break}
          // We already have real pixels for this entire source. An expensive
          // optional overview cannot fill another hole. Give the next input
          // first use of the raster owner before warming native neighbours.
          const costlyOverview = seededOverview && projection.history.completeFrame && nativeTileMs > SOURCE_QUIET_MS
          if (optional) {
            const nextOptional = Math.max(optionalNotBefore, source.materialKeys ? lastInputAt+200 : 0, costlyOverview ? lastInputAt+Math.min(nativeTileMs,1000) : 0)
            const wait = nextOptional-performance.now()
            if (wait > 0) {
              clearTimeout(optionalTimer)
              optionalTimer=setTimeout(()=>{ if(alive && !suspended) void run() },Math.ceil(wait))
              break
            }
          }
          if (optional && !source.materialKeys && !costlyOverview && !moving && !overview) overview = navigationOverview(source.bounds,1,source.nodes)
          const warmBase = optional && !costlyOverview && !moving && overview ? overviewWarmBatch(overview.tiles,p.view,p.width,p.height,
            tile=>!cache.has(tile.key) && !skippedPrefetch.has(tile.key)) : undefined
          const candidates=warmBase?.length ? warmBase.map(tile=>({...tile,prefetch:true as const})) :
            optional?prefetch.filter(tile=>!cache.has(tile.key)&&!skippedPrefetch.has(tile.key)):missing
          if(!candidates.length)break
          // The full visible cohort shares the bounded preparation pipeline,
          // including inward zoom. There is still a single raster owner.
          const ordered=p.overviewBoxes?.length&&!optional&&raster.scale===p.view.zoom*ratio?
            orderMaterialTiles(candidates,materialRegions(p.overviewBoxes,p,ratio),planner.focus(p.view,p.width,p.height)):candidates
          // Newly exposed world comes first. The centre can keep its sharper
          // residents; waiting for it before the margin is what leaves a blank band.
          const holeFirst=!optional&&moving&&continuousZoom&&!zoomingIn
            ?prioritizeUncoveredTiles(ordered,[...cache.values()],{x:-p.view.x/p.view.zoom,y:-p.view.y/p.view.zoom,width:p.width/p.view.zoom,height:p.height/p.view.zoom})
            :ordered
          // A settled overview can stream its visible cohort in one request.
          // The worker still prepares just one tile ahead of its GPU raster.
          const limit=overviewMode&&!optional&&!moving&&raster.scale<=1?8:SOURCE_PIPELINE_TILES
          const batch=holeFirst.slice(0,source.materialKeys && moving && zoomingIn && continuousZoom && backing ? 1 : limit)
          diagnostics.record('cache',{count:batch.length,prefetch:optional?1:0,reasonCode:optional?7:5})
          const work=workQueue.begin(batch,limit)
          const camera = warmBase && overview ? overview.view : raster.camera
          const batchStarted=performance.now()
          try{
            await client.renderSource(source,{pageId:source.pageId,width:Math.ceil(p.width*ratio),height:Math.ceil(p.height*ratio),
              view:camera,transparent:false,grid:false,rasterProfile:profile,
              sourceMaterialOverview:overviewMode||undefined,tileViewport:batch,tilePrepareViewport:tileBatchPrepareViewport(optional||source.materialKeys&&moving&&zoomingIn&&continuousZoom?[]:tiles,[],batch,camera),renderIntent:'preview',
              tileOwner:{documentId:source.owner.documentId,sessionEpoch:source.owner.sessionEpoch}},tile=>{
                // Stage each accepted tile while the rest of its viewport is being drawn.
                if(!alive||!workQueue.accepts(work,tile.key)){
                  tile.bitmap?.close()
                  if(tile.gpuTile&&![...cache.values()].some(value=>value.gpuTile===tile.gpuTile))client.releasePresented([tile.gpuTile])
                  return
                }
                receive(tile);cpuRepairs.delete(tile.key);workQueue.delivered(work,tile.key);updateWorkDemand()
              },work.controller.signal)
            if (!optional && !moving && !work.pending.size) {
              const elapsed=(performance.now()-batchStarted)/batch.length
              nativeTileMs=nativeTileMs ? .5*(nativeTileMs+elapsed) : elapsed
            }
          }catch(error){
            if(work.controller.signal.aborted||String(error).includes('PREVIEW_CANCELLED'))continue
            if(!optional&&sourceRasterLimit(error)&&batch.some(t=>t.width>514||t.height>514)&&qualityPose===poseKey()&&
                planner.retryNativeCoverage(p.view,ratio,p.width,p.height)){
              work.controller.abort();schedulePaint();continue
            }
            if(!optional && qualityPose===poseKey() && quality.rejected(raster.scale,error)){
              work.controller.abort();schedulePaint();continue
            }
            if(optional&&/budget|memory|内存|表面.*超限/i.test(String(error))){
              for(const tile of batch)skippedPrefetch.add(tile.key)
              continue
            }
            throw error
          }finally{workQueue.release(work)}
          if(work.pending.size){
            if(!optional && !warmBase)throw Error('源画板瓦片未返回，已保留当前画面')
            for(const key of work.pending.keys())skippedPrefetch.add(key)
          }
          // Rejections stay bounded to this revision's current warm set.
          if(skippedPrefetch.size>32)for(const key of skippedPrefetch)if(!plan().prefetchKeys.has(key) && !overview?.tiles.some(tile=>tile.key===key))skippedPrefetch.delete(key)
          // Yield host bookkeeping; native preparation and GPU work already
          // use their existing independent threads and bounded task queues.
          if(optional) await new Promise<void>(resolve=>setTimeout(resolve,0))
        }
      }catch(error){if(alive)fail(error)}finally{running=false}
    }
    client.onPresentation=stats=>{
      const bitmap=stats.bitmap as ImageBitmap|undefined
      let bitmapApplied=false
      try {
      if(!alive||failed)return
      const submitted=stats.presented as ResidentAcknowledgement|undefined
      if(submitted?.presentationId&&!submitted.presentationId.startsWith(prefix+':'))return
      if(!initialized)return
      if(stats.error){projection.history.bind(undefined);seededOverview=false;fail(stats.error);return}
      if(Array.isArray(stats.missingGpuTiles)){
        const missing=new Set(stats.missingGpuTiles)
        for(const[key,tile]of cache)if(missing.has(tile.gpuTile)){cache.delete(key);retire(tile)}
        if(wanted && [...wanted.ids].some(id=>missing.has(id)))wanted=undefined
        release();void run()
      }
      if(wanted && stats.coverageDeferredPresentationId===wanted.id && submittedPlacements.get(wanted.sequence)?.outward){
        deferredOutward=wanted.demand;wanted=undefined;schedulePaint();void run()
      }
      if(wanted && !wanted.mixed && stats.coverageDeferredPresentationId===wanted.id && wanted.demand===demandKey() && !stats.missingTextureCount){
        const p=latest.current
        if(planner.retryNativeCoverage(p.view,density.current,p.width,p.height)){
          wanted=undefined
          schedulePaint();void run()
        }else{
          const total=plan().tiles.length
          emit({phase:'limited',done:total,total,error:'当前视口未获得完整像素覆盖'})
        }
      }
      const actual=stats.presented as ResidentAcknowledgement|undefined
      if(!actual?.presentationId?.startsWith(prefix+':'))return
      const sequence=Number(actual.presentationId.slice(prefix.length+1))
      if(!Number.isSafeInteger(sequence)||sequence<=0||sequence>submission||sequence<acknowledged)return
      project()
      const ids=new Set(actual.ids),sent=submittedPlacements.get(sequence)
      const shownTiles=(sent?.tiles??[]).filter(t=>ids.has(t.gpuTile))
      const expected=wanted,p=latest.current
      const current=expected&&actual.presentationId===expected.id&&
        actual.view.x===expected.view.x&&actual.view.y===expected.view.y&&actual.view.zoom===expected.view.zoom&&
        actual.width===expected.width&&actual.height===expected.height&&actual.dpr===expected.dpr&&
        actual.view.x===p.view.x&&actual.view.y===p.view.y&&actual.view.zoom===p.view.zoom&&
        actual.width===p.width&&actual.height===p.height&&actual.dpr===density.current&&expected.demand===demandKey()
      const allIds=current&&[...expected.ids].every(id=>ids.has(id))
      const terminal=allIds&&expected.complete&&!actual.preview
      if(current&&expected.complete&&!terminal&&planner.retryNativeCoverage(p.view,actual.dpr,p.width,p.height)){
        // Coverage is checked by the presenter. Keep the displayed bitmap
        // and retry even when this incomplete handoff itself is declined.
        if(window.coreDesktop?.renderDiagnostics)element.dataset.sourceCoverageRepair=String(sequence)
        wanted=undefined; schedulePaint();void run()
      }
      // An ACK can retire resources even when its obsolete or incomplete bitmap
      // cannot replace the image on screen. Leave the displayed camera intact.
      acknowledged=sequence
      for(const id of submittedPlacements.keys())if(id<=sequence)submittedPlacements.delete(id)
      release()
      if(p.parked)return
      const wheelAdvance=sent?.wheel && (moving&&continuousZoom&&zoomingIn || overviewMode&&current) && !actual.preview &&
        bitmap && bitmapContext && sent.tiles.length===shownTiles.length &&
        actual.view.x===sent.view.x && actual.view.y===sent.view.y && actual.view.zoom===sent.view.zoom &&
        actual.width===sent.width && actual.height===sent.height && actual.dpr===sent.dpr &&
        improvesSourceZoom(backing,actual,p,shownTiles,backingTiles)
      const outwardAdvance=sent?.outward && current && allIds && bitmap && bitmapContext && sent.tiles.length===shownTiles.length
      const planned=sent?.regions
      const accepted=planned&&current&&bitmap&&bitmapContext&&(!actual.preview||actual.previewGaps)&&
        completeMaterialRegions(materialRegions(planned,p,actual.dpr),shownTiles,actual.view.zoom*actual.dpr,actual.previewGaps)
      const regional=!!(accepted&&accepted.length===planned?.length&&retainsVisibleMaterials(partialMaterials,accepted,p,actual.dpr))
      if((actual.preview&&!regional) || ((sent?.mixed || !current || !allIds) && !wheelAdvance && !outwardAdvance && !regional)){
        if(wanted?.id===actual.presentationId)wanted=undefined
        return
      }
      if (bitmap && bitmapContext && startupPreview) {
        seededOverview=projection.history.seed(source,source.bounds,element,startupPreview.scale,actual)
        if (!seededOverview) previewRequested=false
        startupPreview=undefined
        delete element.dataset.sourcePreview
      }
      if(bitmap&&bitmapContext){
        if(terminal&&!source.viewportSubset)handoff.clear()
        completeBacking=terminal&&!source.viewportSubset?actual:undefined
        partialMaterials=regional?planned:undefined
        element.style.clipPath=partialMaterials?sourcePageClip(partialMaterials,actual.view,actual.width,actual.height)??'':''
        consumePresentationBitmap(bitmapContext,element,bitmap);bitmapApplied=true
        shownMaterials=partialMaterials??latest.current.overviewBoxes
        if(!regional)projection.history.capture(element,actual,source.bounds)
        if(window.coreDesktop?.renderDiagnostics){
          if(partialMaterials){
            element.dataset.sourceRegionalMaterials=JSON.stringify(partialMaterials.map(r=>r.materialKey))
            element.dataset.sourceRegionalBounds=JSON.stringify(partialMaterials.map(({x,y,width,height})=>({x,y,width,height})))
          }else{
            delete element.dataset.sourceRegionalMaterials
            delete element.dataset.sourceRegionalBounds
          }
        }
      }
      if(bitmapApplied){
        const p=latest.current
        const newlyVisible=shownTiles.filter(t=>!backingTiles.some(old=>old.gpuTile===t.gpuTile&&old.key===t.key)&&
          tileIntersectsView(t,actual.view,actual)&&tileIntersectsView(t,p.view,p))
        const scale=Math.max(0,...newlyVisible.map(t=>t.zoom))
        if(window.coreDesktop?.renderDiagnostics){
          element.dataset.sourceShownSequence=String(sequence)
          element.dataset.sourceShownNewScale=String(scale)
          const first=shownTiles[0]
          const mixed=shownTiles.some(t=>t.zoom!==first.zoom||(t.phaseX??0)!==(first.phaseX??0)||(t.phaseY??0)!==(first.phaseY??0))
          element.dataset.sourceShownCoverage=source.viewportSubset?'focal-preview':regional?'material-regions':mixed?'complete-mosaic':'complete-lattice'
          element.dataset.sourceBitmapScale=String(actual.view.zoom*actual.dpr)
          element.dataset.sourceMinimumTexelScale=String(Math.min(...shownTiles.map(t=>t.zoom)))
        }
        // A real tile can already be visible through camera reprojection
        // before this older submission qualifies for exact-camera readiness.
        if(moving&&zoomingIn&&continuousZoom&&actual.view.zoom<=p.view.zoom&&quality.scale===undefined&&
            scale>0&&planner.presentedDetail(Math.min(scale,p.view.zoom*density.current))){schedulePaint();void run()}
      }
      backing=actual;backingTiles=shownTiles;project()
      if(p.overviewBoxes&&!lastStatus.startsWith('error/')&&!lastStatus.startsWith('limited/'))badge.style.opacity='0'
      if (bitmapApplied && !seededOverview && actual.navigationBackingBytes===NAVIGATION_BACKING_BYTES) void requestOverview()
      if(bitmapApplied && client.copyNavigationTile) {
        const cohort = nearOverviewTiles(overview?.tiles ?? [],latest.current.view,latest.current.width,latest.current.height)
          .flatMap(tile => cache.get(tile.key) ?? [])
        projection.history.warm(source.bounds,[...cohort,...cache.values()],(id,consume)=>client.copyNavigationTile(id,consume),schedulePaint)
      }
      // An in-flight wheel ACK may cover the newer camera after reprojection.
      // It has no authority to acknowledge that newer camera's terminal state.
      if(regional&&current){
        hover?.refresh?.();latest.current.onPresented?.(actual,false)
        return
      }
      if(!current||!allIds)return
      const complete=!!terminal&&!source.viewportSubset
      if(terminal&&source.viewportSubset){
        // This snapshot covers the focal materials only. Its native pixels
        // can be shown while the host prepares the rest of the same viewport.
        planner.presented(actual.view,actual.dpr,actual.width,actual.height)
        if(window.coreDesktop?.renderDiagnostics&&shownMaterials){
          element.dataset.sourceRegionalMaterials=JSON.stringify(shownMaterials.map(r=>r.materialKey))
          element.dataset.sourceRegionalBounds=JSON.stringify(shownMaterials.map(({x,y,width,height})=>({x,y,width,height})))
          element.dataset.sourceShownCoverage='focal-preview'
        }
      }
      element.dataset.sourcePresentation=String(sequence)
      element.dataset.sourceTargetScale=String(expected.scale)
      const visibleTiles=[...cache.values()].filter(t=>actual.ids.includes(t.gpuTile!)&&tileIntersectsView(t,actual.view,actual))
      const hasRequestedDensity=visibleTiles.some(t=>t.zoom===expected.scale)
      element.dataset.sourceRenderScale=String(Math.max(0,...visibleTiles.map(t=>t.zoom)))
      element.dataset.sourceVisibleDemandScale=hasRequestedDensity?String(expected.scale):''
      if(complete){
        if(source.materialKeys){
          const scale=actual.view.zoom*actual.dpr
          const keys=new Set(shownTiles.map(t=>t.key))
          if(returnReuse)rememberSourceTier(recentNative,scale,keys)
          else{
            recentNative.delete(scale)
            if(recentNative.size>=2)recentNative.delete(recentNative.keys().next().value!)
            recentNative.set(scale,keys)
          }
        }
        quality.reset()
        element.dataset.sourceReadyCamera=JSON.stringify(actual.view)
        planner.presented(actual.view,actual.dpr,actual.width,actual.height)
        const count=plan().tiles.length;emit({phase:'ready',done:count,total:count})
      }
      if(!complete&&moving&&zoomingIn&&quality.scale===undefined&&expected.scale<actual.view.zoom*actual.dpr &&
          hasRequestedDensity&&
          planner.presentedDetail(expected.scale)){schedulePaint();void run()}
      if(terminal&&!complete)hover?.refresh?.()
      latest.current.onPresented?.(actual,complete)
      if(expected.demand===demandKey()&&quality.scale!==undefined){
        if(quality.presented(plan().raster.scale)){schedulePaint();void run()}
        else if(quality.limited){const total=plan().tiles.length;emit({phase:'limited',done:total,total,error:quality.reason})}
      }
      if(!expected.mixed&&expected.demand===demandKey()&&prefetchReady!==expected.demand){
        prefetchReady=expected.demand;void run()
      }
      }catch(error){fail(error)} finally {
        bitmap?.close()
        if(bitmap)client.acceptPresentation?.((stats.presented as ResidentAcknowledgement|undefined)?.presentationToken,bitmapApplied)
      }
    }
    wake.current=()=>{
      if(!alive)return
      if(failed){
        const view=latest.current.view
        // An invalid former camera must not poison later valid navigation.
        // Banner/viewport resize alone cannot restart a permanent failure.
        if(!initialized||!rejectedCamera||view.x===rejectedCamera.x&&view.y===rejectedCamera.y&&view.zoom===rejectedCamera.zoom)return
        failed=false;rejectedCamera=undefined;projection.history.bind(source)
      }
      if(suspended||latest.current.parked){
        if(latest.current.parked){
          wanted=undefined
          delete element.dataset.sourceReadyCamera
          emit({phase:'refining',done:0,total:0})
        }
        if(!suspended)project()
        clearTimeout(optionalTimer);clearTimeout(idleTimer);workQueue.demand(true,()=>false);return
      }
      if(qualityPose!==poseKey()){qualityPose=poseKey();quality.reset()}
      const currentView=latest.current.view,releasedPan=panHeld&&!latest.current.panGestureActive
      panHeld=!!latest.current.panGestureActive
      if(currentView.zoom!==lastZoom){
        const now=performance.now(),inward=latest.current.view.zoom>lastZoom
        wheelInterval=now-lastZoomAt
        const wheel=latest.current.wheelView, view=latest.current.view
        continuousZoom=!!wheel && wheel.x===view.x && wheel.y===view.y && wheel.zoom===view.zoom ||
          inward===zoomingIn && now-lastZoomAt<180
        zoomingIn=inward;lastZoom=latest.current.view.zoom;lastZoomAt=now
      }else if(panHeld || currentView.x!==priorView.x || currentView.y!==priorView.y){
        continuousZoom=false;zoomingIn=false
      }
      priorView=currentView
      // Estimate the physical viewport once, in world units. Zoom must not
      // multiply an already screen-sized viewport a second time.
      if(continuousZoom&&!zoomingIn){
        const outward=latest.current,full=outward.view.zoom*density.current
        const stepped=outwardInteractionScale(full,outward.width,outward.height,outward.view.zoom)
        if(stepped<full&&(quality.scale===undefined||quality.scale>stepped))quality.seed(stepped,full)
      }
      lastInputAt=performance.now();optionalNotBefore=0;clearTimeout(optionalTimer)
      moving=!releasedPan;clearTimeout(idleTimer)
      cpuRepairs.clear();clearTimeout(repairTimer)
      project()
      try{
      // Motion headroom is optional work. An already complete exact native
      // demand may present immediately, without waiting for a quiet timer or
      // replacing its pixels with a more expensive density rung.
      if(initialized&&cache.size){
        const p=latest.current
        if(backing&&zoomingIn&&continuousZoom){
          const density=visibleSourceDensity(backingTiles,p.view,p,source.bounds)
          planner.presentedDetail(density)
        }
        const native=plan(false)
        if(native.exact&&native.tiles.every(tile=>cache.has(tile.key))){
          moving=false
          // This camera has every native pixel. Cancelling obsolete work
          // must not immediately start a replacement speculative batch.
          optionalNotBefore=lastInputAt+SOURCE_QUIET_MS
        }
      }
      updateWorkDemand()
      idleTimer=moving&&!panHeld?setTimeout(()=>{
        if(!alive||failed||suspended)return
        moving=false
        quality.settle()
        try{
          const native=plan(false)
          // Preserve accepted history, but stop pending work that cannot
          // satisfy the current density/phase/owner keys. The request slot
          // still belongs to its real completion, including late GPU work.
          const missing=native.tiles.some(tile=>!cache.has(tile.key))
          // A rung four times coarser in each direction cannot satisfy this
          // settled demand. Keep the displayed frame and let obsolete work
          // leave through its normal cancellation/completion boundary.
          const coveredDetail=import.meta.env.VITE_DESIGN_SETTLED_SOURCE_PRIORITY!=='0' &&
            missing && source.materialKeys && zoomingIn && continuousZoom && native.raster.scale>1 &&
            backingCoversSettledSource(backing,native.p,density.current)
          workQueue.demand(false,tile=>!(coveredDetail && tile.prefetch!==true && tile.zoom*4<=native.raster.scale) &&
            (native.keys.has(tile.key)||!missing&&tile.prefetch===true&&native.prefetchKeys.has(tile.key)||
            retainInFlightTile(tile,native.p.view,native.p,cache.values(),native.keys,native.prefetchKeys,zoomingIn&&continuousZoom,native.raster.scale)))
          schedulePaint();void run()
        }catch(error){fail(error)}
      },continuousZoom&&lastInputAt-lastZoomAt<180?Math.min(SOURCE_WHEEL_QUIET_MS,Math.max(56,wheelInterval*2+8)):SOURCE_QUIET_MS):undefined
      schedulePaint();void run()
      }catch(error){fail(error)}
    }
    const visibility=()=>{
      suspended=document.visibilityState==='hidden'
      clearTimeout(idleTimer)
      if(suspended){workQueue.demand(true,()=>false);cancelAnimationFrame(frameHandle);frameHandle=0;return}
      moving=false;schedulePaint();void run()
    }
    document.addEventListener('visibilitychange',visibility)
    emit({phase:'loading',done:0,total:0})
    void (async()=>{
      try{
        const p=latest.current
        await client.renderSource(source,{pageId:source.pageId,width:Math.ceil(p.width*density.current),height:Math.ceil(p.height*density.current),
          view:{x:0,y:0,zoom:p.view.zoom*density.current},transparent:false,grid:false,rasterProfile:profile,tileViewport:[],renderIntent:'canvas'})
        if(!alive)return
        if(!renderExecutionPolicy.cpuOnly)client.attachPresentation(bitmapContext?new OffscreenCanvas(1,1):element.transferControlToOffscreen(),!!bitmapContext)
        initialized=true;void run()
      }catch(error){if(alive)fail(error)}
    })()
    return()=>{
      alive=false;wake.current=()=>{}
      if(hover&&hover.pick===pick){delete hover.pick;hover.refresh?.()}
      const settled=mounted.current&&!!bitmapContext&&!!source.materialKeys&&initialized&&!failed&&
        !workQueue.current?.pending.size&&acknowledged===submission&&lastStatus.startsWith('ready/')
      workQueue.close();document.removeEventListener('visibilitychange',visibility)
      clearTimeout(repairTimer);clearTimeout(previewTimer);clearTimeout(optionalTimer);clearTimeout(idleTimer);cancelAnimationFrame(frameHandle)
      client.onPresentation=undefined
      if(settled){
        // All old submissions have been acknowledged. Revoke their textures
        // before loading the next material. Only the worker, GPU device and
        // pipelines survive this handoff. The next token gets a new canvas.
        const ids=new Set(retired.keys())
        for(const tile of cache.values())if(tile.gpuTile)ids.add(tile.gpuTile)
        client.releasePresented([...ids]);parked.current={client,owner}
      }else client.dispose()
      diagnostics.flush();diagnostics.close();projection.dispose()
      // Park only actual visible pixels, with the precise old material clip.
      const held=mounted.current&&bitmapContext&&backing&&(!backing.preview||!!partialMaterials)&&shownMaterials&&latest.current.overviewBoxes&&outer.current&&
        handoff.hold(element,outer.current,backing.view,backing.width,backing.height,source,shownMaterials,backing.dpr,completeBacking===backing)
      if(!held){bitmapContext?.transferFromImageBitmap(null);element.remove()}
      badge.remove()
    }
  },[props.source?.token??props.warm,props.width>0&&props.height>0,!!props.overviewBoxes,!!props.source?.viewportSubset])
  useLayoutEffect(()=>{props.hover?.refresh?.()},[props.hover,props.hidden,park,props.source?.token,props.panGestureActive])
  useLayoutEffect(()=>wake.current(),[props.view.x,props.view.y,props.view.zoom,props.width,props.height,props.panGestureActive,park,crop?.x,crop?.y,crop?.width,crop?.height,dpr])
  useLayoutEffect(()=>{handoff.project(props.source,props.overviewBoxes,props.view,props.width,props.height,dpr)},[props.source,props.overviewBoxes,props.view,props.width,props.height,dpr,handoff])
  return <div ref={outer} className="native-source-surface" style={{position:'absolute',inset:0,pointerEvents:'none',overflow:'hidden',visibility:props.hidden||outsideScope?'hidden':undefined,clipPath:props.clipPath}}>
    <div ref={host} style={{position:'absolute',inset:0,overflow:'hidden'}}/>
  </div>
}
