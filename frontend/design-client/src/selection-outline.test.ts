import { expect, test } from 'vitest'
import { apply, boxPoints, multiply, rotate, scene, translate } from './geometry'
import { blank, node, type Matrix, type Point } from './model'
import { kernelBounds } from './kernel/picking'
import { figmaFixture } from './figma-fixtures'
import { rotationStartOutline } from './selection-chrome-pose'
import { selectionMemberCorners, sharedRotationFrame } from './selection-outline'

const place = (x: number, y: number, width: number, height: number, degrees: number) => {
  const shape = node('rectangle', x, y, width, height)
  shape.transform = multiply(translate(x, y), rotate(degrees))
  return shape
}

function cornersOf(shape: ReturnType<typeof place>) {
  return boxPoints({ x: 0, y: 0, width: shape.width, height: shape.height }).map(point => apply(shape.transform, point))
}

function edgeLength(a: Point, b: Point) {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function edgeAngle(a: Point, b: Point) {
  return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
}

test('a curve outline uses kernel extrema, not the authored 128 square', () => {
  const doc = figmaFixture('curve')
  const entry = scene(doc, doc.pages[0].id).find(item => doc.nodes[item.id].kind === 'vector')!
  const shape = doc.nodes[entry.id]
  expect(shape.width).toBe(128)
  expect(shape.height).toBe(128)
  const geometric = kernelBounds(shape)
  expect(geometric).toEqual({ x: 8, y: 8, width: 100, height: 75 })
  const corners = selectionMemberCorners(doc, shape.id, entry.matrix)
  expect(corners).toEqual(boxPoints(geometric!).map(point => apply(entry.matrix, point)))
  const authored = boxPoints({ x: 0, y: 0, width: shape.width, height: shape.height }).map(point => apply(entry.matrix, point))
  expect(corners).not.toEqual(authored)
})

test('a stale group outline follows its children, including a zero-height child', () => {
  const doc = blank('group outline')
  const group = node('group', 10, 20, 4, 4)
  const child = node('rectangle', 30, 40, 80, 50)
  const flat = node('rectangle', 30, 100, 40, 0)
  group.children = [child.id, flat.id]
  doc.nodes = { [group.id]: group, [child.id]: child, [flat.id]: flat }
  doc.pages[0].children = [group.id]
  const entry = scene(doc, doc.pages[0].id).find(item => item.id === group.id)!
  expect(selectionMemberCorners(doc, group.id, entry.matrix)).toEqual([
    { x: 40, y: 60 }, { x: 120, y: 60 }, { x: 120, y: 120 }, { x: 40, y: 120 },
  ])
  const alone = blank('line')
  alone.nodes[flat.id] = flat
  alone.pages[0].children = [flat.id]
  expect(selectionMemberCorners(alone, flat.id, flat.transform)).toEqual([
    { x: 30, y: 100 }, { x: 70, y: 100 }, { x: 70, y: 100 }, { x: 30, y: 100 },
  ])
})

test('two rectangles at the same 30 degree rotation share that box, and a page offset does not stay axis aligned', () => {
  const cos = Math.cos(Math.PI / 6)
  const sin = Math.sin(Math.PI / 6)
  const first = place(0, 0, 100, 40, 30)
  const along = place(0, 0, 100, 40, 30)
  along.transform = multiply(translate(160 * cos, 160 * sin), rotate(30))
  const aligned = sharedRotationFrame([
    { matrix: first.transform, corners: cornersOf(first) },
    { matrix: along.transform, corners: cornersOf(along) },
  ])
  expect(aligned).not.toBeNull()
  const [a, b, , d] = aligned!.corners
  expect(a.x).toBeCloseTo(0, 6)
  expect(a.y).toBeCloseTo(0, 6)
  expect(edgeLength(a, b)).toBeCloseTo(260, 6)
  expect(edgeLength(a, d)).toBeCloseTo(40, 6)
  expect(edgeAngle(a, b)).toBeCloseTo(30, 6)

  const beside = place(160, 0, 100, 40, 30)
  const offset = sharedRotationFrame([
    { matrix: first.transform, corners: cornersOf(first) },
    { matrix: beside.transform, corners: cornersOf(beside) },
  ])
  expect(offset).not.toBeNull()
  expect(edgeAngle(offset!.corners[0], offset!.corners[1])).toBeCloseTo(30, 6)
  expect(Math.min(...offset!.corners.map(point => point.y))).toBeLessThan(-1)
  const pageAligned = [
    { x: -20, y: 0 }, { x: 246.60254037844388, y: 0 },
    { x: 246.60254037844388, y: 84.64101615137754 }, { x: -20, y: 84.64101615137754 },
  ]
  expect(offset!.corners.map(point => point.y)).not.toEqual(pageAligned.map(point => point.y))
})

test('different rotations, skew, and page-aligned angles keep the scene union', () => {
  const at = (degrees: number) => {
    const shape = place(0, 0, 100, 40, degrees)
    return { matrix: shape.transform, corners: cornersOf(shape) }
  }
  expect(sharedRotationFrame([at(30), at(15)])).toBeNull()
  expect(sharedRotationFrame([at(0), at(0)])).toBeNull()
  expect(sharedRotationFrame([at(90), at(90)])).toBeNull()
  expect(sharedRotationFrame([at(30), at(30.004)])).not.toBeNull()
  expect(sharedRotationFrame([at(30), at(30.006)])).toBeNull()
  const skew = [1, 0, 0.25, 1, 0, 0] as Matrix
  const square = boxPoints({ x: 0, y: 0, width: 10, height: 10 }).map(point => apply(skew, point))
  expect(sharedRotationFrame([{ matrix: skew, corners: square }, { matrix: skew, corners: square }])).toBeNull()
})

test('children inside one rotated frame share that world rotation', () => {
  const doc = blank('parent rotation')
  const frame = node('frame', 0, 0, 400, 200)
  frame.transform = multiply(translate(0, 0), rotate(30))
  const left = node('rectangle', 10, 20, 40, 20)
  const right = node('rectangle', 80, 20, 30, 20)
  frame.children = [left.id, right.id]
  doc.nodes = { [frame.id]: frame, [left.id]: left, [right.id]: right }
  doc.pages[0].children = [frame.id]
  const entries = scene(doc, doc.pages[0].id).filter(entry => entry.id === left.id || entry.id === right.id)
  const frameBox = sharedRotationFrame(entries.map(entry => ({
    matrix: entry.matrix,
    corners: selectionMemberCorners(doc, entry.id, entry.matrix)!,
  })))
  expect(frameBox).not.toBeNull()
  expect(edgeAngle(frameBox!.corners[0], frameBox!.corners[1])).toBeCloseTo(30, 6)
  const held = entries.map(entry => selectionMemberCorners(doc, entry.id, entry.matrix)!)
  expect(rotationStartOutline(held, entries.map(entry => entry.matrix))).toEqual(frameBox!.corners)
})
