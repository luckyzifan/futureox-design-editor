// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { CameraReprojection, keepCompleteCameraBacking } from './camera-reprojection'
import { NavigationBacking, NAVIGATION_BACKING_BYTES } from './navigation-backing'
import { zoomOutBeyondPreview } from './tile-preview'
const worlds:JSDOM[]=[]
afterEach(()=>{worlds.splice(0).forEach(dom=>dom.window.close());vi.unstubAllGlobals()})
function fixture(){
 const dom=new JSDOM('<div><canvas></canvas></div>');worlds.push(dom);vi.stubGlobal('document',dom.window.document)
 const host=document.querySelector('div')!,canvas=document.querySelector('canvas')!,projection=new CameraReprojection(canvas,host)
 const backing={presentationId:'accepted',view:{x:10,y:20,zoom:1},width:100,height:80,dpr:2,interaction:false,ids:[1]}
 return{host,canvas,projection,backing}
}
test('a 3200% preview still shows the retained wide page, and later narrow captures do not erase it', () => {
  const dom = new JSDOM('<main></main>')
  worlds.push(dom)
  vi.stubGlobal('document', dom.window.document)
  vi.spyOn(dom.window.HTMLCanvasElement.prototype as { getContext(kind: '2d'): CanvasRenderingContext2D | null }, 'getContext')
    .mockReturnValue({ clearRect() {}, drawImage() {} } as unknown as CanvasRenderingContext2D)
  const host = document.querySelector('main')!
  const backing = new NavigationBacking(host)
  const page = { x: 0, y: 0, width: 400, height: 200 }
  const source = document.createElement('canvas')
  source.width = 200
  source.height = 100
  const base = { dpr: 1, interaction: false, ids: [1], preview: false, navigationBackingBytes: NAVIGATION_BACKING_BYTES, width: 200, height: 100 }
  backing.bind({})
  backing.capture(source, { ...base, view: { x: 0, y: 0, zoom: 1 } }, page)
  backing.show({ ...base, view: { x: 0, y: 0, zoom: 32 }, preview: true }, { view: { x: 0, y: 0, zoom: 1 }, width: 200, height: 100 })
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('block')
  backing.show({ ...base, view: { x: 0, y: 0, zoom: 32 }, preview: true }, { view: { x: 40, y: -10, zoom: .25 }, width: 200, height: 100 })
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('block')
  for (let i = 0; i < 20; i++) backing.capture(source, { ...base, view: { x: i, y: 0, zoom: 32 } }, page)
  const crop = { ...base, view: { x: 0, y: 0, zoom: 32 } }
  expect(backing.canProject(crop, { view: { x: 0, y: 0, zoom: 1 }, width: 200, height: 100 }, page)).toBe(true)
  expect(backing.canProject(crop, { view: { x: 30, y: 10, zoom: .25 }, width: 200, height: 100 }, page)).toBe(true)
  backing.dispose()
})

test('3200% back to 100% and 25% is outside the preview ratio, and a same-zoom pan is not', () => {
  expect(zoomOutBeyondPreview(32, 1)).toBe(true)
  expect(zoomOutBeyondPreview(32, .25)).toBe(true)
  expect(zoomOutBeyondPreview(2, 1)).toBe(false)
  expect(zoomOutBeyondPreview(1, 32)).toBe(false)
  expect(zoomOutBeyondPreview(Number.NaN, 1)).toBe(false)
})

test('returning from 3200% keeps the wide page in the margin instead of a gray plate', () => {
  const dom = new JSDOM('<div><canvas></canvas></div>')
  worlds.push(dom)
  vi.stubGlobal('document', dom.window.document)
  vi.spyOn(dom.window.HTMLCanvasElement.prototype as { getContext(kind: '2d'): CanvasRenderingContext2D | null }, 'getContext')
    .mockReturnValue({ clearRect() {}, drawImage() {} } as unknown as CanvasRenderingContext2D)
  const host = document.querySelector('div')!
  const canvas = document.querySelector('canvas')!
  const projection = new CameraReprojection(canvas, host)
  const bounds = { x: 0, y: 0, width: 400, height: 300 }
  const wide = {
    presentationId: 'wide', view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 80, dpr: 1,
    interaction: false, ids: [1], preview: false, navigationBackingBytes: NAVIGATION_BACKING_BYTES,
  }
  canvas.width = 80
  canvas.height = 60
  projection.history.bind({})
  projection.history.capture(canvas, wide, bounds)
  const crop = { ...wide, presentationId: 'crop', view: { x: 0, y: 0, zoom: 32 }, preview: true }
  projection.update(crop, crop.view, 100, 80, true, bounds)
  projection.update(crop, { x: 10, y: -4, zoom: 1 }, 100, 80, true, bounds)
  const plates = [...host.querySelectorAll('div')].filter(element => element.style.background === 'rgb(245, 245, 245)' && element.style.display === 'block')
  expect(plates).toHaveLength(0)
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('block')
  expect(canvas.style.visibility).not.toBe('hidden')
  projection.update(crop, { x: 40, y: 8, zoom: .25 }, 100, 80, true, bounds)
  expect([...host.querySelectorAll('div')].filter(element => element.style.background === 'rgb(245, 245, 245)' && element.style.display === 'block')).toHaveLength(0)
  expect(host.querySelector<HTMLElement>('[data-camera-history]')?.style.display).toBe('block')
  // A same-zoom pan still paints the new strip.
  const panned = projection.update(wide, { x: 30, y: 0, zoom: 1 }, 100, 80, true)
  expect(panned.active).toBe(true)
  expect([...host.querySelectorAll('div')].some(element => element.style.background === 'rgb(245, 245, 245)' && element.style.display === 'block')).toBe(true)
  projection.dispose()
})

test('a low-zoom fit does not replace a complete image with a gapped preview', () => {
  const {backing} = fixture()
  const fitted = {...backing, view:{x:0,y:0,zoom:0.15}, preview:true, previewGaps:[{x:10,y:10,width:40,height:30}]}
  expect(keepCompleteCameraBacking(backing, fitted, true)).toBe(true)
  expect(keepCompleteCameraBacking(backing, {...fitted, preview:false, previewGaps:undefined}, true)).toBe(false)
  expect(keepCompleteCameraBacking(undefined, fitted, true)).toBe(false)
})

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
 expect(gaps.every(e=>e.style.background==='rgb(245, 245, 245)')).toBe(true)
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

test('a large pan after a cold zoom-out slides the retained image with the input', () => {
  const f = fixture(), bounds = { x: 0, y: 0, width: 400, height: 400 }
  const backing = { ...f.backing, view: { x: 0, y: 0, zoom: 1 } }
  const shrunk = { x: 25, y: 20, zoom: 0.5 }
  f.projection.update(backing, backing.view, 100, 80, true, bounds)
  f.projection.update(backing, shrunk, 100, 80, true, bounds)
  expect(f.canvas.style.transform).toBe('')
  const panned = { x: 85, y: 20, zoom: 0.5 }
  f.projection.update(backing, panned, 100, 80, true, bounds)
  expect(f.canvas.style.transform).toBe('translate(60px, 0px) scale(1)')
  expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual({ x: 60, y: 0, zoom: 1 })
  f.projection.update(backing, { x: 90, y: 15, zoom: 0.5 }, 100, 80, true, bounds)
  expect(f.canvas.style.transform).toBe('translate(65px, -5px) scale(1)')
  // A further zoom inside the pin keeps the pan already followed.
  f.projection.update(backing, { x: 90, y: 15, zoom: 0.6 }, 100, 80, true, bounds)
  expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual({ x: 65, y: -5, zoom: 1 })
  expect(f.canvas.style.transform).toBe('translate(65px, -5px) scale(1)')
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

test('a late zoom-out bitmap preserves the displayed camera while wider coverage is cold',()=>{
 const f=fixture(),bounds={x:0,y:0,width:400,height:400}
 const backing={...f.backing,view:{x:0,y:0,zoom:2}},target={x:0,y:0,zoom:1}
 f.projection.update(backing,backing.view,100,80,true,bounds)
 f.projection.update(backing,target,100,80,true,bounds)
 // The worker completes intermediate cameras after the user has already
 // zoomed farther out. Those bitmaps cover the held view, not the target.
 for(const zoom of [1.75,1.5,1.25]){
  const late={...backing,view:{x:0,y:0,zoom}}
  f.projection.update(late,target,100,80,true,bounds)
  expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(backing.view)
  expect(f.canvas.style.transform).toBe(`translate(0px, 0px) scale(${2/zoom})`)
 }
 f.projection.update({...backing,view:target},target,100,80,true,bounds)
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(target)
 expect(f.canvas.style.transform).toBe('')
 f.projection.dispose()
})

test('a late bitmap cannot hold a camera whose artwork it does not cover',()=>{
 const f=fixture(),bounds={x:0,y:0,width:400,height:400}
 const backing={...f.backing,view:{x:0,y:0,zoom:2}},target={x:0,y:0,zoom:1}
 f.projection.update(backing,backing.view,100,80,true,bounds)
 const late={...backing,view:{x:-100,y:0,zoom:1.5}}
 f.projection.update(late,target,100,80,true,bounds)
 expect(JSON.parse(f.canvas.dataset.projectedCamera!)).toEqual(late.view)
 expect(f.canvas.style.transform).toBe('')
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

test('a stretched zoom keeps a gapped preview and shows a covering underlay', () => {
  const low = { presentationId: 'low', view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 80, dpr: 2, interaction: false, ids: [1] }
  const far = { ...low, presentationId: 'far', view: { x: 0, y: 0, zoom: 8 }, preview: true }
  const live = { view: far.view, width: 100, height: 80 }
  expect(keepCompleteCameraBacking(low, far, true, true, live)).toBe(true)
  expect(keepCompleteCameraBacking(low, { ...far, zoomUnderlay: true }, true, true, live)).toBe(false)
  expect(keepCompleteCameraBacking(low, { ...far, zoomUnderlay: true, previewGaps: [{ x: 0, y: 0, width: 4, height: 4 }] }, true, true, live)).toBe(true)
  const missed = { ...far, zoomUnderlay: true, view: { x: -400, y: -300, zoom: 8 } }
  expect(keepCompleteCameraBacking(low, missed, true, true, live)).toBe(true)
})

test('continuous zoom accepts a covering sharper frame and refuses a late coarser snap-back', () => {
  const low = { presentationId: 'low', view: { x: 0, y: 0, zoom: 1 }, width: 100, height: 80, dpr: 2, interaction: false, ids: [1] }
  const high = { ...low, presentationId: 'high', view: { x: 0, y: 0, zoom: 2 } }
  const live = { view: high.view, width: 100, height: 80 }
  expect(keepCompleteCameraBacking(low, high, true, true, live)).toBe(false)
  const missed = { ...high, view: { x: -400, y: -300, zoom: 2 } }
  expect(keepCompleteCameraBacking(low, missed, true, true, live)).toBe(true)
  expect(keepCompleteCameraBacking(high, low, true, true, live)).toBe(true)
  const wide = { ...low, presentationId: 'wide', width: 200, height: 160 }
  const wideLive = { view: wide.view, width: 200, height: 160 }
  expect(keepCompleteCameraBacking(high, wide, true, true, wideLive)).toBe(false)
})

test('a 3200% crop cannot replace a covering low-zoom frame, and the covering frame can replace the crop',()=>{
 const wide={presentationId:'wide',view:{x:0,y:0,zoom:1},width:800,height:600,dpr:2,interaction:false,ids:[1]}
 const crop={...wide,presentationId:'crop',view:{x:-12000,y:-9000,zoom:32}}
 const live={view:wide.view,width:wide.width,height:wide.height}
 expect(keepCompleteCameraBacking(wide,crop,true,false,live)).toBe(true)
 expect(keepCompleteCameraBacking(crop,wide,true,false,live)).toBe(false)
 expect(keepCompleteCameraBacking(wide,{...crop,preview:true},true)).toBe(true)
})

test('a scale jump requests the exact frame without ending the gesture hold',()=>{
 vi.useFakeTimers()
 try{
  const f=fixture(),settled=vi.fn(),projection=new CameraReprojection(f.canvas,f.host,settled)
  const high={...f.backing,view:{x:0,y:0,zoom:32}}
  projection.update(high,high.view,100,80,true)
  projection.update(high,{x:10,y:20,zoom:1},100,80,true)
  expect(projection.zooming).toBe(true)
  vi.advanceTimersByTime(0)
  expect(settled).toHaveBeenCalledOnce()
  expect(projection.zooming).toBe(true)
  vi.advanceTimersByTime(79)
  expect(projection.zooming).toBe(true)
  vi.advanceTimersByTime(1)
  expect(projection.zooming).toBe(false)
  expect(settled).toHaveBeenCalledTimes(2)
  projection.dispose()
 }finally{vi.useRealTimers()}
})

test('an exact frame discarded during a jump is retried when the gesture hold ends',()=>{
 vi.useFakeTimers()
 const f=fixture(),target={view:{x:0,y:0,zoom:1},width:100,height:80}
 const low={...f.backing,view:{x:0,y:0,zoom:.2}},middle={...f.backing,view:{x:0,y:0,zoom:.9}},exact={...f.backing,view:{...target.view}}
 let displayed=low
 let projection:CameraReprojection
 const receive=(next:typeof low)=>{
  if(keepCompleteCameraBacking(displayed,next,true,projection.zooming,target))return
  displayed=next;projection.update(displayed,target.view,100,80,true)
 }
 projection=new CameraReprojection(f.canvas,f.host,()=>{setTimeout(()=>receive(exact),1)})
 try{
  projection.update(low,low.view,100,80,true)
  projection.update(low,target.view,100,80,true)
  setTimeout(()=>receive(middle),0)
  vi.advanceTimersByTime(81)
  expect(displayed.view).toEqual(target.view)
  expect(f.canvas.style.transform).toBe('')
 }finally{projection.dispose();f.projection.dispose();vi.useRealTimers()}
})

test('disposing a jumping camera cancels the delayed presenter retry',()=>{
 vi.useFakeTimers()
 const f=fixture(),settled=vi.fn(),projection=new CameraReprojection(f.canvas,f.host,settled)
 try{
  projection.update(f.backing,f.backing.view,100,80,true)
  projection.update(f.backing,{x:0,y:0,zoom:8},100,80,true)
  vi.advanceTimersByTime(0)
  expect(settled).toHaveBeenCalledOnce()
  projection.dispose()
  vi.advanceTimersByTime(100)
  expect(settled).toHaveBeenCalledOnce()
 }finally{projection.dispose();f.projection.dispose();vi.useRealTimers()}
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
