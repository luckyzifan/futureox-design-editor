import { expect, test, vi } from 'vitest'
import { movingBackdropKey, staticBackdropKey } from './static-backdrop'
import { GpuRenderer } from './renderer'
import type { GpuScene, GpuNode } from './types'
function fixture() {
  const node=(id:string,children:string[]=[])=>({id,children,clip:true,rect:{x:0,y:0,w:32,h:32},matrix:[1,0,0,1,0,0],fills:[],strokes:[],effects:[]} as unknown as GpuNode)
  const root=node('root',['text']),before=node('before'),text=node('text')
  const scene={version:8,width:64,height:64,transparent:false,grid:false,vertices:[],interactionRetained:true,interactionSelection:['text'],coherentSamples:false,
    nodes:{root,before,text},roots:['before','root'],view:{x:0,y:0,zoom:1},extent:{x:0,y:0,w:64,h:64},background:'#ffffff'} as GpuScene
  return{scene,root}
}
test('moving backdrop proof binds static prefix and lease but permits translated crop changes',()=>{
  const {scene,root}=fixture();Object.assign(scene,{nativeInteraction:true,interactionLease:{},interactionSelection:['root']})
  const key=movingBackdropKey(scene,root)
  expect(key).toBeTypeOf('string')
  expect(movingBackdropKey(scene,{...root,rect:{...root.rect,x:17},matrix:[1,0,0,1,17.125,0]})).toBe(key)
  expect(movingBackdropKey({...scene,interactionLease:undefined},root)).toBeUndefined()
  expect(movingBackdropKey({...scene,interactionSelection:['before','root']},root)).toBeUndefined()
  expect(movingBackdropKey({...scene,coherentSamples:true},root)).toBeUndefined()
  expect(movingBackdropKey({...scene,nodes:{...scene.nodes,before:{...scene.nodes.before,previewDynamic:true}}},root)).toBeUndefined()
})
test('backdrop proof excludes earlier moving roots, moved roots, masks, optical policy changes and new camera lattices',()=>{
  const {scene,root}=fixture(),key=staticBackdropKey(scene,root)
  expect(key).toBeTypeOf('string')
  expect(staticBackdropKey({...scene,interactionSelection:['before','text']},root)).toBeUndefined()
  expect(staticBackdropKey({...scene,interactionSelection:['root']},root)).toBeUndefined()
  expect(staticBackdropKey(scene,{...root,passthrough:true})).toBeUndefined()
  expect(staticBackdropKey(scene,{...root,clip:false})).toBeUndefined()
  expect(staticBackdropKey({...scene,view:{...scene.view,x:.125}},root)).not.toBe(key)
  expect(staticBackdropKey({...scene,background:'#000000'},root)).not.toBe(key)
  scene.nodes.before={...scene.nodes.before,matrix:[1,0,0,1,3,0]}
  expect(staticBackdropKey(scene,root)).not.toBe(key)
  scene.nodes.before={...scene.nodes.before,previewDynamic:true}
  expect(staticBackdropKey(scene,root)).toBeUndefined()
})
test('stationary background is filtered once, retained ownership survives other uncached backdrops',()=>{
  const {scene,root}=fixture(),destroy=vi.fn(),renderer=new GpuRenderer({managed:true,captureDisplay:true,destroy} as any) as any
  renderer.scene=scene
  const make=()=>{const texture={bytes:32*32*16,width:32,height:32,resource:{}};renderer.bytes+=texture.bytes;renderer.busy.add(texture);return{texture,rect:root.rect}}
  renderer.copy=vi.fn(make);renderer.blur=vi.fn((surface:any)=>surface);renderer.copyInteractionSource=vi.fn(make)
  const backdrop=make(),first=renderer.interactionBackdrop(root,backdrop,4);renderer.release(first)
  const retained=renderer.stationaryBackdrop.plane.texture
  const second=renderer.interactionBackdrop(root,backdrop,4);expect(renderer.blur).toHaveBeenCalledTimes(1)
  expect(second.texture).toBe(retained);renderer.release(second);expect(renderer.busy.has(retained)).toBe(true)
  renderer.interactionBackdrop(scene.nodes.before,backdrop,4)
  expect(destroy).not.toHaveBeenCalled();expect(renderer.stationaryBackdrop.plane.texture).toBe(retained)
  renderer.retireStationaryBackdrop();expect(destroy).toHaveBeenCalledWith(retained);expect(renderer.interactionBytes).toBe(0)
})
test('native recompiles may share only the same proven transform lease and sampling contract',()=>{
  const {scene,root}=fixture(),destroy=vi.fn(),renderer=new GpuRenderer({managed:true,captureDisplay:true,destroy} as any) as any
  const lease={};renderer.scene={...scene,interactionLease:lease}
  const make=()=>{const texture={bytes:32*32*16,width:32,height:32,resource:{}};renderer.bytes+=texture.bytes;renderer.busy.add(texture);return{texture,rect:root.rect}}
  renderer.copy=vi.fn(make);renderer.blur=vi.fn((s:any)=>s);renderer.copyInteractionSource=vi.fn(make)
  const backdrop=make();renderer.release(renderer.interactionBackdrop(root,backdrop,4))
  renderer.scene={...scene,nodes:{...scene.nodes},interactionLease:lease}
  renderer.release(renderer.interactionBackdrop(root,backdrop,4));expect(renderer.blur).toHaveBeenCalledTimes(1)
  renderer.release(renderer.interactionBackdrop(root,backdrop,5));expect(renderer.blur).toHaveBeenCalledTimes(2)
  renderer.scene={...scene,nodes:{...scene.nodes},interactionLease:{}}
  renderer.release(renderer.interactionBackdrop(root,backdrop,5));expect(renderer.blur).toHaveBeenCalledTimes(3)
})
test('both stationary and moving backdrop caches separate display-radius intent and normalize the exact lane',()=>{
  const {scene,root}=fixture()
  const staticExact=staticBackdropKey(scene,root)
  expect(staticBackdropKey({...scene,displayTentRadius:false},root)).toBe(staticExact)
  expect(staticBackdropKey({...scene,displayTentRadius:true},root)).not.toBe(staticExact)
  const moving={...scene,nativeInteraction:true,interactionLease:{},interactionSelection:['root']}
  const movingExact=movingBackdropKey(moving,root)
  expect(movingBackdropKey({...moving,displayTentRadius:false},root)).toBe(movingExact)
  expect(movingBackdropKey({...moving,displayTentRadius:true},root)).not.toBe(movingExact)
})
