// Actual Canvas gestures -> KernelSurface -> ProgressiveSurface ->
// ResidentCompositeSurface -> InteractionRenderer -> ResidentPresenter.
// The worker/device transport alone supplies controlled tile/capture completions
// and descriptor GPU operations. This is not a raster-pixel or browser oracle.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import {writeFileSync} from 'node:fs'
import React,{act} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {Canvas} from './Canvas'
import {contentPlane} from './kernel/content-plane'
import {Editor} from './engine'
import {blank,node,effect,type DesignDocument} from './model'
import {InteractionRenderer} from './kernel/interaction-renderer'
import {ResidentPresentation} from './kernel/resident-presentation'
import type {PresentedFrame} from './kernel/Surface'
import {RenderMailbox} from './kernel/render-mailbox'
import {TileFillScheduler} from './kernel/tile-scheduler'
import {descriptorPresenter} from './kernel/descriptor-presenter.test-helper'
import {shortcutPreference} from './shortcut-preference'

const transport=vi.hoisted(()=>({create:null as any,clients:[] as any[],jobs:[] as any[],frames:[] as any[],acks:[] as any[],autoPage:true,holdAcks:false,forwarded:[] as any[],reads:[] as any[]}))
vi.mock('./kernel/client',async original=>({...await original<any>(),
 renderExecutionPolicy:{desktopDisplay:true,desktopFullMath:true,cpuOnly:false,hdrCompositing:false,imageMips:false,imageAtlas:false},
 backendPreference:()=> 'webgpu',KernelClient:class{constructor(){return transport.create()}}
}))
vi.mock('./kernel/ResidentCompositeSurface',async original=>{
 const module=await original<any>()
 return {...module,ResidentCompositeSurface:(props:any)=>React.createElement(module.ResidentCompositeSurface,{...props,
  onPresented:(...args:any[])=>{transport.forwarded.push(args);props.onPresented?.(...args)}})}
})
let dom:any,root:Root,mount:HTMLDivElement,editor:Editor,gpu:ReturnType<typeof descriptorPresenter>
let callbacks:Map<number,FrameRequestCallback>,nextFrame:number,errors:unknown[][],mounted:boolean
let overlayCalls:{owner:InteractionRenderer;document:DesignDocument;commands:any;uiIdentity?:string;resolution:any}[]
let timeline:Record<string,unknown>[],started:number,documentTags:WeakMap<DesignDocument,number>,nextDocument:number
let mailboxes:Set<RenderMailbox>,schedulers:Set<TileFillScheduler>
let observedPresentations:(PresentedFrame|null)[],resolutions:{actual:any;resolved:PresentedFrame|undefined}[]
const documentTag=(doc:DesignDocument)=>{let tag=documentTags.get(doc);if(!tag){tag=++nextDocument;documentTags.set(doc,tag)}return tag}
const trace=(kind:string,fields:Record<string,unknown>={})=>timeline.push({kind,ms:Number((performance.now()-started).toFixed(2)),...fields})
function schedulingSnapshot(kind:string){
 const surface=mount.querySelector<HTMLElement>('.kernel-tiles')
 trace(kind,{nativePreparation:'not exercised: worker transport adapter',pendingRaf:callbacks.size,
  mailboxes:[...mailboxes].map(value=>{const state=value as any;return {running:state.running,queued:state.queued.length,admissible:state.queued.map((job:any)=>job.current())}}),
  schedulers:[...schedulers].map(value=>{const state=value as any;return {cancelled:state.cancelled,onScreen:state.onScreen.length,offScreen:state.offScreen.length,frameWaiting:!!state.cancelFrame,counters:{...value.counters,cutoffs:{...value.counters.cutoffs}}}}),
  contract:surface?{requestedRevision:surface.dataset.requestedRevision,displayedRevision:surface.dataset.revision,publication:surface.dataset.framePublication,detailReady:surface.dataset.detailReady}:null,
  requests:transport.jobs.map(job=>({document:documentTag(job.document),owner:job.options.interactionOwner,done:job.done,aborted:job.signal?.aborted,tiles:job.options.tileViewport?.length})),
 })
}
const tick=async()=>{await act(async()=>{for(let i=0;i<12;i++)await Promise.resolve()})}
async function flushFrames(){await act(async()=>{for(const [id,fn] of [...callbacks]){callbacks.delete(id);fn(performance.now())}for(let i=0;i<12;i++)await Promise.resolve()})}
async function settleUntil(predicate:()=>boolean,label:string){
 const deadline=performance.now()+3000
 while(!predicate()&&performance.now()<deadline){
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))})
  await flushFrames()
 }
 expect(predicate(),`${label}; jobs=${JSON.stringify(transport.jobs.map(j=>({owner:j.options.interactionOwner,tiles:j.options.tileViewport?.length,done:j.done})))}; frames=${transport.frames.length}; acks=${transport.acks.length}; surface=${mount.querySelector('.kernel-presentation')?.outerHTML}`).toBe(true)
}
function deliver(job:any){
 if(job.done)return job.slots
 trace('deliver',{document:documentTag(job.document),owner:job.options.interactionOwner,aborted:job.signal?.aborted})
 job.done=true;job.slots=[]
 const result={bytes:new Uint8Array(),backend:'webgpu',compileMs:1,graphMs:1,milliseconds:1,residentInteraction:false}
 if(job.options.tileViewport){
  for(const tile of job.options.tileViewport){const slot=gpu.presenter.capture(tile.width,tile.height).id;job.slots.push(slot)
   job.receive?.({...tile,...result,gpuTile:slot,cached:false,description:''})}
  job.resolve(result)
 }else{const slot=gpu.presenter.capture(job.options.width,job.options.height).id;job.slots.push(slot);job.resolve({...result,gpuTile:slot})}
 return job.slots
}
beforeEach(()=>{
 timeline=[];started=performance.now();documentTags=new WeakMap();nextDocument=0;mailboxes=new Set();schedulers=new Set()
 Object.assign(transport,{clients:[],jobs:[],frames:[],acks:[],autoPage:true,holdAcks:false,forwarded:[],reads:[]})
 const nativeTimeout=globalThis.setTimeout,nativeClearTimeout=globalThis.clearTimeout
 const observedTimers=new Map<ReturnType<typeof setTimeout>,number>();let timerSequence=0
 vi.stubGlobal('setTimeout',(callback:any,delay?:number,...args:any[])=>{
  if(delay!==80||typeof callback!=='function')return nativeTimeout(callback,delay,...args)
  const timerTag=++timerSequence,document=editor?documentTag(editor.state.doc):undefined
  trace('timer80-scheduled',{timer:timerTag,document,refineDocument:String(callback).includes('setRefineDocument')})
  const timer=nativeTimeout((...values:any[])=>{observedTimers.delete(timer);trace('timer80-fired',{timer:timerTag,document});callback(...values)},delay,...args)
  observedTimers.set(timer,timerTag);return timer
 })
 vi.stubGlobal('clearTimeout',(timer:ReturnType<typeof setTimeout>)=>{
  const timerTag=observedTimers.get(timer)
  if(timerTag!==undefined){trace('timer80-cancelled',{timer:timerTag});observedTimers.delete(timer)}
  nativeClearTimeout(timer)
 })
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/',pretendToBeVisual:true})
 for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLCanvasElement','Element','Node','Event','MouseEvent','WheelEvent','KeyboardEvent','FocusEvent','localStorage'])
  vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('devicePixelRatio',1)
 vi.stubGlobal('CSS',{escape:(value:string)=>value.replace(/[^a-zA-Z0-9_-]/g,c=>`\\${c}`)})
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});vi.stubGlobal('matchMedia',dom.window.matchMedia)
 Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'})
 vi.stubGlobal('WebGL2RenderingContext',function(){})
 callbacks=new Map();nextFrame=0
 vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{callbacks.set(++nextFrame,fn);return nextFrame})
 vi.stubGlobal('cancelAnimationFrame',(id:number)=>callbacks.delete(id))
 vi.stubGlobal('ResizeObserver',class{
  private connected=true
  constructor(private callback:ResizeObserverCallback){}
  observe(target:Element){queueMicrotask(()=>{if(this.connected)this.callback([{target,contentRect:target.getBoundingClientRect()} as ResizeObserverEntry],this as unknown as ResizeObserver)})}
  disconnect(){this.connected=false}
 })
 Object.defineProperties(HTMLElement.prototype,{clientWidth:{configurable:true,get:()=>600},clientHeight:{configurable:true,get:()=>400}})
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,right:600,bottom:400,width:600,height:400,x:0,y:0,toJSON(){}})
 HTMLElement.prototype.setPointerCapture=()=>{};HTMLElement.prototype.hasPointerCapture=()=>false;HTMLElement.prototype.releasePointerCapture=()=>{}
 gpu=descriptorPresenter(stats=>{
  const client=transport.clients.at(-1),entry={stats,client,callback:client?.onPresentation}
  transport.acks.push(entry)
  if(!transport.holdAcks)queueMicrotask(()=>entry.callback?.(stats))
 })
 const proto=Object.getPrototypeOf(gpu.canvas),original=proto.getContext
 proto.getContext=function(kind:string){return kind==='2d'?{measureText:(text:string)=>({width:text.length*6,actualBoundingBoxLeft:0,actualBoundingBoxRight:text.length*6,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),setTransform(){},strokeText(){},fillText(){}}:original.call(this,kind)}
 Object.defineProperty(navigator,'gpu',{configurable:true,value:{requestAdapter:async()=>({requestDevice:async()=>gpu.device}),getPreferredCanvasFormat:()=> 'rgba8unorm'}})
 HTMLCanvasElement.prototype.transferControlToOffscreen=()=>new OffscreenCanvas(600,400)
 const gl=new Proxy({} as any,{get:(_target,key)=>{
  if(typeof key!=='string')return undefined
  if(key.toUpperCase()===key)return 0
  if(key==='isContextLost')return()=>false
  if(key==='getShaderParameter'||key==='getProgramParameter')return()=>true
  if(key==='getError')return()=>0
  if(key.startsWith('create')||key==='getUniformLocation')return()=>({})
  return()=>{}
 }})
 vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockImplementation(((kind:string)=>kind==='webgpu'?gpu.canvas.context:kind==='webgl2'?gl:null) as any)
 transport.create=()=>{
  const client:any={disposed:false,attachPresentation:(canvas:OffscreenCanvas)=>gpu.presenter.attachCanvas(canvas),
   present:(frame:any)=>{transport.frames.push({frame,client});queueMicrotask(()=>{if(!client.disposed)gpu.presenter.draw(frame)})},
   releasePresented:vi.fn((ids:number[])=>gpu.presenter.release(ids)),stopResidentInteraction:vi.fn(),moveResidentInteraction:vi.fn(),
   async readContentPixel(u:number,v:number,expected:any){transport.reads.push(expected);return (await gpu.presenter.readContentPixel(u,v,expected)).contentPixel},
   cancelPreview(){},cancelTileFill(){},bindNavigationInput:()=>()=>{},recordViewportDiagnostic(){},presentationDiagnosticsEnabled:()=>false,
   dispose(){client.disposed=true},render(document:DesignDocument,options:any,...args:any[]){
    return new Promise((resolve,reject)=>{const job={client,document,options,receive:args[5],signal:args[6],resolve,reject,done:false,slots:[] as number[]};transport.jobs.push(job)
     trace('request',{document:documentTag(document),owner:options.interactionOwner,generation:options.interactionGeneration,epoch:options.tileOwner?.sessionEpoch,tiles:options.tileViewport?.length})
     job.signal?.addEventListener('abort',()=>trace('abort',{document:documentTag(document),owner:options.interactionOwner}),{once:true})
     if(!options.interactionOwner&&transport.autoPage)queueMicrotask(()=>deliver(job))})
   }}
  transport.clients.push(client);return client
 }
 const mailboxRun=RenderMailbox.prototype.run
 vi.spyOn(RenderMailbox.prototype,'run').mockImplementation(function<T>(this:RenderMailbox,current:()=>boolean,work:()=>Promise<T>):Promise<T>{
  mailboxes.add(this);trace('mailbox-enqueue',{admissible:current()})
  return mailboxRun.call(this,current,()=>{trace('mailbox-start',{admissible:current()});return work()}) as Promise<T>
 })
 const schedulerFill=TileFillScheduler.prototype.fill
 vi.spyOn(TileFillScheduler.prototype,'fill').mockImplementation(function(this:TileFillScheduler,tiles){
  schedulers.add(this);trace('scheduler-fill',{tiles:tiles.length});return schedulerFill.call(this,tiles)
 })
 observedPresentations=[];resolutions=[]
 const resolvePresentation=ResidentPresentation.prototype.resolve
 vi.spyOn(ResidentPresentation.prototype,'resolve').mockImplementation(function(this:ResidentPresentation,actual){
  const resolved=resolvePresentation.call(this,actual);resolutions.push({actual,resolved});return resolved
 })
 overlayCalls=[]
 const originalOverlay=InteractionRenderer.prototype.capturedOverlay
 vi.spyOn(InteractionRenderer.prototype,'capturedOverlay').mockImplementation(function(this:InteractionRenderer,...args){
  const resolution=originalOverlay.apply(this,args)
  overlayCalls.push({owner:this,document:args[0],commands:args[3],uiIdentity:args[4],resolution});return resolution
 })
 errors=[];const error=console.error.bind(console)
 vi.spyOn(console,'error').mockImplementation((...args)=>{errors.push(args);error(...args)})
 localStorage.clear();shortcutPreference.set('sketch-like')
 editor=new Editor(blank())
 const observePresentation=editor.observeCanvasPresentation.bind(editor)
 vi.spyOn(editor,'observeCanvasPresentation').mockImplementation(frame=>{observedPresentations.push(frame as PresentedFrame|null);observePresentation(frame)})
 editor.set({view:{x:0,y:0,zoom:4},pixelGrid:false,grid:false,checkerboard:false,snap:false,snapPixels:false})
 mount=document.createElement('div');document.body.append(mount);root=createRoot(mount);mounted=true
})
afterEach(async()=>{if(mounted)await act(async()=>root.unmount());editor.dispose();gpu.presenter.dispose();dom.window.close();vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();expect(errors).toEqual([])})
const host=()=>mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
function pointer(type:string,x:number,y:number,options:MouseEventInit={},target:Element=host()){
 const event=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,...options})
 Object.defineProperties(event,{pointerId:{value:7},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(event)
}
function key(value:string,options:KeyboardEventInit={},type='keydown'){
 host().dispatchEvent(new KeyboardEvent(type,{key:value,code:value===' '?'Space':value,bubbles:true,cancelable:true,...options}))
}
const lastFrame=()=>transport.frames.at(-1)?.frame
const lastAck=()=>transport.acks.at(-1)?.stats.presented
const captureJobs=()=>transport.jobs.filter(job=>job.options.interactionOwner)
async function fixture(options:{release?:boolean;authoredCapture?:boolean}={}){
 const doc=blank('Capture chain'),selected=node('frame',20,20,40,40),target=node('rectangle',100,20,20,40),other=node('rectangle',130,20,15,40)
 if(options.authoredCapture)selected.constraints={horizontal:'start',vertical:'start'}
 doc.schemaVersion=5;selected.blend='normal';selected.effects=[effect('glass')];doc.nodes=Object.fromEntries([selected,target,other].map(n=>[n.id,n]));doc.pages[0].children=[selected.id,target.id,other.id]
 doc.pages.push({...doc.pages[0],id:'ffffffff-ffff-4fff-8fff-ffffffffffff',name:'Other',children:[]})
 editor.load(doc);editor.set({view:{x:0,y:0,zoom:4},pixelGrid:false,grid:false,checkerboard:false,snap:false,snapPixels:false})
 await act(async()=>{root.render(<Canvas editor={editor}/>);for(let i=0;i<30;i++)await Promise.resolve()})
 await settleUntil(()=>mount.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true','initial exact page ready')
 await act(async()=>editor.select([selected.id]));await tick()
 expect(mount.querySelector('[data-testid="rotate-corner-0"]'),JSON.stringify({jobs:transport.jobs.map(j=>({owner:j.options.interactionOwner,tiles:j.options.tileViewport?.length})),html:mount.innerHTML.slice(-1500)})).not.toBeNull()
 transport.autoPage=false;host().focus()
 const S=editor.state.doc,handle=mount.querySelector('[data-testid="rotate-corner-0"]')!
 trace('source-S',{document:documentTag(S)})
 const x=Number(handle.getAttribute('data-anchor-x'))*4,y=Number(handle.getAttribute('data-anchor-y'))*4
 await act(async()=>pointer('pointerdown',x,y,{},handle));await tick()
 // Editor.begin is intentionally silent. A real modifier event publishes the
 // active gesture before the first pointer pose, allowing the exact S capture
 // to complete without injecting a synthetic Surface/renderer state.
 await act(async()=>key('Alt',{altKey:true}));await tick()
 const initial=captureJobs().find(job=>!job.done)
 expect(initial,JSON.stringify({jobs:transport.jobs.map(j=>({owner:j.options.interactionOwner,done:j.done})),mode:mount.querySelector('[data-compositor]')?.outerHTML})).toBeDefined()
 await act(async()=>deliver(initial));await tick()
 expect(initial.document).toBe(S)
 expect(lastAck().gpuOverlay).toBe(true)
 await act(async()=>key('Alt',{},'keyup'));await tick()
 const frameS=lastFrame(),slotS=initial.slots[0],commandsS=frameS.overlay
 const owner=overlayCalls.at(-1)!.owner,beforeC=owner.overlayCaptureDiagnostics
 const ackS=transport.acks.find(entry=>entry.stats.presented?.ids.includes(slotS)&&entry.stats.presented.gpuOverlay)!
 const point=(angle:number)=>({x:160+(x-160)*Math.cos(angle)-(y-160)*Math.sin(angle),y:160+(x-160)*Math.sin(angle)+(y-160)*Math.cos(angle)})
 const move=async(angle:number)=>{const p=point(angle);await act(async()=>pointer('pointermove',p.x,p.y));await flushFrames();return p}
 await move(.25)
 const C=captureJobs().find(job=>!job.done);expect(C).toBeDefined();expect(C.document).not.toBe(S)
 await act(async()=>deliver(C));await tick()
 const slotC=C.slots[0]
 trace('completed-C',{document:documentTag(C.document),slot:slotC})
 expect(lastFrame().items.some((item:any)=>item.tile.gpuTile===slotC)).toBe(true)
 expect(lastFrame().items.some((item:any)=>item.tile.gpuTile===slotS)).toBe(false)
 const frameC=lastFrame(),ackC=transport.acks.at(-1)!
 if(options.authoredCapture){
  // Constraints decline the frontend affine shortcut, so the real pointer
  // path calls Editor.preview(C) and Canvas actually produces C commands.
  expect(editor.state.doc).toBe(C.document)
  expect(frameC.overlay).toBeDefined();expect(lastAck().gpuOverlay).toBe(true)
  const own=overlayCalls.find(call=>call.document===C.document&&call.resolution?.commands)
  expect(own).toBeDefined();expect(frameC.overlay).toEqual(own!.commands)
  expect(frameC.overlay.selection.corners).not.toEqual(commandsS.selection.corners)
  expect(own!.uiIdentity).toBe(overlayCalls.find(call=>call.document===S&&call.resolution?.commands)!.uiIdentity)
  expect(owner.overlayCaptureDiagnostics.snapshotCopies).toBeGreaterThan(beforeC.snapshotCopies)
 }else{
  expect(frameC.overlay).toBeUndefined();expect(lastAck().gpuOverlay).toBe(false)
  expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
  expect(overlayCalls.some(call=>call.document===C.document)).toBe(false)
  expect(owner.overlayCaptureDiagnostics.geometryChecks).toBe(beforeC.geometryChecks)
  expect(owner.overlayCaptureDiagnostics.snapshotCopies).toBe(beforeC.snapshotCopies)
 }
 const latest=await move(.5),D=captureJobs().find(job=>!job.done)
 expect(D).toBeDefined();expect(D.document).not.toBe(C.document)
 if(options.release!==false){await act(async()=>pointer('pointerup',latest.x,latest.y));await tick()}
 if(options.release===false)return {S,B:S,C,D,selected,target,other,slotS,slotC,commandsS,owner,ackS,frameS,frameC,ackC}
 const B=editor.state.doc;expect(B).not.toBe(S);expect(B.nodes[selected.id].transform).toEqual(D.document.nodes[selected.id].transform)
 trace('released-B',{document:documentTag(B),pendingD:documentTag(D.document),dAborted:D.signal?.aborted})
 expect(lastFrame().items.some((item:any)=>item.tile.gpuTile===slotC)).toBe(true)
 if(options.authoredCapture){expect(lastFrame().overlay).toEqual(frameC.overlay);expect(lastAck().gpuOverlay).toBe(true)}
 else{expect(lastFrame().overlay).toBeUndefined();expect(lastAck().gpuOverlay).toBe(false)}
 return {S,B,C,D,selected,target,other,slotS,slotC,commandsS,owner,ackS,frameS,frameC,ackC}
}

test('complete C replaces S; missing C snapshot stays closed through D pending release B and exact B takeover',async()=>{
 const h=await fixture(),before=transport.frames.length
 await act(async()=>deliver(h.D));await tick()
 expect(transport.frames.slice(before).every(({frame})=>!frame.items.some((item:any)=>h.D.slots.includes(item.tile.gpuTile)))).toBe(true)
 expect(lastFrame().overlay).toBeUndefined();expect(editor.state.doc).toBe(h.B)
 schedulingSnapshot('before-B-refinement')
 await settleUntil(()=>transport.jobs.some(job=>!job.done&&!job.options.interactionOwner&&job.document===h.B),'authored B refinement request')
 schedulingSnapshot('B-refinement-arrived')
 const bTimer=timeline.find(event=>event.kind==='timer80-scheduled'&&event.document===documentTag(h.B))
 expect(bTimer?.refineDocument).toBe(true)
 expect(timeline.some(event=>event.kind==='timer80-fired'&&event.timer===bTimer?.timer)).toBe(true)
 const jobs=transport.jobs.filter(job=>!job.done&&!job.options.interactionOwner)
 expect(jobs.some(job=>job.document===h.B)).toBe(true)
 transport.autoPage=true
 await act(async()=>{for(const job of jobs)deliver(job)});await tick()
 await settleUntil(()=>mount.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&!lastAck()?.interaction,'exact B takeover')
 expect(lastFrame().items.some((item:any)=>item.tile.gpuTile===h.slotC)).toBe(false)
 expect(lastAck().interaction).toBe(false)
 // Exact B retires C's presentation authority. Existing warm-owner policy may
 // retain its GPU allocation until the next owner boundary; do not confuse
 // presentation retirement with immediate device-memory destruction.
 expect(h.owner.control.isActive()).toBe(false)
 expect(h.owner.items(editor.state.view)).toBeNull()
 schedulingSnapshot('exact-B-acknowledged')
 expect(editor.state.doc).toBe(h.B)
 await act(async()=>editor.undo());await tick();expect(editor.state.doc).toEqual(h.S);expect(editor.canUndo).toBe(false)
 await act(async()=>editor.redo());await tick();expect(editor.state.doc).toEqual(h.B)
 console.log('CHAIN_CAUSAL_TRACE',JSON.stringify(timeline))
 if(process.env.OVERLAY_CHAIN_TRACE)writeFileSync(process.env.OVERLAY_CHAIN_TRACE,JSON.stringify(timeline,null,2))
})


test.each(['grid','Space','Alt-target','title'] as const)('complete C then release B: %s and out-of-order S ACK cannot hide current DOM',async change=>{
 const h=await fixture()
 if(change==='grid')await act(async()=>editor.set({pixelGrid:true}))
 if(change==='Space')await act(async()=>key(' '))
 if(change==='Alt-target'){
  await act(async()=>pointer('pointermove',440,120,{altKey:true}));await flushFrames()
  expect(mount.querySelectorAll('[data-testid="canvas-measurement"]').length).toBeGreaterThan(0)
  await act(async()=>pointer('pointermove',550,120,{altKey:true}));await flushFrames()
 }
 if(change==='title')await act(async()=>editor.update([h.selected.id],{name:'Renamed after release'},'Rename'))
 await tick()
 const current=editor.state.doc
 if(change!=='title')expect(current).toBe(h.B)
 const latest=transport.acks.at(-1)!
 await act(async()=>h.ackS.callback?.(h.ackS.stats));await tick()
 expect(editor.state.doc).toBe(current)
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
 if(change==='grid')expect(mount.querySelector('[data-testid="pixel-grid"]')).not.toBeNull()
 if(change==='Space')expect(mount.querySelector('[data-testid="resize-0"]')).toBeNull()
 if(change==='Alt-target')expect([...mount.querySelectorAll('[data-testid="canvas-measurement"]')].every(e=>e.getAttribute('opacity')==='1')).toBe(true)
 if(change==='title')expect(mount.querySelector('[data-frame-title]')?.textContent).toBe('Renamed after release')
 await act(async()=>latest.callback?.(latest.stats));await tick()
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe('1')
 expect(lastFrame().overlay).toBeUndefined()
})

test.each(['cancel','page','client-destroyed'] as const)('completed C, pending D: %s rejects late capture and stale ACK ownership',async boundary=>{
 const h=await fixture({release:false})
 if(boundary==='cancel'){await act(async()=>key('Escape'));expect(editor.state.doc).toBe(h.S);expect(editor.canUndo).toBe(false)}
 if(boundary==='page'){await act(async()=>editor.switchPage('ffffffff-ffff-4fff-8fff-ffffffffffff'));expect(editor.state.page).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff')}
 if(boundary==='client-destroyed'){
  await act(async()=>root.unmount());mounted=false
  expect(transport.clients[0].disposed).toBe(true)
  transport.autoPage=true;root=createRoot(mount);mounted=true
  await act(async()=>root.render(<Canvas editor={editor}/>));await tick();for(let i=0;i<3;i++)await flushFrames()
 }
 await tick()
 const before=transport.frames.length,document=editor.state.doc,page=editor.state.page
 const title=mount.querySelector('[data-frame-title]')?.getAttribute('opacity')
 await act(async()=>{deliver(h.D);h.ackS.callback?.(h.ackS.stats)});await tick()
 expect(transport.frames.slice(before).every(({frame})=>!frame.items.some((item:any)=>h.D.slots.includes(item.tile.gpuTile)))).toBe(true)
 expect(h.D.client.releasePresented.mock.calls.some(([ids]:[number[]])=>h.D.slots.every((id:number)=>ids.includes(id)))).toBe(true)
 expect(editor.state.doc).toBe(document);expect(editor.state.page).toBe(page)
 expect(mount.querySelector('[data-frame-title]')?.getAttribute('opacity')).toBe(title)
})


test('actual constrained-frame C snapshot has a new cohort despite same frozen surface document and UI key',async()=>{
 const h=await fixture({authoredCapture:true})
 const sourceS=resolutions.find(entry=>entry.actual===h.ackS.stats.presented)!.resolved!
 const sourceC=resolutions.find(entry=>entry.actual===h.ackC.stats.presented)!.resolved!
 // This is the reachable alias: both Surface contexts remain S and both
 // overlays are true with one UI key, but the pixel/geometry cohorts differ.
 expect(sourceS.document).toBe(h.S);expect(sourceC.document).toBe(h.S)
 expect(sourceS.gpuOverlay).toBe(true);expect(sourceC.gpuOverlay).toBe(true)
 expect(sourceC.gpuOverlayIdentity).toBe(sourceS.gpuOverlayIdentity)
 expect.soft(h.frameC.presentationId).not.toBe(h.frameS.presentationId)
 expect.soft(sourceC.gpuOverlayCapture?.slots).toEqual([h.slotC])
 expect.soft(sourceS.gpuOverlayCapture?.slots).toEqual([h.slotS])
 expect.soft(sourceC.gpuOverlayCapture).not.toBe(sourceS.gpuOverlayCapture)
 expect(observedPresentations.some(frame=>frame?.gpuOverlayCapture===sourceC.gpuOverlayCapture)).toBe(true)
 const count=observedPresentations.length,document=editor.state.doc
 await act(async()=>h.ackS.callback?.(h.ackS.stats));await tick()
 expect(resolutions.at(-1)!.actual).toBe(h.ackS.stats.presented)
 expect.soft(resolutions.at(-1)!.resolved).toBeUndefined()
 expect.soft(observedPresentations).toHaveLength(count)
 expect(editor.state.doc).toBe(document)
 expect(lastFrame().overlay).toEqual(h.frameC.overlay)
 // The existing pose-slot fence remains independent. This test establishes
 // rejected stale context publication, not a browser/GPU pixel rollback.
})

async function sampleCurrentContent(){
 const canvas=mount.querySelector<HTMLCanvasElement>('canvas[aria-label="GPU 合成画布"]')!
 const read=contentPlane(canvas)!.pixel(.5,.5)
 const outcome=read.then(value=>({value}),error=>({error:String(error)}))
 await tick();gpu.queue.completeThrough(gpu.queue.epoch);await tick()
 return outcome
}

test('rejected S ACK preserves C readback and later exact ACK admission',async()=>{
 const h=await fixture({authoredCapture:true})
 const current=transport.forwarded.at(-1)![0],count=transport.forwarded.length
 expect(current.presentationId).not.toBe(h.frameS.presentationId)
 await act(async()=>h.ackS.callback?.(h.ackS.stats));await tick()
 expect.soft(transport.forwarded).toHaveLength(count)
 const sampled=await sampleCurrentContent()
 expect.soft(transport.reads.at(-1).presentationId).toBe(current.presentationId)
 expect.soft(sampled).toEqual({value:[10,20,30,255]})
 await settleUntil(()=>transport.jobs.some(job=>!job.done&&!job.options.interactionOwner&&job.document===h.B),'exact B refinement')
 transport.autoPage=true
 await act(async()=>{for(const job of transport.jobs.filter(job=>!job.done&&!job.options.interactionOwner))deliver(job)});await tick()
 await settleUntil(()=>mount.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready')==='true'&&!lastAck()?.interaction,'exact B takeover')
 const exact=transport.forwarded.at(-1)![0],exactCount=transport.forwarded.length
 expect(exact.interaction).toBe(false)
 await act(async()=>h.ackS.callback?.(h.ackS.stats));await tick()
 expect.soft(transport.forwarded).toHaveLength(exactCount)
 expect.soft(transport.forwarded.at(-1)![0]).toBe(exact)
 expect.soft(await sampleCurrentContent()).toEqual({value:[10,20,30,255]})
 expect.soft(transport.reads.at(-1).presentationId).toBe(exact.presentationId)
})
