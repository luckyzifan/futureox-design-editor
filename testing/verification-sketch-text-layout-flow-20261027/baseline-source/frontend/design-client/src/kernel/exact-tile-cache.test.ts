import { test, expect } from 'vitest'
import { ExactTileCache, compilationWitness as w, coordinateSlot, sameBytes } from './exact-tile-cache'

test('damage revokes certificates without losing exact compilation witnesses', () => {
  const cache=new ExactTileCache<number>();cache.set('a',w('a'),1,4);cache.set('b',w('b'),2,4)
  cache.revoke(value=>value===1)
  expect(cache.certified('a')).toBeUndefined();expect(cache.certified('b')).toBe(2)
  expect(cache.get('a',w('a'))).toBe(1);expect(cache.certified('a')).toBe(1)
  cache.revoke(()=>true)
  expect(cache.get('a',w('changed'))).toBeUndefined();expect(cache.certified('a')).toBeUndefined()
  expect(cache.get('b',w('b'))).toBe(2)
})

test('full raw compilation preserves signed zero, number precision, order, roots and masks', () => {
  const raw = '{"x":-0.0,"vertices":[1.0000001192092896],"children":["missing"],"maskId":"mask"}'
  const c = new ExactTileCache<string>()
  for (const next of [raw.replace('-0.0','0.0'), raw.replace('1.0000001192092896','1.0'),
    raw.replace('["missing"]','[]'),raw.replace('"maskId":"mask"','"maskId":null')]) {
    c.set('slot',w(raw),'old',4)
    expect(c.get('slot',w(next))).toBeUndefined()
    expect(c.size).toBe(0)
  }
  c.set('slot',w(raw),'exact',4)
  expect(c.get('slot',w(raw))).toBe('exact')
})
test('same length and prefix are insufficient; every byte is compared with no hash assumption', () => {
  const a=w('same-prefix-A'), b=w('same-prefix-B')
  expect(a.length).toBe(b.length)
  expect(sameBytes(a,b)).toBe(false)
  const c=new ExactTileCache<string>();c.set('slot',a,'old',4)
  expect(c.get('slot',b)).toBeUndefined()
})
test('slot key keeps all f64 camera and phase bits', () => {
  expect(coordinateSlot([0])).not.toBe(coordinateSlot([-0]))
  expect(coordinateSlot([1])).not.toBe(coordinateSlot([1+Number.EPSILON]))
  expect(coordinateSlot([-1.5,0.5,4])).toBe(coordinateSlot([-1.5,0.5,4]))
  expect(()=>coordinateSlot([NaN])).toThrow('coordinate')
})
test('key bytes, UTF16 slot, metadata and value all count toward the budget', () => {
  const cost=4+3+2+ExactTileCache.entryOverhead
  const c=new ExactTileCache<string>(cost)
  c.set('a',w('abc'),'value',4);expect(c.bytes).toBe(cost)
  c.set('b',w('abcd'),'large',4)
  expect(c.get('b',w('abcd'))).toBeUndefined();expect(c.bytes).toBe(cost)
  c.clear();expect(c.bytes).toBe(0);expect(c.size).toBe(0)
  expect(()=>c.set('bad',w('a'),'x',NaN)).toThrow('payload')
})
test('signature changes replace the same coordinate without cascading eviction', () => {
  const cost=4+1+2+ExactTileCache.entryOverhead
  const c=new ExactTileCache<string>(cost*3)
  for(const id of ['a','b','c'])c.set(id,w('0'),id,4)
  expect(c.get('a',w('1'))).toBeUndefined()
  c.set('a',w('1'),'new-a',4)
  expect(c.get('b',w('0'))).toBe('b')
  expect(c.get('c',w('0'))).toBe('c')
  expect(c.size).toBe(3);expect(c.bytes).toBe(cost*3)
})
test('LRU eviction, replacement, oversize replacement and immutable witness ownership', () => {
  const cost=4+1+2+ExactTileCache.entryOverhead,c=new ExactTileCache<string>(cost*2)
  const witness=w('0');c.set('a',witness,'a',4);witness[0]=255
  expect(c.get('a',w('0'))).toBe('a')
  c.set('b',w('0'),'b',4);c.get('a',w('0'));c.set('c',w('0'),'c',4)
  expect(c.get('b',w('0'))).toBeUndefined();expect(c.size).toBe(2)
  c.set('a',w('1'),'oversize',cost*3)
  expect(c.get('a',w('0'))).toBeUndefined();expect(c.size).toBe(1)
})
test('shared owner/render envelope consumes the same bounded cache budget', () => {
  const c=new ExactTileCache<string>(1024)
  c.reserve(600)
  c.set('a',w('raw'),'no-room',10)
  expect(c.size).toBe(0);expect(c.bytes).toBe(600)
  c.clear();expect(c.bytes).toBe(0)
  expect(()=>c.reserve(1025)).toThrow('envelope')
})

test('diagnostics explain cache misses and eviction without exposing keys or affecting lookup',()=>{
  const reasons:number[]=[]
  const cache=new ExactTileCache<number>(1100,(reason,bytes)=>{reasons.push(reason);expect(Number.isFinite(bytes)).toBe(true)})
  expect(cache.get('private-key',new Uint8Array([1]))).toBeUndefined()
  cache.set('a',new Uint8Array([1]),1,1)
  cache.revoke(()=>true);expect(cache.certified('a')).toBeUndefined()
  expect(cache.get('a',new Uint8Array([2]))).toBeUndefined()
  cache.set('a',new Uint8Array([1]),1,1);cache.set('b',new Uint8Array([1]),2,1);cache.set('c',new Uint8Array([1]),3,1)
  cache.set('big',new Uint8Array([1]),3,5000);cache.clear()
  for(const code of [10,11,12,13,14,15])expect(reasons).toContain(code)
  const safe=new ExactTileCache<number>(1100,()=>{throw Error('sink failed')})
  expect(safe.get('a',new Uint8Array())).toBeUndefined()
})
