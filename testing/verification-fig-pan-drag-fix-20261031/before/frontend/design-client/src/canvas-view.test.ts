/// <reference types="node" />
import { beforeAll, test, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { initializePicking, kernelBounds } from './kernel/picking'
import {
  createBox,
  snapMove,
  zoomAt,
  resizeInBasis,
  rotateNode,
  parentBounds,
  rotationDegrees,
} from './canvas-view'
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
  expect(localBounds(resized).width).toBeCloseTo(120, 10)
  expect(parentBounds(resized).y).toBeCloseTo(-10.82745, 4)
  editor.undo()
  expect(localBounds(editor.snapshot().doc.nodes[id]).width).toBeCloseTo(100, 10)
  expect(parentBounds(editor.snapshot().doc.nodes[id]).y).toBeCloseTo(-4.980013, 4)
})
