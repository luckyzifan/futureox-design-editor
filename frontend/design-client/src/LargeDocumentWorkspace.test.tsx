// Shared Editor/WASM and storage routing; native I/O and GPU are test doubles.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LargeDocumentWorkspace } from './LargeDocumentWorkspace'
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
vi.mock('./Canvas',()=>({Canvas:({editor}:{editor:Editor})=>{binding.editor=editor;return <div aria-label="Shared canvas boundary"/>}}))
vi.mock('./Layers',()=>({Layers:()=>null}))
vi.mock('./Inspector',()=>({Inspector:()=>null}))
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
 const sceneCommit=vi.fn(async(_request:{json:string;key:string})=>({status:'ok',...status,revision:1,dirty:true,undoCount:1})),exported=vi.fn(async()=>({status:'ok',...status,revision:1,exported:true,displayName:'complete.sketch'}))
 const scene=vi.fn(async({key}:{key:string})=>({status:'ok',json:key==='2:0'?'{}':JSON.stringify(doc),warnings:[],nodes:1,bytes:2048}))
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[{key:'1:0',id:doc.pages[0].id,name:'Full page',kind:'page',bytes:699402701,part:'page.json',hasChildren:true},{key:'2:0',id:'unadmitted',name:'Unadmitted page',kind:'page',bytes:100,part:'other.json',hasChildren:false}],total:2,hasMore:false}),scene,sceneCommit,export:exported} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentWorkspace bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 await act(async()=>button('Full page完整页面').click())
 expect(document.querySelector('[role=dialog]')).toBeNull()
 expect(document.querySelector('[aria-label="Shared canvas boundary"]')).not.toBeNull()
 await act(async()=>binding.editor!.updateProperties([layer.id],n=>{n.width=180}))
 await act(async()=>button('保存修改').click())
 expect(sceneCommit).toHaveBeenCalledTimes(1)
 const payload=sceneCommit.mock.calls[0][0]
 expect(Object.keys(JSON.parse(payload.json))).toEqual([layer.id]);expect(JSON.parse(payload.json)[layer.id].patch).toEqual({width:180});expect(payload.key).toBe('1:0')
 await act(async()=>button('导出完整文件…').click())
 expect(exported).toHaveBeenCalledWith({owner:status.owner,expectedRevision:1})
 await act(async()=>button('源文件 / 页面').click())
 await act(async()=>button('Unadmitted page完整页面').click())
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
 await act(async()=>root.render(<LargeDocumentWorkspace bridge={bridge} parentEditor={parent} onExit={()=>{}} onWindowClose={async()=>{}}/>))
 expect(document.querySelector('[data-source-key="1:0"]')).not.toBeNull()
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 First"]')!.click())
 expect(document.querySelector('[data-source-key="1:0"]')).toBeNull()
 await act(async()=>reply({status:'ok',items:[{...first,key:'1:1',id:'second',name:'Second',hasChildren:false}],total:1,hasMore:false}))
 expect(document.querySelector('[data-source-key="1:1"]')).not.toBeNull()
 expect(document.querySelector('[data-source-key="1:0"]')).toBeNull()
})
