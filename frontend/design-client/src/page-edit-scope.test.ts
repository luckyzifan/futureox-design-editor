import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, defaultLayout, defaultSizing, node, uid } from './model'
import { emptySystem } from './design-system'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { kernelLayout } from './kernel/picking'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.restoreAllMocks() })

function assetFile() {
  const doc = blank('素材')
  doc.schemaVersion = 16
  doc.designSystem = emptySystem()
  const assets = { id: uid(), name: '素材', children: [] as string[], background: '#ffffff' }
  const coldIds: string[] = []
  for (let index = 0; index < 24; index++) {
    const item = node('frame', index * 12, 0, 10, 10)
    item.component = { variants: {}, properties: {} }
    doc.nodes[item.id] = item
    assets.children.push(item.id)
    coldIds.push(item.id)
  }
  const wire = node('vector', 0, 40, 30, 4)
  wire.connector = {
    from: { point: { x: 0, y: 0 }, nodeId: coldIds[0], anchor: { x: 0, y: 0 } },
    to: { point: { x: 12, y: 0 }, nodeId: coldIds[1], anchor: { x: 1, y: 1 } },
    style: 'straight',
  }
  doc.nodes[wire.id] = wire
  assets.children.push(wire.id)
  coldIds.push(wire.id)
  const text = node('text', 16, 24, 80, 24)
  text.text = 'Hello'
  text.fontSize = 16
  const frame = node('frame', 0, 120, 200, 80)
  frame.layout = { ...defaultLayout(), mode: 'vertical' }
  const child = node('rectangle', 0, 0, 40, 20)
  child.sizing = { ...defaultSizing(), width: 'fill' }
  frame.children = [child.id]
  doc.nodes[text.id] = text
  doc.nodes[frame.id] = frame
  doc.nodes[child.id] = child
  doc.pages[0].children = [text.id, frame.id]
  doc.pages.push(assets)
  return { doc, text, frame, child, coldIds }
}

test('editing one page does not resolve, stringify, or replace cold asset pages', () => {
  const { doc, text, coldIds } = assetFile()
  const editor = new Editor(doc)
  editors.push(editor)
  editor.warmEditingHistory(editor.state.doc, editor.sessionGeneration)
  const before = editor.state.doc
  const full = vi.spyOn(VectorEngine.prototype, 'resolve_components_full')
  const patch = vi.spyOn(VectorEngine.prototype, 'resolve_components_patch')
  const layout = vi.spyOn(VectorEngine.prototype, 'resolve_layout')
  const stringify = vi.spyOn(JSON, 'stringify')
  const edited = editor.change('改文字', d => { d.nodes[text.id].text = 'Next' })
  expect(edited.status).toBe('committed')
  expect(editor.state.doc.nodes[text.id].text).toBe('Next')
  for (const id of coldIds) expect(editor.state.doc.nodes[id]).toBe(before.nodes[id])
  expect(editor.state.doc.pages[1]).toBe(before.pages[1])
  expect(full).not.toHaveBeenCalled()
  expect(patch).not.toHaveBeenCalled()
  expect(layout).not.toHaveBeenCalled()
  expect(stringify.mock.calls.some(([value]) => value && typeof value === 'object' &&
    (value === before || value === editor.state.doc || coldIds.every(id => (value as { nodes?: Record<string, unknown> }).nodes?.[id])))).toBe(false)
  editor.undo()
  expect(editor.state.doc.nodes[text.id].text).toBe('Hello')
  for (const id of coldIds) expect(editor.state.doc.nodes[id]).toBe(before.nodes[id])
  const rejected = editor.change('坏透明度', d => { d.nodes[text.id].opacity = Number.NaN })
  expect(rejected.status).toBe('rejected')
  expect(editor.state.doc.nodes[text.id].text).toBe('Hello')
})

test('auto-layout on the current page resolves that island and keeps other pages identical', () => {
  const { doc, frame, child, coldIds } = assetFile()
  const editor = new Editor(doc)
  editors.push(editor)
  const before = editor.state.doc
  const frameId = before.pages[0].children.find(id => before.nodes[id].layout) ?? frame.id
  const childId = before.nodes[frameId].children[0] ?? child.id
  const candidate = {
    ...before,
    nodes: { ...before.nodes, [frameId]: { ...before.nodes[frameId], width: 260 } },
  }
  const full = vi.spyOn(VectorEngine.prototype, 'resolve_components_full')
  const patch = vi.spyOn(VectorEngine.prototype, 'resolve_components_patch')
  const layout = vi.spyOn(VectorEngine.prototype, 'resolve_layout')
  const fast = kernelLayout(candidate, before)
  expect(full).not.toHaveBeenCalled()
  expect(patch).not.toHaveBeenCalled()
  expect(layout).toHaveBeenCalled()
  const payload = JSON.parse(String(layout.mock.calls[0][0]))
  for (const id of coldIds) {
    expect(payload.nodes[id]).toBeUndefined()
    expect(fast.nodes[id]).toBe(before.nodes[id])
  }
  expect(fast.designSystem).toBe(before.designSystem)
  const oracle = kernelLayout(candidate)
  expect(fast.nodes[frameId].width).toBe(oracle.nodes[frameId].width)
  expect(fast.nodes[childId]).toEqual(oracle.nodes[childId])
})
