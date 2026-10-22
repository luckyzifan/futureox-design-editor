// DRAFT_NOT_RUN C08: mounted properties -> real scoped NDJSON -> UI history -> FD save/reopen.
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

import { PassThrough } from 'node:stream'
import { createEditorDesignAutomation } from './automation/index'
import type { AutomationResponse } from './automation/types'
import { OperationBackend } from '../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../design-mcp/src/server.mjs'
type Json=Record<string,any>
async function connectRpc() {
  const scope='write'
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request), scope })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', id = 0
  const pending = new Map<number, (message: Json) => void>()
  output.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, newline)) as Json
      buffer = buffer.slice(newline + 1)
      const resolve = pending.get(response.id)
      pending.delete(response.id)
      if (resolve) resolve(response)
    }
  })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  const close=async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose() }
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP request ${requestId} timed out`)) }, 20000)
    server.done.then(() => { if (pending.delete(requestId)) { clearTimeout(timer); reject(new Error('MCP connection closed before response')) } })
    pending.set(requestId, response => { clearTimeout(timer); resolve(response) })
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'real-editor-e2e', version: '1' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools as { name: string }[]
  const toolName = (method: string) => `design_${method.replaceAll('.', '_')}`
  const call = async (method: string, params: Json = {}, fences: Json = {}) => {
    expect(tools.some(tool => tool.name === toolName(method))).toBe(true)
    const response = await rpc('tools/call', { name: toolName(method), arguments: { params, ...fences } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    return response.result as Json
  }
  // Explicit file-saving client behavior; model-facing tools/call remains metadata-only.
  const materialize = async (value: Json) => {
    const result = { ...value.result }
    for (const ref of result.resources ?? []) {
      const response = await rpc('resources/read', { uri: ref.uri })
      expect(response.error).toBeUndefined()
      const content = response.result.contents[0]
      const data = ref.encoding === 'json' ? JSON.parse(content.text) : ref.encoding === 'base64' ? content.blob : ref.encoding === 'data-url' ? `data:${ref.mimeType};base64,${content.blob}` : content.text
      if (ref.field === '$metadata') Object.assign(result, data)
      else result[ref.field] = data
    }
    return { ...value, result } as AutomationResponse & { result: Json }
  }
  const read = async (method: string, params: Json = {}) => {
    const response = await call(method, params)
    expect(response.isError, response.structuredContent.ok ? undefined : JSON.stringify(response.structuredContent.error)).toBe(false)
    return materialize(response.structuredContent)
  }
  const mutate = async (method: string, params: Json = {}) => {
    const state = await read('document.get')
    return call(method, params, { documentId: state.documentId, session: state.session, expectedRevision: state.revision })
  }
  return { editor, api, rpc, call, read, mutate, tools, materialize, close }
}

async function rawDraft(field:HTMLInputElement,value:string){await act(async()=>{field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}))})}
test('C08 mounted preview and invalid property reject actual NDJSON writes, corrected UI plus replay-safe MCP edit Undo/Redo save FD reopen',async()=>{
 const n=node('rectangle',100,100,100,60),other=node('rectangle',400,100,60,40);n.fills=[paint('#123456')];const initial=await fixture([n,other]);await hit({x:130,y:125});expect(editor.state.selection).toEqual([n.id]);const rpc=await connectRpc()
 try{
  const trigger=mount.querySelector<HTMLButtonElement>('.paint-editor button[aria-label="颜色"]');expect(trigger).not.toBeNull();await act(async()=>trigger!.click());const color=document.querySelector<HTMLInputElement>('input[aria-label="填充颜色值"]');expect(color).not.toBeNull();await rawDraft(color!,'#abcdef');expect(editor.state.doc.nodes[n.id].fills[0].color).toBe('#abcdef');expect(editor.authoredDocument).toBe(initial);expect(editor.state.version).toBe(0)
  let observed:Awaited<ReturnType<typeof rpc.read>>;await act(async()=>{observed=await rpc.read('document.get',{includeNodes:true,includeFonts:true})});expect(observed!.result.nodes[n.id].fills[0].color).toBe('#123456');expect(editor.propertyPreviewActive).toBe(true);expect(document.activeElement).toBe(color)
  let blocked:Json;await act(async()=>{blocked=await rpc.mutate('node.update',{ids:[n.id],patch:{opacity:.4}})});expect(blocked!.isError).toBe(true);expect(blocked!.structuredContent.error.code).toBe('interaction_active');expect(editor.authoredDocument).toBe(initial);expect(editor.state.version).toBe(0);expect(document.activeElement).toBe(color)
  await act(async()=>key('Escape',{},color!));expect(editor.state.doc).toEqual(initial);expect(editor.propertyPreviewActive).toBe(false)
  const width=mount.querySelector<HTMLInputElement>('input[aria-label="W"]');expect(width).not.toBeNull();await rawDraft(width!,'invalid');await act(async()=>{blocked=await rpc.mutate('node.update',{ids:[n.id],patch:{opacity:.4}})});expect(blocked!.isError).toBe(true);expect(blocked!.structuredContent.error.code).toBe('pending_edits');expect(editor.state.doc).toEqual(initial);expect(editor.state.version).toBe(0);expect(document.activeElement).toBe(width);expect(width!.value).toBe('invalid')
  await perform('correct UI width',async()=>edit('W','150'));const resized=editor.state.doc;expect(resized.nodes[n.id].width).toBe(150);expect(resized.nodes[n.id].fills[0].color).toBe('#123456')
  const state=await rpc.read('document.get'),fences={documentId:state.documentId,session:state.session,expectedRevision:state.revision},request={mutationId:'c08-ui-mcp-once',operations:[{method:'node.update',params:{ids:[n.id],patch:{opacity:.4}}}]}
  await perform('scoped MCP opacity',async()=>{await act(async()=>{const response=await rpc.call('batch.apply',request,fences);expect(response.isError,JSON.stringify(response)).toBe(false);expect(response.structuredContent.result.receipt.replayed).toBe(false)})});const final=editor.state.doc,revision=editor.state.version;expect(final.nodes[n.id].opacity).toBe(.4);expect(final.nodes[other.id]).toEqual(initial.nodes[other.id]);expect(editor.state.selection).toEqual([n.id])
  await act(async()=>{const replay=await rpc.call('batch.apply',request,fences);expect(replay.isError).toBe(false);expect(replay.structuredContent.result.receipt.replayed).toBe(true)});expect(editor.state.doc).toEqual(final);expect(editor.state.version).toBe(revision)
  await act(async()=>{const stale=await rpc.call('node.update',{ids:[n.id],patch:{visible:false}},fences);expect(stale.isError).toBe(true);expect(stale.structuredContent.error.code).toBe('stale_revision')});expect(editor.state.doc).toEqual(final);expect(editor.state.version).toBe(revision)
  const readback=await rpc.read('document.get',{includeNodes:true,includeFonts:true});expect(readback.result.nodes).toEqual(final.nodes);await replayAll();await persist()
 }finally{await rpc.close()}
})
