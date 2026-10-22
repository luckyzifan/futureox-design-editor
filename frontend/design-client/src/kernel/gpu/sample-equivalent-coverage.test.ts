import { expect, test } from 'vitest'
import { identicalSampleCoverage } from './sample-equivalent-coverage'
import type { PathMesh } from './types'

type Span = [number, number, number, number, number, number]
function program(rows: Span[][][]) {
  const curves: number[] = [3, 1, 12, rows.length], headers = 1 + rows.length * 4
  curves.length = headers * 4; curves.fill(0, 4)
  const words = (value: number) => {
    const view = new DataView(new ArrayBuffer(8)); view.setFloat64(0, value, true)
    return Array.from({ length: 4 }, (_, i) => view.getUint16(i * 2, true))
  }
  for (let row = 0; row < rows.length; row++) for (let phase = 0; phase < 4; phase++) {
    const spans = rows[row][phase], at = (1 + row * 4 + phase) * 4
    curves[at] = curves.length / 4; curves[at + 1] = spans.length
    for (const span of spans) curves.push(...span.slice(0, 4), ...words(span[4]), ...words(span[5]))
  }
  return { path: { rect: { x: -100, y: 200, w: 12, h: rows.length }, sampleCount: 4, count: 3,
    area: { first: 0, count: curves.length / 4 } } as PathMesh, curves }
}
const repeat = (spans: Span[]): Span[][] => Array.from({ length: 4 }, () => spans.map(span => [...span] as Span))

test('equal discrete coverage is certified for partial rows and empty rows without requiring full rectangular coverage', () => {
  const { path, curves } = program([repeat([[2, 6, 0, 0, .0625, .0625]]), repeat([])])
  expect(identicalSampleCoverage(path, curves)).toBe(true)
  expect(identicalSampleCoverage(path, new Float32Array(curves))).toBe(true)
})
test('identical interval bytes whose endpoints separate the four sample offsets must decline', () => {
  const { path, curves } = program([repeat([[2, 6, 0, 0, .5, .5]])])
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
test('different interval programs may prove the same integer samples after exact endpoint comparisons', () => {
  const { path, curves } = program([[
    [[1, 3, 0, 0, .2, .2]], [[0, 2, 0, 0, .9, .9]],
    [[1, 2, 0, 0, .1, .9]], [[1, 2, 0, 0, .6, .9]],
  ]])
  expect(identicalSampleCoverage(path, curves)).toBe(true)
})
test('adjacent and overlapping integer runs compare by their actual union, not span counts', () => {
  const { path, curves } = program([[
    [[0, 2, 0, 0, 0, 0], [2, 4, 0, 0, 0, 0]], [[0, 4, 0, 0, 0, 0]],
    [[0, 4, 0, 0, 0, 0]], [[0, 4, 0, 0, 0, 0]],
  ]])
  expect(identicalSampleCoverage(path, curves)).toBe(true)
})
test('one phase with an empty row remains distinct even if other rows agree', () => {
  const row = repeat([[2, 6, 0, 0, 0, 0]])
  row[2] = []
  const { path, curves } = program([repeat([]), row])
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
test('endpoint adjustment cannot erase an earlier covered pixel from overlapping raw intervals', () => {
  const { path, curves } = program([[
    [[2, 5, 0, 0, .5, 0], [2, 6, 0, 0, 0, 0]],
    [[3, 6, 0, 0, 0, 0]], [[3, 6, 0, 0, 0, 0]], [[3, 6, 0, 0, 0, 0]],
  ]])
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
test('sixteen ordered spans retain exact phase decisions at binary-search boundaries, gaps and the final span', () => {
  const row = repeat(Array.from({ length: 16 }, (_, i) => [i * 2, i * 2 + 1, 0, 0, 0, 0] as Span))
  const same = program([row]); same.path.rect.w = 40; same.curves[2] = 40
  expect(identicalSampleCoverage(same.path, same.curves)).toBe(true)
  row[0][15][4] = .5
  const distinct = program([row]); distinct.path.rect.w = 40; distinct.curves[2] = 40
  expect(identicalSampleCoverage(distinct.path, distinct.curves)).toBe(false)
})
test('signed-zero endpoints and negative upper parts follow the literal binary64 ordering', () => {
  const zero = program([repeat([[2, 6, 0, 0, -0, 0]])])
  expect(identicalSampleCoverage(zero.path, zero.curves)).toBe(true)
  const negativeUpper = program([repeat([[2, 6, -1, 0, 1.25, 0]])])
  expect(identicalSampleCoverage(negativeUpper.path, negativeUpper.curves)).toBe(false)
})
test('a single-pixel span must satisfy both its left and right phase endpoint comparisons', () => {
  const { path, curves } = program([repeat([[2, 2, 0, 0, .2, .8]])])
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
test('aliased row pointers cannot amplify a small packet past the total span work limit', () => {
  const { path, curves } = program([repeat(Array.from({ length: 4096 }, (_, i) => [i, i, 0, 0, 0, 1] as Span))])
  path.rect.h = 64; curves[3] = 64
  const first = curves[4], count = curves[5]
  // Repeated legal row references stay within the packet but are still work.
  const tail = curves.slice(first * 4), headerWords = (1 + 64 * 4) * 4
  curves.length = headerWords; curves.fill(0, 4)
  for (let record = 0; record < 64 * 4; record++) {
    curves[4 + record * 4] = headerWords / 4; curves[5 + record * 4] = count
  }
  for (const value of tail) curves.push(value)
  path.area!.count = curves.length / 4
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
test.each(['header', 'sample-count', 'row-pointer', 'truncated', 'nan-endpoint', 'u16-word', 'unsorted', 'work-bound'] as const)('%s cannot create a coverage certificate', mode => {
  const { path, curves } = program([repeat([[2, 6, 0, 0, .0625, .0625]])])
  if (mode === 'header') curves[0] = 4
  if (mode === 'sample-count') path.sampleCount = 16
  if (mode === 'row-pointer') curves[4] = 1
  if (mode === 'truncated') curves.length--
  if (mode === 'nan-endpoint') curves[(1 + 4) * 4 + 7] = 0x7ff8
  if (mode === 'u16-word') curves[(1 + 4) * 4 + 4] = .5
  if (mode === 'unsorted') curves[(1 + 4) * 4 + 1] = 1
  if (mode === 'work-bound') path.area!.count = 262145
  expect(identicalSampleCoverage(path, curves)).toBe(false)
})
