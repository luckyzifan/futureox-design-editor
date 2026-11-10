/** Pure data/transaction-boundary tests. No WASM initialization, renderer,
 * browser, GPU device or GPU-shaped mock is loaded. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { compileEditOps, augmentedDocumentJson, PAGES_ROOT_ID } from './op-sync.ts'
import { createGraphHistoryState } from './graph-history-state.ts'

const clone = value => structuredClone(value)
function node(id, children = []) {
  return { id, name: id, kind: 'frame', transform: [1, 0, 0, 1, 0, 0], width: 100, height: 80,
    children, visible: true, locked: false, opacity: 1, blend: 'normal', fills: [], strokes: [],
    effects: [], radii: [0, 0, 0, 0], smoothing: 0, clip: false, mask: false, points: 0,
    innerRadius: 0, text: '', fontSize: 28 }
}
function document() {
  return { id: 'imported', name: 'Imported document', schemaVersion: 1,
    pages: [{ id: 'page', name: 'Imported page', children: ['frame'], background: '#fff' }],
    nodes: { frame: node('frame', ['a', 'b']), a: node('a'), b: node('b') },
    fonts: {}, colorManagement: { documentSpace: 'srgb', referenceWhiteNits: 203, peakLuminanceNits: 1000 }, prototype: {}, animations: [] }
}

/** Independent model of the CPU Graph transaction boundary. All failed batches
 * leave its store and history untouched, matching graph_api.rs::apply staging. */
class MemoryGraph {
  constructor(doc) { this.doc = JSON.parse(augmentedDocumentJson(doc)); this.past = []; this.future = []; this.commits = 0; this.frees = 0; this.appliedScopes = []; this.frameCalls = 0; this.decodeCalls = 0 }
  free() { this.frees++ }
  commit(doc) { this.past.push(clone(this.doc)); if (this.past.length > 128) this.past.shift(); this.doc = doc; this.future = []; this.commits++ }
  replaceDocument(json, scope) {
    if (this.rejectReplace) throw Error('replacement rejected')
    this.appliedScopes.push(scope ?? null)
    if (scope?.ignoreUndoRedo) { this.doc = JSON.parse(json); this.future = []; this.commits++ }
    else this.commit(JSON.parse(json))
    return this.commits + 1
  }
  undoDepth() { return this.past.length }
  redoDepth() { return this.future.length }
  undo() { if (this.rejectUndo) throw Error('undo rejected'); if (!this.past.length) return false; this.future.push(this.doc); this.doc = this.past.pop(); return true }
  redo() { if (this.rejectRedo) throw Error('redo rejected'); if (!this.future.length) return false; this.past.push(this.doc); this.doc = this.future.pop(); return true }
  opsFrame(ops, revision) { this.frameCalls++; return new TextEncoder().encode(JSON.stringify({ ops, revision })) }
  decodeOpsFrame(frame) { this.decodeCalls++; const value = JSON.parse(new TextDecoder().decode(frame)); if (this.badFrameRevision) value.revision++; return value }
  applyOps(ops, scope) {
    if (this.rejectOps) throw Error('batch rejected')
    const next = clone(this.doc)
    for (const op of ops) {
      const n = next.nodes[op.id]
      switch (op.type) {
        case 'setName': n.name = op.name; break
        case 'setVisible': n.visible = op.visible; break
        case 'setOpacity': n.opacity = op.opacity; break
        case 'setTransform': n.transform = clone(op.matrix); break
        case 'resize': n.width = op.width; n.height = op.height; break
        case 'removeNode':
          assert.ok(n); delete next.nodes[op.id]
          for (const parent of Object.values(next.nodes)) parent.children = parent.children.filter(id => id !== op.id)
          break
        case 'insertNode': {
          assert.ok(next.nodes[op.parent]); assert.equal(next.nodes[op.node.id], undefined)
          next.nodes[op.node.id] = clone(op.node)
          const children = next.nodes[op.parent].children
          children.splice(Math.min(op.index, children.length), 0, op.node.id)
          break
        }
        case 'reorderChild': {
          const children = next.nodes[op.parent].children
          if (op.from < children.length) { const moved = children.splice(op.from, 1)[0]; children.splice(Math.min(op.to, children.length), 0, moved) }
          break
        }
        case 'updateNodeContent': {
          assert.equal(op.node.id, op.id)
          assert.ok(n, `content update target ${op.id} is missing`)
          assert.deepEqual(op.node.children, n.children)
          const parents = Object.values(next.nodes).map(parent => parent.children.join('\0')).join('|')
          next.nodes[op.id] = clone(op.node)
          assert.equal(Object.values(next.nodes).map(parent => parent.children.join('\0')).join('|'), parents)
          break
        }
        default: throw Error(`test model intentionally lacks ${op.type}`)
      }
    }
    this.appliedScopes.push(scope ?? null)
    // Mirror graph_api.rs: an ignoreUndoRedo batch installs without an undo
    // entry but still invalidates the redo chain.
    if (scope?.ignoreUndoRedo) { this.doc = next; this.future = []; this.commits++ }
    else this.commit(next)
  }
}
function assertProjection(graph, expected) { assert.deepEqual(graph.doc, JSON.parse(augmentedDocumentJson(expected))) }

test('document/page edits route complete data, with no false anchor or assumed schema admission', () => {
  const before = document()
  for (const patch of [
    { name: 'Renamed' }, { schemaVersion: 9 }, { fonts: { imported: { family: 'Imported Font', data: 'AA==' } } },
    { colorManagement: { documentSpace: 'display-p3', referenceWhiteNits: 203, peakLuminanceNits: 1000 } }, { prototype: { startNode: 'a' } }, { animations: [{ id: 'anim' }] },
    { designSystem: { components: ['symbol'] } }, { rasterProfile: 'figma' },
    { futureCompatibility: { source: 'figma' } },
    { pages: [{ ...before.pages[0], name: 'Renamed page', background: '#123456', children: ['b', 'frame'] }] },
  ]) {
    const after = { ...clone(before), ...patch }
    assert.equal(compileEditOps(before, after).mode, 'replace')
    const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
    assert.equal(history.apply(0, after).revision, 1)
    assertProjection(graph, after)
    assert.equal(history.undo().revision, 2); assertProjection(graph, before)
    assert.equal(history.redo().revision, 3); assertProjection(graph, after)
  }
})

test('new nested child keeps final sibling position and exact transform payload', () => {
  const before = document(), after = clone(before)
  after.nodes.c = { ...node('c'), transform: [-1, 0.3, 0.2, 1, 14.25, -7.5] }
  after.nodes.frame.children = ['a', 'c', 'b']
  const batch = compileEditOps(before, after)
  assert.equal(batch.mode, 'ops')
  assert.deepEqual(batch.ops.find(op => op.type === 'insertNode').index, 1)
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  history.apply(0, after); assertProjection(graph, after)
  history.undo(); assertProjection(graph, before); history.redo(); assertProjection(graph, after)
})

test('permutations and nested reparenting reproduce the exact final tree', () => {
  for (const order of [['b', 'a'], ['a', 'b']]) {
    const before = document(), after = clone(before)
    after.nodes.frame.children = order
    const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
    history.apply(0, after); assertProjection(graph, after)
  }
  const before = document(), after = clone(before)
  after.nodes.frame.children = ['a']; after.nodes.a.children = ['b']
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  history.apply(0, after); assertProjection(graph, after)
})

test('text, curves, component and layout payloads are carried exactly to the graph boundary', () => {
  const before = document(), after = clone(before)
  Object.assign(after.nodes.a, { text: '你好 e\u0301', textRuns: [{ start: 0, end: 2, fontFamily: 'Imported' }],
    network: { vertices: [{ x: 0.25, y: 2.5 }], edges: [] }, componentKey: 'sketch-symbol',
    layout: { horizontal: true, gap: 9.5 }, constraints: { horizontal: 'scale', vertical: 'max' },
    fills: [{ kind: 'solid', color: '#abcdef' }], futureNodeData: { source: 'figma' } })
  const batch = compileEditOps(before, after)
  assert.equal(batch.mode, 'ops')
  assert.deepEqual(batch.ops.map(op => op.type), ['updateNodeContent'])
  assert.equal(batch.ops[0].id, 'a')
  assert.deepEqual(batch.ops[0].node.children, before.nodes.a.children)
  assert.deepEqual(batch.ops[0].node.futureNodeData, { source: 'figma' })
  assert.ok(!batch.ops.some(op => op.type === 'removeNode' || op.type === 'insertNode'))
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  history.apply(0, after); assertProjection(graph, after)
  history.undo(); assertProjection(graph, before); history.redo(); assertProjection(graph, after)
})

test('rejected op batch propagates without replacement, mutation or lost redo; the same revision retries', () => {
  const before = document(), first = clone(before); first.nodes.a.name = 'first'
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  history.apply(0, first)
  graph.rejectOps = true
  const second = clone(first); second.nodes.b.name = 'second'
  assert.throws(() => history.apply(1, second), /batch rejected/)
  assert.equal(history.revision, 1); assert.equal(history.document.nodes.b.name, 'b')
  assert.equal(graph.commits, 1); assertProjection(graph, first)
  history.undo(); assertProjection(graph, before)
  assert.throws(() => history.apply(2, second), /batch rejected/)
  assert.equal(history.revision, 2); assert.equal(graph.redoDepth(), 1)
  graph.rejectOps = false
  history.redo(); assertProjection(graph, first)
  const result = history.apply(3, second)
  assert.equal(result.undoDepth, 2); assert.equal(graph.commits, 2); assertProjection(graph, second)
  history.undo(); assertProjection(graph, first); history.undo(); assertProjection(graph, before)
})

test('replacement and op failures never advance revision or snapshots and the same revision retries', () => {
  for (const failure of ['metadata', 'op']) {
    const before = document(), after = clone(before)
    if (failure === 'metadata') after.fonts = { imported: { family: 'Imported', data: 'AA==' } }
    else after.nodes.a.name = 'pending'
    const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
    graph.rejectOps = true; graph.rejectReplace = true
    assert.throws(() => history.apply(0, after), failure === 'metadata' ? /replacement rejected/ : /batch rejected/)
    assertProjection(graph, before); assert.equal(graph.commits, 0)
    assert.equal(history.undo().revision, 0)
    graph.rejectReplace = false; graph.rejectOps = false
    const result = history.apply(0, after)
    assert.equal(result.revision, 1); assert.equal(result.undoDepth, 1); assertProjection(graph, after)
  }
})

test('local commits do not build a transport frame; a consumer checks revision before apply', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  assert.equal(history.apply(0, before).revision, 0)
  assert.throws(() => history.apply(0, { ...before, id: 'other' }), /文件标识/)
  const after = clone(before); after.nodes.a.name = 'changed'
  history.apply(0, after)
  assert.equal(graph.frameCalls, 0)
  assert.equal(graph.decodeCalls, 0)
  assert.equal(history.frameBytes, 0)
  assert.equal(history.mode, 'op-batch')
  assertProjection(graph, after)
  history.undo(); assertProjection(graph, before)
  const delivered = []
  history.setSyncFrameConsumer({ onFrame(frame, revision) { delivered.push({ bytes: frame.byteLength, revision }) } })
  graph.badFrameRevision = true
  assert.throws(() => history.apply(2, after), /版本不一致/)
  assert.equal(graph.commits, 1)
  assert.equal(delivered.length, 0)
  assertProjection(graph, before)
  graph.badFrameRevision = false
  history.apply(2, after)
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].revision, 3)
  assert.ok(delivered[0].bytes > 0)
  assert.equal(history.frameBytes, delivered[0].bytes)
  assertProjection(graph, after)
  history.setSyncFrameConsumer({ onFrame() { throw Error('consumer rejected the frame') } })
  const blocked = clone(after); blocked.nodes.b.name = 'blocked'
  assert.throws(() => history.apply(3, blocked), /consumer rejected/)
  assert.equal(history.revision, 3)
  assertProjection(graph, after)
  history.setSyncFrameConsumer(null)
  const again = clone(after); again.nodes.b.name = 'local'
  const calls = graph.frameCalls
  history.apply(3, again)
  assert.equal(graph.frameCalls, calls)
  assert.equal(history.frameBytes, 0)
  assertProjection(graph, again)
})

test('unexpressible disconnected edits use replacement and cycles cannot hang compilation', () => {
  const before = document(), after = clone(before)
  after.nodes.orphan = node('orphan')
  assert.equal(compileEditOps(before, after).mode, 'replace')
  const cyclic = document(); cyclic.nodes.x = node('x', ['y']); cyclic.nodes.y = node('y', ['x'])
  const next = clone(cyclic); delete next.nodes.x; delete next.nodes.y
  assert.equal(compileEditOps(cyclic, next).mode, 'replace')
})

test('bounded mixed history retains exactly the last 128 complete graph and TS states', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  let after = before
  for (let i = 0; i < 140; i++) { after = clone(after); if (i % 2) after.name = `metadata-${i}`; else after.nodes.a.name = `node-${i}`; history.apply(i, after) }
  assert.equal(graph.undoDepth(), 128)
  for (let i = 0; i < 128; i++) {
    const undo = history.undo()
    assert.ok(Object.keys(undo.patch.nodes).length || Object.keys(undo.patch.fields).length)
    assertProjection(graph, undo.document)
  }
  const noUndo = history.undo(); assert.equal(noUndo.undoDepth, 0); assert.equal(noUndo.revision, 268)
  for (let i = 0; i < 128; i++) history.redo()
  assertProjection(graph, after)
  assert.ok(graph.doc.nodes[PAGES_ROOT_ID])
})

test('typed history shares untouched records and preserves authored null, absent and unknown fields', () => {
  const before = document()
  before.nodes.a.network = null
  before.nodes.a.futureNodeData = { source: 'sketch', nullable: null }
  before.futureCompatibility = { source: 'sketch', nullable: null }
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const after = clone(before)
  after.nodes.a.name = 'changed'
  after.nodes.a.fills = [{ kind: 'solid', color: '#123456', image: null }]
  const committed = history.apply(0, after)
  assert.deepEqual(committed.changedIds, ['a'])
  assert.strictEqual(committed.document, history.document)
  assert.strictEqual(committed.document.nodes.b, before.nodes.b)
  assert.strictEqual(committed.document.pages, before.pages)
  assert.strictEqual(committed.document.futureCompatibility, before.futureCompatibility)
  assert.equal(committed.document.nodes.a.network, null)
  assert.equal(Object.hasOwn(committed.document.nodes.a, 'layout'), false)
  assert.deepEqual(committed.document.nodes.a.futureNodeData, before.nodes.a.futureNodeData)
  const undo = history.undo()
  assert.strictEqual(undo.document, before)
  assert.equal(undo.document.nodes.a.network, null)
  assert.equal(Object.hasOwn(undo.document.nodes.a, 'layout'), false)
  const redo = history.redo()
  assert.strictEqual(redo.document, committed.document)
  assert.equal(redo.document.nodes.a.fills[0].image, null)
  assert.equal(committed.document.nodes.a.fills[0].image, null)
})

test('metadata removal and authored null survive undo and redo without reconstructing patches', () => {
  const before = document(); before.futureCompatibility = { from: 'sketch' }
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const removed = clone(before); delete removed.futureCompatibility
  const first = history.apply(0, removed)
  assert.equal(Object.hasOwn(first.document, 'futureCompatibility'), false)
  assert.deepEqual(first.changedIds, [])
  assert.deepEqual(history.undo().document.futureCompatibility, { from: 'sketch' })
  assert.equal(Object.hasOwn(history.redo().document, 'futureCompatibility'), false)
  const nullable = { ...history.document, futureCompatibility: null }
  assert.equal(history.apply(3, nullable).document.futureCompatibility, null)
  assert.equal(Object.hasOwn(history.undo().document, 'futureCompatibility'), false)
  assert.equal(history.redo().document.futureCompatibility, null)
})

test('no-op commits preserve the exact authored snapshot and do not discard redo', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const after = clone(before); after.nodes.a.name = 'changed'
  history.apply(0, after); history.undo()
  const noop = history.apply(2, clone(before))
  assert.strictEqual(noop.document, before)
  assert.equal(noop.revision, 2); assert.equal(noop.redoDepth, 1)
  assert.deepEqual(noop.changedIds, [])
  assert.deepEqual(noop.patch, { nodes: {}, fields: {} })
  assert.equal(graph.commits, 1)
  history.redo(); assertProjection(graph, after)
})

test('a new commit after undo discards redo and reports inserted and deleted node ids', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const first = clone(before); first.nodes.a.name = 'first'
  history.apply(0, first); history.undo()
  const branch = clone(before)
  delete branch.nodes.b; branch.nodes.c = node('c'); branch.nodes.frame.children = ['a', 'c']
  const result = history.apply(2, branch)
  assert.deepEqual(new Set(result.changedIds), new Set(['frame', 'b', 'c']))
  assert.equal(result.redoDepth, 0); assert.equal(result.undoDepth, 1)
  assert.strictEqual(history.redo().document, result.document)
  history.undo(); assertProjection(graph, before)
})

test('failed undo and redo preserve revision, snapshots and exact document references', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const after = clone(before); after.nodes.a.name = 'changed'
  const committed = history.apply(0, after)
  graph.rejectUndo = true
  assert.throws(() => history.undo(), /undo rejected/)
  assert.equal(history.revision, 1); assert.strictEqual(history.document, committed.document)
  graph.rejectUndo = false; history.undo(); graph.rejectRedo = true
  assert.throws(() => history.redo(), /redo rejected/)
  assert.equal(history.revision, 2); assert.strictEqual(history.document, before)
  graph.rejectRedo = false
  assert.strictEqual(history.redo().document, committed.document)
})

test('unexpected projection depth fails before moving the authored timeline; disposal is idempotent', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  graph.replaceDocument(augmentedDocumentJson(before))
  assert.throws(() => history.undo(), /记录不一致/)
  assert.equal(history.revision, 0); assert.strictEqual(history.document, before)
  history.free(); history[Symbol.dispose]()
  assert.equal(graph.frees, 1)
  assert.throws(() => history.apply(0, before), /已释放/)
  assert.throws(() => history.undo(), /已释放/)
  assert.throws(() => history.redo(), /已释放/)
})

test('every user edit submits with an explicit user edit scope', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const after = clone(before); after.nodes.a.name = 'renamed'
  history.apply(0, after)
  assert.deepEqual(graph.appliedScopes, [{ source: 'user' }])
})

test('declared scopes reach the kernel; ignoreUndoRedo stays out of both histories', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const first = clone(before); first.nodes.a.name = 'first'
  history.apply(0, first)
  assert.equal(graph.undoDepth(), 1)
  const silent = clone(first); silent.nodes.b.name = 'ai-fix'
  const result = history.apply(1, silent, { source: 'ai', ignoreUndoRedo: true })
  assert.deepEqual(graph.appliedScopes.at(-1), { source: 'ai', ignoreUndoRedo: true })
  assertProjection(graph, silent)
  assert.equal(graph.undoDepth(), 1, 'ignored batch must not grow kernel history')
  assert.equal(result.undoDepth, 1)
  // Undo after an ignored commit reverts to the last undoable state on both
  // sides — the ignored edit itself is not recoverable, by design.
  history.undo(); assertProjection(graph, before)
  assert.equal(history.document.nodes.b.name, 'b')
  const again = clone(before); again.nodes.a.name = 'again'
  const plugin = history.apply(history.revision, again, { source: 'plugin' })
  assert.deepEqual(graph.appliedScopes.at(-1), { source: 'plugin' })
  assert.equal(plugin.undoDepth, 1)
  assertProjection(graph, again)
})

test('document replacements preserve provenance and the same ignored-history semantics as ops', () => {
  const before = document(), graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const after = clone(before); after.name = 'renamed-doc' // metadata edits compile to replacements
  history.apply(0, after, { source: 'ai', ignoreUndoRedo: true })
  assert.deepEqual(graph.appliedScopes.at(-1), { source: 'ai', ignoreUndoRedo: true })
  assert.equal(graph.commits, 1); assertProjection(graph, after)
  assert.equal(history.undo().undoDepth, 0)
  const next = clone(after); next.name = 'plugin replacement'
  history.apply(1, next, { source: 'plugin' })
  assert.deepEqual(graph.appliedScopes.at(-1), { source: 'plugin' })
  history.undo(); assertProjection(graph, after)
  history.redo(); assertProjection(graph, next)
})

test('multiple unmoved fills compile to content updates and one undo, without rewriting parents', () => {
  const before = document(), after = clone(before)
  after.nodes.a.fills = [{ kind: 'solid', color: '#111111', opacity: 0.25 }]
  after.nodes.b.fills = [{ kind: 'solid', color: '#222222' }]
  after.nodes.a.opacity = 0.5
  const batch = compileEditOps(before, after)
  assert.equal(batch.mode, 'ops')
  assert.deepEqual(batch.ops.map(op => op.type), ['updateNodeContent', 'updateNodeContent'])
  assert.deepEqual(batch.ops.map(op => op.id), ['a', 'b'])
  assert.equal(batch.ops[0].node.opacity, 0.5)
  assert.deepEqual(batch.ops[0].node.children, before.nodes.a.children)
  assert.ok(batch.ops.every(op => op.type !== 'removeNode' && op.type !== 'insertNode'))
  const graph = new MemoryGraph(before), history = createGraphHistoryState(before, graph)
  const committed = history.apply(0, after, { source: 'plugin' })
  assert.equal(committed.revision, 1)
  assert.deepEqual(committed.changedIds, ['a', 'b'])
  assert.deepEqual(graph.appliedScopes, [{ source: 'plugin' }])
  assert.equal(graph.undoDepth(), 1)
  assert.equal(graph.frameCalls, 0, 'local content commits do not encode a sync frame')
  assertProjection(graph, after)
  assert.deepEqual(graph.doc.nodes.frame.children, ['a', 'b'])
  history.undo(); assertProjection(graph, before)
  history.redo(); assertProjection(graph, after)
  assert.throws(() => history.apply(1, after), /版本冲突/)
  assert.equal(history.revision, 3)
  assertProjection(graph, after)
})

test('scalar batches stay scalar ops, and a child move is not a content-only batch', () => {
  const before = document(), renamed = clone(before)
  renamed.nodes.a.name = 'first'
  renamed.nodes.b.opacity = 0.25
  const scalars = compileEditOps(before, renamed)
  assert.equal(scalars.mode, 'ops')
  assert.ok(scalars.ops.every(op => op.type === 'setName' || op.type === 'setOpacity'))
  assert.equal(scalars.ops.length, 2)
  const moved = clone(renamed)
  moved.nodes.frame.children = ['a']
  moved.nodes.a.children = ['b']
  moved.nodes.b.fills = [{ kind: 'solid', color: '#abcdef' }]
  const structural = compileEditOps(renamed, moved)
  assert.equal(structural.mode, 'ops')
  assert.ok(structural.ops.some(op => op.type === 'removeNode' || op.type === 'insertNode' || op.type === 'reorderChild'))
  const graph = new MemoryGraph(renamed), history = createGraphHistoryState(renamed, graph)
  history.apply(0, moved)
  assertProjection(graph, moved)
  history.undo(); assertProjection(graph, renamed)
})
