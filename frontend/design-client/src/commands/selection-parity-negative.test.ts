import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { figmaFixture } from '../figma-fixtures'
import { blank, node, type DesignDocument } from '../model'
import { createEditorDesignAutomation } from '../automation/index'
const request = (editor: Editor, method: string, params: Record<string, unknown>) => ({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
function pair(document: DesignDocument) { return [new Editor(structuredClone(document)), new Editor(structuredClone(document))] as const }
function completeParity(document: DesignDocument, ids: string[], uiAction: (editor: Editor) => unknown, method: string, params: (ui: Editor) => Record<string, unknown>, changed = true) {
  const [ui, mcp] = pair(document), api = createEditorDesignAutomation(mcp), events = [[], []] as string[][]
  const stops = [ui, mcp].map((editor, i) => editor.subscribeEdits(event => events[i].push(`${event.kind}:${event.source}`)))
  try {
    ui.select(ids); mcp.select(ids)
    const before = [ui.state.doc, mcp.state.doc]
    uiAction(ui); const response = api.execute(request(mcp, method, params(ui)))
    expect(response.ok).toBe(true); expect(ui.state.doc).toEqual(mcp.state.doc); expect(ui.state.selection).toEqual(mcp.state.selection)
    const after = ui.state.doc
    expect(ui.state.version).toBe(changed ? 1 : 0); expect(mcp.state.version).toBe(changed ? 1 : 0)
    if (changed) {
      ui.undo('user'); mcp.undo('automation'); expect(ui.state.doc).toEqual(before[0]); expect(mcp.state.doc).toEqual(before[1])
      ui.redo('user'); mcp.redo('automation'); expect(ui.state.doc).toEqual(after); expect(mcp.state.doc).toEqual(after)
      expect(events).toEqual([['edit:user', 'undo:user', 'redo:user'], ['edit:automation', 'undo:automation', 'redo:automation']])
    } else expect(events).toEqual([[], []])
    return structuredClone(after)
  } finally { stops.forEach(stop => stop()); api.dispose(); ui.dispose(); mcp.dispose() }
}
function childrenFixture(kind: 'group' | 'frame' | 'section' | 'vector' = 'group') {
  const doc = blank(), wrapper = node(kind, 30, 40, 120, 100), a = node('rectangle', 10, 15, 30, 20), b = node('ellipse', 60, 50, 20, 30), outside = node('rectangle', 220, 80, 20, 20)
  wrapper.children = [a.id, b.id]; if (kind === 'vector') wrapper.booleanOperation = 'union'
  doc.nodes = Object.fromEntries([wrapper, a, b, outside].map(n => [n.id, n])); doc.pages[0].children = [wrapper.id, outside.id]
  return { doc, wrapper, a, b, outside }
}

test('parity: curve align has identical complete authored results and native undo/redo', () => {
  const doc = figmaFixture('curve'), frame = doc.nodes[doc.pages[0].children[0]], id = frame.children[0]
  const after = completeParity(doc, [id], ui => ui.align('x', 'start'), 'node.align', () => ({ ids: [id], axis: 'x', mode: 'start' }))
  expect(after.nodes[id].transform[4]).toBe(-8)
})
test('parity: curve group has identical full bounds, transform, topology and undo/redo', () => {
  const doc = figmaFixture('curve'), frame = doc.nodes[doc.pages[0].children[0]], id = frame.children[0]
  const after = completeParity(doc, [id], ui => ui.group(), 'node.group', ui => ({ ids: [id], id: ui.state.selection[0] }))
  const group = after.nodes[after.nodes[frame.id].children[0]]
  expect([group.transform[4], group.transform[5], group.width, group.height]).toEqual([8, 8, 100, 75])
})
test('parity: section ungroup has identical complete authored results and undo/redo', () => {
  const f = childrenFixture('section')
  completeParity(f.doc, [f.wrapper.id], ui => ui.ungroup(), 'node.ungroup', () => ({ ids: [f.wrapper.id] }))
})
test('parity: selection-frame is transparent/unclipped while empty-frame factory is unchanged', () => {
  const doc = blank(), child = node('rectangle', 10, 10, 20, 20); doc.nodes = { [child.id]: child }; doc.pages[0].children = [child.id]
  const after = completeParity(doc, [child.id], ui => ui.group(false, undefined, 'frame'), 'node.group', ui => ({ ids: [child.id], id: ui.state.selection[0], kind: 'frame' }))
  const wrapper = after.nodes[after.pages[0].children[0]]
  expect(wrapper).toMatchObject({ fills: [], strokes: [], effects: [], clip: false, blend: 'pass-through' })
  const empty = node('frame'); expect(empty.fills[0].color).toBe('#ffffff'); expect(empty.clip).toBe(true); expect(empty.blend).toBe('normal')
})
