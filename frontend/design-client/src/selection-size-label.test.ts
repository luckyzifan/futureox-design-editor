import { expect,test } from 'vitest'
import { Editor } from './engine'
import { blank,node } from './model'
import { selectionLocalBounds } from './canvas-view'
import { scene,unionBounds,worldMatrix } from './geometry'
import { selectionMetric } from './selection-properties'
import { formatLogicalDimension,selectionSizeLabel } from './selection-size-label'

function fixture(kind: 'rectangle'|'frame'|'group' = 'rectangle') {
  const doc=blank(),parent=node('frame',0,0,2000,2000),target=node(kind,20,40,1466.59,1049.02),child=node('rectangle',0,0,100.125,75.5)
  parent.transform=[2,0,0,3,100,200];parent.children=[target.id]
  if(kind==='group')target.children=[child.id]
  doc.nodes={[parent.id]:parent,[target.id]:target,...(kind==='group'?{[child.id]:child}:{})};doc.pages[0].children=[parent.id]
  const editor=new Editor(doc)
  const label=()=>selectionSizeLabel(selectionLocalBounds(editor.state.doc,target.id),scene(editor.state.doc,editor.state.page).find(e=>e.id===target.id)!.bounds,worldMatrix(editor.state.doc,target.id))
  return {editor,target,child,label}
}
test.each(['rectangle','frame'] as const)('single %s preserves fractional W/H and authoritative property units under nonuniform ancestor scale',kind=>{
 const {editor,target,label}=fixture(kind)
 try{const before=editor.state.doc;expect(label()).toBe('2933.18 × 3147.06');expect(selectionMetric(editor.state.doc.nodes[target.id],'width',editor.state.doc)).toBe(2933.18);expect(editor.state.doc).toBe(before);expect(editor.canUndo).toBe(false)
  editor.update([target.id],{width:512.125,height:342.0625},'Resize fixture');expect(label()).toBe('1024.25 × 1026.19');editor.undo();expect(label()).toBe('2933.18 × 3147.06')
 }finally{editor.dispose()}
})
test('rotated and reflected single node remains 100 × 75, not world AABB',()=>{
 const {editor,target,label}=fixture()
 try{editor.update([editor.state.doc.pages[0].children[0]],{transform:[1,0,0,1,100,200]},'Unscale ancestor fixture');editor.update([target.id],{width:100,height:75,transform:[-Math.SQRT1_2,-Math.SQRT1_2,-Math.SQRT1_2,Math.SQRT1_2,20,40]},'Rotate and reflect fixture');expect(label()).toBe('100 × 75')
 const world=scene(editor.state.doc,editor.state.page).find(e=>e.id===target.id)!.bounds;expect(world.width).not.toBe(100);expect(world.height).not.toBe(75)
 }finally{editor.dispose()}
})
test('ordinary group reports child geometry in group axes rather than stale authored group dimensions',()=>{
 const {editor,target,child,label}=fixture('group')
 try{expect(label()).toBe('200.25 × 226.5');editor.update([child.id],{width:120.25},'Resize child');expect(label()).toBe('240.5 × 226.5');expect(editor.state.doc.nodes[target.id].width).not.toBe(120.25);editor.undo();expect(label()).toBe('200.25 × 226.5')
 }finally{editor.dispose()}
})
test('mixed selection retains aggregate semantics and display formatting never mutates data',()=>{
 const doc=blank(),a=node('rectangle',0,0,100.125,75.5),b=node('rectangle',200,100,20.25,10.75);doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
 const before=JSON.stringify(doc),aggregate=unionBounds(scene(doc,doc.pages[0].id).map(e=>e.bounds));expect(selectionSizeLabel(null,aggregate)).toBe('220.25 × 110.75');expect(JSON.stringify(doc)).toBe(before)
 expect(formatLogicalDimension(100.00000000000001)).toBe('100');expect(formatLogicalDimension(20.6079998016)).toBe('20.61');expect(formatLogicalDimension(91.712)).toBe('91.71');expect(formatLogicalDimension(0.000000125)).toBe('0');expect(formatLogicalDimension(-0)).toBe('0');expect(formatLogicalDimension(NaN)).toBe('—')
})
test('ordinary group transform resize updates label without rewriting child geometry',async()=>{
 const {editor,target,child,label}=fixture('group')
 const {resizedNode}=await import('./selection-properties')
 try{const before=editor.state.doc;editor.update([target.id],resizedNode(before.nodes[target.id],[2,0,0,2,20,40]),'Resize group fixture');expect(label()).toBe('400.5 × 453');expect(editor.state.doc.nodes[child.id]).toEqual(before.nodes[child.id]);editor.undo();expect(label()).toBe('200.25 × 226.5')
 }finally{editor.dispose()}
})
test('normal frame resize contract and display agree with inspector units',async()=>{
 const {editor,target,label}=fixture('frame'),{resizeNodeDimension,selectionMetric}=await import('./selection-properties')
 try{editor.change('Resize frame via inspector contract',doc=>resizeNodeDimension(doc.nodes[target.id],'width',1234.5678,doc));expect(selectionMetric(editor.state.doc.nodes[target.id],'width',editor.state.doc)).toBeCloseTo(1234.5678,8);expect(label()).toBe('1234.57 × 3147.06');editor.undo();expect(label()).toBe('2933.18 × 3147.06')
 }finally{editor.dispose()}
})
