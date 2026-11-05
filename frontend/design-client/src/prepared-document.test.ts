import { expect, test, vi } from 'vitest'
import { blank, node } from './model'
import { prepareDocument, takePreparedDocument } from './prepared-document'
import { Editor } from './engine'
import { VectorEngine } from './generated/design-kernel/design_kernel'

test('save/adoption hands off the validated snapshot without caller aliases', () => {
  const source = blank('original'), rectangle = node('rectangle', 0, 0, 20, 20)
  source.nodes[rectangle.id] = rectangle; source.pages[0].children = [rectangle.id]
  const prepared = prepareDocument(source), saveCopy = prepared.snapshot()
  source.nodes[rectangle.id].width = -1
  saveCopy.nodes[rectangle.id].visible = 'invalid' as never
  const editor = new Editor(blank())
  expect(editor.load(prepared)).toBe(true)
  expect(editor.state.doc.nodes[rectangle.id].width).toBe(20)
  expect(editor.state.doc.nodes[rectangle.id].visible).toBe(true)
  const session = editor.sessionGeneration
  expect(() => editor.load(prepared)).toThrow('已被接收')
  expect(editor.sessionGeneration).toBe(session)
  expect(() => prepared.snapshot()).toThrow('已被接收')
})

test('untrusted JSON cannot forge admission and failed preparation creates no token', () => {
  expect(takePreparedDocument({ prepared: true, snapshot() { return blank() } })).toBeUndefined()
  const source = blank(), rectangle = node('rectangle', 0, 0, 20, 20)
  rectangle.visible = 'invalid' as never
  source.nodes[rectangle.id] = rectangle; source.pages[0].children = [rectangle.id]
  expect(() => prepareDocument(source)).toThrow()
})

test('admission does not stringify the same prepared graph twice', () => {
  const doc = blank('wire'), shape = node('rectangle', 1, 2, 10, 12)
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const seen: object[] = []
  const original = JSON.stringify
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown, ...rest: unknown[]) => {
    if (value && typeof value === 'object' && 'nodes' in value && 'pages' in value) seen.push(value)
    return original(value, ...(rest as []))
  })
  try {
    prepareDocument(doc)
    expect(seen.filter((value, index) => seen.indexOf(value) !== index)).toEqual([])
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThan(3)
  } finally { spy.mockRestore() }
})

test('idle history preparation keeps one undo timeline and refuses stale sessions or active edits', () => {
  const editor = new Editor(blank()), before = editor.state.doc
  const version = editor.state.version, session = editor.sessionGeneration
  expect(editor.warmEditingHistory(before, session + 1)).toBe(false)
  editor.begin('move')
  expect(editor.warmEditingHistory(before, session)).toBe(false)
  editor.cancel()
  expect(editor.warmEditingHistory(before, session)).toBe(true)
  expect(editor.warmEditingHistory(before, session)).toBe(false)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  editor.change('rename', doc => { doc.name = 'changed' })
  expect(editor.canUndo).toBe(true)
  editor.undo(); expect(editor.state.doc.name).toBe(before.name)
  editor.redo(); expect(editor.state.doc.name).toBe('changed')
})

test('adoption rebinds its fonts after another preparation changes the shared picking environment', () => {
  const editor = new Editor(blank()), source = { ...blank(), fonts: {} }
  const first = prepareDocument(source)
  prepareDocument({ ...blank(), fonts: {} })
  const load = vi.spyOn(VectorEngine.prototype, 'load_document_fonts')
  try {
    expect(editor.load(first)).toBe(true)
    expect(load).toHaveBeenCalledExactlyOnceWith('{}')
  } finally { load.mockRestore() }
})
