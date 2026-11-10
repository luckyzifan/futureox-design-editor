import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from '../engine'
import { blank, defaultLayout, node, type DesignDocument, type DesignNode } from '../model'
import { Graph } from './graph'
import { augmentedDocumentJson, compileEditOps } from './op-sync'
import { createGraphHistoryState } from './graph-history-state'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const doc = blank('Content update')
  doc.schemaVersion = 21
  doc.fdCompatibility = {
    contractVersion: 1,
    requiredCapabilities: [],
    extensions: { 'org.example/content': { keep: null, n: 1.25 } },
  }
  const frame = node('frame', 0, 0, 240, 160)
  const a = node('rectangle', 4, 6, 40, 30)
  const b = node('ellipse', 80, 12, 36, 28)
  frame.layout = { ...defaultLayout(), mode: 'none', gap: 8 }
  frame.children = [a.id, b.id]
  Object.assign(a, { network: null, futureNodeData: { source: 'sketch', nullable: null } })
  b.locked = true
  doc.nodes = { [frame.id]: frame, [a.id]: a, [b.id]: b }
  doc.pages[0].children = [frame.id]
  const open = Graph.open
  let graph: Graph | undefined
  Graph.open = function (json: string) {
    graph = open.call(Graph, json)
    return graph
  }
  const editor = new Editor(doc)
  return {
    doc, editor, frame, a, b,
    graph() {
      if (!graph) throw new Error('editing graph was not opened')
      return graph
    },
    restore() { Graph.open = open },
  }
}

function nativeNode(graph: Graph, id: string) {
  return JSON.parse(graph.documentJson()).nodes[id] as DesignNode
}

test('unmoved fill edits use one content batch, stable handles and one undo', () => {
  const fx = fixture()
  try {
    fx.editor.change('seed', draft => { draft.nodes[fx.a.id].name = 'Seed' })
    const graph = fx.graph()
    const frameHandle = graph.handle(fx.frame.id)
    const handle = graph.handle(fx.a.id)
    const sibling = graph.handle(fx.b.id)
    const before = fx.editor.state.doc
    const nativeBefore = graph.documentJson()
    const changed = fx.editor.change('fills', draft => {
      draft.nodes[fx.a.id].fills[0].color = '#123456'
      draft.nodes[fx.a.id].fills[0].opacity = 0.1
      draft.nodes[fx.a.id].opacity = 0.25
    })
    expect(changed.status).toBe('committed')
    const after = fx.editor.state.doc
    const batch = compileEditOps(before, after)
    expect(batch.mode).toBe('ops')
    if (batch.mode !== 'ops') throw new Error('expected ops')
    expect(batch.ops.map(op => op.type)).toEqual(['updateNodeContent'])
    expect(graph.handle(fx.a.id)).toBe(handle)
    expect(graph.handle(fx.b.id)).toBe(sibling)
    expect(graph.handle(fx.frame.id)).toBe(frameHandle)
    expect(graph.parent(handle)).toBe(frameHandle)
    expect(graph.children(frameHandle)).toEqual([handle, sibling])
    expect(graph.undoDepth()).toBe(2)
    expect(after.nodes[fx.frame.id]).toBe(before.nodes[fx.frame.id])
    expect(after.nodes[fx.b.id]).toBe(before.nodes[fx.b.id])
    expect(after.fdCompatibility).toBe(before.fdCompatibility)
    expect(after.nodes[fx.a.id].network).toBeNull()
    expect((after.nodes[fx.a.id] as DesignNode & { futureNodeData?: { source: string; nullable: null } }).futureNodeData)
      .toEqual({ source: 'sketch', nullable: null })
    expect(after.nodes[fx.frame.id].layout).toBe(before.nodes[fx.frame.id].layout)
    const native = nativeNode(graph, fx.a.id)
    expect(native.fills[0].color).toBe('#123456')
    expect(native.fills[0].opacity).toBe(0.1)
    expect(native.opacity).toBe(0.25)
    expect(nativeNode(graph, fx.frame.id).children).toEqual([fx.a.id, fx.b.id])
    expect(nativeNode(graph, fx.frame.id).layout?.mode).toBe('none')
    fx.editor.undo()
    expect(fx.editor.state.doc).toBe(before)
    expect(fx.editor.state.doc.nodes[fx.a.id].fills[0].color).not.toBe('#123456')
    expect(graph.documentJson()).toBe(nativeBefore)
    expect(graph.handle(fx.a.id)).toBe(handle)
    fx.editor.redo()
    expect(fx.editor.state.doc).toBe(after)
    expect(graph.handle(fx.a.id)).toBe(handle)
    expect(nativeNode(graph, fx.a.id).fills[0].color).toBe('#123456')
  } finally { fx.editor.dispose(); fx.restore() }
})

test('a rejected content batch leaves authored state, revision and native handles untouched', () => {
  const fx = fixture()
  try {
    fx.editor.change('seed', draft => { draft.nodes[fx.a.id].name = 'Seed' })
    const graph = fx.graph()
    const handle = graph.handle(fx.a.id)
    const before = fx.editor.state.doc
    const version = fx.editor.state.version
    const native = graph.documentJson()
    const depth = graph.undoDepth()
    vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => { throw new Error('content rejected') })
    const rejected = fx.editor.change('fills', draft => { draft.nodes[fx.a.id].fills[0].color = '#ffffff' })
    expect(rejected.status).toBe('rejected')
    expect(fx.editor.state.doc).toBe(before)
    expect(fx.editor.state.version).toBe(version)
    expect(graph.documentJson()).toBe(native)
    expect(graph.undoDepth()).toBe(depth)
    expect(graph.handle(fx.a.id)).toBe(handle)
    const retry = fx.editor.change('fills', draft => { draft.nodes[fx.a.id].fills[0].color = '#abcdef' })
    expect(retry.status).toBe('committed')
    expect(fx.editor.state.version).toBe(version + 1)
    expect(graph.handle(fx.a.id)).toBe(handle)
  } finally { fx.editor.dispose(); fx.restore() }
})

test('native content admission rejects identity and child changes atomically', () => {
  const fx = fixture()
  try {
    fx.editor.change('seed', draft => { draft.nodes[fx.a.id].name = 'Seed' })
    const graph = fx.graph()
    const handle = graph.handle(fx.a.id)
    const native = graph.documentJson()
    const depth = graph.undoDepth()
    const node = fx.editor.state.doc.nodes[fx.a.id]
    expect(() => graph.applyOps([
      { type: 'setName', id: fx.a.id, name: 'must-not-stick' },
      { type: 'updateNodeContent', id: fx.a.id, node: { ...node, children: ['missing-child'] } },
    ])).toThrow(/children/)
    expect(graph.documentJson()).toBe(native)
    expect(graph.undoDepth()).toBe(depth)
    expect(graph.name(handle)).toBe('Seed')
    expect(() => graph.applyOps([
      { type: 'updateNodeContent', id: fx.a.id, node: { ...node, id: 'other-node' } },
    ])).toThrow(/id/)
    expect(graph.handle(fx.a.id)).toBe(handle)
    expect(graph.documentJson()).toBe(native)
  } finally { fx.editor.dispose(); fx.restore() }
})

test('a sync consumer receives the same admitted content result as a local commit', () => {
  const fx = fixture()
  try {
    fx.editor.change('seed', draft => { draft.nodes[fx.a.id].fills[0].color = '#111111' })
    const local = fx.graph().documentJson()
    fx.editor.undo()
    const history = createGraphHistoryState(fx.editor.state.doc, Graph.open(augmentedDocumentJson(fx.editor.state.doc)))
    const frames: Uint8Array[] = []
    history.setSyncFrameConsumer({ onFrame(frame) { frames.push(frame) } })
    const next = { ...fx.editor.state.doc, nodes: { ...fx.editor.state.doc.nodes, [fx.a.id]: { ...fx.editor.state.doc.nodes[fx.a.id], fills: fx.editor.state.doc.nodes[fx.a.id].fills.map((paint, index) => index === 0 ? { ...paint, color: '#111111' } : paint) } } }
    history.apply(0, next)
    expect(frames.length).toBe(1)
    const decoded = fx.graph().decodeOpsFrame(frames[0], true)
    expect(decoded.revision).toBe(1)
    expect(decoded.ops.map(op => op.type)).toEqual(['updateNodeContent'])
    expect(history.document.nodes[fx.a.id].fills[0].color).toBe('#111111')
    const probe = Graph.open(augmentedDocumentJson(fx.editor.state.doc))
    try {
      probe.applyOps(decoded.ops)
      expect(JSON.parse(probe.documentJson()).nodes[fx.a.id].fills[0].color).toBe(JSON.parse(local).nodes[fx.a.id].fills[0].color)
      expect(JSON.parse(probe.documentJson()).nodes[fx.frame.id].children).toEqual(JSON.parse(local).nodes[fx.frame.id].children)
    } finally { probe.free() }
    history.free()
  } finally { fx.editor.dispose(); fx.restore() }
})

test('locked siblings are not rewritten and a disposed history rejects the old session', () => {
  const fx = fixture()
  try {
    const locked = fx.editor.state.doc.nodes[fx.b.id]
    fx.editor.update([fx.a.id, fx.b.id], n => { n.fills[0].color = '#010203' }, '修改填充')
    expect(fx.editor.state.doc.nodes[fx.a.id].fills[0].color).toBe('#010203')
    expect(fx.editor.state.doc.nodes[fx.b.id]).toBe(locked)
    expect(fx.editor.state.doc.nodes[fx.b.id].fills[0].color).not.toBe('#010203')
    const history = createGraphHistoryState(fx.doc, Graph.open(augmentedDocumentJson(fx.doc)))
    const renamed = { ...fx.doc, nodes: { ...fx.doc.nodes, [fx.a.id]: { ...fx.doc.nodes[fx.a.id], name: 'once' } } }
    expect(history.apply(0, renamed).revision).toBe(1)
    expect(() => history.apply(0, renamed)).toThrow(/版本冲突/)
    history.free()
    expect(() => history.apply(1, renamed)).toThrow(/已释放/)
    expect(() => history.undo()).toThrow(/已释放/)
  } finally { fx.editor.dispose(); fx.restore() }
})
