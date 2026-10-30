import { test, expect } from 'vitest'
import { CoverageCache } from './coverage-cache'
import type { Texture } from './types'
const texture = (bytes = 16): Texture => ({
  bytes,
  width: 2,
  height: 2,
  resource: {} as GPUTexture,
})
test('hash collisions require full exact vertex equality and copied ownership', () => {
  const c = new CoverageCache(1024, 10, () => {}),
    a = texture(),
    bits = new Uint32Array([1, 2, 3])
  c.begin()
  c.put('collision', bits, a)
  bits[0] = 9
  expect(c.get('collision', new Uint32Array([1, 2, 3]))).toBe(a)
  expect(c.get('collision', new Uint32Array([1, 2, 4]))).toBeUndefined()
  expect(c.get('collision', new Uint32Array([1, 2]))).toBeUndefined()
})
test('current-frame textures stay pinned while old entries are evicted by LRU', () => {
  const destroyed: Texture[] = [],
    c = new CoverageCache(48, 2, (t) => destroyed.push(t)),
    a = texture(),
    b = texture(),
    d = texture(),
    bits = new Uint32Array([1, 2])
  c.begin()
  expect(c.put('a', bits, a)).toBe(true)
  expect(c.put('b', bits, b)).toBe(true)
  expect(c.put('d', bits, d)).toBe(false)
  expect(destroyed).toHaveLength(0)
  c.begin()
  expect(c.get('a', bits)).toBe(a)
  expect(c.put('d', bits, d)).toBe(true)
  expect(destroyed).toEqual([b])
  expect(c.has(a)).toBe(true)
  expect(c.has(d)).toBe(true)
  expect(c.bytes).toBe(48)
})
test('global budget eviction respects commands in this frame and clear releases all', () => {
  const destroyed: Texture[] = [],
    c = new CoverageCache(1024, 10, (t) => destroyed.push(t)),
    a = texture(),
    b = texture(),
    bits = new Uint32Array([2])
  c.begin()
  c.put('a', bits, a)
  c.put('b', bits, b)
  c.begin()
  c.get('a', bits)
  c.evictUnused(999)
  expect(destroyed).toEqual([b])
  c.clear()
  expect(destroyed).toEqual([b, a])
  expect(c.bytes).toBe(0)
  expect(c.get('a', bits)).toBeUndefined()
})
test('oversized entries are not admitted', () => {
  const c = new CoverageCache(16, 2, () => {})
  c.begin()
  expect(c.put('large', new Uint32Array([1]), texture(16))).toBe(false)
  expect(c.bytes).toBe(0)
})
test('explicit ownership transfer removes all current-frame aliases without destroying their texture', () => {
  const destroyed: Texture[] = [], cache = new CoverageCache(1024, 10, (value) => destroyed.push(value))
  const shared = texture(), other = texture(), bits = new Uint32Array([1, 2])
  cache.begin()
  cache.put('first', bits, shared); cache.put('second', bits, shared); cache.put('other', bits, other)
  expect(cache.remove(shared)).toBe(true)
  expect(cache.get('first', bits)).toBeUndefined(); expect(cache.get('second', bits)).toBeUndefined()
  expect(cache.has(shared)).toBe(false); expect(cache.get('other', bits)).toBe(other)
  expect(cache.bytes).toBe(other.bytes + bits.byteLength)
  expect(destroyed).toEqual([])
  expect(cache.remove(shared)).toBe(false)
  cache.clear(); expect(destroyed).toEqual([other])
})

test('aliases destroy their shared physical texture exactly once', () => {
  const destroyed: Texture[] = [], cache = new CoverageCache(1024, 10, value => destroyed.push(value))
  const shared = texture(), bits = new Uint32Array([1])
  cache.begin(); cache.put('a', bits, shared); cache.put('b', bits, shared)
  cache.begin(); cache.get('b', bits); cache.evictUnused(1000)
  expect(destroyed).toEqual([]); expect(cache.has(shared)).toBe(true)
  cache.clear(); expect(destroyed).toEqual([shared])
})

test('a new alias pins an existing texture before cache admission', () => {
  const destroyed: Texture[] = [], cache = new CoverageCache(20, 1, value => destroyed.push(value))
  const shared = texture(), bits = new Uint32Array([1])
  cache.begin(); cache.put('a', bits, shared); cache.begin()
  expect(cache.put('b', bits, shared)).toBe(false)
  expect(cache.has(shared)).toBe(true); expect(destroyed).toEqual([])
})
