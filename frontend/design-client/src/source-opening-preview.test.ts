// @vitest-environment jsdom
import {act,createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,test,vi} from 'vitest'
import {SourceOpeningSurface,sourcePageClip,useSourceOpening,visibleMaterialDetail,type OpeningView,type SourceThumbnailCoverage} from './source-opening-preview'

const items=Array.from({length:36},(_,i)=>{
  const rect={x:(i%6)*120,y:Math.floor(i/6)*120,width:100,height:80}
  return {key:'preview-'+i,id:'r'+i,name:'Material '+i,kind:'artboard',pageId:i<18?'A':'B',pageName:'Page',source:rect,placed:rect,bytes:9000}
})
const source:OpeningView={owner:{documentId:'a',sessionEpoch:1},bounds:{x:0,y:0,width:700,height:680},pages:[['A','A',18],['B','B',18]],items,
  images:new Map(items.map((_,i)=>[i,'rendered'])),finished:true,cacheHit:false,rendered:36}
test('a zoomed-out artboard does not clip the native surface down to the thumbnail',()=>{
  const artboard={x:0,y:0,width:1900,height:1060}
  const view={x:460,y:300,zoom:0.07}
  expect(sourcePageClip([artboard],view,1000,700)).toBeUndefined()
  expect(sourcePageClip([{x:0,y:0,width:900,height:700}],{x:0,y:0,zoom:1},1000,800)).toContain('inset(')
})

test('a fit overview schedules no exact scene; a close view prepares only visible roots of its page',()=>{
  expect(visibleMaterialDetail(source,{x:20,y:10,zoom:0.8},800,600,2)).toEqual([])
  expect(visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'A',0)).toEqual([0])
  const selected=visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'A')
  expect(selected).toContain(0);expect(selected.length).toBeLessThan(18)
  expect(visibleMaterialDetail(source,{x:0,y:0,zoom:4},800,600,2,'B')).toEqual([])
})
test('an unavailable thumbnail can be repaired without preparing the other materials',()=>{
  const images=new Map(source.images);images.delete(3)
  expect(visibleMaterialDetail({...source,images},{x:20,y:10,zoom:0.8},800,600,2)).toEqual([3])
})

test('a large catalogue only vouches for loaded artwork within its mounted window',async()=>{
 const host=document.createElement('div'),root=createRoot(host)
 const coverage:SourceThumbnailCoverage={current:undefined}
 const many=Array.from({length:600},(_,i)=>({...items[0],id:String(i),placed:{x:i*200,y:0,width:80,height:80}}))
 const catalogue={...source,items:many,images:new Map(many.map((_,i)=>[i,'image-'+i]))}
 const view={x:0,y:0,zoom:1}
 const draw=(x:number)=>act(()=>root.render(createElement(SourceOpeningSurface,{source:catalogue,view:{...view,x},width:100,height:100,coverage})))
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 try{
   await draw(0)
   const first=host.querySelector('image')!
   expect(host.querySelectorAll('image')).toHaveLength(1)
   expect(coverage.current?.(view,100,100)).toBe(false)
   await act(()=>{first.dispatchEvent(new Event('load'))})
   expect(coverage.current?.(view,100,100)).toBe(true)
   // The first decoded board can suppress a progress label. The next board
   // is outside the mounted window and cannot authorize a full reprojection.
   expect(coverage.current?.(view,320,100,'any')).toBe(true)
   expect(coverage.current?.(view,320,100)).toBe(false)
   expect(coverage.current?.({...view,x:-1000},100,100,'any')).toBe(false)
   expect(coverage.current?.({...view,x:-1000},100,100)).toBe(false)
   await draw(-10)
   expect(host.querySelector('image')).toBe(first)
   await draw(-1000)
   expect(coverage.current?.({...view,x:-1000},100,100)).toBe(false)
 }finally{await act(()=>root.unmount());vi.unstubAllGlobals()}
})

test('a finished base catalogue continues to receive sharper images for several visible boards',async()=>{
 const host=document.createElement('div'),root=createRoot(host)
 vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 vi.stubGlobal('Image',class {src='';decode(){return Promise.resolve()}})
 const owner=source.owner,images=[{index:0,png:'base0'},{index:1,png:'base1'}]
 const calls:number[]=[]
 const openingView=async({offset,cursor,detailCursor=0}:{offset:number;cursor:number;detailCursor?:number})=>{
   calls.push(detailCursor)
   return {status:'ok',phase:'available',owner,revision:0,bounds:source.bounds,total:2,offset,items:offset?[]:items.slice(0,2),
     pages:[],nextOffset:2,cursor:2,images:cursor?[]:images,moreImages:false,finished:true,rendered:2,cacheHit:true,
     indexing:detailCursor<2,detail:cursor&&detailCursor<2?{index:detailCursor,png:'fine'+detailCursor}:undefined}
 }
 const bridge={openingView} as unknown as import('./desktop').LargeDocumentBridge
 function Probe(){const q=useSourceOpening(bridge,1);return createElement('div',null,[...(q.view?.images.values()??[])].join('|'))}
 try{
   await act(()=>root.render(createElement(Probe)))
   await act(()=>vi.advanceTimersByTimeAsync(500))
   expect(host.textContent).toBe('data:image/png;base64,fine0|data:image/png;base64,fine1')
   expect(calls.at(-1)).toBe(2)
 }finally{await act(()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals()}
})

test('completed catalogues wake again and accept a rolling detail cursor beyond sixteen',async()=>{
  const host=document.createElement('div'),root=createRoot(host)
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('Image',class {src='';decode(){return Promise.resolve()}})
  let wake:ReturnType<typeof useSourceOpening>['setViewport']|undefined
  let shifted=false,calls=0
  const bridge={openingView:async({offset,cursor,detailCursor=0}:{offset:number;cursor:number;detailCursor?:number})=>{
    calls++
    const detail=shifted&&detailCursor<17?{index:1,png:'nearby'}:undefined
    return {status:'ok',phase:'available',owner:source.owner,revision:0,bounds:source.bounds,total:2,offset,items:offset?[]:items.slice(0,2),
      pages:[],nextOffset:2,cursor:2,images:cursor?[]:[{index:0,png:'a'},{index:1,png:'b'}],moreImages:false,finished:true,rendered:2,cacheHit:true,
      indexing:false,detail,detailBase:shifted?16:0,nextDetailCursor:detail?17:Math.max(detailCursor,shifted?16:0),detailPending:false}
  }} as unknown as import('./desktop').LargeDocumentBridge
  function Probe(){const q=useSourceOpening(bridge,1);wake=q.setViewport;return createElement('div',null,q.view?.images.get(1))}
  try{
    await act(()=>root.render(createElement(Probe)))
    const before=calls
    await act(()=>vi.advanceTimersByTimeAsync(1000))
    expect(calls).toBe(before)
    shifted=true
    await act(()=>{wake?.({x:40,y:10,width:100,height:100},1)})
    await act(()=>vi.advanceTimersByTimeAsync(200))
    expect(host.textContent).toBe('data:image/png;base64,nearby')
    const idle=calls
    await act(()=>vi.advanceTimersByTimeAsync(1000))
    expect(calls).toBe(idle)
  }finally{await act(()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals()}
})
