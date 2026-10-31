// Mounted production controller; GPU transport is mocked here. Device pixels
// and overlap timings are verified separately by the native check entry.
// @ts-expect-error jsdom is a test-only runtime dependency.
import {JSDOM} from 'jsdom'
import React,{act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import type {KernelOptions,TileResult} from './client'
import type {SourceCanvasSnapshot} from '../desktop'
import type {ResidentFrame} from './gpu/resident-presenter'
import type {RasterTile} from './tile-cache'

type Job={options:KernelOptions;signal?:AbortSignal;receive:(tile:TileResult)=>void;finish:()=>void;active:boolean}
const state=vi.hoisted(()=>({jobs:[] as Job[],frames:[] as ResidentFrame[],released:[] as number[],active:0,maxActive:0,disposed:0,phaseExact:true,motionMultiplier:1,prefetchEnabled:false}))
vi.mock('./client',()=>({backendPreference:()=> 'webgpu',renderExecutionPolicy:{desktopFullMath:true,desktopDisplay:true,cpuOnly:false,hdrCompositing:false},KernelClient:class{
 onPresentation?: (value:Record<string,unknown>)=>void
 renderSource(_source:unknown,options:KernelOptions,receive:(tile:TileResult)=>void,signal?:AbortSignal){
  if(!options.tileViewport?.length)return Promise.resolve({})
  state.active++;state.maxActive=Math.max(state.maxActive,state.active)
  return new Promise((resolve,reject)=>{
   const done=()=>{if(job.active){job.active=false;state.active--}}
   const job:Job={options,signal,receive,active:true,finish:()=>{done();resolve({})}}
   state.jobs.push(job)
   signal?.addEventListener('abort',()=>{done();reject(Error('PREVIEW_CANCELLED'))},{once:true})
  })
 }
 attachPresentation(){}
 present(frame:ResidentFrame){state.frames.push(frame);this.onPresentation?.({presented:{presentationId:frame.presentationId,view:frame.view,width:frame.width,height:frame.height,dpr:frame.dpr,ids:frame.items.map(item=>item.tile.gpuTile)}})}
 releasePresented(ids:number[]){state.released.push(...ids)}
 dispose(){state.disposed++}
}}))
vi.mock('./presentation',()=>({useDevicePixelRatio:()=>1}))
vi.mock('./canvas-raster-plan',()=>({canvasRasterPlan:(view:{zoom:number},_dpr:number,_w:number,_h:number,options:any)=>{const scale=options.samplingScale??view.zoom;return {scale,phase:{x:0,y:0},camera:{...view,zoom:scale}}},canvasRasterPhaseMatches:()=>state.phaseExact,nativeTileMotionScale:(view:{zoom:number})=>view.zoom*state.motionMultiplier}))
vi.mock('./tile-computation-key',()=>({periodicComputationCamera:(camera:unknown)=>camera,tileComputationDependsOnCamera:()=>false,tileComputationKey:(tile:RasterTile)=>tile.key}))
vi.mock('./tile-plan-aligned',()=>({planTilesWithPrefetchRim:(_bounds:unknown,zoom:number)=>({viewport:[0,1,2,3].map(index=>({key:`${zoom}:${index}`,x:(index%2)*512,y:Math.floor(index/2)*512,width:514,height:514,zoom,gutter:1,phaseX:0,phaseY:0})),rim:state.prefetchEnabled?[{key:`${zoom}:rim`,x:1024,y:0,width:514,height:514,zoom,gutter:1,phaseX:0,phaseY:0,prefetch:true}]:[],cacheLimitSkipped:0})}))
import {NativeSourceSurface,type NativeSourceStatus} from './NativeSourceSurface'

let dom:JSDOM,root:Root,frames:Map<number,FrameRequestCallback>,sequence:number,statuses:NativeSourceStatus[]
const source:SourceCanvasSnapshot={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',bytes:1000,nodes:20,roots:4,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:2000,height:2000},warnings:[],rasterProfile:'figma',colorManaged:true}
const pause=()=>new Promise(resolve=>setTimeout(resolve,5))
const draw=(view={x:0,y:0,zoom:1},snapshot=source)=>act(async()=>{root.render(<NativeSourceSurface source={snapshot} view={view} width={800} height={700} onStatus={value=>statuses.push(value)}/>);await pause()})
const deliver=(job:Job,index:number,id:number)=>job.receive({...job.options.tileViewport![index],gpuTile:id} as TileResult)
const paint=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn(performance.now()))}
beforeEach(()=>{
 dom=new JSDOM('<div id="root"></div>')
 for(const name of ['window','document','navigator'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);frames=new Map;sequence=0;statuses=[]
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{frames.set(++sequence,fn);return sequence})
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>frames.delete(id))
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:()=>({})})
 Object.assign(state,{jobs:[],frames:[],released:[],active:0,maxActive:0,disposed:0,phaseExact:true,motionMultiplier:1,prefetchEnabled:false})
 root=createRoot(document.getElementById('root')!)
})
afterEach(async()=>{await act(async()=>{root.unmount();await pause()});dom.window.close();vi.unstubAllGlobals();expect(state.active).toBe(0)})

test('two-tile batches remain single-owner and the first tile presents before the second finishes',async()=>{
 await draw();const first=state.jobs[0]
 expect(first.options.tileViewport).toHaveLength(2)
 await act(async()=>{deliver(first,0,11);paint()})
 expect(state.frames.at(-1)?.items.map(item=>item.tile.gpuTile)).toEqual([11])
 expect(statuses.some(value=>value.phase==='ready')).toBe(false)
 expect(state.jobs).toHaveLength(1)
 await act(async()=>{deliver(first,1,12);first.finish();await pause()})
 const second=state.jobs[1];expect(second.options.tileViewport).toHaveLength(2)
 expect(second.options.tileViewport?.map(tile=>tile.key)).toEqual(['1:2','1:3'])
 await act(async()=>{deliver(second,0,13);deliver(second,1,14);second.finish();await pause();paint()})
 expect(state.maxActive).toBe(1)
 expect(state.frames.at(-1)?.items.map(item=>item.tile.gpuTile).sort()).toEqual([11,12,13,14])
 expect(statuses.some(value=>value.phase==='ready'&&value.done===4&&value.total===4)).toBe(true)
})

test('a batch resolving without its second tile fails instead of certifying a partial viewport',async()=>{
 await draw();const job=state.jobs[0]
 await act(async()=>{deliver(job,0,21);job.finish();await pause();paint()})
 expect(statuses.at(-1)).toMatchObject({phase:'error',error:'源画板瓦片未返回，已保留当前画面'})
 expect(statuses.some(value=>value.phase==='ready')).toBe(false)
 expect(state.jobs).toHaveLength(1)
})

test('a camera reversal cancels the remaining batch and late tiles cannot enter the latest frame',async()=>{
 await draw();const old=state.jobs[0]
 await draw({x:0,y:0,zoom:8})
 expect(old.signal?.aborted).toBe(true)
 expect(state.jobs.at(-1)?.options.view.zoom).toBe(8)
 await act(async()=>{deliver(old,0,31);deliver(old,1,32);paint()})
 expect(state.released).toEqual([31,32])
 expect(state.frames.flatMap(frame=>frame.items).some(item=>item.tile.gpuTile===31||item.tile.gpuTile===32)).toBe(false)
 expect(state.maxActive).toBe(1)
 expect(statuses.some(value=>value.phase==='error')).toBe(false)
})

test('return to an exactly covered viewport cancels compatible-density obsolete work',async()=>{
 await draw();const a=state.jobs[0]
 await act(async()=>{deliver(a,0,71);deliver(a,1,72);a.finish();await pause()})
 const b=state.jobs[1]
 await act(async()=>{deliver(b,0,73);deliver(b,1,74);b.finish();await pause();paint()})
 const afterInitial=statuses.length
 await draw({x:0,y:0,zoom:2});const obsolete=state.jobs.at(-1)!
 expect(obsolete.active).toBe(true)
 await draw({x:0,y:0,zoom:1})
 await act(async()=>{paint();await pause()})
 expect(obsolete.signal?.aborted).toBe(true)
 expect(state.active).toBe(0)
 expect(statuses.slice(afterInitial).some(value=>value.phase==='ready'&&value.done===4)).toBe(true)
 await act(async()=>{deliver(obsolete,0,81);paint()})
 expect(state.released).toContain(81)
 expect(state.frames.at(-1)?.items.some(item=>item.tile.gpuTile===81)).toBe(false)
})

test('a completed offscreen tile does not cancel the useful tile still in the batch',async()=>{
 await draw();const job=state.jobs[0]
 await act(async()=>deliver(job,0,41))
 await draw({x:-600,y:0,zoom:1})
 expect(job.signal?.aborted).toBe(false)
 expect(state.jobs).toHaveLength(1)
})

test('hidden source canvases cancel optional work and resume only the latest demand',async()=>{
 await draw();const old=state.jobs[0]
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'})
 await act(async()=>{document.dispatchEvent(new dom.window.Event('visibilitychange'));await pause()})
 expect(old.signal?.aborted).toBe(true);const before=state.jobs.length
 await draw({x:0,y:0,zoom:8});expect(state.jobs.length).toBe(before)
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
 await act(async()=>{document.dispatchEvent(new dom.window.Event('visibilitychange'));await pause()})
 expect(state.jobs.at(-1)?.options.view.zoom).toBe(8)
 expect(state.maxActive).toBe(1)
})

test('cached coverage without an exact current phase cannot cancel compatible work',async()=>{
 await draw();const a=state.jobs[0]
 await act(async()=>{deliver(a,0,91);deliver(a,1,92);a.finish();await pause()})
 const b=state.jobs[1]
 await act(async()=>{deliver(b,0,93);deliver(b,1,94);b.finish();await pause();paint()})
 await draw({x:0,y:0,zoom:2});const useful=state.jobs.at(-1)!
 state.phaseExact=false
 await draw({x:0,y:0,zoom:1})
 expect(useful.signal?.aborted).toBe(false)
 expect(useful.active).toBe(true)
})

test('a duplicate delivery cannot release the accepted texture or count as the missing second tile',async()=>{
 await draw();const job=state.jobs[0]
 await act(async()=>{deliver(job,0,51);deliver(job,0,51);deliver(job,0,52);paint()})
 expect(state.released).toEqual([52])
 expect(state.frames.at(-1)?.items.map(item=>item.tile.gpuTile)).toEqual([51])
 await act(async()=>{job.finish();await pause()})
 expect(statuses.at(-1)?.phase).toBe('error')
})

test('replacing the source cancels its batch and isolates late results from the new owner',async()=>{
 await draw();const old=state.jobs[0]
 await draw({x:0,y:0,zoom:1},{...source,token:'new-source-token',revision:1})
 expect(old.signal?.aborted).toBe(true);expect(state.disposed).toBe(1)
 await act(async()=>{deliver(old,1,61);paint()})
 expect(state.released).toContain(61)
 expect(state.frames.flatMap(frame=>frame.items).some(item=>item.tile.gpuTile===61)).toBe(false)
 expect(state.maxActive).toBe(1)
})


test('strict target: an exact native cache return bypasses unused motion headroom',async()=>{
 await draw();const a=state.jobs[0]
 await act(async()=>{deliver(a,0,201);deliver(a,1,202);a.finish();await pause()})
 const b=state.jobs[1]
 await act(async()=>{deliver(b,0,203);deliver(b,1,204);b.finish();await pause();paint()})
 const before=statuses.length;state.motionMultiplier=1.125
 await draw({x:0,y:0,zoom:1.5});const obsolete=state.jobs.at(-1)!
 expect(obsolete.options.view.zoom).toBe(1.6875)
 await draw({x:0,y:0,zoom:1})
 await act(async()=>{paint();await pause()})
 expect(obsolete.signal?.aborted).toBe(true)
 expect(state.active).toBe(0)
 expect(statuses.slice(before).some(s=>s.phase==='ready')).toBe(true)
 expect(state.frames.at(-1)?.allowEmpty).toBe(false)
})

test('strict target: quiet input cancels compatible headroom that cannot certify the native phase',async()=>{
 await draw();const a=state.jobs[0]
 await act(async()=>{deliver(a,0,211);deliver(a,1,212);a.finish();await pause()})
 const b=state.jobs[1]
 await act(async()=>{deliver(b,0,213);deliver(b,1,214);b.finish();await pause();paint()})
 state.motionMultiplier=1.125
 await draw({x:0,y:0,zoom:1.25});const obsolete=state.jobs.at(-1)!
 expect(obsolete.options.view.zoom).toBe(1.40625)
 // Controlled transport only; real pixel latency is measured by the replay.
 await act(async()=>{await new Promise(r=>setTimeout(r,60));paint()})
 expect(obsolete.signal?.aborted).toBe(true)
 expect(state.jobs.at(-1)?.options.view.zoom).toBe(1.25)
 expect(state.maxActive).toBe(1)
 expect(statuses.some(s=>s.phase==='error')).toBe(false)
})

test('optional rim begins only after visible presentation and is cancelled for required new density',async()=>{
 state.prefetchEnabled=true
 await draw();const a=state.jobs[0]
 await act(async()=>{deliver(a,0,301);deliver(a,1,302);a.finish();await pause()})
 const b=state.jobs[1]
 await act(async()=>{deliver(b,0,303);deliver(b,1,304);b.finish();await pause()})
 expect(state.jobs).toHaveLength(2)
 await act(async()=>{paint();await pause()})
 const rim=state.jobs[2];expect(rim.options.tileViewport?.every(t=>t.prefetch)).toBe(true)
 expect(statuses.some(s=>s.phase==='ready'&&s.total===4)).toBe(true)
 expect(rim.options.tilePrepareViewport?.w).toBe(514)
 await draw({x:0,y:0,zoom:2})
 expect(rim.signal?.aborted).toBe(true)
 expect(state.jobs.at(-1)?.options.tileViewport?.some(t=>t.prefetch)).toBe(false)
 expect(state.maxActive).toBe(1)
})
