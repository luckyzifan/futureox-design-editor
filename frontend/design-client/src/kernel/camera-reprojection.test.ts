// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { CameraReprojection, keepCompleteCameraBacking } from './camera-reprojection'
const worlds:JSDOM[]=[]
afterEach(()=>{worlds.splice(0).forEach(dom=>dom.window.close());vi.unstubAllGlobals()})
function fixture(){
 const dom=new JSDOM('<div><canvas></canvas></div>');worlds.push(dom);vi.stubGlobal('document',dom.window.document)
 const host=document.querySelector('div')!,canvas=document.querySelector('canvas')!,projection=new CameraReprojection(canvas,host)
 const backing={presentationId:'accepted',view:{x:10,y:20,zoom:1},width:100,height:80,dpr:2,interaction:false,ids:[1]}
 return{host,canvas,projection,backing}
}
test('partial white tile deliveries cannot replace a complete reprojectable image',()=>{
 const {backing}=fixture(),next={...backing,preview:true,view:{x:42,y:20,zoom:2}}
 expect(keepCompleteCameraBacking(backing,next,true)).toBe(true)
 expect(keepCompleteCameraBacking(backing,{...next,preview:false},true)).toBe(false)
 expect(keepCompleteCameraBacking(undefined,next,true)).toBe(false)
 expect(keepCompleteCameraBacking({...backing,preview:true},next,true)).toBe(false)
 expect(keepCompleteCameraBacking(backing,next,false)).toBe(false)
 expect(keepCompleteCameraBacking(backing,{...next,interaction:true},true)).toBe(false)
})
test('a zoom burst keeps the wide image through reversal and accepts exact detail after it settles',()=>{
 const {backing}=fixture(),narrow={...backing,view:{x:-40,y:-20,zoom:2}}
 expect(keepCompleteCameraBacking(backing,narrow,true,true)).toBe(true)
 expect(keepCompleteCameraBacking(backing,narrow,true,false,narrow)).toBe(false)
 expect(keepCompleteCameraBacking(backing,narrow,true,false,backing)).toBe(true)
 expect(keepCompleteCameraBacking(narrow,backing,true,true)).toBe(false)
 expect(keepCompleteCameraBacking(backing,narrow,false,true)).toBe(false)
})
test('zoom quiet timer requests a final cohort and disposal cancels late work',()=>{
 vi.useFakeTimers()
 try{
  const f=fixture(),settled=vi.fn(),projection=new CameraReprojection(f.canvas,f.host,settled)
  projection.update(f.backing,f.backing.view,100,80,true)
  projection.update(f.backing,{...f.backing.view,zoom:2},100,80,true)
  vi.advanceTimersByTime(60);expect(projection.zooming).toBe(true)
  projection.update(f.backing,{...f.backing.view,zoom:1},100,80,true)
  vi.advanceTimersByTime(79);expect(settled).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1);expect(settled).toHaveBeenCalledOnce();expect(projection.zooming).toBe(false)
  projection.update(f.backing,{...f.backing.view,zoom:3},100,80,true);projection.dispose()
  vi.advanceTimersByTime(100);expect(settled).toHaveBeenCalledOnce()
 }finally{vi.useRealTimers()}
})
test('camera motion does not wait for worker completion and marks only newly exposed strips',()=>{
 const f=fixture(),view={x:30,y:25,zoom:1}
 expect(f.projection.update(f.backing,view,100,80,true)).toEqual({active:true,changed:true})
 expect(f.canvas.style.transform).toBe('translate(20px, 5px) scale(1)')
 expect(f.canvas.style.width).toBe('100px')
 const gaps=[...f.host.querySelectorAll('div')].filter(e=>e.style.display!=='none')
 expect(gaps.map(e=>[e.style.left,e.style.top,e.style.width,e.style.height])).toEqual([
  ['0px','0px','20px','80px'],['20px','0px','80px','5px']])
 expect(f.projection.update(f.backing,view,100,80,true).changed).toBe(false)
 expect(f.backing.view).toEqual({x:10,y:20,zoom:1})
})
test('cold zoom-out keeps the visible image until real pixels cover newly exposed artwork', () => {
 const f=fixture(), bounds={x:0,y:0,width:400,height:400}
 const backing={...f.backing,view:{x:0,y:0,zoom:1}}, target={x:25,y:20,zoom:0.5}
 f.projection.update(backing,backing.view,100,80,true,bounds)
 f.projection.update(backing,target,100,80,true,bounds)
 expect(f.canvas.style.transform).toBe('')
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(backing.view)
 // White pasteboard outside the actual page does not hold back navigation.
 f.projection.update(backing,target,100,80,true,{x:0,y:0,width:100,height:80})
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(target)
 f.projection.dispose()
})

test('a lower-density navigation preview still follows horizontal and upward wheel cameras',()=>{
 const f=fixture(),backing={...f.backing,preview:true,dpr:1,view:{x:0,y:0,zoom:.25}}
 f.projection.update(backing,backing.view,100,80,true)
 const target={x:-32,y:32,zoom:.25}
 f.projection.update(backing,target,100,80,true)
 expect(f.canvas.style.transform).toBe('translate(-32px, 32px) scale(1)')
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(target)
 f.projection.dispose()
})

test('a late worker camera is reprojected to the current view, and exact arrival clears the projection',()=>{
 const f=fixture(),view={x:42,y:20,zoom:1}
 f.projection.update(f.backing,view,100,80,true)
 f.projection.update({...f.backing,view:{x:26,y:20,zoom:1}},view,100,80,true)
 expect(f.canvas.style.transform).toBe('translate(16px, 0px) scale(1)')
 expect(f.projection.update({...f.backing,view},view,100,80,true).active).toBe(false)
 expect(f.canvas.style.transform).toBe('')
 expect([...f.host.querySelectorAll('div')].every(e=>e.style.display==='none')).toBe(true)
})
test('a context or editing boundary removes the preview and keeps ordinary authored transparency',()=>{
 const f=fixture(),view={x:140,y:20,zoom:1}
 f.projection.update(f.backing,view,120,80,true)
 expect(f.host.querySelector('div')?.style.width).toBe('120px')
 expect(f.projection.update(f.backing,view,120,80,false).active).toBe(false)
 expect(f.canvas.style.transform).toBe('');expect(f.canvas.style.width).toBe('120px')
 expect([...f.host.querySelectorAll('div')].every(e=>e.style.display==='none')).toBe(true)
 f.projection.dispose();expect(f.host.children).toHaveLength(1)
})

test('new pan strips can publish without painting a white block over a known part of the old image', () => {
  const {backing} = fixture()
  const view = {x:backing.view.x-30,y:backing.view.y,zoom:1}
  const next = {...backing,view,preview:true}
  // The 100 CSS pixel source moves left by 30. Pixels 0..69 still exist.
  expect(keepCompleteCameraBacking(backing,{...next,previewGaps:[{x:180,y:0,width:20,height:160}]},true,false,next)).toBe(false)
  expect(keepCompleteCameraBacking(backing,{...next,previewGaps:[{x:80,y:0,width:20,height:160}]},true,false,next)).toBe(true)
  expect(keepCompleteCameraBacking(backing,{...next,previewGaps:[{x:80,y:0,width:20,height:160}]},true,false,next,backing)).toBe(false)
})

test('an installed thumbnail underlay follows zoom-out immediately and stays visible in new strips',()=>{
 const f=fixture(),backing={...f.backing,view:{x:0,y:0,zoom:1}},bounds={x:0,y:0,width:400,height:400}
 f.projection.update(backing,backing.view,100,80,true,bounds,true)
 const target={x:25,y:20,zoom:.5}
 expect(f.projection.update(backing,target,100,80,true,bounds,true).active).toBe(true)
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(target)
 expect([...f.host.querySelectorAll('div')].filter(e=>e.style.display==='block')).toHaveLength(0)
 f.projection.dispose()
})
