import { expect, test } from 'vitest'
import { flatRects, parseSmartSnap, smartGuidesSnapWorld } from './canvas-smart-guides'
// The shared test-setup.ts already initialized the real kernel module.

test('flatRects packs world rects into flat four-value rows', () => {
  expect(Array.from(flatRects([{ x: 92.5, y: 0, width: 10, height: 10 }]))).toEqual([
    92.5, 0, 10, 10,
  ])
  expect(
    Array.from(flatRects([
      { x: 60, y: 40, width: 30, height: 20 },
      { x: 90, y: 0, width: 0, height: 100 },
    ])),
  ).toEqual([60, 40, 30, 20, 90, 0, 0, 100])
})

test('parseSmartSnap reads kernel JSON back into guide segments and fails closed', () => {
  const snap = parseSmartSnap(
    '{"dx":-2,"dy":0,"guides":[{"axis":"x","position":90,"start":0,"end":60},null]}',
  )
  expect(snap.dx).toBe(-2)
  expect(snap.dy).toBe(0)
  expect(snap.guides[0]).toEqual({ axis: 'x', position: 90, start: 0, end: 60 })
  expect(snap.guides[1]).toBeNull()
  // Missing guides, non-numeric deltas and foreign axes all degrade to no-snap.
  expect(parseSmartSnap('{"dx":1,"dy":2}').guides).toEqual([null, null])
  expect(parseSmartSnap('{"dx":"x","dy":2,"guides":[]}').dx).toBe(0)
  expect(
    parseSmartSnap('{"dx":0,"dy":0,"guides":[{"axis":"z","position":1,"start":0,"end":2}]}')
      .guides,
  ).toEqual([null, null])
  expect(parseSmartSnap('{"dx":0,"dy":0,"guides":[{"axis":"y","position":1,"start":0}]}').guides).toEqual([
    null,
    null,
  ])
})

test('smartGuidesSnapWorld snaps through the real kernel with finite guide extents', () => {
  // Moving left edge 92 against a target right edge 90 within threshold 5:
  // correction -2 with the guide drawn on the shared edge, spanning the union.
  const snap = smartGuidesSnapWorld(
    { x: 92, y: 0, width: 10, height: 10 },
    undefined,
    [{ x: 60, y: 40, width: 30, height: 20 }],
    5,
  )
  expect(snap.dx).toBe(-2)
  expect(snap.dy).toBe(0)
  expect(snap.guides[0]?.axis).toBe('x')
  expect(snap.guides[0]?.position).toBe(90)
  expect(snap.guides[0]!.start).toBeLessThanOrEqual(0)
  expect(snap.guides[0]!.end).toBeGreaterThanOrEqual(60)
  expect(snap.guides[1]).toBeNull()
})

test('ruler guides participate as zero-width rectangles', () => {
  const snap = smartGuidesSnapWorld(
    { x: 92, y: 0, width: 10, height: 10 },
    undefined,
    [{ x: 90, y: 0, width: 0, height: 100 }],
    5,
  )
  expect(snap.dx).toBe(-2)
  expect(snap.guides[0]?.position).toBe(90)
})

test('boundary deltas stay free: the threshold stays strictly exclusive', () => {
  // |delta| == threshold must not snap even though the kernel itself admits it.
  const snap = smartGuidesSnapWorld(
    { x: 110, y: 0, width: 10, height: 10 },
    undefined,
    [{ x: 111, y: 0, width: 5, height: 5 }],
    1,
  )
  expect(snap.dx).toBe(0)
  expect(snap.guides[0]).toBeNull()
})

test('beyond-threshold targets never snap', () => {
  const snap = smartGuidesSnapWorld(
    { x: 0, y: 0, width: 10, height: 10 },
    undefined,
    [{ x: 60, y: 30, width: 10, height: 10 }],
    5,
  )
  expect(snap).toEqual({ dx: 0, dy: 0, guides: [null, null] })
})

test('fractional world rects round onto the kernel integer grid before snapping', () => {
  const snap = smartGuidesSnapWorld(
    { x: 110.25, y: 0.75, width: 10, height: 10 },
    undefined,
    [{ x: 111.375, y: 0, width: 30, height: 30 }],
    6,
  )
  expect(snap.dx).toBe(1)
  expect(snap.guides[0]?.position).toBe(111)
})
