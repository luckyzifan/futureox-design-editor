// DRAFT_NOT_RUN C04: one cross-parent rejection / explicit move-page / resource paste chain.
// Actual mounted Canvas + Layers + Inspector, registered keyboard/menu commands.
// CPU WASM real; KernelSurface/device layout and native clipboard/save transport doubles.
// Save uses production DesktopSession.save seam, NOT an App/native-menu save click.
// FD bytes really roundtrip a temporary file and reopen in a fresh Editor.
// @ts-expect-error jsdom runtime dependency
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Canvas } from './Canvas'
import { Layers } from './Layers'
import { Inspector } from './Inspector'
import { PendingEditContext } from './pending-edit-context'
import { Editor } from './engine'
import { DesktopSession } from './desktop-session'
import type { DesktopBridge, DesktopClipboard, DesktopCommand } from './desktop'
import { blank, node, paint, uid, type DesignDocument, type DesignNode } from './model'
import { worldMatrix } from './geometry'
import { shortcutPreference } from './shortcut-preference'
import { interfacePreference } from './interface-preference'
import { shortcutBindings, resolveShortcut, type ShortcutAction } from './shortcut-profiles'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
const bootstrap=await vi.hoisted(async()=>{
  // @ts-expect-error jsdom runtime dependency
  const {JSDOM}=await import('jsdom');const d=new JSDOM('<!doctype html><html><body></body></html>')
  for(const k of['window','document','navigator'])vi.stubGlobal(k,k==='window'?d.window:d.window[k]);return d
})
bootstrap.window.close()
vi.mock('./kernel/Surface',async()=>{const {useLayoutEffect}=await import('react');return{KernelSurface(props:import('./kernel/Surface').SurfaceProps){useLayoutEffect(()=>{props.onPresentation?.({...props,epoch:props.presentationEpoch!,pixelRatio:1,managed:false})},[props.document,props.pageId,props.view,props.width,props.height,props.presentationEpoch,props.onPresentation]);return <div data-testid="device-boundary"/>}}})
let dom:any,root:Root,mount:HTMLDivElement,editor:Editor,errors:unknown[][]
let listeners:Set<(command:DesktopCommand)=>void>,bridge:DesktopBridge,clipboard:DesktopClipboard
let writeClipboard:ReturnType<typeof vi.fn>,readClipboard:ReturnType<typeof vi.fn>,saveDocument:ReturnType<typeof vi.fn>
const hostRect={left:37,top:23,right:1037,bottom:823,width:1000,height:800,x:37,y:23,toJSON(){}}
type Step={name:string;before:DesignDocument;after:DesignDocument;selectionBefore:string[];selectionAfter:string[];pageBefore:string;pageAfter:string}
let steps:Step[]
beforeEach(()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
 for(const k of['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLCanvasElement','Element','Node','Event','MouseEvent','KeyboardEvent','FocusEvent','WheelEvent','localStorage'])vi.stubGlobal(k,k==='window'?dom.window:dom.window[k])
 Object.defineProperty(navigator,'platform',{configurable:true,value:'MacIntel'});vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('devicePixelRatio',1)
 vi.stubGlobal('CSS',{escape:(v:string)=>v.replace(/[^a-zA-Z0-9_-]/g,c=>`\\${c}`)})
 dom.window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}})
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}})
 let frame=0;const pending=new Map<number,FrameRequestCallback>();vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{pending.set(++frame,fn);return frame});vi.stubGlobal('cancelAnimationFrame',(id:number)=>pending.delete(id))
 Object.defineProperties(dom.window.HTMLElement.prototype,{clientWidth:{configurable:true,get:()=>1000},clientHeight:{configurable:true,get:()=>800}})
 vi.spyOn(dom.window.HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(hostRect)
 dom.window.HTMLElement.prototype.setPointerCapture=()=>{};dom.window.HTMLElement.prototype.hasPointerCapture=()=>false;dom.window.HTMLElement.prototype.releasePointerCapture=()=>{}
 vi.spyOn(dom.window.HTMLCanvasElement.prototype,'getContext').mockReturnValue(null)
 errors=[];const original=console.error.bind(console);vi.spyOn(console,'error').mockImplementation((...v)=>{errors.push(v);original(...v)})
 localStorage.clear();shortcutPreference.set('sketch-like');interfacePreference.set({locale:'zh-CN'});listeners=new Set();clipboard={};steps=[]
 writeClipboard=vi.fn(async(value:DesktopClipboard)=>{clipboard=structuredClone(value);return{status:'ok'}})
 readClipboard=vi.fn(async()=>({status:'ok',...structuredClone(clipboard)}))
 saveDocument=vi.fn(async(_request:{documentJson:string;handle?:string;saveAs?:boolean})=>({status:'ok',handle:'chain.fd',displayName:'chain.fd'}))
 bridge={version:1,renderPolicy:{cpuOnly:true},onCommand:(fn:(command:DesktopCommand)=>void)=>{listeners.add(fn);return()=>{expect(listeners.delete(fn)).toBe(true)}},clipboard:{write:writeClipboard,read:readClipboard},readRecovery:vi.fn(async()=>({status:'cancelled'})),clearRecovery:vi.fn(async()=>({status:'ok'})),writeRecovery:vi.fn(async()=>({status:'ok'})),setDirty:vi.fn(async()=>{}),saveDocument} as unknown as DesktopBridge
 Object.defineProperty(window,'coreDesktop',{configurable:true,value:bridge})
 mount=document.createElement('div');document.body.append(mount);root=createRoot(mount)
})
afterEach(async()=>{await act(async()=>root.unmount());expect(listeners.size).toBe(0);editor?.dispose();dom.window.close();vi.unstubAllGlobals();vi.restoreAllMocks();expect(errors).toEqual([])})
const host=()=>mount.querySelector<HTMLElement>('[data-testid="canvas"]')!
async function microtasks(){for(let i=0;i<8;i++)await Promise.resolve()}
async function fixture(nodes:DesignNode[],roots=nodes.map(n=>n.id),zoom=1,otherRoots:string[]=[]){const d=blank('Bounded operation chain');d.schemaVersion=6;d.nodes=Object.fromEntries(nodes.map(n=>[n.id,n]));d.pages[0].children=roots;if(otherRoots.length)d.pages.push({id:uid(),name:'Destination page',children:otherRoots,background:'#ffffff'});editor=new Editor(d);editor.set({view:{x:19,y:31,zoom},snap:false,snapPixels:false});await act(async()=>{root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor}/><Layers editor={editor}/><Inspector editor={editor}/></PendingEditContext.Provider>);await microtasks()});expect(listeners.size).toBe(1);host().focus();return editor.state.doc}
function point(p:{x:number;y:number}){return{x:hostRect.left+editor.state.view.x+p.x*editor.state.view.zoom,y:hostRect.top+editor.state.view.y+p.y*editor.state.view.zoom}}
function pointer(type:string,p:{x:number;y:number},target:Element=host(),options:MouseEventInit={}){const s=point(p),e=new MouseEvent(type,{bubbles:true,cancelable:true,clientX:s.x,clientY:s.y,button:0,...options});Object.defineProperties(e,{pointerId:{value:7},isPrimary:{value:true},pointerType:{value:'mouse'}});target.dispatchEvent(e)}
async function at(type:string,p:{x:number;y:number},target?:Element,options:MouseEventInit={}){await act(async()=>pointer(type,p,target,options))}
async function hit(p:{x:number;y:number},options:MouseEventInit={}){await at('pointerdown',p,undefined,options);await at('pointerup',p,undefined,options)}
function key(k:string,options:KeyboardEventInit={},target:EventTarget=host()){const e=new KeyboardEvent('keydown',{key:k,code:k.length===1?`Key${k.toUpperCase()}`:k,bubbles:true,cancelable:true,...options});target.dispatchEvent(e);return e}
async function shortcut(command:ShortcutAction){host().focus();const context={profile:shortcutPreference.getSnapshot(),platform:'mac' as const,desktop:true};const binding=shortcutBindings(context).find(b=>b.command===command);expect(binding).toBeDefined();const parts=binding!.combo.split('+'),k=parts.pop()!;const e=new KeyboardEvent('keydown',{key:k.toLowerCase(),code:`Key${k.toUpperCase()}`,bubbles:true,cancelable:true,metaKey:parts.includes('Meta')||parts.includes('Mod'),ctrlKey:parts.includes('Ctrl'),shiftKey:parts.includes('Shift'),altKey:parts.includes('Alt')});expect(resolveShortcut(e,context)?.command).toBe(command);await act(async()=>{host().dispatchEvent(e);await microtasks()});expect(e.defaultPrevented).toBe(true)}
async function layer(id:string,toggle=false){const row=mount.querySelector<HTMLElement>(`[data-testid="layer-${id}"]`);expect(row).not.toBeNull();await act(async()=>{row!.dispatchEvent(new MouseEvent('click',{bubbles:true,metaKey:toggle}));await microtasks()});expect(document.activeElement).toBe(host())}
async function menu(label:string){host().focus();await act(async()=>key('ContextMenu'));const b=document.querySelector<HTMLButtonElement>(`[role="menuitem"][aria-label="${label}"]`);expect(b).not.toBeNull();expect(b!.disabled).toBe(false);await act(async()=>{b!.click();await microtasks()});expect(document.querySelector('[role="menu"]')).toBeNull()}
async function edit(label:string,value:string){const f=mount.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);expect(f).not.toBeNull();await act(async()=>{f!.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(f,value);f!.dispatchEvent(new Event('input',{bubbles:true}))});expect(document.activeElement).toBe(f);await act(async()=>{key('Enter',{},f!);await microtasks()});expect(document.activeElement).not.toBe(f)}
async function drag(from:{x:number;y:number},to:{x:number;y:number}){await at('pointerdown',from);await at('pointermove',{x:(from.x+to.x)/2,y:(from.y+to.y)/2});await at('pointerup',to)}
function closeMatrix(actual:readonly number[],expected:readonly number[]){expect(actual).toHaveLength(6);expected.forEach((v,i)=>expect(actual[i]).toBeCloseTo(v,8))}
function turn(p:{x:number;y:number},center:{x:number;y:number},angle:number){const a=angle*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return{x:center.x+c*(p.x-center.x)-s*(p.y-center.y),y:center.y+s*(p.x-center.x)+c*(p.y-center.y)}}
async function rotate(center:{x:number;y:number},finish:'commit'|'cancel'='commit'){const h=mount.querySelector('[data-testid="rotate-corner-1"]');expect(h).not.toBeNull();const from={x:Number(h!.getAttribute('data-anchor-x')),y:Number(h!.getAttribute('data-anchor-y'))},to=turn(from,center,-30);await at('pointerdown',from,h!);await at('pointermove',to);if(finish==='cancel')await act(async()=>key('Escape'));else await at('pointerup',to)}
async function perform(name:string,fn:()=>Promise<void>){const before=editor.state.doc,selectionBefore=[...editor.state.selection],pageBefore=editor.state.page,version=editor.state.version;await fn();expect(editor.state.doc,`${name} must author exactly one operation`).not.toEqual(before);expect(editor.state.version).toBe(version+1);expect(editor.interactionActive).toBe(false);steps.push({name,before,after:editor.state.doc,selectionBefore,selectionAfter:[...editor.state.selection],pageBefore,pageAfter:editor.state.page})}
async function replayAll(){const finalSelection=[...editor.state.selection],finalPage=editor.state.page;for(let i=steps.length-1;i>=0;i--){await shortcut('undo');expect(editor.state.doc,`Undo ${steps[i].name}`).toEqual(steps[i].before);expect(editor.state.selection).toEqual(steps[i].selectionBefore);expect(editor.state.page).toBe(steps[i].pageBefore);expect(document.activeElement).toBe(host())}expect(editor.canUndo).toBe(false);for(let i=0;i<steps.length;i++){await shortcut('redo');expect(editor.state.doc,`Redo ${steps[i].name}`).toEqual(steps[i].after);expect(editor.state.selection).toEqual(i+1<steps.length?steps[i+1].selectionBefore:finalSelection);expect(document.activeElement).toBe(host())}expect(editor.state.page).toBe(finalPage);expect(editor.canRedo).toBe(false)}
async function persist(){const expected=editor.state.doc,selection=[...editor.state.selection];const session=new DesktopSession(bridge,editor,async()=> 'discard');let dir:string|undefined;try{await act(async()=>{await session.start();expect(await session.save()).toBe(true)});expect(saveDocument).toHaveBeenCalledTimes(1);const payload=saveDocument.mock.calls[0][0] as {documentJson:string};expect(JSON.parse(payload.documentJson)).toEqual(expected);const bytes=encodeDocumentBinary(JSON.parse(payload.documentJson));expect(bytes.byteLength).toBeGreaterThan(32);dir=mkdtempSync(join(tmpdir(),'chain-fd-'));const path=join(dir,'chain.fd');writeFileSync(path,bytes);const disk=readFileSync(path);expect([...disk]).toEqual([...bytes]);const restored=decodeDocumentBinary(new Uint8Array(disk));expect(restored).toEqual(expected);const reopened=new Editor(restored as DesignDocument);try{expect(reopened.state.doc).toEqual(expected);expect(reopened.canUndo).toBe(false);expect(reopened.canRedo).toBe(false);expect(reopened.state.selection).toEqual([])}finally{reopened.dispose()}expect(editor.state.selection).toEqual(selection);expect(editor.state.doc).toEqual(expected)}finally{session.dispose();if(dir)rmSync(dir,{recursive:true,force:true})}}

const CHAIN_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
test('C04 cross-parent group refusal then actual move-page resource copy paste and page-aware Undo/Redo FD reopen',async()=>{
 const pa=node('frame',150,100,300,250),pb=node('frame',600,200,250,250),a=node('rectangle',20,30,80,60),b=node('rectangle',40,50,70,40),sentinel=node('rectangle',800,500,20,20)
 pa.transform=[0,1,-1,0,400,100];pb.transform=[Math.cos(Math.PI/6),-.5,.5,Math.cos(Math.PI/6),600,200];pa.children=[a.id];pb.children=[b.id];a.name='Image source';b.name='Solid source';a.fills=[{...paint('#112233','image'),image:CHAIN_PNG,fit:'contain'}];b.fills=[paint('#abcdef')]
 const initial=await fixture([pa,pb,a,b,sentinel],[pa.id,pb.id],1,[sentinel.id]);const sourcePage=editor.state.page,target=initial.pages[1]
 await layer(a.id);await layer(b.id,true);expect([...editor.state.selection].sort()).toEqual([a.id,b.id].sort())
 host().focus();await act(async()=>key('ContextMenu'));const group=document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="编组"]');expect(group).not.toBeNull();expect(group!.disabled).toBe(true);await act(async()=>key('Escape',{},document.querySelector('[role="menu"]')!))
 const version=editor.state.version,selection=[...editor.state.selection];await shortcut('group');expect(editor.state.doc).toEqual(initial);expect(editor.state.version).toBe(version);expect(editor.state.selection).toEqual(selection);expect(editor.canUndo).toBe(false)
 await perform('explicit move to other page',async()=>{host().focus();await act(async()=>key('ContextMenu'));const picker=document.querySelector<HTMLButtonElement>('[data-page-picker="true"]');expect(picker).not.toBeNull();await act(async()=>picker!.click());const destination=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(e=>e.textContent===target.name);expect(destination).toBeDefined();expect(destination!.disabled).toBe(false);await act(async()=>destination!.click())})
 const moved=editor.state.doc;expect(editor.state.page).toBe(sourcePage);expect(editor.state.selection).toEqual([]);expect(moved.nodes[pa.id].children).toEqual([]);expect(moved.nodes[pb.id].children).toEqual([]);expect(moved.pages[1].children).toEqual([sentinel.id,a.id,b.id]);for(const id of[a.id,b.id,sentinel.id])closeMatrix(worldMatrix(moved,id),worldMatrix(initial,id));expect(moved.nodes[a.id].fills[0].image).toBe(CHAIN_PNG)
 const pageButton=[...mount.querySelectorAll<HTMLButtonElement>('.pages button.page')].find(e=>e.querySelector('.page-name')?.textContent===target.name);expect(pageButton).toBeDefined();await act(async()=>pageButton!.click());expect(editor.state.page).toBe(target.id);expect(editor.state.doc).toBe(moved);await layer(a.id);await layer(b.id,true)
 await shortcut('copy');expect(writeClipboard).toHaveBeenCalledTimes(1);expect(editor.state.doc).toBe(moved);await perform('paste roots on destination page',async()=>shortcut('paste'));expect(readClipboard).toHaveBeenCalledTimes(1);expect(editor.state.selection).toHaveLength(2)
 const pasted=[...editor.state.selection];expect(pasted.map(id=>editor.state.doc.nodes[id].name).sort()).toEqual(['Image source','Solid source']);expect(pasted.every(id=>!initial.nodes[id])).toBe(true);expect(editor.state.doc.pages[1].children).toEqual([sentinel.id,a.id,b.id,...pasted]);for(const id of pasted){const clone=editor.state.doc.nodes[id],original=clone.name==='Image source'?a:b;expect(['Image source','Solid source']).toContain(clone.name);closeMatrix(worldMatrix(editor.state.doc,id),worldMatrix(moved,original.id));expect(clone.fills.map(p=>({kind:p.kind,color:p.color,image:p.image,fit:p.fit}))).toEqual(moved.nodes[original.id].fills.map(p=>({kind:p.kind,color:p.color,image:p.image,fit:p.fit})));expect(editor.parentMap(editor.state.doc).get(id)).toBe(target.id)}
 for(const id of[a.id,b.id,sentinel.id])expect(editor.state.doc.nodes[id]).toEqual(moved.nodes[id]);expect(editor.state.doc.pages[0]).toEqual(moved.pages[0]);await replayAll();await persist()
})
