import {MATERIAL_MARGIN} from './kernel/source-overview-window'
import {PASTEBOARD_COVERAGE} from './kernel/cpu-tile-frame'
import {memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type RefObject} from 'react'
import type {CanvasCamera} from './canvas-camera'
import type {LargeDocumentBridge, LargeDocumentOwner, OpeningPage, SourceCanvasSnapshot, SourceCanvasBox, SourceCanvasItem} from './desktop'

export type OpeningView = {
  owner:LargeDocumentOwner; bounds:SourceCanvasBox; items:SourceCanvasItem[]; pages:OpeningPage[];
  materialDisplay?:SourceCanvasSnapshot; images:ReadonlyMap<number,string>; finished:boolean; cacheHit:boolean; rendered:number
}
export const SOURCE_DETAIL_SAMPLE_MS=120
export function useSourceOpening(bridge:LargeDocumentBridge, generation:number|undefined) {
  const [value,setValue]=useState<{generation:number;view:OpeningView}>()
  const priority=useRef<{pageId?:string;material?:number;viewport?:SourceCanvasBox;viewportDensity?:number;viewportAnchor?:[number,number]}>({})
  const focusedAt=useRef(-Infinity)
  const wake=useRef<()=>void>(()=>{})
  useEffect(()=>{
    if(generation===undefined || !bridge.openingView)return
    const read=bridge.openingView.bind(bridge)
    let failures=0,live=true, inFlight=false, timer:ReturnType<typeof setTimeout>|undefined
    let owner:LargeDocumentOwner|undefined, pages:OpeningPage[]=[], cursor=0, detailCursor=0, finished=false, lastDisplay:SourceCanvasSnapshot|undefined
    const items:SourceCanvasItem[]=[], images=new Map<number,string>(),baseImages=new Map<number,string>(),refined=new Map<number,number>()
    const poll=async()=>{
      if(!live||inFlight)return
      clearTimeout(timer);inFlight=true
      const priorityAtStart = priority.current
      let delay:number|undefined=65
      try {
        const reply=await read({owner,offset:items.length,cursor,detailCursor,...priority.current})
        if(!live)return
        if(reply.status==='error')throw Error(reply.message)
        failures=0
        if(reply.status==='ok' && reply.phase==='unavailable' || reply.status==='cancelled' && owner){setValue(undefined);live=false;return}
        if(reply.status==='ok' && reply.phase==='available'){
          if(owner&&(owner.documentId!==reply.owner.documentId||owner.sessionEpoch!==reply.owner.sessionEpoch))return
          owner=reply.owner; if(reply.pages)pages=reply.pages
          if(reply.offset!==items.length || reply.cursor!==cursor+reply.images.length)throw Error('Invalid material preview batch')
          items.push(...reply.items);cursor=reply.cursor
          for(const {index,png} of reply.images){
            const src='data:image/png;base64,'+png
            baseImages.set(index,src)
            if(!refined.has(index))images.set(index,src)
          }
          let evicted=false
          const base=reply.detailBase??0
          for(const [index,sequence] of refined)if(sequence<=base){
            refined.delete(index);const fallback=baseImages.get(index)
            if(fallback){images.set(index,fallback);evicted=true}
          }
          const next=reply.nextDetailCursor??(detailCursor+Number(!!reply.detail))
          if(next!==Math.max(detailCursor,base)+Number(!!reply.detail))throw Error('Invalid source detail cursor')
          detailCursor=next
          if(reply.detail){
            const {index,png}=reply.detail
            if(index<0||index>=items.length)throw Error('Invalid material detail receipt')
            const src='data:image/png;base64,'+png
            const decoded=new Image();decoded.src=src
            try{await decoded.decode();if(!live)return;refined.set(index,detailCursor);images.set(index,src)}catch{/* Keep the visible base pixels. */}
          }
          const selected=priority.current.material
          const display=selected===undefined ? undefined :
            reply.materialDisplay?.openingMaterial===selected ? reply.materialDisplay :
              lastDisplay?.openingMaterial===selected ? lastDisplay : undefined
          const displayChanged=display?.token!==lastDisplay?.token
          lastDisplay=display
          if(items.length===reply.total && (displayChanged || reply.items.length || reply.images.length || reply.detail || evicted || reply.finished!==finished || !reply.total))
            setValue({generation,view:{owner,bounds:reply.bounds,items,pages,materialDisplay:display,images:new Map(images),finished:reply.finished,cacheHit:reply.cacheHit,rendered:reply.rendered}})
          finished=reply.finished
          if(reply.finished&&!reply.indexing&&!reply.moreDetails&&!reply.detailPending&&!reply.detail&&items.length===reply.total){
            delay=undefined
            return
          }
          if(items.length<reply.total||reply.moreImages||reply.moreDetails||reply.detail)delay=0
          else if(reply.detailPending)delay=65
          else if(!reply.images.length)delay=priority.current.material!==undefined&&!display&&performance.now()-focusedAt.current<800?32:200
        }
      }catch {
        delay=250
        if(++failures>=3 && live){live=false;setValue(undefined)}
      }
      finally {
        inFlight=false
        // A material click can arrive while the preceding request owns the
        // cursor. Send its new priority as soon as that cursor is available.
        if(priorityAtStart!==priority.current)delay=0
        if(live&&delay!==undefined)timer=setTimeout(()=>void poll(),delay)
      }
    }
    priority.current={};wake.current=()=>{if(live)void poll()};void poll()
    return()=>{live=false;clearTimeout(timer);wake.current=()=>{}}
  },[bridge,generation])
  const setViewport=useCallback((viewport:SourceCanvasBox,viewportDensity?:number,anchor?:{x:number;y:number})=>{
    const old=priority.current.viewport
    if(old?.x===viewport.x&&old.y===viewport.y&&old.width===viewport.width&&old.height===viewport.height&&priority.current.viewportDensity===viewportDensity&&priority.current.viewportAnchor?.[0]===anchor?.x&&priority.current.viewportAnchor?.[1]===anchor?.y)return
    priority.current={...priority.current,viewport,viewportDensity,viewportAnchor:anchor?[anchor.x,anchor.y]:undefined};wake.current()
  },[])
  return {setViewport,view:value?.generation===generation?value?.view:undefined,
    focus:(pageId?:string,material?:number,opening=false)=>{if(priority.current.material!==material)focusedAt.current=opening?performance.now():-Infinity;priority.current={pageId,material};wake.current()}}
}

/** Each image was rendered from this source root. Both this layer and the
 * precise native surface use the same packed world bounds and editor camera. */
export function visibleMaterialDetail(source: OpeningView, view: CanvasCamera, width:number, height:number, dpr:number,
  pageId?:string, focused?:number) {
  const visible:{index:number;area:number;missing:boolean}[]=[]
  let pageFits=true
  for (let i=0;i<source.items.length;i++){
    const item=source.items[i];if(pageId&&item.pageId!==pageId)continue
    const b=item.placed,x=b.x*view.zoom+view.x,y=b.y*view.zoom+view.y,w=b.width*view.zoom,h=b.height*view.zoom
    if(x<0||y<0||x+w>width||y+h>height)pageFits=false
    const dx=Math.min(width,x+w)-Math.max(0,x),dy=Math.min(height,y+h)-Math.max(0,y)
    if(dx<=0||dy<=0)continue
    if(i===focused) return [i]
    // Small catalogue images already represent materials at overview scale.
    // Request a precision scene only for appreciable on-screen artwork.
    const missing=source.finished&&!source.images.has(i)
    if(missing || Math.max(w,h)*dpr>256 && dx*dy>=width*height/64)visible.push({index:i,area:dx*dy,missing})
  }
  return visible.filter(v=>focused!==undefined||!pageFits||v.missing).sort((a,b)=>b.area-a.area).slice(0,16).map(v=>v.index).sort((a,b)=>a-b)
}
export type SourceThumbnailCoverage=RefObject<((view:CanvasCamera,width:number,height:number,requirement?:'all'|'any')=>boolean)|undefined>
const Thumbnail=memo(function Thumbnail({item,index,src,loaded}:{item:SourceCanvasItem;index:number;src:string;loaded:Map<number,string>}){
  useLayoutEffect(()=>()=>{if(loaded.get(index)===src)loaded.delete(index)},[index,src,loaded])
  const b=item.placed
  return <image data-opening-material={index} data-opening-page={item.pageId} x={b.x} y={b.y} width={b.width} height={b.height}
    preserveAspectRatio="none" href={src} onLoad={e=>{if(e.currentTarget.getAttribute('href')===src)loaded.set(index,src)}}/>
})
export function SourceOpeningSurface({source,view,width,height,pageId,focused,onDetail,onViewport,coverage}:{
  source:OpeningView;view:CanvasCamera;width:number;height:number;pageId?:string;focused?:number
  onDetail?:(roots:number[])=>void;onViewport?:(box:SourceCanvasBox,density:number)=>void;coverage?:SourceThumbnailCoverage
}) {
  const rows=useMemo(()=>source.items.map((item,index)=>({item,index})).filter(r=>!pageId||r.item.pageId===pageId),[source.items,pageId])
  const loaded=useMemo(()=>new Map<number,string>(),[source.owner.documentId,source.owner.sessionEpoch])
  // Ordinary source pages keep their thumbnails mounted. On very large pages
  // move an overscanned window in whole viewport steps, outside pointer events.
  const scale=rows.length>512||rows.length>32&&view.zoom>=1?2**Math.floor(Math.log2(view.zoom)):0
  const sx=scale?width/scale:0,sy=scale?height/scale:0
  const cx=sx?Math.floor((width/2-view.x)/view.zoom/sx):0,cy=sy?Math.floor((height/2-view.y)/view.zoom/sy):0
  const windowRows=useMemo(()=>sx&&sy?rows.filter(({item:{placed:b}})=>
    b.x+b.width>(cx-1)*sx && b.y+b.height>(cy-1)*sy && b.x<(cx+2)*sx && b.y<(cy+2)*sy):rows,[rows,sx,sy,cx,cy])
  const images=useMemo(()=>windowRows.map(({item,index})=>{
    const src=source.images.get(index)
    return src?<Thumbnail key={index} item={item} index={index} src={src} loaded={loaded}/>:null
  }),[windowRows,source.images,loaded])
  useLayoutEffect(()=>{
    if(!coverage)return
    coverage.current=(camera,w,h,requirement='all')=>{
      if(requirement==='all'&&sx&&sy&&(-camera.x/camera.zoom<(cx-1)*sx || -camera.y/camera.zoom<(cy-1)*sy ||
        (w-camera.x)/camera.zoom>(cx+2)*sx || (h-camera.y)/camera.zoom>(cy+2)*sy))return false
      for(const {item,index} of windowRows){
        const b=item.placed,x=b.x*camera.zoom+camera.x,y=b.y*camera.zoom+camera.y
        if(x>=w||y>=h||x+b.width*camera.zoom<=0||y+b.height*camera.zoom<=0)continue
        const decoded=loaded.has(index)&&loaded.get(index)===source.images.get(index)
        if(requirement==='any'&&decoded)return true
        if(requirement==='all'&&!decoded)return false
      }
      return requirement==='all'&&rows.length>0
    }
    return ()=>{coverage.current=undefined}
  },[coverage,rows.length,windowRows,loaded,source.images,sx,sy,cx,cy])
  const priorityPose=useRef<{x:number;y:number;zoom:number;width:number;height:number}|undefined>(undefined)
  useEffect(()=>{
    if(!onViewport||!width||!height)return
    const last=priorityPose.current
    if(last&&last.width===width&&last.height===height&&Math.abs(Math.log(view.zoom/last.zoom))<.12&&
       Math.abs(view.x-last.x*view.zoom/last.zoom)<width/8&&Math.abs(view.y-last.y*view.zoom/last.zoom)<height/8)return
    priorityPose.current={...view,width,height}
    onViewport({x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom},view.zoom*(window.devicePixelRatio||1))
  },[onViewport,view.x,view.y,view.zoom,width,height])
  const pending=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
  const latest=useRef({source,view,width,height,pageId,focused,onDetail,onViewport})
  latest.current={source,view,width,height,pageId,focused,onDetail,onViewport}
  useEffect(()=>()=>{clearTimeout(pending.current);pending.current=undefined},[source.owner.documentId,source.owner.sessionEpoch])
  useEffect(()=>{
    if(!onDetail||!width||!height||pending.current!==undefined)return
    // Sample the latest viewport during a continuous gesture as well as on
    // its last event. Restarting this timer on every wheel tick starves refinement.
    pending.current=setTimeout(()=>{
      pending.current=undefined
      const {source,view,width,height,pageId,focused,onDetail,onViewport}=latest.current
      if(!onDetail||!width||!height)return
      onViewport?.({x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom},view.zoom*(window.devicePixelRatio||1))
      onDetail(visibleMaterialDetail(source,view,width,height,window.devicePixelRatio||1,pageId,focused))
    },SOURCE_DETAIL_SAMPLE_MS)
  },[source.owner.documentId,source.owner.sessionEpoch,source.items,view.x,view.y,view.zoom,width,height,pageId,focused,onDetail,onViewport,source.finished])
  const panRef=useRef(view)
  const panned=panRef.current.zoom===view.zoom&&(panRef.current.x!==view.x||panRef.current.y!==view.y)
  panRef.current=view
  let cover=0
  for(const item of source.items){
    const b=item.placed,x=b.x*view.zoom+view.x,y=b.y*view.zoom+view.y,w=b.width*view.zoom,h=b.height*view.zoom
    const l=Math.max(0,x),t=Math.max(0,y),r=Math.min(width,x+w),bo=Math.min(height,y+h)
    if(r>l&&bo>t)cover+=(r-l)*(bo-t)
  }
  // Above the native canvas while the artboard is a small island. Otherwise
  // the native bitmap's page fill (#f5f5f5) is the top layer and the pan
  // strip never shows this field.
  const aboveNative=width>0&&height>0&&cover<width*height*0.8
  const patternId=useMemo(()=>`pasteboard-${source.owner.documentId}-${source.owner.sessionEpoch}`,[source.owner.documentId,source.owner.sessionEpoch])
  return <svg className="source-opening-surface" aria-label="源文件素材预览" data-material-count={source.items.length}
    data-rendered-materials={source.images.size} data-source-owner={source.owner.documentId}
    data-source-coverage-extend={panned?'pan':undefined}
    width={width} height={height} style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none',zIndex:aboveNative?3:0}}>
    <defs>
      <pattern id={patternId} width="8" height="8" patternUnits="userSpaceOnUse">
        <rect width="8" height="8" fill={PASTEBOARD_COVERAGE[0]}/>
        <rect width="4" height="4" fill={PASTEBOARD_COVERAGE[1]}/>
        <rect x="4" y="4" width="4" height="4" fill={PASTEBOARD_COVERAGE[1]}/>
      </pattern>
    </defs>
    <rect width={width} height={height} fill={`url(#${patternId})`}/>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
      {images}
    </g>
  </svg>
}

// The full source lays out independent roots with spacing. Exclude adjacent
// pages from a page-specific view while retaining the gutter around each root.
export function sourcePageClip(boxes:readonly SourceCanvasBox[]|undefined,view:CanvasCamera,width:number,height:number) {
  if(!boxes?.length||!(width>0)||!(height>0))return undefined
  const rects:string[]=[]
  let unionL=Infinity,unionT=Infinity,unionR=-Infinity,unionB=-Infinity
  for(const b of boxes){
    const left=Math.max(0,(b.x-MATERIAL_MARGIN)*view.zoom+view.x),top=Math.max(0,(b.y-MATERIAL_MARGIN)*view.zoom+view.y)
    const right=Math.min(width,(b.x+b.width+MATERIAL_MARGIN)*view.zoom+view.x),bottom=Math.min(height,(b.y+b.height+MATERIAL_MARGIN)*view.zoom+view.y)
    if(!(right>left)||!(bottom>top))continue
    unionL=Math.min(unionL,left);unionT=Math.min(unionT,top);unionR=Math.max(unionR,right);unionB=Math.max(unionB,bottom)
    if(boxes.length!==1)rects.push(`M${left} ${top}H${right}V${bottom}H${left}Z`)
  }
  // A zoomed-out artboard is a small island. Clipping the native surface to
  // it leaves the pasteboard as the workspace gray, so a pan exposes a solid
  // #f5f5f5 strip no matter what the coarse tile painted.
  if(!(unionR>unionL)||!(unionB>unionT)||(unionR-unionL)*(unionB-unionT)<width*height*0.8)return undefined
  if(unionL===0&&unionT===0&&unionR===width&&unionB===height)return undefined
  if(boxes.length===1)return `inset(${unionT}px ${width-unionR}px ${height-unionB}px ${unionL}px)`
  return rects.length?`path("${rects.join(' ')}")`:undefined
}
