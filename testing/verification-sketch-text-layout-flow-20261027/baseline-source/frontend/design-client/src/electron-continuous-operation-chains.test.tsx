// DRAFT_NOT_RUN: four bounded multi-operation chains, not arbitrary combinations.
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
import { blank, node, paint, type DesignDocument, type DesignNode } from './model'
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
type Step={name:string;before:DesignDocument;after:DesignDocument;selectionBefore:string[];selectionAfter:string[]}
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
async function fixture(nodes:DesignNode[],roots=nodes.map(n=>n.id),zoom=1){const d=blank('Bounded operation chain');d.schemaVersion=6;d.nodes=Object.fromEntries(nodes.map(n=>[n.id,n]));d.pages[0].children=roots;editor=new Editor(d);editor.set({view:{x:19,y:31,zoom},snap:false,snapPixels:false});await act(async()=>{root.render(<PendingEditContext.Provider value={editor}><Canvas editor={editor}/><Layers editor={editor}/><Inspector editor={editor}/></PendingEditContext.Provider>);await microtasks()});expect(listeners.size).toBe(1);host().focus();return editor.state.doc}
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
async function perform(name:string,fn:()=>Promise<void>){const before=editor.state.doc,selectionBefore=[...editor.state.selection],version=editor.state.version;await fn();expect(editor.state.doc,`${name} must author exactly one operation`).not.toEqual(before);expect(editor.state.version).toBe(version+1);expect(editor.interactionActive).toBe(false);steps.push({name,before,after:editor.state.doc,selectionBefore,selectionAfter:[...editor.state.selection]})}
async function replayAll(){const finalSelection=[...editor.state.selection];for(let i=steps.length-1;i>=0;i--){await shortcut('undo');expect(editor.state.doc,`Undo ${steps[i].name}`).toEqual(steps[i].before);expect(editor.state.selection).toEqual(steps[i].selectionBefore);expect(document.activeElement).toBe(host())}expect(editor.canUndo).toBe(false);for(let i=0;i<steps.length;i++){await shortcut('redo');expect(editor.state.doc,`Redo ${steps[i].name}`).toEqual(steps[i].after);expect(editor.state.selection).toEqual(i+1<steps.length?steps[i+1].selectionBefore:finalSelection);expect(document.activeElement).toBe(host())}expect(editor.canRedo).toBe(false)}
async function persist(){const expected=editor.state.doc,selection=[...editor.state.selection];const session=new DesktopSession(bridge,editor,async()=> 'discard');let dir:string|undefined;try{await act(async()=>{await session.start();expect(await session.save()).toBe(true)});expect(saveDocument).toHaveBeenCalledTimes(1);const payload=saveDocument.mock.calls[0][0] as {documentJson:string};expect(JSON.parse(payload.documentJson)).toEqual(expected);const bytes=encodeDocumentBinary(JSON.parse(payload.documentJson));expect(bytes.byteLength).toBeGreaterThan(32);dir=mkdtempSync(join(tmpdir(),'chain-fd-'));const path=join(dir,'chain.fd');writeFileSync(path,bytes);const disk=readFileSync(path);expect([...disk]).toEqual([...bytes]);const restored=decodeDocumentBinary(new Uint8Array(disk));expect(restored).toEqual(expected);const reopened=new Editor(restored as DesignDocument);try{expect(reopened.state.doc).toEqual(expected);expect(reopened.canUndo).toBe(false);expect(reopened.canRedo).toBe(false);expect(reopened.state.selection).toEqual([])}finally{reopened.dispose()}expect(editor.state.selection).toEqual(selection);expect(editor.state.doc).toEqual(expected)}finally{session.dispose();if(dir)rmSync(dir,{recursive:true,force:true})}}

for(const zoom of[.5,2])test(`C01 chain select drag rotate width copy paste Undo/Redo FD reopen zoom${zoom}`,async()=>{
 const a=node('rectangle',100,100,100,60),other=node('rectangle',500,300,60,40);a.fills=[paint('#112233')];other.fills=[paint('#dd8844')];const initial=await fixture([a,other],undefined,zoom)
 await hit({x:130,y:125});expect(editor.state.selection).toEqual([a.id]);expect(editor.state.doc).toEqual(initial);expect(editor.canUndo).toBe(false)
 await perform('drag',async()=>drag({x:130,y:125},{x:170,y:150}));closeMatrix(editor.state.doc.nodes[a.id].transform,[1,0,0,1,140,125]);expect(editor.state.doc.nodes[other.id]).toEqual(initial.nodes[other.id])
 const c=Math.cos(Math.PI/6),center={x:190,y:155};await perform('rotate',async()=>rotate(center));closeMatrix(editor.state.doc.nodes[a.id].transform,[c,-.5,.5,c,center.x-c*50-.5*30,center.y+.5*50-c*30])
 const rotated=editor.state.doc.nodes[a.id];await perform('width',async()=>edit('W','140'));const resized=editor.state.doc.nodes[a.id];expect(resized.width).toBeCloseTo(140,8);expect(resized.height).toBe(60);closeMatrix(resized.transform,rotated.transform);expect(resized.fills).toEqual(a.fills)
 const beforeCopy=editor.state.doc,version=editor.state.version;await shortcut('copy');expect(writeClipboard).toHaveBeenCalledTimes(1);expect(clipboard.forma).toBeTypeOf('string');expect(editor.state.doc).toBe(beforeCopy);expect(editor.state.version).toBe(version)
 // Registered paste -> pasteToSelection(false); selected page-root rectangle has no container target, so paste(true) preserves world position. Direct paste(false) +24 is NOT this entry.
 await perform('paste',async()=>shortcut('paste'));expect(readClipboard).toHaveBeenCalledTimes(1);const copied=editor.state.selection[0];expect(copied).not.toBe(a.id);expect(editor.state.selection).toHaveLength(1);const clone=editor.state.doc.nodes[copied];closeMatrix(clone.transform,resized.transform);closeMatrix(worldMatrix(editor.state.doc,copied),worldMatrix(beforeCopy,a.id));expect(editor.state.doc.pages[0].children).toEqual([...beforeCopy.pages[0].children,copied]);expect(editor.parentMap(editor.state.doc).get(copied)).toBe(editor.state.page);expect(clone.width).toBeCloseTo(140,8);expect(clone.height).toBe(60);expect(clone.fills.map(p=>({color:p.color,opacity:p.opacity}))).toEqual(resized.fills.map(p=>({color:p.color,opacity:p.opacity})));expect(editor.state.doc.nodes[a.id]).toEqual(beforeCopy.nodes[a.id]);expect(editor.state.doc.nodes[other.id]).toEqual(initial.nodes[other.id]);expect(Object.keys(editor.state.doc.nodes)).toHaveLength(3)
 await replayAll();await persist()
})

test('C02 chain nested group child drag whole rotation ungroup and exact per-step history FD reopen',async()=>{
 const parent=node('frame',50,40,600,400),a=node('rectangle',100,100,80,60),middle=node('rectangle',250,100,30,30),b=node('rectangle',400,100,80,60);parent.children=[a.id,middle.id,b.id];const initial=await fixture([parent,a,middle,b],[parent.id])
 await layer(a.id);await layer(b.id,true);expect([...editor.state.selection].sort()).toEqual([a.id,b.id].sort());expect(editor.canUndo).toBe(false)
 await perform('group',async()=>menu('编组'));const group=editor.state.selection[0];expect(editor.state.doc.nodes[group].children).toEqual([a.id,b.id]);expect(editor.state.doc.nodes[parent.id].children).toEqual([group,middle.id]);for(const id of[a.id,b.id,middle.id])closeMatrix(worldMatrix(editor.state.doc,id),worldMatrix(initial,id))
 await layer(a.id);expect(editor.state.selection).toEqual([a.id]);await perform('child drag',async()=>drag({x:170,y:160},{x:190,y:170}));const am=worldMatrix(editor.state.doc,a.id);closeMatrix(am,[1,0,0,1,170,150]);closeMatrix(worldMatrix(editor.state.doc,b.id),[1,0,0,1,450,140]);expect(editor.state.doc.nodes[middle.id]).toEqual(initial.nodes[middle.id])
 await layer(group);expect(editor.state.selection).toEqual([group]);const beforeRotation=editor.state.doc;const center={x:(170+530)/2,y:(140+210)/2};await perform('group rotate',async()=>rotate(center))
 for(const id of[a.id,b.id]){const previous=worldMatrix(beforeRotation,id),actual=worldMatrix(editor.state.doc,id);const origin=turn({x:previous[4],y:previous[5]},center,-30);closeMatrix(actual,[Math.cos(Math.PI/6),-.5,.5,Math.cos(Math.PI/6),origin.x,origin.y])}
 const rotated=editor.state.doc;await perform('ungroup',async()=>menu('解除编组'));expect(editor.state.doc.nodes[group]).toBeUndefined();expect(editor.state.doc.nodes[parent.id].children).toEqual([a.id,b.id,middle.id]);for(const id of[a.id,b.id,middle.id])closeMatrix(worldMatrix(editor.state.doc,id),worldMatrix(rotated,id));expect(editor.state.doc.nodes[middle.id]).toEqual(initial.nodes[middle.id]);await replayAll();await persist()
})

test('C03 chain parent lock hide eligibility unlock show cancelled rotation then committed rotation Undo/Redo FD reopen',async()=>{
 const parent=node('group',100,100,100,80),child=node('rectangle',10,10,80,60),other=node('rectangle',500,300,60,40);parent.children=[child.id];const initial=await fixture([parent,child,other],[parent.id,other.id]);await layer(parent.id)
 await perform('lock parent',async()=>menu('锁定图层'));const locked=editor.state.doc;expect(locked.nodes[parent.id].locked).toBe(true);await hit({x:140,y:135},{metaKey:true});expect(editor.state.selection).toEqual([]);expect(editor.state.doc).toEqual(locked)
 await layer(child.id);await perform('unlock ancestry',async()=>menu('解锁图层及父级'));expect(editor.state.doc.nodes[parent.id].locked).toBe(false)
 await layer(parent.id);await perform('hide parent',async()=>menu('隐藏图层'));const hidden=editor.state.doc;await hit({x:140,y:135},{metaKey:true});expect(editor.state.selection).toEqual([]);expect(editor.state.doc).toEqual(hidden)
 await layer(parent.id);await perform('show parent',async()=>menu('显示图层'));await hit({x:140,y:135},{metaKey:true});expect(editor.state.selection).toEqual([child.id]);const ready=editor.state.doc,version=editor.state.version
 await rotate({x:150,y:140},'cancel');expect(editor.state.doc).toEqual(ready);expect(editor.state.version).toBe(version);expect(editor.interactionActive).toBe(false);expect(editor.state.selection).toEqual([child.id])
 await perform('child rotate',async()=>rotate({x:150,y:140}));const c=Math.cos(Math.PI/6);closeMatrix(worldMatrix(editor.state.doc,child.id),[c,-.5,.5,c,150-c*40-.5*30,140+.5*40-c*30]);expect(editor.state.doc.nodes[other.id]).toEqual(initial.nodes[other.id]);expect(editor.state.doc.nodes[parent.id].locked).toBe(false);expect(editor.state.doc.nodes[parent.id].visible).toBe(true)
 await replayAll();await persist()
})
