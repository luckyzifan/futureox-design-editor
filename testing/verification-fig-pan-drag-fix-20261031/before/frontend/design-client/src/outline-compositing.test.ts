import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, effect, stroke } from './model'
import { geometry_json } from './generated/design-kernel/design_kernel'

function fixture(fills = false) {
  const d = blank(),
    a = node('rectangle', 0, 0, 20, 20),
    middle = node('rectangle', 5, 5, 5, 5),
    b = node('rectangle', 10, 0, 20, 20)
  for (const [n, color] of [
    [a, '#ff0000'],
    [b, '#0000ff'],
  ] as const) {
    n.fills = fills ? [paint('#ffffff')] : []
    n.strokes = [{ ...stroke(), paint: paint(color), width: 4, join: 'miter' }]
  }
  a.opacity = 0.25
  b.opacity = 0.8
  b.blend = 'multiply'
  b.effects = [
    { ...effect('shadow'), radius: 1, spread: 0, x: 2, y: 1, color: '#000000', opacity: 0.5 },
  ]
  d.nodes = Object.fromEntries([a, middle, b].map((n) => [n.id, n]))
  d.pages[0].children = [a.id, middle.id, b.id]
  const editor = new Editor(d)
  // Same production WASM operation, without web worker transport.
  Object.assign(editor, {
    runGeometry: async (payload: unknown) => JSON.parse(geometry_json(JSON.stringify(payload))),
  })
  editor.select([a.id, b.id])
  return { editor, a, b, middle }
}
test('outlines retain each source style and its original sibling slot through undo/redo', async () => {
  const { editor, a, b, middle } = fixture()
  await editor.geometry('outline')
  expect(editor.state.message).toBe('矢量几何运算')
  const roots = editor.state.doc.pages[0].children.map((id) => editor.state.doc.nodes[id])
  expect(roots[1].id).toBe(middle.id)
  expect(roots[0].opacity).toBe(a.opacity)
  expect(roots[2].opacity).toBe(b.opacity)
  expect(roots[2].blend).toBe('multiply')
  expect(roots[2].effects).toEqual(b.effects)
  const after = editor.state.doc
  editor.undo()
  expect(editor.state.doc.nodes[b.id].kind).toBe('rectangle')
  editor.redo()
  expect(editor.state.doc.pages[0].children).toEqual(after.pages[0].children)
  for (const id of after.pages[0].children) {
    const actual = editor.state.doc.nodes[id],
      expected = after.nodes[id]
    expect(actual.opacity).toBe(expected.opacity)
    expect(actual.blend).toBe(expected.blend)
    expect(actual.effects).toEqual(expected.effects)
    expect(actual.network?.vertices).toEqual(expected.network?.vertices)
  }
})
test('fill and stroke stay together under source compositing applied exactly once', async () => {
  const { editor, a, b, middle } = fixture(true)
  await editor.geometry('outline')
  expect(editor.state.message).toBe('矢量几何运算')
  const d = editor.state.doc,
    roots = d.pages[0].children.map((id) => d.nodes[id])
  expect(roots[1].id).toBe(middle.id)
  for (const [group, original] of [
    [roots[0], a],
    [roots[2], b],
  ] as const) {
    expect(['group', 'frame']).toContain(group.kind)
    expect(group.opacity).toBe(original.opacity)
    expect(group.blend).toBe(original.blend)
    expect(group.effects).toEqual(original.effects)
    expect(group.children).toHaveLength(2)
    const children = group.children.map((id) => d.nodes[id])
    expect(children[0].fills[0].color).toBe('#ffffff')
    expect(children[1].fills[0].color).toBe(original.strokes[0].paint.color)
    for (const child of children) {
      expect(child.opacity).toBe(1)
      expect(child.blend).toBe('normal')
      expect(child.effects).toEqual([])
    }
  }
})
test('session generation changes on same-document reload and disposal', () => {
  const editor = new Editor(blank()),
    g = editor.sessionGeneration
  editor.load(editor.state.doc)
  expect(editor.sessionGeneration).toBe(g + 1)
  editor.dispose()
  expect(editor.sessionGeneration).toBe(g + 2)
})

test('resolved bindings and styles are baked once, including overlapping fill/strokes', async () => {
  const { editor, a, b } = fixture(true)
  editor.change('Bind source', (d) => {
    d.schemaVersion = 6
    d.designSystem = {
      collections: { c: { name: 'C', modes: ['m'], defaultMode: 'm' } },
      variables: { alpha: { name: 'Alpha', collection: 'c', kind: 'number', values: { m: 0.4 } } },
      styles: { shadow: { name: 'Shadow', kind: 'effect', value: b.effects } },
      activeModes: {},
      libraries: {},
    }
    d.nodes[a.id].bindings = { opacity: 'alpha' }
    d.nodes[b.id].styleRefs = { effects: 'shadow' }
    d.nodes[b.id].variableModes = { c: 'm' }
  })
  const before = editor.state.doc
  const { VectorEngine } = await import('./generated/design-kernel/design_kernel')
  const engine = new VectorEngine()
  const render = (d: typeof before) => {
    engine.load_document(JSON.stringify(d))
    return engine.render_rgba(
      JSON.stringify({
        pageId: d.pages[0].id,
        width: 48,
        height: 40,
        view: { x: 5, y: 5, zoom: 1 },
        transparent: true,
        rasterProfile: 'analytic',
      }),
    )
  }
  try {
    const pixels = render(before)
    await editor.geometry('outline')
    expect(editor.state.message).toBe('矢量几何运算')
    const d = editor.state.doc
    const groups = [d.nodes[d.pages[0].children[0]], d.nodes[d.pages[0].children[2]]]
    expect(groups[0].opacity).toBe(0.4)
    for (const group of groups)
      for (const id of group.children) {
        expect(d.nodes[id].opacity).toBe(1)
        expect(d.nodes[id].effects).toEqual([])
        expect(d.nodes[id].bindings).toBeUndefined()
        expect(d.nodes[id].styleRefs).toBeUndefined()
      }
    expect([...render(d)]).toEqual([...pixels])
  } finally {
    engine.free()
  }
})

test('empty outline results do not shift later source styles', async () => {
  const { editor, b, middle } = fixture()
  Object.assign(editor, {
    runGeometry: async (payload: unknown) => {
      const results = JSON.parse(geometry_json(JSON.stringify(payload)))
      results[0] = []
      return results
    },
  })
  await editor.geometry('outline')
  const roots = editor.state.doc.pages[0].children.map((id) => editor.state.doc.nodes[id])
  expect(roots).toHaveLength(2)
  expect(roots[0].id).toBe(middle.id)
  expect(roots[1].opacity).toBe(b.opacity)
  expect(roots[1].blend).toBe(b.blend)
  const outline = roots[1].children.length ? editor.state.doc.nodes[roots[1].children[0]] : roots[1]
  expect(outline.fills[0].color).toBe(b.strokes[0].paint.color)
})
test('single outlined source retains transformed effect scale', async () => {
  const { editor, b } = fixture()
  editor.change('Scale', (d) => {
    d.nodes[b.id].transform = [2, 0, 0, 3, 10, 0]
  })
  editor.select([b.id])
  await editor.geometry('outline')
  const result = editor.state.doc.nodes[editor.state.selection[0]]
  expect(result.kind).toBe('frame')
  expect(result.transform.slice(0, 4)).toEqual([2, 0, 0, 3])
  expect(result.effects).toEqual(b.effects)
})

test.each(['background-blur', 'glass'] as const)(
  'outlined ellipse preserves %s backdrop coverage',
  async (kind) => {
    const d = blank(),
      bg = node('rectangle', 0, 0, 20, 40),
      shape = node('ellipse', 5, 5, 30, 30)
    bg.fills = [paint('#ff0000')]
    shape.fills = [{ ...paint('#ffffff'), opacity: 0.1 }]
    shape.strokes = [{ ...stroke('#000000', 2), join: 'miter' }]
    shape.effects = [{ ...effect(kind), radius: 4 }]
    d.schemaVersion = 5
    d.nodes = { [bg.id]: bg, [shape.id]: shape }
    d.pages[0].children = [bg.id, shape.id]
    const editor = new Editor(d)
    editor.select([shape.id])
    Object.assign(editor, {
      runGeometry: async (payload: unknown) => JSON.parse(geometry_json(JSON.stringify(payload))),
    })
    const { VectorEngine } = await import('./generated/design-kernel/design_kernel')
    const renderer = new VectorEngine()
    const render = () => {
      renderer.load_document(JSON.stringify(editor.state.doc))
      return renderer.render_rgba(
        JSON.stringify({
          pageId: d.pages[0].id,
          width: 40,
          height: 40,
          transparent: true,
          rasterProfile: 'analytic',
          view: { x: 0, y: 0, zoom: 1 },
        }),
      )
    }
    try {
      const before = render()
      await editor.geometry('outline')
      const after = render()
      expect(editor.state.message).toBe('矢量几何运算')
      // Interior backdrop pixels must survive; outlining approximates stroke edges.
      for (const [x, y] of [
        [23, 20],
        [17, 20],
        [20, 23],
      ]) {
        const i = (y * 40 + x) * 4
        expect([...after.slice(i, i + 4)]).toEqual([...before.slice(i, i + 4)])
      }
    } finally {
      renderer.free()
    }
  },
)

test('outlining a live Boolean bakes geometry and removes operand descendants atomically', async () => {
  const { editor, a, b } = fixture(true)
  editor.group(false, 'union')
  const booleanId = editor.state.selection[0]
  expect(editor.state.doc.nodes[booleanId].booleanOperation).toBe('union')
  await editor.geometry('outline')
  expect(editor.state.message).toBe('矢量几何运算')
  expect(editor.state.doc.nodes[a.id]).toBeUndefined()
  expect(editor.state.doc.nodes[b.id]).toBeUndefined()
  expect(Object.values(editor.state.doc.nodes).some((n) => n.booleanOperation)).toBe(false)
  editor.undo()
  expect(editor.state.doc.nodes[booleanId].booleanOperation).toBe('union')
  expect(editor.state.doc.nodes[a.id]).toBeDefined()
  expect(editor.state.doc.nodes[b.id]).toBeDefined()
})
