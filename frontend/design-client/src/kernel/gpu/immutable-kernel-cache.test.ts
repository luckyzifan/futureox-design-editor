import { expect, test } from 'vitest'
import { ImmutableKernelCache, immutableKernelKey } from './immutable-kernel-cache'
import type { Texture } from './types'

const texture = (bytes = 16) => ({ width: bytes / 16, height: 1, bytes, resource: {} }) as Texture

test('LRU admission and global-pressure eviction require actual completion', () => {
  const destroyed: Texture[] = [], cache = new ImmutableKernelCache(32, 2, t => destroyed.push(t))
  const a = texture(), b = texture(), c = texture()
  expect(cache.put('a', a, 1, 0)).toBe(true)
  expect(cache.put('b', b, 1, 0)).toBe(true)
  expect(cache.put('c', c, 2, 0)).toBe(false)
  expect(cache.evictCompleted(32, 0)).toBe(0)
  expect(cache.get('a', 2)).toBe(a)
  expect(cache.put('c', c, 2, 1)).toBe(true)
  expect(destroyed).toEqual([b])
  expect(cache.bytes).toBe(32)
  expect(cache.evictCompleted(32, 1)).toBe(0)
  expect(cache.evictCompleted(16, 2)).toBe(16)
  expect(destroyed).toEqual([b, a])
  expect(cache.get('c', 3)).toBe(c)
  cache.abandon()
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
  expect(destroyed).toEqual([b, a]) // driver owns teardown, never double-destroy
})

test('count, byte and duplicate-ownership bounds are independent', () => {
  const cache = new ImmutableKernelCache(1024, 1, () => {})
  const a = texture()
  expect(cache.put('oversize', texture(2048), 1, 0)).toBe(false)
  expect(cache.put('a', a, 1, 0)).toBe(true)
  expect(cache.put('b', texture(), 1, 0)).toBe(false)
  expect(() => cache.put('a', texture(), 1, 0)).toThrow('Duplicate')
  expect(() => cache.put('alias', a, 1, 0)).toThrow('Duplicate')
})

test('operator, exact binary64 radius and color/storage domains cannot collide', () => {
  const keys = [
    immutableKernelKey('display-tent', 24, 'float:linear'),
    immutableKernelKey('rational-tent', 24, 'float:linear'),
    immutableKernelKey('rational-tent', 24, 'float:srgb'),
    immutableKernelKey('rational-tent', 24, 'byte:srgb'),
    immutableKernelKey('rational-box', 24, 'float:linear'),
    immutableKernelKey('certified-tent', 24, 'float:linear'),
    immutableKernelKey('rational-tent', 24 + 2 ** -48, 'float:linear'),
    immutableKernelKey('rational-tent', 0, 'float:linear'),
    immutableKernelKey('rational-tent', -0, 'float:linear'),
  ]
  expect(new Set(keys).size).toBe(keys.length)
  expect(() => immutableKernelKey('tent', NaN, 'float')).toThrow('Non-finite')
})
