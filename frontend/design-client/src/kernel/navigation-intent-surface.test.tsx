// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { blank } from '../model'
const state=vi.hoisted(()=>({sequence:1,composites:[] as any[]}))
vi.mock('./use-navigation-zoom',()=>({useNavigationZoom:(view:any,_identity:string,enabled:boolean)=>({active:enabled,suspended:false,sample:enabled?{sequence:state.sequence,view}:undefined})}))
vi.mock('./TileCompositeSurface',()=>({TileCompositeSurface:(props:any)=>{state.composites.push(props);return null}}))
vi.mock('./ResidentCompositeSurface',()=>({ResidentCompositeSurface:()=>null}))
vi.mock('./use-zoom-activity',()=>({useZoomActivity:()=>true,useCameraActivity:()=>true}))
vi.mock('./presentation',async original=>({...await original<any>(),useDevicePixelRatio:()=>1,useDisplayCapability:()=>undefined}))
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();state.composites=[];state.sequence=1})
test('mounted navigation sends request-specific cancellation and keeps newest output ownership',async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('WebGL2RenderingContext',function(){})
  Object.defineProperty(window,'coreDesktop',{configurable:true,value:{version:1,renderPolicy:{cpuOnly:true},preparation:{open:async()=> 'owned',close:async()=>{},request:async(_id:any,r:any)=>({id:1,value:JSON.stringify(r.args[0])})}}})
  class WorkerStub{
    static instances:WorkerStub[]=[];messages:any[]=[];onmessage?: (event:any)=>void
    constructor(){WorkerStub.instances.push(this)}postMessage(m:any){this.messages.push(m)}terminate(){}
    requests(){return this.messages.filter(m=>m.id&&!m.command)}
    reply(data:any){this.onmessage?.({data})}
  }
  vi.stubGlobal('Worker',WorkerStub)
  const {ProgressiveSurface}=await import('./ProgressiveSurface')
  const document=blank(),container=window.document.createElement('div'),root=createRoot(container)
  const props={document,pageId:document.pages[0].id,width:100,height:100,view:{x:0,y:0,zoom:1},grid:false,backend:'cpu' as const,onFallback:vi.fn()}
  try{
    await act(async()=>{root.render(<ProgressiveSurface {...props}/> )})
    const worker=WorkerStub.instances[0]
    await vi.waitFor(()=>expect(worker.requests()).toHaveLength(1));const first=worker.requests()[0]
    // Accepted synchronization remains pending while the presentation intent changes.
    state.sequence=2
    await act(async()=>{root.render(<ProgressiveSurface {...props} view={{x:10,y:0,zoom:2}}/>)})
    expect(worker.messages.filter(m=>m.command==='cancel-request').map(m=>m.requestId)).toEqual([first.id])
    expect(worker.requests()).toHaveLength(1)
    await act(async()=>{worker.reply({id:first.id,documentSynchronized:true,stateReceipt:null})})
    await vi.waitFor(()=>expect(worker.requests()).toHaveLength(2));const second=worker.requests()[1]
    const late={width:100,height:100,close:vi.fn()}
    await act(async()=>{worker.reply({id:first.id,bitmap:late,buffer:new ArrayBuffer(0),width:100,height:100,backend:'cpu',milliseconds:1,stats:{nodes:0}})})
    expect(late.close).toHaveBeenCalledOnce()
    expect(props.onFallback).not.toHaveBeenCalled()
    // A → B → A is a new ownership token, not coordinate equality.
    state.sequence=3
    await act(async()=>{root.render(<ProgressiveSurface {...props}/>)})
    await vi.waitFor(()=>expect(worker.requests()).toHaveLength(3));const third=worker.requests()[2]
    const staleB={width:100,height:100,close:vi.fn()}
    await act(async()=>{worker.reply({id:second.id,bitmap:staleB,buffer:new ArrayBuffer(0),backend:'cpu',milliseconds:1,stats:{nodes:0}})})
    expect(staleB.close).toHaveBeenCalledOnce()
    const complete={width:100,height:100,close:vi.fn()}
    await act(async()=>{worker.reply({id:third.id,bitmap:complete,buffer:new ArrayBuffer(0),backend:'cpu',milliseconds:1,stats:{nodes:0}})})
    expect(state.composites.at(-1).items.some((item:any)=>item.tile.bitmap===complete)).toBe(true)
    state.sequence=4
    await act(async()=>{root.render(<ProgressiveSurface {...props} view={{x:20,y:0,zoom:3}}/>)})
    await vi.waitFor(()=>expect(worker.requests()).toHaveLength(4));const fourth=worker.requests()[3]
    expect(complete.close).not.toHaveBeenCalled()
    expect(state.composites.at(-1).items.some((item:any)=>item.tile.bitmap===complete)).toBe(true)
    // Unmount cancels only the still-owned optional request.
    await act(async()=>root.unmount())
    expect(worker.messages.filter(m=>m.command==='cancel-request').map(m=>m.requestId)).toEqual([first.id,second.id,fourth.id])
  }finally{await act(async()=>root.unmount());delete (window as any).coreDesktop}
})

for (const boundary of ['paused','visible','contract','fonts','client'] as const) {
 test(`actual optional request signal is isolated across ${boundary} boundary`,async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  vi.stubGlobal('WebGL2RenderingContext',function(){})
  Object.defineProperty(window,'coreDesktop',{configurable:true,value:{version:1,renderPolicy:{cpuOnly:true},preparation:{open:async()=> 'owned',close:async()=>{},request:async(_id:any,r:any)=>({id:1,value:JSON.stringify(r.args[0])})}}})
  class WorkerStub {
   static instances:WorkerStub[]=[];messages:any[]=[];onmessage?:(event:any)=>void
   constructor(){WorkerStub.instances.push(this)}postMessage(message:any){this.messages.push(message)}terminate(){}
   requests(){return this.messages.filter(message=>message.id&&!message.command)}
   reply(data:any){this.onmessage?.({data})}
  }
  vi.stubGlobal('Worker',WorkerStub)
  const {KernelClient}=await import('./client'),render=vi.spyOn(KernelClient.prototype,'render')
  const {ProgressiveSurface}=await import('./ProgressiveSurface')
  const document=blank(),container=window.document.createElement('div'),root=createRoot(container)
  const props={document,pageId:document.pages[0].id,width:100,height:100,view:{x:0,y:0,zoom:1},grid:false,backend:'cpu' as const,onFallback:vi.fn()}
  try {
   await act(async()=>root.render(<ProgressiveSurface key="first" {...props}/>))
   const worker=WorkerStub.instances[0];await vi.waitFor(()=>expect(worker.requests()).toHaveLength(1))
   const first=worker.requests()[0],oldSignal=render.mock.calls[0][8]!
   expect(oldSignal.aborted).toBe(false)
   const changed={...props,...(boundary==='paused'?{paused:true}:boundary==='visible'?{visible:false}:boundary==='contract'?{presentationEpoch:1}:boundary==='fonts'?{document:{...document,fonts:{...document.fonts}}}:{})}
   await act(async()=>root.render(<ProgressiveSurface key={boundary==='client'?'replacement':'first'} {...changed}/>))
   expect(oldSignal.aborted).toBe(true)
   expect(worker.messages.filter(message=>message.command==='cancel-request').map(message=>message.requestId)).toContain(first.id)
   await act(async()=>worker.reply({id:first.id,documentSynchronized:true,stateReceipt:null}))
   if(boundary==='paused'||boundary==='visible')await act(async()=>root.render(<ProgressiveSurface key="first" {...props}/>))
   // Hidden-state work can already have accepted synchronization before resume.
   // Drain its ACK, not its obsolete presentation, before expecting the successor.
   if(boundary==='visible')await act(async()=>{for(const request of worker.requests().slice(1))worker.reply({id:request.id,documentSynchronized:true,stateReceipt:null})})
   await vi.waitFor(()=>expect(render.mock.calls.filter(call=>call[8]&&!call[8]!.aborted)).toHaveLength(1))
   const currentSignal=render.mock.calls.filter(call=>call[8]&&!call[8]!.aborted).at(-1)![8]!
   expect(currentSignal).not.toBe(oldSignal)
   const stale={width:100,height:100,close:vi.fn()}
   await act(async()=>worker.reply({id:first.id,bitmap:stale,buffer:new ArrayBuffer(0),width:100,height:100,backend:'cpu',milliseconds:1,stats:{nodes:0}}))
   expect(currentSignal.aborted).toBe(false)
   expect(props.onFallback).not.toHaveBeenCalled()
  } finally {await act(async()=>root.unmount());render.mockRestore();delete(window as any).coreDesktop}
 })
}

test('same sampled raw pan preserves the actual pending request signal',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('WebGL2RenderingContext',function(){})
 Object.defineProperty(window,'coreDesktop',{configurable:true,value:{version:1,renderPolicy:{cpuOnly:true},preparation:{open:async()=> 'owned',close:async()=>{},request:async(_id:any,r:any)=>({id:1,value:JSON.stringify(r.args[0])})}}})
 class WorkerStub{static instances:WorkerStub[]=[];messages:any[]=[];constructor(){WorkerStub.instances.push(this)}postMessage(message:any){this.messages.push(message)}terminate(){}}
 vi.stubGlobal('Worker',WorkerStub)
 const {KernelClient}=await import('./client'),render=vi.spyOn(KernelClient.prototype,'render')
 const {ProgressiveSurface}=await import('./ProgressiveSurface'),document=blank(),root=createRoot(window.document.createElement('div'))
 const props={document,pageId:document.pages[0].id,width:100,height:100,view:{x:0,y:0,zoom:1},grid:false,backend:'cpu' as const,onFallback:vi.fn()}
 try{await act(async()=>root.render(<ProgressiveSurface {...props}/>));await vi.waitFor(()=>expect(render).toHaveBeenCalledOnce());const signal=render.mock.calls[0][8]!
  await act(async()=>root.render(<ProgressiveSurface {...props} view={{x:20,y:10,zoom:1}}/>))
  expect(signal.aborted).toBe(false);expect(render).toHaveBeenCalledOnce();expect(WorkerStub.instances[0].messages.some(message=>message.command==='cancel-request')).toBe(false)
 }finally{await act(async()=>root.unmount());render.mockRestore();delete(window as any).coreDesktop}
})

test('late rejection of an old size A cannot clear a newer A admission after A to B to A', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('WebGL2RenderingContext', function () {})
  Object.defineProperty(window, 'coreDesktop', { configurable: true,
    value: { version: 1, renderPolicy: { cpuOnly: true } } })
  class WorkerStub {
    postMessage() {}
    terminate() {}
  }
  vi.stubGlobal('Worker', WorkerStub)
  const { KernelClient } = await import('./client')
  const pending: { width: number; signal?: AbortSignal; reject(error: Error): void }[] = []
  // Model work still waiting for a permit/ordered synchronization. Its promise
  // deliberately rejects after its signal, so newer intents can reuse the key.
  const render = vi.spyOn(KernelClient.prototype, 'render').mockImplementation(
    (_document, options, _png, _backend, _readback, _reference, _debug, _progress, signal) =>
      new Promise<any>((_resolve, reject) => pending.push({ width: options.width, signal, reject })))
  const { ProgressiveSurface } = await import('./ProgressiveSurface')
  const document = blank(), root = createRoot(window.document.createElement('div'))
  const props = { document, pageId: document.pages[0].id, width: 100, height: 100,
    view: { x: 0, y: 0, zoom: 1 }, grid: false, backend: 'cpu' as const, onFallback: vi.fn() }
  try {
    await act(async () => root.render(<ProgressiveSurface {...props} />))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const oldA = pending[0]
    await act(async () => root.render(<ProgressiveSurface {...props} width={120} />))
    await act(async () => root.render(<ProgressiveSurface {...props} />))
    expect(oldA.signal?.aborted).toBe(true)
    expect(pending).toHaveLength(1)
    await act(async () => oldA.reject(Error('PREVIEW_CANCELLED')))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(pending[1].width).toBe(100)
    expect(pending[1].signal?.aborted).toBe(false)
    expect(props.onFallback).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    pending.forEach(request => request.reject(Error('PREVIEW_CANCELLED')))
    render.mockRestore()
    delete (window as any).coreDesktop
  }
})
