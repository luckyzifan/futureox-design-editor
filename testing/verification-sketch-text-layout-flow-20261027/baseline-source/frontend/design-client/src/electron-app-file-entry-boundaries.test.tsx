// DRAFT NOT RUN. Mounted production App file menu -> DesktopSession -> actual
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
import { blank, node, type DesignDocument } from './model'
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
  await act(async () => root.unmount()); editor?.dispose(); nudgePreference.reset(); shortcutPreference.set('figma-like')
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
async function menu(action:'新建设计'|'打开本机设计文件'){
  if(!document.querySelector('.file-menu'))await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  const target=[...document.querySelectorAll<HTMLButtonElement>('.file-menu button')].find(b=>b.textContent?.includes(action))!
  expect(target).toBeTruthy();expect(target.disabled).toBe(false);await act(async()=>target.click())
}
function dialog(){return document.querySelector<HTMLElement>('[role="alertdialog"]')}
async function decide(text:'取消'|'不保存'|'保存'){expect(dialog()).not.toBeNull();const target=[...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;await act(async()=>target.click())}
function nativeFile(doc:DesignDocument):DesktopResult<DesktopFile>{const bytes=encodeDocumentBinary(doc);return {status:'ok',handle:'opaque:opened',displayName:'opened.fd',documentJson:JSON.stringify(decodeDocumentBinary(bytes))}}
async function unchangedHistory(before:DesignDocument){await act(async()=>editor!.undo());expect(editor!.state.doc).toEqual(before);expect(editor!.canUndo).toBe(false);await act(async()=>editor!.redo())}

test('F01 actual New menu settles valid Inspector draft; cancelling leave preserves original document and one undo',async()=>{
  const h=await start();await inputWidth('120');expect(editor!.state.doc).toBe(h.before)
  await menu('新建设计');await settle(()=>!!dialog());const committed=editor!.state.doc
  expect(committed.id).toBe(h.before.id);expect(committed.nodes[h.id].width).toBe(120);expect(committed.nodes[h.other]).toEqual(h.before.nodes[h.other])
  await decide('取消');await settle(()=>!dialog());expect(editor!.state.doc).toBe(committed);expect(h.bridge.saveDocument).not.toHaveBeenCalled();expect(h.bridge.acceptDocument).not.toHaveBeenCalled()
  await unchangedHistory(h.before);expect(editor!.state.doc).toEqual(committed)
})
test('F02 actual New menu cannot discard invalid field; Escape then explicit discard creates new blank without saving',async()=>{
  const h=await start();await inputWidth('invalid');await menu('新建设计');await settle(()=>editor!.state.message.includes('输入'))
  expect(dialog()).toBeNull();expect(editor!.state.doc).toBe(h.before);expect(width().value).toBe('invalid');expect(editor!.canUndo).toBe(false)
  await fieldKey('Escape');await menu('新建设计');await settle(()=>!!dialog());await decide('不保存');await settle(()=>editor!.state.doc.id!==h.before.id)
  expect(Object.keys(editor!.state.doc.nodes)).toHaveLength(0);expect(editor!.canUndo).toBe(false);expect(h.bridge.saveDocument).not.toHaveBeenCalled();expect(h.bridge.acceptDocument).not.toHaveBeenCalled()
})
test('F03 actual Open menu submits draft, saves exact old snapshot through leave dialog, then admits decoded FD',async()=>{
  const h=await start(),incoming=blank('Incoming FD'),shape=node('ellipse',10,20,30,40);incoming.nodes={[shape.id]:shape};incoming.pages[0].children=[shape.id]
  h.bridge.openDocument.mockResolvedValueOnce(nativeFile(incoming));await inputWidth('120');await menu('打开本机设计文件');await settle(()=>!!dialog())
  const committed=editor!.state.doc;expect(committed.nodes[h.id].width).toBe(120);expect(h.bridge.acceptDocument).not.toHaveBeenCalled()
  await decide('保存');await settle(()=>editor!.state.doc.id===incoming.id&&h.bridge.acceptDocument.mock.calls.length===1)
  expect(h.bridge.openDocument).toHaveBeenCalledTimes(1);expect(h.saved).toHaveLength(1);expect(decodeDocumentBinary(h.saved[0])).toEqual(committed)
  expect(editor!.state.doc).toEqual(incoming);expect(editor!.canUndo).toBe(false);expect(editor!.canRedo).toBe(false);expect(h.bridge.acceptDocument).toHaveBeenCalledWith({handle:'opaque:opened'})
})
test('F04 actual Open menu native chooser cancel preserves exact document/history and never asks to discard',async()=>{
  const h=await start();await inputWidth('120');await fieldKey('Enter');const before=editor!.state.doc
  await menu('打开本机设计文件');await settle(()=>h.bridge.openDocument.mock.calls.length===1);await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve()})
  expect(dialog()).toBeNull();expect(editor!.state.doc).toBe(before);expect(h.bridge.saveDocument).not.toHaveBeenCalled();expect(h.bridge.acceptDocument).not.toHaveBeenCalled()
  await unchangedHistory(h.before);expect(editor!.state.doc).toEqual(before)
})
test('F05 actual Open menu corrupt FD transport decode fails before leave/adoption, retaining current edits',async()=>{
  const h=await start();await inputWidth('120');await fieldKey('Enter');const before=editor!.state.doc,bytes=encodeDocumentBinary(blank('Truncated'))
  const decode=vi.fn(()=>decodeDocumentBinary(bytes.slice(0,12)))
  h.bridge.openDocument.mockImplementationOnce(async()=>{try{decode();throw new Error('Corrupt fixture unexpectedly decoded')}catch(error){return {status:'error',code:'INVALID_DOCUMENT',message:String(error)}}})
  await menu('打开本机设计文件');await settle(()=>h.bridge.openDocument.mock.calls.length===1);await act(async()=>{for(let i=0;i<20;i++)await Promise.resolve()})
  expect(decode).toHaveBeenCalledTimes(1);expect(decode.mock.results[0].type).toBe('throw');expect(dialog()).toBeNull();expect(editor!.state.doc).toBe(before);expect(editor!.canUndo).toBe(true)
  expect(h.bridge.acceptDocument).not.toHaveBeenCalled();expect(h.bridge.saveDocument).not.toHaveBeenCalled();await unchangedHistory(h.before);expect(editor!.state.doc).toEqual(before)
})
test('F06 actual Open menu deferred decode cannot overwrite a newly adopted same-ID session',async()=>{
  const h=await start(),incoming=blank('Delayed FD'),pending=deferred<unknown>()
  const decode=vi.fn(()=>pending.promise);Object.assign(h.bridge,{documentCodec:{encode:async(d:unknown)=>JSON.stringify(d),decode}})
  h.bridge.openDocument.mockResolvedValueOnce(nativeFile(incoming));await menu('打开本机设计文件');await settle(()=>decode.mock.calls.length===1)
  const replacement=structuredClone(h.before);replacement.nodes[h.id].name='New session node';const generation=editor!.sessionGeneration
  await act(async()=>expect(editor!.load(replacement)).toBe(true));const adopted=editor!.state.doc;expect(editor!.sessionGeneration).not.toBe(generation)
  await act(async()=>pending.resolve(JSON.parse((nativeFile(incoming) as {documentJson:string}).documentJson)));await settle(()=>editor!.state.message.includes('读取期间'))
  expect(editor!.state.doc).toBe(adopted);expect(editor!.state.doc.id).toBe(h.before.id);expect(editor!.canUndo).toBe(false);expect(dialog()).toBeNull();expect(h.bridge.acceptDocument).not.toHaveBeenCalled();expect(h.bridge.saveDocument).not.toHaveBeenCalled()
})
