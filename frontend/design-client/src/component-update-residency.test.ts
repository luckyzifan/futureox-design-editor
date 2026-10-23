import {test,expect,vi} from 'vitest'
import {Editor} from './engine'
import {blank,node} from './model'
import {initializePicking} from './kernel/picking'
import {VectorEngine} from './generated/design-kernel/design_kernel'
import {readFileSync} from 'node:fs'

test('actual Editor commits reuse acknowledged derivation deltas; undo and font resets remain safe',async()=>{
 await initializePicking({wasm:readFileSync(new URL('../public/kernel/design_kernel_bg.wasm',import.meta.url)),font:readFileSync(new URL('../public/fonts/NotoSansSC.ttf',import.meta.url))})
 const doc=blank(),master=node('frame',0,0,100,40),child=node('rectangle',0,0,80,30),instance=node('frame',150,0,100,40)
 master.component={variants:{},properties:{}};master.children=[child.id];instance.instance={componentId:master.id,overrides:{},propertyValues:{}}
 doc.nodes={[master.id]:master,[child.id]:child,[instance.id]:instance};doc.pages[0].children=[master.id,instance.id]
 const full=vi.spyOn(VectorEngine.prototype,'resolve_components_full'),patch=vi.spyOn(VectorEngine.prototype,'resolve_components_patch')
 const editor=new Editor(doc)
 try{
  full.mockClear();patch.mockClear()
  editor.updateProperties([child.id],n=>{n.opacity=.7})
  editor.updateProperties([child.id],n=>{n.opacity=.6})
  editor.updateProperties([child.id],n=>{n.opacity=.5})
  expect(patch.mock.calls.length).toBeGreaterThan(0)
  expect(patch.mock.calls.every(([wire])=>JSON.stringify(JSON.parse(wire).nodes).length<10000)).toBe(true)
  const generated=()=>Object.values(editor.state.doc.nodes).find(n=>n.instanceOrigin?.owner===instance.id&&n.instanceOrigin.source===child.id)
  expect(generated()?.opacity).toBe(.5)
  editor.undo();expect(generated()?.opacity).toBe(.6)
  editor.redo();expect(generated()?.opacity).toBe(.5)
  editor.undo();editor.updateProperties([child.id],n=>{n.opacity=.4});expect(generated()?.opacity).toBe(.4)
 }finally{editor.dispose();full.mockRestore();patch.mockRestore()}
})
