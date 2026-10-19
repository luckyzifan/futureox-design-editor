import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { Graph } from './kernel/graph'
import { blank, node, type DesignDocument, type DesignNode } from './model'

afterEach(() => vi.restoreAllMocks())

function fixture(prepare?: (document: DesignDocument, a: DesignNode) => void) {
  const document = blank('Local editing')
  const a = node('rectangle', 10, 20, 40, 30), b = node('ellipse', 80, 20, 40, 30)
  document.nodes = { [a.id]: a, [b.id]: b }
  document.pages[0].children = [a.id]
  const secondPage = { ...blank().pages[0], name: 'Second page', children: [b.id] }
  document.pages.push(secondPage)
  prepare?.(document, a)
  return { editor: new Editor(document), a, b, secondPage: secondPage.id }
}

test('previewBase composes property and drag changes into one shared document and undo entry', () => {
  const { editor, a, b } = fixture()
  try {
    editor.select([a.id])
    const before = editor.state.doc, version = editor.state.version
    editor.begin('Move and rename')
    editor.change('Rename', (draft) => { draft.nodes[a.id].name = 'Renamed' })
    expect(editor.canUndo).toBe(false)
    expect(editor.preview({ [a.id]: { transform: [1, 0, 0, 1, 30, 40] } })).toBe(true)
    expect(editor.preview({ [a.id]: { transform: [1, 0, 0, 1, 50, 60] } })).toBe(true)
    expect(editor.state.doc.nodes[a.id].name).toBe('Renamed')
    expect(editor.state.version).toBe(version)
    editor.commit()
    const after = editor.state.doc
    expect(after.nodes[a.id].transform).toEqual([1, 0, 0, 1, 50, 60])
    expect(after.nodes[b.id]).toBe(before.nodes[b.id])
    expect(editor.state.version).toBe(version + 1)
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.selection).toEqual([a.id])
    expect(editor.canUndo).toBe(false)
    editor.redo()
    expect(editor.state.doc).toBe(after)
  } finally { editor.dispose() }
})

test('undo and redo restore the exact document, page and selection from both sides of navigation', () => {
  const { editor, a, b, secondPage } = fixture()
  try {
    editor.select([a.id])
    const before = editor.state.doc, firstPage = editor.state.page
    editor.change('Rename', (draft) => { draft.nodes[a.id].name = 'Renamed' })
    const after = editor.state.doc
    editor.set({ page: secondPage, selection: [b.id] })
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.page).toBe(firstPage)
    expect(editor.state.selection).toEqual([a.id])
    editor.redo()
    expect(editor.state.doc).toBe(after)
    expect(editor.state.page).toBe(secondPage)
    expect(editor.state.selection).toEqual([b.id])
  } finally { editor.dispose() }
})

test('a rejected graph operation leaves the editor clean and surfaces the error without replacement', () => {
  const { editor, a } = fixture()
  try {
    const before = editor.state.doc, version = editor.state.version
    const replacement = vi.spyOn(Graph.prototype, 'replaceDocument')
    const rejected = vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => {
      throw new Error('operation rejected')
    })
    editor.change('Rename', (draft) => { draft.nodes[a.id].name = 'Renamed' })
    expect(rejected).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(version)
    expect(editor.state.message).toContain('operation rejected')
    expect(editor.canUndo).toBe(false)
    editor.change('Retry rename', (draft) => { draft.nodes[a.id].name = 'Renamed' })
    expect(editor.state.doc.nodes[a.id].name).toBe('Renamed')
    expect(editor.state.version).toBe(version + 1)
    editor.undo()
    expect(editor.state.doc).toBe(before)
  } finally { editor.dispose() }
})

test('a rejected transaction rolls back its preview while keeping the older successful history', () => {
  const { editor, a } = fixture()
  try {
    const initial = editor.state.doc
    editor.select([a.id])
    editor.change('First rename', (draft) => { draft.nodes[a.id].name = 'First' })
    const before = editor.state.doc, version = editor.state.version
    editor.begin('Move')
    expect(editor.preview({ [a.id]: { transform: [1, 0, 0, 1, 90, 100] } })).toBe(true)
    vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => { throw new Error('commit rejected') })
    editor.commit()
    expect(editor.interactionActive).toBe(false)
    expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(version)
    expect(editor.state.selection).toEqual([a.id])
    expect(editor.state.message).toContain('commit rejected')
    editor.undo()
    expect(editor.state.doc).toBe(initial)
    expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})

test('editor undo and redo retain authored optional shapes rather than normalizing them from the graph', () => {
  const { editor, a } = fixture((document, layer) => {
    // Imported forward-compatible shapes may contain explicit null optionals.
    Object.assign(layer, { network: null, futureNodeData: { source: 'sketch' } })
    Object.assign(document, { futureCompatibility: { nullable: null } })
  })
  try {
    const before = editor.state.doc
    editor.change('Rename', (draft) => { draft.nodes[a.id].name = 'Renamed' })
    const after = editor.state.doc
    editor.undo()
    expect(editor.state.doc).toBe(before)
    expect(editor.state.doc.nodes[a.id].network).toBeNull()
    expect(Object.hasOwn(editor.state.doc.nodes[a.id], 'layout')).toBe(false)
    editor.redo()
    expect(editor.state.doc).toBe(after)
    expect(editor.state.doc.nodes[a.id].network).toBeNull()
    expect(Object.hasOwn(editor.state.doc.nodes[a.id], 'layout')).toBe(false)
    expect(editor.state.doc).toMatchObject({ futureCompatibility: { nullable: null } })
  } finally { editor.dispose() }
})

test('editor navigation metadata stays aligned with the bounded Rust history across truncation and redo', () => {
  const { editor, a } = fixture()
  try {
    for (let i = 0; i < 140; i++)
      editor.change(`Rename ${i}`, (draft) => { draft.nodes[a.id].name = `Name ${i}` })
    const final = editor.state.doc
    let undos = 0
    while (editor.canUndo) { editor.undo(); undos++; if (undos > 128) throw new Error('unbounded undo') }
    expect(undos).toBe(128)
    expect(editor.state.doc.nodes[a.id].name).toBe('Name 11')
    let redos = 0
    while (editor.canRedo) { editor.redo(); redos++; if (redos > 128) throw new Error('unbounded redo') }
    expect(redos).toBe(128)
    expect(editor.state.doc).toBe(final)
  } finally { editor.dispose() }
})
