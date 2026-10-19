import { expect, test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { decodeScenePacket } from './scene-packet'
import { reuseExactSceneSources } from './exact-scene-reuse'
import { preparePreviewSelection } from './translated-scene'

test('exact recompilation retains unchanged source pixels but rejects changed geometry, camera and bit patterns', () => {
  const doc=blank(), a=node('rectangle',10.125,12.25,40,30), b=node('rectangle',70,10,24,24)
  a.fills=[paint('#dd3344')]; b.fills=[paint('#3388cc')]
  doc.nodes[a.id]=a;doc.nodes[b.id]=b;doc.pages[0].children=[a.id,b.id]
  const kernel=new VectorEngine(), options={pageId:doc.pages[0].id,width:140,height:100,view:{x:.375,y:.125,zoom:1.2},transparent:false,grid:false}
  const compile=(document=doc)=>{kernel.load_document(JSON.stringify(document));return decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify(options)))}
  try {
    const old=compile(), moved=compile({...doc,nodes:{...doc.nodes,[a.id]:{...a,transform:[1,0,0,1,11.25,12.25]}}})
    const reused=reuseExactSceneSources(old,moved)
    expect(reused.nodes[b.id].previewSource).toBe(old.nodes[b.id])
    expect(reused.nodes[a.id].previewSource).toBeUndefined()
    const changedView={...moved,view:{...moved.view,x:moved.view.x+.125}}
    expect(reuseExactSceneSources(old,changedView).nodes[b.id].previewSource).toBeUndefined()
    const bad={...moved,curves:new Float32Array(moved.curves||[])}
    const offset=bad.nodes[b.id].fill.area!.first*4
    new Uint32Array(bad.curves.buffer)[offset]^=1
    expect(reuseExactSceneSources(old,bad).nodes[b.id].previewSource).toBeUndefined()
    // A previous lease is never modified by proof or failure.
    expect(old.nodes[b.id].previewSource).toBeUndefined()
  } finally {kernel.free()}
})

test('unchanged ancestor metadata cannot certify a subtree containing a moved descendant', () => {
  const doc=blank(), parent=node('frame',0,0,120,120), child=node('rectangle',10,10,20,20)
  parent.children=[child.id];doc.nodes[parent.id]=parent;doc.nodes[child.id]=child;doc.pages[0].children=[parent.id]
  const kernel=new VectorEngine()
  try {
    kernel.load_document(JSON.stringify(doc)); const options=JSON.stringify({pageId:doc.pages[0].id,width:128,height:128,view:{x:0,y:0,zoom:1}})
    const old=preparePreviewSelection(decodeScenePacket(kernel.compile_gpu_packet(options)),[child.id])
    const next=preparePreviewSelection(decodeScenePacket(kernel.compile_gpu_packet(options)),[child.id])
    expect(reuseExactSceneSources(old,next).nodes[parent.id].previewSource).toBeUndefined()
  }finally{kernel.free()}
})
