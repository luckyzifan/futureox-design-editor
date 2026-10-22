import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { blank, node, effect } from '../model'
import { ResidentCompositeSurface } from './ResidentCompositeSurface'
import { InteractionRenderer } from './interaction-renderer'
vi.mock('./content-plane',()=>({registerContentPlane:()=>()=>{}}))
vi.mock('./client',()=>({renderExecutionPolicy:{desktopDisplay:true,desktopFullMath:true},KernelClient:class{}}))
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const c of cleanup.splice(0))await c();vi.restoreAllMocks();vi.unstubAllGlobals()})
const page=(serial:number,gpuTile:number)=>({tile:{key:`page-${serial}`,serial,gpuTile,x:0,y:0,width:100,height:100,zoom:1,bytes:new Uint8Array()},active:true,layer:0})
async function harness(kind='rotate',detail?:boolean){
 const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
 for(const k of ['window','document','navigator','HTMLElement','HTMLCanvasElement','Node','Event'])vi.stubGlobal(k,k==='window'?dom.window:(dom.window as any)[k])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const trace:any[]=[]
 if(detail!==undefined){
  (dom.window as any).coreDesktop={renderDiagnostics:true,renderDiagnosticsDetail:detail}
  vi.spyOn(console,'log').mockImplementation((value:any)=>{if(typeof value==='string'&&value.startsWith('[render-diag] ')){const parsed=JSON.parse(value.slice(14));trace.push(...(parsed.batch||[parsed]))}})
 }
 HTMLCanvasElement.prototype.transferControlToOffscreen=vi.fn(()=>({} as OffscreenCanvas))
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host)
 cleanup.push(async()=>{await act(async()=>root.unmount());dom.window.close()})
 const jobs:any[]=[],frames:any[]=[]
 const client={attachPresentation:vi.fn(),present:vi.fn((frame:any)=>frames.push(frame)),releasePresented:vi.fn(),
 presentationDiagnosticsEnabled:()=>false,stopResidentInteraction:vi.fn(),cancelPreview:vi.fn(),
 render(doc:any,options:any){return new Promise(resolve=>jobs.push({doc,options,resolve}))}}
 const doc=blank(),n=node('frame',0,0,50,50);n.transform=[Math.cos(.2),Math.sin(.2),-Math.sin(.2),Math.cos(.2),0,0];n.blend='normal';n.effects=[effect('glass')];doc.nodes[n.id]=n;doc.pages[0].children=[n.id]
 const control={current:null as any},interaction={document:doc,selection:[n.id],active:true,gestureKind:kind,epoch:1,control,onReady:vi.fn()}
 const props:any={client,items:[page(1,1)],view:{x:0,y:0,zoom:1},width:100,height:100,dpr:1,pageId:doc.pages[0].id,rasterProfile:'analytic',backend:'webgpu',sourceDocument:doc,translationItems:[],allowPageTranslation:true,onReady:vi.fn(),onGone:vi.fn(),onFailure:vi.fn(),presentation:null,interaction}
 async function render(changes:any={}){Object.assign(props,changes);await act(async()=>root.render(<ResidentCompositeSurface {...props}/>))}
 async function resolve(index:number,slot:number){await act(async()=>{jobs[index].resolve({bytes:new Uint8Array(),gpuTile:slot,compileMs:1,graphMs:1});await Promise.resolve()})}
 const rotate=(angle:number)=>({...doc,nodes:{...doc.nodes,[n.id]:{...n,transform:[Math.cos(angle),Math.sin(angle),-Math.sin(angle),Math.cos(angle),0,0]}}})
 const update=async(document:any,extra:any={})=>render({sourceDocument:document,interaction:{...interaction,document},settledDocument:undefined,...extra})
 await render();expect(jobs.length).toBe(1);await resolve(0,100)
 expect(frames.at(-1).items.some((i:any)=>i.tile.gpuTile===100)).toBe(true)
 return{trace,props,client,jobs,frames,doc,n,control,interaction,render,resolve,rotate,update,ids:()=>frames.at(-1).items.map((i:any)=>i.tile.gpuTile)}
}
test.each(['rotate','resize','scale'])('active %s retains warm owner across exact readiness and next update',async kind=>{
 const h=await harness(kind),owner=h.control.current,prepare=vi.spyOn(InteractionRenderer.prototype,'prepare'),exact=page(2,2)
 await h.render({items:[exact],translationItems:[exact],settledDocument:h.doc})
 expect(h.control.current).toBe(owner);expect(prepare.mock.calls.some(call=>call[0]===undefined)).toBe(false)
 expect(h.client.stopResidentInteraction).not.toHaveBeenCalled()
 await h.update(h.rotate(.4),{translationItems:[]});expect(h.control.current).toBe(owner)
 await h.resolve(1,200);expect(h.ids()).toContain(200);expect(h.props.onFailure).not.toHaveBeenCalled()
})
test.each(['reverse','same-object-ABA'])('%s exact pose hides old sample and rejects older in-flight completion without an empty frame',async scenario=>{
 const h=await harness(),b=h.rotate(.4),c=scenario==='same-object-ABA'?h.doc:h.rotate(-.4),exact=page(3,3)
 await h.update(b);expect(h.jobs).toHaveLength(2)
 await h.update(c,{items:[exact],translationItems:[exact],settledDocument:c})
 expect(h.ids()).toEqual([3]);const count=h.frames.length
 await h.resolve(1,200)
 expect(h.frames.slice(count).some(f=>f.items.some((i:any)=>i.tile.gpuTile===200))).toBe(false)
 expect(h.client.releasePresented.mock.calls.some(([ids])=>ids.includes(200))).toBe(true)
 expect(h.jobs).toHaveLength(3);expect(h.jobs[2].doc).toBe(c)
 await h.resolve(2,300);expect(h.ids()).toEqual([3,300]);expect(h.frames.every(f=>f.items.length>0)).toBe(true)
})
test.each(['cancel','commit','page','owner-loss'])('%s retires prior capture safely and rejects its late success',async boundary=>{
 const h=await harness(),b=h.rotate(.4),exact=page(2,2)
 await h.update(b);const old=h.jobs[1]
 if(boundary==='cancel')await h.update(h.doc,{interaction:{...h.interaction,active:false},items:[exact],translationItems:[exact],settledDocument:h.doc})
 if(boundary==='commit')await h.update(b,{interaction:{...h.interaction,document:b,active:false},items:[exact],translationItems:[exact],settledDocument:b})
 if(boundary==='page'){
  const other=blank();await h.update(other,{pageId:other.pages[0].id,interaction:{...h.interaction,document:other,selection:[],active:false,epoch:2},items:[exact],translationItems:[exact],settledDocument:other})
 }
 if(boundary==='owner-loss')await h.render({client:{...h.client,present:vi.fn(),releasePresented:vi.fn()}})
 const from=h.frames.length;await act(async()=>{old.resolve({bytes:new Uint8Array(),gpuTile:200,compileMs:1});await Promise.resolve()})
 expect(h.frames.slice(from).some(f=>f.items.some((i:any)=>i.tile.gpuTile===200))).toBe(false)
 expect(h.client.releasePresented.mock.calls.some(([ids])=>ids.includes(200))).toBe(true)
})
test.each(['rotate','resize'])('fractional move handoff cannot keep the old page owner during next %s',async kind=>{
 const h=await harness('move',true),exact=page(2,2)
 await h.render({items:[exact],translationItems:[exact],settledDocument:h.doc})
 const move=h.control.current
 await act(async()=>{move.apply(h.doc,{[h.n.id]:{transform:[...h.n.transform.slice(0,4),1,0]}})})
 expect((h.client as any).presentationInputOwner).toContain(':page:')
 await act(async()=>{move.apply(h.doc,{[h.n.id]:{transform:[...h.n.transform.slice(0,4),.1,0]}})})
 // Keep the fallback capture unresolved: page.handingOff is true and the
 // replacement InteractionRenderer has no ready tile yet.
 const next=h.rotate(-.4)
 await h.update(next,{interaction:{...h.interaction,document:next,gestureKind:kind},translationItems:[]})
 expect((h.client as any).presentationInputOwner).toContain(':layer:')
 const switchRow=h.trace.find(r=>r.event==='handoff-trace'&&r.handoffDecision===1&&r.handoffReason===1&&r.handoffOwnerKind===2&&r.handoffPreviousOwnerKind===1)
 expect(switchRow).toBeDefined()
 expect(switchRow.handoffGesture).toBe(kind==='rotate'?2:3)
 expect(h.frames.at(-1).items.every((i:any)=>!i.placement)).toBe(true)
 expect(h.frames.at(-1).items.length).toBeGreaterThan(0)
})

test.each([false,true])('handoff causal chain survives terminal cleaning detail=%s',async detail=>{
 const h=await harness('rotate',detail),owner=h.control.current,b=h.rotate(.4),c=h.rotate(-.4),exact=page(3,3)
 await h.update(b);await h.update(c,{items:[exact],translationItems:[exact],settledDocument:c})
 await h.resolve(1,200);await h.resolve(2,300)
 expect(h.control.current).toBe(owner)
 const rows=h.trace.filter(r=>r.event==='handoff-trace')
 expect(rows.length).toBeGreaterThan(0)
 const floor=rows.find(r=>r.handoffDecision===2&&r.handoffFloor===3)
 const hidden=rows.find(r=>r.handoffDecision===6&&r.handoffReason===4&&r.handoffSampleOrder===1)
 const rejected=rows.find(r=>r.handoffDecision===5&&r.handoffReason===4&&r.handoffSampleOrder===2)
 const accepted=rows.find(r=>r.handoffDecision===4&&r.handoffSampleOrder===3)
 expect([floor,hidden,rejected,accepted],JSON.stringify(rows)).not.toContain(undefined)
 expect(floor.handoffSequence).toBeLessThan(hidden.handoffSequence)
 expect(hidden.handoffSequence).toBeLessThan(rejected.handoffSequence)
 expect(rejected.handoffSequence).toBeLessThan(accepted.handoffSequence)
 expect(new Set([floor,hidden,rejected,accepted].map(r=>r.handoffOwner)).size).toBe(1)
 expect(rows.some(r=>r.handoffDecision===1&&r.handoffReason===1&&r.handoffOwnerKind===2&&r.handoffGesture===2)).toBe(true)
 expect(rows.every(r=>!('document' in r)&&!('nodeId' in r)&&!('matrix' in r)&&!('operationId' in r))).toBe(true)
})
