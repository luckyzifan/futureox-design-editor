import { expect, test } from 'vitest'
import { editableNetwork, materializeEditableNetwork, ELLIPSE_EDIT_KAPPA } from './editable-network'
import { blank, node, type DesignDocument } from './model'
import { Editor } from './engine'
import { VectorEngine } from './generated/design-kernel/design_kernel'

function render(document: DesignDocument) {
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(document))
    return engine.render_rgba(JSON.stringify({ pageId: document.pages[0].id, width: 64, height: 64,
      view: { x: 0, y: 0, zoom: 1 }, transparent: true, grid: false, rasterProfile: 'analytic' }))
  } finally { engine.free() }
}

test('ellipse overlay uses four closed cardinal cubics with tangent controls', () => {
  const ellipse = node('ellipse', 12, 18, 200, 100)
  const before = structuredClone(ellipse)
  const draft = editableNetwork(ellipse)
  expect(draft.vertices.map(({ x, y }) => [x, y])).toEqual([[200, 50], [100, 100], [0, 50], [100, 0]])
  expect(draft.edges).toHaveLength(4)
  for (let i = 0; i < 4; i++) {
    expect(draft.edges[i].from).toBe(draft.vertices[i].id)
    expect(draft.edges[i].to).toBe(draft.vertices[(i + 1) % 4].id)
    expect(draft.edges[i].c1).toBeDefined(); expect(draft.edges[i].c2).toBeDefined()
  }
  expect(draft.edges[0].c1).toEqual({ x: 200, y: 50 + 50 * ELLIPSE_EDIT_KAPPA })
  expect(draft.edges[0].c2).toEqual({ x: 100 + 100 * ELLIPSE_EDIT_KAPPA, y: 100 })
  expect(draft.edges[3].c2).toEqual({ x: 200, y: 50 - 50 * ELLIPSE_EDIT_KAPPA })
  expect(ellipse).toEqual(before)
  expect(editableNetwork(ellipse)).toEqual(draft)
})

test('existing vector networks are deeply cloned without replacing their authored IDs', () => {
  const original = node('vector')
  original.network = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 10, y: 20 }],
    edges: [{ id: 'edge', from: 'a', to: 'b', c1: { x: 3, y: 4 }, c2: { x: 8, y: 9 } }], fillRule: 'nonzero' }
  const snapshot = structuredClone(original)
  const draft = editableNetwork(original)
  expect(draft).toEqual(original.network)
  draft.vertices[0].x = 123; draft.edges[0].c1!.x = 456
  expect(original).toEqual(snapshot)
})

for (const kind of ['rectangle', 'polygon', 'star', 'line'] as const) {
  test(`${kind} editing IDs are stable and do not mutate the primitive`, () => {
    const primitive = node(kind, 1.25, -3.5, 100, 60), snapshot = structuredClone(primitive)
    const a = editableNetwork(primitive), b = editableNetwork(primitive)
    expect(a).toEqual(b)
    expect(a.vertices.every((vertex) => vertex.id.startsWith(primitive.id))).toBe(true)
    a.vertices[0].x += 4
    expect(b.vertices[0].x).not.toBe(a.vertices[0].x)
    expect(primitive).toEqual(snapshot)
  })
}

test('entering and leaving virtual editing preserves document identity, undo and actual WASM Arc pixels', () => {
  const doc = blank(), ellipse = node('ellipse', 5.25, 4.5, 20.5, 16.25)
  doc.nodes[ellipse.id] = ellipse; doc.pages[0].children = [ellipse.id]
  const editor = new Editor(doc), original = editor.state.doc, json = JSON.stringify(original), pixels = render(original)
  editor.select([ellipse.id]); editor.set({ tool: 'vector' })
  const draft = editableNetwork(editor.state.doc.nodes[ellipse.id])
  expect(draft.edges).toHaveLength(4)
  editor.set({ tool: 'select', editingVertex: null })
  expect(editor.state.doc).toBe(original)
  expect(JSON.stringify(editor.state.doc)).toBe(json)
  expect(editor.canUndo).toBe(false)
  expect(render(editor.state.doc)).toEqual(pixels)
})

test('one actual edit can be materialized as one transaction and undo restores the exact Arc', () => {
  const doc = blank(), ellipse = node('ellipse', 6.25, 6.5, 24.5, 20.25)
  doc.nodes[ellipse.id] = ellipse; doc.pages[0].children = [ellipse.id]
  const editor = new Editor(doc), original = structuredClone(editor.state.doc), pixels = render(editor.state.doc)
  const draft = editableNetwork(ellipse); draft.vertices[0].x += 3
  const edited = materializeEditableNetwork(ellipse, draft)
  expect(edited.id).toBe(ellipse.id); expect(edited.fills).toEqual(ellipse.fills)
  draft.vertices[0].x += 9
  expect(edited.network!.vertices[0].x).not.toBe(draft.vertices[0].x)
  editor.update([ellipse.id], { kind: edited.kind, network: edited.network }, '编辑曲线')
  expect(editor.state.doc.nodes[ellipse.id].kind).toBe('vector')
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc).toEqual(original)
  expect(editor.state.doc.nodes[ellipse.id].kind).toBe('ellipse')
  expect(editor.state.doc.nodes[ellipse.id].network).toBeUndefined()
  expect(render(editor.state.doc)).toEqual(pixels)
  expect(editor.canUndo).toBe(false)
})
