import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import * as Model from './model'
import * as Components from './components'
import * as Picking from './kernel/picking'
import { Graph } from './kernel/graph'
import { componentFixture, originNode } from './component-fixtures'

const baseline = process.env.LOCAL_EDIT_BASELINE === '1'
const editors: Editor[] = []
afterEach(() => { for (const e of editors.splice(0)) e.dispose(); vi.restoreAllMocks() })
function fixture(components = true) {
  const doc = components ? componentFixture().doc : Model.blank('Local edit proof')
  const target = Model.node('rectangle', 10, 20, 30, 40)
  target.fills = [Model.paint('#123456')]
  doc.nodes[target.id] = target; doc.pages[0].children.push(target.id)
  const editor = new Editor(doc); editors.push(editor)
  editor.warmEditingHistory(editor.state.doc, editor.sessionGeneration)
  return { editor, id: target.id }
}
function counters() {
  return {
    structure: vi.spyOn(Model, 'validateStructure'), validation: vi.spyOn(Model, 'validateDocument'),
    capture: vi.spyOn(Components, 'captureOverrides'), detach: vi.spyOn(Components, 'detachMissing'),
    layout: vi.spyOn(Picking, 'kernelLayout'), native: vi.spyOn(Graph.prototype, 'applyOps'),
  }
}

test('actual Editor/WASM: two independent opacity edits preserve validation, op history and undo while eliminating unrelated dependency passes', () => {
  const { editor: e, id } = fixture(), before = e.state.doc
  const count = counters()
  expect(e.change('Opacity one', d => { d.nodes[id].opacity = .55 }).status).toBe('committed')
  expect(e.change('Opacity two', d => { d.nodes[id].opacity = .65 }).status).toBe('committed')
  const calls = Object.fromEntries(Object.entries(count).map(([key, spy]) => [key, spy.mock.calls.length]))
  console.log('LOCAL_EDIT_CALL_COUNTS', JSON.stringify({ baseline, nodes: Object.keys(before.nodes).length, calls }))
  expect(count.validation).toHaveBeenCalledTimes(2)
  expect(count.native).toHaveBeenCalledTimes(2)
  if (baseline) {
    expect(count.structure).toHaveBeenCalledTimes(4)
    expect(count.capture).toHaveBeenCalledTimes(2); expect(count.detach).toHaveBeenCalledTimes(2)
    expect(count.layout).toHaveBeenCalledTimes(2)
  } else {
    expect(count.structure).toHaveBeenCalledTimes(1)
    expect(count.capture).not.toHaveBeenCalled(); expect(count.detach).not.toHaveBeenCalled()
    expect(count.layout).not.toHaveBeenCalled()
  }
  const final = e.state.doc
  expect(e.state.version).toBe(2); expect(e.historyOperationMode).toBe('op-batch')
  e.undo(); expect(e.state.doc.nodes[id].opacity).toBe(.55)
  e.undo(); expect(e.state.doc).toEqual(before)
  e.redo(); e.redo(); expect(e.state.doc).toEqual(final)
})

test('actual coordinate property edit keeps local placement and forced native layout equal', () => {
  const { editor: e, id } = fixture(), before = e.state.doc
  const layout = vi.spyOn(Picking, 'kernelLayout')
  e.updateProperties([id], { transform: [1, 0, 0, 1, 44, 61] })
  expect(e.state.doc.nodes[id].transform).toEqual([1, 0, 0, 1, 44, 61])
  if (!baseline) expect(layout).not.toHaveBeenCalled()
  expect(e.state.doc).toEqual(Picking.kernelLayout(e.state.doc))
  e.undo(); expect(e.state.doc).toEqual(before)
})

test('actual solid-color preview keeps authored state and revision separate and commits one undo', () => {
  const { editor: e, id } = fixture(), before = e.state.doc
  e.select([id])
  const target = { kind: 'solid-fill' as const, nodeId: id, fillId: e.state.doc.nodes[id].fills[0].id, fillIndex: 0 }
  const lease = e.acquirePropertyPreview([target])!
  expect(lease).not.toBeNull()
  const count = counters()
  expect(e.previewProperty(lease, { color: '#aa3366' })).toBe('preview')
  expect(e.previewProperty(lease, { opacity: .4 })).toBe('preview')
  expect(e.authoredDocument).toBe(before); expect(e.state.version).toBe(0)
  expect(count.native).not.toHaveBeenCalled()
  if (!baseline) { expect(count.capture).not.toHaveBeenCalled(); expect(count.layout).not.toHaveBeenCalled() }
  expect(e.commitProperty(lease)).toBe('committed')
  const after = e.state.doc
  expect(after.nodes[id].fills[0]).toMatchObject({ color: '#aa3366', opacity: .4 })
  expect(count.native).toHaveBeenCalledTimes(1); expect(e.state.version).toBe(1)
  expect(after).toEqual(Picking.kernelLayout(after))
  e.undo(); expect(e.state.doc).toEqual(before); expect(e.canUndo).toBe(false)
  e.redo(); expect(e.state.doc).toEqual(after)
})

test('new auto-layout dependency invalidates local eligibility and preserves derived child placement', () => {
  const doc = Model.blank(), frame = Model.node('frame', 0, 0, 100, 100), child = Model.node('rectangle', 20, 30, 20, 20)
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc); editors.push(e)
  e.change('First local edit', d => { d.nodes[child.id].opacity = .8 })
  expect(e.change('Add flow dependency', d => { d.nodes[frame.id].layout = { ...Model.defaultLayout(), mode: 'horizontal' } }).status).toBe('committed')
  const layout = vi.spyOn(Picking, 'kernelLayout')
  e.updateProperties([child.id], { transform: [1, 0, 0, 1, 99, 88] })
  expect(layout).toHaveBeenCalled()
  expect(e.state.doc).toEqual(Picking.kernelLayout(e.state.doc))
  expect(e.state.doc.nodes[child.id].transform.slice(4)).not.toEqual([99, 88])
})

test('component source colors still propagate and instance colors remain overrides', () => {
  const { doc, ids } = componentFixture(), e = new Editor(doc); editors.push(e)
  const instance = originNode(e.state.doc, ids.a, e.state.doc.nodes[ids.label].componentKey!)
  const capture = vi.spyOn(Components, 'captureOverrides')
  e.update([instance.id], n => { n.fills[0].color = '#ff0000' })
  e.update([ids.label], n => { n.fills[0].color = '#0000ff' })
  expect(capture).toHaveBeenCalledTimes(2)
  expect(e.state.doc.nodes[instance.id].fills[0].color).toBe('#ff0000')
  expect(originNode(e.state.doc, ids.b, e.state.doc.nodes[ids.label].componentKey!).fills[0].color).toBe('#0000ff')
  expect(e.state.doc).toEqual(Picking.kernelLayout(e.state.doc))
})

test.each(['opacity', 'color', 'topology'] as const)('invalid %s edit keeps document, revision and history atomic', field => {
  const { editor: e, id } = fixture(false), before = e.state.doc
  const native = vi.spyOn(Graph.prototype, 'applyOps')
  const result = e.change('Invalid', d => {
    if (field === 'opacity') d.nodes[id].opacity = NaN
    if (field === 'color') d.nodes[id].fills[0].color = 'not-a-color'
    if (field === 'topology') d.nodes[id].children.push(id)
  })
  expect(result.status).toBe('rejected'); expect(e.state.doc).toBe(before)
  expect(e.state.version).toBe(0); expect(e.canUndo).toBe(false); expect(native).not.toHaveBeenCalled()
})

test('native admission failure never publishes or advances local proof/history state', () => {
  const { editor: e, id } = fixture(false), before = e.state.doc
  const native = vi.spyOn(Graph.prototype, 'applyOps').mockImplementationOnce(() => { throw Error('Injected native admission failure') })
  expect(e.change('Rejected native edit', d => { d.nodes[id].opacity = .4 }).status).toBe('rejected')
  expect(e.state.doc).toBe(before); expect(e.state.version).toBe(0); expect(e.canUndo).toBe(false)
  expect(e.change('Retry new edit', d => { d.nodes[id].opacity = .6 }).status).toBe('committed')
  expect(native).toHaveBeenCalledTimes(2); expect(e.state.version).toBe(1)
  e.undo(); expect(e.state.doc).toEqual(before)
})
