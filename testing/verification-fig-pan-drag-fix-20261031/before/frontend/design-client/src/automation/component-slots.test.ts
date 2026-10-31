import { afterEach, expect, test } from 'vitest'
import { Editor } from '../engine'
import { blank, node, defaultLayout, type DesignDocument } from '../model'
import { createEditorDesignAutomation } from './index'
import { encodeDocumentBinary, decodeDocumentBinary } from '../kernel/binfmt'
import { createMain, insertInstance, cloneTree } from '../components'
import { declareSlot } from '../component-slots'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function fixture() {
  const d = blank(), main = node('frame'), host = node('frame'), fallback = node('rectangle'), content = node('frame'), child = node('text')
  main.children = [host.id]; host.children = [fallback.id]; content.children = [child.id]; child.text = 'Owned arbitrary content'
  for (const n of [main, host, fallback, content, child]) d.nodes[n.id] = n
  d.pages[0].children = [main.id, content.id]
  createMain(d, [main.id], d.pages[0].id); declareSlot(d, host.id, 'Body', 'body'); d.schemaVersion = 15
  const instanceId = insertInstance(d, main.id, d.pages[0].id, { x: 300, y: 0 })
  const e = new Editor(d); editors.push(e)
  const api = createEditorDesignAutomation(e)
  const call = (method: string, params: Record<string, unknown>) => api.execute({ method, params, documentId: e.state.doc.id, session: e.sessionGeneration, expectedRevision: e.state.version })
  return { e, api, call, main, host, fallback, content, child, instanceId }
}
test('real Editor atomic assignment, content edit, undo and FD reopen', () => {
  const { e, call, instanceId, content, child, host } = fixture(), before = e.state.doc
  const response = call('batch.apply', { operations: [
    { method: 'component.assignSlot', params: { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] } },
    { method: 'node.update', params: { ids: [child.id], patch: { text: 'Instance-owned text' } } },
  ] })
  expect(response.ok, JSON.stringify(response)).toBe(true)
  const after = e.state.doc
  expect(after.nodes[instanceId].instance!.slotContents).toEqual({ body: [content.id] })
  expect(after.nodes[child.id].text).toBe('Instance-owned text')
  e.undo(); expect(e.state.doc).toBe(before); e.redo()
  const reopened = new Editor(decodeDocumentBinary(encodeDocumentBinary(after)) as DesignDocument); editors.push(reopened)
  expect(reopened.state.doc.nodes[content.id]).toEqual(after.nodes[content.id])
  expect(reopened.state.doc.nodes[child.id].text).toBe('Instance-owned text')
  reopened.update([host.id], { width: 222 }); expect(reopened.state.doc.nodes[child.id].text).toBe('Instance-owned text')
})
test('real Editor invalid batch is atomic and fences and permission policy reject writes', () => {
  const { e, api, call, instanceId, content } = fixture(), before = e.state.doc
  const result = call('batch.apply', { operations: [
    { method: 'node.update', params: { ids: [content.id], patch: { name: 'Should roll back' } } },
    { method: 'component.assignSlot', params: { nodeId: instanceId, slotId: 'body', nodeIds: ['missing'] } },
  ] })
  expect(result.ok).toBe(false); expect(e.state.doc).toBe(before); expect(e.canUndo).toBe(false)
  expect(api.execute({ method: 'component.assignSlot', params: { nodeId: instanceId, slotId: 'body', nodeIds: [] } }).ok).toBe(false)
  const denied = createEditorDesignAutomation(e, { grants: [] })
  expect(denied.execute({ method: 'component.assignSlot', params: { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }, documentId: e.state.doc.id, session: e.sessionGeneration, expectedRevision: e.state.version }).ok).toBe(false)
  expect(e.state.doc).toBe(before)
})
test('source deletion detaches preserving custom content, reset retains displaced content', () => {
  const { e, call, main, instanceId, content, child } = fixture()
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }).ok).toBe(true)
  const assigned = e.state.doc
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: null }).ok).toBe(true)
  expect(e.state.doc.pages[0].children).toContain(content.id)
  e.undo(); expect(e.state.doc).toBe(assigned)
  expect(call('node.delete', { ids: [main.id] }).ok).toBe(true)
  expect(e.state.doc.nodes[instanceId].instance).toBeUndefined()
  expect(e.state.doc.nodes[child.id].text).toBe('Owned arbitrary content')
})

test('variant name migration keeps owned IDs and allows structural child editing', () => {
  const { e, call, main, instanceId, content, child } = fixture()
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }).ok).toBe(true)
  let variant = ''
  e.change('Add alternate component', d => {
    variant = cloneTree(d, main.id); d.pages[0].children.push(variant)
    const hostId = d.nodes[variant].children[0]
    d.nodes[hostId].componentKey = 'alternate-host'
    d.nodes[variant].component!.slots = { alternate: { name: 'Body', targetKey: 'alternate-host' } }
  })
  expect(call('component.swap', { nodeId: instanceId, componentId: variant }).ok).toBe(true)
  expect(e.state.doc.nodes[instanceId].instance!.slotContents).toEqual({ alternate: [content.id] })
  expect(e.state.doc.nodes[child.id].text).toBe('Owned arbitrary content')
  const leaf = '12345678-1234-4234-8234-123456789012'
  expect(call('node.create', { id: leaf, kind: 'rectangle', parentId: content.id }).ok).toBe(true)
  expect(e.state.doc.nodes[content.id].children).toContain(leaf)
  const before = e.state.doc
  expect(call('component.removeSlot', { componentId: variant, slotId: 'alternate' }).ok).toBe(false)
  expect(e.state.doc).toBe(before)
  { const result = call('node.delete', { ids: [content.id] }); expect(result.ok, JSON.stringify(result)).toBe(true) }
  expect(e.state.doc.nodes[instanceId].instance!.slotContents).toEqual({ alternate: [] })
})
test('locked subtree and foreign slot content are rejected atomically', () => {
  const { e, call, main, instanceId, content, child } = fixture()
  e.update([child.id], { locked: true }); const locked = e.state.doc
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }).ok).toBe(false)
  expect(e.state.doc).toBe(locked)
  e.change('Unlock content', d => { d.nodes[child.id].locked = false })
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }).ok).toBe(true)
  const second = e.insertComponent(main.id), before = e.state.doc
  expect(call('component.assignSlot', { nodeId: second, slotId: 'body', nodeIds: [content.id] }).ok).toBe(false)
  expect(e.state.doc).toBe(before)
})

test('slot contents participate in the same auto-layout and retain IDs after source changes', () => {
  const { e, call, instanceId, content, host } = fixture()
  e.update([host.id], { layout: { ...defaultLayout(), mode: 'vertical', padding: [11, 12, 13, 14] } })
  expect(call('component.assignSlot', { nodeId: instanceId, slotId: 'body', nodeIds: [content.id] }).ok).toBe(true)
  expect(e.state.doc.nodes[content.id].transform.slice(4)).toEqual([14, 11])
  e.update([host.id], { layout: { ...defaultLayout(), mode: 'vertical', padding: [21, 22, 23, 24] } })
  expect(e.state.doc.nodes[content.id].transform.slice(4)).toEqual([24, 21])
  expect(e.state.doc.nodes[instanceId].instance!.slotContents!.body).toEqual([content.id])
})
