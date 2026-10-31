// DRAFT NOT RUN E01-E06. Mounted App export menus and real Editor ownership.
// Image production is a deferred marker-Blob boundary, NOT pixel/render proof.
// Original mounted App file harness retained for actual New/leave transitions.
// Mounted production App file menu -> DesktopSession -> actual
// pending-input/leave dialog/admission/Editor/WASM. Native dialog/file transport,
// async codec scheduling and Surface are controlled boundaries, not OS GUI proof.
// Real FD codec supplies valid/truncated bytes at native transport seam. No large
// FIG/Sketch fixture copy or claim that a codec test substitutes for menu routing.
// Mounted production App + Canvas + Inspector and real Editor/WASM. Only the
// graphics-device and persistence/host boundaries are replaced. Platform names
// exercise policy branches, not real macOS/Windows/Linux acceptance.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import App from './App'
import { Editor } from './engine'
import { blank, node, paint, type DesignDocument } from './model'
import { nudgePreference } from './nudge-preference'
import { shortcutPreference } from './shortcut-preference'
import * as localStore from './local-store'
import * as startupPreview from './startup-preview'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { interfacePreference } from './interface-preference'
import type { DesktopBridge, DesktopCommand, DesktopFile, DesktopResult } from './desktop'

const bootstrap = await vi.hoisted(async()=>{
  // @ts-expect-error jsdom is a test-only runtime dependency.
  const {JSDOM}=await import('jsdom');const initial=new JSDOM('<html><body></body></html>')
  for(const key of ['window','document','navigator'])vi.stubGlobal(key,key==='window'?initial.window:initial.window[key]);return initial
});bootstrap.window.close()

vi.mock('./kernel/Surface', async () => {
  const { useLayoutEffect } = await import('react')
  return { KernelSurface(props: import('./kernel/Surface').SurfaceProps) {
    useLayoutEffect(() => { props.onPresentation?.({ ...props, epoch: props.presentationEpoch!, pixelRatio: 1, managed: false }) }, [props.document, props.pageId, props.view, props.width, props.height, props.presentationEpoch, props.onPresentation])
    return <div data-testid="surface-boundary" />
  } }
})
let dom: any, root: Root, mount: HTMLElement, editor: Editor | undefined, errors: unknown[][]
beforeEach(async () => {
  exportsHarness.jobs.length=0;created=[];revoked=[];
  vi.spyOn(URL,'createObjectURL').mockImplementation(blob=>{const url=`blob:export-${created.length}`;created.push({url,blob});return url});
  vi.spyOn(URL,'revokeObjectURL').mockImplementation(url=>{revoked.push(url)});
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {})
  Object.defineProperties(dom.window.HTMLElement.prototype, { clientWidth: { configurable: true, get: () => 1000 }, clientHeight: { configurable: true, get: () => 800 } })
  vi.spyOn(dom.window.HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0, toJSON() {} })
  vi.spyOn(dom.window.HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(localStore, 'localOpen').mockResolvedValue(null)
  vi.spyOn(localStore, 'localList').mockResolvedValue([])
  vi.spyOn(localStore.SaveCoordinator.prototype, 'save').mockResolvedValue()
  vi.spyOn(localStore, 'localSelect').mockResolvedValue()
  vi.spyOn(startupPreview, 'readStartupPreview').mockResolvedValue(undefined)
  const set = Editor.prototype.set; editor = undefined
  vi.spyOn(Editor.prototype, 'set').mockImplementation(function (this: Editor, patch) { editor ??= this; return set.call(this, patch) })
  errors = []; const error=console.error.bind(console);vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args);error(...args) })
  interfacePreference.reset();nudgePreference.reset(); shortcutPreference.set('sketch-like')
  Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'})
  mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount()); expect(new Set(revoked).size).toBe(revoked.length);expect([...revoked].sort()).toEqual(created.map(x=>x.url).sort()); editor?.dispose(); nudgePreference.reset(); shortcutPreference.set('figma-like')
  dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); expect(errors).toEqual([])
})
async function render() {
  await act(async () => { root.render(<App />); for (let i = 0; i < 30; i++) await Promise.resolve() })
  // App intentionally starts on Home. These are editor operation tests, so
  // enter through the real ready-gated route instead of clicking inert chrome.
  expect(document.querySelector('[aria-label="本机设计首页"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="canvas"]')).toBeNull()
  const resume = button('继续编辑')
  expect(resume.disabled).toBe(false)
  await act(async () => resume.click())
  expect(document.querySelector('[aria-label="本机设计首页"]')).toBeNull()
  expect(canvas()).not.toBeNull()
}
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.includes(text))!
const canvas = () => document.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function key(value: string, options: KeyboardEventInit = {}, type = 'keydown') { await act(async () => canvas().dispatchEvent(new KeyboardEvent(type, { key: value, code: value, bubbles: true, cancelable: true, ...options }))) }


function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(done=>resolve=done),resolve:(value:T)=>resolve(value)}}
async function settle(check:()=>boolean){for(let i=0;i<100&&!check();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))});expect(check()).toBe(true)}
function nativeHost(){
  const listeners=new Set<(command:DesktopCommand)=>void>(),saved:Uint8Array[]=[]
  const bridge={
    version:1,renderPolicy:Object.freeze({cpuOnly:true}),
    listCatalog:vi.fn<DesktopBridge['listCatalog']>().mockResolvedValue({status:'ok',projects:[],directories:[],files:[]}),
    selectCatalogDirectory:vi.fn<DesktopBridge['selectCatalogDirectory']>().mockResolvedValue({status:'cancelled'}),
    scanCatalogDirectory:vi.fn<DesktopBridge['scanCatalogDirectory']>().mockResolvedValue({status:'ok',directoryId:'directory',files:[],truncated:false}),
    openCatalogFile:vi.fn<DesktopBridge['openCatalogFile']>().mockResolvedValue({status:'cancelled'}),
    openDocument:vi.fn<DesktopBridge['openDocument']>().mockResolvedValue({status:'cancelled'}),
    acceptDocument:vi.fn<DesktopBridge['acceptDocument']>().mockResolvedValue({status:'ok'}),
    saveDocument:vi.fn<DesktopBridge['saveDocument']>().mockImplementation(async request=>{saved.push(encodeDocumentBinary(JSON.parse(request.documentJson) as DesignDocument));return {status:'ok',handle:'opaque:saved',displayName:'saved.fd'}}),
    readRecovery:vi.fn<DesktopBridge['readRecovery']>().mockResolvedValue({status:'cancelled'}),
    acceptRecovery:vi.fn<DesktopBridge['acceptRecovery']>().mockResolvedValue({status:'ok'}),
    writeRecovery:vi.fn<DesktopBridge['writeRecovery']>().mockResolvedValue({status:'ok'}),
    clearRecovery:vi.fn<DesktopBridge['clearRecovery']>().mockResolvedValue({status:'ok'}),
    setDirty:vi.fn<DesktopBridge['setDirty']>().mockResolvedValue(undefined),
    onCommand:vi.fn<DesktopBridge['onCommand']>().mockImplementation(listener=>{listeners.add(listener);return()=>{expect(listeners.delete(listener)).toBe(true)}}),
    onCloseRequested:vi.fn<DesktopBridge['onCloseRequested']>().mockReturnValue(()=>{}),
    respondToClose:vi.fn<DesktopBridge['respondToClose']>().mockResolvedValue({accepted:true}),
  } satisfies DesktopBridge
  Object.defineProperty(window,'coreDesktop',{configurable:true,value:bridge})
  return {bridge,saved,listeners}
}
async function start(){const h=nativeHost();await render();expect(editor).toBeDefined()
  const doc=blank('Original file'),shape=node('rectangle',20,30,80,50),other=node('rectangle',200,30,40,50)
  doc.nodes={[shape.id]:shape,[other.id]:other};doc.pages[0].children=[shape.id,other.id]
  await act(async()=>{expect(editor!.load(doc)).toBe(true);editor!.select([shape.id])})
  expect(document.querySelector<HTMLInputElement>('input[aria-label="W"]')).not.toBeNull()
  return {...h,id:shape.id,other:other.id,before:editor!.state.doc}
}
function width(){return document.querySelector<HTMLInputElement>('input[aria-label="W"]')!}
async function inputWidth(value:string){await act(async()=>{width().focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(width(),value);width().dispatchEvent(new Event('input',{bubbles:true}))})}
async function fieldKey(value:string){await act(async()=>width().dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true})))}
async function menu(action:string){
  if(!document.querySelector('.file-menu'))await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  const target=[...document.querySelectorAll<HTMLButtonElement>('.file-menu button')].find(b=>b.textContent?.includes(action))!
  expect(target).toBeTruthy();expect(target.disabled).toBe(false);await act(async()=>target.click())
}
function dialog(){return document.querySelector<HTMLElement>('[role="alertdialog"]')}
async function decide(text:'取消'|'不保存'|'保存'){expect(dialog()).not.toBeNull();const target=[...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;await act(async()=>target.click())}
function nativeFile(doc:DesignDocument):DesktopResult<DesktopFile>{const bytes=encodeDocumentBinary(doc);return {status:'ok',handle:'opaque:opened',displayName:'opened.fd',documentJson:JSON.stringify(decodeDocumentBinary(bytes))}}
async function unchangedHistory(before:DesignDocument){await act(async()=>editor!.undo());expect(editor!.state.doc).toEqual(before);expect(editor!.canUndo).toBe(false);await act(async()=>editor!.redo())}


const exportsHarness=vi.hoisted(()=>({jobs:[] as {kind:string;args:any[];resolve:(value:any)=>void;reject:(reason:unknown)=>void}[]}))
vi.mock('./export',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('./export')>()
 const pending=(kind:string,args:any[])=>new Promise((resolve,reject)=>exportsHarness.jobs.push({kind,args,resolve,reject}))
 return {...actual,exportImage:(...args:any[])=>pending('image',args),exportVisualSvg:(...args:any[])=>pending('visual-svg',args),exportRasterBatch:(...args:any[])=>pending('batch',args)}
})
let created:{url:string;blob:Blob|MediaSource}[]=[],revoked:string[]=[]
async function tick(){await act(async()=>{for(let i=0;i<30;i++)await Promise.resolve()})}
async function complete(index:number,name:string){const job=exportsHarness.jobs[index],asset={name,blob:new Blob([JSON.stringify({name,document:job.args[0],page:job.args[1]})],{type:'image/png'}),width:80,height:50,scale:1};await act(async()=>{job.resolve(job.kind==='batch'?[asset]:asset);for(let i=0;i<30;i++)await Promise.resolve()});return asset}
function job(index:number){expect(exportsHarness.jobs.length).toBeGreaterThan(index);return exportsHarness.jobs[index]}
function signal(index:number):AbortSignal{return job(index).args[5]}
function preview(){return document.querySelector<HTMLImageElement>('img[alt="设计导出预览"]')}
function link(name:string){return [...document.querySelectorAll<HTMLAnchorElement>('a[download]')].find(a=>a.download===name)}
async function closePreview(){const b=document.querySelector<HTMLButtonElement>('.remote-modal h2 button');expect(b).not.toBeNull();await act(async()=>b!.click())}
async function command(k:string,options:KeyboardEventInit={}){canvas().focus();await key(k,options)}
async function undo(){await command('z',{metaKey:true})}
async function redo(){await command('z',{metaKey:true,shiftKey:true})}
async function openPanel(){await menu('导出图像 · 1x / 2x / 3x');expect(document.querySelector('[role="dialog"][aria-label="导出图像"]')).not.toBeNull()}
async function generatePanel(){const b=button('生成 PNG');expect(b).toBeDefined();expect(b.disabled).toBe(false);await act(async()=>b.click())}
async function escapePanel(){const panel=document.querySelector<HTMLElement>('[role="dialog"][aria-label="导出图像"]');expect(panel).not.toBeNull();await act(async()=>panel!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(document.querySelector('[role="dialog"][aria-label="导出图像"]')).toBeNull()}

import { PassThrough } from 'node:stream'
import { createEditorDesignAutomation } from './automation/index'
import { OperationBackend } from '../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../design-mcp/src/server.mjs'
async function connectRpc(){
 const api=createEditorDesignAutomation(editor!),backend=new OperationBackend({capabilities:api.capabilities(),execute:request=>api.execute(request),scope:'write'}),input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();diagnostics.resume()
 let id=0,buffer='';const pending=new Map<number,(v:any)=>void>();output.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))!==-1){const v=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);const done=pending.get(v.id);pending.delete(v.id);done?.(v)}})
 const server=new DesignMcpServer({backend,input,output,diagnostics}).start()
 const rpc=(method:string,params?:any):Promise<any>=>new Promise((resolve,reject)=>{const requestId=++id,timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('NDJSON timeout'))},20000);pending.set(requestId,v=>{clearTimeout(timer);resolve(v)});input.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,...(params?{params}:{})})+'\n')})
 const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'export-chain',version:'1'}});expect(init.result.protocolVersion).toBe('2025-11-25');input.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n')
 const call=async(method:string,params:any={},fences:any={})=>{const v=await rpc('tools/call',{name:`design_${method.replaceAll('.','_')}`,arguments:{params,...fences}});expect(v.error).toBeUndefined();return v.result}
 return {async paint(id:string,paintId:string){const state=await call('document.get');expect(state.isError).toBe(false);const s=state.structuredContent;return call('paint.patch',{ids:[id],target:'fill',paintId,patch:{color:'#abcdef'}},{documentId:s.documentId,session:s.session,expectedRevision:s.revision})},async close(){await server.close();input.destroy();output.destroy();diagnostics.destroy();api.dispose()}}
}

test('E01 actual quick export commits valid draft into detached snapshot and releases current preview without extra history',async()=>{
 const h=await start(),initialVersion=editor!.state.version;await inputWidth('120');await menu('导出 PNG');await settle(()=>exportsHarness.jobs.length===1);const captured=job(0).args[0] as DesignDocument,committed=editor!.state.doc
 expect(job(0).kind).toBe('image');expect(job(0).args[1]).toBe(editor!.state.page);expect(job(0).args[2]).toBe('png');expect(job(0).args[3]).toBe(2);expect(captured).toEqual(committed);expect(captured).not.toBe(committed);expect(captured.nodes[h.id].width).toBe(120);expect(editor!.state.version).toBe(initialVersion+1);expect(signal(0).aborted).toBe(false)
 const asset=await complete(0,'draft-snapshot.png');await settle(()=>!!preview());expect(created).toHaveLength(1);expect(created[0].blob).toBe(asset.blob);expect(preview()!.getAttribute('src')).toBe(created[0].url);expect(link(asset.name)!.getAttribute('href')).toBe(created[0].url);expect(editor!.state.doc).toBe(committed);expect(editor!.state.selection).toEqual([h.id]);await closePreview();expect(revoked).toEqual([created[0].url]);await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canUndo).toBe(false);await redo();expect(editor!.state.doc).toEqual(committed)
})
test('E02 actual quick export then Canvas Delete Undo ABA cannot publish retired snapshot or corrupt redo',async()=>{
 const h=await start();await menu('导出 PNG');await settle(()=>exportsHarness.jobs.length===1);await command('Backspace');expect(editor!.state.doc.nodes[h.id]).toBeUndefined();const deleted=editor!.state.doc;expect(signal(0).aborted).toBe(true);await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.state.selection).toEqual([h.id]);expect(job(0).args[0]).toEqual(h.before)
 await complete(0,'retired-delete.png');expect(created).toHaveLength(0);expect(preview()).toBeNull();expect(link('retired-delete.png')).toBeUndefined();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canRedo).toBe(true);await redo();expect(editor!.state.doc).toEqual(deleted);expect(editor!.state.selection).toEqual([])
})
test('E03 actual New discard during quick export preserves fresh export when old result completes last',async()=>{
 const h=await start();await menu('导出 PNG');await settle(()=>exportsHarness.jobs.length===1);const generation=editor!.sessionGeneration;await menu('新建设计');await settle(()=>!!dialog());await decide('不保存');await settle(()=>editor!.state.doc.id!==h.before.id);const next=editor!.state.doc;expect(editor!.sessionGeneration).not.toBe(generation);expect(signal(0).aborted).toBe(true)
 await menu('导出 PNG');await settle(()=>exportsHarness.jobs.length===2);expect(job(1).args[0]).toEqual(next);expect(signal(1).aborted).toBe(false);const fresh=await complete(1,'fresh-document.png');await settle(()=>!!link(fresh.name));const status=editor!.state.message;await complete(0,'old-document.png');expect(created).toHaveLength(1);expect(created[0].blob).toBe(fresh.blob);expect(link(fresh.name)).toBeDefined();expect(link('old-document.png')).toBeUndefined();expect(editor!.state.doc).toBe(next);expect(editor!.state.selection).toEqual([]);expect(editor!.canUndo).toBe(false);expect(editor!.state.message).toBe(status);await closePreview()
})
test('E04 actual image panel Escape retires pending failure and fresh reopened panel owns its result',async()=>{
 const h=await start();await openPanel();await generatePanel();await settle(()=>exportsHarness.jobs.length===1);await escapePanel();expect(signal(0).aborted).toBe(true);await openPanel();await generatePanel();await settle(()=>exportsHarness.jobs.length===2);expect(signal(1).aborted).toBe(false)
 await act(async()=>{job(0).reject(new Error('retired-image-generation'));for(let i=0;i<30;i++)await Promise.resolve()});expect(document.body.textContent).not.toContain('retired-image-generation');expect(button('生成 PNG').disabled).toBe(true);const current=await complete(1,'reopened-panel.png');await settle(()=>!!link(current.name));expect(created).toHaveLength(1);expect(created[0].blob).toBe(current.blob);expect(button('生成 PNG').disabled).toBe(false);expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false);await escapePanel();expect(revoked).toEqual([created[0].url]);expect(document.activeElement?.isConnected).toBe(true)
})
test('E05 actual panel snapshot may finish after real NDJSON paint edit without rolling live document or history back',async()=>{
 const h=await start();const paintId=editor!.state.doc.nodes[h.id].fills[0].id,oldColor=editor!.state.doc.nodes[h.id].fills[0].color,rpc=await connectRpc();try{
  await openPanel();await generatePanel();await settle(()=>exportsHarness.jobs.length===1);expect(job(0).args[3]).toEqual({kind:'selection',nodeIds:[h.id]});expect(job(0).args[0]).toEqual(h.before);expect(job(0).args[0]).not.toBe(h.before)
  await act(async()=>{const response=await rpc.paint(h.id,paintId);expect(response.isError,JSON.stringify(response)).toBe(false)});const changed=editor!.state.doc,version=editor!.state.version;expect(changed.nodes[h.id].fills[0].color).toBe('#abcdef');expect(job(0).args[0].nodes[h.id].fills[0].color).toBe(oldColor);expect(signal(0).aborted).toBe(false)
  const asset=await complete(0,'captured-old-paint.png');await settle(()=>!!link(asset.name));expect(created[0].blob).toBe(asset.blob);expect(editor!.state.doc).toBe(changed);expect(editor!.state.version).toBe(version);expect(editor!.state.selection).toEqual([h.id]);await escapePanel();await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canUndo).toBe(false);await redo();expect(editor!.state.doc).toEqual(changed)
 }finally{await rpc.close()}
})
test('E06 actual quick export invalid property blocks producer then Escape allows clean retry without history',async()=>{
 const h=await start();await inputWidth('invalid');await menu('导出 PNG');await tick();expect(exportsHarness.jobs).toHaveLength(0);expect(created).toHaveLength(0);expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false);expect(width().value).toBe('invalid');expect(document.activeElement).toBe(width());await fieldKey('Escape');await menu('导出 PNG');await settle(()=>exportsHarness.jobs.length===1);expect(job(0).args[0]).toEqual(h.before);await complete(0,'clean-retry.png');await settle(()=>!!link('clean-retry.png'));expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false);await closePreview()
})
