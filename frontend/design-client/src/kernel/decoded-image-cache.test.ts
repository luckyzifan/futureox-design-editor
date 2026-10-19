import { expect, test } from 'vitest'
import { DecodedImageCache, imageCacheVictims, validDecodedImage } from './decoded-image-cache'

const image = (data: Uint8Array | Float32Array = new Uint8Array([1, 2, 3, 4])) => ({ width: 1, height: 1, data })

test('decoded residency includes scope, keys and entire backing buffers', () => {
  const cache = new DecodedImageCache(400)
  cache.begin('a') // 130 bytes of scope metadata
  expect(cache.set('a', 'x', image())).toBe(true)
  expect(cache.bytes).toBe(264)
  cache.set('a', 'y', image())
  expect(cache.bytes).toBe(398)
  const borrowed = cache.get('a', 'x')!
  cache.set('a', 'z', image())
  expect(cache.get('a', 'y')).toBeUndefined()
  expect(cache.get('a', 'x')).toBe(borrowed)
  expect(cache.bytes).toBe(398)
  cache.set('a', 'x', image(new Float32Array([1, 2, 3, 4])))
  expect(cache.bytes).toBe(276)
  expect(cache.get('a', 'z')).toBeUndefined()
  // A four-byte view cannot hide a 512-byte retained backing allocation.
  expect(cache.set('a', 'large', image(new Uint8Array(new ArrayBuffer(512), 0, 4)))).toBe(false)
  expect(cache.bytes).toBe(276)
  cache.clear()
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
  expect([...borrowed.data]).toEqual([1, 2, 3, 4])
})

test('document/color scope switches invalidate all variants and ignore stale hydration', () => {
  const cache = new DecodedImageCache(1024)
  const srgb = JSON.stringify(['doc-a', 'srgb']), p3 = JSON.stringify(['doc-a', 'p3'])
  cache.begin(srgb)
  cache.set(srgb, 'b:uri', image()); cache.set(srgb, 'f:uri', image(new Float32Array(4)))
  cache.begin(srgb)
  expect(cache.size).toBe(2)
  cache.begin(p3)
  expect(cache.get(srgb, 'f:uri')).toBeUndefined()
  expect(cache.get(p3, 'b:uri')).toBeUndefined()
  expect(cache.set(srgb, 'f:uri', image())).toBe(false)
  cache.set(p3, 'f:uri', image(new Float32Array(4)))
  cache.begin(JSON.stringify(['doc-b', 'p3']))
  expect(cache.size).toBe(0)
})

test('malformed images and unsafe cache budgets are rejected before admission', () => {
  for (const limit of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() => new DecodedImageCache(limit)).toThrow('budget')
  const cache = new DecodedImageCache(1024)
  cache.begin('a')
  for (const record of [null, {}, { width: Infinity, height: 1, data: new Uint8Array(4) },
    { width: 0.5, height: 2, data: new Uint8Array(4) }, { width: 2 ** 32, height: 2 ** 32, data: new Uint8Array(4) },
    image(new Uint8Array(3)), { width: 1, height: 1, data: new Uint32Array(4) }]) {
    expect(validDecodedImage(record)).toBe(false)
    expect(cache.set('a', 'x', record as any)).toBe(false)
  }
  const zero = new DecodedImageCache(0)
  zero.begin('a')
  expect(zero.set('a', 'x', image())).toBe(false)
  expect(zero.bytes).toBe(0)
})

test('disk eviction counts bytes rather than subtracting a byte target from entry count', () => {
  const MiB = 1024 * 1024
  const entries = [{ key: 'old', bytes: 140 * MiB, lastUsed: 1 }, { key: 'new', bytes: 140 * MiB, lastUsed: 2 }]
  expect(imageCacheVictims(entries, 256 * MiB)).toEqual(['old'])
  expect(imageCacheVictims([{ key: 'one-large', bytes: 300 * MiB, lastUsed: 1 }], 256 * MiB)).toEqual(['one-large'])
})

test('disk eviction decrements remaining bytes and stops exactly at the target', () => {
  const entries = [1, 2, 3, 4, 5].map(key => ({ key, bytes: 10, lastUsed: key }))
  expect(imageCacheVictims(entries, 40)).toEqual([1, 2]) // 50 -> 30, the 75% target
  expect(imageCacheVictims(entries, 50)).toEqual([])
  expect(imageCacheVictims([...entries, { key: 6, bytes: NaN, lastUsed: 1 }], 50)).toEqual([6])
})

test('many document switches and decodes remain bounded without changing borrowed pixels', () => {
  const cache = new DecodedImageCache(2048), borrowed = image()
  for (let n = 0; n < 3000; n++) {
    const scope = `document-${Math.floor(n / 100)}`
    cache.begin(scope); cache.set(scope, `image-${n}`, n === 0 ? borrowed : image())
    expect(cache.bytes).toBeLessThanOrEqual(cache.limit)
  }
  expect([...borrowed.data]).toEqual([1, 2, 3, 4])
  cache.clear(); expect(cache.bytes).toBe(0)
})
