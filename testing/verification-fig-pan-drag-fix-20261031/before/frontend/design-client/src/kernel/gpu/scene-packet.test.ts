import { expect, test, vi } from 'vitest'
import { VectorEngine } from '../../generated/design-kernel/design_kernel'
import { blank, node, paint } from '../../model'
import { decodeScenePacket, copyScenePacket, scenePacketWitness, CompiledScenePacket } from './scene-packet'
import { FrameResources, frameResource } from './frame-resources'
import { decodeFrameValue } from './frame-wire'
import { emptyFrame, frameValue } from './frame-wire.test-helper'
import {copyWitness} from '../compilation-witness'
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhxsAAAAASUVORK5CYII='
function fixture(){
  const doc=blank(),shape=node('ellipse',.3,-.7,43.8,27.9),image={...paint('#ffffff'),kind:'image' as const,image:png}
  shape.fills=[image,{...image,opacity:.5}];doc.nodes[shape.id]=shape;doc.pages[0].children=[shape.id]
  const engine=new VectorEngine();engine.load_document(JSON.stringify(doc))
  return {engine,shape,options:{pageId:doc.pages[0].id,width:64,height:64,view:{x:.125,y:-.375,zoom:1.137},rasterProfile:'figmaSubpixel'}}
}
function sameScene(actual:any,expected:any){
  expect({...actual,vertices:[],curves:[]}).toEqual({...expected,vertices:[],curves:[]})
  for(const key of ['vertices','curves']) {
    const values=actual[key] as Float32Array,reference=new Float32Array(expected[key])
    expect([...new Uint32Array(values.buffer,values.byteOffset,values.length)]).toEqual([...new Uint32Array(reference.buffer)])
  }
}
test('materialized handoffs retain exact geometry and witnesses without replicating transport resource bodies',()=>{
  const f=fixture();f.engine.bind_frame_scene_scope('decoded-handoff')
  try{
    const bytes=f.engine.compile_gpu_packet(JSON.stringify(f.options)),source=decodeScenePacket(bytes)
    const h=new DataView(bytes.buffer,bytes.byteOffset),nv=h.getUint32(12,true),nc=h.getUint32(16,true)
    expect(nv+nc).toBeGreaterThan(0)
    expect(h.getUint32(20,true)).toBeGreaterThan(0)
    const a=CompiledScenePacket.from(bytes,true),b=CompiledScenePacket.from(bytes,true)
    sameScene(decodeScenePacket(a),source);sameScene(decodeScenePacket(b),source)
    if(!(a.scene.vertices instanceof Float32Array)||!(b.scene.vertices instanceof Float32Array))throw Error('Expected typed geometry')
    expect(a.scene.vertices.buffer.byteLength).toBe((nv+nc)*4)
    expect(a.scene.vertices.buffer).not.toBe(b.scene.vertices.buffer)
    expect(a.transport.scenePacketBytes).toBe(bytes.length)
    expect(copyWitness(scenePacketWitness(a))).toEqual(copyWitness(scenePacketWitness(bytes)))
    const before=new Uint8Array(b.scene.vertices.buffer).slice()
    new Uint8Array(a.scene.vertices.buffer)[0]^=1
    expect(new Uint8Array(b.scene.vertices.buffer)).toEqual(before)
    const store=new FrameResources(),lease=store.capture()
    try{expect(()=>decodeScenePacket(a,store,lease)).toThrow('resource lease')}finally{lease.release()}
  }finally{f.engine.free()}
})
test('Rust binary frame preserves the JSON oracle, numeric values, resources and exact f32 words',()=>{
  const f=fixture()
  try{const reference=JSON.parse(f.engine.compile_gpu(JSON.stringify(f.options))),packet=f.engine.compile_gpu_packet(JSON.stringify(f.options))
    expect(new DataView(packet.buffer,packet.byteOffset).getUint32(0,true)).toBe(0x43534746)
    for(const padding of [0,1,4]){const copy=new Uint8Array(packet.length+padding);copy.set(packet,padding);sameScene(decodeScenePacket(copy.subarray(padding)),reference)}
  }finally{f.engine.free()}
})
test('acknowledged frame resources remove repeated payloads and retain exact shader storage',()=>{
  const f=fixture(),store=new FrameResources();f.engine.bind_frame_scene_scope('producer-A')
  const run=()=>{const lease=store.capture();try{const bytes=f.engine.compile_gpu_packet(JSON.stringify({...f.options,frameResources:lease.acknowledgement}));return {bytes,scene:decodeScenePacket(bytes,store,lease)}}finally{lease.release()}}
  try{const first=run(),second=run()
    expect(new DataView(first.bytes.buffer).getUint32(20,true)).toBeGreaterThan(0)
    expect(new DataView(second.bytes.buffer).getUint32(20,true)).toBe(0)
    sameScene(second.scene,first.scene);expect(second.scene.nodes[f.shape.id]).toBe(first.scene.nodes[f.shape.id])
    expect(scenePacketWitness(second.bytes)).toEqual(scenePacketWitness(first.bytes))
    expect(()=>decodeScenePacket(second.bytes.slice())).toThrow('Missing frame resource')
    const copy=copyScenePacket(second.bytes);sameScene(decodeScenePacket(copy),first.scene);copy[0]=0;expect(second.bytes[0]).toBe(70)
    store.clear();const reset=run();expect(new DataView(reset.bytes.buffer).getUint32(20,true)).toBeGreaterThan(0);sameScene(reset.scene,first.scene)
    f.engine.bind_frame_scene_scope('producer-B');const rebound=run();sameScene(rebound.scene,first.scene)
    expect(scenePacketWitness(rebound.bytes)).not.toEqual(scenePacketWitness(first.bytes))
  }finally{f.engine.free()}
})
test('program storage owns only geometry while its exact witness retains the original complete byte proof',()=>{
  const f=fixture();f.engine.bind_frame_scene_scope('independent-program-storage')
  try{
    const packet=f.engine.compile_gpu_packet(JSON.stringify(f.options)),header=new DataView(packet.buffer,packet.byteOffset)
    const start=Math.ceil((24+header.getUint32(8,true))/4)*4,nv=header.getUint32(12,true),nc=header.getUint32(16,true)
    const expected=packet.slice(0,start+(nv+nc)*4);new DataView(expected.buffer).setUint32(20,0,true)
    const scene=decodeScenePacket(packet)
    if(!(scene.vertices instanceof Float32Array)||!(scene.curves instanceof Float32Array))throw Error('Decoder did not retain exact typed program storage')
    expect(scene.vertices.buffer).not.toBe(packet.buffer);expect(scene.curves.buffer).toBe(scene.vertices.buffer)
    expect(scene.vertices.buffer.byteLength).toBe((nv+nc)*4)
    expect(copyWitness(scenePacketWitness(packet))).toEqual(expected)
    const programs=new Uint8Array(scene.vertices.buffer),before=programs.slice()
    packet[start]^=1
    expect(programs).toEqual(before);expect(copyWitness(scenePacketWitness(packet))).toEqual(expected)
  }finally{f.engine.free()}
})
test('retired acknowledged resources stay charged until their old request lease releases',()=>{
  const store=new FrameResources(),lease=store.capture(),entry=frameResource(1,1,new TextEncoder().encode('resource'))
  store.commit('A',new Map([[1,entry]]),lease);lease.release();const pinned=store.capture(),before=store.bytes
  store.clear();expect(store.bytes).toBe(before)
  store.commit('A',new Map([[1,entry]]),pinned);expect(store.capture().entries.size).toBe(0)
  pinned.release();pinned.release();expect(store.bytes).toBe(0)
})
test('a materialization hit validates every image dependency without allocating fill or stroke arrays',()=>{
  const f=fixture(),store=new FrameResources();f.engine.bind_frame_scene_scope('materialization')
  const firstLease=store.capture()
  const first=decodeScenePacket(f.engine.compile_gpu_packet(JSON.stringify({...f.options,frameResources:firstLease.acknowledgement})),store,firstLease)
  firstLease.release();const lease=store.capture()
  try{
    const raw=[...lease.entries.values()].find(entry=>entry.kind===2&&entry.value.node.id===f.shape.id)!.value.node
    const packet=f.engine.compile_gpu_packet(JSON.stringify({...f.options,frameResources:lease.acknowledgement}))
    const mapping=vi.spyOn(Array.prototype,'map')
    let next,mapped=0
    try{next=decodeScenePacket(packet,store,lease);mapped=mapping.mock.contexts.filter(context=>context===raw.fills||context===raw.strokes).length}finally{mapping.mockRestore()}
    expect(next.nodes[f.shape.id]).toBe(first.nodes[f.shape.id])
    expect(mapped).toBe(0)
    const withoutImages={...lease,entries:new Map([...lease.entries].filter(([,entry])=>entry.kind!==1))}
    expect(()=>decodeScenePacket(packet.slice(),undefined,withoutImages)).toThrow('Missing frame resource')
  }finally{lease.release();f.engine.free()}
})
test('old packet formats, truncation, extra bytes and invalid binary tags fail before publication',()=>{
  const bytes=emptyFrame(7)
  expect(decodeScenePacket(bytes).width).toBe(7)
  for(let i=0;i<bytes.length;i++)expect(()=>decodeScenePacket(bytes.slice(0,i))).toThrow()
  const old=bytes.slice();new DataView(old.buffer).setUint32(0,0x4b504746,true);expect(()=>decodeScenePacket(old)).toThrow('Unsupported')
  const extra=new Uint8Array(bytes.length+1);extra.set(bytes);expect(()=>decodeScenePacket(extra)).toThrow('length')
  const invalid=bytes.slice();invalid[24]=255;expect(()=>decodeScenePacket(invalid)).toThrow('metadata tag')
})
test('metadata retains strings, signed zero, nested arrays and hostile property names without prototype mutation',()=>{
  const value=JSON.parse('{"__proto__":{"safe":true},"text":"原样\\n\\\"\\\\😀","values":[null,false,true,0.1]}')
  value.zero=-0;const decoded=decodeFrameValue(frameValue(value))
  expect(decoded).toEqual(value);expect(Object.is(decoded.zero,-0)).toBe(true);expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
  expect(({} as any).safe).toBeUndefined()
})

test('a changed descendant revokes its containing compiled-source identity',async()=>{
  const {sameCompiledSource}=await import('./source-identity')
  const f=fixture(),parent=node('group',0,0,80,60),store=new FrameResources()
  const doc=blank();doc.nodes[parent.id]=parent;doc.nodes[f.shape.id]=f.shape;parent.children=[f.shape.id];doc.pages[0].children=[parent.id]
  f.engine.load_document(JSON.stringify(doc));f.engine.bind_frame_scene_scope('subtree')
  const options={...f.options,pageId:doc.pages[0].id}
  const compile=()=>{const lease=store.capture();try{return decodeScenePacket(f.engine.compile_gpu_packet(JSON.stringify({...options,frameResources:lease.acknowledgement})),store,lease)}finally{lease.release()}}
  try{
    const first=compile(),again=compile();expect(sameCompiledSource(first.nodes[parent.id],again.nodes[parent.id],first,again)).toBe(true)
    const changed={...f.shape,fills:[paint('#ff0000')]};store.invalidate()
    f.engine.apply_document_patch_with_damage(JSON.stringify({fields:{},nodes:{[changed.id]:changed}}))
    const next=compile();expect(sameCompiledSource(first.nodes[parent.id],next.nodes[parent.id],first,next)).toBe(false)
    expect(()=>{next.nodes[parent.id].opacity=.5}).toThrow()
  }finally{f.engine.free()}
})
