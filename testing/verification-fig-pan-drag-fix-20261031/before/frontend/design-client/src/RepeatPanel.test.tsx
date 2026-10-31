// CPU DOM/Editor test only; no GPU/browser-layout claim.
// @ts-expect-error jsdom is a test-only runtime dependency.
import {JSDOM} from 'jsdom'
import React,{act,useSyncExternalStore} from 'react'
import type {Root} from 'react-dom/client'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {Editor} from './engine'
import {blank,node} from './model'
import {RepeatPanel} from './RepeatPanel'
import {PendingEditContext} from './pending-edit-context'
let dom:any,root:Root,mount:HTMLDivElement,editor:Editor,id:string
beforeEach(async()=>{
 dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'https://design.invalid/'})
 for(const name of ['window','document','navigator','HTMLElement','HTMLInputElement','Node','Event','KeyboardEvent'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const {createRoot}=await import('react-dom/client');mount=document.createElement('div');document.body.append(mount);root=createRoot(mount)
 const d=blank(),n=node('rectangle',10,10,10,10);id=n.id;d.nodes[id]=n;d.pages[0].children=[id];editor=new Editor(d)
})
afterEach(async()=>{await act(async()=>root.unmount());editor.dispose();dom.window.close();vi.unstubAllGlobals();vi.restoreAllMocks()})
function Panel(){useSyncExternalStore(editor.subscribe,editor.snapshot);return <PendingEditContext.Provider value={editor}><RepeatPanel editor={editor} node={editor.state.doc.nodes[id]}/></PendingEditContext.Provider>}
test('shared inspector creates/removes true repeats and native undo restores parameters',async()=>{
 await act(async()=>root.render(<Panel/>))
 const button=()=>mount.querySelector('button')!
 expect(button().textContent).toBe('添加重复变换');await act(async()=>button().click())
 expect(editor.state.doc.schemaVersion).toBe(15);expect(editor.state.doc.nodes[id].repeat?.count).toBe(3);expect(Object.keys(editor.state.doc.nodes)).toHaveLength(1)
 expect(mount.textContent).toContain('枢轴 X（父坐标）');expect(mount.textContent).toContain('每步旋转（度）')
 await act(async()=>button().click());expect(editor.state.doc.nodes[id].repeat).toBeUndefined();await act(async()=>editor.undo());expect(editor.state.doc.nodes[id].repeat?.count).toBe(3)
})
