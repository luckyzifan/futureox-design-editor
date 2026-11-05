// @vitest-environment jsdom
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {expect,test,vi} from 'vitest'
import {SourceMaterialHover} from './SourceMaterialHover'
import {SpatialIndex} from './geometry'
import type {SourceCanvasItem} from './desktop'

test('the source hover follows the frontmost material, the camera and pointer ownership',async()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>setTimeout(()=>cb(0),1))
  vi.stubGlobal('cancelAnimationFrame',clearTimeout)
  const host=document.createElement('div');document.body.append(host)
  host.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:160,height:100,right:160,bottom:100,toJSON(){}})
  const root=createRoot(host),ref={current:host}
  const material=(id:string,x:number,width:number):SourceCanvasItem=>{
    const placed={x,y:0,width,height:80};return {id,key:id,name:id,kind:'artboard',pageId:'p',pageName:'P',bytes:1,placed,source:placed}
  }
  const rows=[material('back',0,100),material('front',42,28)]
  const index=new SpatialIndex(rows.map(row=>({id:row.id,bounds:row.placed,row})))
  const pick=(p:{x:number;y:number})=>index.query({...p,width:0,height:0}).at(-1)?.row
  const draw=(zoom:number,panning=false)=>act(()=>root.render(<SourceMaterialHover host={ref} view={{zoom,x:0,y:0}} panning={panning} chromeSelector="button" pick={pick}/>))
  const hovered=()=>host.querySelector('[data-testid="source-hover-outline"]')?.getAttribute('data-material-id')
  const move=(x:number,y:number)=>{host.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:x,clientY:y}));vi.advanceTimersByTime(4)}
  try{
    await draw(1);move(55,40);expect(hovered()).toBe('front')
    await draw(2);vi.advanceTimersByTime(4);expect(hovered()).toBe('back')
    host.dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,buttons:1}));expect(hovered()).toBeNull()
    await draw(2,true);move(55,40);expect(hovered()).toBeNull()
    await draw(1);move(140,50);expect(hovered()).toBeNull()
    move(55,40);host.dispatchEvent(new MouseEvent('pointerleave'));expect(hovered()).toBeNull()
  }finally{await act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals()}
})

test('a late layer hit cannot restore an outline after moving to empty canvas',async()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('requestAnimationFrame',(cb:FrameRequestCallback)=>setTimeout(()=>cb(0),1));vi.stubGlobal('cancelAnimationFrame',clearTimeout)
  const host=document.createElement('div');document.body.append(host)
  host.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:160,height:100,right:160,bottom:100,toJSON(){}})
  const root=createRoot(host),ref={current:host}
  const placed={x:0,y:0,width:70,height:80},row={id:'art',key:'k',name:'art',kind:'artboard',pageId:'p',pageName:'P',bytes:1,placed,source:placed}
  let release!:(v:import('./source-hover-detail').SourceHitReply)=>void
  const detail={pick:vi.fn(()=>new Promise<import('./source-hover-detail').SourceHitReply>(r=>{release=r}))}
  const move=(x:number)=>{host.dispatchEvent(new MouseEvent('pointermove',{bubbles:true,clientX:x,clientY:12}));vi.advanceTimersByTime(3)}
  const outline=()=>host.querySelector('[data-testid="source-hover-outline"]')?.getAttribute('data-node-id')
  const response={hit:{nodeId:'label',corners:[{x:10,y:10},{x:25,y:10},{x:25,y:18},{x:10,y:18}]}}
  try{
    await act(()=>root.render(<SourceMaterialHover host={ref} view={{x:0,y:0,zoom:1}} panning={false} chromeSelector="button" detail={detail} pick={p=>p.x<70?row:undefined}/>))
    move(20);expect(outline()).toBe('art');move(120)
    release(response);await vi.advanceTimersByTimeAsync(5);expect(outline()).toBeNull()
    move(22);release(response);await vi.advanceTimersByTimeAsync(5);expect(outline()).toBe('label')
    expect(detail.pick).toHaveBeenCalledTimes(2)
  }finally{await act(()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals()}
})
