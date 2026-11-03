import {useCallback,useEffect, useRef, useState} from 'react'
import type {CanvasCamera} from './canvas-camera'
import type {LargeDocumentBridge, LargeDocumentOwner, OpeningPage, SourceCanvasBox, SourceCanvasItem} from './desktop'

export type OpeningView = {
  owner:LargeDocumentOwner; bounds:SourceCanvasBox; items:SourceCanvasItem[]; pages:OpeningPage[];
  images:ReadonlyMap<number,string>; finished:boolean; cacheHit:boolean; rendered:number
}
export function useSourceOpening(bridge:LargeDocumentBridge, generation:number|undefined) {
  const [value,setValue]=useState<{generation:number;view:OpeningView}>()
  const priority=useRef<{pageId?:string;material?:number;viewport?:SourceCanvasBox}>({})
  const wake=useRef<()=>void>(()=>{})
  useEffect(()=>{
    if(generation===undefined || !bridge.openingView)return
    const read=bridge.openingView.bind(bridge)
    let failures=0,live=true, inFlight=false, timer:ReturnType<typeof setTimeout>|undefined
    let owner:LargeDocumentOwner|undefined, pages:OpeningPage[]=[], cursor=0
    const items:SourceCanvasItem[]=[], images=new Map<number,string>()
    const poll=async()=>{
      if(!live||inFlight)return
      clearTimeout(timer);inFlight=true
      let delay=65
      try {
        const reply=await read({owner,offset:items.length,cursor,...priority.current})
        if(!live)return
        if(reply.status==='error')throw Error(reply.message)
        failures=0
        if(reply.status==='ok' && reply.phase==='unavailable' || reply.status==='cancelled' && owner){setValue(undefined);live=false;return}
        if(reply.status==='ok' && reply.phase==='available'){
          if(owner&&(owner.documentId!==reply.owner.documentId||owner.sessionEpoch!==reply.owner.sessionEpoch))return
          owner=reply.owner; if(reply.pages)pages=reply.pages
          if(reply.offset!==items.length || reply.cursor!==cursor+reply.images.length)throw Error('Invalid material preview batch')
          items.push(...reply.items);cursor=reply.cursor
          for(const {index,png} of reply.images) images.set(index,'data:image/png;base64,'+png)
          if(items.length===reply.total && (reply.items.length || reply.images.length || reply.finished || !reply.total))
            setValue({generation,view:{owner,bounds:reply.bounds,items,pages,images:new Map(images),finished:reply.finished,cacheHit:reply.cacheHit,rendered:reply.rendered}})
          if(reply.finished&&items.length===reply.total){live=false;return}
          if(items.length<reply.total||reply.moreImages)delay=0
          else if(!reply.images.length)delay=200
        }
      }catch {
        delay=250
        if(++failures>=3 && live){live=false;setValue(undefined)}
      }
      finally {inFlight=false;if(live)timer=setTimeout(()=>void poll(),delay)}
    }
    priority.current={};wake.current=()=>{if(live)void poll()};void poll()
    return()=>{live=false;clearTimeout(timer);wake.current=()=>{}}
  },[bridge,generation])
  const setViewport=useCallback((viewport:SourceCanvasBox)=>{
    const old=priority.current.viewport
    if(old?.x===viewport.x&&old.y===viewport.y&&old.width===viewport.width&&old.height===viewport.height)return
    priority.current={...priority.current,viewport};wake.current()
  },[])
  return {setViewport,view:value?.generation===generation?value?.view:undefined,
    focus:(pageId?:string,material?:number)=>{priority.current={pageId,material};wake.current()}}
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
export function SourceOpeningSurface({source,view,width,height,pageId,focused,onDetail,onViewport}:{
  source:OpeningView;view:CanvasCamera;width:number;height:number;pageId?:string;focused?:number
  onDetail?:(roots:number[])=>void;onViewport?:(box:SourceCanvasBox)=>void
}) {
  useEffect(()=>{
    if(!onDetail||!width||!height)return
    const timer=setTimeout(()=>{
      onViewport?.({x:-view.x/view.zoom,y:-view.y/view.zoom,width:width/view.zoom,height:height/view.zoom})
      onDetail(visibleMaterialDetail(source,view,width,height,window.devicePixelRatio||1,pageId,focused))
    },120)
    return()=>clearTimeout(timer)
  },[source.items,view.x,view.y,view.zoom,width,height,pageId,focused,onDetail,onViewport,source.finished])
  return <svg className="source-opening-surface" aria-label="源文件素材预览" data-material-count={source.items.length}
    data-rendered-materials={source.images.size} data-source-owner={source.owner.documentId}
    width={width} height={height} style={{position:'absolute',inset:0,overflow:'hidden',pointerEvents:'none'}}>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom})`}>
      {source.items.map((item,index)=>{
        const image=source.images.get(index), b=item.placed
        if(!image || pageId&&item.pageId!==pageId || (b.x+b.width)*view.zoom+view.x<0 || (b.y+b.height)*view.zoom+view.y<0 ||
            b.x*view.zoom+view.x>width || b.y*view.zoom+view.y>height)return null
        return <image key={index} data-opening-material={index} data-opening-page={item.pageId}
          x={b.x} y={b.y} width={b.width} height={b.height} preserveAspectRatio="none" href={image}/>
      })}
    </g>
  </svg>
}

// The full source lays out independent roots with spacing. Exclude adjacent
// pages from a page-specific view while retaining the gutter around each root.
export function sourcePageClip(boxes:readonly SourceCanvasBox[]|undefined,view:CanvasCamera,width:number,height:number) {
  if(!boxes)return undefined
  const rects:string[]=[]
  for(const b of boxes){
    const left=Math.max(0,(b.x-32)*view.zoom+view.x),top=Math.max(0,(b.y-32)*view.zoom+view.y)
    const right=Math.min(width,(b.x+b.width+32)*view.zoom+view.x),bottom=Math.min(height,(b.y+b.height+32)*view.zoom+view.y)
    if(right>left&&bottom>top)rects.push(`M${left} ${top}H${right}V${bottom}H${left}Z`)
  }
  return rects.length?`path("${rects.join(' ')}")`:'inset(100%)'
}
