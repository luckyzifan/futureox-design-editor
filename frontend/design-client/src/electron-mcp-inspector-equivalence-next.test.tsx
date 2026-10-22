// DRAFT_NOT_RUN B01-B04: real scoped NDJSON -> mounted panels/selection and bounded UI equivalence.
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
import { blank, node, paint, defaultTextStyle, type DesignDocument, type DesignNode } from './model'
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

function outlinePoints(){const e=mount.querySelector('[data-testid="canvas-selection-outline"]');expect(e).not.toBeNull();return e!.getAttribute('points')!.trim().split(/\s+/).map(v=>v.split(',').map(Number))}
function assertOutline(expected:number[][]){const actual=outlinePoints();expect(actual).toHaveLength(expected.length);for(const p of expected)expect(actual.some(q=>Math.abs(q[0]-p[0])<1e-8&&Math.abs(q[1]-p[1])<1e-8)).toBe(true)}
function widthHeight(w:number,h:number){expect(Number(mount.querySelector<HTMLInputElement>('input[aria-label="W"]')!.value)).toBeCloseTo(w,8);expect(Number(mount.querySelector<HTMLInputElement>('input[aria-label="H"]')!.value)).toBeCloseTo(h,8)}
async function writeRpc(rpc:Awaited<ReturnType<typeof connectRpc>>,method:string,params:Json){await act(async()=>{const result=await rpc.mutate(method,params);expect(result.isError,JSON.stringify(result)).toBe(false);await microtasks()})}
async function uiHistory(before:DesignDocument,after:DesignDocument){await shortcut('undo');expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false);await shortcut('redo');expect(editor.state.doc).toEqual(after);expect(editor.canRedo).toBe(false)}
async function buttonText(text:string){const b=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===text);expect(b).toBeDefined();expect(b!.disabled).toBe(false);await act(async()=>{b!.click();await microtasks()})}
for(const zoom of [.5,2])test(`B01 MCP selected rotated-parent child transform/name updates actual outline Inspector Layers then UI history zoom ${zoom}`,async()=>{
 const p=node('frame',400,100,300,300),n=node('rectangle',20,30,80,40),other=node('rectangle',160,160,30,30);p.transform=[0,1,-1,0,400,100];p.children=[n.id,other.id];n.name='Before RPC';await fixture([p,n,other],[p.id],zoom);await layer(n.id);const before=editor.state.doc;expect(editor.state.selection).toEqual([n.id]);assertOutline([[370,120],[370,200],[330,200],[330,120]]);widthHeight(80,40)
 const rpc=await connectRpc();try{
  await writeRpc(rpc,'node.update',{ids:[n.id],patch:{name:'Renamed over NDJSON',transform:[1,0,0,1,45,55]}});const after=editor.state.doc;expect(editor.state.version).toBe(1);expect(editor.state.selection).toEqual([n.id]);expect(after.nodes[n.id].transform).toEqual([1,0,0,1,45,55]);expect(after.nodes[p.id]).toEqual(before.nodes[p.id]);expect(after.nodes[other.id]).toEqual(before.nodes[other.id]);assertOutline([[345,145],[345,225],[305,225],[305,145]]);widthHeight(80,40);expect(mount.querySelector(`[data-testid="layer-${n.id}"]`)!.getAttribute('aria-label')).toBe('Renamed over NDJSON')
  const read=await rpc.read('document.get',{includeNodes:true});expect(read.result.nodes).toEqual(after.nodes);await uiHistory(before,after);assertOutline([[345,145],[345,225],[305,225],[305,145]]);expect(editor.state.selection).toEqual([n.id]);await persist()
 }finally{await rpc.close()}
})
test('B02 MCP deletion of one selected member reconciles selection outline single Inspector and Layers with UI undo redo',async()=>{
 const a=node('rectangle',100,100,80,40),b=node('rectangle',300,100,60,50);await fixture([a,b]);await layer(a.id);await layer(b.id,true);expect(new Set(editor.state.selection)).toEqual(new Set([a.id,b.id]));const before=editor.state.doc,rpc=await connectRpc();try{
  await writeRpc(rpc,'node.delete',{ids:[b.id]});const after=editor.state.doc;expect(editor.state.version).toBe(1);expect(after.nodes[b.id]).toBeUndefined();expect(after.nodes[a.id]).toEqual(before.nodes[a.id]);expect(editor.state.selection).toEqual([a.id]);expect(mount.querySelector(`[data-testid="layer-${b.id}"]`)).toBeNull();widthHeight(80,40);assertOutline([[100,100],[180,100],[180,140],[100,140]])
  await shortcut('undo');expect(editor.state.doc).toEqual(before);expect(new Set(editor.state.selection)).toEqual(new Set([a.id,b.id]));expect(mount.querySelector(`[data-testid="layer-${b.id}"]`)).not.toBeNull();expect(editor.canUndo).toBe(false);await shortcut('redo');expect(editor.state.doc).toEqual(after);expect(editor.state.selection).toEqual([a.id]);widthHeight(80,40);assertOutline([[100,100],[180,100],[180,140],[100,140]]);await persist()
 }finally{await rpc.close()}
})
test('B03 actual second-fill color alpha Apply and NDJSON paint.patch author identical graph each one undo step',async()=>{
 const n=node('rectangle',100,100,100,60),other=node('rectangle',400,100,40,40);n.fills=[paint('#112233'),paint('#445566')];n.fills[0].opacity=.8;n.fills[1].opacity=.6;n.opacity=.75;await fixture([n,other]);await layer(n.id);const before=editor.state.doc,rpc=await connectRpc();try{
  const cards=[...mount.querySelectorAll<HTMLElement>('.property-card')].filter(x=>x.querySelector('.paint-editor'));expect(cards).toHaveLength(2);const trigger=cards[1].querySelector<HTMLButtonElement>('button[aria-label="颜色"]');expect(trigger).not.toBeNull();await act(async()=>trigger!.click());await rawDraft(document.querySelector<HTMLInputElement>('input[aria-label="填充颜色值"]')!,'#abcdef');await rawDraft(document.querySelector<HTMLInputElement>('input[aria-label="填充不透明度 %"]')!,'25');expect(editor.authoredDocument).toBe(before);expect(editor.state.version).toBe(0);await buttonText('应用');const ui=editor.state.doc;expect(editor.state.version).toBe(1);expect(ui.nodes[n.id].fills[1]).toMatchObject({id:n.fills[1].id,color:'#abcdef',opacity:.25});expect(ui.nodes[n.id].fills[0]).toEqual(before.nodes[n.id].fills[0]);expect(ui.nodes[n.id].opacity).toBe(.75);expect(ui.nodes[other.id]).toEqual(before.nodes[other.id]);await shortcut('undo');expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
  const version=editor.state.version;await writeRpc(rpc,'paint.patch',{ids:[n.id],target:'fill',paintId:n.fills[1].id,patch:{color:'#abcdef',opacity:.25}});expect(editor.state.version).toBe(version+1);expect(editor.state.doc).toEqual(ui);expect(editor.canRedo).toBe(false);expect(editor.state.selection).toEqual([n.id]);await uiHistory(before,ui);await persist()
 }finally{await rpc.close()}
})
test('B04 actual Canvas text menu editor Complete and NDJSON text.set agree for plain no-run replacement with UI history',async()=>{
 const n=node('text',100,100,240,60),other=node('rectangle',450,100,40,40);n.text='Plain before';n.fontSize=20;n.textStyle=defaultTextStyle();n.textRuns=[];await fixture([n,other]);await layer(n.id);const before=editor.state.doc,rpc=await connectRpc();try{
  host().focus();await act(async()=>key('ContextMenu'));const editItem=[...document.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]')].find(b=>b.textContent?.trim()==='编辑文字');expect(editItem).toBeDefined();expect(editItem!.disabled).toBe(false);await act(async()=>{editItem!.click();await microtasks()});expect(document.querySelector('[role="menu"]')).toBeNull();const area=mount.querySelector<HTMLTextAreaElement>('textarea[aria-label="画布文字编辑"]');expect(area).not.toBeNull();await act(async()=>{area!.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(area,'Shared plain text');area!.dispatchEvent(new Event('input',{bubbles:true}));await microtasks()});expect(area!.value).toBe('Shared plain text');await buttonText('完成');const ui=editor.state.doc;expect(ui.nodes[n.id].text).toBe('Shared plain text');expect(ui.nodes[n.id].textRuns).toEqual([]);expect(ui.nodes[n.id].textStyle).toEqual(before.nodes[n.id].textStyle);expect(ui.nodes[other.id]).toEqual(before.nodes[other.id]);expect(editor.state.version).toBe(1);expect(mount.querySelector('textarea[aria-label="画布文字编辑"]')).toBeNull();await shortcut('undo');expect(editor.state.doc).toEqual(before);expect(editor.canUndo).toBe(false)
  const version=editor.state.version;await writeRpc(rpc,'text.set',{ids:[n.id],text:'Shared plain text'});expect(editor.state.version).toBe(version+1);expect(editor.state.doc).toEqual(ui);expect(editor.canRedo).toBe(false);expect(editor.state.selection).toEqual([n.id]);await uiHistory(before,ui);await persist()
 }finally{await rpc.close()}
})
