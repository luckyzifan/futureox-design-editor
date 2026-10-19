import { decodeScenePacket } from './gpu/scene-packet'
import { expect, test } from 'vitest'
import { CompiledPacketCache } from './compiled-packet-cache'
test('compiler packet ownership is isolated and LRU admission remains bounded',()=>{
  const cache=new CompiledPacketCache(270,4),a=new Uint8Array([1,2,3,4])
  cache.put('a',a);a[0]=9
  const hit=cache.get('a')!;expect(hit[0]).toBe(1);hit[0]=8;expect(cache.get('a')![0]).toBe(1)
  cache.put('b',a);cache.get('a');cache.put('c',a)
  expect(cache.get('b')).toBeUndefined();expect(cache.get('a')).toBeDefined();expect(cache.bytes).toBeLessThanOrEqual(270)
  cache.put('large',new Uint8Array(5));expect(cache.get('large')).toBeUndefined()
  cache.clear();expect(cache.bytes).toBe(0);expect(cache.get('a')).toBeUndefined()
})

test('regional packets survive only certified translations disjoint from both dependencies and the read halo',async()=>{
  const { VectorEngine }=await import('../generated/design-kernel/design_kernel')
  const {blank,node,paint}=await import('../model')
  const doc=blank(),left=node('rectangle',20,20,30,30),right=node('rectangle',700,20,30,30)
  left.fills=[paint('#3399ff')];right.fills=[paint('#ff9933')]
  doc.nodes[left.id]=left;doc.nodes[right.id]=right;doc.pages[0].children=[left.id,right.id]
  const kernel=new VectorEngine();kernel.load_document(JSON.stringify(doc))
  try{
    const options=JSON.stringify({pageId:doc.pages[0].id,width:128,height:128,view:{x:.25,y:.5,zoom:1},
      gpuViewport:{x:0,y:0,w:128,h:128},prepareViewport:{x:0,y:0,w:900,h:200}})
    const packet=kernel.compile_gpu_packet(options),cache=new CompiledPacketCache()
    cache.put(options,packet,true);cache.certify(options,decodeScenePacket(packet))
    cache.applyDamage({full:false,translationOnly:true,rects:[[695,15,45,45]]},[right.id])
    expect(cache.get(options)).toEqual(packet);expect(cache.retained).toBe(1)
    // Same-size changes, a dependency whose paint damage is elsewhere, and
    // non-certified changes must not accidentally reuse old scene commands.
    cache.applyDamage({full:false,translationOnly:true,rects:[[695,15,45,45]]},[left.id])
    expect(cache.get(options)).toBeUndefined()
    for(const damage of [{full:true,translationOnly:true},{full:false,rects:[[695,15,45,45]]},
      {full:false,translationOnly:true,rects:[[125,20,40,40]]}] as const){
      cache.put(options,packet,true);cache.certify(options,decodeScenePacket(packet));cache.applyDamage(damage as any,[right.id]);expect(cache.get(options)).toBeUndefined()
    }
    cache.put(options,packet);cache.applyDamage({full:false,translationOnly:true,rects:[]},[])
    expect(cache.get(options)).toBeUndefined();expect(cache.bytes).toBe(0)
  }finally{kernel.free()}
})
