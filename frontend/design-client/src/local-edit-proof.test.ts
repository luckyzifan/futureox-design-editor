import { expect, test } from 'vitest'
import { blank, node, defaultLayout, type DesignDocument } from './model'
import { applyDocumentPatch, documentPatch, produceDocumentDraft, shareDocument } from './document-patch'
import { proveLocalEdit } from './local-edit-proof'
import { compileEditOps, augmentedDocumentJson } from './kernel/op-sync'
import { Graph } from './kernel/graph'
import { createGraphHistoryState } from './kernel/graph-history-state'

function fixture() {
  const doc = blank(); doc.schemaVersion = 15; doc.rasterProfile = 'analytic'
  const frame = node('frame', 0, 0, 200, 200), child = node('rectangle', 4, 5, 20, 30), other = node('rectangle', 40, 50, 20, 30)
  frame.children = [child.id, other.id]
  doc.nodes = { [frame.id]: frame, [child.id]: child, [other.id]: other }; doc.pages[0].children = [frame.id]
  return { doc, frame: frame.id, child: child.id, other: other.id }
}

test('complete producer witness and sharing preserve exact patches without another node-map enumeration', () => {
  const { doc, child, other } = fixture()
  let scans = 0
  doc.nodes = new Proxy(doc.nodes, { ownKeys(target) { scans++; return Reflect.ownKeys(target) } })
  const after = produceDocumentDraft(doc, d => { d.nodes[child].opacity = .5 })
  scans = 0
  const shared = shareDocument(doc, after)
  expect(shared).toBe(after); expect(shared.nodes[other]).toBe(doc.nodes[other])
  expect(documentPatch(doc, shared).nodes).toEqual({ [child]: shared.nodes[child] })
  expect(scans).toBe(0)
  expect(applyDocumentPatch(doc, documentPatch(doc, shared))).toEqual(shared)
})

test('proof is based on all actual changed nodes, not a selected target or document identity', () => {
  const { doc, child, other } = fixture()
  const first = produceDocumentDraft(doc, d => { d.nodes[child].opacity = .5 })
  expect(proveLocalEdit(doc, first)?.ids).toEqual([child])
  const unknown = { ...first, nodes: { ...first.nodes, [other]: { ...first.nodes[other], width: 44 } } }
  expect(proveLocalEdit(first, unknown)).toBeUndefined()
  const replaced = produceDocumentDraft(first, d => { d.nodes = { ...d.nodes, [other]: { ...d.nodes[other], name: 'renamed' } } })
  expect(documentPatch(first, replaced).nodes).toEqual({ [other]: replaced.nodes[other] })
  expect(shareDocument(first, replaced)).toEqual(replaced)
})

test('fresh dependency changes, unrelated branches, undo and root changes cannot inherit a false proof', () => {
  const { doc, frame, child } = fixture()
  const a = produceDocumentDraft(doc, d => { d.nodes[child].opacity = .5 })
  expect(proveLocalEdit(doc, a)).toBeDefined()
  const b = produceDocumentDraft(a, d => { d.nodes[frame].layout = { ...defaultLayout(), mode: 'horizontal' } })
  expect(proveLocalEdit(a, b)).toBeUndefined()
  const move = produceDocumentDraft(b, d => { d.nodes[child].transform[4] = 80 })
  expect(proveLocalEdit(b, move)).toBeUndefined()
  const branch = produceDocumentDraft(doc, d => { d.nodes[child].name = 'branch' })
  expect(documentPatch(a, branch).nodes[child]).toEqual(branch.nodes[child])
  expect(shareDocument(a, branch)).toEqual(branch)
  expect(shareDocument(a, doc)).toEqual(doc)
  const metadata = produceDocumentDraft(a, d => { d.name = 'renamed document' })
  expect(proveLocalEdit(a, metadata)).toBeUndefined()
})

test.each(['constraints', 'component', 'bindings', 'repeat', 'connector', 'textPath'] as const)('strict classification rejects %s dependency', field => {
  const { doc, frame, child, other } = fixture()
  // Classification rejects these witnesses before admission. Fixtures need
  // only valid topology, not a second synthetic validation implementation.
  if (field === 'constraints') doc.nodes[child].constraints = { horizontal: 'start', vertical: 'start' }
  if (field === 'component') doc.nodes[frame].component = { properties: {}, variants: {} }
  if (field === 'bindings') doc.nodes[child].bindings = { opacity: 'token' }
  if (field === 'repeat') (doc.nodes[other] as any).repeat = { count: 3 }
  if (field === 'connector') (doc.nodes[other] as any).connector = { from: { nodeId: child }, to: { point: { x: 1, y: 1 } } }
  if (field === 'textPath') (doc.nodes[other] as any).textPath = { nodeId: child }
  const after = produceDocumentDraft(doc, d => { d.nodes[child].transform[4] = 80 })
  expect(proveLocalEdit(doc, after)).toBeUndefined()
})

test('equal-value edits collapse without changing snapshots or producing hidden operations', () => {
  const { doc, child } = fixture()
  const after = produceDocumentDraft(doc, d => { d.nodes[child].fills = structuredClone(doc.nodes[child].fills) })
  expect(after).not.toBe(doc)
  expect(shareDocument(doc, after)).toBe(doc)
  const changed = produceDocumentDraft(doc, d => { d.nodes[child].name = 'one' })
  const reverted = produceDocumentDraft(changed, d => { d.nodes[child].name = doc.nodes[child].name })
  expect(shareDocument(doc, reverted)).toBe(doc)
})


test('proved scalar op batch equals the old compiler byte-for-byte and native graph output', () => {
  const { doc, child } = fixture()
  const after = produceDocumentDraft(doc, d => { d.nodes[child].opacity = .5; d.nodes[child].transform[4] = 80 })
  const oldBatch = compileEditOps(doc, after)
  expect(proveLocalEdit(doc, after)).toBeDefined()
  const batch = compileEditOps(doc, after)
  expect(batch).toEqual(oldBatch)
  if (batch.mode !== 'ops' || oldBatch.mode !== 'ops') throw Error('Expected scalar operations')
  const oldGraph = Graph.open(augmentedDocumentJson(doc)), graph = Graph.open(augmentedDocumentJson(doc))
  try {
    expect(graph.opsFrame(batch.ops, 1, true)).toEqual(oldGraph.opsFrame(oldBatch.ops, 1, true))
    oldGraph.applyOps(oldBatch.ops); graph.applyOps(batch.ops)
    expect(graph.documentJson()).toBe(oldGraph.documentJson())
    expect(graph.undoDepth()).toBe(1); expect(graph.undo()).toBe(true); expect(graph.redo()).toBe(true)
    expect(graph.documentJson()).toBe(oldGraph.documentJson())
  } finally { graph.free(); oldGraph.free() }
})

test('proof-backed real history preserves revision conflicts and atomic native rejection', () => {
  const { doc, child } = fixture(), graph = Graph.open(augmentedDocumentJson(doc)), history = createGraphHistoryState(doc, graph)
  try {
    const after = produceDocumentDraft(doc, d => { d.nodes[child].opacity = .5 })
    expect(proveLocalEdit(doc, after)).toBeDefined()
    expect(history.apply(0, after).revision).toBe(1)
    expect(() => history.apply(0, after)).toThrow(/版本冲突/)
    // Unknown targets are an actual native operation error. Scalar range
    // validation belongs to Editor.validateDocument, tested separately above.
    const nativeBefore = graph.documentJson()
    expect(() => graph.applyOps([
      { type: 'setOpacity', id: child, opacity: .7 },
      { type: 'setOpacity', id: 'missing-node', opacity: .4 },
    ])).toThrow()
    expect(graph.documentJson()).toBe(nativeBefore)
    expect(history.revision).toBe(1); expect(history.document).toBe(after)
    expect(history.undo().document).toBe(doc); expect(history.redo().document).toBe(after)
  } finally { history.free() }
})

test('multi-node scalar proof retains the old compiler wire order and semantics', () => {
  const { doc, child, other } = fixture()
  const after = produceDocumentDraft(doc, d => { d.nodes[other].name = 'second first'; d.nodes[child].opacity = .3 })
  const oldBatch = compileEditOps(doc, after)
  expect(proveLocalEdit(doc, after)).toBeDefined()
  const batch = compileEditOps(doc, after)
  expect(batch).toEqual(oldBatch)
  if (batch.mode !== 'ops' || oldBatch.mode !== 'ops') throw Error('Expected scalar operations')
  const oldGraph = Graph.open(augmentedDocumentJson(doc)), graph = Graph.open(augmentedDocumentJson(doc))
  try {
    expect(graph.opsFrame(batch.ops, 1, true)).toEqual(oldGraph.opsFrame(oldBatch.ops, 1, true))
    const initial = graph.documentJson()
    oldGraph.applyOps(oldBatch.ops); graph.applyOps(batch.ops)
    expect(graph.documentJson()).toBe(oldGraph.documentJson())
    const final = graph.documentJson()
    expect(graph.undoDepth()).toBe(1); graph.undo(); expect(graph.documentJson()).toBe(initial)
    graph.redo(); expect(graph.documentJson()).toBe(final)
  } finally { graph.free(); oldGraph.free() }
})
