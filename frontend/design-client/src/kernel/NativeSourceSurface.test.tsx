// Controller lifetime regression; real native/GPU work is measured separately.
// @ts-expect-error jsdom runtime dependency
import {JSDOM} from 'jsdom'
import React,{act}from'react'
import{createRoot}from'react-dom/client'
import{expect,test,vi}from'vitest'
const calls=vi.hoisted(()=>({requests:0,disposed:0,defer:false,holdAdmission:false,admit:undefined as (()=>void)|undefined,error:'Scene path budget exceeded',scales:[] as number[],jobs:[] as {zoom:number;signal?:AbortSignal;keys:string[]}[]}))
vi.mock('./client',()=>({backendPreference:()=> 'webgpu',renderExecutionPolicy:{desktopFullMath:true,desktopDisplay:true,cpuOnly:false,hdrCompositing:false},KernelClient:class{
 onPresentation?:unknown
 renderSource(_source:unknown,options:{tileViewport:unknown[];view:{zoom:number}},_receive?:unknown,signal?:AbortSignal){
  calls.requests++;if(!options.tileViewport.length)return calls.holdAdmission?new Promise(resolve=>{calls.admit=()=>resolve({})}):Promise.resolve({})
  if(!calls.defer){calls.scales.push(options.view.zoom);return Promise.reject(Error(calls.error))}
  calls.jobs.push({zoom:options.view.zoom,signal,keys:options.tileViewport.map(tile=>(tile as {key:string}).key)})
  return new Promise((_resolve,reject)=>signal?.addEventListener('abort',()=>reject(Error('PREVIEW_CANCELLED')),{once:true}))
 }
 attachPresentation(){} present(){} releasePresented(){} dispose(){calls.disposed++}
}}))
vi.mock('./presentation',()=>({useDevicePixelRatio:()=>1}))
vi.mock('./tile-plan-aligned',()=>({planTilesWithPrefetchRim:(_bounds:unknown,zoom:number)=>({viewport:[{key:`tile:${zoom}`,x:0,y:0,width:514,height:514,zoom,gutter:1}],rim:[],cacheLimitSkipped:0})}))
import{NativeSourceSurface,type NativeSourceStatus}from'./NativeSourceSurface'
import type{SourceCanvasSnapshot}from'../desktop'
test.each([
 {decoded:true,scope:'full',nativeFirst:true},
 {decoded:false,scope:'full',nativeFirst:false},
 {decoded:true,scope:'material',nativeFirst:false},
 {decoded:true,scope:'edited',nativeFirst:false},
])('first GPU view keeps decoded opening pixels while prioritizing native tiles: %o',async({decoded,scope,nativeFirst})=>{
 const dom=new JSDOM('<div id="root"></div>')
 for(const name of ['window','document','navigator'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 vi.stubGlobal('OffscreenCanvas',class {});vi.stubGlobal('ImageBitmapRenderingContext',class {})
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>({transferFromImageBitmap(){}})})
 const root=createRoot(document.getElementById('root')!),source:SourceCanvasSnapshot={owner:{documentId:'source',sessionEpoch:1},revision:scope==='edited'?1:0,token:'source-token',
  bytes:254000000,nodes:124447,roots:306,pageId:'page',stageId:'stage',bounds:{x:-970,y:-2378,width:32516,height:28495},warnings:[],rasterProfile:'figma',colorManaged:true,
  ...(scope==='material'?{materialKeys:['material']}:{}),}
 try{
  calls.requests=0;calls.defer=true;calls.jobs=[];calls.holdAdmission=true
  await act(async()=>root.render(<NativeSourceSurface source={source} view={{x:61.56815106409152,y:200.0792071595522,zoom:.022235207282568583}} width={803} height={928} underlay={{current:()=>decoded}}/>))
  // Real source admission outlives the initial quiet-camera timer.
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,60));calls.admit?.()})
  expect(calls.jobs).toHaveLength(1)
  expect(calls.jobs[0].keys.every(key=>key.startsWith('tile:'))).toBe(nativeFirst)
  expect(calls.jobs[0].signal?.aborted).toBe(false)
 }finally{await act(async()=>root.unmount());dom.window.close();vi.unstubAllGlobals();calls.defer=false;calls.holdAdmission=false;calls.admit=undefined}
 expect(calls.jobs.every(job=>job.signal?.aborted)).toBe(true)
})
test('a permanent render failure cannot restart itself when its error banner resizes the canvas',async()=>{
 const dom=new JSDOM('<div id="root"></div>'),statuses:NativeSourceStatus[]=[]
 for(const name of ['window','document','navigator'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:()=>({})})
 let finishPreview: ((reply:unknown)=>void)|undefined
 const decode=vi.fn()
 Object.defineProperty(dom.window,'coreDesktop',{value:{version:1,largeDocument:{canvasPreview:()=>new Promise(resolve=>{finishPreview=resolve})}}})
 vi.stubGlobal('OffscreenCanvas',class {});vi.stubGlobal('ImageBitmapRenderingContext',class {});vi.stubGlobal('createImageBitmap',decode)
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'getContext',{value:()=>({transferFromImageBitmap(){}})})
 const root=createRoot(document.getElementById('root')!),source:SourceCanvasSnapshot={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',
  bytes:600*1024**2,nodes:124447,roots:306,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:16000,height:30000},warnings:[],rasterProfile:'figma',colorManaged:true}
 const draw=(height:number)=><NativeSourceSurface source={source} view={{x:0,y:0,zoom:1}} width={800} height={height} onStatus={value=>statuses.push(value)}/>
 try{
  calls.requests=0;calls.disposed=0;calls.defer=false;calls.jobs=[]
  await act(async()=>root.render(draw(600)))
  expect(calls.requests).toBe(2);expect(statuses.at(-1)).toMatchObject({phase:'error',error:'Scene path budget exceeded'})
  await act(async()=>{root.render(draw(560));await new Promise(resolve=>setTimeout(resolve,150))})
  expect(calls.requests).toBe(2);expect(statuses.at(-1)?.phase).toBe('error')
  expect(finishPreview).toBeTypeOf('function')
  await act(async()=>finishPreview!({status:'ok',phase:'ready',width:1,height:1,scale:1,png:'AA=='}))
  expect(decode).not.toHaveBeenCalled()
  expect(document.querySelector('.native-source-surface .kernel-status')?.textContent).toBe('画板绘制未完成')
 }finally{await act(async()=>root.unmount());dom.window.close();vi.unstubAllGlobals()}
 expect(calls.disposed).toBe(1)
})

test('a large camera jump keeps in-flight coverage of the empty viewport',async()=>{
 const dom=new JSDOM('<div id="root"></div>')
 for(const name of ['window','document','navigator'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:()=>({})})
 const root=createRoot(document.getElementById('root')!),source:SourceCanvasSnapshot={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',bytes:600*1024**2,nodes:124447,roots:306,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:16000,height:30000},warnings:[],rasterProfile:'figma',colorManaged:true}
 const statuses:NativeSourceStatus[]=[]
 const draw=(zoom:number)=><NativeSourceSurface source={source} view={{x:0,y:0,zoom}} width={800} height={600} onStatus={value=>statuses.push(value)}/>
 try{
  calls.requests=0;calls.disposed=0;calls.defer=true;calls.jobs=[]
  await act(async()=>root.render(draw(1)))
  expect(calls.jobs).toHaveLength(1);expect(calls.jobs[0].signal?.aborted).toBe(false)
  await act(async()=>root.render(draw(8)))
  // The zoom-1 tile still paints this tighter, otherwise empty view. Cancelling
  // it would start the sharp lattice with nothing on screen. Unmount aborts it.
  expect(calls.jobs[0].signal?.aborted).toBe(false);expect(calls.jobs).toHaveLength(1)
  expect(statuses.some(status=>status.phase==='error')).toBe(false)
 }finally{await act(async()=>root.unmount());dom.window.close();vi.unstubAllGlobals();calls.defer=false}
 expect(calls.jobs.every(job=>job.signal?.aborted)).toBe(true)
})

 test.each(['Invalid tile request','GPU surface budget exceeded','GPU 表面内存预算超限'])('a rejected camera (%s) recovers after navigation without restarting on banner resize',async(error)=>{
 const dom=new JSDOM('<div id="root"></div>')
 for(const name of ['window','document','navigator'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 Object.defineProperty(dom.window.HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:()=>({})})
 const root=createRoot(document.getElementById('root')!),source:SourceCanvasSnapshot={owner:{documentId:'source',sessionEpoch:1},revision:0,token:'source-token',bytes:1,nodes:1,roots:1,pageId:'page',stageId:'stage',bounds:{x:0,y:0,width:100,height:100},warnings:[],rasterProfile:'figma',colorManaged:true}
 const statuses:NativeSourceStatus[]=[]
 const draw=(zoom:number,height=600)=><NativeSourceSurface source={source} view={{x:0,y:0,zoom}} width={800} height={height} onStatus={value=>statuses.push(value)}/>
 try{
  calls.requests=0;calls.disposed=0;calls.defer=false;calls.error=error;calls.scales=[];calls.jobs=[]
  await act(async()=>root.render(draw(256)))
  const scales=error==='Invalid tile request'?[256]:[256,128,64,32,16,8,4]
  expect(calls.scales).toEqual(scales)
  expect(statuses.at(-1)?.phase).toBe('error')
  await act(async()=>root.render(draw(256,560)))
  expect(calls.requests).toBe(1+scales.length)
  calls.defer=true
  await act(async()=>root.render(draw(1,560)))
  expect(calls.jobs).toHaveLength(1);expect(calls.jobs[0].zoom).toBe(1);expect(calls.disposed).toBe(0)
 }finally{await act(async()=>root.unmount());dom.window.close();vi.unstubAllGlobals();calls.defer=false;calls.error='Scene path budget exceeded'}
})
