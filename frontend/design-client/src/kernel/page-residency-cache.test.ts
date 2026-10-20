import { expect, test } from 'vitest'
import { PageResidencyCache } from './page-residency-cache'

test('A → B → A takes exact resident objects, without cloning pixels or history', () => {
  const cache = new PageResidencyCache<object>(100), document = {}
  const a = { serial: 1 }, b = { serial: 2 }
  cache.synchronize(document, 'session:1/render:exact')
  cache.store('A', [a], 40)
  expect(cache.take('A')).toEqual([a])
  cache.store('B', [b], 40)
  expect(cache.values()[0]).toBe(b)
  expect(cache.bytes).toBe(40)
  expect(cache.hits).toBe(1)
  expect(cache.take('missing')).toBeUndefined()
})

test('all immutable content, undo/redo, font and resource revisions invalidate inactive pixels', () => {
  const cache = new PageResidencyCache<object>(100)
  const original = { nodes: {}, fonts: {} }
  let current: object = original
  for (const document of [original, { ...original, nodes: { edited: true } }, original,
    { ...original, fonts: { revised: true } }, { ...original, nodes: { image: 'new bytes' } }]) {
    cache.synchronize(current, 'session:1')
    cache.store('A', [{}], 40)
    const invalidated = cache.synchronize(document, 'session:1')
    expect(invalidated).toBe(document !== current)
    expect(cache.size).toBe(document === current ? 1 : 0)
    current = document
  }
  cache.store('A', [{}], 40)
  expect(cache.synchronize(current, 'session:2')).toBe(true)
  expect(cache.size).toBe(0)
  cache.store('A', [{}], 40)
  cache.synchronize(current, 'session:2/backend:cpu')
  expect(cache.bytes).toBe(0)
})

test('shared byte allowance, LRU page bound and oversized pages are enforced', () => {
  const cache = new PageResidencyCache<string>(100, 2)
  cache.store('A', ['a'], 40); cache.store('B', ['b'], 40); cache.store('C', ['c'], 40)
  expect(cache.take('A')).toBeUndefined()
  expect(cache.bytes).toBe(80)
  expect(cache.trim(45)).toBe(true)
  expect(cache.values()).toEqual(['c'])
  cache.store('huge', ['huge'], 101)
  expect(cache.values()).toEqual(['c'])
  cache.trim(0)
  expect(cache.bytes).toBe(0)
  expect(cache.size).toBe(0)
  for (let i = 0; i < 50; i++) cache.store(String(i), [String(i)], 1)
  expect(cache.size).toBe(2)
})

test('eviction and invalidation release resources, while activation transfers ownership', () => {
  const retired: string[] = [], cache = new PageResidencyCache<string>(10, 2, value => retired.push(value))
  cache.synchronize({}, 'scope')
  cache.store('A', ['a'], 8)
  expect(cache.take('A')).toEqual(['a'])
  expect(retired).toEqual([])
  cache.store('B', ['b'], 8); cache.store('C', ['c'], 8)
  expect(retired).toEqual(['b'])
  cache.clear()
  expect(retired).toEqual(['b', 'c'])
  cache.clear()
  expect(retired).toEqual(['b', 'c'])
})
