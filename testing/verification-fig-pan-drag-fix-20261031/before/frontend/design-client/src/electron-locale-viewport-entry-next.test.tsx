// DRAFT NOT RUN L01-L06: actual mounted App locale/viewport combinations.
// DOM/state and controlled placement arithmetic only, no pixel/DPI/OS GUI proof.
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
import { interfacePreference, INTERFACE_PREFERENCE_KEY, interfaceText } from './interface-preference'
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
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'CompositionEvent', 'StorageEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`) })
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView=()=>{}; // jsdom layout transport only; no scrolling/pixel assertion.
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
  Object.defineProperties(window,{innerWidth:{configurable:true,value:1200},innerHeight:{configurable:true,value:800}});
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
async function menu(action:string){
  if(!document.querySelector('.file-menu'))await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!.click())
  const target=[...document.querySelectorAll<HTMLButtonElement>('.file-menu button')].find(b=>b.textContent?.includes(action))!
  expect(target).toBeTruthy();expect(target.disabled).toBe(false);await act(async()=>target.click())
}
function dialog(){return document.querySelector<HTMLElement>('[role="alertdialog"]')}
async function decide(text:'取消'|'不保存'|'保存'){expect(dialog()).not.toBeNull();const target=[...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)!;await act(async()=>target.click())}
function nativeFile(doc:DesignDocument):DesktopResult<DesktopFile>{const bytes=encodeDocumentBinary(doc);return {status:'ok',handle:'opaque:opened',displayName:'opened.fd',documentJson:JSON.stringify(decodeDocumentBinary(bytes))}}
async function unchangedHistory(before:DesignDocument){await act(async()=>editor!.undo());expect(editor!.state.doc).toEqual(before);expect(editor!.canUndo).toBe(false);await act(async()=>editor!.redo())}


import { hasPendingEdits } from './pending-edits'
async function externalLocale(locale:'zh-CN'|'en'){await act(async()=>{localStorage.setItem(INTERFACE_PREFERENCE_KEY,JSON.stringify({...interfacePreference.getSnapshot(),locale}));window.dispatchEvent(new StorageEvent('storage',{key:INTERFACE_PREFERENCE_KEY,storageArea:localStorage}));for(let i=0;i<8;i++)await Promise.resolve()});expect(interfacePreference.getSnapshot().locale).toBe(locale);expect(document.documentElement.lang).toBe(locale)}
async function viewport(w:number,h=800){await act(async()=>{Object.defineProperties(window,{innerWidth:{configurable:true,value:w},innerHeight:{configurable:true,value:h}});window.dispatchEvent(new Event('resize'));for(let i=0;i<8;i++)await Promise.resolve()})}
const shell=()=>document.querySelector<HTMLElement>('.editor-shell')!
const field=(name:string)=>document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
async function typeField(f:HTMLInputElement,value:string){expect(f).not.toBeNull();await act(async()=>{f.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(f,value);f.dispatchEvent(new Event('input',{bubbles:true}))})}
async function press(target:HTMLElement,k:string,options:KeyboardEventInit={}){await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true,...options})))}
function panelToggle(side:'left'|'right'){const name=interfaceText[interfacePreference.getSnapshot().locale][side];return document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"][aria-expanded]`)!}
async function toggle(side:'left'|'right'){await workspaceOpen();const b=panelToggle(side);expect(b).not.toBeNull();await pointerActivate(b)}
async function openCompactBoth(){for(const side of ['left','right'] as const){if(panelToggle(side).getAttribute('aria-expanded')==='false')await toggle(side);expect(panelToggle(side).getAttribute('aria-expanded')).toBe('true')}}
async function undo(){canvas().focus();await key('z',{metaKey:true})}
async function redo(){canvas().focus();await key('z',{metaKey:true,shiftKey:true})}
async function openColor(slot=0){const cards=[...document.querySelectorAll<HTMLElement>('.property-card')].filter(x=>x.querySelector('.paint-editor')),b=cards[slot].querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;expect(b).not.toBeNull();await act(async()=>b.click());expect(document.querySelector('.property-color-popover')).not.toBeNull();return b}
async function exactButton(text:string,scope:ParentNode=document){const b=[...scope.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text)!;expect(b).toBeDefined();expect(b.disabled).toBe(false);await act(async()=>{b.focus();b.click()})}
async function openPresets(){const label=interfacePreference.getSnapshot().locale==='en'?'Region tools':'区域工具';const b=document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;expect(b).not.toBeNull();await act(async()=>b.click());await exactButton(interfacePreference.getSnapshot().locale==='en'?'Device and size presets…':'设备与尺寸预设…');await settle(()=>!!document.querySelector('.frame-preset-panel'))}

test('L01 real dirty Inspector remains recoverable within compact viewport through visible toggle or Escape without forced window widening',async()=>{
 const h=await start(),prefs=interfacePreference.getSnapshot(),version=editor!.state.version,f=width();await inputWidth('120');expect(hasPendingEdits(editor!)).toBe(true);await viewport(899);expect(width()).toBe(f);expect(f.value).toBe('120');expect(editor!.state.doc).toBe(h.before);await externalLocale('en');await viewport(560);expect(width()).toBe(f)
 // A genuine visible control is focused before keyboard input. Never synthesize
 // an event directly on a CSS-hidden field and call that user recovery.
 expect(editor!.state.doc).toBe(h.before);expect(editor!.state.version).toBe(version);expect(f.value).toBe('120')
 await toggle('right');expect(shell().classList.contains('chrome-hide-inspector')).toBe(false);expect(window.innerWidth).toBe(560);expect(width()).toBe(f)
 // Explicit focus transfer causes the production field blur commit. Resizing
 // and external locale alone above did not commit; this boundary must commit once.
 const committed=editor!.state.doc;expect(committed.nodes[h.id].width).toBe(120);expect(committed.nodes[h.id].height).toBe(50);expect(committed.nodes[h.other]).toEqual(h.before.nodes[h.other]);expect(editor!.state.version).toBe(version+1);expect(hasPendingEdits(editor!)).toBe(false);await act(async()=>f.focus());await press(f,'Enter');expect(editor!.state.doc).toBe(committed);expect(editor!.state.version).toBe(version+1);await viewport(1200);expect(interfacePreference.getSnapshot().leftOpen).toBe(prefs.leftOpen);expect(interfacePreference.getSnapshot().rightOpen).toBe(prefs.rightOpen);await undo();expect(editor!.state.doc).toEqual(h.before);await redo();expect(editor!.state.doc).toEqual(committed)
})
test('L02 actual color composition retains session through compact resize and external locale then cancel preserves redo',async()=>{
 const h=await start();await inputWidth('120');await fieldKey('Enter');const redone=editor!.state.doc;await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canRedo).toBe(true);const before=editor!.state.doc,version=editor!.state.version;await openColor();const f=field('填充颜色值'),panel=document.querySelector('.property-color-popover')!;await act(async()=>f.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));await typeField(f,'#abcdef');await viewport(560,420);await externalLocale('en');await viewport(1200,800);expect(field('Fill color value')).toBe(f);expect(document.querySelector('.property-color-popover')).toBe(panel);expect(document.activeElement).toBe(f);expect(f.value).toBe('#abcdef');await press(f,'Enter');await press(f,'Escape');expect(document.querySelector('.property-color-popover')).toBe(panel);expect(editor!.authoredDocument).toBe(before);expect(editor!.state.version).toBe(version);await act(async()=>f.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await press(f,'Escape');expect(document.querySelector('.property-color-popover')).toBeNull();expect(editor!.state.doc).toEqual(before);expect(editor!.canRedo).toBe(true);await redo();expect(editor!.state.doc).toEqual(redone)
})
test('L03 actual Canvas context menu dismisses on resize and reopens translated without stale command history',async()=>{
 const h=await start();canvas().focus();await key('ContextMenu');const old=document.querySelector<HTMLElement>('[role="menu"]')!;expect(old).not.toBeNull();await press(old,'ArrowDown');expect(old.contains(document.activeElement)).toBe(true);await viewport(560,420);expect(document.querySelector('[role="menu"]')).toBeNull();expect(old.isConnected).toBe(false);expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false);await externalLocale('en');canvas().focus();await key('ContextMenu');const next=document.querySelector<HTMLElement>('[role="menu"]')!;expect(next).not.toBeNull();expect(next).not.toBe(old);await act(async()=>next.querySelector<HTMLButtonElement>('button[data-menu-group="selection"]')!.click());expect([...next.querySelectorAll('.context-label')].some(e=>e.textContent==='Invert selection')).toBe(true);await press(next,'Escape');expect(document.querySelector('[role="menu"]')).toBeNull();await viewport(1200);canvas().focus();await key('ContextMenu');await act(async()=>document.querySelector<HTMLButtonElement>('[role="menu"] button[data-menu-group="selection"]')!.click());const all=[...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(b=>b.querySelector('.context-label')?.textContent==='Invert selection')!;expect(all).not.toBeNull();await act(async()=>{all.click();for(let i=0;i<12;i++)await Promise.resolve()});expect(new Set(editor!.state.selection)).toEqual(new Set([h.other]));expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false)
})
test('L04 actual App preset dialog keeps custom drafts across locale and viewport with focus trap and one creation history',async()=>{
 const h=await start();await openPresets();const panel=document.querySelector<HTMLElement>('.frame-preset-panel')!,name=field('自定义画板名称'),w=field('自定义画板宽'),height=field('自定义画板高');await typeField(name,'Authored 中文');await typeField(w,'123');await typeField(height,'234');await viewport(560,420);await externalLocale('en');await viewport(1200,800);expect(document.querySelector('.frame-preset-panel')).toBe(panel);expect(field('Custom frame name')).toBe(name);expect(field('Custom frame width')).toBe(w);expect(name.value).toBe('Authored 中文');expect(w.value).toBe('123');expect(height.value).toBe('234');expect(document.activeElement).toBe(height);expect(editor!.state.doc).toBe(h.before)
 const controls=[...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]')];const first=controls[0],last=controls.at(-1)!;await act(async()=>last.focus());await press(last,'Tab');expect(document.activeElement).toBe(first);await press(first,'Tab',{shiftKey:true});expect(document.activeElement).toBe(last);await act(async()=>panel.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(document.querySelector('.frame-preset-panel')).toBeNull();const after=editor!.state.doc,n=after.nodes[editor!.state.selection[0]];expect(n).toMatchObject({kind:'frame',name:'Authored 中文',width:123,height:234});expect(after.nodes[h.id]).toEqual(h.before.nodes[h.id]);await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canUndo).toBe(false);await redo();expect(editor!.state.doc).toEqual(after);await openPresets();await viewport(560);const reopened=document.querySelector<HTMLElement>('.frame-preset-panel')!;await press(reopened,'Escape');expect(document.querySelector('.frame-preset-panel')).toBeNull();expect(editor!.state.doc).toEqual(after)
})
test('L05 actual compact multi Inspector invalid draft still vetoes translated Layers tab then Escape restores navigation',async()=>{
 const h=await start(),mixed=structuredClone(h.before);mixed.nodes[h.id].opacity=.2;mixed.nodes[h.other].opacity=.7;await act(async()=>{editor!.load(mixed);editor!.select([h.id])});h.before=editor!.state.doc;await viewport(560);await openCompactBoth();const a=document.querySelector<HTMLElement>(`[data-testid="layer-${h.id}"]`)!,b=document.querySelector<HTMLElement>(`[data-testid="layer-${h.other}"]`)!;await act(async()=>a.dispatchEvent(new MouseEvent('click',{bubbles:true})));await act(async()=>b.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:true})));expect(new Set(editor!.state.selection)).toEqual(new Set([h.id,h.other]));const f=field('透明度 %');expect(f).not.toBeNull();await typeField(f,'101');await press(f,'Enter');expect(f.getAttribute('aria-invalid')).toBe('true');await externalLocale('en');await viewport(899);expect(f.isConnected).toBe(true);expect(f.value).toBe('101');const tabs=[...document.querySelectorAll<HTMLButtonElement>('.layers-panel [role="tab"]')];expect(tabs).toHaveLength(2);await act(async()=>tabs[1].click());expect(tabs[0].getAttribute('aria-selected')).toBe('true');expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false);await press(f,'Escape');await act(async()=>tabs[1].click());expect(tabs[1].getAttribute('aria-selected')).toBe('true');const panelId=tabs[1].getAttribute('aria-controls')!;expect(document.getElementById(panelId)).not.toBeNull();await viewport(1200);expect(editor!.state.doc).toBe(h.before);expect(new Set(editor!.state.selection)).toEqual(new Set([h.id,h.other]));expect(editor!.canUndo).toBe(false)
})
test('L06 actual second-fill popover reclamps controlled viewport while preview stays owned then Apply Undo Redo',async()=>{
 const h=await start(),doc=structuredClone(h.before);doc.nodes[h.id].fills=[paint('#112233'),paint('#445566')];await act(async()=>{editor!.load(doc);editor!.select([h.id])});const before=editor!.state.doc,version=editor!.state.version;const cards=[...document.querySelectorAll<HTMLElement>('.property-card')].filter(x=>x.querySelector('.paint-editor'));const trigger=cards[1].querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;Object.defineProperty(trigger,'getBoundingClientRect',{configurable:true,value:()=>({left:1100,top:700,width:24,height:24,right:1124,bottom:724,x:1100,y:700,toJSON(){}})});await act(async()=>trigger.click());const panel=document.querySelector<HTMLElement>('.property-color-popover')!,f=field('填充颜色值');Object.defineProperty(panel,'getBoundingClientRect',{configurable:true,value:()=>({left:0,top:0,width:316,height:300,right:316,bottom:300,x:0,y:0,toJSON(){}})});expect(trigger.getBoundingClientRect).not.toBe(panel.getBoundingClientRect);expect(trigger.getBoundingClientRect().left).toBe(1100);await typeField(f,'#abcdef');await typeField(field('填充不透明度 %'),'25');const expected=(w:number,h:number)=>({left:Math.max(8,Math.min(1100-Math.min(316,Math.max(0,w-16)),w-Math.min(316,Math.max(0,w-16))-8)),top:Math.max(8,Math.min(700,h-300-8))});for(const [w,hgt] of [[560,420],[1200,800]]){await viewport(w,hgt);const e=expected(w,hgt);expect(Number.parseFloat(panel.style.left)).toBe(e.left);expect(Number.parseFloat(panel.style.top)).toBe(e.top);expect(document.querySelector('.property-color-popover')).toBe(panel)}await externalLocale('en');expect(field('Fill color value')).toBe(f);expect(f.value).toBe('#abcdef');expect(editor!.authoredDocument).toBe(before);expect(editor!.state.version).toBe(version);await exactButton('Apply',panel);const after=editor!.state.doc;expect(after.nodes[h.id].fills[1]).toMatchObject({id:doc.nodes[h.id].fills[1].id,color:'#abcdef',opacity:.25});expect(after.nodes[h.id].fills[0]).toEqual(before.nodes[h.id].fills[0]);expect(after.nodes[h.other]).toEqual(before.nodes[h.other]);expect(editor!.state.version).toBe(version+1);await undo();expect(editor!.state.doc).toEqual(before);await redo();expect(editor!.state.doc).toEqual(after);await openColor(1);await exactButton('Cancel',document.querySelector('.property-color-popover')!);expect(editor!.state.doc).toEqual(after);expect(document.activeElement?.isConnected).toBe(true)
})

test('L07 invalid real Inspector draft can recover while still compact via visible toggle and Escape rather than forced wider window',async()=>{
 const h=await start(),f=width(),version=editor!.state.version;await inputWidth('invalid');await fieldKey('Enter');expect(f.validity.customError).toBe(true);expect(hasPendingEdits(editor!)).toBe(true);await viewport(560,420);await externalLocale('en');expect(width()).toBe(f);expect(f.value).toBe('invalid');expect(editor!.state.doc).toBe(h.before)
 await toggle('right');if(shell().classList.contains('chrome-hide-inspector')){await press(workspaceSummary(),'Escape');await toggle('right')}
 if(shell().classList.contains('chrome-hide-inspector')){canvas().focus();await key('Escape');await toggle('right')}
 expect({rightHidden:shell().classList.contains('chrome-hide-inspector'),pending:hasPendingEdits(editor!),customError:f.validity.customError,activeIsVisibleToggle:document.activeElement===panelToggle('right')},'Invalid draft needs a usable narrow-window recovery route through visible controls').toMatchObject({rightHidden:false})
 expect(window.innerWidth).toBe(560);expect(width()).toBe(f);await act(async()=>f.focus());await press(f,'Escape');expect(hasPendingEdits(editor!)).toBe(false);expect(f.validity.customError).toBe(false);expect(editor!.state.doc).toBe(h.before);expect(editor!.state.version).toBe(version);expect(editor!.canUndo).toBe(false);expect(editor!.state.selection).toEqual([h.id])
})

async function pointerActivate(target:HTMLElement){let prevented=false;await act(async()=>{const down=new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:20,clientY:20});Object.defineProperties(down,{pointerId:{value:41},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(down);prevented=down.defaultPrevented;if(!prevented)target.focus();const up=new MouseEvent('pointerup',{bubbles:true,cancelable:true,button:0,clientX:20,clientY:20});Object.defineProperties(up,{pointerId:{value:41},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(up);target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,button:0}));for(let i=0;i<8;i++)await Promise.resolve()});return prevented}
async function keyboardActivate(target:HTMLElement,k:'Enter'|' '){let prevented=false;await act(async()=>{target.focus();const down=new KeyboardEvent('keydown',{key:k,code:k===' '?'Space':'Enter',bubbles:true,cancelable:true});target.dispatchEvent(down);prevented=down.defaultPrevented;target.dispatchEvent(new KeyboardEvent('keyup',{key:k,code:k===' '?'Space':'Enter',bubbles:true,cancelable:true}));/* jsdom has no native button default activation; synthesize only when capture did not cancel it. */if(!prevented)target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));for(let i=0;i<8;i++)await Promise.resolve()});return prevented}
for(const entry of ['pointer','Enter','Space'] as const)test(`L08 hidden invalid Inspector reveal through ${entry} preserves original input error and restores focus for one corrected commit`,async()=>{
 const h=await start(),f=width(),version=editor!.state.version;await inputWidth('invalid');await fieldKey('Enter');expect(f.validity.customError).toBe(true);await viewport(560);expect(shell().classList.contains('chrome-hide-inspector')).toBe(true);await workspaceOpen(entry);const reveal=panelToggle('right');const blocked=entry==='pointer'?await pointerActivate(reveal):await keyboardActivate(reveal,entry==='Space'?' ':'Enter')
 expect(blocked,'Revealing hidden pending owner must not be cancelled by App capture').toBe(false);expect(shell().classList.contains('chrome-hide-inspector')).toBe(false);expect(width()).toBe(f);expect(f.value).toBe('invalid');expect(f.validity.customError).toBe(true);expect(hasPendingEdits(editor!)).toBe(true);expect(document.activeElement,'Original visible invalid input must regain focus, not a detached or hidden substitute').toBe(f);expect(editor!.state.doc).toBe(h.before);expect(editor!.state.version).toBe(version)
 await typeField(f,'125');await press(f,'Enter');const after=editor!.state.doc;expect(after.nodes[h.id].width).toBe(125);expect(after.nodes[h.id].height).toBe(50);expect(after.nodes[h.other]).toEqual(h.before.nodes[h.other]);expect(editor!.state.version).toBe(version+1);expect(hasPendingEdits(editor!)).toBe(false);await undo();expect(editor!.state.doc).toEqual(h.before);expect(editor!.canUndo).toBe(false);await redo();expect(editor!.state.doc).toEqual(after)
})
test('L09 visible invalid owner still blocks panel close sidebar navigation and New until Escape cancels',async()=>{
 const h=await start();await viewport(560);await openCompactBoth();const f=width(),version=editor!.state.version;await inputWidth('invalid');await fieldKey('Enter');expect(document.activeElement).toBe(f);expect(f.validity.customError).toBe(true)
 for(const side of ['left','right'] as const){await workspaceOpen();expect(await pointerActivate(panelToggle(side))).toBe(true);expect(panelToggle(side).getAttribute('aria-expanded')).toBe('true');expect(document.activeElement).toBe(workspaceSummary())}
 const tabs=[...document.querySelectorAll<HTMLButtonElement>('.layers-panel [role="tab"]')];expect(tabs).toHaveLength(2);expect(await pointerActivate(tabs[1])).toBe(true);expect(tabs[0].getAttribute('aria-selected')).toBe('true');expect(f.value).toBe('invalid')
 const file=document.querySelector<HTMLButtonElement>('[aria-label="文件菜单"]')!;expect(await pointerActivate(file)).toBe(true);const newButton=[...document.querySelectorAll<HTMLButtonElement>('.file-menu button')].find(b=>b.textContent?.includes('新建设计'));if(newButton)await pointerActivate(newButton)
 expect(dialog()).toBeNull();expect(editor!.state.doc).toBe(h.before);expect(editor!.state.version).toBe(version);expect(hasPendingEdits(editor!)).toBe(true);expect(shell().classList.contains('chrome-hide-inspector')).toBe(false);const refocusPrevented=await pointerActivate(f);console.log('L09_REFOCUS_DIAGNOSTIC',JSON.stringify({prevented:refocusPrevented,active:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label'),rightHidden:shell().classList.contains('chrome-hide-inspector'),connected:f.isConnected,hiddenAncestor:!!f.closest('[hidden],[inert]'),customError:f.validity.customError,pending:hasPendingEdits(editor!)}));expect(document.activeElement,'Visible invalid field must be reachable again after blocked navigation').toBe(f);await press(f,'Escape');expect(f.validity.customError).toBe(false);expect(hasPendingEdits(editor!)).toBe(false);expect(editor!.canUndo).toBe(false);await workspaceOpen();expect(await pointerActivate(panelToggle('right'))).toBe(false);expect(panelToggle('right').getAttribute('aria-expanded')).toBe('false');expect(editor!.state.doc).toBe(h.before)
})

function workspaceSummary(){const summary=document.querySelector<HTMLElement>('details.workspace-actions > summary')!;expect(summary).not.toBeNull();return summary}
async function workspaceOpen(entry:'pointer'|'Enter'|'Space'='pointer'){const summary=workspaceSummary(),details=summary.parentElement as HTMLDetailsElement;if(!details.open){if(entry==='pointer')await pointerActivate(summary);else await keyboardActivate(summary,entry==='Space'?' ':'Enter')}expect(details.open,'Workspace summary must actually expose controls before activating a panel toggle').toBe(true);expect(summary.getAttribute('aria-label')).toBe('更多工作区操作')}
// DRAFT NOT RUN. Append to the mounted locale/viewport test module; reuses its
// real App, Editor and activation helpers. No product file changes.
import { cancelPendingOperations } from './pending-edits'

test('L10 fake recovery markers and unrelated side cannot bypass actual pending panel owner',async()=>{
 const h=await start(),f=width();await inputWidth('invalid');await fieldKey('Enter');await viewport(560);await workspaceOpen()
 const fake=document.createElement('button');fake.textContent='Synthetic unrelated control';fake.setAttribute('data-panel-reveal','right');fake.setAttribute('data-panel-recovery','right');shell().append(fake)
 try{expect(await pointerActivate(fake)).toBe(true);expect(shell().classList.contains('chrome-hide-inspector')).toBe(true);expect(editor!.state.doc).toBe(h.before);expect(hasPendingEdits(editor!)).toBe(true)
  await workspaceOpen();expect(await pointerActivate(panelToggle('left'))).toBe(true);expect(panelToggle('left').getAttribute('aria-expanded')).toBe('false');expect(panelToggle('right').getAttribute('aria-expanded')).toBe('false');expect(f.value).toBe('invalid');expect(f.validity.customError).toBe(true)
  const outside=document.createElement('button');outside.setAttribute('data-panel-reveal','right');document.body.append(outside);try{await pointerActivate(outside);expect(panelToggle('right').getAttribute('aria-expanded')).toBe('false');expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false)}finally{outside.remove()}
 }finally{fake.remove()}
})
for(const transition of ['same-ID session','selection'] as const)test(`L11 queued panel focus recovery cannot target stale input after ${transition} replacement`,async()=>{
 const h=await start(),f=width(),initialSession=editor!.sessionGeneration;await inputWidth('invalid');await fieldKey('Enter');await viewport(560);await workspaceOpen();const summary=workspaceSummary(),reveal=panelToggle('right');let fired=false,armed=false,oldFocusAfterTransition=0
 const focus=()=>{if(armed)oldFocusAfterTransition++};f.addEventListener('focus',focus)
 // Controlled synchronous cancellation through the real NumberField handler,
 // not an assertion that a user can reach this hidden field. No registry clear,
 // forced Editor state or bypass of load's pending-input admission is used.
 const trace:unknown[]=[]
 const interrupt=()=>{fired=true;trace.push({event:'interrupt',pending:hasPendingEdits(editor!),selection:[...editor!.state.selection]});f.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(hasPendingEdits(editor!)).toBe(false);expect(f.validity.customError).toBe(false);trace.push({event:'cancelled',pending:hasPendingEdits(editor!)});if(transition==='same-ID session'){const replacement=structuredClone(h.before);replacement.nodes[h.id].name='Replacement session';expect(editor!.load(replacement)).toBe(true);expect(editor!.sessionGeneration).not.toBe(initialSession);editor!.select([h.id]);expect(editor!.state.selection).toEqual([h.id])}else{editor!.select([h.other]);expect(editor!.state.selection).toEqual([h.other])}trace.push({event:'transitioned',session:editor!.sessionGeneration,selection:[...editor!.state.selection]});armed=true}
 // The actual App menu wrapper focuses its summary after togglePanel queues
 // recovery, but before React's layout effect. This is a synchronous subscriber
 // boundary, not a timer delay or monkey-patched focus implementation.
 summary.addEventListener('focus',interrupt,{once:true})
 try{expect(await pointerActivate(reveal)).toBe(false);expect(fired,'The real wrapper focus transition must execute the interruption').toBe(true);console.log('L11_OWNER_TRANSITION',JSON.stringify({transition,trace,oldFocusAfterTransition,activeTag:document.activeElement?.tagName,activeLabel:document.activeElement?.getAttribute('aria-label')}));expect(oldFocusAfterTransition).toBe(0);expect(document.activeElement).not.toBe(f);expect(editor!.canUndo).toBe(false);expect(editor!.canRedo).toBe(false)
  if(transition==='same-ID session'){expect(editor!.sessionGeneration).not.toBe(initialSession);expect(editor!.state.doc.id).toBe(h.before.id);expect(editor!.state.doc.nodes[h.id].name).toBe('Replacement session');expect(editor!.state.selection).toEqual([h.id])}else{expect(editor!.sessionGeneration).toBe(initialSession);expect(editor!.state.doc).toBe(h.before);expect(editor!.state.selection).toEqual([h.other])}
 }finally{summary.removeEventListener('focus',interrupt);f.removeEventListener('focus',focus)}
})
test('L12 queued recovery does not steal a newer visible editable focus owner',async()=>{
 const h=await start(),f=width();await inputWidth('invalid');await fieldKey('Enter');await viewport(560);await workspaceOpen();const summary=workspaceSummary(),reveal=panelToggle('right'),newOwner=document.createElement('input');newOwner.setAttribute('aria-label','External editable focus owner');newOwner.value='Independent draft';document.body.append(newOwner);let fired=false
 const interrupt=()=>{fired=true;newOwner.focus()};summary.addEventListener('focus',interrupt,{once:true})
 try{expect(await pointerActivate(reveal)).toBe(false);expect(fired).toBe(true);expect(shell().classList.contains('chrome-hide-inspector')).toBe(false);expect(document.activeElement).toBe(newOwner);expect(newOwner.value).toBe('Independent draft');expect(width()).toBe(f);expect(f.value).toBe('invalid');expect(f.validity.customError).toBe(true);expect(hasPendingEdits(editor!)).toBe(true);expect(editor!.state.doc).toBe(h.before);expect(editor!.canUndo).toBe(false)}finally{summary.removeEventListener('focus',interrupt);newOwner.remove()}
})
