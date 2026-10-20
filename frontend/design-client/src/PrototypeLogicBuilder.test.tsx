// @ts-expect-error jsdom runtime dependency has no local declaration.
import {JSDOM} from 'jsdom'
import React,{act} from 'react'
import {createRoot} from 'react-dom/client'
import {test,expect,vi} from 'vitest'
import {PrototypeLogicBuilder} from './PrototypeLogicBuilder'
import {blank,node} from './model'
import type {PrototypeAction} from './prototype'
test('mounted logic builder keeps drafts local and applies nested branch controls',()=>{
 const dom=new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>',{url:'https://design.invalid'})
 for(const name of ['window','document','navigator','HTMLElement','Node','Event'])vi.stubGlobal(name,name==='window'?dom.window:dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true)
 const d=blank(),n=node('frame');d.nodes[n.id]=n;d.pages[0].children=[n.id];const event={trigger:'click' as const,actions:[] as PrototypeAction[]};d.prototype={interactions:{[n.id]:[event]}}
 const changes:PrototypeAction[][]=[],mount=document.getElementById('app')!,root=createRoot(mount)
 try{
  act(()=>root.render(<PrototypeLogicBuilder doc={d} event={event} onChange={a=>changes.push(a)}/>))
  const buttons=(text:string)=>[...mount.querySelectorAll('button')].filter(b=>b.textContent===text)
  act(()=>buttons('添加条件分支')[0].click());expect(changes).toHaveLength(0);expect(event.actions).toEqual([])
  act(()=>buttons('添加顺序动作')[0].click());expect(changes).toHaveLength(0)
  act(()=>buttons('应用逻辑')[0].click());expect(changes).toHaveLength(1)
  expect(changes[0][0]).toMatchObject({kind:'if',expression:{kind:'literal',value:true},thenActions:[{kind:'back'}],elseActions:[]})
  act(()=>buttons('放弃逻辑编辑')[0].click());expect(event.actions).toEqual([])
 }finally{act(()=>root.unmount());dom.window.close();vi.unstubAllGlobals()}
})
