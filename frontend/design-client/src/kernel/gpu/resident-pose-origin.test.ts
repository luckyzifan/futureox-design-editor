import { expect, test } from 'vitest'
import type { GpuNode, GpuScene } from './types'
import { capturePoseOrigins, residentPoseShift, type ResidentPoseOrigin } from './resident-pose-origin'
import { previewTranslationDelta } from './translated-scene'

const matrix = (x: number, y: number): number[] => [1, 0, 0, 1, x, y]
const scene = (nodes: Record<string, { id: string; matrix: number[]; children?: string[] }>): GpuScene =>
  ({ nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, {
    rect: { x: 0, y: 0, w: 100, h: 100 }, fill: { rect: { x: 0, y: 0, w: 100, h: 100 }, first: 0, count: 0, rule: 'nonzero' },
    fills: [], strokes: [], effects: [], children: [], opacity: 1, blend: 'normal', clip: false, mask: false, ...node,
  }])), roots: Object.keys(nodes).slice(0, 1), view: { x: 0, y: 0, zoom: 1 } }) as unknown as GpuScene

test('native recompilation and repeated absolute poses keep the original cumulative capture window', () => {
  const initial = scene({ moving: { id: 'moving', matrix: matrix(100, 200) } })
  const origin = capturePoseOrigins(initial, ['moving'])!.get('moving')!
  expect(residentPoseShift(origin, matrix(100, 200), [43, 25])).toEqual({ x: 43, y: 25 })
  // A freshly compiled native node has no previewSource. Pointerup and commit
  // can repeat this same absolute transform with a zero incremental delta.
  expect(residentPoseShift(origin, matrix(143, 225), [0, 0])).toEqual({ x: 43, y: 25 })
  expect(residentPoseShift(origin, matrix(143, 225), [0, 0])).toEqual({ x: 43, y: 25 })
})

test('successive increments and backwards motion are measured from the first capture', () => {
  const origin: ResidentPoseOrigin = [100, 200]
  expect(residentPoseShift(origin, matrix(100, 200), [10, -5])).toEqual({ x: 10, y: -5 })
  expect(residentPoseShift(origin, matrix(110, 195), [12, 8])).toEqual({ x: 22, y: 3 })
  expect(residentPoseShift(origin, matrix(122, 203), [-29, -13])).toEqual({ x: -7, y: -10 })
  expect(residentPoseShift(origin, matrix(93, 190), [7, 10])).toEqual({ x: 0, y: 0 })
})

test('capture copies and freezes the two coordinates without retaining mutable matrix storage', () => {
  const initial = scene({ a: { id: 'a', matrix: matrix(10, 20) }, b: { id: 'b', matrix: matrix(-30, 40) } })
  const origins = capturePoseOrigins(initial, ['a', 'b'])!
  initial.nodes.a.matrix[4] = 500; initial.nodes.b.matrix[5] = 600
  expect(origins.get('a')).toEqual([10, 20]); expect(origins.get('b')).toEqual([-30, 40])
  expect(Object.isFrozen(origins.get('a'))).toBe(true)
})

test('a rotated scaled parent uses the existing world delta before cumulative origin subtraction', () => {
  const parent = { id: 'parent', matrix: [0, 2, -3, 0, 500, 400], children: ['moving'] }
  const moving = { id: 'moving', matrix: matrix(488, 406), children: [] }
  const initial = scene({ parent, moving })
  const origin = capturePoseOrigins(initial, ['moving'])!.get('moving')!
  // Parent transforms local (3,4) to (488,406), then local (8,11) to (467,416).
  const transform: GpuNode['matrix'] = [1, 0, 0, 1, 8, 11]
  const delta = previewTranslationDelta(initial, 'moving', transform)!
  expect(delta).toEqual([-21, 10])
  expect(residentPoseShift(origin, moving.matrix, delta)).toEqual({ x: -21, y: 10 })
  const compiled = scene({ parent, moving: { ...moving, matrix: matrix(467, 416) } })
  expect(residentPoseShift(origin, compiled.nodes.moving.matrix,
    previewTranslationDelta(compiled, 'moving', transform)!)).toEqual({ x: -21, y: 10 })
})

test('sub-ulp deltas retain the original add-then-subtract order rather than algebraic regrouping', () => {
  const anchor = 2 ** 18, ulp = 2 ** -34
  const current = matrix(anchor + ulp, -anchor), delta = [ulp / 4, -ulp / 4] as const
  const actual = residentPoseShift([anchor, -anchor], current, delta)!
  expect(actual.x).toBe(current[4] + delta[0] - anchor)
  expect(actual.x).not.toBe((current[4] - anchor) + delta[0])
  expect(actual.y).toBe(current[5] + delta[1] + anchor)
})

test('unknown, duplicate, empty and malformed origins cannot authorize a pose window', () => {
  const initial = scene({ moving: { id: 'moving', matrix: matrix(100, 200) } })
  for (const ids of [[], ['missing'], ['moving', 'moving'], Array.from({ length: 17 }, () => 'moving')])
    expect(capturePoseOrigins(initial, ids)).toBeUndefined()
  initial.nodes.moving.id = 'another'
  expect(capturePoseOrigins(initial, ['moving'])).toBeUndefined()
  expect(residentPoseShift(undefined as unknown as ResidentPoseOrigin, matrix(100, 200), [0, 0])).toBeUndefined()
})

test('nonfinite and out-of-range input or cumulative positions conservatively require recapture', () => {
  for (const bad of [NaN, Infinity, -Infinity, 1_000_000, -1_000_000]) {
    expect(capturePoseOrigins(scene({ moving: { id: 'moving', matrix: matrix(bad, 0) } }), ['moving'])).toBeUndefined()
    expect(residentPoseShift([bad, 0], matrix(0, 0), [0, 0])).toBeUndefined()
    expect(residentPoseShift([0, 0], matrix(bad, 0), [0, 0])).toBeUndefined()
    expect(residentPoseShift([0, 0], matrix(0, 0), [bad, 0])).toBeUndefined()
  }
  expect(residentPoseShift([-900_000, 0], matrix(900_000, 0), [0, 0])).toBeUndefined()
  expect(residentPoseShift([0, 0], [1, 0, 0, 1, 0], [0, 0])).toBeUndefined()
  expect(residentPoseShift([0, 0], [NaN, 0, 0, 1, 0, 0], [0, 0])).toBeUndefined()
})
