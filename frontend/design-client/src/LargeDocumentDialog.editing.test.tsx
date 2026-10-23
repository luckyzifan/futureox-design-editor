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
const bootstrap=await vi.hoisted(async()=>{
 // @ts-expect-error jsdom runtime dependency
 const {JSDOM}=await import('jsdom');const dom=new JSDOM('<html><body></body></html>')
 for(const key of ['window','document','navigator'])vi.stubGlobal(key,key==='window'?dom.window:dom.window[key])
 return dom
})
bootstrap.window.close()
vi.mock('./Canvas',()=>({Canvas:()=> <div aria-label="Graphics boundary"/>}))
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
afterEach(async()=>{await act(async()=>root.unmount());parent.dispose();dom.window.close();vi.unstubAllGlobals()})
const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label&&!b.disabled)!
const width=()=>document.querySelector<HTMLInputElement>('input[aria-label="W"]')!
test('managed adoption supports property edits, owns drafts/history, and preserves the parent',async()=>{
 const doc=blank('Working source'),layer=node('rectangle',0,0,140,140);layer.name='Working layer';doc.nodes[layer.id]=layer;doc.pages[0].children=[layer.id]
 doc.schemaVersion=4;doc.colorManagement=defaultColorSettings();delete doc.rasterProfile
 const originalParent=JSON.stringify(parent.authoredDocument)
 const status={owner:{documentId:'source',sessionEpoch:1},revision:0,name:'source.sketch',format:'sketch',expandedBytes:831806447,maxExpandedBytes:4294967296,indexedObjects:124399,dirty:false,undoCount:0,redoCount:0}
 const committed=vi.fn(async(_value:{json:string})=>({status:'ok',...status,revision:1,dirty:true,undoCount:1}))
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
