import { test, expect } from 'vitest'
import { CoefficientByteCache } from './coefficient-byte-cache'

test('copies producer bytes once, hits borrow owned storage without clones', () => {
  const cache = new CoefficientByteCache(32, 4), producer = new Uint8Array([1, 2, 3, 4])
  const owned = cache.put('a', producer)!
  expect(owned).not.toBe(producer); expect(owned.buffer).not.toBe(producer.buffer)
  producer.fill(9)
  expect([...owned]).toEqual([1, 2, 3, 4])
  expect(cache.get('a')).toBe(owned); expect(cache.get('a')).toBe(owned)
  expect(cache.bytes).toBe(4)
})
test('cache storage survives WASM memory growth and producer view detachment', () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 })
  const producer = new Uint8Array(memory.buffer, 0, 4); producer.set([1, 2, 3, 4])
  const cache = new CoefficientByteCache(32, 4), owned = cache.put('a', producer)!
  memory.grow(1)
  expect(producer.byteLength).toBe(0); expect([...cache.get('a')!]).toEqual([1, 2, 3, 4])
  expect(owned.buffer.byteLength).toBe(4)
})
test('byte and entry pressure evict least recently read values only', () => {
  const cache = new CoefficientByteCache(8, 2)
  const a = cache.put('a', new Uint8Array(4))!
  cache.put('b', new Uint8Array(4)); expect(cache.get('a')).toBe(a)
  cache.put('c', new Uint8Array(4))
  expect(cache.get('b')).toBeUndefined(); expect(cache.get('a')).toBe(a)
  expect(cache.size).toBe(2); expect(cache.bytes).toBe(8)
  cache.put('d', new Uint8Array(8))
  expect(cache.size).toBe(1); expect(cache.bytes).toBe(8)
  // A borrowed CPU reference remains valid even after map eviction.
  expect(a.byteLength).toBe(4)
  cache.clear(); expect(cache.size).toBe(0); expect(cache.bytes).toBe(0)
})
test('oversize, empty and disabled admission do not evict existing entries', () => {
  const cache = new CoefficientByteCache(4, 1), a = cache.put('a', new Uint8Array(4))!
  expect(cache.put('huge', new Uint8Array(5))).toBeUndefined()
  expect(cache.put('empty', new Uint8Array())).toBeUndefined()
  expect(cache.get('a')).toBe(a); expect(cache.bytes).toBe(4)
  expect(new CoefficientByteCache(4, 0).put('a', a)).toBeUndefined()
  expect(new CoefficientByteCache(0, 1).put('a', a)).toBeUndefined()
})
test('duplicate admission and invalid bounds fail without corrupting accounting', () => {
  const cache = new CoefficientByteCache(4, 1), a = cache.put('a', new Uint8Array(4))!
  expect(() => cache.put('a', new Uint8Array(1))).toThrow('Duplicate')
  expect(cache.get('a')).toBe(a); expect(cache.bytes).toBe(4)
  for (const bad of [-1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => new CoefficientByteCache(bad, 1)).toThrow('Invalid')
    expect(() => new CoefficientByteCache(4, bad)).toThrow('Invalid')
  }
})
