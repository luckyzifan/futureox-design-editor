import { expect, test } from 'vitest'
import { blank, node } from '../model'
import { applyDocumentPatch, equalValue } from '../document-patch'
import { readAuthoredSnapshot } from './authored-snapshot'

test('identical validated envelopes share authored records while edits stay isolated',()=>{
  const doc=blank(),a=node('rectangle',0,0,20,20),b=node('rectangle',40,0,20,20)
  doc.nodes={[a.id]:a,[b.id]:b};doc.pages[0].children=[a.id,b.id]
  const json=JSON.stringify(doc),canvas=readAuthoredSnapshot(json)
  const interaction=readAuthoredSnapshot(json,{json,document:canvas})
  expect(interaction).toBe(canvas)
  const patch={nodes:{[a.id]:{...a,transform:[1,0,0,1,12.375,0] as typeof a.transform}},fields:{}}
  const committed=applyDocumentPatch(canvas,patch),posed=applyDocumentPatch(interaction,patch)
  expect(committed.nodes[b.id]).toBe(posed.nodes[b.id]);expect(equalValue(committed,posed)).toBe(true)
  expect(canvas.nodes[a.id].transform[4]).toBe(0)
  const changed=JSON.stringify({...doc,name:'another revision'})
  expect(readAuthoredSnapshot(changed,{json,document:canvas})).not.toBe(canvas)
  expect(()=>readAuthoredSnapshot('',{json:'',document:canvas})).toThrow()
})
