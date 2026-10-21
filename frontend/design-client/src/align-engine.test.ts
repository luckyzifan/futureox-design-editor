import { expect, test } from 'vitest'
import {
  alignOffsets,
  alignSnapWorld,
  arrangeOffsets,
  arrangePatches,
  distributeOffsets,
  dragSnap,
  spacingSnap,
  tidyOffsets,
  type AlignCommand,
} from './align-engine'
import { blank, node } from './model'
import { scene, worldMatrix } from './geometry'
import type { Bounds } from './model'
import type { SmartSnapResult } from './canvas-smart-guides'

const rect = (x: number, y: number, width: number, height: number): Bounds => ({ x, y, width, height })
const NO_SNAP: SmartSnapResult = { dx: 0, dy: 0, guides: [null, null] }

test('alignOffsets: two or more rects align to the selection union bounds', () => {
  const rects = [rect(10, 0, 20, 10), rect(50, 30, 30, 20), rect(100, 5, 10, 40)]
  // union = x 10..110, y 0..50
  const x = (c: AlignCommand) => alignOffsets(rects, c)!.map((d) => d.x)
  expect(x('align-left')).toEqual([0, -40, -90])
  expect(x('align-right')).toEqual([80, 30, 0])
  expect(x('align-hcenter')).toEqual([40, -5, -45])
  const y = (c: AlignCommand) => alignOffsets(rects, c)!.map((d) => d.y)
  expect(y('align-top')).toEqual([0, -30, -5])
  expect(y('align-bottom')).toEqual([40, 0, 5])
  expect(y('align-vcenter')).toEqual([20, -15, 0])
  // The untouched axis always stays zero.
  for (const d of alignOffsets(rects, 'align-left')!) expect(d.y).toBe(0)
  for (const d of alignOffsets(rects, 'align-top')!) expect(d.x).toBe(0)
})

test('alignOffsets: a single rect aligns to its container bounds', () => {
  const child = rect(20, 5, 30, 10), container = rect(0, 0, 100, 80)
  expect(alignOffsets([child], 'align-left', container)).toEqual([{ x: -20, y: 0 }])
  expect(alignOffsets([child], 'align-hcenter', container)).toEqual([{ x: 15, y: 0 }])
  expect(alignOffsets([child], 'align-right', container)).toEqual([{ x: 50, y: 0 }])
  expect(alignOffsets([child], 'align-top', container)).toEqual([{ x: 0, y: -5 }])
  expect(alignOffsets([child], 'align-vcenter', container)).toEqual([{ x: 0, y: 30 }])
  expect(alignOffsets([child], 'align-bottom', container)).toEqual([{ x: 0, y: 65 }])
  // Without a container a single rect cannot align.
  expect(alignOffsets([child], 'align-left')).toBeNull()
  expect(alignOffsets([], 'align-left')).toBeNull()
})

test('distributeOffsets: equal edge gaps with pinned outermost rects', () => {
  const rects = [rect(0, 0, 10, 10), rect(30, 4, 20, 10), rect(100, 9, 10, 10)]
  // union x 0..110, sizes 40 → gap (110-40)/2 = 35; positions 0, 45, 100
  const deltas = distributeOffsets(rects, 'x')!
  expect(deltas[0]).toEqual({ x: 0, y: 0 })
  expect(deltas[1]).toEqual({ x: 15, y: 0 })
  expect(deltas[2]).toEqual({ x: 0, y: 0 })
  // Deltas follow input order even when input is unsorted.
  const shuffled = distributeOffsets([rects[2], rects[0], rects[1]], 'x')!
  expect(shuffled[0]).toEqual({ x: 0, y: 0 })
  expect(shuffled[1]).toEqual({ x: 0, y: 0 })
  expect(shuffled[2]).toEqual({ x: 15, y: 0 })
  // Vertical distribution uses heights.
  const v = distributeOffsets([rect(0, 0, 10, 10), rect(3, 25, 10, 20), rect(5, 60, 10, 10)], 'y')!
  // union y 0..70, sizes 40 → gap 15; middle top already 25.
  expect(v[1]).toEqual({ x: 0, y: 0 })
  // Two rects cannot distribute.
  expect(distributeOffsets(rects.slice(0, 2), 'x')).toBeNull()
})

test('distributeOffsets: overlapping rects distribute with negative gaps', () => {
  const rects = [rect(0, 0, 20, 10), rect(10, 0, 20, 10), rect(20, 0, 20, 10)]
  // union width 40, sizes 60 → gap -10; positions 0, 10, 20 (already even)
  expect(distributeOffsets(rects, 'x')!.map((d) => d.x)).toEqual([0, 0, 0])
})

test('tidyOffsets: rows cluster by overlap, equalize gaps and center rows', () => {
  // Two rows of two, uneven gaps: row1 x gaps 5 (0-10, 15-25), row2 gap 45.
  const rects = [
    rect(0, 0, 10, 10),
    rect(15, 2, 10, 10),
    rect(0, 30, 10, 10),
    rect(55, 30, 10, 10),
  ]
  const d = tidyOffsets(rects)!
  // mean in-row gap = (5 + 45) / 2 = 25; row1 anchored at x 0 → second at 35
  expect(d[0].x).toBe(0)
  expect(d[1].x).toBe(20)
  expect(d[2].x).toBe(0)
  expect(d[3].x).toBe(-20)
  // row band 0..12 centered at 6; mean row gap = (30-12)=18 (single value)
  expect(d[0].y).toBe(1)
  expect(d[1].y).toBe(-1)
  // row2 top = 12 + 18 = 30 (unchanged), band center 35
  expect(d[2].y).toBe(0)
  expect(d[3].y).toBe(0)
})

test('tidyOffsets: a single row equalizes horizontal gaps; a single column vertical gaps', () => {
  const row = [rect(0, 0, 10, 10), rect(30, 5, 10, 10), rect(50, 2, 10, 10)]
  const d = tidyOffsets(row)!
  // mean gap = (20 + 10) / 2 = 15 → positions 0, 25, 50
  expect(d.map((p) => p.x)).toEqual([0, -5, 0])
  // one row band 0..15 → centers align to 7.5
  expect(d.map((p) => p.y)).toEqual([2.5, -2.5, 0.5])
  const column = [rect(0, 0, 10, 10), rect(4, 30, 10, 10), rect(1, 50, 10, 10)]
  const v = tidyOffsets(column)!
  expect(v.map((p) => p.y)).toEqual([0, -5, 0])
  expect(v.map((p) => p.x)).toEqual([0, 0, 0])
  expect(tidyOffsets([rect(0, 0, 10, 10)])).toBeNull()
})

test('arrangeOffsets routes each command and returns null when not applicable', () => {
  expect(arrangeOffsets([rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 'distribute-horizontal')).toBeNull()
  expect(arrangeOffsets([rect(0, 0, 10, 10)], 'tidy')).toBeNull()
  expect(
    arrangeOffsets([rect(0, 0, 10, 10), rect(30, 0, 10, 10)], 'align-bottom'),
  ).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }])
})

test('spacingSnap: repeats an existing sibling gap after the second sibling', () => {
  // A 0..10, B 20..30 (gap 10). Drag a 5-wide rect to x 37: candidate 40 (gap 10), delta +3.
  const snap = spacingSnap(rect(37, 0, 5, 10), [rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 5)
  expect(snap.dx).toBe(3)
  expect(snap.dy).toBe(0)
  const guide = snap.guides[0]!
  expect(guide.axis).toBe('x')
  expect(guide.position).toBe(30) // the stationary edge of B
  expect(guide.start).toBeLessThanOrEqual(0)
  expect(guide.end).toBeGreaterThanOrEqual(10)
  expect(snap.guides[1]).toBeNull()
})

test('spacingSnap: repeats the gap before the first sibling', () => {
  // A 0..10, B 20..30 (gap 10). Drag a 5-wide rect to x -13: candidate -15, delta -2.
  const snap = spacingSnap(rect(-13, 0, 5, 10), [rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 5)
  expect(snap.dx).toBe(-2)
  expect(snap.guides[0]!.position).toBe(0) // stationary leading edge of A
})

test('spacingSnap: centers with equal gaps inside a bracketing sibling pair', () => {
  // A 0..10, B 40..50; a 10-wide rect at x 17 has gaps 7 and 13 → equal at x 20.
  const snap = spacingSnap(rect(17, 0, 10, 10), [rect(0, 0, 10, 10), rect(40, 0, 10, 10)], 5)
  expect(snap.dx).toBe(3)
  expect(snap.guides[0]!.axis).toBe('x')
  expect(snap.guides[0]!.position).toBe(10)
  expect(snap.guides[0]!.start).toBeLessThanOrEqual(0)
  expect(snap.guides[0]!.end).toBeGreaterThanOrEqual(10)
})

test('spacingSnap: vertical axis, threshold stays exclusive, distant rows ignored', () => {
  const siblings = [rect(0, 0, 10, 10), rect(0, 20, 10, 10)]
  const snap = spacingSnap(rect(0, 37, 10, 5), siblings, 5)
  expect(snap.dy).toBe(3)
  expect(snap.guides[1]!.axis).toBe('y')
  expect(snap.guides[1]!.position).toBe(30)
  // |delta| == threshold must not snap.
  expect(spacingSnap(rect(35, 0, 5, 10), [rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 5).guides[0]).toBeNull()
  // Siblings on a far-away row never generate spacing candidates.
  const far = [rect(0, 500, 10, 10), rect(20, 500, 10, 10)]
  expect(spacingSnap(rect(37, 0, 5, 10), far, 5)).toEqual(NO_SNAP)
  // Zero-area ruler-guide rects never contribute spacing values.
  const guides = [rect(0, 0, 0, 100), rect(20, 0, 0, 100)]
  expect(spacingSnap(rect(37, 0, 5, 10), guides, 5)).toEqual(NO_SNAP)
})

test('dragSnap: spacing beats edge snapping only when its correction is smaller', () => {
  const siblings = [rect(0, 0, 10, 10), rect(20, 0, 10, 10)]
  const moving = rect(37, 0, 5, 10) // spacing candidate delta +3
  const edgeAt = (delta: number | null): SmartSnapResult =>
    delta === null
      ? NO_SNAP
      : { dx: delta, dy: 0, guides: [{ axis: 'x', position: 42, start: 0, end: 10 }, null] }
  // spacing (3) < edge (4) → spacing wins
  let result = dragSnap(moving, undefined, siblings, 5, () => edgeAt(4))
  expect(result.dx).toBe(3)
  expect(result.guides[0]!.position).toBe(30)
  // edge (2) < spacing (3) → edge wins
  result = dragSnap(moving, undefined, siblings, 5, () => edgeAt(2))
  expect(result.dx).toBe(2)
  expect(result.guides[0]!.position).toBe(42)
  // tie → edge wins (spacing strictly smaller only)
  result = dragSnap(moving, undefined, siblings, 5, () => edgeAt(3))
  expect(result.dx).toBe(3)
  expect(result.guides[0]!.position).toBe(42)
  // no edge snap → spacing alone; no spacing → edge alone
  result = dragSnap(moving, undefined, siblings, 5, () => NO_SNAP)
  expect(result.guides[0]!.position).toBe(30)
  result = dragSnap(rect(80, 0, 5, 10), undefined, siblings, 5, () => edgeAt(-1))
  expect(result).toEqual({ dx: -1, dy: 0, guides: [{ axis: 'x', position: 42, start: 0, end: 10 }, null] })
})

test('alignSnapWorld falls back to spacing snapping through the real kernel edge pass', () => {
  // The kernel edge snap finds nothing here (no aligned edges); spacing snaps
  // the third rect to repeat the 10-unit sibling gap.
  const snap = alignSnapWorld(rect(37, 0, 5, 10), undefined, [rect(0, 0, 10, 10), rect(20, 0, 10, 10)], 5)
  expect(snap.dx).toBe(3)
  expect(snap.guides[0]!.axis).toBe('x')
  expect(snap.guides[0]!.position).toBe(30)
  // Edge snapping still works through the same entry point.
  const edge = alignSnapWorld(rect(92, 0, 10, 10), undefined, [rect(60, 40, 30, 20)], 5)
  expect(edge.dx).toBe(-2)
  expect(edge.guides[0]!.position).toBe(90)
})

function arrangeFixture() {
  const doc = blank('arrange')
  const a = node('rectangle', 0, 0, 10, 10),
    b = node('rectangle', 30, 4, 20, 10),
    c = node('rectangle', 100, 9, 10, 10)
  doc.nodes = { [a.id]: a, [b.id]: b, [c.id]: c }
  doc.pages[0].children = [a.id, b.id, c.id]
  return { doc, page: doc.pages[0].id, a, b, c }
}

test('arrangePatches: distribute moves only the middle rect and survives a change roundtrip', () => {
  const { doc, page, a, b, c } = arrangeFixture()
  const patches = arrangePatches(doc, page, [a.id, b.id, c.id], 'distribute-horizontal')!
  expect(Object.keys(patches)).toEqual([b.id])
  expect(patches[b.id].transform).toEqual([1, 0, 0, 1, 45, 4])
  // Zero-delta commands produce no patch at all.
  expect(arrangePatches(doc, page, [a.id], 'distribute-horizontal')).toBeNull()
  expect(arrangePatches(doc, page, [a.id], 'align-left')).toBeNull() // root has no parent container
})

test('arrangePatches: a single child aligns to its parent frame, in parent space', () => {
  const doc = blank('single align')
  const frame = node('frame', 100, 200, 400, 300),
    child = node('rectangle', 10, 20, 50, 40)
  frame.children = [child.id]
  doc.nodes = { [frame.id]: frame, [child.id]: child }
  doc.pages[0].children = [frame.id]
  const patches = arrangePatches(doc, doc.pages[0].id, [child.id], 'align-hcenter')!
  // child world x 110, frame world x 100 w 400 → target world x 100+175=275, delta 165
  expect(patches[child.id].transform).toEqual([1, 0, 0, 1, 175, 20])
})

test('arrangePatches: locked and auto-layout targets reject the whole plan', () => {
  const { doc, page, a, b, c } = arrangeFixture()
  b.locked = true
  const patches = arrangePatches(doc, page, [a.id, b.id, c.id], 'distribute-horizontal')!
  // A locked explicit target rejects the whole selection; no partial patches.
  expect(patches).toBeNull()
  b.locked = false
  const parent = node('frame', 0, 0, 400, 100)
  parent.layout = { mode: 'horizontal', gap: 10, padding: [0, 0, 0, 0] } as never
  parent.children = [a.id, b.id]
  doc.nodes[parent.id] = parent
  doc.pages[0].children = [parent.id, c.id]
  expect(arrangePatches(doc, doc.pages[0].id, [a.id, b.id, c.id], 'align-top')).toBeNull()
})

test('arrangePatches: nested parent transforms keep world-space alignment', () => {
  const doc = blank('nested')
  const outer = node('frame', 50, 60, 500, 500),
    inner = node('frame', 10, 10, 300, 300),
    child = node('rectangle', 5, 5, 20, 20)
  outer.children = [inner.id]
  inner.children = [child.id]
  doc.nodes = { [outer.id]: outer, [inner.id]: inner, [child.id]: child }
  doc.pages[0].children = [outer.id]
  const patches = arrangePatches(doc, doc.pages[0].id, [child.id], 'align-left')!
  // child world x = 50+10+5 = 65; inner world x = 60 → delta -5 in inner space
  child.transform = patches[child.id].transform
  const entries = scene(doc, doc.pages[0].id)
  expect(entries.find((e) => e.id === child.id)!.bounds.x).toBe(60)
  expect(worldMatrix(doc, child.id)).toEqual([1, 0, 0, 1, 60, 75])
})
