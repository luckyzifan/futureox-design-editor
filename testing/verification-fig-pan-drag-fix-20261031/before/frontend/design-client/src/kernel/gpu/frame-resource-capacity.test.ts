import {expect,test} from 'vitest'
import {Buffer} from 'node:buffer'
import {documentCapacity} from '../../document-capacity'
import {FrameResources,frameResource} from './frame-resources'

test('host policy admits a real charged resource above the removed 32 MiB ceiling and keeps in-flight bytes owned',()=>{
  const store=new FrameResources(),lease=store.capture()
  expect(store.limit).toBe(documentCapacity().memoryBytes)
  const bytes=new TextEncoder().encode('x'.repeat(12*1024*1024))
  const resource=frameResource(1,1,bytes)
  expect(resource.size).toBeGreaterThan(32*1024*1024)
  expect(resource.size).toBeLessThan(store.limit)
  store.commit('native-owner',new Map([[1,resource]]),lease);lease.release()
  const inFlight=store.capture()
  expect(inFlight.entries.get(1)).toBe(resource)
  expect(store.bytes).toBe(resource.size)
  expect(Buffer.compare(resource.data,bytes)).toBe(0)
  store.clear();expect(store.bytes).toBe(resource.size)
  inFlight.release();inFlight.release();expect(store.bytes).toBe(0)
})

test('a smaller trusted host still enforces its actual allowance without uncharging pinned entries',()=>{
  const store=new FrameResources(1024),first=frameResource(1,1,new Uint8Array(200)),second=frameResource(2,1,new Uint8Array(200))
  const initial=store.capture();store.commit('A',new Map([[1,first]]),initial);initial.release()
  const inFlight=store.capture();store.commit('A',new Map([[2,second]]),inFlight)
  const next=store.capture();expect(next.entries.size).toBe(0);expect(store.bytes).toBe(first.size)
  next.release();inFlight.release();expect(store.bytes).toBe(0)
  const retry=store.capture();store.commit('A',new Map([[2,second]]),retry);retry.release()
  expect(store.bytes).toBe(second.size);expect(store.bytes).toBeLessThanOrEqual(store.limit)
})

test.each([NaN,Infinity,-1,2**53])('invalid memory allowance %s is rejected before cache ownership',limit=>{
  expect(()=>new FrameResources(limit)).toThrow('Invalid trusted frame resource memory allowance')
})

test('unchanged membership shares one immutable ACK cohort without revisiting per-resource pins',()=>{
  const store=new FrameResources(65536),seed=store.capture(),entry=frameResource(1,1,new Uint8Array(200))
  store.commit('A',new Map([[1,entry]]),seed);seed.release()
  let pins=entry.pins,reads=0
  Object.defineProperty(entry,'pins',{get(){reads++;return pins},set(value:number){pins=value},configurable:true})
  const first=store.capture();first.release();reads=0
  for(let i=0;i<100;i++){
    store.touch(1);const lease=store.capture()
    expect(lease.entries).toBe(first.entries);expect(lease.acknowledgement).toBe(first.acknowledgement)
    expect((lease.entries as Map<number,unknown>).set).toBeUndefined()
    expect(Object.isFrozen(lease.acknowledgement.ranges[0])).toBe(true)
    lease.release()
  }
  expect(reads).toBe(0);expect(pins).toBe(1)
  store.clear();expect(pins).toBe(0);expect(store.bytes).toBe(0)
})

test('membership publication creates a new cohort while old readers retain their exact dictionary',()=>{
  const store=new FrameResources(65536),seed=store.capture(),a=frameResource(1,1,new Uint8Array(100)),b=frameResource(3,1,new Uint8Array(100))
  store.commit('A',new Map([[1,a]]),seed);seed.release()
  const old=store.capture();store.commit('A',new Map([[3,b]]),old)
  const next=store.capture();expect(next.entries).not.toBe(old.entries)
  expect(old.entries.has(3)).toBe(false);expect(next.entries.has(3)).toBe(true)
  expect(next.acknowledgement.ranges).toEqual([[1,1],[3,3]])
  store.clear();expect(store.bytes).toBe(a.size+b.size)
  next.release();expect(store.bytes).toBe(a.size)
  old.release();expect(store.bytes).toBe(0)
})
test('retransmitted canonical resources already pinned by an old cohort are charged only once',()=>{
  const store=new FrameResources(1024),seed=store.capture(),a=frameResource(1,1,new Uint8Array(200)),b=frameResource(2,1,new Uint8Array(200))
  store.commit('A',new Map([[1,a]]),seed);seed.release()
  const old=store.capture();store.commit('A',new Map([[2,b]]),old)
  expect(store.bytes).toBe(a.size)
  store.commit('A',new Map([[1,a]]),old);expect(store.bytes).toBe(a.size)
  const next=store.capture();expect(next.entries.get(1)).toBe(a)
  store.clear();next.release();expect(store.bytes).toBe(a.size)
  old.release();expect(store.bytes).toBe(0)
})
test('foreign and completed leases cannot publish a resource dictionary',()=>{
  const a=new FrameResources(4096),b=new FrameResources(4096),lease=a.capture(),entry=frameResource(1,1,new Uint8Array(200))
  b.commit('A',new Map([[1,entry]]),lease);expect(b.bytes).toBe(0)
  lease.release();a.commit('A',new Map([[1,entry]]),lease);expect(a.bytes).toBe(0)
})
