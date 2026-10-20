// DOM is scoped per test so the shared Node/WASM test setup retains file URLs.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
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
test('removing one serial must retain a GPU handle referenced by another live serial',async()=>{
  const h=harness(), a=item(1,77), b=item(2,77)
  await h.render([a,b]); h.client.releasePresented.mockClear()
  await h.render([b])
  expect(h.props.onFailure).not.toHaveBeenCalled()
  expect(retired(h.client)).not.toContain(77)
  expect(h.client.present.mock.calls.at(-1)![0].items[0].tile.gpuTile).toBe(77)
})
test('removing both aliased serials retires their handle exactly once',async()=>{
  const h=harness(), a=item(1,77), b=item(2,77)
  await h.render([a,b]); h.client.releasePresented.mockClear()
  await h.render([])
  expect(retired(h.client)).toEqual([77])
})
test('ordinary page retention preserves original object serial through A to B to A',async()=>{
  const h=harness(), a=item(1,77), b=item(2,88)
  await h.render([a]); h.client.releasePresented.mockClear()
  await h.render([{...a,active:false},b]); await h.render([a,{...b,active:false}])
  expect(retired(h.client)).toEqual([])
})

test('replacing the current page serial without changing its handle does not destroy the replacement',async()=>{
  const h=harness(), a=item(1,77), b=item(2,77)
  await h.render([a]); h.client.releasePresented.mockClear()
  await h.render([b]); expect(retired(h.client)).toEqual([])
  await h.unmount(); expect(retired(h.client)).toEqual([])
})
test('retirement occurs exactly once when the final aliased owner leaves',async()=>{
  const h=harness(), a=item(1,77), b=item(2,77)
  await h.render([a,b]); h.client.releasePresented.mockClear()
  await h.render([b]); expect(retired(h.client)).toEqual([])
  await h.render([]); expect(retired(h.client)).toEqual([77])
})
test('an interaction alias leaving cannot retire a retained page handle',async()=>{
  const h=harness(), a=item(1,77), moving=item(-1,77)
  interactionState.tiles=[moving.tile]
  await h.render([a]); h.client.releasePresented.mockClear()
  interactionState.tiles=[]; await h.render([a]); expect(retired(h.client)).toEqual([])
  await h.render([]); expect(retired(h.client)).toEqual([77])
})
test('a page alias leaving cannot retire a still retained interaction handle',async()=>{
  const h=harness(), a=item(1,77), moving=item(-1,77)
  interactionState.tiles=[moving.tile]
  await h.render([a]); h.client.releasePresented.mockClear()
  await h.render([]); expect(retired(h.client)).toEqual([])
  interactionState.tiles=[]; await h.render([]); expect(retired(h.client)).toEqual([77])
})
test('unmount retains parent page handles and retires unowned interaction aliases once',async()=>{
  const h=harness(), a=item(1,77)
  interactionState.tiles=[item(-1,77).tile,item(-2,88).tile,item(-3,88).tile]
  await h.render([a]); h.client.releasePresented.mockClear()
  await h.unmount(); expect(retired(h.client)).toEqual([88])
})
