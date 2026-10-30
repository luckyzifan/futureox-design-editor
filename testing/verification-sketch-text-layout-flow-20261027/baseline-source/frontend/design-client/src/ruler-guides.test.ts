import {expect,test} from 'vitest'
import {blank,node,uid,validateDocument} from './model'
import {Editor} from './engine'
import {worldGuides,guidePosition} from './ruler-guides'
import {validate_document_json} from './generated/design-kernel/design_kernel'
import {encodeDocumentBinary,decodeDocumentBinary} from './kernel/binfmt'

test('page and rotated-frame guides promote schema and survive the real binary/Rust document path',()=>{
 const d=blank(),n=node('frame',100,200,80,60);n.transform=[0,1,-1,0,100,200];d.nodes[n.id]=n;d.pages[0].children=[n.id]
 const editor=new Editor(d),before=editor.state.doc
 editor.change('guides',doc=>{doc.pages[0].guides=[{id:uid(),axis:'x',position:12.125}];doc.nodes[n.id].guides=[{id:uid(),axis:'y',position:17.75}]})
 const result=editor.state.doc;expect(result.schemaVersion).toBe(11);validateDocument(result);validate_document_json(JSON.stringify(result))
 expect(decodeDocumentBinary(encodeDocumentBinary(result))).toEqual(result)
 const guides=worldGuides(result,result.pages[0].id);expect(guides).toHaveLength(2)
 expect(guides[1].from).toEqual({x:82.25,y:200});expect(guides[1].to).toEqual({x:82.25,y:280})
 expect(guidePosition(result,n.id,'y',{x:82.25,y:240})).toBe(17.75)
 editor.undo();expect(editor.state.doc).toEqual(before);editor.dispose()
})
test('client and Rust reject guides with duplicate IDs, invalid axes, nonfinite values and old schema',()=>{
 for(const mutation of ['duplicate','axis','range','schema'] as const){
  const d=blank();d.schemaVersion=11;d.pages[0].guides=[{id:uid(),axis:'x',position:1}]
  if(mutation==='duplicate')d.pages[0].guides.push({...d.pages[0].guides[0]})
  if(mutation==='axis')(d.pages[0].guides[0] as any).axis='z'
  if(mutation==='range')d.pages[0].guides[0].position=1e8
  if(mutation==='schema')d.schemaVersion=10
  expect(()=>validateDocument(d)).toThrow();expect(()=>validate_document_json(JSON.stringify(d))).toThrow()
 }
})
