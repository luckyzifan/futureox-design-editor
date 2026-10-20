import { expect, test } from 'vitest'
import { Editor } from '../engine'
import { figmaFixture } from '../figma-fixtures'
import { blank, node, type DesignDocument } from '../model'
import { createDesignAutomation } from '../automation/core'
import { apply, multiply, rotate, translate } from './affine'
import { worldMatrix } from '../geometry'
const apiFor = (editor: Editor) => createDesignAutomation(editor)
const request = (editor: Editor, method: string, params: Record<string, unknown>) => ({ method, params, expectedRevision: editor.state.version, documentId: editor.state.doc.id, session: editor.sessionGeneration })
function pair(document: DesignDocument) { return [new Editor(structuredClone(document)), new Editor(structuredClone(document))] as const }
function reversible(editor: Editor, work: () => void, source: 'user' | 'automation') {
  const before = editor.state.doc, version = editor.state.version, events: string[] = [], stop = editor.subscribeEdits(event => events.push(`${event.kind}:${event.source}`))
  try {
    work(); const after = editor.state.doc
    expect(editor.state.version).toBe(version + 1); expect(after).not.toEqual(before)
    editor.undo(source); expect(editor.state.doc).toEqual(before); editor.redo(source); expect(editor.state.doc).toEqual(after)
    expect(events).toEqual([`edit:${source}`, `undo:${source}`, `redo:${source}`])
  } finally { stop() }
}
for (const command of ['align', 'group'] as const) test(`expected difference retained: curve ${command}, native history reversible`, () => {
  const doc = figmaFixture('curve'), frame = doc.nodes[doc.pages[0].children[0]], id = frame.children[0], [ui, mcp] = pair(doc)
  try {
    const api = apiFor(mcp); ui.select([id]); mcp.select([id])
    if (command === 'align') {
      reversible(ui, () => ui.align('x', 'start'), 'user')
      // Legacy MCP is already at authored-box x=0: truthful no-op, no history.
      const before = mcp.state.doc, version = mcp.state.version, response = api.execute(request(mcp, 'node.align', { ids: [id], axis: 'x', mode: 'start' }))
      expect(response.ok).toBe(true); expect(mcp.state.doc).toEqual(before); expect(mcp.state.version).toBe(version)
      expect(ui.state.doc.nodes[id].transform[4]).toBe(-8); expect(mcp.state.doc.nodes[id].transform[4]).toBe(0)
    } else {
      reversible(ui, () => ui.group(), 'user')
      reversible(mcp, () => expect(api.execute(request(mcp, 'node.group', { ids: [id] })).ok).toBe(true), 'automation')
      const a = ui.state.doc.nodes[ui.state.selection[0]], b = mcp.state.doc.nodes[mcp.state.selection[0]]
      expect([a.transform[4], a.transform[5], a.width, a.height]).toEqual([8, 8, 100, 75])
      expect([b.transform[4], b.transform[5], b.width, b.height]).toEqual([0, 0, 128, 128])
    }
  } finally { ui.dispose(); mcp.dispose() }
})
test('expected difference retained: section ungroup versus MCP invalid_kind', () => {
  const doc = blank(), section = node('section', 0, 0, 100, 100), child = node('rectangle', 10, 10, 20, 20)
  section.children = [child.id]; doc.nodes = { [section.id]: section, [child.id]: child }; doc.pages[0].children = [section.id]
  const [ui, mcp] = pair(doc)
  try {
    ui.select([section.id]); reversible(ui, () => ui.ungroup(), 'user')
    const before = mcp.state.doc, version = mcp.state.version, response = apiFor(mcp).execute(request(mcp, 'node.ungroup', { ids: [section.id] }))
    expect(response.ok).toBe(false); if (!response.ok) expect(response.error.code).toBe('invalid_kind')
    expect(mcp.state.doc).toEqual(before); expect(mcp.state.version).toBe(version); expect(mcp.canUndo).toBe(false)
  } finally { ui.dispose(); mcp.dispose() }
})
test('expected difference retained: selection-frame fill, clipping and blend', () => {
  const doc = blank(), child = node('rectangle', 10, 10, 20, 20); doc.nodes = { [child.id]: child }; doc.pages[0].children = [child.id]
  const [ui, mcp] = pair(doc)
  try {
    ui.select([child.id]); reversible(ui, () => ui.group(false, undefined, 'frame'), 'user')
    reversible(mcp, () => expect(apiFor(mcp).execute(request(mcp, 'node.group', { ids: [child.id], kind: 'frame' })).ok).toBe(true), 'automation')
    const a = ui.state.doc.nodes[ui.state.selection[0]], b = mcp.state.doc.nodes[mcp.state.selection[0]]
    expect({ fills: a.fills, clip: a.clip, blend: a.blend }).toEqual({ fills: [], clip: false, blend: 'pass-through' })
    expect(b.fills[0].color).toBe('#ffffff'); expect(b.clip).toBe(true); expect(b.blend).toBe('normal')
  } finally { ui.dispose(); mcp.dispose() }
})
test('wrap/lift preserve world matrices and paint order under rotated parent for both adapters', () => {
  for (const route of ['ui', 'mcp'] as const) {
    const doc = blank(), parent = node('frame'), a = node('rectangle', 10, 20, 20, 30), x = node('rectangle', 35, 40, 10, 10), b = node('rectangle', 70, 50, 15, 25)
    parent.transform = multiply(translate(30, 20), rotate(30)); parent.children = [a.id, x.id, b.id]; doc.pages[0].children = [parent.id]
    doc.nodes = Object.fromEntries([parent, a, x, b].map(n => [n.id, n])); const editor = new Editor(doc), api = apiFor(editor)
    try {
      const worlds = [a.id, b.id].map(id => worldMatrix(editor.state.doc, id)); editor.select([b.id, a.id])
      reversible(editor, () => route === 'ui' ? editor.group() : expect(api.execute(request(editor, 'node.group', { ids: [b.id, a.id] })).ok).toBe(true), route === 'ui' ? 'user' : 'automation')
      const group = editor.state.doc.nodes[editor.state.selection[0]]
      expect(group.children).toEqual([a.id, b.id]); expect(editor.state.doc.nodes[parent.id].children).toEqual([group.id, x.id])
      for (const [index, id] of [a.id, b.id].entries()) worldMatrix(editor.state.doc, id).forEach((v, i) => expect(v).toBeCloseTo(worlds[index][i], 9))
      reversible(editor, () => route === 'ui' ? editor.ungroup() : expect(api.execute(request(editor, 'node.ungroup', { ids: [group.id] })).ok).toBe(true), route === 'ui' ? 'user' : 'automation')
      expect(editor.state.doc.nodes[parent.id].children).toEqual([a.id, b.id, x.id])
      for (const [index, id] of [a.id, b.id].entries()) {
        const point = apply(worldMatrix(editor.state.doc, id), { x: 3, y: 4 }), original = apply(worlds[index], { x: 3, y: 4 })
        expect(point.x).toBeCloseTo(original.x, 9); expect(point.y).toBeCloseTo(original.y, 9)
      }
    } finally { editor.dispose() }
  }
})
test('MCP staged sequential plans, rollback, stale fences, spoof rejection and exact retry', () => {
  const doc = blank(), a = node('rectangle', 10, 10, 20, 20), b = node('rectangle', 70, 20, 20, 20)
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc), api = apiFor(editor), groupId = 'b225d69a-7723-4c87-8471-b58e6c4f7114'
  try {
    const before = editor.state.doc, invalid = api.execute(request(editor, 'batch.apply', { operations: [
      { method: 'node.group', params: { ids: [a.id, b.id], id: groupId } },
      { method: 'node.align', params: { ids: [groupId], axis: 'x', mode: 'start' } },
    ] }))
    expect(invalid.ok).toBe(false); expect(editor.state.doc).toEqual(before); expect(editor.state.version).toBe(0)
    const operation = request(editor, 'batch.apply', { mutationId: 'shared-planner', operations: [
      { method: 'node.group', params: { ids: [a.id, b.id], id: groupId } },
      { method: 'node.align', params: { ids: [a.id], axis: 'x', mode: 'end' } },
    ] })
    reversible(editor, () => expect(api.execute(operation).ok).toBe(true), 'automation')
    const after = editor.state.doc, version = editor.state.version
    expect(api.execute(operation).ok).toBe(true); expect(editor.state.doc).toEqual(after); expect(editor.state.version).toBe(version)
    const stale = api.execute({ ...request(editor, 'node.ungroup', { ids: [groupId] }), expectedRevision: 0 })
    expect(stale.ok).toBe(false); if (!stale.ok) expect(stale.error.code).toBe('stale_revision')
    const spoof = api.execute({ ...request(editor, 'node.ungroup', { ids: [groupId] }), author: 'admin' })
    expect(spoof.ok).toBe(false); if (!spoof.ok) expect(spoof.error.code).toBe('invalid_request')
    expect(editor.state.doc).toEqual(after); expect(editor.state.version).toBe(version)
  } finally { editor.dispose() }
})
test('ungroup mask handling remains explicit; MCP child-lock guards are not weakened', () => {
  for (const locked of [false, true]) {
    const doc = blank(), group = node('group'), child = node('rectangle', 5, 10, 20, 20), outside = node('rectangle', 50, 50, 30, 30)
    child.mask = true; child.locked = locked; group.children = [child.id]
    doc.nodes = Object.fromEntries([group, child, outside].map(n => [n.id, n])); doc.pages[0].children = [group.id, outside.id]
    const [ui, mcp] = pair(doc)
    try {
      ui.select([group.id]); ui.ungroup(); expect(ui.state.doc.nodes[child.id].mask).toBe(false)
      const before = mcp.state.doc, response = apiFor(mcp).execute(request(mcp, 'node.ungroup', { ids: [group.id] }))
      expect(response.ok).toBe(!locked)
      if (locked) { if (!response.ok) expect(response.error.code).toBe('locked_node'); expect(mcp.state.doc).toEqual(before); expect(mcp.state.version).toBe(0) }
      else { expect(mcp.state.doc.nodes[child.id].mask).toBe(true); expect(mcp.state.doc.pages[0].children).toEqual([child.id, outside.id]) }
    } finally { ui.dispose(); mcp.dispose() }
  }
})
