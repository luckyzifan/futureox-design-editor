import { beforeAll, afterEach, expect, test, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { blank, node, type Matrix } from '../model'
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
