import { PoseDiagnostics } from './pose-diagnostics'
import { beforeAll, afterEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { blank, node, type Matrix } from '../model'
import { recoverInteractionPreview, type InteractionPreviewFailure } from './interaction-preview-recovery'
import { Editor } from '../engine'
import { initializePicking } from './picking'
import { InteractionRenderer } from './interaction-renderer'
import { KernelClient } from './client'
const worker = vi.hoisted(() => ({ jobs: [] as any[], stops: [] as number[] }))
vi.mock('./client', () => ({ KernelClient: class {
  cancelPreview() {} dispose() {} moveResidentInteraction() {}
  stopResidentInteraction(id: number) { worker.stops.push(id) }
  releasePresented() {}
  render(document: unknown, options: any) {
    return new Promise((resolve, reject) => worker.jobs.push({document,options,reject,
      resolve:(result={})=>resolve({bytes:new Uint8Array(options.width*options.height*4),...result})}))
  }
}}))
beforeAll(async () => {
 await initializePicking({wasm:new Uint8Array(await readFile(new URL('../../public/kernel/design_kernel_bg.wasm',import.meta.url))),
 font:new Uint8Array(await readFile(new URL('../../public/fonts/NotoSansSC.ttf',import.meta.url)))})
})
afterEach(()=>{worker.jobs.length=worker.stops.length=0;vi.unstubAllEnvs()})
for (const finish of ['commit','cancel'] as const) test(`failed live preview falls back to actual Editor ${finish} without double movement/history`,async()=>{
 vi.stubEnv('VITE_DESIGN_RESIDENT_PENDING_POSE','1')
 const doc=blank(),root=node('frame',0,0,240,180),child=node('rectangle',40,40,24,20)
 root.blend='normal';root.clip=false;root.children=[child.id];doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
 const editor=new Editor(doc),client=new KernelClient(),owner=new InteractionRenderer(()=>{},client)
 const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
 const patch=(x:number)=>({[child.id]:{transform:[1,0,0,1,x,40] as Matrix}})
 try {
  editor.select([child.id]);editor.begin('move')
  owner.prepare({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){}},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  worker.jobs[0].resolve({gpuTile:920,residentInteraction:false});await flush()
  expect(owner.control.apply(editor.state.doc,patch(52))).toEqual({x:12,y:0})
  worker.jobs[1].reject(Error('Sampling coordinate field exceeds 64 MiB'));await flush()
  expect(owner.control.apply(editor.state.doc,patch(56))).toBeNull()
  expect(editor.state.doc.nodes[child.id].transform[4]).toBe(40)
  expect(editor.preview(patch(56))).toBe(true)
  owner.control.end(editor.state.doc)
  expect(owner.control.isActive()).toBe(false)
  expect(worker.stops).toContain(920)
  const jobs = worker.jobs.length
  owner.prepare({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){}},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  expect(owner.control.isActive()).toBe(false)
  expect(worker.jobs.length).toBe(jobs)
  // Canvas flushes the final pointer-up proposal again; it must remain an
  // absolute preview in the same transaction, not a second delta or undo item.
  expect(editor.preview(patch(56))).toBe(true)
  owner.control.end(editor.state.doc)
  expect(worker.stops.filter(id=>id===920)).toHaveLength(1)
  editor[finish]()
  expect(editor.state.doc.nodes[child.id].transform[4]).toBe(finish==='commit'?56:40)
  expect(editor.canUndo).toBe(finish==='commit')
  if(finish==='commit') {editor.undo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(40);expect(editor.canUndo).toBe(false);editor.redo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(56)}
  owner.prepare({document:editor.state.doc,selection:[child.id],active:false,epoch:editor.sessionGeneration,control:{current:null},onReady(){}},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  expect(owner.error).toBe('')
  owner.prepare({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){}},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  expect(owner.control.apply(editor.state.doc,patch(64))).not.toBeNull()
 } finally {owner.dispose();editor.dispose()}
})


test.each(['commit','cancel','pointer-after-failure','props-lag'] as const)('fatal capture after pointer stops immediately recovers latest absolute patch then %s',async finish=>{
 const doc=blank(),root=node('frame',0,0,240,180),child=node('rectangle',40,40,24,20)
 root.blend='normal';root.children=[child.id];doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
 const rows:Record<string,number>[]=[]
 const editor=new Editor(doc),client=new KernelClient(),owner=new InteractionRenderer(()=>{},client,false,new PoseDiagnostics(row=>rows.push(row)))
 const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
 const patch=(x:number)=>({[child.id]:{transform:[1,0,0,1,x,40] as Matrix}})
 let pending:Parameters<Editor['preview']>|null=null;const preview=vi.spyOn(editor,'preview')
 const failure=vi.fn((event:InteractionPreviewFailure)=>recoverInteractionPreview(event,{editor,pending:()=>pending,
  gesture:()=>({kind:'move',ids:[child.id]}),sequence:()=>owner.control.inputSequence!(),clearPending:()=>{pending=null},
  restoreRetained:()=>{},end:()=>owner.control.end(editor.state.doc),restoreOverlays:()=>{}}))
 try{
  editor.select([child.id]);editor.begin('move')
  owner.prepare({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){},onPreviewFailed:failure},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  worker.jobs[0].resolve({gpuTile:960,residentInteraction:false});await flush()
  if(finish==='props-lag')owner.prepare({document:editor.state.doc,selection:[child.id],active:false,epoch:editor.sessionGeneration,control:{current:null},onReady(){},onPreviewFailed:failure},doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
  owner.control.apply(editor.state.doc,patch(52));pending=[patch(52)]
  owner.control.apply(editor.state.doc,patch(60));pending=[patch(60)]
  worker.jobs[1].reject(Error('Sampling coordinate field exceeds 64 MiB'));await flush()
  expect(failure).toHaveBeenCalledOnce();expect(preview).toHaveBeenCalledOnce()
  expect(rows.filter(row=>row.poseStage===7&&row.poseReason===5)).toHaveLength(1)
  const terminal=rows.filter(row=>row.poseStage===5)
  expect(terminal).toHaveLength(1);expect(terminal[0]).toMatchObject({poseReason:5,posePendingCount:2,poseSubmittedCount:2})
  const through=owner.control.inputSequence!()
  owner.acceptPresentedInput(through,performance.now(),true,true)
  expect(rows.filter(row=>row.poseStage===5)).toHaveLength(1)
  expect(failure).toHaveBeenCalledOnce()

  expect(editor.state.doc.nodes[child.id].transform[4]).toBe(60)
  expect(worker.stops.filter(id=>id===960)).toHaveLength(1)
  expect(owner.control.isActive()).toBe(false)
  const finalX=finish==='pointer-after-failure'?68:60
  if(finish==='pointer-after-failure'){
   expect(owner.control.apply(editor.state.doc,patch(68))).toBeNull()
   editor.preview(patch(68));owner.control.end(editor.state.doc)
  }
  editor[finish==='cancel'?'cancel':'commit']()
  expect(editor.state.doc.nodes[child.id].transform[4]).toBe(finish==='cancel'?40:finalX)
  expect(editor.canUndo).toBe(finish!=='cancel')
  if(finish!=='cancel'){editor.undo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(40);expect(editor.canUndo).toBe(false);editor.redo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(finalX)}
 }finally{preview.mockRestore();owner.dispose();editor.dispose()}
})

test.each(['end','cancel','commit','dispose','document','document-aba','epoch','selection','cancelled','new-gesture'] as const)('late capture failure is fenced after %s',async change=>{
 const doc=blank(),root=node('frame',0,0,240,180),child=node('rectangle',40,40,24,20)
 root.blend='normal';root.children=[child.id];doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
 const editor=new Editor(doc),owner=new InteractionRenderer(()=>{},new KernelClient()),failure=vi.fn()
 const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
 const props=()=>({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){},onPreviewFailed:failure})
 const prepare=(p=props())=>owner.prepare(p,doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
 try{
 editor.select([child.id]);editor.begin('move');prepare();worker.jobs[0].resolve({gpuTile:961,residentInteraction:false});await flush()
 owner.control.apply(editor.state.doc,{[child.id]:{transform:[1,0,0,1,60,40]}})
 const failed=worker.jobs[1]
 if(change==='end')owner.control.end(editor.state.doc)
 else if(change==='new-gesture'){editor.cancel();owner.control.end(editor.state.doc);editor.begin('move');owner.control.apply(editor.state.doc,{[child.id]:{transform:[1,0,0,1,70,40]}})}
 else if(change==='cancel'||change==='commit'){editor[change]();owner.control.end(editor.state.doc)}
 else if(change==='dispose')owner.dispose()
 else if(change==='document'||change==='document-aba'){
  const original=props();prepare({...original,document:{...original.document}})
  if(change==='document-aba')prepare(original)
 }else if(change==='epoch')prepare({...props(),epoch:editor.sessionGeneration+1})
 else if(change==='selection')prepare({...props(),selection:[]})
 failed.reject(Error(change==='cancelled'?'PREVIEW_CANCELLED':'Sampling coordinate field exceeds 64 MiB'));await flush()
 expect(failure).not.toHaveBeenCalled()
 if(change==='new-gesture'){
  const patches={[child.id]:{transform:[1,0,0,1,80,40] as Matrix}}
  // A predecessor's error can still select ordinary preview; it must not
  // drop the new authored transaction or replay its old absolute patch.
  const accepted=owner.control.apply(editor.state.doc,patches)
  if(accepted===null){expect(editor.preview(patches)).toBe(true);owner.control.end(editor.state.doc)}
  else {expect(editor.preview(patches)).toBe(true);owner.control.end(editor.state.doc)}
  editor.commit();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(80)
  editor.undo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(40);expect(editor.canUndo).toBe(false)
 }
 }finally{owner.dispose();editor.dispose()}
})

test.each(['commit','cancel','undo','redo','document','page','sequence','selection','gesture','duplicate','pending','reentry'] as const)('Canvas recovery receiver checks current Editor ownership: %s',async boundary=>{
 const doc=blank(),child=node('rectangle',40,40,24,20);doc.nodes[child.id]=child;doc.pages[0].children=[child.id]
 const editor=new Editor(doc)
 try{
 editor.select([child.id]);editor.begin('move')
 let pending:Parameters<Editor['preview']>|null=[{[child.id]:{transform:[1,0,0,1,60,40] as Matrix}}]
 const event:InteractionPreviewFailure={document:editor.state.doc,epoch:editor.sessionGeneration,pageId:editor.state.page,sequence:2,ids:[child.id]}
 let gesture:{kind:string;ids:string[];duplicating?:boolean}|null={kind:'move',ids:[child.id]}
 let sequence=2,reentered:boolean|undefined
 const preview=vi.spyOn(editor,'preview')
 const context={editor,pending:()=>pending,gesture:()=>gesture,sequence:()=>sequence,clearPending:()=>{pending=null},
  restoreRetained:()=>{if(boundary==='reentry')reentered=recoverInteractionPreview(event,context)},end:vi.fn(),restoreOverlays:vi.fn()}
 if(boundary==='commit'||boundary==='cancel'||boundary==='undo'||boundary==='redo')editor[boundary]()
 if(boundary==='document')event.document={...event.document}
 if(boundary==='page')event.pageId='different'
 if(boundary==='sequence')sequence=3
 if(boundary==='selection')editor.select([])
 if(boundary==='gesture')gesture=null
 if(boundary==='duplicate')gesture!.duplicating=true
 if(boundary==='pending')pending=null
 const accepted=recoverInteractionPreview(event,context)
 expect(accepted).toBe(boundary==='reentry')
 expect(preview).toHaveBeenCalledTimes(boundary==='reentry'?1:0)
 if(boundary==='reentry'){expect(reentered).toBe(false);expect(context.end).toHaveBeenCalledOnce();editor.commit();editor.undo();expect(editor.state.doc.nodes[child.id].transform[4]).toBe(40)}
 preview.mockRestore()
 }finally{editor.dispose()}
})

test.each(['commit','cancel','document','new-gesture'] as const)('queued fatal notification is rejected after intervening %s',async boundary=>{
 const doc=blank(),root=node('frame',0,0,240,180),child=node('rectangle',40,40,24,20)
 root.blend='normal';root.children=[child.id];doc.nodes[root.id]=root;doc.nodes[child.id]=child;doc.pages[0].children=[root.id]
 const editor=new Editor(doc),owner=new InteractionRenderer(()=>{},new KernelClient()),failure=vi.fn()
 const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve()}
 const props=()=>({document:editor.state.doc,selection:[child.id],active:true,epoch:editor.sessionGeneration,control:{current:null},onReady(){},onPreviewFailed:failure})
 const prepare=(p=props())=>owner.prepare(p,doc.pages[0].id,{x:0,y:0,zoom:1},2,'figmaSubpixel','webgpu',undefined,{width:240,height:180})
 const queued:(()=>void)[]=[]
 try{
  editor.select([child.id]);editor.begin('move');prepare();worker.jobs[0].resolve({gpuTile:962,residentInteraction:false});await flush()
  owner.control.apply(editor.state.doc,{[child.id]:{transform:[1,0,0,1,60,40]}})
  vi.stubGlobal('queueMicrotask',(fn:()=>void)=>queued.push(fn))
  worker.jobs[1].reject(Error('Sampling coordinate field exceeds 64 MiB'));await flush()
  expect(queued).toHaveLength(1);expect(failure).not.toHaveBeenCalled()
  if(boundary==='document')prepare({...props(),document:{...editor.state.doc}})
  else {editor[boundary==='new-gesture'?'cancel':boundary]();owner.control.end(editor.state.doc)
   if(boundary==='new-gesture'){editor.begin('move');owner.control.apply(editor.state.doc,{[child.id]:{transform:[1,0,0,1,70,40]}})} }
  queued.shift()!();expect(failure).not.toHaveBeenCalled()
 }finally{vi.unstubAllGlobals();owner.dispose();editor.dispose()}
})
