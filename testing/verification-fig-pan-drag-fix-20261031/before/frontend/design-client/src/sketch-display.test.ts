import {expect,test} from 'vitest'
import {blank,node,paint} from './model'
import {admitSketchDisplay} from '../../design-desktop/src/sketch-display-contract.mjs'
import {sketchDisplayDocument} from './sketch-display'
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
function fixture(){
 const d=blank('Native display');d.schemaVersion=11
 const a=node('frame',10,20,100,100),b=node('frame',200,20,100,100),child=node('rectangle',0,0,100,100)
 child.fills=[{...paint(),kind:'image',image:'sketch-asset:images/a.png'}];a.children=[child.id];d.nodes={[a.id]:a,[b.id]:b,[child.id]:child};d.pages[0].children=[a.id,b.id]
 const owner={kernel_id:'sketch' as const,document_schema:'sketch-native-v1' as const,document_id:d.id,session_epoch:7}
 return {a,b,child,value:{owner,revision:2,pageId:d.pages[0].id,document:d,assets:{'sketch-asset:images/a.png':png},artboards:[a.id,b.id],warnings:[],sourceFonts:[]}}
}
test('display hydrates original image bytes only for the selected artboard and passes Rust admission',async()=>{
 const {a,b,child,value}=fixture(),snapshot=admitSketchDisplay(value,value.owner,2),before=JSON.stringify(snapshot)
 const doc=await sketchDisplayDocument(snapshot,a.id)
 expect(Object.keys(doc.nodes).sort()).toEqual([a.id,child.id].sort());expect(doc.nodes[child.id].fills[0].image).toBe(png)
 expect(JSON.stringify(snapshot)).toBe(before);expect((await sketchDisplayDocument(snapshot,b.id)).nodes[child.id]).toBeUndefined()
})
test('display refuses stale revision, cross-document owner, ungranted images, cyclic trees and non-artboard roots',async()=>{
 for(const mode of ['revision','owner','image','cycle']){
  const {a,child,value}=fixture(),expected={...value.owner}
  if(mode==='revision')value.revision=1
  if(mode==='owner')value.owner.session_epoch++
  if(mode==='image')value.document.nodes[child.id].fills[0].image='file:///private/secret'
  if(mode==='cycle')value.document.nodes[child.id].children=[a.id]
  expect(()=>admitSketchDisplay(value,expected,2)).toThrow()
 }
 const {child,value}=fixture();await expect(sketchDisplayDocument(value,child.id)).rejects.toThrow('未知 Sketch 画板')
})
