import { test, expect } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { pickingGeometryEpoch } from './kernel/picking'
test('invalid self-cycle is rejected before layout parent traversal', () => {
  const doc = blank(), n = node('rectangle'); doc.schemaVersion = 14; doc.nodes[n.id] = n; doc.pages[0].children = [n.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc, version = editor.state.version, epoch = pickingGeometryEpoch()
    let events = 0; editor.subscribeEdits(() => { events++ })
    expect(editor.change('Invalid self-cycle', draft => { draft.nodes[n.id].children = [n.id] })?.status).toBe('rejected')
    expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    expect(editor.state.version).toBe(version); expect(events).toBe(0); expect(pickingGeometryEpoch()).toBe(epoch)
  } finally { editor.dispose() }
})

test('topology previews reject duplicate parents and self-cycles before dependency walks', () => {
  const doc = blank(), a = node('group'), b = node('rectangle'); doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    editor.begin('Invalid preview')
    expect(editor.preview({ [a.id]: { children: [a.id] } })).toBe(false)
    expect(editor.state.doc).toBe(before)
    expect(editor.preview({ [a.id]: { children: [b.id] } })).toBe(false)
    expect(editor.state.doc).toBe(before)
    editor.commit(); expect(editor.canUndo).toBe(false)
  } finally { editor.dispose() }
})

test.each(['cycle', 'duplicate parent', 'unowned node', 'depth'] as const)('change rejects %s before dependency resolution', kind => {
  const doc = blank(), a = node('group'), b = node('group'); doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc, version = editor.state.version, epoch = pickingGeometryEpoch()
    const result = editor.change('Invalid topology', draft => {
      if (kind === 'cycle') { draft.pages[0].children = [a.id]; draft.nodes[a.id].children = [b.id]; draft.nodes[b.id].children = [a.id] }
      if (kind === 'duplicate parent') draft.nodes[a.id].children = [b.id]
      if (kind === 'unowned node') draft.pages[0].children = [a.id]
      if (kind === 'depth') {
        let parent = a.id
        for (let i = 0; i < 66; i++) {
          const nested = node('group'); draft.nodes[nested.id] = nested; draft.nodes[parent].children = [nested.id]; parent = nested.id
        }
      }
    })
    expect(result?.status).toBe('rejected'); expect(editor.state.doc).toBe(before)
    expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false); expect(pickingGeometryEpoch()).toBe(epoch)
  } finally { editor.dispose() }
})

test('staged topology admission calls the user mutation once and publishes only one exact authored history entry', () => {
  const doc = blank(), a = node('rectangle'), b = node('rectangle'); doc.schemaVersion = 14
  Object.assign(a, { futureOptional: undefined, futureValue: { negativeZero: -0 } })
  doc.nodes = { [a.id]: a, [b.id]: b }; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc; let mutations = 0, publications = 0
    editor.subscribeEdits(() => { publications++ })
    const result = editor.change('Staged edit', draft => { mutations++; draft.nodes[a.id].name = 'Renamed' })
    expect(result?.status).toBe('committed'); expect(mutations).toBe(1); expect(publications).toBe(1)
    const after = editor.state.doc
    expect(after.nodes[b.id]).toBe(before.nodes[b.id])
    expect(Object.hasOwn(after.nodes[a.id], 'futureOptional')).toBe(true)
    expect(Object.is((after.nodes[a.id] as any).futureValue.negativeZero, -0)).toBe(true)
    editor.undo(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    editor.redo(); expect(editor.state.doc).toBe(after)
  } finally { editor.dispose() }
})

test('no-op authored stages retain document identity, revision, redo history and event count', () => {
  const doc = blank(), a = node('rectangle'); doc.nodes[a.id] = a; doc.pages[0].children = [a.id]
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    editor.change('Rename', draft => { draft.nodes[a.id].name = 'Changed' })
    const after = editor.state.doc; editor.undo()
    const revision = editor.state.version; let events = 0, calls = 0
    editor.subscribeEdits(() => { events++ })
    for (const edit of [
      (draft: typeof doc) => { draft.nodes[a.id].name = before.nodes[a.id].name },
      (draft: typeof doc) => { draft.nodes[a.id].fills = structuredClone(before.nodes[a.id].fills) },
      (draft: typeof doc) => { draft.nodes[a.id].width++; draft.nodes[a.id].width-- },
    ]) {
      expect(editor.change('No-op', draft => { calls++; edit(draft) })?.status).toBe('unchanged')
      expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(revision)
      expect(editor.canUndo).toBe(false); expect(editor.canRedo).toBe(true); expect(events).toBe(0)
    }
    expect(calls).toBe(3); editor.redo(); expect(editor.state.doc).toBe(after)
  } finally { editor.dispose() }
})
