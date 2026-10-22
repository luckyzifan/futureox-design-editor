import React from 'react'
import { beforeEach, afterEach, expect, test } from 'vitest'
import { interfacePreference } from './interface-preference'
import { Editor } from './engine'
import { LayoutPanel } from './LayoutPanel'
import { blank, node } from './model'
const editors: Editor[]=[]
beforeEach(()=>interfacePreference.set({locale:'en'}))
afterEach(()=>{editors.splice(0).forEach(e=>e.dispose());interfacePreference.reset()})
function find(tree: any, predicate:(v:any)=>boolean):any {
  if(!tree||typeof tree!=='object')return
  if(predicate(tree))return tree
  for(const child of [tree.props?.children].flat(Infinity)){const found=find(child,predicate);if(found)return found}
}
function text(tree:any):string {return typeof tree==='string'||typeof tree==='number'?String(tree):[tree?.props?.children].flat(Infinity).map(v=>v?text(v):'').join('')}
function fixture(){
  const doc=blank(),frame=node('frame',0,0,300,100)
  doc.nodes[frame.id]=frame;doc.pages[0].children=[frame.id]
  for(const x of [10,60]){const n=node('rectangle',x,10,40,30);doc.nodes[n.id]=n;frame.children.push(n.id)}
  const editor=new Editor(doc);editors.push(editor);editor.select([frame.id])
  const slots:any[]=[];let cursor=0
  const hooks={useSyncExternalStore(_subscribe:any,snapshot:()=>any){cursor++;return snapshot()},useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(v:any)=>slots[i]=v]}}
  const render=()=>{cursor=0;const internals=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,old=internals.H;internals.H=hooks;try{return LayoutPanel({editor,node:editor.state.doc.nodes[frame.id],ids:[frame.id]})}finally{internals.H=old}}
  const button=(label:string)=>find(render(),v=>v.type==='button'&&text(v)===label)
  return{editor,frame,render,button}
}
test('shared Web/Electron layout panel previews and cancels without document or history changes',()=>{
  const f=fixture(),before=f.editor.state.doc,version=f.editor.state.version
  f.button('Suggest auto layout…').props.onClick();expect(text(f.render())).toContain('horizontal');expect(f.button('Apply proposal')).toBeDefined()
  expect(f.editor.state.doc).toBe(before);expect(f.editor.state.version).toBe(version);expect(f.editor.canUndo).toBe(false)
  f.button('Cancel').props.onClick();expect(f.button('Apply proposal')).toBeUndefined();expect(f.editor.state.doc).toBe(before)
})
test('shared panel applies once and native undo restores original',()=>{
  const f=fixture(),before=f.editor.state.doc,version=f.editor.state.version
  f.button('Suggest auto layout…').props.onClick();f.button('Apply proposal').props.onClick()
  expect(f.editor.state.version).toBe(version+1);expect(f.editor.state.doc.nodes[f.frame.id].layout?.mode).toBe('horizontal')
  expect(f.button('Apply proposal')).toBeUndefined();f.editor.undo();expect(f.editor.state.doc).toEqual(before)
})
test('stale shared panel proposal stays visible with an error instead of silently reapplying',()=>{
  const f=fixture();f.button('Suggest auto layout…').props.onClick();f.editor.change('rename',d=>{d.name='Changed'})
  const before=f.editor.state.doc;f.button('Apply proposal').props.onClick()
  expect(f.editor.state.doc).toBe(before);expect(text(f.render())).toContain('stale');expect(f.button('Apply proposal')).toBeDefined()
})
