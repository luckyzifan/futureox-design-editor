import { expect, test } from 'vitest'
import { exactTilePayloadBytes, OwnerTileCache, ownsExactTileBytes } from './owner-tile-cache'
import { compilationWitness as w } from './exact-tile-cache'
const fixture = (limit?: number) => { const cache = new OwnerTileCache<number>(limit); return { cache, a: cache.owner('canvas'), b: cache.owner('interaction') } }
test('canvas interaction canvas preserves actual isolated hits', () => {
  const {cache,a,b}=fixture(); a.set('x',w('same'),1,4)
  expect(b.certified('x')).toBeUndefined(); b.set('x',w('same'),2,4)
  expect(cache.owner('canvas').certified('x')).toBe(1); expect(b.get('x',w('same'))).toBe(2)
})
test('interleaved patches revoke only changed owner and reject stale completion', () => {
  const {a,b}=fixture(); a.set('x',w('old'),1,4); a.set('y',w('same'),2,4); b.set('x',w('old'),3,4)
  const old=a.capture(); a.revoke(v=>v===1)
  expect(a.certified('x')).toBeUndefined(); expect(a.certified('y')).toBe(2); expect(b.certified('x')).toBe(3)
  expect(a.set('x',w('late'),99,4,old)).toBe(false); expect(a.get('x',w('old'))).toBe(1)
  a.revoke(()=>true); expect(a.get('x',w('new image'))).toBeUndefined(); expect(b.certified('x')).toBe(3)
})
for(const reason of ['full document reopen','embedded fonts','image resource reset','history restore','session reset']) test(reason+' invalidates only its owner',()=>{
  const {a,b}=fixture(); a.set('x',w('a'),1,4); b.set('x',w('b'),2,4)
  const old=a.capture(), other=b.capture(); a.clear()
  expect(a.certified('x')).toBeUndefined(); expect(b.certified('x')).toBe(2)
  expect(a.set('x',w('late'),1,4,old)).toBe(false); expect(b.current(other)).toBe(true)
})
test('quality and session namespaces never certify another variant',()=>{
  const {a}=fixture(); for(const [s,v] of [['session1/preview',1],['session1/settle',2],['session2/settle',3]] as const)a.set(s,w(String(v)),v,4)
  expect(a.certified('session1/preview')).toBe(1); expect(a.certified('session1/settle')).toBe(2)
  expect(a.certified('session2/settle')).toBe(3); expect(a.certified('session2/export')).toBeUndefined()
})
test('device/config reset invalidates every owner and stale response; tickets bind owner',()=>{
  const {cache,a,b}=fixture(); a.set('x',w('a'),1,4); b.set('x',w('b'),2,4)
  const x=a.capture(), y=b.capture(); expect(b.set('x',w('wrong'),9,4,x)).toBe(false)
  cache.clear(); expect(cache.size).toBe(0); expect(cache.bytes).toBe(OwnerTileCache.ownerMetadataBytes)
  expect(a.set('x',w('late'),1,4,x)).toBe(false); expect(b.set('x',w('late'),2,4,y)).toBe(false)
  expect(a.set('x',w('new'),3,4,a.capture())).toBe(true)
})
test('one global LRU and aggregate budget includes owner metadata',()=>{
  const {cache,a,b}=fixture(2174); a.set('x',w('1'),1,4); b.set('x',w('2'),2,4)
  expect(cache.size).toBe(2); expect(a.certified('x')).toBe(1); b.set('y',w('3'),3,4)
  expect(cache.size).toBe(2); expect(cache.bytes).toBeLessThanOrEqual(2174)
  expect(b.certified('x')).toBeUndefined(); expect(a.certified('x')).toBe(1); expect(cache.evictions).toBe(1)
})
test('transfer bitmaps and driver texture leases are not CPU byte cache payloads',()=>{
  const buffer=new ArrayBuffer(4); expect(ownsExactTileBytes({buffer})).toBe(true)
  expect(ownsExactTileBytes({buffer,bitmap:{}})).toBe(false); expect(ownsExactTileBytes({buffer,gpuTile:0})).toBe(false)
  expect(ownsExactTileBytes({buffer:new ArrayBuffer(0)})).toBe(false)
})

test('tile admission charges owned buffers and variable strings without serializing the render result',()=>{
  const tile={buffer:new ArrayBuffer(128),backend:'webgpu',intermediateFormat:'rgba8unorm',
    description:'adapter',reason:'',toJSON(){throw Error('unexpected serialization')}}
  const base=exactTilePayloadBytes(tile)
  const reason='\u0000中'.repeat(2000)
  expect(exactTilePayloadBytes({...tile,linearBuffer:new ArrayBuffer(512),reason})).toBe(base+512+reason.length*2)
  expect(exactTilePayloadBytes({...tile,colorManagement:{documentSpace:'srgb'}})).toBe(base+8)
})

test('deterministic exact-byte replay reports saved compile/render work, not generic cache percentages',()=>{
  const run=(clearOnSwitch:boolean)=>{
    const {cache}=fixture(); let previous=''; let hits=0, compiled=0, rendered=0
    for(const lane of ['canvas','interaction','canvas','interaction','canvas']) {
      if(clearOnSwitch && previous!==lane)cache.clear()
      previous=lane; const owner=cache.owner(lane)
      for(const tile of ['left','right']) {
        if(owner.certified(tile)!==undefined){hits++;continue}
        compiled++;rendered++;owner.set(tile,w(lane+'/'+tile),1,16)
      }
    }
    return {hits,compiled,rendered,bytes:cache.bytes}
  }
  const before=run(true), after=run(false)
  expect(before).toMatchObject({hits:0,compiled:10,rendered:10})
  expect(after).toMatchObject({hits:6,compiled:4,rendered:4})
  expect(after.bytes).toBeLessThanOrEqual(128*1024*1024)
})

test('owner metadata is reserved and unbounded owner creation is rejected',()=>{
  const {cache}=fixture(); expect(cache.bytes).toBe(OwnerTileCache.ownerMetadataBytes)
  expect(()=>cache.owner('arbitrary')).toThrow('owner')
  const tiny=new OwnerTileCache<number>(0); tiny.owner('canvas').set('x',w('x'),1,4); expect(tiny.bytes).toBe(0)
})
