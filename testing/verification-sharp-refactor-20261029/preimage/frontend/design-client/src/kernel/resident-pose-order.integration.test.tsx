/** Actual Surface -> InteractionRenderer -> render-worker/native WASM ->
 * ResidentPresenter protocol. Only WebGPU operations and cross-thread transport
 * are descriptor/loopback adapters. This does not certify physical GPU pixels. */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { blank, node, effect, type DesignDocument, type Matrix } from '../model'
import { createRenderPolicy } from './render-policy'
import { descriptorPresenter } from './descriptor-presenter.test-helper'
import { residentFrameSignature } from './gpu/resident-frame'
const state=vi.hoisted(()=>({report:undefined as any,presenter:undefined as any,gpu:undefined as any,onPost:undefined as any,
  font:undefined as Uint8Array|undefined,compileCount:0,renders:0,holdAcks:false,heldAcks:[] as any[],holdSamples:false,heldSamples:[] as any[],failPresent:0,afterPresentFailure:undefined as any,frames:[] as any[],renderGate:undefined as undefined|Promise<void>,renderBlocked:false}))
vi.mock('./client',()=>({renderExecutionPolicy:{desktopDisplay:true,desktopFullMath:true},KernelClient:class{}}))
vi.mock('./content-plane',()=>({registerContentPlane:()=>()=>{}}))
vi.mock('./kernel-resources',()=>({loadKernelResources:async()=>state.font}))
vi.mock('./image-mip-cache',()=>({imageCacheKey:async()=>undefined,readCachedImage:async()=>undefined,writeCachedImage(){}}))
vi.mock('./gpu/factory',()=>({straightAlpha:(bytes:Uint8Array)=>bytes,
  createGpu:async()=>({driver:{name:'webgpu',managed:true,displayMath:true,lost:false,description:'descriptor-only WebGPU',
    attachPresenter(_canvas:any,report:any){state.report=report;if(!state.gpu){state.gpu=descriptorPresenter(report);state.presenter=state.gpu.presenter}},
    presentFrame(frame:any){state.frames.push(frame);if(state.failPresent&&state.failPresent===frame.input?.sequence){state.failPresent=0;state.afterPresentFailure?.();throw Error('injected presenter submission failure')}state.presenter.draw(frame)},
    replacePresented(slot:number,next:number){return state.presenter.replace(slot,next)},
    releasePresented(ids:number[]){state.presenter?.release(ids)},stats:()=>({}),
    abortFrameAndReleaseFilterScratch:async()=>{}},
    async render(scene:any){state.renders++;if(state.renderGate){state.renderBlocked=true;await state.renderGate}
      return {gpuTile:state.presenter.capture(scene.width,scene.height).id,drawCalls:0,triangles:0}},
    dispose(){state.presenter?.dispose();state.presenter=undefined;state.gpu=undefined},abortFrameAndReleaseFilterScratch:async()=>{},releaseFilterBatch(){}})
}))
const real117Input=process.env.CORE_ROTATION_117_INPUT
const hasReal117Input=!!real117Input&&existsSync(real117Input)
if(!hasReal117Input)console.warn('[rotation117] Three real117 cases skipped: set CORE_ROTATION_117_INPUT to an existing parsed JSON fixture.')
const NativeMessageChannel=MessageChannel, cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const done of cleanup.splice(0))await done();vi.unstubAllGlobals();vi.restoreAllMocks();vi.resetModules()})
async function harness(real117=false,kind:'move'|'rotate'|'scale'='rotate'){
  vi.resetModules();Object.assign(state,{report:undefined,presenter:undefined,gpu:undefined,onPost:undefined,renders:0,frames:[],holdAcks:false,heldAcks:[],holdSamples:false,heldSamples:[],failPresent:0,afterPresentFailure:undefined,renderGate:undefined,renderBlocked:false})
  const dom=new JSDOM('<html><body></body></html>',{url:'https://design.invalid/'})
  for(const k of ['window','document','navigator','HTMLElement','HTMLCanvasElement','Node','Event'])vi.stubGlobal(k,k==='window'?dom.window:(dom.window as any)[k])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  HTMLCanvasElement.prototype.transferControlToOffscreen=()=>({} as OffscreenCanvas)
  const channels:MessageChannel[]=[];vi.stubGlobal('MessageChannel',class{constructor(){const c=new NativeMessageChannel();channels.push(c);return c}})
  const jobs=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>(),messages:any[]=[]
  let client:any
  const scope:any={postMessage(value:any){messages.push(value);queueMicrotask(()=>{
    const job=jobs.get(value.id)
    if(job&&(value.backend||value.error)){jobs.delete(value.id);value.error?job.reject(Error(value.error)):job.resolve({...value,bytes:new Uint8Array(value.buffer||0)})}
    if(value.presentation){if(state.holdAcks&&value.presentation.presented){state.heldAcks.push(value.presentation);return}if(state.holdSamples&&value.presentation.residentSample){state.heldSamples.push(value.presentation);return}client?.onPresentation?.(value.presentation)}
  })}}
  vi.stubGlobal('self',scope)
  const wasm=new Uint8Array(readFileSync(new URL('../../public/kernel/design_kernel_bg.wasm',import.meta.url)))
  state.font=new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf',import.meta.url)))
  await (await import('./module')).initializeKernelModule(wasm)
  await import('./render-worker')
  const executionPolicy=createRenderPolicy(false,false,false,false,true,true)
  const send=(request:any)=>queueMicrotask(()=>scope.onmessage({data:{executionPolicy,backend:'webgpu',...request}}))
  let id=0,revision=0
  client={attachPresentation(canvas:any){send({command:'display-attach',canvas})},presentationDiagnosticsEnabled:()=>false,
    present(frame:any){send({command:'display-frame',sequence:++id,frame})},
    releasePresented(ids:number[]){send({command:'display-release',ids})},
    stopResidentInteraction(slot:number){send({command:'interaction-pose-stop',slot})},
    moveResidentInteraction(slot:number,transforms:any,input:any){send({command:'interaction-pose',slot,transforms,input:{...input,owner:client.presentationInputOwner}})},
    render(document:DesignDocument,options:any){return new Promise((resolve,reject)=>{const request=++id;jobs.set(request,{resolve,reject});send({id:request,channel:'interaction',document:JSON.stringify(document),documentRevision:++revision,options})})},
  }
  const doc:DesignDocument=real117?JSON.parse(readFileSync(real117Input!,'utf8')):blank()
  let selected:string
  if(real117)selected=doc.nodes[doc.pages[0].children[0]].children[0]
  else{doc.schemaVersion=5;const root=node('frame',0,0,80,80);root.blend='normal';root.effects=[effect('glass')];doc.nodes[root.id]=root;doc.pages[0].children=[root.id];selected=root.id}
  const control={current:null as any},feedback=vi.fn(),onFailure=vi.fn()
  const interaction:any={document:doc,selection:[selected],active:true,gestureKind:kind,epoch:1,control,onReady:vi.fn(),onPosePresented:feedback}
  const view={x:0,y:0,zoom:real117?.125:1}
  const props:any={client,items:[],view,width:240,height:160,dpr:1,pageId:doc.pages[0].id,rasterProfile:'figmaSubpixel',backend:'webgpu',
    sourceDocument:doc,translationItems:[],allowPageTranslation:false,onReady:vi.fn(),onGone:vi.fn(),onFailure,presentation:null,interaction}
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
  const { ResidentCompositeSurface }=await import('./ResidentCompositeSurface')
  const render=async(changes:any={})=>{Object.assign(props,changes);await act(async()=>{root.render(<ResidentCompositeSurface {...props}/>);await Promise.resolve()})}
  cleanup.push(async()=>{await act(async()=>root.unmount());await new Promise(r=>setTimeout(r,10));channels.forEach(c=>{c.port1.close();c.port2.close()});dom.window.close()})
  await render()
  await act(async()=>{await vi.waitFor(()=>expect(control.current?.isActive()&&state.frames.length,JSON.stringify({failures:onFailure.mock.calls,messages:messages.map(m=>({id:m.id,error:m.error,backend:m.backend,presentation:m.presentation&&Object.keys(m.presentation)})),renders:state.renders,active:control.current?.isActive()})).toBeTruthy())})
  expect(onFailure).not.toHaveBeenCalled()
  const original=doc.nodes[selected].transform
  const transform=(angle:number):Matrix=>kind==='move'?[...original.slice(0,4),original[4]+Math.round(angle*100),original[5]] as Matrix:kind==='scale'?[1+angle,0,0,1+angle,original[4],original[5]]:[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),original[4],original[5]]
  const apply=async(angle:number)=>{let result:any;await act(async()=>{result=control.current.apply(doc,{[selected]:{transform:transform(angle)}});await Promise.resolve()});expect(result).toBeTruthy();return control.current.inputSequence()}
  const waitSample=async(sequence:number)=>{await act(async()=>{await vi.waitFor(()=>expect(messages.some(m=>m.presentation?.residentSample?.sequence===sequence&&!m.presentation.residentSample.needsRebase)).toBe(true))})}
  return {doc,selected,control,feedback,onFailure,props,interaction,messages,send,render,apply,waitSample,transform,client,host}
}
for(const real117 of [false,true])test.skipIf(real117&&!hasReal117Input).each(['move','rotate','scale'] as const)(`native %s advances DOM feedback exactly once after real presenter ACK, real117=${real117}`,async(kind)=>{
  const h=await harness(real117,kind)
  // First affine input promotes/recompiles the warmed translation capture.
  await h.apply(.1)
  await act(async()=>{await vi.waitFor(()=>expect(state.frames.some(f=>f.input?.sequence===1),JSON.stringify(h.messages.map(m=>({id:m.id,error:m.error,sample:m.presentation?.residentSample&&{sequence:m.presentation.residentSample.sequence,rebase:m.presentation.residentSample.needsRebase},ack:m.presentation?.input?.sequence})))).toBe(true),{timeout:10000})})
  const before=h.feedback.mock.calls.length, start=h.messages.length
  const second=await h.apply(.2)
  await act(async()=>{await vi.waitFor(()=>expect(h.messages.some(m=>m.presentation?.presented&&m.presentation.input?.sequence===second)).toBe(true),{timeout:10000})})
  await act(async()=>{await new Promise(r=>setTimeout(r,20))})
  const sequence=h.messages.slice(start).filter(m=>m.presentation?.input?.sequence===second||m.presentation?.residentSample?.sequence===second)
    .map(m=>m.presentation.presented?'presented':m.presentation.residentSample?'sample':'other')
  expect(sequence).toContain('presented');if(!(real117&&kind==='move'))expect(sequence).toContain('sample')
  expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence),JSON.stringify({sequence,second,frames:state.frames.map(f=>f.input?.sequence)})).toEqual([second])
  if(kind!=='move')expect(h.feedback.mock.calls.at(-1)![0].offset.matrix).toBeDefined()
  expect(h.onFailure).not.toHaveBeenCalled()
})

async function warmAffine(h:Awaited<ReturnType<typeof harness>>){
  const first=await h.apply(.1)
  await act(async()=>{await vi.waitFor(()=>expect(state.frames.some(f=>f.input?.sequence===first)).toBe(true))})
}
test('real worker coalesces queued rotations and feedback follows only submitted complete frames',async()=>{
  const h=await harness();await warmAffine(h)
  let release!:()=>void;state.renderGate=new Promise(resolve=>{release=resolve})
  const start=h.feedback.mock.calls.length,second=await h.apply(.2)
  await act(async()=>{await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))})
  const skipped=await h.apply(.3),latest=await h.apply(.4)
  expect(h.feedback.mock.calls.slice(start)).toHaveLength(0)
  state.renderGate=undefined;release();await h.waitSample(latest)
  await act(async()=>{await new Promise(r=>setTimeout(r,10))})
  const accepted=h.feedback.mock.calls.slice(start).map(([pose])=>pose.sequence)
  expect(accepted).toEqual([second,latest]);expect(accepted).not.toContain(skipped)
  for(const sequence of accepted)expect(state.frames.some(f=>f.input?.sequence===sequence)).toBe(true)
  expect(new Set(accepted).size).toBe(accepted.length)
})
test.each(['cancel','epoch','owner-loss'] as const)('real in-flight raster cannot revive feedback after %s',async boundary=>{
  const h=await harness();await warmAffine(h)
  let release!:()=>void;state.renderGate=new Promise(resolve=>{release=resolve})
  const start=h.feedback.mock.calls.length,second=await h.apply(.2)
  await act(async()=>{await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))})
  const previous=[...h.messages].reverse().find(m=>m.presentation?.presented)?.presentation
  if(boundary==='cancel'){
    await act(async()=>{h.control.current.end(h.doc)})
    await h.render({interaction:{...h.interaction,active:false}})
  }else if(boundary==='epoch'){
    await h.render({interaction:{...h.interaction,active:false,epoch:2}})
  }else{
    await h.render({client:{...h.client,present:vi.fn(),releasePresented:vi.fn()}})
  }
  state.renderGate=undefined;release()
  await act(async()=>{await new Promise(r=>setTimeout(r,35));h.client.onPresentation?.(previous)})
  expect(h.feedback.mock.calls.slice(start)).toHaveLength(0)
  expect(h.messages.some(m=>m.presentation?.input?.sequence===second&&m.presentation.presented)).toBe(false)
})
test('a committed rotation and its late ACK cannot steal feedback from the next gesture',async()=>{
  const h=await harness();await warmAffine(h)
  const second=await h.apply(.2);await h.waitSample(second)
  await act(async()=>{await new Promise(r=>setTimeout(r,10))})
  const oldAck=[...h.messages].reverse().find(m=>m.presentation?.presented&&m.presentation.input?.sequence===second)!.presentation
  const final={...h.doc,nodes:{...h.doc.nodes,[h.selected]:{...h.doc.nodes[h.selected],transform:h.transform(.2)}}}
  await act(async()=>{h.control.current.end(final)})
  await h.render({sourceDocument:final,interaction:{...h.interaction,document:final,active:false}})
  const before=h.feedback.mock.calls.length
  await h.render({sourceDocument:final,interaction:{...h.interaction,document:final,active:true}})
  let sequence=0
  await act(async()=>{expect(h.control.current.apply(final,{[h.selected]:{transform:h.transform(-.2)}})).toBeTruthy();sequence=h.control.current.inputSequence();h.client.onPresentation(oldAck)})
  await h.waitSample(sequence)
  await act(async()=>{await new Promise(r=>setTimeout(r,10));h.client.onPresentation(oldAck)})
  expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence)).toEqual([sequence])
  expect(h.feedback.mock.calls.at(-1)![0].document).toBe(final)
})

test('completed sample without its actual presenter ACK never advances feedback',async()=>{
  const h=await harness();await warmAffine(h)
  state.holdAcks=true;const before=h.feedback.mock.calls.length,sequence=await h.apply(.2)
  await h.waitSample(sequence)
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
  expect(state.heldAcks.some(ack=>ack.input?.sequence===sequence)).toBe(true)
  const actual=state.heldAcks.find(ack=>ack.input?.sequence===sequence)
  await act(async()=>{h.client.onPresentation({...actual,presented:{...actual.presented,ids:[]}})})
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
  state.holdAcks=false
  await act(async()=>{for(const ack of state.heldAcks.splice(0))h.client.onPresentation(ack)})
  expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence)).toEqual([sequence])
})
test.each(['cancel','epoch'] as const)('buffered real ACK is revoked when %s occurs before the sample message',async boundary=>{
  const h=await harness();await warmAffine(h)
  state.holdSamples=true;const before=h.feedback.mock.calls.length,sequence=await h.apply(.2)
  await h.waitSample(sequence)
  expect(state.heldSamples.some(sample=>sample.residentSample.sequence===sequence)).toBe(true)
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
  if(boundary==='cancel')await act(async()=>{h.control.current.end(h.doc)})
  else await h.render({interaction:{...h.interaction,active:false,epoch:2}})
  state.holdSamples=false
  await act(async()=>{for(const sample of state.heldSamples.splice(0))h.client.onPresentation(sample)})
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
})
test('presenter submission failure cannot move feedback before the successful replacement frame',async()=>{
  const h=await harness();await warmAffine(h)
  const before=h.feedback.mock.calls.length
  let release!:()=>void;state.failPresent=2;state.afterPresentFailure=()=>{state.renderGate=new Promise(resolve=>{release=resolve})}
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{})
  const sequence=await h.apply(.2)
  await act(async()=>{await vi.waitFor(()=>expect(state.renderBlocked).toBe(true))})
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
  expect(h.messages.some(m=>m.presentation?.input?.sequence===sequence&&m.presentation.presented)).toBe(false)
  expect(h.messages.some(m=>m.presentation?.residentSample?.sequence===sequence&&m.presentation.residentSample.needsRebase)).toBe(true)
  state.renderGate=undefined;release()
  await act(async()=>{await vi.waitFor(()=>expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence),JSON.stringify(h.messages.map(m=>({id:m.id,error:m.error,sample:m.presentation?.residentSample&&{sequence:m.presentation.residentSample.sequence,rebase:m.presentation.residentSample.needsRebase},ack:m.presentation?.input?.sequence})))).toEqual([sequence]),{timeout:5000})})
  expect(warn).toHaveBeenCalled()
})
test('only the newest early real ACK survives while sample notifications are delayed',async()=>{
  const h=await harness();await warmAffine(h)
  state.holdSamples=true;const before=h.feedback.mock.calls.length,older=await h.apply(.2)
  await h.waitSample(older)
  const latest=await h.apply(.3);await h.waitSample(latest)
  expect(h.feedback.mock.calls.slice(before)).toHaveLength(0)
  state.holdSamples=false
  await act(async()=>{for(const sample of state.heldSamples.splice(0))h.client.onPresentation(sample)})
  expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence)).toEqual([latest])
  const oldSample=h.messages.find(m=>m.presentation?.residentSample?.sequence===older)!.presentation
  await act(async()=>{h.client.onPresentation(oldSample)})
  expect(h.feedback.mock.calls.slice(before).map(([pose])=>pose.sequence)).toEqual([latest])
})
