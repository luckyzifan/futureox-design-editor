import { expect, test } from 'vitest'
import { blank, node, type DesignDocument } from './model'
import { applyDocumentPatch, documentPatch, type DocumentPatch } from './document-patch'

function fullDiff(a: DesignDocument, b: DesignDocument): DocumentPatch {
  const nodes: DocumentPatch['nodes'] = {}, fields: DocumentPatch['fields'] = {}
  for (const [id, n] of Object.entries(b.nodes)) if (n !== a.nodes[id]) nodes[id] = n
  for (const id of Object.keys(a.nodes)) if (!b.nodes[id]) nodes[id] = null
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (k !== 'nodes' && k !== 'id' && (a as any)[k] !== (b as any)[k]) fields[k] = (b as any)[k] ?? null
  return { nodes, fields }
}
function fixture(count = 19000) {
  const doc = blank()
  for (let i = 0; i < count; i++) doc.nodes[`n${i}`] = { ...node('rectangle', i, 0, 10, 10), id: `n${i}` }
  return doc
}
function change(a: DesignDocument, i: number) {
  const id = `n${i % 20}`
  const nodes = { ...a.nodes, [id]: { ...a.nodes[id], name: `changed ${i}` } }
  if (i % 5 === 0) delete nodes[`extra${i - 5}`]
  if (i % 5 === 0) nodes[`extra${i}`] = { ...node('rectangle', 0, 0, 10, 10), id: `extra${i}` }
  return { ...a, nodes, name: `revision ${i}` }
}

test('trusted bounded transitions equal full diffs for edits, skipped snapshots, undo, redo and replacement', () => {
  const initial = fixture(), history = [initial]
  for (let i = 0; i < 45; i++) {
    const before = history.at(-1)!, after = change(before, i)
    expect(documentPatch(before, after)).toEqual(fullDiff(before, after))
    history.push(after)
  }
  for (const [a, b] of [[0, 45], [40, 45], [44, 45], [45, 44], [44, 45], [45, 30], [30, 45], [10, 11]]) {
    const before = history[a], after = history[b]
    expect(documentPatch(before, after)).toEqual(fullDiff(before, after))
    expect(applyDocumentPatch(before, documentPatch(before, after))).toEqual(after)
  }
  const replacement = structuredClone(initial)
  expect(documentPatch(history[45], replacement)).toEqual(fullDiff(history[45], replacement))
  expect(() => documentPatch(initial, { ...initial, id: 'different' })).toThrow()
})

test('a repeated witnessed diff does not enumerate either node map', () => {
  let scans = 0
  const before = fixture(), after = change(before, 1)
  before.nodes = new Proxy(before.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  after.nodes = new Proxy(after.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  const expected = documentPatch(before, after)
  expect(scans).toBe(2)
  scans = 0
  expect(documentPatch(before, after)).toEqual(expected)
  expect(scans).toBe(0)
})

test('field-only patches share nodes and preserve resources, additions and removals', () => {
  const before = fixture(10)
  const fields = { name: 'new name', fonts: [{ id: 'font-1', family: 'Fixture' }], images: [{ id: 'image-1', data: 'fixture' }], optionalFixture: 'value' }
  const after = applyDocumentPatch(before, { nodes: {}, fields })
  expect(after.nodes).toBe(before.nodes)
  expect(documentPatch(before, after)).toEqual(fullDiff(before, after))
  const removed = applyDocumentPatch(after, { nodes: {}, fields: { optionalFixture: null } })
  expect(documentPatch(before, removed)).toEqual(fullDiff(before, removed))
  expect((after as any).optionalFixture).toBe('value')
})

test('normalization never mutates shared or frozen incoming nodes and nested paints', () => {
  const before = fixture(1), base = before.nodes.n0
  const paint = Object.freeze({ ...base.fills[0], image: null })
  const incoming = Object.freeze({ ...base, layout: null, fills: Object.freeze([paint]), strokes: Object.freeze([{ paint, width: 1 }]) })
  const patch = { nodes: { n0: incoming }, fields: {} } as unknown as DocumentPatch
  const after = applyDocumentPatch(before, patch)
  expect(incoming.layout).toBeNull(); expect(paint.image).toBeNull()
  expect(after.nodes.n0).not.toBe(incoming)
  expect(after.nodes.n0.layout).toBeUndefined()
  expect(after.nodes.n0.fills[0].image).toBeUndefined()
  expect(after.nodes.n0.strokes[0].paint.image).toBeUndefined()
  expect(before.nodes.n0).toBe(base)
  expect(documentPatch(before, after)).toEqual(fullDiff(before, after))
})

test('unknown branches, overlong chains and oversized witnesses fall back to complete scans', () => {
  let scans = 0
  const initial = fixture(4200)
  initial.nodes = new Proxy(initial.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  let tip = initial
  for (let i = 0; i < 40; i++) { const next = change(tip, i); documentPatch(tip, next); tip = next }
  scans = 0
  const longPatch = documentPatch(initial, tip)
  expect(scans).toBe(1)
  expect(longPatch).toEqual(fullDiff(initial, tip))
  const left = change(initial, 1), right = change(initial, 2)
  documentPatch(initial, left); documentPatch(initial, right)
  expect(documentPatch(left, right)).toEqual(fullDiff(left, right))
  expect(documentPatch(right, left)).toEqual(fullDiff(right, left))
  const replacement = structuredClone({ ...initial, nodes: { ...initial.nodes } })
  documentPatch(initial, replacement)
  scans = 0
  const oversizedPatch = documentPatch(initial, replacement)
  expect(scans).toBe(1)
  expect(oversizedPatch).toEqual(fullDiff(initial, replacement))
})
