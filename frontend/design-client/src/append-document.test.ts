import { expect, test } from 'vitest'
import { readFile } from 'node:fs/promises'
import { blank, node } from './model'
import { Editor } from './engine'
import { scene } from './geometry'
import { createClip } from './animation'
import { prepareDocumentForEditing } from './kernel/picking'
import { import_sketch_json } from './generated/design-kernel/design_kernel'

test('appending the same animated source twice isolates IDs, references and history without replacing the canvas', () => {
  const source = blank('Imported'), a = node('rectangle', 40, 20, 100, 80), b = node('rectangle', 180, 20, 100, 80)
  source.nodes = { [a.id]: a, [b.id]: b }; source.pages[0].children = [a.id, b.id]
  source.animations = [createClip(source, source.pages[0].id, [a.id])]
  source.schemaVersion = 4
  source.prototype = { startNode: a.id, interactions: { [a.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: b.id }] }] } }
  const editor = new Editor(prepareDocumentForEditing(blank()))
  try {
    const documentId = editor.state.doc.id, first = editor.appendDocument(source), before = editor.state.doc
    const second = editor.appendDocument(source), after = editor.state.doc
    expect(after.id).toBe(documentId)
    expect(Object.keys(after.nodes)).toHaveLength(6)
    expect(after.pages[0].children).toEqual([...first, ...second])
    for (const id of Object.keys(before.nodes)) expect(after.nodes[id]).toEqual(before.nodes[id])
    const firstChild = after.nodes[first[0]].children[0], secondChildren = after.nodes[second[0]].children
    expect(after.prototype?.startNode).toBe(firstChild)
    expect(after.prototype?.interactions[secondChildren[0]][0].actions[0].target).toBe(secondChildren[1])
    expect(after.animations?.map(c => c.tracks[0].nodeId)).toEqual([firstChild, secondChildren[0]])
    expect(new Set(after.animations?.map(c => c.id)).size).toBe(2)
    const boxes = scene(after, after.pages[0].id).filter(n => [...first, ...second].includes(n.id)).map(n => n.bounds)
    expect(boxes[1].x).toBeGreaterThan(boxes[0].x + boxes[0].width)
    editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.redo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(6)
  } finally { editor.dispose() }
})

test('appending every source page keeps each page as a separately movable group', () => {
  const source = blank('Pages'), a = node('rectangle', 0, 0, 100, 50), b = node('rectangle', 0, 0, 100, 50)
  source.nodes = { [a.id]: a, [b.id]: b }; source.pages[0].children = [a.id]
  source.pages.push({ ...source.pages[0], id: crypto.randomUUID(), name: 'Second', children: [b.id] })
  const editor = new Editor(blank())
  try { expect(editor.appendDocument(source)).toHaveLength(2); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(4) }
  finally { editor.dispose() }
})

test.runIf(!!process.env.SKETCH_FIXTURE)('real 117 repeated three times: independent nodes, fonts, editable groups and one-step undo', async () => {
  const raw = JSON.parse(import_sketch_json(new Uint8Array(await readFile(process.env.SKETCH_FIXTURE!))))
  const document = raw.document || raw
  document.id = crypto.randomUUID(); document.name = '117'
  const source = prepareDocumentForEditing(document), editor = new Editor(blank())
  try {
    const roots = [editor.appendDocument(source), editor.appendDocument(source), editor.appendDocument(source)].flat()
    expect(roots).toHaveLength(3)
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(Object.keys(source.nodes).length * 3 + 3)
    expect(editor.state.doc.fonts).toEqual(source.fonts)
    editor.select([roots[2]]); editor.change('Move imported group', d => { d.nodes[roots[2]].transform[4] += 40; d.nodes[roots[2]].transform[5] += 30 })
    expect(editor.state.doc.nodes[roots[2]].transform[5]).toBe(30 - scene(source, source.pages[0].id)[0].bounds.y)
    editor.undo(); editor.undo()
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(Object.keys(source.nodes).length * 2 + 2)
  } finally { editor.dispose() }
}, 30000)
