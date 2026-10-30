import {expect,test} from 'vitest'
import {blank,node,validateDocument} from './model'
import {defaultColorSettings} from './color'
import {Editor} from './engine'
test('first edit of a color-managed imported document without a profile adopts the managed default',()=>{
 const d=blank('Imported'),n=node('rectangle',0,0,40,30);d.schemaVersion=3;d.colorManagement=defaultColorSettings();delete d.rasterProfile
 d.nodes[n.id]=n;d.pages[0].children=[n.id];validateDocument(d)
 const editor=new Editor(d)
 try{
  const edit=editor.change('Rename',doc=>{doc.nodes[n.id].name='Renamed'})
  expect(edit.status).toBe('committed');expect(editor.state.doc.nodes[n.id].name).toBe('Renamed')
  expect(editor.state.doc.rasterProfile).toBe('figma');validateDocument(editor.state.doc)
  editor.undo();expect(editor.state.doc.nodes[n.id].name).toBe(n.name)
  editor.redo();expect(editor.state.doc.nodes[n.id].name).toBe('Renamed')
 }finally{editor.dispose()}
})
