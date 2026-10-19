import { expect,test } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank,node,paint,effect,type Matrix } from '../../model'
import { decodeScenePacket } from './scene-packet'
import { preparePreviewSelection,translatePreviewScene } from './translated-scene'
import { TranslationPatchSession } from './translation-patch-session'

function fixture(nested:boolean){
  const doc=blank(),root=node('frame',50,50,128,128),leaf=node('rectangle',10,12,24,20),other=node('rectangle',55,42,20,24),fixed=node('rectangle',240,50,30,40)
  root.blend='normal';root.clip=true;root.children=[leaf.id,other.id]
  leaf.fills=[paint('#0099ff','linear')];other.fills=[paint('#449944')]
  for(const n of [root,leaf,other,fixed])doc.nodes[n.id]=n
  doc.pages[0].children=[root.id,fixed.id]
  const kernel=new VectorEngine();kernel.load_document(JSON.stringify(doc))
  const scene=decodeScenePacket(kernel.compile_gpu_packet(JSON.stringify({pageId:doc.pages[0].id,width:320,height:240,view:{x:0,y:0,zoom:1},grid:false,transparent:false})))
  const ids=nested?[leaf.id,other.id]:[root.id]
  return{doc,kernel,ids,scene:preparePreviewSelection(scene,ids),fixed}
}
test.each([false,true])('patch sessions match full-document translation, nested=%s',nested=>{
  const {doc,kernel,ids,scene,fixed}=fixture(nested)
  try{
    const plan=TranslationPatchSession.create(scene,doc,ids)!
    expect(plan).not.toBeNull()
    let fast=scene,reference=scene,before=doc
    const window={x:40,y:40,w:80,h:80},original=JSON.stringify(scene.nodes)
    for(let i=1;i<=24;i++){
      const transforms=Object.fromEntries(ids.map((id,j)=>[id,[...doc.nodes[id].transform.slice(0,4),doc.nodes[id].transform[4]+(j===1?Math.floor(i/2):i)*.375,doc.nodes[id].transform[5]+Math.sin(i/3)*2] as Matrix]))
      const after={...doc,nodes:{...doc.nodes,...Object.fromEntries(ids.map(id=>[id,{...doc.nodes[id],transform:transforms[id]}]))}}
      const published=JSON.stringify(fast.nodes)
      const next=plan.prepare(fast,transforms,window)!
      expect(JSON.stringify(fast.nodes)).toBe(published)
      const expected=translatePreviewScene({...reference,interactionWindow:window},before,after)!
      expect(next).not.toBeNull();expect(expected).not.toBeNull()
      expect(JSON.stringify(next.nodes)).toBe(JSON.stringify(expected.nodes))
      expect(next.nodes[fixed.id]).toBe(scene.nodes[fixed.id])
      plan.accept(next,transforms);fast=next;reference=expected;before=after
    }
    expect(plan.snapshot()).toEqual(before)
    expect(plan.snapshot()).toBe(plan.snapshot())
    expect(JSON.stringify(scene.nodes)).toBe(original)
  }finally{kernel.free()}
})
test('invalid transforms, guard escapes and stale scene leases leave the displayed scene untouched',()=>{
  const {doc,kernel,ids,scene}=fixture(false)
  try{
    const plan=TranslationPatchSession.create(scene,doc,ids)!,id=ids[0],original=JSON.stringify(scene.nodes)
    const window={x:40,y:40,w:80,h:80}
    for(const transform of [[0,1,-1,0,55,50],[1,0,0,1,Infinity,50],[1,0,0,1,500,50]] as Matrix[])
      expect(plan.prepare(scene,{[id]:transform},window)).toBeNull()
    expect(plan.prepare({...scene},{[id]:doc.nodes[id].transform},window)).toBeNull()
    expect(JSON.stringify(scene.nodes)).toBe(original)
    expect(plan.snapshot()).toEqual(doc)
    expect(TranslationPatchSession.create({...scene,softwareRaster:true},doc,ids)).toBeNull()
  }finally{kernel.free()}
})

test('stationary clipped background-blur ancestors admit nested patches, foreground blur does not',()=>{
  const {doc,kernel,ids,scene}=fixture(true)
  try{
    const root=doc.nodes[doc.pages[0].children[0]];root.effects=[effect('background-blur')]
    expect(TranslationPatchSession.create(scene,doc,ids)).not.toBeNull()
    root.clip=false;expect(TranslationPatchSession.create(scene,doc,ids)).toBeNull()
    root.clip=true;root.effects=[effect('blur')];expect(TranslationPatchSession.create(scene,doc,ids)).toBeNull()
    root.effects=[effect('glass')];expect(TranslationPatchSession.create(scene,doc,ids)).toBeNull()
  }finally{kernel.free()}
})
