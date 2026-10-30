import { expect, test } from 'vitest'
import { blank, node, type DesignDocument } from './model'
import { documentPatch } from './document-patch'
import { LayerRowsCache, layerTreeRows } from './layer-tree'
import { layerSelection } from './layer-selection'
import { Editor } from './engine'
function fixture(count = 20) {
  const doc = blank(), frame = node('frame', 0, 0, 10, 10)
  frame.id = 'frame'; doc.nodes = { frame }; doc.pages[0].children = ['frame']
  for (let i = 0; i < count; i++) {
    const n = node('text', 0, 0, 10, 10); n.id = `n${i}`; n.name = `Layer ${i}`
    doc.nodes[n.id] = n; frame.children.push(n.id)
  }
  return doc
}
const edit = (doc: DesignDocument, id: string, patch: object) => ({ ...doc, nodes: { ...doc.nodes, [id]: { ...doc.nodes[id], ...patch } } })
test('certified paint/text/visibility/lock edits reuse ordering', () => {
  let doc = fixture(10000)
  const cache = new LayerRowsCache(), collapsed = new Set<string>(), page = doc.pages[0].id
  const rows = cache.read(doc, page, collapsed, '')
  for (const patch of [{ text: 'new content' }, { visible: false }, { locked: true }, { opacity: .5 }, { name: 'Renamed' }]) {
    const next = edit(doc, 'n0', patch); documentPatch(doc, next); doc = next
    expect(cache.read(doc, page, collapsed, '')).toBe(rows)
    expect(rows).toEqual(layerTreeRows(doc, page, collapsed, ''))
  }
  expect(doc.nodes.n0.name).toBe('Renamed')
  expect(cache.stats).toEqual({ builds: 1, certificateHits: 5, nodeChecks: 0, rowAllocations: 10001 })
})
test('oracle for reorder, collapse, search, rename, removal, reparent, undo, pages and purge', () => {
  let doc = fixture(), collapsed = new Set<string>(), search = ''
  const cache = new LayerRowsCache(); let page = doc.pages[0].id
  const check = () => {
    const actual = cache.read(doc, page, collapsed, search), expected = layerTreeRows(doc, page, collapsed, search)
    expect(actual).toEqual(expected)
    expect(layerSelection(actual.map(r => r.id), [], 'n0', 'n10', { range: true }))
      .toEqual(layerSelection(expected.map(r => r.id), [], 'n0', 'n10', { range: true }))
  }
  const update = (next: DesignDocument) => { documentPatch(doc, next); doc = next; check() }
  check(); const initial = doc
  update(edit(doc, 'frame', { children: [...doc.nodes.frame.children].reverse() }))
  collapsed = new Set(['frame']); check(); search = 'Layer 1'; check()
  update(edit(doc, 'n0', { name: 'Layer 100' })); update(edit(doc, 'n1', { name: 'Gone' }))
  const absent = { ...doc, nodes: { ...doc.nodes } }; delete absent.nodes.n2; update(absent)
  search = ''; collapsed = new Set(); check()
  update({ ...doc, nodes: { ...doc.nodes, frame: { ...doc.nodes.frame, children: doc.nodes.frame.children.filter(id => id !== 'n0') } }, pages: [{ ...doc.pages[0], children: ['n0', 'frame'] }] })
  update(initial)
  doc = { ...doc, pages: [...doc.pages, { ...doc.pages[0], id: 'page2', children: ['n0'] }] }; page = 'page2'; check()
  page = 'missing'; check(); cache.clear(); check()
})
test('uncertified and skipped transitions fall back safely, including instance descendants', () => {
  const cache = new LayerRowsCache(), collapsed = new Set<string>(); let doc = fixture(), page = doc.pages[0].id
  const rows = cache.read(doc, page, collapsed, 'layer')
  let next = edit(doc, 'n0', { text: 'preview' })
  expect(cache.read(next, page, collapsed, 'layer')).toBe(rows); doc = next
  const skipped = edit(doc, 'n0', { name: 'does not match' }); documentPatch(doc, skipped)
  next = edit(skipped, 'frame', { instance: { componentId: 'component' }, children: ['n1'] }); documentPatch(skipped, next)
  expect(cache.read(next, page, collapsed, 'layer')).toEqual(layerTreeRows(next, page, collapsed, 'layer'))
  expect(cache.stats.nodeChecks).toBeGreaterThan(0)
})
test('deterministic mixed-edit differential sequence', () => {
  let doc = fixture(60), seed = 7; const cache = new LayerRowsCache(), page = doc.pages[0].id
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0)
  for (let i = 0; i < 400; i++) {
    const id = `n${random() % 60}`, old = doc
    if (i % 7 === 0) doc = edit(doc, 'frame', { children: [...doc.nodes.frame.children.slice(1), doc.nodes.frame.children[0]] })
    else doc = edit(doc, id, i % 3 ? { text: String(i), locked: !!(i % 2) } : { name: `Layer ${random() % 20}` })
    if (i % 4) documentPatch(old, doc)
    const collapsed = new Set(i % 11 ? [] : ['frame']), search = i % 5 ? '' : 'Layer 1'
    expect(cache.read(doc, page, collapsed, search)).toEqual(layerTreeRows(doc, page, collapsed, search))
  }
})

test('operation-count benchmark: wide, balanced and deep trees match the full traversal oracle', () => {
  const results: object[] = []
  for (const shape of ['wide', 'balanced', 'deep'] as const) {
    let doc = fixture(shape === 'deep' ? 400 : 10000)
    if (shape !== 'wide') {
      doc.nodes.frame.children = ['n0']
      const count = Object.keys(doc.nodes).length - 1
      for (let i = 1; i < count; i++) {
        const parent = shape === 'deep' ? i - 1 : Math.floor((i - 1) / 4)
        doc.nodes[`n${parent}`].children.push(`n${i}`)
      }
    }
    const cache = new LayerRowsCache(), page = doc.pages[0].id, collapsed = new Set<string>()
    const first = cache.read(doc, page, collapsed, ''), baselineRows = first.length * 21
    for (let i = 0; i < 20; i++) {
      const next = edit(doc, 'n20', { text: `Edit ${i}`, opacity: i / 20 }); documentPatch(doc, next); doc = next
      const rows = cache.read(doc, page, collapsed, '')
      expect(rows).toBe(first); expect(rows).toEqual(layerTreeRows(doc, page, collapsed, ''))
    }
    expect(cache.stats.builds).toBe(1); expect(cache.stats.nodeChecks).toBe(0)
    results.push({ shape, rows: first.length, updates: 20, baselineRowsAllocated: baselineRows, cachedRowsAllocated: cache.stats.rowAllocations, certifiedHits: cache.stats.certificateHits, fallbackNodeChecks: cache.stats.nodeChecks })
  }
  console.log('LAYER_ROW_OPERATION_BENCHMARK', JSON.stringify(results))
})


test('real editor commit, undo and redo preserve certified rows; clear releases cached snapshot', () => {
  const document = blank(), text = node('text', 0, 0, 100, 100)
  document.nodes[text.id] = text; document.pages[0].children = [text.id]
  const editor = new Editor(document), cache = new LayerRowsCache(), collapsed = new Set<string>()
  try {
    const read = () => cache.read(editor.state.doc, editor.state.page, collapsed, '')
    const first = read()
    editor.change('Text edit', doc => { doc.nodes[text.id].text = 'Changed' })
    expect(editor.state.doc.nodes[text.id].text, editor.state.message).toBe('Changed')
    expect(read()).toBe(first)
    editor.undo(); expect(read()).toBe(first)
    editor.redo(); expect(read()).toBe(first)
    expect(cache.stats.certificateHits).toBe(3)
    cache.clear(); expect(read()).not.toBe(first)
    expect(read()).toEqual(layerTreeRows(editor.state.doc, editor.state.page, collapsed, ''))
  } finally { editor.dispose() }
})
