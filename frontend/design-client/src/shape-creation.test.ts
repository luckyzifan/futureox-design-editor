import { expect, test } from 'vitest'
import { blank, uid, validateDocument } from './model'
import { createShapeSeed, creationGhostNode, creationPointCount, creationPreviewPoints, creationToolStaysArmed, creationVisiblePaint, resolveShapeCreation, translateCreationAnchor, type ShapeCreationKind } from './shape-creation'

const anchor = { x: 10.25, y: -9.75 }
const options = { anchor, pointer: { x: 31.875, y: 5.125 }, screenDistance: 30, snap: false }

for (const kind of ['rectangle', 'ellipse', 'polygon', 'star', 'frame', 'section', 'text'] as ShapeCreationKind[]) {
  test(`${kind}: preview and commit preserve identity, attributes and fractional geometry`, () => {
    const seed = createShapeSeed(kind, uid())
    const preview = resolveShapeCreation(seed, options)
    const commit = resolveShapeCreation(seed, options)
    expect(commit).toEqual(preview)
    expect(seed.transform).toEqual([1, 0, 0, 1, 0, 0])
    expect(commit.node.id).toBe(seed.id)
    expect(commit.node.fills).toEqual(seed.fills)
    expect(commit.bounds).toEqual({ x: 10.25, y: -9.75, width: 21.625, height: 14.875 })
    const doc = blank(); doc.nodes[commit.node.id] = commit.node; doc.pages[0].children = [commit.node.id]
    expect(() => validateDocument(doc)).not.toThrow()
  })
}

for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const snap of [false, true]) {
  test(`square/centre constraints survive quadrant ${sx}/${sy}, snap=${snap}`, () => {
    const seed = createShapeSeed('ellipse', 'circle')
    const result = resolveShapeCreation(seed, { anchor, pointer: { x: anchor.x + sx * 10.5, y: anchor.y + sy * 4.5 }, screenDistance: 12, shift: true, alt: true, snap })
    expect(result.bounds.width).toBe(result.bounds.height)
    const centre = snap ? { x: 10, y: -10 } : anchor
    expect((result.start.x + result.end.x) / 2).toBe(centre.x)
    expect((result.start.y + result.end.y) / 2).toBe(centre.y)
    expect(Math.sign(result.end.x - centre.x)).toBe(sx)
    expect(Math.sign(result.end.y - centre.y)).toBe(sy)
    if (snap) for (const value of [...Object.values(result.start), ...Object.values(result.end)]) expect(Number.isInteger(value)).toBe(true)
  })
}

test('Space translates the creation anchor without changing the span', () => {
  const anchor = { x: 40.25, y: 18.5 }
  const origin = { x: 90.75, y: 48.25 }
  const pointer = { x: 130.125, y: 70.75 }
  const moved = translateCreationAnchor(anchor, origin, pointer)
  expect(moved).toEqual({ x: 79.625, y: 41 })
  const before = resolveShapeCreation(createShapeSeed('rectangle', 'space'), { anchor, pointer: origin, screenDistance: 40 })
  const after = resolveShapeCreation(createShapeSeed('rectangle', 'space'), { anchor: moved, pointer, screenDistance: 40 })
  expect(after.bounds.width).toBeCloseTo(before.bounds.width, 8)
  expect(after.bounds.height).toBeCloseTo(before.bounds.height, 8)
  expect(after.bounds.x - before.bounds.x).toBeCloseTo(pointer.x - origin.x, 8)
  expect(after.bounds.y - before.bounds.y).toBeCloseTo(pointer.y - origin.y, 8)
})

test('click threshold uses CSS screen distance; narrow and returning drags never become defaults', () => {
  const seed = createShapeSeed('rectangle', 'narrow')
  const click = resolveShapeCreation(seed, { ...options, screenDistance: 2.99 })
  expect(click.click).toBe(true); expect(click.bounds.width).toBe(100); expect(click.bounds.height).toBe(100)
  const narrow = resolveShapeCreation(seed, { ...options, pointer: { x: anchor.x + 0.125, y: anchor.y + 500 }, screenDistance: 3 })
  expect(narrow.click).toBe(false); expect(narrow.bounds.width).toBe(0.125); expect(narrow.bounds.height).toBe(500)
  const returning = resolveShapeCreation(seed, { ...options, pointer: anchor, screenDistance: 50 })
  expect(returning.click).toBe(false); expect(returning.bounds.width).toBe(0.01)
})

test('click defaults are 100 squares for frames and shapes; centre creation retains the anchor', () => {
  for (const kind of ['rectangle', 'ellipse', 'frame', 'text'] as const) {
    const result = resolveShapeCreation(createShapeSeed(kind), { ...options, screenDistance: 0, alt: true, snap: true })
    expect(result.bounds.width).toBe(100)
    expect(result.bounds.height).toBe(100)
    expect(result.bounds.x + result.bounds.width / 2).toBe(10)
    expect(result.bounds.y + result.bounds.height / 2).toBe(-10)
  }
})

test('a frame click and a frame drag share one fill, and the drag keeps the pointer span', () => {
  const seed = createShapeSeed('frame', 'frame')
  const click = resolveShapeCreation(seed, { ...options, screenDistance: 0 })
  const drag = resolveShapeCreation(seed, options)
  expect(click.bounds).toMatchObject({ width: 100, height: 100 })
  expect(drag.bounds).toEqual({ x: 10.25, y: -9.75, width: 21.625, height: 14.875 })
  expect(creationVisiblePaint(click.node)).toBe('#ffffff')
  expect(creationVisiblePaint(drag.node)).toBe(creationVisiblePaint(click.node))
  expect(drag.node.fills).toEqual(click.node.fills)
  expect(creationVisiblePaint(createShapeSeed('rectangle'))).toBe('#d9d9d9')
  expect(creationPreviewPoints(createShapeSeed('polygon'))).toBeTruthy()
})

test('the creation fill stays until the committed document is the presented frame', () => {
  const node = { id: 'new' }
  expect(creationGhostNode(node, null, () => false)).toBe(node)
  expect(creationGhostNode(null, node, () => false)).toBe(node)
  expect(creationGhostNode(null, node, () => true)).toBeNull()
  expect(creationGhostNode(null, null, () => false)).toBeNull()
})

test('line clicks create a 100px horizontal path with stable endpoints and compatibility height', () => {
  const seed = createShapeSeed('line', 'line')
  for (const alt of [false, true]) {
    const result = resolveShapeCreation(seed, { ...options, screenDistance: 0, alt })
    expect(result.bounds.width).toBe(100); expect(result.node.height).toBe(1)
    expect(result.node.network!.vertices.map((v) => v.y)).toEqual([0, 0])
    expect(result.node.network!.vertices.map((v) => v.id)).toEqual(['line:start', 'line:end'])
    expect(result.end.x - result.start.x).toBe(100)
    if (alt) expect((result.start.x + result.end.x) / 2).toBe(anchor.x)
  }
})

for (const [dx, dy, expected] of [[20, 4, 0], [20, 13, 45], [3, 20, 90], [-13, 20, 135], [-20, 3, 180], [-20, -13, -135], [3, -20, -90], [20, -13, -45]] as const) {
  test(`Shift line ${dx}/${dy} locks to ${expected} degrees without a different commit path`, () => {
    const result = resolveShapeCreation(createShapeSeed('line', 'l'), { anchor, pointer: { x: anchor.x + dx, y: anchor.y + dy }, screenDistance: 40, shift: true, alt: true, snap: true })
    expect(Math.atan2(result.end.y - result.start.y, result.end.x - result.start.x) * 180 / Math.PI).toBeCloseTo(expected, 10)
    expect((result.start.x + result.end.x) / 2).toBe(10)
    expect((result.start.y + result.end.y) / 2).toBe(-10)
    const vertices = result.node.network!.vertices
    expect(vertices[1].x - vertices[0].x).toBe(result.end.x - result.start.x)
    expect(vertices[1].y - vertices[0].y).toBe(result.end.y - result.start.y)
  })
}

test('a nearly vertical line keeps its authored fractional endpoints', () => {
  const result = resolveShapeCreation(createShapeSeed('line'), { ...options, pointer: { x: anchor.x + 0.0001, y: anchor.y + 300 }, screenDistance: 300 })
  expect(result.node.network!.vertices[1].x).toBeCloseTo(0.0001, 12)
  expect(result.node.network!.vertices[1].y).toBe(300)
})

test('rectangle, ellipse, polygon and frame stay armed; text and select do not', () => {
  for (const tool of ['rectangle', 'ellipse', 'polygon', 'frame', 'sticky']) expect(creationToolStaysArmed(tool)).toBe(true)
  expect(creationToolStaysArmed('text')).toBe(false)
  expect(creationToolStaysArmed('select')).toBe(false)
  expect(creationToolStaysArmed('pen')).toBe(false)
})

test('polygon creation defaults to three vertices and arrow changes are bounded', () => {
  expect(createShapeSeed('polygon').points).toBe(3)
  expect(createShapeSeed('star').points).toBe(5)
  expect(creationPointCount(3, -1)).toBe(3)
  expect(creationPointCount(3, 1)).toBe(4)
  expect(creationPointCount(60, 1)).toBe(60)
  expect(creationPointCount(60, -1)).toBe(59)
})

test('the creation ghost keeps the seed fill until the committed node is presented', () => {
  const seed = createShapeSeed('rectangle', 'ghost')
  const preview = resolveShapeCreation(seed, { ...options, screenDistance: 0 })
  expect(creationVisiblePaint(preview.node)).toBe('#d9d9d9')
  expect(creationGhostNode(preview.node, null, () => true)?.id).toBe('ghost')
  expect(creationGhostNode(null, preview.node, () => false)?.id).toBe('ghost')
  expect(creationGhostNode(null, preview.node, () => true)).toBeNull()
  const frame = resolveShapeCreation(createShapeSeed('frame', 'board'), { ...options, screenDistance: 0 })
  expect(frame.bounds).toEqual({ x: 10.25, y: -9.75, width: 100, height: 100 })
  expect(creationVisiblePaint(frame.node)).toBe('#ffffff')
  expect(creationPreviewPoints(createShapeSeed('star', 'star'))).toContain(',')
  expect(creationPreviewPoints(preview.node)).toBeNull()
})

test('a resolved line remains a valid portable design node', () => {
  const created = resolveShapeCreation(createShapeSeed('line'), { ...options, shift: true, alt: true, snap: true })
  const doc = blank(); doc.nodes[created.node.id] = created.node; doc.pages[0].children = [created.node.id]
  expect(() => validateDocument(doc)).not.toThrow()
})
