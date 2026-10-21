// DOM is scoped per test so the shared Node/WASM test setup retains file URLs.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { ResidentCompositeSurface } from './ResidentCompositeSurface'
// Exercise the production component's React layout effects and release calls;
// no GPU/device timing is claimed. Only unrelated interaction/content services
// and the worker transport are controlled.
const interactionState = vi.hoisted(() => ({ tiles: [] as any[] }))
vi.mock('./resident-presentation', () => ({ ResidentPresentation: class { stage() { return undefined } resolve() {} snapshotResolver() { return () => undefined } } }))
vi.mock('./content-plane', () => ({ registerContentPlane: () => () => {} }))
vi.mock('./interaction-renderer', () => ({ InteractionRenderer: class {
  get tiles() { return interactionState.tiles }
  ready=false; lastSampleMs=0; lastSampleCompileMs=0; lastSampleGraphMs=0; lastSampleCheckpointMs=0
  dispose() {} prepare() {} items() { return null }
} }))
vi.mock('./page-translation', () => ({ PageTranslation: class { tiles=[]; prepare() { return false } clear() {} } }))
const roots: ReturnType<typeof createRoot>[] = []
let dom: any
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event'])
    vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
})
afterEach(async () => { for (const root of roots) await act(async () => root.unmount()); roots.length=0; interactionState.tiles=[]; dom.window.close(); vi.unstubAllGlobals() })
function harness() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  HTMLCanvasElement.prototype.transferControlToOffscreen = vi.fn(() => ({} as OffscreenCanvas))
  const node=document.createElement('div'); document.body.append(node)
  const root=createRoot(node); roots.push(root)
  const client={ attachPresentation:vi.fn(), present:vi.fn(), releasePresented:vi.fn(), presentationDiagnosticsEnabled:()=>false }
  const props={ client, items:[], view:{x:0,y:0,zoom:1},width:100,height:100,dpr:1,pageId:'A',rasterProfile:'exact',backend:'webgpu',sourceDocument:{},translationItems:[],allowPageTranslation:false,onReady:vi.fn(),onGone:vi.fn(),onFailure:vi.fn(),presentation:null }
  return { client, props, async unmount() { await act(async () => root.unmount()); roots.splice(roots.indexOf(root),1) }, async render(items:any[]) { await act(async () => root.render(<ResidentCompositeSurface {...props as any} items={items} />)) } }
}
const item=(serial:number,gpuTile:number)=>({tile:{serial,gpuTile,key:`tile-${serial}`,x:0,y:0,width:10,height:10,zoom:1,bytes:new Uint8Array()},active:true,layer:0})
const retired=(client:any)=>client.releasePresented.mock.calls.flatMap(([ids]:[number[]])=>ids)
test('required-frame budget rejection reaches explicit surface failure and existing fallback, not silent consumption', async()=>{
  const h=harness(),failures:string[]=[],onRenderFailure=vi.fn(),onFallback=vi.fn()
  const surface=readFileSync(new URL('./ProgressiveSurface.tsx',import.meta.url),'utf8')
  const body=surface.match(/onFailure=\{message => \{([\s\S]*?)\}\}/)![1]
    .replaceAll('import.meta.env.DEV','false').replaceAll('import.meta.env.VITE_DESIGN_TRACE_PASSES','undefined')
  const previewDevice={current:{client:h.client,key:'old-device'}},client={current:h.client}
  const forward=new Function('message','renderDiagnosticError','recordRenderDiagnostic','requestedView','dpr','setFailure','props','residentDisplay','backend','previewDevice','client',body)
  h.props.onFailure=vi.fn((message:string)=>forward(message,()=>1,()=>{}, {zoom:1},1,(value:string)=>failures.push(value),{onRenderFailure,onFallback},true,'webgpu',previewDevice,client))
  await h.render([item(1,77)])
  const worker=readFileSync(new URL('./render-worker.ts',import.meta.url),'utf8')
  const handler=worker.slice(worker.indexOf('displayTasks.port1.onmessage=()=>{'),worker.indexOf('\nconst navigationJournal'))
  const error=Error('GPU display resident budget exceeded (required payload cannot fit)'),present=vi.fn(()=>{throw error})
  const run=new Function('gpu','reportDisplay',`let displayFramePending=true, displayFrame={}, displayTasks={port1:{}};${handler};return displayTasks.port1.onmessage`)
    ({driver:{presentFrame:present}},(presentation:unknown)=>(h.client as any).onPresentation(presentation))
  await act(async()=>run())
  expect(present).toHaveBeenCalledOnce();expect(failures).toEqual([String(error)])
  expect(onRenderFailure).toHaveBeenCalledOnce();expect(onFallback).toHaveBeenCalledExactlyOnceWith(`PREVIEW_CPU_FALLBACK: ${error}`)
  expect(previewDevice.current).toEqual({client:h.client})
  // The existing status renders this same failure string when fallback is not selected.
  expect(surface).toContain("className={`kernel-status ${failure ? 'error' : ''}`}")
  expect(surface).toContain("title={failure || '画布高清显示'}")
})
test('failed explicit bitmap transport closes the produced output and reports failure', async()=>{
  const worker=readFileSync(new URL('./render-worker.ts',import.meta.url),'utf8')
  const block=worker.slice(worker.indexOf("if(request.command==='display-read-pixel'||request.command==='display-capture-content'){"),worker.indexOf("  if(request.command==='interaction-pose'){"))
  const close=vi.fn(),bitmap={close},messages:any[]=[],request={id:74,command:'display-capture-content'}
  const self={postMessage(message:any){if(message.bitmap)throw Error('synthetic transport failure');messages.push(message)}}
  new Function('request','gpu','self',block)(request,{driver:{captureContentBitmap:async()=>({bitmap,contentFrame:{}})}},self)
  await Promise.resolve();await Promise.resolve()
  expect(close).toHaveBeenCalledOnce();expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({id:74,error:'Error: synthetic transport failure'})
  expect(messages[0]).not.toHaveProperty('bitmap')
})
