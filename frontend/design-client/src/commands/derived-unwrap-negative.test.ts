import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { createEditorDesignAutomation } from '../automation/index'
import { blank, node, type ConstraintAnchor } from '../model'
import { worldMatrix } from '../geometry'
function fixture(anchor: ConstraintAnchor) {
  const doc = blank(), outer = node('frame', 0, 0, 500, 300), wrapper = node('frame', 0, 0, 100, 100), child = node('rectangle', 80, 5, 10, 10)
  child.constraints = { horizontal: anchor, vertical: 'start', referenceWidth: 100, referenceHeight: 100 }
  child.opacity = .6; outer.children = [wrapper.id]; wrapper.children = [child.id]
  doc.nodes = Object.fromEntries([outer, wrapper, child].map(n => [n.id, n])); doc.pages[0].children = [outer.id]
  return { doc, outer, wrapper, child }
}
const request = (editor: Editor, method: string, params: Record<string, unknown>) => ({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
for (const anchor of ['end', 'stretch', 'scale'] as const) {
  test(`derived unwrap ${anchor}: a resize plus unwrap batch rejects atomically before discarding unresolved constraints`, () => {
    const f = fixture(anchor), editor = new Editor(f.doc), api = createEditorDesignAutomation(editor)
    try {
      const before = editor.state, response = api.execute(request(editor, 'batch.apply', { operations: [
        { method: 'node.update', params: { ids: [f.wrapper.id], patch: { width: 200 } } },
        { method: 'node.ungroup', params: { ids: [f.wrapper.id] } },
      ] }))
      expect(response, JSON.stringify({ response, child: editor.state.doc.nodes[f.child.id] })).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
      expect(editor.state).toBe(before); expect(editor.state.doc.nodes[f.wrapper.id].width).toBe(100)
      expect(editor.state.version).toBe(0); expect(editor.canUndo).toBe(false)
    } finally { api.dispose(); editor.dispose() }
  })
  test(`derived unwrap ${anchor}: separate normalized commits preserve exact native geometry, styles and undo on UI/MCP`, () => {
    const f = fixture(anchor), ui = new Editor(structuredClone(f.doc)), mcp = new Editor(structuredClone(f.doc)), api = createEditorDesignAutomation(mcp)
    try {
      const before = ui.state.doc
      ui.change('Resize wrapper', draft => { draft.nodes[f.wrapper.id].width = 200 })
      expect(api.execute(request(mcp, 'node.update', { ids: [f.wrapper.id], patch: { width: 200 } })).ok).toBe(true)
      expect(mcp.state.doc).toEqual(ui.state.doc)
      const resized = ui.state.doc, expectedX = anchor === 'end' ? 180 : anchor === 'scale' ? 160 : 80, expectedWidth = anchor === 'stretch' ? 110 : anchor === 'scale' ? 20 : 10
      expect(worldMatrix(resized, f.child.id)[4]).toBe(expectedX); expect(resized.nodes[f.child.id].width).toBe(expectedWidth)
      ui.select([f.wrapper.id]); mcp.select([f.wrapper.id]); ui.ungroup()
      expect(api.execute(request(mcp, 'node.ungroup', { ids: [f.wrapper.id] })).ok).toBe(true)
      expect(mcp.state.doc).toEqual(ui.state.doc); expect(ui.state.version).toBe(2); expect(mcp.state.version).toBe(2)
      const after = ui.state.doc
      expect(worldMatrix(after, f.child.id)).toEqual(worldMatrix(resized, f.child.id)); expect(after.nodes[f.child.id].width).toBe(expectedWidth)
      expect(after.nodes[f.child.id].fills).toEqual(f.child.fills); expect(after.nodes[f.child.id].opacity).toBe(.6)
      for (const editor of [ui, mcp]) {
        editor.undo(); expect(editor.state.doc).toEqual(resized); editor.undo(); expect(editor.state.doc).toEqual(before)
        editor.redo(); editor.redo(); expect(editor.state.doc).toEqual(after)
      }
    } finally { api.dispose(); ui.dispose(); mcp.dispose() }
  })
}
test('UI unwrap refuses an unsettled resize transaction without changing its preview or creating history', () => {
  const f = fixture('end'), editor = new Editor(f.doc)
  try {
    const before = editor.state.doc; editor.select([f.wrapper.id]); editor.begin('Resize preview')
    editor.change('Resize preview', draft => { draft.nodes[f.wrapper.id].width = 200 })
    const preview = editor.state; expect(editor.ungroup()).toBeUndefined(); expect(editor.state).toBe(preview)
    expect(editor.canUndo).toBe(false); editor.cancel(); expect(editor.state.doc).toEqual(before)
  } finally { editor.dispose() }
})
