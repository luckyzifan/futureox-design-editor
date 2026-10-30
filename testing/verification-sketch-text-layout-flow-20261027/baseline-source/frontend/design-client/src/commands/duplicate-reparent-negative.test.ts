import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, type DesignDocument, type Matrix } from '../model'
import { multiply, translate, worldMatrix } from '../geometry'
import { createDesignAutomation } from '../automation/core'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function editor(doc: DesignDocument) { const e = new Editor(doc); editors.push(e); return e }
const close = (actual: Matrix, expected: Matrix) => actual.forEach((n, i) => expect(n).toBeCloseTo(expected[i], 9))
function apiFor(e: Editor) {
  const api = createDesignAutomation(e)
  return { call: (method: string, params = {}) => api.execute({ method, params, expectedRevision: e.state.version, documentId: e.state.doc.id, session: e.sessionGeneration }) }
}
for (const horizontal of ['end', 'stretch', 'scale'] as const) for (const rotated of [false, true])
  test(`explicit copy reparent ${horizontal}, rotated destination=${rotated}, preserves native world geometry and one undo/redo`, () => {
    const doc = blank(), source = node('frame', 0, 0, 100, 100), target = node('frame', 300, 200, 500, 400), child = node('rectangle', 80, 10, 10, 20)
    if (rotated) target.transform = [0, 1, -1, 0, 300, 200]
    child.constraints = { horizontal, vertical: 'end', referenceWidth: 100, referenceHeight: 100 }
    source.children = [child.id]; doc.nodes = Object.fromEntries([source, target, child].map(n => [n.id, n])); doc.pages[0].children = [source.id, target.id]
    const e = editor(doc), before = e.state.doc, expected = multiply(translate(17, -9), worldMatrix(before, child.id))
    const response = apiFor(e).call('node.duplicate', { ids: [child.id], parentId: target.id, index: 0, offsetX: 17, offsetY: -9 })
    expect(response.ok, JSON.stringify(response)).toBe(true); if (!response.ok) throw Error(response.error.message)
    const result = (response.result as { operations: { result: { ids: string[]; idMap: Record<string, string> } }[] }).operations[0].result
    const [copy] = result.ids, after = e.state.doc
    expect(result.idMap[child.id]).toBe(copy); expect(after.nodes[target.id].children).toEqual([copy])
    close(worldMatrix(after, copy), expected); expect([after.nodes[copy].width, after.nodes[copy].height]).toEqual([10, 20])
    expect(after.nodes[copy].fills).toEqual(before.nodes[child.id].fills); expect(after.nodes[child.id]).toEqual(before.nodes[child.id])
    e.undo(); expect(e.state.doc).toEqual(before); expect(e.canUndo).toBe(false); e.redo(); expect(e.state.doc).toEqual(after)
  })
