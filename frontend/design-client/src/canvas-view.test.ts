/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking, kernelBounds } from './kernel/picking'
import {
  createBox,
  snapMove,
  zoomAt,
  resizeInBasis,
  resizeSnapEnd,
  rotateNode,
  parentBounds,
  rotationDegrees,
  vectorPointSnaps,
} from './canvas-view'
import { createSmartGuidesIndex } from './canvas-smart-guides'
import { figmaFixture } from './figma-fixtures'
import { scene, apply, multiply, rotate } from './geometry'
import { Editor } from './engine'
import { localBounds } from './canvas-view'
beforeAll(async () =>
  initializePicking({
    wasm: new Uint8Array(
      await readFile(new URL('../public/kernel/design_kernel_bg.wasm', import.meta.url)),
    ),
    font: new Uint8Array(
      await readFile(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)),
    ),
  }),
)
function curve() {
  return Object.values(figmaFixture('curve').nodes).find((n) => n.kind === 'vector')!
}
test('curve selection follows true extrema, not its two 100px control handles', () => {
  const n = curve()
  expect(kernelBounds(n)).toEqual({ x: 8, y: 8, width: 100, height: 75 })
  const d = figmaFixture('curve'),
    entry = scene(d, d.pages[0].id).find((e) => d.nodes[e.id].kind === 'vector')!
  expect(entry.bounds.height).toBe(75)
})
test('pixel drag matches the measured Figma x/y result while disabled snapping preserves decimals', () => {
  const box = { x: 8.125, y: 8.125, width: 20.4, height: 12.6 }
  expect(snapMove(box, { x: 5, y: 0 }, true)).toEqual({ x: 4.875, y: -0.125 })
  expect(snapMove(box, { x: 5, y: 0 }, false)).toEqual({ x: 5, y: 0 })
  const created = createBox({ x: 8.125, y: 8.125 }, { x: 30.4, y: 26.6 }, true)
  expect(created).toEqual({ x: 8, y: 8, width: 22, height: 19 })
})
test('rotation direction and centre match Figma 17-degree property measurements', () => {
  const n = curve()
  rotateNode(n, 17)
  const b = parentBounds(n)
  expect(b.x).toBeCloseTo(-0.7791767, 4)
  expect(b.y).toBeCloseTo(-4.980013, 4)
  expect(rotationDegrees(n)).toBeCloseTo(17, 10)
  // +17° is clockwise on the Y-down canvas: a point to the right of center moves down.
  expect(apply(n.transform, { x: 68, y: 45.5 }).y).toBeGreaterThan(45.5)
  expect(apply(n.transform, { x: 58, y: 45.5 })).toEqual(
    expect.objectContaining({ x: expect.closeTo(58, 10), y: expect.closeTo(45.5, 10) }),
  )
})
test('rotated resize preserves its local axes and opposite corner, with whole-pixel dimensions', () => {
  const r = rotate(-17),
    basis = [r[0], r[1], r[2], r[3], 100, 200] as [number, number, number, number, number, number]
  const box = { x: 0, y: 0, width: 20, height: 10 },
    start = apply(basis, { x: 20, y: 10 }),
    end = apply(basis, { x: 31.7, y: 16.2 })
  const delta = resizeInBasis(basis, box, start, end, 2, false, false, true),
    next = multiply(delta, basis)
  expect(apply(next, { x: 0, y: 0 }).x).toBeCloseTo(100, 10)
  expect(apply(next, { x: 0, y: 0 }).y).toBeCloseTo(200, 10)
  expect(Math.hypot(next[0], next[1]) * 20).toBeCloseTo(32, 9)
  expect(Math.hypot(next[2], next[3]) * 10).toBeCloseTo(16, 9)
  expect(Math.atan2(next[1], next[0])).toBeCloseTo((-17 * Math.PI) / 180, 10)
})
test('pixel snap keeps a crossed edge mirrored and at least one pixel', () => {
  const basis = [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number]
  const box = { x: 0, y: 0, width: 100, height: 50 }
  const snapped = resizeInBasis(basis, box, { x: 100, y: 25 }, { x: -20.6, y: 25 }, 5, false, false, true)
  expect(apply(snapped, { x: 0, y: 25 }).x).toBeCloseTo(0, 8)
  expect(apply(snapped, { x: 100, y: 25 }).x).toBeCloseTo(-21, 8)
  const held = resizeInBasis(basis, box, { x: 100, y: 25 }, { x: -0.2, y: 25 }, 5, false, false, true)
  expect(apply(held, { x: 100, y: 25 }).x).toBeCloseTo(-1, 8)
})

test('resize snap moves the free edge, center, and anchored-center edge onto another object', () => {
  const basis = [1, 0, 0, 1, 0, 0] as [number, number, number, number, number, number]
  const box = { x: 0, y: 0, width: 50, height: 40 }
  const query = (siblings: { x: number; y: number; width: number; height: number }[]) => {
    const index = createSmartGuidesIndex(undefined, siblings)
    expect(index).toBeDefined()
    return {
      index: index!,
      ask: (end: { x: number; y: number }, corner = 5, aspect = false, center = false, start = { x: 50, y: 20 }) =>
        resizeSnapEnd(basis, box, start, end, corner, aspect, center, 6, (moving, threshold) => index!.snap(moving, threshold)),
    }
  }
  const edge = query([{ x: 100, y: 0, width: 40, height: 40 }])
  const hit = edge.ask({ x: 96, y: 28 })
  expect(hit.end.x).toBeCloseTo(100, 6)
  expect(hit.end.y).toBeCloseTo(28, 6)
  expect(hit.guides[0]?.position).toBe(100)
  expect(hit.snapped).toEqual({ x: true, y: false })
  const missed = edge.ask({ x: 90, y: 20 })
  expect(missed.end).toEqual({ x: 90, y: 20 })
  expect(missed.snapped).toEqual({ x: false, y: false })
  const boundary = edge.ask({ x: 94, y: 20 })
  expect(boundary.end.x).toBeCloseTo(94, 6)
  expect(boundary.guides[0]).toBeNull()
  edge.index.free()

  const centered = query([{ x: 40, y: -100, width: 200, height: 20 }])
  const centerHit = centered.ask({ x: 70, y: 20 })
  expect(centerHit.end.x).toBeCloseTo(80, 6)
  expect(centerHit.guides[0]?.position).toBe(40)
  centered.index.free()

  const alt = query([{ x: 100, y: 0, width: 40, height: 40 }])
  const altHit = alt.ask({ x: 96, y: 20 }, 5, false, true)
  expect(altHit.end.x).toBeCloseTo(100, 6)
  const altMatrix = resizeInBasis(basis, box, { x: 50, y: 20 }, altHit.end, 5, false, true, false)
  expect(apply(altMatrix, { x: 25, y: 20 }).x).toBeCloseTo(25, 6)
  expect(apply(altMatrix, { x: 50, y: 20 }).x).toBeCloseTo(100, 6)
  alt.index.free()

  const offset = query([{ x: 100, y: 0, width: 10, height: 40 }])
  const offsetHit = offset.ask({ x: 103.68, y: 20 }, 5, false, false, { x: 54, y: 20 })
  expect(offsetHit.end.x).toBeCloseTo(108, 5)
  const offsetMatrix = resizeInBasis(basis, box, { x: 54, y: 20 }, offsetHit.end, 5, false, false, false)
  expect(apply(offsetMatrix, { x: 50, y: 20 }).x).toBeCloseTo(100, 5)
  offset.index.free()

  const turned = resizeSnapEnd(rotate(30), box, { x: 50, y: 20 }, { x: 96, y: 20 }, 5, false, false, 6,
    () => { throw new Error('rotated resize does not query world snap') })
  expect(turned.end).toEqual({ x: 96, y: 20 })
  expect(turned.snapped).toEqual({ x: false, y: false })
})

test('zoom changes preserve the document point under the chosen anchor', () => {
  const v = { x: 30, y: 35, zoom: 0.75 },
    a = { x: 390, y: 310 },
    next = zoomAt(v, 4, a)
  expect((a.x - v.x) / v.zoom).toBeCloseTo((a.x - next.x) / next.zoom, 10)
  expect((a.y - v.y) / v.zoom).toBeCloseTo((a.y - next.y) / next.zoom, 10)
})
test('measuring a mutable draft does not retain stale bounds after resize or undo', () => {
  const editor = new Editor(figmaFixture('curve')),
    id = Object.values(editor.snapshot().doc.nodes).find((n) => n.network)!.id
  editor.update([id], (n) => rotateNode(n, 17))
  editor.update([id], (n) => {
    const b = localBounds(n),
      ratio = 120 / b.width
    for (const p of n.network!.vertices) p.x = b.x + (p.x - b.x) * ratio
    for (const e of n.network!.edges) {
      if (e.c1) e.c1.x = b.x + (e.c1.x - b.x) * ratio
      if (e.c2) e.c2.x = b.x + (e.c2.x - b.x) * ratio
    }
    n.width *= ratio
  })
  const resized = editor.snapshot().doc.nodes[id]
  const resizedBox = parentBounds(resized)
  expect(localBounds(resized).width).toBeCloseTo(120, 10)
  // Clockwise +17° then a wider curve. The AABB is recomputed; it is not the
  // pre-resize rotated box and not a stale unrotated measurement.
  expect(resizedBox.width).toBeGreaterThan(110)
  editor.undo()
  expect(localBounds(editor.snapshot().doc.nodes[id]).width).toBeCloseTo(100, 10)
  expect(parentBounds(editor.snapshot().doc.nodes[id]).y).toBeCloseTo(-4.980013, 4)
  expect(parentBounds(editor.snapshot().doc.nodes[id]).width).not.toBeCloseTo(resizedBox.width, 1)
})

test('Control suspends vector point snapping only once the pixel grid is drawn', () => {
  // The preference off never snaps, with or without Control.
  for (const zoom of [1, 4, 8]) for (const ctrlKey of [false, true]) expect(vectorPointSnaps(false, ctrlKey, zoom)).toBe(false)
  // Below the grid's zoom, Control keeps the point on the pixel grid.
  for (const zoom of [0.5, 1, 3.99]) for (const ctrlKey of [false, true]) expect(vectorPointSnaps(true, ctrlKey, zoom)).toBe(true)
  // At and above the grid's zoom, Control is the temporary exception.
  expect(vectorPointSnaps(true, false, 4)).toBe(true)
  for (const zoom of [4, 8, 32]) expect(vectorPointSnaps(true, true, zoom)).toBe(false)
  // An unknown zoom is not a drawn grid.
  expect(vectorPointSnaps(true, true, Number.NaN)).toBe(true)
})
