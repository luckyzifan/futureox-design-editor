import React from 'react'
import {expect,test,vi} from 'vitest'
import {SketchInspectionDialog} from './SketchInspectionDialog'
import {SketchReadOnlyPreview} from './SketchReadOnlyPreview'
import type {SketchInspection} from './sketch-inspection'

// Actual React element/handler checks. Native window size and GPU rendering are
// covered separately in the desktop acceptance, not simulated by this harness.
function harness(){const slots:any[]=[];let at=0;const hooks={useState(initial:any){const i=at++;if(!(i in slots))slots[i]=initial;return[slots[i],(v:any)=>slots[i]=v]},useRef(value:any){const i=at++;return slots[i]??={current:value}},useEffect(){at++},useSyncExternalStore(_subscribe:any,snapshot:()=>any){at++;return snapshot()}};return(fn:()=>any)=>{at=0;const r=(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,old=r.H;r.H=hooks;try{return fn()}finally{r.H=old}}}
function find(tree:any,predicate:(n:any)=>boolean):any{if(!tree||typeof tree!=='object')return;if(predicate(tree))return tree;for(const child of [tree.props?.children].flat(Infinity)){const value=find(child,predicate);if(value)return value}}
const result=(id='8eafc349-45d2-405c-9405-cb07ef12c9a8'):SketchInspection=>({displayName:'111.sketch',pageCount:1,layerCount:1192,editable:false,renderable:false,owner:{kernel_id:'sketch',document_schema:'sketch-native-v1',document_id:id,session_epoch:1},preview:{status:'ready',frameJson:'fixture',pageName:'Page',pageId:'P'}})
test('GPU preview is not mounted until confirmation; another file requires a fresh confirmation',()=>{
 const render=harness(),onClose=vi.fn();let value=result(),tree=render(()=>SketchInspectionDialog({result:value,onClose}))
 expect(find(tree,n=>n.type===SketchReadOnlyPreview)).toBeUndefined()
 find(tree,n=>n.type==='button'&&n.props.children==='确认打开').props.onClick()
 tree=render(()=>SketchInspectionDialog({result:value,onClose}));expect(find(tree,n=>n.type===SketchReadOnlyPreview)).toBeDefined()
 expect(find(tree,n=>n.type==='footer'&&n.props['data-testid']==='sketch-open-actions')).toBeDefined()
 find(tree,n=>n.type==='button'&&n.props.children==='完成').props.onClick();expect(onClose).toHaveBeenCalledOnce()
 value=result('bdbf09a0-37f0-4c2e-bc60-fc2501d04e84');tree=render(()=>SketchInspectionDialog({result:value,onClose}));expect(find(tree,n=>n.type===SketchReadOnlyPreview)).toBeUndefined()
 expect(find(tree,n=>n.type==='button'&&n.props.children==='确认打开').props.disabled).toBe(false)
})
test('loading and unsupported states keep Cancel available and cannot start rendering',()=>{
 for(const value of [null,{...result(),preview:{status:'unavailable' as const,reason:'Unsupported native feature'}}]){
  const render=harness(),onClose=vi.fn(),tree=render(()=>SketchInspectionDialog({result:value,onClose}))
  expect(find(tree,n=>n.type==='button'&&n.props.children==='确认打开').props.disabled).toBe(true)
  find(tree,n=>n.type==='button'&&n.props.children==='取消').props.onClick();expect(onClose).toHaveBeenCalledOnce()
  expect(find(tree,n=>n.type===SketchReadOnlyPreview)).toBeUndefined()
 }
})
test('unsupported native preview names the compatibility import and keeps confirmation disabled',()=>{
 const render=harness(),onClose=vi.fn(),onImport=vi.fn()
 const value={...result(),preview:{status:'unavailable' as const,reason:'Sketch archive: Unsupported("Sketch page transforms")'}}
 const tree=render(()=>SketchInspectionDialog({result:value,onClose,onImportCompatibility:onImport}))
 expect(find(tree,n=>n.type==='button'&&n.props.children==='确认打开').props.disabled).toBe(true)
 expect(JSON.stringify(tree)).toContain('可以用兼容格式导入')
 expect(JSON.stringify(tree)).toContain('Sketch page transforms')
 find(tree,n=>n.type==='button'&&n.props.children==='用兼容格式导入…').props.onClick()
 expect(onImport).toHaveBeenCalledOnce()
 expect(find(tree,n=>n.type===SketchReadOnlyPreview)).toBeUndefined()
 const named=render(()=>SketchInspectionDialog({result:value,onClose}))
 expect(JSON.stringify(named)).toContain('导入 Sketch / FIG / SVG / PDF')
 expect(find(named,n=>n.type==='button'&&n.props.children==='用兼容格式导入…')).toBeUndefined()
})
