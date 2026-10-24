// Real Inspector + Editor/WASM. Graphics and native I/O remain explicit doubles.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LargeDocumentDialog } from './LargeDocumentDialog'
import { Editor } from './engine'
import { blank, node } from './model'
import { defaultColorSettings } from './color'
import { hasPendingEdits } from './pending-edits'
import type { LargeDocumentBridge } from './desktop'
const binding=vi.hoisted(()=>({editor:null as Editor|null}))
const bootstrap=await vi.hoisted(async()=>{
 // @ts-expect-error jsdom runtime dependency
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('<html><body></body></html>')
 for(const key of ['window','document','navigator'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
 return dom
})
bootstrap.window.close()
vi.mock('./Canvas',()=>({Canvas:({editor}:{editor:Editor})=>{binding.editor=editor;return <div aria-label="Graphics boundary"/>}}))
let dom:any,root:Root,parent:Editor
beforeEach(()=>{
 dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://design.invalid'})
 for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','Element','Node','Event','MouseEvent','KeyboardEvent','localStorage'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 vi.stubGlobal('requestAnimationFrame',()=>1);vi.stubGlobal('cancelAnimationFrame',()=>{})
 parent=new Editor(blank('Unchanged parent'));root=createRoot(document.getElementById('root')!)
})
afterEach(async()=>{await act(async()=>root.unmount());parent.dispose();dom.window.close();vi.unstubAllGlobals();binding.editor=null})
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label&&!b.disabled)!
const width=()=>document.querySelector<HTMLInputElement>('input[aria-label="W"]')!
test('managed adoption supports property edits, owns drafts/history, and preserves the parent',async()=>{
 const doc=blank('Working source'),layer=node('rectangle',0,0,140,140);layer.name='Working layer';doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 doc.schemaVersion=4;doc.colorManagement=defaultColorSettings();delete doc.rasterProfile
 const originalParent=JSON.stringify(parent.authoredDocument)
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:831806447,maxExpandedBytes:4294967296,indexedObjects:124399,dirty:false,undoCount:0,redoCount:0}
 const committed=vi.fn(async(_value:{json:string})=>({status:'ok',...status,revision:1,dirty:true,undoCount:1,key:'0:1'}))
 const bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[{key:'0:1',id:layer.id,name:layer.name,kind:'rectangle',bytes:4096,part:'page.json',hasChildren:false}],total:1,hasMore:false}),read:async()=>({status:'ok',json:'{"name":"Working layer"}',hash:'a'.repeat(64),omittedFields:[]}),project:async()=>({status:'ok',json:JSON.stringify(doc),warnings:[]}),commitCanvas:committed} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={()=>{}}/>))
 await act(async()=>button('Working layerrectangle').click())
 await act(async()=>button('在画布中编辑此对象').click())
 expect(width().getAttribute('aria-valuenow')).toBe('140')
 await act(async()=>{width().focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(width(),'180');width().dispatchEvent(new Event('input',{bubbles:true}))})
 expect(hasPendingEdits(parent)).toBe(true)
 await act(async()=>width().dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})))
 expect(width().getAttribute('aria-valuenow')).toBe('180')
 await act(async()=>button('撤销画布修改').click())
 expect(width().getAttribute('aria-valuenow')).toBe('140')
 await act(async()=>button('重做').click())
 expect(width().getAttribute('aria-valuenow')).toBe('180')
 await act(async()=>button('应用画布修改').click())
 expect(committed).toHaveBeenCalledTimes(1)
 const sent=JSON.parse(committed.mock.calls[0][0].json)
 expect(sent.nodes[layer.id].width).toBe(180)
 expect(sent.rasterProfile).toBe('figma')
 expect(JSON.stringify(parent.authoredDocument)).toBe(originalParent)
 expect(hasPendingEdits(parent)).toBe(false)
})

test.each(['newer edit','undo to initial'] as const)('edits during a subtree save survive and cannot be discarded by source refresh: %s',async(mode)=>{
 const doc=blank('Working source'),layer=node('rectangle',0,0,140,140);layer.name='Working layer';doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:100,maxExpandedBytes:4294967296,indexedObjects:5,dirty:false,undoCount:0,redoCount:0}
 const group={key:'0:1',id:'group',name:'Group',kind:'group',bytes:100,part:'page.json',hasChildren:true}
 let complete!:(value:unknown)=>void
 const open=vi.fn(async()=>({status:'ok',...status}))
 const children=vi.fn(async({key}:{key?:string})=>({status:'ok',items:key?[{...group,key:'0:2',id:layer.id,name:layer.name,kind:'rectangle',hasChildren:false}]:[group],total:1,hasMore:false}))
 const committed=vi.fn((_value:unknown)=>new Promise(resolve=>{complete=resolve})),closed=vi.fn()
 const bridge={open,children,read:async()=>({status:'ok',json:'{"name":"Working layer"}',hash:'a'.repeat(64),omittedFields:[]}),project:async()=>({status:'ok',json:JSON.stringify(doc),warnings:[]}),commitCanvas:committed} as unknown as LargeDocumentBridge
 await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={closed} keepSession/>))
 await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 Group"]')!.click())
 await act(async()=>button('Working layerrectangle').click())
 await act(async()=>button('在画布中编辑此对象').click())
 const loaded=binding.editor!,initial=JSON.stringify(loaded.authoredDocument),expectedWidth=mode==='undo to initial'?140:190
 await act(async()=>loaded.updateProperties([layer.id],node=>{node.width=180}))
 await act(async()=>button('应用画布修改').click())
 expect(JSON.parse((committed.mock.calls[0][0] as {json:string}).json).nodes[layer.id].width).toBe(180)
 if(mode==='undo to initial'){
  await act(async()=>button('撤销画布修改').click())
  expect(JSON.stringify(loaded.authoredDocument)).toBe(initial)
 }else await act(async()=>loaded.updateProperties([layer.id],node=>{node.width=190}))
 await act(async()=>complete({status:'ok',...status,revision:1,dirty:true,undoCount:1,key:'0:7'}))
 expect(loaded.authoredDocument.nodes[layer.id].width).toBe(expectedWidth)
 expect(loaded.canUndo||loaded.canRedo).toBe(true)
 expect(document.querySelector('[aria-label="Graphics boundary"]')).not.toBeNull()
 expect(document.querySelector('[role=alert]')!.textContent).toContain('当前画布草稿已保留')
 expect(children.mock.calls.at(-1)![0]).toMatchObject({expectedRevision:1,key:undefined})
 expect(hasPendingEdits(parent)).toBe(true)
 await act(async()=>button('关闭').click())
 expect(closed).not.toHaveBeenCalled()
 await act(async()=>button('刷新会话状态').click())
 expect(open).toHaveBeenCalledTimes(1)
 expect(loaded.authoredDocument.nodes[layer.id].width).toBe(expectedWidth)
 expect(hasPendingEdits(parent)).toBe(true)
 await act(async()=>button('应用画布修改').click())
 expect(committed.mock.calls[1][0]).toMatchObject({key:'0:7',expectedRevision:1})
 expect(JSON.parse((committed.mock.calls[1][0] as {json:string}).json).nodes[layer.id].width).toBe(expectedWidth)
 await act(async()=>complete({status:'ok',...status,revision:2,dirty:true,undoCount:2,key:'0:7'}))
 expect(document.querySelector('[aria-label="Graphics boundary"]')).toBeNull()
 expect(hasPendingEdits(parent)).toBe(false)
})
