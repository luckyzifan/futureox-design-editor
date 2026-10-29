// Shared Editor/WASM and storage routing; native I/O and GPU are test doubles.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LargeDocumentWorkspace, type SourceWorkspace } from './LargeDocumentWorkspace'
import { Editor } from './engine'
import { blank, node } from './model'
import type { LargeDocumentBridge } from './desktop'
const binding=vi.hoisted(()=>({editor:null as Editor|null}))
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
afterEach(async()=>{await act(async()=>root.unmount());parent.dispose();dom.window.close();vi.unstubAllGlobals();binding.editor=null})
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label&&!b.disabled)!
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
 await act(async()=>button('Unadmitted page载入页面').click())
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
 await act(async()=>button('页面 / 画板').click());await act(async()=>button('Slow载入页面').click())
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
 await act(async()=>button('Full page载入页面').click())
 return binding.editor!
}

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
 await act(async()=>button('Other page载入页面').click())
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
