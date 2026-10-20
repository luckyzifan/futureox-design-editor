// CPU DOM events and real WASM only; no browser layout/GPU evidence.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank,node,paint } from './model'
import { ShapeBuilderDialog } from './ShapeBuilderDialog'
let root:Root, dom:any, editor:Editor, mount:HTMLElement
beforeEach(async()=>{
  dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
  for(const name of ['window','document','navigator','HTMLElement','Node','Event','KeyboardEvent'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
  const {createRoot}=await import('react-dom/client');mount=document.createElement('div');document.body.append(mount);root=createRoot(mount)
  const d=blank(),a=node('rectangle',0,0,100,100),b=node('rectangle',50,0,100,100)
  d.nodes={[a.id]:a,[b.id]:b};d.pages[0].children=[a.id,b.id];editor=new Editor(d);editor.select([a.id,b.id])
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.unstubAllGlobals()})
const button=(text:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(e=>e.textContent===text)!
test('keyboard region selection and Apply make one undoable edit',async()=>{
  const close=vi.fn(),before=editor.state.doc
  await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={close}/>))
  expect(document.querySelectorAll('[data-region-id]')).toHaveLength(3)
  expect(mount.hasAttribute('inert')).toBe(true)
  for(const id of ['1:0','3:0'])await act(async()=>document.querySelector(`[data-region-id="${id}"]`)!.dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true})))
  expect(document.querySelectorAll('[aria-pressed=true]')).toHaveLength(2)
  expect(editor.state.doc).toBe(before)
  await act(async()=>button('应用').click())
  expect(close).toHaveBeenCalledOnce();expect(editor.state.doc.pages[0].children).toHaveLength(2)
  editor.undo();expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
})
test('Alt pointer selects erase and cancel leaves originals intact',async()=>{
  const close=vi.fn(),before=editor.state.doc
  await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={close}/>))
  await act(async()=>document.querySelector('[data-region-id="3:0"]')!.dispatchEvent(new dom.window.MouseEvent('pointerdown',{button:0,altKey:true,bubbles:true,cancelable:true})))
  expect((document.querySelector('select') as HTMLSelectElement).value).toBe('erase')
  await act(async()=>button('取消').click());expect(close).toHaveBeenCalledOnce();expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
})
function svgPointEvent(type:string,x:number,y:number,altKey=false){
  const svg=document.querySelector<SVGSVGElement>('.shape-builder-dialog svg')!
  const [vx,vy,width,height]=svg.getAttribute('viewBox')!.split(' ').map(Number)
  vi.spyOn(svg,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:width,bottom:height,width,height,toJSON:()=>({})})
  svg.dispatchEvent(new dom.window.MouseEvent(type,{clientX:x-vx,clientY:y-vy,button:0,buttons:type==='pointerup'?0:1,altKey,bubbles:true,cancelable:true}))
}
test('single long pointer move sweeps both narrow regions without pointerenter events',async()=>{
  const ids=editor.state.doc.pages[0].children
  editor.change('Fixture',d=>{d.nodes[ids[1]].transform=[1,0,0,1,40,0];d.nodes[ids[1]].width=.2;const third=node('rectangle',70,0,.2,100);d.nodes[third.id]=third;d.pages[0].children.push(third.id)},undefined)
  editor.select(editor.state.doc.pages[0].children)
  const before=editor.state.doc
  await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={()=>{}}/>))
  expect(document.querySelectorAll('[data-region-id]')).toHaveLength(5)
  await act(async()=>svgPointEvent('pointerdown',10,50,true))
  await act(async()=>svgPointEvent('pointermove',90,50,true))
  await act(async()=>svgPointEvent('pointerup',90,50,true))
  expect(document.querySelectorAll('[aria-pressed=true]')).toHaveLength(5)
  expect((document.querySelector('select') as HTMLSelectElement).value).toBe('erase')
  expect(editor.state.doc).toBe(before)
})
test('drag entirely through a hole does not select its surrounding region',async()=>{
  const {contoursToNetwork}=await import('./geometry')
  const d=blank(),annulus=node('vector',0,0,100,100)
  annulus.strokes=[];annulus.fills=[paint('#4285f4')];annulus.network=contoursToNetwork([[{x:0,y:0},{x:100,y:0},{x:100,y:100},{x:0,y:100}],[{x:25,y:25},{x:75,y:25},{x:75,y:75},{x:25,y:75}]])
  d.nodes={[annulus.id]:annulus};d.pages[0].children=[annulus.id];editor.dispose();editor=new Editor(d);editor.select([annulus.id])
  await act(async()=>root.render(<ShapeBuilderDialog editor={editor} onClose={()=>{}}/>))
  expect(document.querySelectorAll('[data-region-id]')).toHaveLength(1)
  await act(async()=>svgPointEvent('pointerdown',35,50))
  await act(async()=>svgPointEvent('pointermove',65,50))
  await act(async()=>svgPointEvent('pointerup',65,50))
  expect(document.querySelectorAll('[aria-pressed=true]')).toHaveLength(0)
  expect(button('应用').disabled).toBe(true)
})
