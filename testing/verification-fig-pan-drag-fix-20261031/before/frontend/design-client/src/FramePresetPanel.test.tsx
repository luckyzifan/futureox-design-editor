// Real React input events and real Editor/WASM transactions. Not browser-pixel or Electron evidence.
// @ts-expect-error jsdom is a test-only dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach,beforeEach,expect,test,vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { FramePresetPanel } from './FramePresetPanel'
let root:Root,dom:any,editor:Editor,mount:HTMLElement,closed:ReturnType<typeof vi.fn<() => void>>
beforeEach(async()=>{
  dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
  for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','Event','KeyboardEvent'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const {createRoot}=await import('react-dom/client');mount=document.createElement('div');document.body.append(mount);root=createRoot(mount);editor=new Editor(blank());closed=vi.fn()
  await act(async()=>root.render(<FramePresetPanel editor={editor} onClose={closed}/>))
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.unstubAllGlobals()})
const input=(label:string)=>document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!
async function fill(label:string,value:string){await act(async()=>{const el=input(label);Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})}
const presets=()=>[...document.querySelectorAll<HTMLButtonElement>('.frame-preset-list button')]
test('search + category + orientation lead to actual named selected frame and undo',async()=>{
  expect(document.activeElement).toBe(input('搜索画板预设'));expect(mount.hasAttribute('inert')).toBe(true)
  await fill('搜索画板预设','iPhone 13 / 13 Pro');expect(presets()).toHaveLength(1)
  await act(async()=>document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());expect(presets()[0].textContent).toContain('844 × 390')
  await act(async()=>presets()[0].click());expect(closed).toHaveBeenCalledTimes(1)
  const frame=editor.state.doc.nodes[editor.state.selection[0]];expect(frame).toMatchObject({kind:'frame',name:'iPhone 13 / 13 Pro',width:844,height:390})
  editor.undo();expect(editor.state.doc.pages[0].children).toEqual([])
})
test('custom inputs create exact editable dimensions; invalid size is disabled',async()=>{
  await fill('自定义画板宽','0');expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
  await fill('自定义画板宽','512');await fill('自定义画板高','342');await fill('自定义画板名称','Custom board')
  await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
  expect(editor.state.doc.nodes[editor.state.selection[0]]).toMatchObject({name:'Custom board',width:512,height:342})
})
test('category selection filters and stale page refuses creation',async()=>{
  const select=document.querySelector<HTMLSelectElement>('[aria-label="预设分类"]')!
  await act(async()=>{select.value='watch';select.dispatchEvent(new Event('change',{bubbles:true}))});expect(presets()).toHaveLength(2)
  editor.set({page:'stale-page'});const before=editor.state.doc
  await act(async()=>presets()[0].click());expect(editor.state.doc).toBe(before);expect(closed).not.toHaveBeenCalled();expect(document.querySelector('[role="alert"]')?.textContent).toContain('页面已变化')
})
test('Escape cancels without history; Tab wraps focus',async()=>{
  const first=document.querySelector<HTMLButtonElement>('button')!,last=document.querySelector<HTMLButtonElement>('button[type="submit"]')!;last.focus()
  await act(async()=>last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));expect(document.activeElement).toBe(first)
  await act(async()=>first.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));expect(closed).toHaveBeenCalledOnce();expect(editor.canUndo).toBe(false)
})
