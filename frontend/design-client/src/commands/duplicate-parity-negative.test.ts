import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, type DesignDocument } from '../model'
import { translate, worldMatrix } from '../geometry'
import { createDesignAutomation } from '../automation/core'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function editor(doc: DesignDocument) { const e = new Editor(doc); editors.push(e); return e }
function fixture(kind: 'rectangle' | 'frame' = 'rectangle') {
  const doc = blank(), n = node(kind, 10, 20, 100, 80)
  doc.nodes[n.id] = n; doc.pages[0].children = [n.id]
  return { doc, n }
}
function duplicate(e: Editor, ids: string[], params = {}) {
  const response = createDesignAutomation(e).execute({ method: 'node.duplicate', params: { ids, ...params },
    documentId: e.state.doc.id, session: e.sessionGeneration, expectedRevision: e.state.version })
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  return (response.result as { operations: { result: { ids: string[] } }[] }).operations[0].result.ids
}
for (const kind of ['rectangle', 'frame'] as const) test(`UI/MCP default ${kind} placement, selection and one Undo/Redo are identical`, () => {
  const { doc, n } = fixture(kind), ui = editor(doc), mcp = editor(doc)
  const bases = new Map([[ui, ui.state.doc], [mcp, mcp.state.doc]])
  ui.select([n.id]); ui.duplicate(); const [copy] = duplicate(mcp, [n.id])
  expect(worldMatrix(mcp.state.doc, copy)).toEqual(worldMatrix(ui.state.doc, ui.state.selection[0]))
  expect(mcp.state.selection).toEqual([copy])
  for (const e of [ui, mcp]) {
    const after = e.state.doc; e.undo(); expect(e.state.doc).toEqual(bases.get(e)); expect(e.canUndo).toBe(false)
    e.redo(); expect(e.state.doc).toEqual(after)
  }
})
test('same-ID reopen invalidates duplicate repeat rather than reusing old displacement', () => {
  const { doc, n } = fixture(), e = editor(doc)
  e.select([n.id]); e.duplicate(); e.transformSelection(translate(30, 5))
  const id = e.state.selection[0], reopened = structuredClone(e.state.doc), position = worldMatrix(reopened, id)
  expect(e.load(reopened)).toBe(true); e.select([id]); e.duplicate()
  expect(worldMatrix(e.state.doc, e.state.selection[0])).toEqual(position)
})
test('a same-ID load subscriber cannot receive the old duplicate selection or repeat seed', () => {
  const { doc, n } = fixture(), e = editor(doc); e.select([n.id])
  let loaded = false, replacement: DesignDocument | undefined
  const release = e.subscribe(() => {
    if (loaded || e.state.version === 0) return
    loaded = true; replacement = structuredClone(e.state.doc); e.load(replacement)
  })
  e.duplicate(); release()
  expect(loaded).toBe(true); expect(e.state.selection).toEqual([])
  expect(e.state.doc).toEqual(replacement)
})
