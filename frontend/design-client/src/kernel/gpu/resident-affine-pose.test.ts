import { expect, test } from 'vitest'
import { blank, node, type Matrix } from '../../model'
import { apply, multiply, inverse } from '../../geometry'
import { residentContentAffines, residentOverlayAffines } from './resident-affine-pose'
import type { GpuScene } from './types'

function fixture() {
  const document = blank(), parent = node('frame', 30, 25, 150, 120), selected = node('rectangle', 10, 15, 30, 20)
  parent.transform = [0, 1.5, -1.5, 0, 180, 20]; parent.clip = false; parent.blend = 'normal'; parent.children = [selected.id]
  document.nodes[parent.id] = parent; document.nodes[selected.id] = selected; document.pages[0].children = [parent.id]
  return { document, parent, selected }
}
const fakeNode = (id: string, matrix: Matrix, children: string[]) => ({ id, matrix, children, fills: [], strokes: [], effects: [] })
function compiledScene(camera: Matrix, parent: Matrix, pose: Matrix, parentId: string, selectedId: string): GpuScene {
  return { view: { x: camera[4], y: camera[5], zoom: camera[0] }, roots: [parentId], interactionSelection: [selectedId], nodes: {
    [parentId]: fakeNode(parentId, multiply(camera, parent), [selectedId]),
    [selectedId]: fakeNode(selectedId, multiply(camera, multiply(parent, pose)), []),
  } } as unknown as GpuScene
}

test('content affine maps the compiled base pose onto the authored current pose in screen space (independent oracle)', () => {
  const f = fixture(), camera: Matrix = [2.25, 0, 0, 2.25, -.375, .125]
  const base: Matrix = f.selected.transform, current: Matrix = [.6, .8, -.8, .6, 45, 18]
  const scene = compiledScene(camera, f.parent.transform, base, f.parent.id, f.selected.id)
  const content = residentContentAffines(scene, { [f.selected.id]: current })[f.selected.id]
  // Independent analytic expectation: a local point painted at the base pose lands
  // at camera*parent*base on screen; at the current pose it lands at
  // camera*parent*current. The content affine must carry the former to the latter.
  const baseScreen = multiply(camera, multiply(f.parent.transform, base))
  const currentScreen = multiply(camera, multiply(f.parent.transform, current))
  const expected = multiply(currentScreen, inverse(baseScreen))
  for (const point of [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 20 }, { x: 7.5, y: 11 }]) {
    const actual = apply(content, apply(baseScreen, point))
    const target = apply(currentScreen, point)
    expect(actual.x).toBeCloseTo(target.x, 8)
    expect(actual.y).toBeCloseTo(target.y, 8)
    const direct = apply(expected, apply(baseScreen, point))
    expect(actual.x).toBeCloseTo(direct.x, 8)
    expect(actual.y).toBeCloseTo(direct.y, 8)
  }
})

test('screen content affine is the camera conjugate of the inverse world chrome affine', () => {
  const f = fixture(), camera: Matrix = [2.25, 0, 0, 2.25, -.375, .125]
  const base: Matrix = f.selected.transform, current: Matrix = [.6, .8, -.8, .6, 45, 18]
  const scene = compiledScene(camera, f.parent.transform, base, f.parent.id, f.selected.id)
  const content = residentContentAffines(scene, { [f.selected.id]: current })[f.selected.id]
  const chrome = residentOverlayAffines(scene, { [f.selected.id]: current })[f.selected.id]
  // chrome is world-space (camera cancelled); content is screen-space. They relate
  // by content = camera * inverse(chrome) * inverse(camera).
  const conjugated = multiply(camera, multiply(inverse(chrome), inverse(camera)))
  conjugated.forEach((value, i) => expect(content[i]).toBeCloseTo(value, 8))
})

test('identity pose yields identity content affine; singular poses are rejected', () => {
  const f = fixture(), camera: Matrix = [1, 0, 0, 1, 0, 0]
  const scene = compiledScene(camera, f.parent.transform, f.selected.transform, f.parent.id, f.selected.id)
  const same = residentContentAffines(scene, { [f.selected.id]: f.selected.transform })[f.selected.id]
  ;[1, 0, 0, 1, 0, 0].forEach((value, i) => expect(same[i]).toBeCloseTo(value, 9))
  // A degenerate (zero-area) current pose has no inverse and must be dropped.
  const singular = residentContentAffines(scene, { [f.selected.id]: [0, 0, 0, 0, 5, 5] as Matrix })
  expect(singular[f.selected.id]).toBeUndefined()
})