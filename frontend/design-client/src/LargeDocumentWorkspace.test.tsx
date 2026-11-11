// Shared Editor/WASM and storage routing; native I/O and GPU are test doubles.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LargeDocumentWorkspace, type SourceWorkspace } from './LargeDocumentWorkspace'
import { SourceDocumentStatus } from './SourceDocumentStatus'
import { Editor } from './engine'
import { blank, node } from './model'
import type { LargeDocumentBridge } from './desktop'
import * as preparation from './prepared-document'
import { registerPendingEdit, pendingEditsChanged } from './pending-edits'
const binding=vi.hoisted(()=>({editor:null as Editor|null,source:null as SourceWorkspace|null}))
const bootstrap=await vi.hoisted(async()=>{
 // @ts-expect-error jsdom runtime dependency
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('<html><body></body></html>')
 for(const key of ['window','document','navigator'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
 return dom
})
bootstrap.window.close()
// Storage adapter tests use a tiny workbench boundary; actual App/Canvas GUI
// acceptance is separate. No FD/local-workspace saver participates here.
function workbench(source:SourceWorkspace){
 binding.editor=source.editor
 binding.source=source
 return <div>{source.navigation}<button onClick={()=>void source.save()}>保存修改</button><button onClick={()=>void source.exportFile()}>导出完整文件…</button><button onClick={()=>void source.leave()}>返回设计</button>
  <div className="source-workspace-canvas" inert={source.locked||undefined}>{source.ready&&<div aria-label="Shared canvas boundary"/>}</div>
  <div className="source-workspace-status">{source.error?<p role="alert">{source.error}</p>:source.notice}</div></div>
}
let dom:any,root:Root,parent:Editor
beforeEach(()=>{
 dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://design.invalid'})
 for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 parent=new Editor(blank('Original design'));root=createRoot(document.getElementById('root')!)
})
afterEach(async()=>{await act(async()=>root.unmount());parent.dispose();dom.window.close();vi.restoreAllMocks();vi.unstubAllGlobals();binding.editor=null;binding.source=null})
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>(b.textContent===label||b.getAttribute('aria-label')===label)&&!b.disabled)!
test('native-capable Sketch entry lists every material in one canvas before any local edit scope is requested',async()=>{
 const doc=blank('Material'),layer=node('rectangle',0,0,140,140);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:831806447,maxExpandedBytes:2**42,indexedObjects:124447,dirty:false,undoCount:0,redoCount:0}
 const scene=vi.fn(async()=>({status:'ok',json:JSON.stringify(doc),warnings:[],nodes:1,bytes:2048}))
 const canvasLayout=vi.fn(async({offset=0}:{offset?:number})=>({status:'ok',items:Array.from({length:Math.min(200,306-offset)},(_,i)=>({key:`1:${offset+i+1}`,id:offset+i===0?layer.id:`material-${offset+i}`,name:`素材 ${offset+i}`,kind:'frame',pageId:'p',pageName:'浅色',source:{x:0,y:0,width:140,height:140},placed:{x:(offset+i)*268,y:0,width:140,height:140},bytes:2048})),offset,total:306,hasMore:offset+200<306,boundsAreLayoutHints:true,bounds:{x:0,y:0,width:82000,height:300}}))
 const bridge={open:async()=>({status:'ok',...status}),canvasSnapshot:async()=>({status:'ok',owner:status.owner,revision:0,token:'native-source',bytes:573894001,nodes:124447,roots:306,pageId:doc.pages[0].id,stageId:'stage',bounds:{x:0,y:0,width:82000,height:300},warnings:[],rasterProfile:'figma',colorManaged:true}),canvasLayout,scene,children:async()=>({status:'ok',items:[],total:0,hasMore:false})}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(canvasLayout.mock.calls.map(([request])=>request.offset)).toEqual([0,200])
 expect(scene).not.toHaveBeenCalled();expect(binding.source!.nativeCanvas!.snapshot.roots).toBe(306)
 expect(document.querySelectorAll('[aria-label="全部素材"] [role="listitem"]')).toHaveLength(306)
 const mutation=vi.fn();await act(async()=>{binding.editor!.change('unexpected',mutation)})
 expect(mutation).not.toHaveBeenCalled();expect(Object.keys(binding.editor!.authoredDocument.nodes)).toHaveLength(0)
 await act(async()=>binding.source!.nativeCanvas!.openPoint({x:70,y:70}))
 expect(scene).toHaveBeenCalledOnce();expect(binding.source!.nativeCanvas).toBeUndefined()
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=180}))
 expect(binding.editor!.authoredDocument.nodes[layer.id].width).toBe(180)
 expect(document.body.textContent).toContain('返回完整画板')
})
test('page uses shared main canvas, sends changed nodes and exports through the source owner',async()=>{
 const doc=blank('Page'),layer=node('rectangle',0,0,140,140);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const original=JSON.stringify(parent.authoredDocument)
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:831806447,maxExpandedBytes:4294967296,indexedObjects:124399,dirty:false,undoCount:0,redoCount:0}
 const sceneCommit=vi.fn(async(_request:{json:string;key:string})=>({status:'ok',...status,revision:1,dirty:true,undoCount:1,key:'1:0'})),exported=vi.fn(async()=>({status:'ok',...status,revision:1,exported:true,displayName:'complete.sketch'}))
 const scene=vi.fn(async({key}:{key:string})=>({status:'ok',json:key==='2:0'?'{}':JSON.stringify(doc),warnings:[],nodes:1,bytes:2048}))
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[{key:'1:0',id:doc.pages[0].id,name:'Full page',kind:'page',bytes:699402701,part:'page.json',hasChildren:true},{key:'2:0',id:'unadmitted',name:'Unadmitted page',kind:'page',bytes:100,part:'other.json',hasChildren:false}],total:2,hasMore:false}),scene,sceneCommit,export:exported} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelector('[role=dialog]')).toBeNull()
 expect(document.querySelector('[aria-label="Shared canvas boundary"]')).not.toBeNull()
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=180}))
 await act(async()=>button('保存修改').click())
 expect(sceneCommit).toHaveBeenCalledTimes(1)
 const payload=sceneCommit.mock.calls[0][0]
 expect(Object.keys(JSON.parse(payload.json))).toEqual([layer.id]);expect(JSON.parse(payload.json)[layer.id].patch).toEqual({width:180});expect(payload.key).toBe('1:0')
 await act(async()=>button('导出完整文件…').click())
 expect(exported).toHaveBeenCalledWith({owner:status.owner,expectedRevision:1})
 await act(async()=>button('页面 / 画板').click())
 await act(async()=>button('载入页面 Unadmitted page').click())
 expect(scene.mock.calls.map(([request])=>request.key)).toEqual(['1:0','2:0','1:0'])
 expect(binding.editor!.authoredDocument.nodes[layer.id].width).toBe(180)
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=190}))
 await act(async()=>button('保存修改').click())
 expect(sceneCommit.mock.calls.at(-1)![0].key).toBe('1:0')
 expect(JSON.parse(sceneCommit.mock.calls.at(-1)![0].json)[layer.id].patch).toEqual({width:190})
 expect(JSON.stringify(parent.authoredDocument)).toBe(original)
})

test('pending source navigation removes stale clickable rows until the matching reply arrives',async()=>{
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:4294967296,indexedObjects:2,dirty:false,undoCount:0,redoCount:0}
 const first={key:'1:0',id:'first',name:'First',kind:'group',bytes:100,part:'page.json',hasChildren:true}
 let reply!:(value:unknown)=>void
 const children=vi.fn(async({key}:{key?:string})=>key?new Promise(resolve=>{reply=resolve}):{status:'ok',items:[first],total:1,hasMore:false})
 const bridge={open:async()=>({status:'ok',...status}),children}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelector('[data-source-key="1:0"]')).not.toBeNull()
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 First"]')!.click())
 expect(document.querySelector('[data-source-key="1:0"]')).toBeNull()
 await act(async()=>reply({status:'ok',items:[{...first,key:'1:1',id:'second',name:'Second',hasChildren:false}],total:1,hasMore:false}))
 expect(document.querySelector('[data-source-key="1:1"]')).not.toBeNull()
 expect(document.querySelector('[data-source-key="1:0"]')).toBeNull()
})

test('loading keeps the old canvas interactive and a late source cannot overwrite a new edit',async()=>{
 const doc=blank('Loaded'),layer=node('rectangle',0,0,100,100);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const next=blank('Slow source'),other=node('rectangle',0,0,20,20);next.nodes[other.id]=other;next.pages[0].children=[other.id]
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:4294967296,indexedObjects:2,dirty:false,undoCount:0,redoCount:0}
 let release!:(value:unknown)=>void
 const scene=vi.fn(async({key}:{key:string})=>key==='1:1'?new Promise(resolve=>{release=resolve}):{status:'ok',json:JSON.stringify(doc),warnings:[],nodes:1,bytes:100})
 const row=(key:string,name:string)=>({key,id:key,name,kind:'page',bytes:100,part:'p',hasChildren:false})
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[row('1:0','Loaded'),row('1:1','Slow')],total:2,hasMore:false}),scene,cancel:async()=>({status:'ok'})}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 await act(async()=>button('页面 / 画板').click());await act(async()=>button('载入页面 Slow').click())
 expect(document.querySelector('.source-workspace-canvas')!.hasAttribute('inert')).toBe(false)
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=120}))
 await act(async()=>release({status:'ok',json:JSON.stringify(next),warnings:[],nodes:1,bytes:100}))
 expect(binding.editor!.authoredDocument.nodes[layer.id].width).toBe(120)
 expect(binding.editor!.authoredDocument.nodes[other.id]).toBeUndefined()
 expect(document.querySelector('.source-workspace-status')!.textContent).toContain('当前画布已保留')
 expect(scene.mock.calls.map(([r])=>r.key)).toEqual(['1:0','1:1','1:0'])
})

function sourceFixture(){
 const doc=blank('Page'),layer=node('rectangle',0,0,140,140);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 let live={owner:{documentId:'source',sessionEpoch:1},revision:1,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:4294967296,indexedObjects:4,dirty:true,undoCount:1,redoCount:0}
 const parentRow={key:'1:3',id:'parent',name:'Source parent',kind:'document',bytes:100,part:'page.json',hasChildren:true}
 const pageRow={...parentRow,key:'1:4',id:doc.pages[0].id,name:'Full page',kind:'page',hasChildren:false}
 const otherRow={...pageRow,key:'1:6',id:'other',name:'Other page'}
 const children=vi.fn(async({key}:{key?:string})=>({status:'ok',items:key?[pageRow,otherRow]:[parentRow],total:key?2:1,hasMore:false}))
 const scene=vi.fn(async(_value:{key:string;expectedRevision:number})=>({status:'ok',json:JSON.stringify(doc),warnings:[],nodes:1,bytes:2048}))
 const sceneCommit=vi.fn(async(_value:{key:string;expectedRevision:number;json:string})=>({status:'ok',...live,revision:++live.revision,key:'1:9'}))
 const close=vi.fn(async()=>({status:'ok'}))
 const bridge={open:async()=>({status:'ok',...live}),children,scene,sceneCommit,close,
  undo:async()=>({status:'ok',...live,revision:++live.revision,redoCount:++live.redoCount}),redo:async()=>({status:'ok',...live,revision:++live.revision,redoCount:--live.redoCount})} as unknown as LargeDocumentBridge
 return {bridge,children,scene,sceneCommit,close,doc,layer,get live(){return live}}
}
async function loadFixture(f:ReturnType<typeof sourceFixture>,onExit=()=>{}){
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={f.bridge} parentEditor={parent} onExit={onExit} onWindowClose={async()=>{}}/>))
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 Source parent"]')!.click())
 await act(async()=>button('载入页面 Full page').click())
 return binding.editor!
}

test('source edits and undo are saved automatically without a save button or export', async () => {
 const f=sourceFixture(), editor=await loadFixture(f)
 vi.useFakeTimers()
 try {
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=180}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.sceneCommit.mock.calls[0][0].json)[f.layer.id].patch.width).toBe(180)
  expect(binding.source!.dirty).toBe(false)
  await act(async()=>editor.undo())
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledTimes(2)
  expect(JSON.parse(f.sceneCommit.mock.calls[1][0].json)[f.layer.id].patch.width).toBe(f.layer.width)
  expect(binding.source!.dirty).toBe(false)
 } finally { vi.useRealTimers() }
})

test('a source edit arriving during autosave follows the acknowledged revision in a second automatic commit',async()=>{
 const f=sourceFixture(),editor=await loadFixture(f)
 let finish!:(value:any)=>void
 f.sceneCommit.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 vi.useFakeTimers()
 try {
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=180}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledOnce()
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=210}))
  await act(async()=>finish({status:'ok',...f.live,revision:++f.live.revision,key:'1:9'}))
  expect(binding.source!.dirty).toBe(true)
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledTimes(2)
  const next=f.sceneCommit.mock.calls[1][0]
  expect(next.expectedRevision).toBe(2)
  expect(next.key).toBe('1:9')
  expect(JSON.parse(next.json)[f.layer.id].patch.width).toBe(210)
  expect(binding.source!.dirty).toBe(false)
  expect(binding.source!.error).toBe('')
 } finally { vi.useRealTimers() }
})

test('source autosave waits for a draft to end without committing the input itself',async()=>{
 const f=sourceFixture(),editor=await loadFixture(f),commit=vi.fn(()=>false)
 let pending=true
 const off=registerPendingEdit(editor,{dirty:()=>pending,commit})
 vi.useFakeTimers()
 try {
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=180}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).not.toHaveBeenCalled();expect(commit).not.toHaveBeenCalled()
  await act(async()=>{pending=false;pendingEditsChanged(editor)})
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledOnce()
  expect(binding.source!.dirty).toBe(false)
 } finally { off();vi.useRealTimers() }
})

test('leaving while source autosave is writing waits for its receipt and preserves the newest edit',async()=>{
 const f=sourceFixture(),exit=vi.fn(),editor=await loadFixture(f,exit)
 let finish!:(value:any)=>void
 f.sceneCommit.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve}))
 vi.useFakeTimers()
 try {
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=180}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=210}))
  let leaving!:Promise<void>
  await act(async()=>{leaving=binding.source!.leave()})
  expect(exit).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled()
  await act(async()=>{finish({status:'ok',...f.live,revision:++f.live.revision,key:'1:9'});await leaving})
  expect(f.sceneCommit).toHaveBeenCalledTimes(2)
  expect(f.close).toHaveBeenCalledWith({owner:f.live.owner,expectedRevision:3})
  expect(exit).toHaveBeenCalledOnce()
 } finally { vi.useRealTimers() }
})

test('correcting a rejected source edit resumes autosave without a manual save or dismissal',async()=>{
 const f=sourceFixture(),editor=await loadFixture(f)
 f.sceneCommit.mockRejectedValueOnce(Error('Sketch cannot preserve this edited geometry'))
 vi.useFakeTimers()
 try {
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.width=180}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(binding.source!.dirty).toBe(true)
  expect(binding.source!.error).toContain('edited geometry')
  await act(async()=>vi.advanceTimersByTimeAsync(5000))
  expect(f.sceneCommit).toHaveBeenCalledOnce()
  await act(async()=>editor.undo())
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(binding.source!.error).toBe('')
  await act(async()=>editor.updateProperties([f.layer.id],n=>{n.transform[4]+=1}))
  await act(async()=>vi.advanceTimersByTimeAsync(650))
  expect(f.sceneCommit).toHaveBeenCalledTimes(2)
  expect(binding.source!.dirty).toBe(false)
 } finally {vi.useRealTimers()}
})

test('a late source-history reply cannot discard edits made after the clean snapshot',async()=>{
 const f=sourceFixture(),loaded=await loadFixture(f)
 let reply!:(value:any)=>void
 f.bridge.undo=()=>new Promise(resolve=>{reply=resolve})
 await act(async()=>button('页面 / 画板').click())
 await act(async()=>button('撤销已保存修改').click())
 await act(async()=>loaded.updateProperties([f.layer.id],node=>{node.width=190}))
 await act(async()=>reply({status:'ok',...f.live,revision:2}))
 expect(f.scene.mock.calls).toHaveLength(1)
 expect(loaded.authoredDocument.nodes[f.layer.id].width).toBe(190)
 expect(loaded.canUndo).toBe(true)
 expect(document.querySelector('[role=alert]')!.textContent).toContain('当前画布已保留')
})

test('source undo and redo invalidate active ordinals without reloading a different object',async()=>{
 const f=sourceFixture();await loadFixture(f)
 await act(async()=>button('页面 / 画板').click())
 await act(async()=>button('撤销已保存修改').click())
 expect(f.scene.mock.calls).toHaveLength(1)
 expect(f.children.mock.calls.at(-1)![0]).toMatchObject({key:undefined,expectedRevision:2})
 expect(document.querySelector('[aria-label="Shared canvas boundary"]')).toBeNull()
 await act(async()=>button('重做已保存修改').click())
 expect(f.scene.mock.calls).toHaveLength(1)
 expect(f.children.mock.calls.at(-1)![0]).toMatchObject({key:undefined,expectedRevision:3})
})

test('a save while navigating fences the clicked row and retains the remapped root receipt for the next save and close',async()=>{
 const f=sourceFixture(),onExit=vi.fn(),loaded=await loadFixture(f,onExit)
 await act(async()=>loaded.updateProperties([f.layer.id],node=>{node.width=180}))
 await act(async()=>button('页面 / 画板').click())
 await act(async()=>button('载入页面 Other page').click())
 expect(f.sceneCommit.mock.calls[0][0]).toMatchObject({key:'1:4',expectedRevision:1})
 expect(f.scene.mock.calls).toHaveLength(1)
 expect(document.querySelector('[role=alert]')!.textContent).toContain('从刷新后的列表重新选择')
 expect(loaded.authoredDocument.nodes[f.layer.id].width).toBe(180)
 await act(async()=>loaded.updateProperties([f.layer.id],node=>{node.width=190}))
 await act(async()=>button('返回设计').click())
 expect(f.sceneCommit.mock.calls[1][0]).toMatchObject({key:'1:9',expectedRevision:2})
 expect(f.close).toHaveBeenCalledWith({owner:f.live.owner,expectedRevision:3})
 expect(onExit).toHaveBeenCalledTimes(1)
})

test('failed save blocks navigation and close without dropping dirty Editor history',async()=>{
 const f=sourceFixture(),onExit=vi.fn(),loaded=await loadFixture(f,onExit)
 f.sceneCommit.mockRejectedValue(Error('Native source commit rejected'))
 await act(async()=>loaded.updateProperties([f.layer.id],node=>{node.width=180}))
 await act(async()=>button('返回设计').click())
 expect(f.close).not.toHaveBeenCalled();expect(onExit).not.toHaveBeenCalled()
 expect(loaded.authoredDocument.nodes[f.layer.id].width).toBe(180)
 expect(loaded.canUndo).toBe(true)
 expect(document.querySelector('[role=alert]')!.textContent).toContain('Native source commit rejected')
})

test('a commit receipt without a fresh root key cannot rebind or close the dirty canvas',async()=>{
 const f=sourceFixture(),onExit=vi.fn(),loaded=await loadFixture(f,onExit)
 f.sceneCommit.mockResolvedValue({status:'ok',...f.live,revision:2} as never)
 await act(async()=>loaded.updateProperties([f.layer.id],node=>{node.width=180}))
 await act(async()=>button('返回设计').click())
 expect(f.sceneCommit).toHaveBeenCalledTimes(1)
 expect(f.close).not.toHaveBeenCalled();expect(onExit).not.toHaveBeenCalled()
 expect(loaded.authoredDocument.nodes[f.layer.id].width).toBe(180)
 expect(document.querySelector('[role=alert]')!.textContent).toContain('保存回执缺少有效的源对象位置')
})

test('automatic board entry and sidebar refresh never overlap the source operation lane',async()=>{
 const doc=blank('Board'),layer=node('rectangle',0,0,20,20);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:1e12,indexedObjects:2,dirty:false,undoCount:0,redoCount:0}
 const page={key:'1:0',id:'page',name:'Page',kind:'page',bytes:100,part:'p',hasChildren:true},board={...page,key:'1:5',id:layer.id,name:'Board',kind:'artboard',hasChildren:false}
 let active=0,peak=0
 const lane=async<T,>(work:()=>T)=>{active++;peak=Math.max(active,peak);try{await new Promise(resolve=>setTimeout(resolve,2));return work()}finally{active--}}
 const children=vi.fn(async({key}:{key?:string})=>lane(()=>({status:'ok',items:[key?board:page],total:1,hasMore:false})))
 const bridge={open:async()=>({status:'ok',...status}),children,scene:async()=>lane(()=>({status:'ok',json:JSON.stringify(doc),warnings:[],nodes:1,bytes:100}))}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 for(let i=0;i<20&&!document.querySelector('[aria-label="Shared canvas boundary"]');i++)await act(async()=>new Promise(resolve=>setTimeout(resolve,5)))
 expect(document.querySelector('[aria-label="Shared canvas boundary"]')).not.toBeNull()
 await act(async()=>new Promise(resolve=>setTimeout(resolve,10)))
 expect(peak).toBe(1);expect(document.querySelector('[role=alert]')).toBeNull()
 expect(binding.editor!.authoredDocument.nodes[layer.id]).toBeDefined()
 expect(document.querySelector('[data-source-key="1:0"]')).not.toBeNull()
 expect(button('页面 / 画板').getAttribute('aria-pressed')).toBe('true')
})

test('page ranges navigate without dropping the current range on a failed load',async()=>{
 const doc=blank('Page'),layer=node('rectangle',0,0,20,20);doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:1e12,indexedObjects:3,dirty:false,undoCount:0,redoCount:0}
 const row={key:'1:0',id:'page',name:'Page',kind:'page',bytes:100,part:'p',hasChildren:false}
 let fail=false
 const scene=vi.fn(async({offset=0}:{offset?:number})=>({status:'ok',json:fail&&offset===0?'{}':JSON.stringify(doc),warnings:[],nodes:1,bytes:100,pageRange:{offset,end:offset+1,totalRoots:3,nextOffset:offset===2?null:offset+1}}))
 const sceneCommit=vi.fn(async()=>({status:'ok',...status,revision:1,key:row.key}))
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[row],total:1,hasMore:false}),scene,sceneCommit}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelector('.source-workspace-status')!.textContent).toContain('共 3 个')
 await act(async()=>button('下一部分').click())
 expect(scene.mock.calls.at(-1)![0].offset).toBe(1)
 expect(document.querySelector('[aria-label="页面分段"]')!.textContent).toContain('2–2 / 3')
 fail=true
 await act(async()=>button('上一部分').click())
 expect(scene.mock.calls.slice(-2).map(([r])=>r.offset??0)).toEqual([0,1])
 expect(document.querySelector('[aria-label="页面分段"]')!.textContent).toContain('2–2 / 3')
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=30}))
 await act(async()=>button('下一部分').click())
 expect(sceneCommit).toHaveBeenCalledTimes(1)
 expect(scene.mock.calls.at(-1)![0]).toMatchObject({offset:2,expectedRevision:1})
 expect(document.querySelector('[aria-label="页面分段"]')!.textContent).toContain('3–3 / 3')
})

test('derived capacity rejection narrows whole-root ranges and keeps complete forward/backward coverage',async()=>{
 const doc=blank('Derived page'),ids:string[]=[]
 for(let i=0;i<8;i++){const n=node('rectangle',i*20,0,10,10);doc.nodes[n.id]=n;ids.push(n.id)}
 doc.pages[0].children=ids
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:1e12,indexedObjects:8,dirty:false,undoCount:0,redoCount:0}
 const row={key:'1:0',id:'page',name:'Page',kind:'page',bytes:100,part:'p',hasChildren:false}
 const scene=vi.fn(async({offset=0,limit=8}:{offset?:number;limit?:number})=>{
  const end=Math.min(8,offset+limit),part=structuredClone(doc);part.pages[0].children=ids.slice(offset,end)
  part.nodes=Object.fromEntries(part.pages[0].children.map(id=>[id,part.nodes[id]]))
  return {status:'ok',json:JSON.stringify(part),warnings:[],nodes:end-offset,bytes:100,pageRange:{offset,end,totalRoots:8,nextOffset:end<8?end:null}}
 })
 const original=preparation.prepareDocumentJson
 vi.spyOn(preparation,'prepareDocumentJson').mockImplementation(source=>{
  if(JSON.parse(source).pages[0].children.length>2)throw Error('DOCUMENT_RESOURCE_LIMIT: derived instance bytes exceed allowance')
  return original(source)
 })
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[row],total:1,hasMore:false}),scene}as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={workbench} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(scene.mock.calls.map(([r])=>r.limit)).toEqual([undefined,4,2])
 expect(document.querySelector('[aria-label="页面分段"]')!.textContent).toContain('1–2 / 8')
 const visited=[...binding.editor!.authoredDocument.pages[0].children]
 for(let i=0;i<3;i++){
  await act(async()=>button('下一部分').click())
  visited.push(...binding.editor!.authoredDocument.pages[0].children)
 }
 expect(visited).toEqual(ids)
 await act(async()=>button('上一部分').click())
 expect(scene.mock.calls.at(-1)![0]).toMatchObject({offset:4,limit:2})
 expect(binding.editor!.authoredDocument.pages[0].children).toEqual(ids.slice(4,6))
 expect(document.querySelector('[role="alert"]')).toBeNull()
})

test('an admitted thumbnail catalogue avoids a full scene and only refines the requested material',async()=>{
 const owner={documentId:'source-a',sessionEpoch:1}
 const status={owner,revision:0,name:'sample.sketch',format:'sketch',dirty:false,undoCount:0,redoCount:0,indexedObjects:8,expandedBytes:100,maxExpandedBytes:100000}
 const bounds={x:0,y:0,width:500,height:200},rect={x:0,y:0,width:100,height:100}
 const items=['first','second','third'].map((name,i)=>({id:name,name,kind:'artboard',pageId:i<2?'first':'third',pageName:i<2?'first':'third',source:rect,placed:{...rect,x:i*250},key:'1:'+i,bytes:1024}))
 let finish!:(value:unknown)=>void
 const canvasSnapshot=vi.fn(async(request:{materialKeys?:string[]})=>({status:'ok',owner,revision:0,token:'detail',materialKeys:request.materialKeys,bytes:123,nodes:3,roots:request.materialKeys?.length||3,pageId:'p',stageId:'s',bounds,warnings:[],rasterProfile:'figma',colorManaged:true}))
 const bridge={cancel:vi.fn(async()=>({status:'ok'})),open:()=>new Promise(resolve=>{finish=resolve}),openingView:async()=>({status:'ok',phase:'available',owner,bounds,revision:0,total:3,
  items:items.map((item,i)=>({...item,key:'preview-'+i})),pages:[['first','first',2],['third','third',1]],offset:0,nextOffset:3,cursor:3,images:[{index:0,png:'a'},{index:1,png:'b'},{index:2,png:'c'}],moreImages:false,finished:true,rendered:0,cacheHit:true}),
  canvasLayout:async()=>({status:'ok',items,total:3,hasMore:false}),canvasSnapshot} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={s=><div ref={s.canvas}>{workbench(s)}</div>} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelectorAll('.source-page-entry')).toHaveLength(3)
 expect(document.querySelector('.source-row-copy .source-row-name')!.textContent).toBe('first')
 expect(document.querySelector('.source-row-copy .source-row-page')!.textContent).toBe('first')
 await act(async()=>finish({status:'ok',...status}))
 expect(canvasSnapshot).not.toHaveBeenCalled();expect(binding.source!.nativeCanvas).toBeUndefined()
 await act(async()=>binding.source!.onDetail!([1]))
 expect(canvasSnapshot).toHaveBeenCalledTimes(1);expect(canvasSnapshot.mock.calls[0][0].materialKeys).toEqual(['1:1'])
 expect(binding.source!.nativeCanvas!.snapshot.roots).toBe(1)
 await act(async()=>binding.source!.onDetail!([1]));expect(canvasSnapshot).toHaveBeenCalledTimes(1)
 const parked=binding.source!.nativeCanvas!.snapshot
 await act(async()=>binding.source!.onDetail!([]))
 expect(binding.source!.nativeCanvas!.snapshot).toBe(parked)
 expect(binding.source!.parkNative).toBe(true)
 expect(binding.source!.hideNative).toBe(true)
 await act(async()=>binding.source!.onDetail!([1]))
 expect(binding.source!.nativeCanvas!.snapshot).toBe(parked)
 expect(binding.source!.parkNative).toBe(false)
 expect(canvasSnapshot).toHaveBeenCalledTimes(1)
 expect(document.querySelectorAll('.source-page-entry')).toHaveLength(3)
 // The old [0] request was cancelled when [2] appeared. Its late rejection
 // must not blacklist a new [0] demand after the camera reverses.
 let rejectPending!:()=>void
 canvasSnapshot.mockImplementationOnce(()=>new Promise<never>((_,reject)=>{rejectPending=()=>reject(Error('Large document operation cancelled'))}))
 await act(async()=>binding.source!.onDetail!([0]))
 expect(binding.source!.parkNative).toBe(true)
 expect(binding.source!.hideNative).toBe(true)
 const beforeBlank=vi.mocked(bridge.cancel).mock.calls.length
 await act(async()=>binding.source!.onDetail!([]))
 expect(bridge.cancel).toHaveBeenCalledTimes(beforeBlank+1)
 expect(binding.source!.nativeCanvas!.snapshot).toBe(parked)
 await act(async()=>binding.source!.onDetail!([2]))
 await act(async()=>binding.source!.onDetail!([0]))
 await act(async()=>rejectPending())
 expect(binding.source!.nativeCanvas!.snapshot.materialKeys).toEqual(['1:0'])
 expect(canvasSnapshot.mock.calls.filter(([req])=>req.materialKeys?.join(',')==='1:0')).toHaveLength(2)
 const picker=document.querySelector('select[aria-label="素材页面"]') as HTMLSelectElement
 await act(async()=>{picker.value='first';picker.dispatchEvent(new Event('change',{bubbles:true}))})
 await act(async()=>button('精修当前页').click())
 expect(canvasSnapshot.mock.calls.at(-1)?.[0].materialKeys).toEqual(['1:0','1:1'])
 expect(binding.source!.nativeCanvas!.snapshot.roots).toBe(2)
 const afterPage=canvasSnapshot.mock.calls.length
 await act(async()=>binding.source!.onDetail!([2]))
 expect(canvasSnapshot).toHaveBeenCalledTimes(afterPage)
 expect(binding.source!.nativeCanvas!.snapshot.roots).toBe(2)

})

test('a failed open rebinds the host document so refine can show a native frame',async()=>{
 const owner={documentId:'3ab8effd-5db9-4ec9-80b9-ee76a9cb89d2',sessionEpoch:1}
 const status={owner,revision:0,name:'topology-verified-20261027.sketch',format:'sketch' as const,expandedBytes:100,maxExpandedBytes:1e12,indexedObjects:124000,dirty:false,undoCount:0,redoCount:0}
 const bounds={x:0,y:0,width:140,height:140}
 const item={id:'m',name:'140x140pt 30个（黑色）',kind:'artboard',pageId:'p',pageName:'浅色',source:bounds,placed:bounds,key:'1:1',bytes:100}
 const hostStatus=vi.fn(async()=>({status:'ok' as const,...status}))
 const canvasLayout=vi.fn(async()=>({status:'ok' as const,items:[item],total:1,hasMore:false,boundsAreLayoutHints:true as const,bounds}))
 const canvasSnapshot=vi.fn(async()=>({status:'ok' as const,owner,revision:0,token:'sharp',bytes:10,nodes:2,roots:1,pageId:'p',stageId:'s',bounds,warnings:[],rasterProfile:'figma' as const,colorManaged:true}))
 const bridge={open:vi.fn(async()=>{throw new Error('原生文件响应缺少设计内容')}),status:hostStatus,canvasLayout,canvasSnapshot,children:async()=>({status:'ok',items:[],total:0,hasMore:false}),openingView:async()=>({status:'ok',phase:'available',owner,revision:0,bounds,total:1,items:[{...item,key:'preview-0'}],pages:[['p','浅色',1]],offset:0,nextOffset:1,cursor:0,images:[],moreImages:false,finished:true,rendered:0,cacheHit:true})} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={s=><div ref={s.canvas}>{workbench(s)}</div>} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 await act(async()=>{await hostStatus.mock.results[0]?.value})
 expect(hostStatus).toHaveBeenCalled()
 expect(binding.source!.error).toContain('原生文件响应缺少设计内容')
 expect(binding.source!.notice).not.toContain('正在准备这个素材的原始图层')
 const refine=[...document.querySelectorAll('button')].find(button=>button.textContent==='精修完整画板')
 expect(refine).toBeTruthy()
 expect((refine as HTMLButtonElement).disabled).toBe(false)
 await act(async()=>binding.source!.dismissError?.())
 expect(binding.source!.error).toBe('')
 expect(binding.source!.notice).not.toContain('正在准备这个素材的原始图层')
 expect((refine as HTMLButtonElement).disabled).toBe(false)
 await act(async()=>{(refine as HTMLButtonElement).click()})
 expect(binding.source!.nativeCanvas?.snapshot.token).toBe('sharp')
 await act(async()=>binding.source!.nativeCanvas!.onStatus({phase:'ready',done:1,total:1}))
 expect(binding.source!.hideNative).toBe(false)
 expect(document.querySelector('.source-row-name')!.textContent).toBe('140x140pt 30个（黑色）')
})

test('a conversion-window reject stays distinct from directory, preview and a smaller editable subtree',async()=>{
 const owner={documentId:'source-window',sessionEpoch:1}
 const status={owner,revision:0,name:'synthetic-over-limit.sketch',format:'sketch' as const,expandedBytes:93412322,maxExpandedBytes:2**42,indexedObjects:3,dirty:false,undoCount:0,redoCount:0}
 const bounds={x:0,y:0,width:400,height:80}
 const rect={x:0,y:0,width:80,height:80}
 const catalogue=[
  {id:'wide',name:'整页图表',kind:'artboard',pageId:'p1',pageName:'数据',source:rect,placed:{...rect,x:0},key:'1:0',bytes:80_000_000},
  {id:'small',name:'图例',kind:'artboard',pageId:'p1',pageName:'数据',source:rect,placed:{...rect,x:160},key:'1:1',bytes:1024},
  {id:'swatch',name:'色板',kind:'artboard',pageId:'p2',pageName:'图表',source:rect,placed:{...rect,x:320},key:'1:2',bytes:1024},
 ]
 const windowError='大型文档：Source subtree exceeds the bounded conversion window; select a smaller subtree'
 const doc=blank('Material'),layer=node('rectangle',0,0,40,40)
 doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 let finish!:(value:unknown)=>void
 const canvasSnapshot=vi.fn(async(request:{materialKeys?:string[]})=>request.materialKeys
  ?{status:'ok' as const,owner,revision:0,token:`detail-${request.materialKeys.join(',')}`,materialKeys:request.materialKeys,bytes:10,nodes:1,roots:request.materialKeys.length,pageId:'p1',stageId:'s',bounds,warnings:[],rasterProfile:'figma' as const,colorManaged:true}
  :{status:'error' as const,message:windowError})
 const scene=vi.fn(async(request:{key:string})=>request.key==='1:0'
  ?{status:'error' as const,message:windowError}
  :{status:'ok' as const,json:JSON.stringify(doc),warnings:[],nodes:1,bytes:100})
 const bridge={cancel:async()=>({status:'ok' as const}),open:()=>new Promise(resolve=>{finish=resolve}),openingView:async()=>({status:'ok' as const,phase:'available' as const,owner,bounds,revision:0 as const,total:3,
  items:catalogue.map((item,i)=>({...item,key:`preview-${i}`})),pages:[['p1','数据',2],['p2','图表',1]] as [string,string,number][],offset:0,nextOffset:3,cursor:3,
  images:catalogue.map((_,index)=>({index,png:'a'})),moreImages:false,finished:true,rendered:0,cacheHit:true}),
  canvasLayout:async()=>({status:'ok' as const,items:catalogue,total:3,hasMore:false,boundsAreLayoutHints:true as const,bounds}),canvasSnapshot,scene,
  children:async()=>({status:'ok' as const,items:[],total:0,hasMore:false})} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace renderWorkbench={s=>{binding.source=s;return <div ref={s.canvas}>{s.navigation}<SourceDocumentStatus source={s}/></div>}} bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelectorAll('.source-page-entry')).toHaveLength(3)
 expect(binding.source!.stageReport).toMatchObject({
  directory:{status:'ready',detail:'目录：2 页 / 3 个素材'},
  preview:{status:'ready',detail:'预览：3/3 张缩略图'},
  refine:{status:'idle'},
  edit:{status:'idle'},
 })
 expect(canvasSnapshot).not.toHaveBeenCalled()
 await act(async()=>finish({status:'ok',...status}))
 expect(canvasSnapshot).not.toHaveBeenCalled()
 expect(binding.source!.stageReport!.refine.status).toBe('idle')
 const fullRefines=()=>canvasSnapshot.mock.calls.filter(([request])=>!request.materialKeys).length
 await act(async()=>button('精修完整画板').click())
 expect(fullRefines()).toBe(1)
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.error).toBe(windowError)
 expect(binding.source!.failureStage).toBe('refine')
 expect(binding.source!.stageReport).toMatchObject({
  directory:{status:'ready',detail:'目录：2 页 / 3 个素材'},
  preview:{status:'ready',detail:'预览：3/3 张缩略图'},
  refine:{status:'rejected',detail:'完整精修：超过固定转换窗口，尚未完成'},
  edit:{status:'idle',detail:'编辑尚未开始'},
 })
 const card=document.querySelector('[data-failure-stage="refine"]')!
 expect(card.querySelector('[role="alert"]')!.textContent).toContain('固定转换窗口')
 expect(card.querySelector('[role="alert"]')!.textContent).not.toContain('可释放其他应用的内存后重试')
 expect(card.querySelector('pre')!.textContent).toBe(windowError)
 expect(card.querySelector('[data-stage="directory"]')!.getAttribute('data-status')).toBe('ready')
 expect(card.querySelector('[data-stage="preview"]')!.getAttribute('data-status')).toBe('ready')
 expect(card.querySelector('[data-stage="refine"]')!.getAttribute('data-status')).toBe('rejected')
 expect(card.querySelector('[data-stage="edit"]')!.getAttribute('data-status')).toBe('idle')
 const refine=button('精修完整画板')
 expect(refine.disabled).toBe(false)
 await act(async()=>refine.click())
 expect(fullRefines()).toBe(2)
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.stageReport!.refine.status).toBe('rejected')
 const picker=document.querySelector('select[aria-label="素材页面"]') as HTMLSelectElement
 await act(async()=>(card.querySelector('.source-window-action') as HTMLButtonElement).click())
 expect(document.activeElement).toBe(picker)
 await act(async()=>document.querySelector<HTMLButtonElement>('[data-source-material-id="small"]')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})))
 expect(scene.mock.calls.map(([request])=>request.key)).toContain('1:1')
 expect(binding.source!.error).toBe('')
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.stageReport).toMatchObject({
  directory:{status:'ready'},
  preview:{status:'ready'},
  refine:{status:'rejected'},
  edit:{status:'ready',detail:'编辑：已载入 图例'},
 })
 await act(async()=>document.querySelector<HTMLButtonElement>('[data-source-material-id="wide"]')!.click())
 expect(scene.mock.calls.some(([request])=>request.key==='1:0')).toBe(true)
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.failureStage).toBe('edit')
 expect(binding.source!.error).toBe(windowError)
 expect(binding.source!.stageReport).toMatchObject({
  directory:{status:'ready',detail:'目录：2 页 / 3 个素材'},
  preview:{status:'ready',detail:'预览：3/3 张缩略图'},
  refine:{status:'rejected',detail:'完整精修：超过固定转换窗口，尚未完成'},
  edit:{status:'rejected',detail:'编辑：超过固定转换窗口，尚未完成'},
 })
 expect(document.querySelector('[data-failure-stage="edit"] [role="alert"]')!.textContent).not.toContain('可释放其他应用的内存后重试')
 expect((document.querySelector('[data-source-material-id="small"]') as HTMLButtonElement).disabled).toBe(false)
 expect(button('返回完整画板').disabled).toBe(false)
 const retried=fullRefines()
 await act(async()=>button('返回完整画板').click())
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.stageReport!.refine.status).toBe('rejected')
 await act(async()=>button('精修完整画板').click())
 expect(fullRefines()).toBe(retried+1)
 expect(binding.source!.busy).toBe(false)
 expect(binding.source!.failureStage).toBe('refine')
 expect(binding.source!.stageReport!.edit.status).not.toBe('ready')
})
