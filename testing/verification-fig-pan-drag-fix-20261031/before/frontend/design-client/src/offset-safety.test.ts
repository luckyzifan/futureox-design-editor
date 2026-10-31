import {expect,test} from 'vitest'
import {Editor} from './engine'
import {blank,node} from './model'
import {prepareDocumentForEditing,kernelBounds} from './kernel/picking'

test('invalid negative offset of an open path cannot replace the displayed scene or be committed',()=>{
 const d=blank(),n=node('line',20,20,100,1);d.nodes[n.id]=n;d.pages[0].children=[n.id]
 const e=new Editor(d),before=e.state.doc;e.select([n.id]);e.begin('偏移路径')
 e.preview({[n.id]:{pathOffset:-5}})
 expect(e.state.doc).toBe(before);expect(e.state.message).toContain('Open paths require a positive offset')
 expect(()=>e.entries()).not.toThrow();expect(()=>kernelBounds(e.state.doc.nodes[n.id])).not.toThrow()
 e.commit();expect(e.canUndo).toBe(false)
 e.update([n.id],{pathOffset:-5});expect(e.state.doc).toBe(before)
 const imported=structuredClone(d);imported.schemaVersion=10;imported.nodes[n.id].pathOffset=-5
 expect(()=>prepareDocumentForEditing(imported)).toThrow('Open paths require a positive offset')
 e.dispose()
})
