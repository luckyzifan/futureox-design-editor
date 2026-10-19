import { expect, test } from 'vitest'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { Editor } from './engine'
import { apply, contoursToNetwork } from './geometry'
import {
  blank,
  node,
  paint,
  type DesignDocument,
  type DesignNode,
  type Matrix,
  type Point,
} from './model'

function fixture(parent: DesignNode, children: DesignNode[]) {
  const doc = blank()
  doc.nodes[parent.id] = parent
  parent.children = children.map((n) => n.id)
  for (const n of children) doc.nodes[n.id] = n
  doc.pages[0].children = [parent.id]
  return doc
}
function alphaAt(doc: DesignDocument, p: Point, zoom: number) {
  const core = new VectorEngine()
  try {
    core.load_document(JSON.stringify(doc))
    return core.render_rgba(
      JSON.stringify({
        pageId: doc.pages[0].id,
        width: 32,
        height: 32,
        transparent: true,
        view: { x: 16.5 - p.x * zoom, y: 16.5 - p.y * zoom, zoom },
      }),
    )[(16 * 32 + 16) * 4 + 3]
  } finally {
    core.free()
  }
}
const transforms: Matrix[] = [
  [1, 0, 0, 1, 0.125, -0.375],
  [-1, 0, 0, 1, 120.125, 0.375],
  [1, 0.25, 0.75, 1, -0.125, 0.375],
  [1, 0.25, 0.75, 1, 9999999.125, -9999999.125],
  [-1, 0, 0.25, 1, -9999999.125, 9999999.125],
]

test('rounded ancestor clip excludes child picking outside the CPU fill under affine transforms', () => {
  for (const matrix of transforms) {
    const parent = node('frame', 0, 0, 100, 100),
      child = node('rectangle', 0, 0, 100, 100)
    parent.transform = matrix
    parent.radii = [40, 40, 40, 40]
    parent.fills = []
    const doc = fixture(parent, [child]),
      editor = new Editor(doc)
    editor.set({ view: { x: 0, y: 0, zoom: 32 } })
    const outside = apply(matrix, { x: 1, y: 1 }),
      inside = apply(matrix, { x: 25, y: 25 })
    expect(alphaAt(doc, outside, 32)).toBe(0)
    expect(editor.hit(outside, true)).not.toBe(child.id)
    expect(alphaAt(doc, inside, 32)).toBe(255)
    expect(editor.hit(inside, true)).toBe(child.id)
  }
})

test('tiny curved ancestor mask uses the same device geometry as the rendered CPU path', () => {
  for (const matrix of transforms) {
    const parent = node('group'),
      mask = node('vector', 0, 0, 0.003, 0.001),
      child = node('rectangle', 0, 0, 4, 2)
    parent.transform = matrix
    mask.transform = [1000, 0, 0, 1000, 0, 0]
    mask.mask = true
    mask.locked = true
    mask.fills = [paint('#ffffff')]
    mask.strokes = []
    mask.network = {
      vertices: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0.001, y: 0 },
        { id: 'c', x: 0.001, y: 0.001 },
        { id: 'd', x: 0, y: 0.001 },
      ],
      edges: [
        { id: 'ab', from: 'a', to: 'b' },
        { id: 'bc', from: 'b', to: 'c', c1: { x: 0.003, y: 0 }, c2: { x: 0.003, y: 0.001 } },
        { id: 'cd', from: 'c', to: 'd' },
        { id: 'da', from: 'd', to: 'a' },
      ],
      fillRule: 'evenodd',
    }
    const doc = fixture(parent, [mask, child]),
      editor = new Editor(doc),
      p = apply(matrix, { x: 2, y: 0.5 })
    editor.set({ view: { x: 0, y: 0, zoom: 32 } })
    expect(alphaAt(doc, p, 32)).toBe(255)
    expect(editor.hit(p, true)).toBe(child.id)
  }
})

test('ancestor mask preserves nonzero winding rather than introducing an evenodd hole', () => {
  const parent = node('group'),
    mask = node('vector', 0, 0, 100, 100),
    child = node('rectangle', 0, 0, 100, 100)
  mask.mask = true
  mask.locked = true
  mask.fills = [paint('#ffffff')]
  mask.strokes = []
  mask.network = contoursToNetwork([
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    [
      { x: 25, y: 25 },
      { x: 75, y: 25 },
      { x: 75, y: 75 },
      { x: 25, y: 75 },
    ],
  ])
  mask.network.fillRule = 'nonzero'
  const doc = fixture(parent, [mask, child]),
    editor = new Editor(doc),
    p = { x: 50, y: 50 }
  expect(alphaAt(doc, p, 1)).toBe(255)
  expect(editor.hit(p, true)).toBe(child.id)
})

test('nested constraints refresh after pointer, zoom, edit, undo, and first-visible-mask changes', () => {
  const outer = node('frame', 0, 0, 100, 100),
    group = node('group'),
    mask = node('rectangle', 0, 0, 50, 100),
    nextMask = node('rectangle', 75, 0, 25, 100),
    child = node('rectangle', 0, 0, 100, 100)
  outer.radii = [40, 40, 40, 40]
  outer.fills = []
  mask.mask = nextMask.mask = true
  mask.locked = nextMask.locked = true
  const doc = fixture(outer, [group])
  for (const n of [mask, nextMask, child]) doc.nodes[n.id] = n
  group.children = [mask.id, nextMask.id, child.id]
  const editor = new Editor(doc),
    p = { x: 25, y: 25 }
  for (const zoom of [0.025, 0.25, 1, 32, 1, 0.025]) {
    editor.set({ view: { x: 999.125, y: -543.375, zoom } })
    expect(editor.hit(p, true)).toBe(child.id)
    expect(editor.hit({ x: 1, y: 1 }, true)).not.toBe(child.id)
    expect(editor.hit({ x: 75, y: 50 }, true)).not.toBe(child.id)
    expect(editor.hit(p, true)).toBe(child.id)
  }
  editor.update([mask.id], { locked: false }, '切换锁定')
  editor.update([mask.id], { opacity: 0 })
  expect(editor.hit(p, true)).not.toBe(child.id)
  editor.undo()
  expect(editor.hit(p, true)).toBe(child.id)
  editor.update([mask.id], { visible: false }, '切换可见性')
  expect(editor.hit(p, true)).not.toBe(child.id)
  expect(editor.hit({ x: 85, y: 50 }, true)).toBe(child.id)
  editor.undo()
  expect(editor.hit(p, true)).toBe(child.id)
  editor.update([outer.id], { radii: [0, 0, 0, 0] })
  expect(editor.hit({ x: 1, y: 1 }, true)).toBe(child.id)
  editor.undo()
  expect(editor.hit({ x: 1, y: 1 }, true)).not.toBe(child.id)
})

test('geometric clip checks retain exact frame edges without the object selection halo', () => {
  const parent = node('frame', 0, 0, 10, 10),
    child = node('rectangle', -5, -5, 20, 20)
  parent.fills = []
  const editor = new Editor(fixture(parent, [child]))
  expect(editor.hit({ x: 10, y: 5 }, true)).toBe(child.id)
  expect(editor.hit({ x: 5, y: 10 }, true)).toBe(child.id)
  expect(editor.hit({ x: 10.001, y: 5 }, true)).not.toBe(child.id)
})

test('group and text masks retain the preexisting bounds proxy pending alpha-compositing picking', () => {
  for (const kind of ['group', 'text'] as const) {
    const parent = node('group'),
      mask = node(kind, 0, 0, 100, 100),
      child = node('rectangle', 0, 0, 100, 100)
    mask.mask = true
    mask.locked = true
    const editor = new Editor(fixture(parent, [mask, child]))
    expect(editor.hit({ x: 50, y: 50 }, true)).toBe(child.id)
  }
})

test('offscreen large curved masks reject before exceeding the device subdivision budget', () => {
  const parent = node('group'),
    mask = node('ellipse', 1e6, 1e6, 1e7, 1e7),
    child = node('rectangle', 0, 0, 100, 100)
  mask.mask = true
  mask.locked = true
  const doc = fixture(parent, [mask, child]),
    editor = new Editor(doc),
    p = { x: 10, y: 10 }
  editor.set({ view: { x: 0, y: 0, zoom: 32 } })
  expect(alphaAt(doc, p, 32)).toBe(0)
  expect(editor.hit(p, true)).toBe(null)
})
