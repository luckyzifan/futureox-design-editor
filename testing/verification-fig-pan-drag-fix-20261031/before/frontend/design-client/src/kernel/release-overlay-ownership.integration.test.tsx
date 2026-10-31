/** Production Surface -> InteractionRenderer -> ResidentPresenter ownership.
 * Only capture completion and GPU descriptors are adapters. No pixel oracle. */
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import {appendFileSync} from 'node:fs'
import React, {act} from 'react'
import {createRoot} from 'react-dom/client'
import {afterEach,expect,test,vi} from 'vitest'
import {blank,node,effect} from '../model'
import {apply,scene,boxPoints,bounds,unionBounds,multiply} from '../geometry'
import {selectionLocalBounds} from '../canvas-view'
import {canvasOverlayCommands,canvasGpuOverlayOwnsUi} from '../canvas-overlay-commands'
import {ResidentCompositeSurface} from './ResidentCompositeSurface'
import {InteractionRenderer} from './interaction-renderer'
import {descriptorPresenter} from './descriptor-presenter.test-helper'
vi.mock('./content-plane',()=>({registerContentPlane:()=>()=>{}}))
vi.mock('./client',()=>({renderExecutionPolicy:{desktopDisplay:true,desktopFullMath:true},KernelClient:class{}}))
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const done of cleanup.splice(0))await done();vi.restoreAllMocks();vi.unstubAllGlobals()})

// This is the production Canvas command producer, not a command mock. Geometry
// inputs use the same production scene/selection helpers as the mounted Canvas.
type Ui = {pixelGrid?:boolean;handles?:boolean;target?:{id:string;bounds:{x:number;y:number;width:number;height:number}}|null;tool?:string}
function canvasContext(document:any,ids:string[],ui:Ui={}){
 const entries=scene(document,document.pages[0].id),selected=entries.filter(e=>ids.includes(e.id))
 const local=selected.length===1?selectionLocalBounds(document,selected[0].id):null
 const corners=local?boxPoints(local).map(point=>apply(selected[0].matrix,point)):boxPoints(unionBounds(selected.map(e=>e.bounds)))
 return canvasOverlayCommands({document,pageId:document.pages[0].id,epoch:1,tool:ui.tool||'select',pixelGrid:ui.pixelGrid??false,
  canTransform:ui.handles??true,selected,owners:ids,frameTitles:entries.filter(e=>['frame','section'].includes(document.nodes[e.id].kind)&&(e.depth===0||ids.includes(e.id))),
  localSelection:local,selectionCorners:corners,selectionBox:bounds(corners),
  measurementTarget:ui.target===undefined?{id:'target-one',bounds:{x:130,y:0,width:30,height:70}}:ui.target})
}

async function harness(kind:'rotate'|'scale'='rotate',workerPoses=false,options:{multiple?:boolean;selectedCount?:number;initialOverlay?:boolean}={}){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
 for(const k of ['window','document','navigator','HTMLElement','HTMLCanvasElement','Node','Event'])vi.stubGlobal(k,k==='window'?dom.window:(dom.window as any)[k])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 HTMLCanvasElement.prototype.transferControlToOffscreen=()=>({} as OffscreenCanvas)
 const jobs:any[]=[],frames:any[]=[],acks:any[]=[]
 let client:any
 const gpu=descriptorPresenter(stats=>{acks.push(stats);client.onPresentation?.(stats)})
 // Descriptor-only text raster adapter. Production CanvasLabels still executes;
 // this supplies deterministic metrics, not browser glyph or pixel evidence.
 const canvasPrototype=Object.getPrototypeOf(gpu.canvas),getContext=canvasPrototype.getContext
 canvasPrototype.getContext=function(kind:string){return kind==='2d'?{
  measureText:(text:string)=>({width:text.length*6,actualBoundingBoxLeft:0,actualBoundingBoxRight:text.length*6,actualBoundingBoxAscent:8,actualBoundingBoxDescent:2}),
  setTransform(){},strokeText(){},fillText(){},
 }:getContext.call(this,kind)}
 client={attachPresentation(){},present(frame:any){frames.push(frame);queueMicrotask(()=>gpu.presenter.draw(frame))},
  releasePresented(ids:number[]){gpu.presenter.release(ids)},presentationDiagnosticsEnabled:()=>false,
  stopResidentInteraction:vi.fn(),moveResidentInteraction:vi.fn(),render(doc:any,options:any){return new Promise(resolve=>jobs.push({doc,options,resolve}))}}
 const doc=blank(),n=node('frame',0,0,50,50);n.blend='normal';n.effects=[effect('glass')];doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
 const ids=[n.id]
 for(let i=1;i<(options.selectedCount||(options.multiple?2:1));i++){const next=node('frame',i*50,0,50,50);next.blend='normal';next.effects=[effect('glass')];doc.nodes[next.id]=next;doc.pages[0].children.push(next.id);ids.push(next.id)}
 const pageSlot=gpu.presenter.capture(100,100).id
 // This fixture is a complete viewport capture, not a guttered world tile.
 const page={tile:{key:'page',serial:1,gpuTile:pageSlot,x:0,y:0,width:100,height:100,zoom:1,bytes:new Uint8Array()},active:true,layer:0,gutter:0}
 const control={current:null as any},view={x:0,y:0,zoom:4}
 const interaction={document:doc,selection:ids,active:true,gestureKind:kind,epoch:1,control,onReady:vi.fn()}
 const overlay=(document:any,ui:Ui={})=>canvasContext(document,ids,ui)
 const presentation={document:doc,pageId:doc.pages[0].id,epoch:1,view,width:100,height:100,pixelRatio:1,managed:true,grid:false,checkerboard:false,pixelPreview:false,rasterProfile:'analytic',computeBackend:'webgpu',preview:false}
 const onPresented=vi.fn(),props:any={client,items:[page],view,width:100,height:100,dpr:1,pageId:doc.pages[0].id,rasterProfile:'analytic',backend:'webgpu',sourceDocument:doc,translationItems:[],allowPageTranslation:true,onReady:vi.fn(),onGone:vi.fn(),onFailure:vi.fn(),onPresented,presentation,overlay:options.initialOverlay===false?undefined:overlay(doc),interaction}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 cleanup.push(async()=>{await act(async()=>root.unmount());gpu.presenter.dispose();dom.window.close()})
 const render=async(changes:any={})=>{Object.assign(props,changes);await act(async()=>{root.render(<ResidentCompositeSurface {...props}/>);await Promise.resolve()})}
 await render();expect(jobs).toHaveLength(1)
 const oldSlot=gpu.presenter.capture(100,100).id
 await act(async()=>{jobs[0].resolve({bytes:new Uint8Array(),gpuTile:oldSlot,compileMs:1,residentInteraction:workerPoses});await Promise.resolve()})
 expect(frames.at(-1).items.some((item:any)=>item.tile.gpuTile===oldSlot)).toBe(true)
 expect(acks.at(-1).presented.gpuOverlay).toBe(options.initialOverlay!==false)
 const matrix=kind==='scale'?[1.4,0,0,1.4,0,0]:[Math.cos(.4),Math.sin(.4),-Math.sin(.4),Math.cos(.4),0,0]
 const patches=Object.fromEntries(ids.map(id=>[id,{transform:multiply(matrix as any,doc.nodes[id].transform)}]))
 await act(async()=>{expect(control.current.apply(doc,patches)).toBeTruthy()})
 expect(jobs).toHaveLength(workerPoses?1:2) // Deliberately leave the last capture/pose incomplete.
 const final={...doc,nodes:{...doc.nodes,...Object.fromEntries(ids.map(id=>[id,{...doc.nodes[id],...patches[id]}]))}}
 await act(async()=>{control.current.end(final)})
 return {doc,final,n,ids,props,control,render,frames,acks,jobs,oldSlot,overlay,onPresented,gpu,
  replaceClient:()=>{client={...client};return client}}
}

test.each([{kind:'rotate',multiple:false},{kind:'scale',multiple:false},{kind:'rotate',multiple:true},{kind:'scale',multiple:true}] as const)('retained $kind (multiple=$multiple) keeps complete capture-owned Canvas commands',async ({kind,multiple})=>{
 const h=await harness(kind,false,{multiple})
 // Production Canvas keeps the prior exact surfaceDocument for refinement,
 // while the committed overlay and interaction document advance immediately.
 const pendingOverlay=h.overlay(h.final),original=h.overlay(h.doc).commands,oldCorners=original.selection!.corners
 expect(pendingOverlay.commands.selection!.corners).not.toEqual(oldCorners)
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:pendingOverlay})
 const frame=h.frames.at(-1),ack=h.acks.at(-1).presented
 expect(frame.items.some((item:any)=>item.tile.gpuTile===h.oldSlot)).toBe(true)
 expect(frame.interaction).toBe(true);expect(ack.ids).toContain(h.oldSlot)
 expect(h.onPresented.mock.calls.at(-1)![1].document).toBe(h.doc)
 expect(h.jobs).toHaveLength(2);expect(h.props.onFailure).not.toHaveBeenCalled()
 expect(ack.gpuOverlay,JSON.stringify({oldCaptureStillVisible:ack.ids.includes(h.oldSlot),interaction:ack.interaction,overlayOwner:frame.overlay?'present':'missing',committedDocumentPreserved:h.props.interaction.document===h.final})).toBe(true)
 for(let i=0;i<oldCorners.length;i++){
  expect(frame.overlay.selection.corners[i].x).toBeCloseTo(oldCorners[i].x,9)
  expect(frame.overlay.selection.corners[i].y).toBeCloseTo(oldCorners[i].y,9)
 }
 // Exact command equality checks multi-selection AABB corners, all label
 // anchors/bases/text, and every measurement endpoint, not only gpuOverlay.
 expect(frame.overlay).toEqual(original)
 expect(frame.overlay.labels).not.toEqual(pendingOverlay.commands.labels)
 expect(frame.overlay.measurements).not.toEqual(pendingOverlay.commands.measurements)
 expect(h.props.interaction.document).toBe(h.final)
})

test.each(['overlay-geometry','selection','page','epoch','owner','next-resize','worker-pose'] as const)('%s cannot borrow a prior capture overlay',async boundary=>{
 const h=await harness('rotate',boundary==='worker-pose'),overlay=h.overlay(h.final)
 const changes:any={interaction:{...h.props.interaction,document:h.final,active:false},overlay}
 if(boundary==='overlay-geometry'){const geometry={...h.final,nodes:{...h.final.nodes,[h.n.id]:{...h.final.nodes[h.n.id],width:60}}};changes.overlay=h.overlay(geometry);changes.interaction={...changes.interaction,document:geometry,active:true}}
 if(boundary==='selection')changes.overlay={...overlay,commands:{...overlay.commands,selection:{...overlay.commands.selection,owners:['different-selection']}}}
 if(boundary==='page')changes.overlay={...overlay,pageId:'different-page'}
 if(boundary==='epoch')changes.overlay={...overlay,epoch:2}
 if(boundary==='owner')changes.client=h.replaceClient()
 if(boundary==='next-resize')changes.interaction={...changes.interaction,active:true,gestureKind:'resize'}
 await h.render(changes)
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
 expect(h.props.interaction.document).toBe(changes.interaction.document)
 expect(h.props.onFailure).not.toHaveBeenCalled()
})


test('a capture without its own complete overlay snapshot cannot borrow a newer one',async()=>{
 const h=await harness('rotate',false,{initialOverlay:false})
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:h.overlay(h.final)})
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===h.oldSlot)).toBe(true)
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
})

test('cancelled handoff cannot replay the previous capture chrome over another document',async()=>{
 const h=await harness()
 await act(async()=>h.control.current.end(h.doc))
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:h.overlay(h.final)})
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
})

test('late cancelled capture cannot replace the retained overlay cohort',async()=>{
 const h=await harness(),original=h.overlay(h.doc).commands
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:h.overlay(h.final)})
 const lateSlot=h.gpu.presenter.capture(100,100).id
 await act(async()=>{h.jobs[1].resolve({bytes:new Uint8Array(),gpuTile:lateSlot,compileMs:1});await Promise.resolve()})
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===h.oldSlot)).toBe(true)
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===lateSlot)).toBe(false)
 expect(h.frames.at(-1).overlay).toEqual(original)
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(true)
 expect(h.props.onFailure).not.toHaveBeenCalled()
})


test.each([
 ['pixel grid enabled',{pixelGrid:true}],
 ['Space hides handles',{handles:false}],
 ['Alt released',{target:null}],
 ['hover changes measurement target',{target:{id:'target-two',bounds:{x:200,y:20,width:60,height:30}}}],
 ['coincident target has another identity',{target:{id:'target-two',bounds:{x:130,y:0,width:30,height:70}}}],
 ['displayed target geometry changes',{target:{id:'target-one',bounds:{x:131,y:0,width:30,height:70}}}],
 ['tool hides selection',{tool:'vector'}],
] as const)('%s cannot hide current DOM using old capture UI',async(_label,ui)=>{
 const h=await harness(),pending={interaction:{...h.props.interaction,document:h.final,active:false},overlay:h.overlay(h.final)}
 await h.render(pending)
 const oldAck=h.onPresented.mock.calls.at(-1)![1],before=h.frames.length,oldId=h.frames.at(-1).presentationId
 expect(oldAck.gpuOverlay).toBe(true)
 const current=h.overlay(h.final,ui)
 expect(current.document).toBe(pending.overlay.document)
 expect(current.uiIdentity).not.toBe(pending.overlay.uiIdentity)
 // Synchronous ownership check: before the clearing frame is acknowledged,
 // the stale acknowledgement already cannot hide the correct current DOM.
 expect(canvasGpuOverlayOwnsUi(oldAck,current,true)).toBe(false)
 await h.render({overlay:current})
 expect(h.frames.length).toBeGreaterThan(before)
 expect(h.frames.at(-1).presentationId).not.toBe(oldId)
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===h.oldSlot)).toBe(true)
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
 const lateSlot=h.gpu.presenter.capture(100,100).id
 await act(async()=>{h.jobs[1].resolve({bytes:new Uint8Array(),gpuTile:lateSlot,compileMs:1});await Promise.resolve()})
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===lateSlot)).toBe(false)
 expect(h.props.interaction.document).toBe(h.final)
})

test('capture rejection stays closed even when source presentation advances to current document',async()=>{
 const h=await harness()
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},
  presentation:{...h.props.presentation,document:h.final},overlay:h.overlay(h.final,{pixelGrid:true})})
 expect(h.frames.at(-1).items.some((item:any)=>item.tile.gpuTile===h.oldSlot)).toBe(true)
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
})

test('returning to exactly the captured UI may reuse its geometry without rewriting committed document',async()=>{
 const h=await harness(),original=h.overlay(h.doc)
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:h.overlay(h.final,{handles:false})})
 expect(h.frames.at(-1).overlay).toBeUndefined()
 await h.render({overlay:h.overlay(h.final)})
 expect(h.frames.at(-1).overlay).toEqual(original.commands)
 expect(h.props.interaction.document).toBe(h.final)
})

test('legacy commands without a UI certificate cannot borrow retained capture geometry',async()=>{
 const h=await harness(),current=h.overlay(h.final)
 await h.render({interaction:{...h.props.interaction,document:h.final,active:false},overlay:{...current,uiIdentity:undefined}})
 expect(h.frames.at(-1).overlay).toBeUndefined()
 expect(h.acks.at(-1).presented.gpuOverlay).toBe(false)
})

test.each([1,16,64])('exact command snapshot reuse performs linear owner membership work for %i selections',async selectedCount=>{
 const calls:{owner:InteractionRenderer;args:Parameters<InteractionRenderer['capturedOverlay']>;result:ReturnType<InteractionRenderer['capturedOverlay']>}[]=[]
 const original=InteractionRenderer.prototype.capturedOverlay
 vi.spyOn(InteractionRenderer.prototype,'capturedOverlay').mockImplementation(function(this:InteractionRenderer,...args){
  const result=original.apply(this,args);calls.push({owner:this,args,result});return result
 })
 const h=await harness('rotate',false,{selectedCount})
 const own=calls.find(call=>call.args[0]===h.doc&&call.result?.commands)
 expect(own).toBeDefined()
 const owner=own!.owner,before=owner.overlayCaptureDiagnostics,iterations=20
 // Explicit work-count check, not a browser/compositor timing benchmark. The
 // command reference is the production producer object observed by Surface.
 for(let i=0;i<iterations;i++)expect(owner.capturedOverlay(...own!.args)?.commands).toBe(own!.result!.commands)
 const after=owner.overlayCaptureDiagnostics
 expect(after.snapshotCopies-before.snapshotCopies).toBe(0)
 expect(after.geometryChecks-before.geometryChecks).toBe(0)
 expect(after.snapshotReuses-before.snapshotReuses).toBe(iterations)
 expect(after.ownerMembershipChecks-before.ownerMembershipChecks).toBe(iterations*selectedCount*2)
 // A new immutable producer object still requires exactly one defensive copy;
 // equal UI identity alone never certifies the new object's geometry.
 const fresh=h.overlay(h.doc)
 expect(owner.capturedOverlay(h.doc,h.doc.pages[0].id,1,fresh.commands,fresh.uiIdentity)?.commands).toEqual(fresh.commands)
 expect(owner.overlayCaptureDiagnostics.snapshotCopies-after.snapshotCopies).toBe(1)
 if(process.env.OVERLAY_WORK_COUNTS)appendFileSync(process.env.OVERLAY_WORK_COUNTS,JSON.stringify({selectedCount,iterations,before,after,fresh:owner.overlayCaptureDiagnostics})+'\n')
})
