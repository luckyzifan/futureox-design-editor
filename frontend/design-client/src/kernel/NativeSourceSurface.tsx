import {useLayoutEffect,useRef} from 'react'
import {desktopBridge,type SourceCanvasSnapshot} from '../desktop'
import {navigationOverview,nearOverviewTiles} from './navigation-overview'
import {NAVIGATION_BACKING_BYTES} from './navigation-backing'
import type {CanvasCamera} from '../canvas-camera'
import {KernelClient,backendPreference,renderExecutionPolicy,type TileResult} from './client'
import {canvasSamplingProfile} from './render-policy'
import {SourceViewportPlanner,improvesSourceZoom,sourceTileBringsDetail,visibleSourceDensity} from './source-viewport-plan'
import {tileBatchPrepareViewport} from './tile-prepare-viewport'
import {tileIntersectsView} from './tile-preview'
import {SourceRenderWork} from './source-render-work'
import {SourceQualityLadder,sourceRasterLimit} from './source-quality-ladder'
import {useDevicePixelRatio} from './presentation'
import type {ResidentAcknowledgement} from './resident-presentation'
import type {ResidentFrame} from './gpu/resident-presenter'
import type {RasterTile} from './tile-cache'
import {createRenderDiagnostics,PREFIX} from '../../../design-desktop/src/render-terminal-diagnostics.mjs'
import {CameraReprojection,atomicPresentationContext,consumePresentationBitmap,keepCompleteCameraBacking} from './camera-reprojection'

export type NativeSourceStatus={phase:'loading'|'refining'|'ready'|'limited'|'error';done:number;total:number;error?:string}
type Props={hidden?:boolean;clipPath?:string;source:SourceCanvasSnapshot;view:CanvasCamera;width:number;height:number;
  onStatus?:(status:NativeSourceStatus)=>void;onPresented?:(frame:ResidentAcknowledgement,complete:boolean)=>void}
type Placement=RasterTile & {gpuTile:number}
type Tile=TileResult&{serial:number;used:number;lastSubmission:number;placement:Placement}
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
  const host=useRef<HTMLDivElement>(null),latest=useRef(props),wake=useRef<()=>void>(()=>{})
  const mounted=useRef(false),parked=useRef<{client:KernelClient;owner:string}|undefined>(undefined)
  const dpr=useDevicePixelRatio(),density=useRef(dpr);density.current=dpr;latest.current=props
  useLayoutEffect(()=>{
    mounted.current=true
    return ()=>{mounted.current=false;parked.current?.client.dispose();parked.current=undefined}
  },[])
  useLayoutEffect(()=>{
    if(latest.current.width<=0||latest.current.height<=0)return
    const source=latest.current.source,owner=JSON.stringify([source.owner,source.revision,source.rasterProfile,source.colorManaged])
    if(parked.current&&parked.current.owner!==owner){parked.current.client.dispose();parked.current=undefined}
    const client=parked.current?.client??new KernelClient(),element=document.createElement('canvas'),badge=document.createElement('span')
    parked.current=undefined
    const diagnostics=createRenderDiagnostics({enabled:window.coreDesktop?.renderDiagnostics===true,session:Math.floor(Math.random()*1e12),sink:record=>console.log(PREFIX+JSON.stringify(record))})
    const profile=canvasSamplingProfile(renderExecutionPolicy,source.rasterProfile,backendPreference(),source.colorManaged)
    const planner=new SourceViewportPlanner(profile,source.colorManaged)
    const quality=new SourceQualityLadder()
    let overview: ReturnType<typeof navigationOverview>
    element.className='kernel-compositor native-source-content'
    element.setAttribute('aria-label','全源画板')
    Object.assign(element.style,{position:'absolute',inset:'0',pointerEvents:'none'})
    host.current!.append(element)
    const bitmapContext=atomicPresentationContext(element)
    const projection=new CameraReprojection(element,host.current!,()=>schedulePaint())
    projection.history.bind(source)
    let backing:ResidentAcknowledgement|undefined
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
      return projection.update(backing,p.view,p.width,p.height,!!bitmapContext,source.bounds)
    }
    badge.className='kernel-status';badge.setAttribute('role','status');badge.setAttribute('aria-label','完整画板显示状态')
    Object.assign(badge.style,{position:'absolute',right:'14px',top:'var(--kernel-status-top, 12px)',fontSize:'11px',color:'#7b8190',zIndex:'5'})
    host.current!.append(badge)
    const prefix=crypto.randomUUID(),cache=new Map<string,Tile>(),retired=new Map<number,number>()
    // A displayed bitmap can outlive evicted GPU tiles. Its geometry remains
    // needed to prove the next zoom frame preserves all visible detail.
    const submittedPlacements=new Map<number,Placement[]>()
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
    const workQueue=new SourceRenderWork<RasterTile>()
    let wanted:{id:string;sequence:number;view:CanvasCamera;width:number;height:number;dpr:number;scale:number;complete:boolean;covered:boolean;demand:string;ids:Set<number>}|undefined
    const emit=(status:NativeSourceStatus)=>{
      if(!alive)return
      const signature=`${status.phase}/${status.done}/${status.total}/${status.error??''}`,now=performance.now()
      if(signature===lastStatus)return
      if(status.phase==='refining'&&lastStatus.startsWith('refining/')&&now-lastStatusAt<120)return
      lastStatus=signature;lastStatusAt=now
      badge.textContent=status.phase==='ready'?'WebGPU · 清晰':status.phase==='limited'?'当前倍率为预览精度':status.phase==='error'?'画板绘制未完成':status.phase==='loading'?'正在准备完整画板…':`正在绘制 ${status.done} / ${status.total}`
      badge.title=status.error??'当前视口完成全部瓦片与采样密度校验后显示清晰'
      diagnostics.record('viewport-state',{state:status.phase==='loading'?0:status.phase==='refining'?1:status.phase==='ready'?2:3,
        previewTiles:status.done,count:status.total,zoom:latest.current.view.zoom,dpr:density.current,
        width:latest.current.width,height:latest.current.height,sceneReady:initialized?1:0,finalComplete:status.phase==='ready'?1:0})
      if(status.phase==='ready'||status.phase==='error')diagnostics.flush()
      latest.current.onStatus?.(status)
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
      return {p,...planner.plan(p.view,density.current,p.width,p.height,motion,quality.scale,continuousZoom)}
    }
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
    const paint=()=>{
      frameHandle=0
      if(!alive||!initialized||failed||suspended)return
      try{
        const {p,ratio,tiles,keys,exact,raster}=plan(),done=tiles.filter(tile=>cache.has(tile.key)).length
        if(window.coreDesktop?.renderDiagnostics){
          element.dataset.sourceDemandScale=String(raster.scale)
          element.dataset.sourceDemandZoom=String(p.view.zoom)
          element.dataset.sourceMoving=String(moving)
        }
        project()
        const visible=[...cache.values()].filter(tile=>tileIntersectsView(tile,p.view,p)).sort((a,b)=>a.zoom-b.zoom||a.used-b.used)
        if(!cache.size){emit({phase:'refining',done,total:tiles.length});return}
        const sequence=++submission,id=`${prefix}:${sequence}`,complete=done===tiles.length&&exact
        for(const tile of visible){tile.lastSubmission=sequence;tile.used=++tick}
        const anchor=visible[0]||cache.values().next().value!
        // Even an offscreen anchor must survive until this display task is
        // acknowledged. Release messages can otherwise overtake deferred draw.
        anchor.lastSubmission=sequence;anchor.used=++tick
        submittedPlacements.set(sequence,(visible.length?visible:[anchor]).map(t=>t.placement))
        if(submittedPlacements.size>32)submittedPlacements.delete(submittedPlacements.keys().next().value!)
        // A coarse motion tile can fill a hole but must remain below sharper
        // history. Only the requested native lattice wins the phase handoff.
        const items:ResidentFrame['items']=visible.map(tile=>({active:true,layer:exact&&keys.has(tile.key)?4:1,
          tile:{key:tile.key,serial:tile.serial,gpuTile:tile.gpuTile!,x:tile.x,y:tile.y,width:tile.width,height:tile.height,zoom:tile.zoom,phaseX:tile.phaseX,phaseY:tile.phaseY}}))
        wanted={id,sequence,view:{...p.view},width:p.width,height:p.height,dpr:ratio,scale:raster.scale,complete,covered:done===tiles.length,demand:demandKey(),ids:new Set(visible.map(tile=>tile.gpuTile!))}
        // The live anchor certifies this source even when all cached content
        // moves offscreen. The presenter marks unknown pixels as preview;
        // its independent ACK is required before claiming exact readiness.
        client.present({presentationId:id,view:p.view,width:p.width,height:p.height,dpr:ratio,items,allowBackground:true,
          cameraPreview:import.meta.env.VITE_DESIGN_PAN_PRESENT_PREVIEW!=='0' && (bitmapContext || backing?.view.zoom===p.view.zoom)
            ?{anchor:anchor.gpuTile!}:undefined})
        emit({phase:'refining',done,total:tiles.length})
        // This is an evictable history allowance, never a source-size refusal.
        const keep=Math.max(32,tiles.length*3)
        for(const tile of [...cache.values()].sort((a,b)=>a.used-b.used)){
          if(cache.size<=keep)break
          if(keys.has(tile.key) || overview?.tiles.some(base=>base.key===tile.key))continue
          cache.delete(tile.key);retire(tile)
        }
        release()
      }catch(error){fail(error)}
    }
    const schedulePaint=()=>{if(alive&&!frameHandle)frameHandle=requestAnimationFrame(paint)}
    const receive=(tile:TileResult)=>{
      if(!alive){tile.bitmap?.close();if(tile.gpuTile)client.releasePresented([tile.gpuTile]);return}
      if(!tile.gpuTile){tile.bitmap?.close();throw Error('完整源画布尚未取得 GPU 显示纹理')}
      const {key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}=tile
      const placement={key,x,y,width,height,zoom,phaseX,phaseY,gutter,gpuTile}
      const old=cache.get(tile.key)
      if(old&&old.gpuTile!==tile.gpuTile)retire(old)
      retired.delete(tile.gpuTile)
      cache.set(tile.key,{...tile,placement,serial:old?.gpuTile===tile.gpuTile?old.serial:++serial,used:++tick,lastSubmission:old?.gpuTile===tile.gpuTile?old.lastSubmission:0})
      if(!tile.prefetch||tileIntersectsView(tile,latest.current.view,latest.current))schedulePaint()
    }
    const updateWorkDemand=()=>{
      if(workQueue.current?.pending.size){
        const next=plan()
        // Returning to an exact, fully resident viewport leaves no missing
        // pixel for this batch to repair. Its old density may still be within
        // the ordinary 2x reuse window, but finishing it only delays later
        // input. Cancel preview work without retiring any accepted texture.
        const covered=next.exact&&next.tiles.every(tile=>cache.has(tile.key))
        // Completed tiles no longer hold the batch's camera lease. Cancel if
        // either remaining tile would delay the current viewport with old work.
        const optional=[...workQueue.current.pending.values()].every(tile=>tile.prefetch===true)
        const missing=next.tiles.some(tile=>!cache.has(tile.key))
        workQueue.demand(covered&&!optional,tile=>{
          if(overview?.tiles.some(base=>base.key===tile.key))return !moving && !missing
          if(tile.prefetch)return next.keys.has(tile.key)||!missing&&next.prefetchKeys.has(tile.key)
          const relative=next.raster.scale/tile.zoom
          return relative<=2&&relative>=.5&&tileIntersectsView(tile,next.p.view,next.p) ||
            zoomingIn&&continuousZoom&&relative>2&&relative<=8&&sourceTileBringsDetail(tile,next.p.view,next.p,cache.values())
        })
      }
    }
    const run=async()=>{
      if(!alive||!initialized||running||failed||suspended)return
      running=true
      try{
        while(alive&&!failed&&!suspended){
          const {p,ratio,raster,tiles,prefetch}=plan(),missing=tiles.filter(tile=>!cache.has(tile.key))
          const optional=missing.length===0
          if(optional && source.materialKeys)break
          if(optional&&prefetchReady!==demandKey()){schedulePaint();break}
          // We already have real pixels for this entire source. An expensive
          // optional overview cannot fill another hole. Give the next input
          // first use of the raster owner before warming native neighbours.
          const costlyOverview = seededOverview && projection.history.completeFrame && nativeTileMs > SOURCE_QUIET_MS
          if (optional) {
            const nextOptional = Math.max(optionalNotBefore, costlyOverview ? lastInputAt+Math.min(nativeTileMs,1000) : 0)
            const wait = nextOptional-performance.now()
            if (wait > 0) {
              clearTimeout(optionalTimer)
              optionalTimer=setTimeout(()=>{ if(alive && !suspended) void run() },Math.ceil(wait))
              break
            }
          }
          if (optional && !costlyOverview && !moving && !overview) overview = navigationOverview(source.bounds,1,source.nodes)
          const warmBase = optional && !costlyOverview && !moving && overview ? nearOverviewTiles(overview.tiles,p.view,p.width,p.height)
            .find(tile=>!cache.has(tile.key) && !skippedPrefetch.has(tile.key)) : undefined
          const candidates=warmBase ? [{...warmBase,prefetch:true as const}] :
            optional?prefetch.filter(tile=>!cache.has(tile.key)&&!skippedPrefetch.has(tile.key)):missing
          if(!candidates.length)break
          const batch=candidates.slice(0,SOURCE_PIPELINE_TILES)
          diagnostics.record('cache',{count:batch.length,prefetch:optional?1:0,reasonCode:optional?7:5})
          const work=workQueue.begin(batch,SOURCE_PIPELINE_TILES)
          const camera = warmBase && overview ? overview.view : raster.camera
          const batchStarted=performance.now()
          try{
            await client.renderSource(source,{pageId:source.pageId,width:Math.ceil(p.width*ratio),height:Math.ceil(p.height*ratio),
              view:camera,transparent:false,grid:false,rasterProfile:profile,
              tileViewport:batch,tilePrepareViewport:tileBatchPrepareViewport(optional?[]:tiles,[],batch,camera),renderIntent:'preview',
              tileOwner:{documentId:source.owner.documentId,sessionEpoch:source.owner.sessionEpoch}},tile=>{
                // Every useful tile can present while the next one is still
                // preparing/rasterizing. Late or duplicate delivery cannot
                // populate a newer owner or retire a texture already in use.
                if(!alive||!workQueue.accepts(work,tile.key)){
                  tile.bitmap?.close()
                  if(tile.gpuTile&&![...cache.values()].some(value=>value.gpuTile===tile.gpuTile))client.releasePresented([tile.gpuTile])
                  return
                }
                receive(tile);workQueue.delivered(work,tile.key);updateWorkDemand()
              },work.controller.signal)
            if (!optional && !moving && !work.pending.size) {
              const elapsed=(performance.now()-batchStarted)/batch.length
              nativeTileMs=nativeTileMs ? .5*(nativeTileMs+elapsed) : elapsed
            }
          }catch(error){
            if(work.controller.signal.aborted||String(error).includes('PREVIEW_CANCELLED'))continue
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
            if(!optional)throw Error('源画板瓦片未返回，已保留当前画面')
            for(const key of work.pending.keys())skippedPrefetch.add(key)
          }
          // Rejections stay bounded to this revision's current warm set.
          if(skippedPrefetch.size>32)for(const key of skippedPrefetch)if(!plan().prefetchKeys.has(key) && !overview?.tiles.some(tile=>tile.key===key))skippedPrefetch.delete(key)
          // Yield host bookkeeping; native preparation and GPU work already
          // use their existing independent threads and bounded task queues.
          await new Promise<void>(resolve=>setTimeout(resolve,0))
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
        release();void run()
      }
      const actual=stats.presented as ResidentAcknowledgement|undefined
      if(!actual?.presentationId?.startsWith(prefix+':'))return
      const sequence=Number(actual.presentationId.slice(prefix.length+1))
      if(!Number.isSafeInteger(sequence)||sequence<=0||sequence>submission||sequence<acknowledged)return
      project()
      const ids=new Set(actual.ids),shownTiles=(submittedPlacements.get(sequence)??[]).filter(t=>ids.has(t.gpuTile))
      if(bitmap && backing && actual.preview && latest.current.view.zoom<backing.view.zoom &&
          !projection.history.canAdvance(backing,actual,latest.current,source.bounds))return
      if(bitmap && keepCompleteCameraBacking(backing,actual,!!bitmapContext,projection.zooming,latest.current,projection.history.completeFrame) &&
          !improvesSourceZoom(backing,actual,latest.current,shownTiles,backingTiles))return
      if (bitmap && bitmapContext && startupPreview) {
        seededOverview=projection.history.seed(source,source.bounds,element,startupPreview.scale,actual)
        if (!seededOverview) previewRequested=false
        startupPreview=undefined
        delete element.dataset.sourcePreview
      }
      if(bitmap&&bitmapContext){
        consumePresentationBitmap(bitmapContext,element,bitmap);bitmapApplied=true
        projection.history.capture(element,actual,source.bounds)
        if(source.materialKeys){
          // Let the immutable source preview show through GPU-confirmed gaps.
          // Real white paint belongs to the tile and is never cut out.
          const gaps=actual.preview?actual.previewGaps:undefined
          const outlines=gaps?.map(g=>{
            const x=g.x/actual.dpr,y=g.y/actual.dpr,w=g.width/actual.dpr,h=g.height/actual.dpr
            return `M${x} ${y}v${h}h${w}v${-h}Z`
          }).join(' ')
          element.style.clipPath=outlines?`path(evenodd, "M0 0h${actual.width}v${actual.height}H0Z ${outlines}")`:
            actual.preview&&!gaps?'inset(100%)':''
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
        }
        // A real tile can already be visible through camera reprojection
        // before this older submission qualifies for exact-camera readiness.
        if(moving&&zoomingIn&&continuousZoom&&actual.view.zoom<=p.view.zoom&&quality.scale===undefined&&
            scale>0&&planner.presentedDetail(Math.min(scale,p.view.zoom*density.current))){schedulePaint();void run()}
      }
      backing=actual;backingTiles=shownTiles;acknowledged=sequence
      for(const id of submittedPlacements.keys())if(id<=sequence)submittedPlacements.delete(id)
      release();project()
      if (bitmapApplied && !seededOverview && actual.navigationBackingBytes===NAVIGATION_BACKING_BYTES) void requestOverview()
      if(bitmapApplied && client.copyNavigationTile) {
        const cohort = nearOverviewTiles(overview?.tiles ?? [],latest.current.view,latest.current.width,latest.current.height)
          .flatMap(tile => cache.get(tile.key) ?? [])
        projection.history.warm(source.bounds,[...cohort,...cache.values()],(id,consume)=>client.copyNavigationTile(id,consume),schedulePaint)
      }
      const expected=wanted,p=latest.current
      if(!expected||actual.presentationId!==expected.id||actual.view.x!==expected.view.x||actual.view.y!==expected.view.y||actual.view.zoom!==expected.view.zoom||
        actual.width!==expected.width||actual.height!==expected.height||actual.dpr!==expected.dpr||
        actual.view.x!==p.view.x||actual.view.y!==p.view.y||actual.view.zoom!==p.view.zoom||actual.width!==p.width||actual.height!==p.height||actual.dpr!==density.current||
        [...expected.ids].some(id=>!actual.ids.includes(id)))return
      const complete=expected.complete&&!actual.preview
      element.dataset.sourcePresentation=String(sequence)
      element.dataset.sourceTargetScale=String(expected.scale)
      const visibleTiles=[...cache.values()].filter(t=>actual.ids.includes(t.gpuTile!)&&tileIntersectsView(t,actual.view,actual))
      const hasRequestedDensity=visibleTiles.some(t=>t.zoom===expected.scale)
      element.dataset.sourceRenderScale=String(Math.max(0,...visibleTiles.map(t=>t.zoom)))
      element.dataset.sourceVisibleDemandScale=hasRequestedDensity?String(expected.scale):''
      if(complete){
        quality.reset()
        element.dataset.sourceReadyCamera=JSON.stringify(actual.view)
        planner.presented(actual.view,actual.dpr,actual.width,actual.height)
        const count=plan().tiles.length;emit({phase:'ready',done:count,total:count})
      }
      if(!complete&&moving&&zoomingIn&&quality.scale===undefined&&expected.scale<actual.view.zoom*actual.dpr &&
          hasRequestedDensity&&
          planner.presentedDetail(expected.scale)){schedulePaint();void run()}
      if(actual.preview)badge.textContent='缓存预览 · 正在补画'
      latest.current.onPresented?.(actual,complete)
      if(expected.covered&&!actual.preview&&expected.demand===demandKey()&&quality.scale!==undefined){
        if(quality.presented(plan().raster.scale)){schedulePaint();void run()}
        else if(quality.limited){const total=plan().tiles.length;emit({phase:'limited',done:total,total,error:quality.reason})}
      }
      if(expected.covered&&!actual.preview&&expected.demand===demandKey()&&prefetchReady!==expected.demand){
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
      if(suspended){workQueue.demand(true,()=>false);return}
      if(qualityPose!==poseKey()){qualityPose=poseKey();quality.reset()}
      if(latest.current.view.zoom!==lastZoom){
        const now=performance.now(),inward=latest.current.view.zoom>lastZoom
        continuousZoom=inward===zoomingIn && now-lastZoomAt<180
        zoomingIn=inward;lastZoom=latest.current.view.zoom;lastZoomAt=now
      }
      lastInputAt=performance.now();optionalNotBefore=0;clearTimeout(optionalTimer)
      moving=true;clearTimeout(idleTimer)
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
      idleTimer=moving?setTimeout(()=>{
        if(!alive||failed||suspended)return
        moving=false
        try{
          const native=plan(false)
          // Preserve accepted history, but stop pending work that cannot
          // satisfy the current density/phase/owner keys. The request slot
          // still belongs to its real completion, including late GPU work.
          const missing=native.tiles.some(tile=>!cache.has(tile.key))
          workQueue.demand(false,tile=>native.keys.has(tile.key)||!missing&&tile.prefetch===true&&native.prefetchKeys.has(tile.key)||
            missing&&zoomingIn&&continuousZoom&&!tile.prefetch&&tile.zoom<native.raster.scale&&tile.zoom>=native.raster.scale/8&&
            sourceTileBringsDetail(tile,native.p.view,native.p,cache.values()))
          schedulePaint();void run()
        }catch(error){fail(error)}
      },continuousZoom&&lastInputAt-lastZoomAt<180?SOURCE_WHEEL_QUIET_MS:SOURCE_QUIET_MS):undefined
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
        client.attachPresentation(bitmapContext?new OffscreenCanvas(1,1):element.transferControlToOffscreen(),!!bitmapContext);initialized=true;void run()
      }catch(error){if(alive)fail(error)}
    })()
    return()=>{
      alive=false;wake.current=()=>{}
      const settled=mounted.current&&!!bitmapContext&&!!source.materialKeys&&initialized&&!running&&!failed&&
        !workQueue.current&&acknowledged===submission&&lastStatus.startsWith('ready/')
      workQueue.close();document.removeEventListener('visibilitychange',visibility)
      clearTimeout(previewTimer);clearTimeout(optionalTimer);clearTimeout(idleTimer);cancelAnimationFrame(frameHandle)
      client.onPresentation=undefined
      if(settled){
        // All old submissions have been acknowledged. Revoke their textures
        // before loading the next material. Only the worker, GPU device and
        // pipelines survive this handoff. The next token gets a new canvas.
        const ids=new Set(retired.keys())
        for(const tile of cache.values())if(tile.gpuTile)ids.add(tile.gpuTile)
        client.releasePresented([...ids]);parked.current={client,owner}
      }else client.dispose()
      diagnostics.flush();diagnostics.close();projection.dispose();bitmapContext?.transferFromImageBitmap(null)
      element.remove();badge.remove()
    }
  },[props.source.token,props.width>0&&props.height>0])
  useLayoutEffect(()=>wake.current(),[props.view.x,props.view.y,props.view.zoom,props.width,props.height,dpr])
  return <div ref={host} className="native-source-surface" style={{position:'absolute',inset:0,pointerEvents:'none',overflow:'hidden',visibility:props.hidden?'hidden':undefined,clipPath:props.clipPath}}/>
}
