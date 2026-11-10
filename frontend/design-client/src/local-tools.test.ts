import { test, expect } from 'vitest'
import { blank, node, uid, validateDocument } from './model'
import { Editor } from './engine'
import { forma_encode_json, forma_decode_json } from './generated/design-kernel/design_kernel'
import { createShapeSeed, resolveShapeCreation } from './shape-creation'
import { vectorTool } from './utility-tools'
import { exportBounds } from './export'

test('portable binary keeps authored fields and accepts no damaged string table', () => {
  const d = {
      ...blank(),
      extension: { optional: null, precise: 0.12345678901234566, label: 'original-label' },
    },
    bytes = forma_encode_json(JSON.stringify(d))
  expect(JSON.parse(forma_decode_json(bytes))).toEqual(d)
  const copy = bytes.slice(),
    pattern = new TextEncoder().encode('original-label')
  const at = copy.findIndex((_, i) => pattern.every((v, k) => copy[i + k] === v))
  expect(at).toBeGreaterThan(0)
  copy[at] ^= 1
  expect(() => forma_decode_json(copy)).toThrow()
})
test('slice creates retained geometry, uses schema 10, leaves artwork export bounds unchanged and undoes once', () => {
  const d = blank(),
    a = node('rectangle', 10, 20, 100, 60)
  d.nodes[a.id] = a
  d.pages[0].children = [a.id]
  const before = exportBounds(d, d.pages[0].id)
  const e = new Editor(d),
    slice = resolveShapeCreation(createShapeSeed('slice'), {
      anchor: { x: -300, y: -200 },
      pointer: { x: 300, y: 200 },
      screenDistance: 100,
    }).node
  e.change(
    '切片',
    (doc) => {
      doc.nodes[slice.id] = slice
      doc.pages[0].children.push(slice.id)
    },
    [slice.id],
  )
  expect(e.state.doc.schemaVersion).toBe(10)
  expect(slice.fills).toEqual([])
  expect(exportBounds(e.state.doc, e.state.page)).toEqual(before)
  e.undo()
  expect(e.state.doc).toEqual(d)
  e.dispose()
})
test('comments retain anchors in local coordinates, detach on deletion and undo with the document', () => {
  const d = blank(),
    n = node('rectangle', 100, 200, 100, 100)
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  const e = new Editor(d)
  e.change('评论', (doc) => {
    doc.reviews = [
      {
        id: uid(),
        pageId: doc.pages[0].id,
        nodeId: n.id,
        position: { x: 5, y: 8 },
        kind: 'comment',
        resolved: false,
        messages: [{ id: uid(), author: '本机用户', text: '保留原始字段', createdAt: 1 }],
      },
    ]
  })
  const saved = structuredClone(e.state.doc)
  expect(validateDocument(saved)).toEqual(saved)
  expect(JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(saved))))).toEqual(saved)
  e.select([n.id])
  e.remove()
  expect(e.state.doc.reviews![0].nodeId).toBeUndefined()
  expect(e.state.doc.reviews![0].position).toEqual({ x: 105, y: 208 })
  e.undo()
  expect(e.state.doc).toEqual(saved)
  e.dispose()
})
test('cutting a cubic produces two independent endpoints without moving the path', () => {
  const n = node('line', 0, 0, 100, 100)
  n.network = {
    vertices: [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 100, y: 0 },
    ],
    edges: [{ id: 'e', from: 'a', to: 'b', c1: { x: 0, y: 100 }, c2: { x: 100, y: 100 } }],
    fillRule: 'evenodd',
  }
  const out = vectorTool(n, 'cut', { x: 50, y: 75 }, { edge: 'e', parameter: 0.5, nonce: 'split' })
  expect(out.network.vertices.slice(-2).map((v) => [v.x, v.y])).toEqual([
    [50, 75],
    [50, 75],
  ])
  expect(out.network.edges).toHaveLength(2)
  expect(n.network.edges).toHaveLength(1)
})

test('table resizing preserves existing cell text and reverses as one transaction', async () => {
  const { boardObjects, resizeTable } = await import('./board-tools'),
    d = blank(),
    table = boardObjects('table', { x: 0, y: 0, width: 480, height: 192 })
  for (const n of table.nodes) d.nodes[n.id] = n
  d.pages[0].children = [table.root]
  d.schemaVersion = 10
  const e = new Editor(d),
    root = e.state.doc.nodes[table.root],
    cell = e.state.doc.nodes[root.children[0]],
    text = e.state.doc.nodes[cell.children[0]]
  e.update(
    [text.id],
    (n) => {
      n.text = '内容保留'
    },
    '文字',
  )
  const before = structuredClone(e.state.doc)
  resizeTable(e, root.id, 4, 4)
  expect(e.state.doc.nodes[text.id].text).toBe('内容保留')
  expect(e.state.doc.nodes[root.id].children).toHaveLength(16)
  e.undo()
  expect(e.state.doc).toEqual(before)
  e.dispose()
})
test('connector follows targets after layout instead of remaining a painted line', () => {
  const d = blank(),
    a = node('rectangle', 0, 0, 100, 50),
    b = node('rectangle', 300, 200, 100, 50),
    line = node('vector', 0, 0, 1, 1)
  line.connector = {
    style: 'elbow',
    from: { point: { x: 100, y: 25 }, nodeId: a.id, anchor: { x: 1, y: 0.5 } },
    to: { point: { x: 300, y: 225 }, nodeId: b.id, anchor: { x: 0, y: 0.5 } },
  }
  d.schemaVersion = 10
  d.nodes = { [a.id]: a, [b.id]: b, [line.id]: line }
  d.pages[0].children = [a.id, b.id, line.id]
  const e = new Editor(d)
  e.update(
    [b.id],
    (n) => {
      n.transform[4] = 400
    },
    '移动目标',
  )
  const actual = e.state.doc.nodes[line.id]
  expect(actual.transform[4] + actual.network!.vertices.at(-1)!.x).toBe(400)
  e.dispose()
})

test('property changes travel through real compressed op/facet batches and share undo history', async () => {
  const { createGraphHistory } = await import('./kernel/graph-history'),
    d = blank(),
    n = node('rectangle')
  d.nodes[n.id] = n
  d.pages[0].children = [n.id]
  const h = createGraphHistory(d)
  const next = structuredClone(d)
  next.nodes[n.id].name = '通过操作帧'
  next.nodes[n.id].opacity = 0.375
  next.nodes[n.id].transform[4] = 12.25
  const result = h.apply(0, next)
  expect(result.revision).toBe(1)
  expect(h.mode).toBe('op-batch')
  expect(h.frameBytes).toBe(0)
  const frames: Uint8Array[] = []
  h.setSyncFrameConsumer({ onFrame(frame, revision) { frames.push(frame); expect(revision).toBe(2) } })
  const third = structuredClone(next)
  third.nodes[n.id].name = '同步帧'
  expect(h.apply(1, third).revision).toBe(2)
  expect(h.frameBytes).toBeGreaterThan(0)
  const { Graph } = await import('./kernel/graph')
  const { augmentedDocumentJson } = await import('./kernel/op-sync')
  const probe = Graph.open(augmentedDocumentJson(d))
  try {
    const decoded = probe.decodeOpsFrame(frames[0], true)
    expect(decoded.revision).toBe(2)
    expect(decoded.ops).toEqual([expect.objectContaining({ type: 'setName', id: n.id, name: '同步帧' })])
  } finally { probe.free() }
  expect(h.undo().patch.nodes[n.id]).toEqual(next.nodes[n.id])
  expect(h.undo().patch.nodes[n.id]).toEqual(n)
  expect(h.redo().patch.nodes[n.id]).toEqual(next.nodes[n.id])
  h.free()
})

test('connector attachment picking reaches a shape under an existing connector', () => {
  const d = blank(),
    shape = node('rectangle', 0, 0, 100, 60),
    link = node('vector', 0, 0, 100, 60)
  link.network = {
    vertices: [
      { id: 'a', x: 0, y: 30 },
      { id: 'b', x: 100, y: 30 },
    ],
    edges: [{ id: 'e', from: 'a', to: 'b' }],
    fillRule: 'nonzero',
  }
  link.connector = { style: 'straight', from: { point: { x: 0, y: 30 } }, to: { point: { x: 100, y: 30 } } }
  d.schemaVersion = 10
  d.nodes = { [shape.id]: shape, [link.id]: link }
  d.pages[0].children = [shape.id, link.id]
  const e = new Editor(d)
  expect(e.hit({ x: 50, y: 30 }, true)).toBe(link.id)
  expect(
    e.hit({ x: 50, y: 30 }, true, undefined, 1, undefined, (n) => !n.connector && n.kind !== 'slice'),
  ).toBe(shape.id)
  e.dispose()
})
