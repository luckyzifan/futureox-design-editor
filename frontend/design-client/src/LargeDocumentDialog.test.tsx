// Mounted UI/host-boundary checks; native storage and GPU are tested separately.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LargeDocumentDialog } from './LargeDocumentDialog'
import type { LargeDocumentBridge, LargeDocumentStatus } from './desktop'
import type { Editor } from './engine'
vi.mock('./Canvas',()=>({Canvas:()=>null}))
vi.mock('./Inspector',()=>({Inspector:()=>null}))
vi.mock('./engine',()=>({Editor:class {}}))
vi.mock('./model',()=>({validateDocument:(value:unknown)=>value}))
let dom:any,root:Root
const parent={} as Editor
const status:LargeDocumentStatus={owner:{documentId:'test-document',sessionEpoch:1},revision:0,name:'large.json',format:'json',expandedBytes:4294967296,maxExpandedBytes:4294967296,indexedObjects:625000,dirty:false,undoCount:0,redoCount:0}
beforeEach(()=>{
  dom=new JSDOM('<html><body><div id="root"></div></body></html>',{url:'https://design.invalid'})
  for(const name of ['window','document','HTMLElement','Element','Node','Event','MouseEvent'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  root=createRoot(document.getElementById('root')!)
})
afterEach(async()=>{await act(async()=>root.unmount());dom.window.close();vi.unstubAllGlobals()})
function button(text:string){return [...document.querySelectorAll('button')].find(b=>b.textContent===text)!}
test('StrictMode starts one import, keeps cancellation available, then displays the admitted source',async()=>{
  let complete!:(value:unknown)=>void
  const open=vi.fn(()=>new Promise(resolve=>{complete=resolve})),cancel=vi.fn(async()=>({status:'ok',requested:1,running:true,cancelled:false}))
  const bridge={open,cancel,children:vi.fn(async()=>({status:'ok',items:[],total:0,hasMore:false}))} as unknown as LargeDocumentBridge
  await act(async()=>root.render(<StrictMode><LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={()=>{}}/></StrictMode>))
  expect(open).toHaveBeenCalledTimes(1)
  await act(async()=>button('停止当前操作').click())
  expect(cancel).toHaveBeenCalledTimes(1)
  await act(async()=>complete({status:'ok',...status}))
  expect(document.body.textContent).toContain('4096.0 MiB')
  expect(document.body.textContent).toContain('625,000')
})
test('native error details remain visible and a failed File grant can fall back to native selection',async()=>{
  const openFile=vi.fn(async()=>{throw Error('File grant unavailable')}),open=vi.fn(async()=>({status:'error',code:'FAILED',message:'Source failed CRC validation'}))
  const bridge={openFile,open} as unknown as LargeDocumentBridge
  await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} initialFile={new dom.window.File(['{}'],'source.json')} parentEditor={parent} onClose={()=>{}}/>))
  expect(document.body.textContent).toContain('File grant unavailable')
  await act(async()=>button('刷新会话状态').click())
  expect(openFile).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).toContain('Source failed CRC validation')
})
test('a failed native close keeps the source panel available',async()=>{
  const onClose=vi.fn(),bridge={open:async()=>({status:'ok',...status}),children:async()=>({status:'ok',items:[],total:0,hasMore:false}),close:async()=>({status:'error',code:'STALE',message:'Refresh the source revision'})} as unknown as LargeDocumentBridge
  await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={onClose}/>))
  await act(async()=>button('关闭').click())
  expect(onClose).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Refresh the source revision')
})

test('source history invalidates ordinal breadcrumbs and stale selection before fetching the new revision',async()=>{
  const old={key:'0:10',id:'parent',name:'Old parent',kind:'group',bytes:100,part:'page.json',hasChildren:true}
  const child={...old,key:'0:11',id:'child',name:'Old child',hasChildren:false}
  const children=vi.fn(async({key}:{key?:string})=>({status:'ok',items:key?[child]:[old],total:1,hasMore:false}))
  const undo=vi.fn(async()=>({status:'ok',...status,revision:2,undoCount:0,redoCount:1}))
  const bridge={open:async()=>({status:'ok',...status,revision:1,undoCount:1}),children,undo,read:async()=>({status:'ok',json:'{"name":"Old child"}',hash:'a'.repeat(64),omittedFields:[]})} as unknown as LargeDocumentBridge
  await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={()=>{}}/>))
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 Old parent"]')!.click())
  await act(async()=>button('Old childgroup').click())
  await act(async()=>button('撤销已应用修改').click())
  expect(children.mock.calls.at(-1)![0]).toMatchObject({expectedRevision:2,key:undefined,offset:0})
  expect(document.querySelector('textarea')).toBeNull()
  expect([...document.querySelectorAll('nav button')].map(b=>b.textContent)).toEqual(['全部文件'])
})

test('pending source navigation clears old clickable rows and ignores the superseded reply',async()=>{
  const old={key:'0:10',id:'parent',name:'Old parent',kind:'group',bytes:100,part:'page.json',hasChildren:true}
  let finish!:(value:unknown)=>void
  const children=vi.fn(async({key}:{key?:string})=>key?new Promise(resolve=>{finish=resolve}):{status:'ok',items:[old],total:1,hasMore:false})
  const bridge={open:async()=>({status:'ok',...status}),children} as unknown as LargeDocumentBridge
  await act(async()=>root.render(<LargeDocumentDialog bridge={bridge} parentEditor={parent} onClose={()=>{}}/>))
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="展开 Old parent"]')!.click())
  expect([...document.querySelectorAll('.large-document-rows button')]).toHaveLength(0)
  await act(async()=>button('全部文件').click())
  await act(async()=>finish({status:'ok',items:[{...old,name:'Stale child',key:'0:11'}],total:1,hasMore:false}))
  expect(document.querySelector('.large-document-rows')!.textContent).not.toContain('Stale child')
})
