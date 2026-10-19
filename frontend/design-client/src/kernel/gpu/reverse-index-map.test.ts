import { expect, test } from 'vitest'
import { ReverseIndexMap } from './reverse-index-map'
test('aliases stay exact across bucket extension, replacement, deletion and clear', () => {
  const map = new ReverseIndexMap<string, Set<number>, number>(value => value), bucket = new Set([1])
  map.set('a', bucket); map.set('b', new Set([2])); bucket.add(2); map.set('a', bucket)
  expect([...map.keys()]).toEqual(['a', 'b'])
  expect([...map.keysFor(2)]).toEqual(['b', 'a'])
  map.set('a', new Set([3])); expect([...map.keysFor(1)]).toEqual([]); expect([...map.keysFor(2)]).toEqual(['b'])
  map.delete('b'); expect([...map.keysFor(2)]).toEqual([])
  map.clear(); expect(map.size).toBe(0); expect([...map.keysFor(3)]).toEqual([])
})
