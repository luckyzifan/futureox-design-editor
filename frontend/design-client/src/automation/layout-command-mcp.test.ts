import { afterEach, expect, test } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationResponse } from './types'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
type Json = Record<string, any>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function fixture(document = blank('MCP live document'), scope: 'read' | 'write' = 'write') {
  const editor = new Editor(document)
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request), scope })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', id = 0
  const pending = new Map<number, (message: Json) => void>()
  output.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, newline)) as Json
      buffer = buffer.slice(newline + 1)
      const resolve = pending.get(response.id)
      pending.delete(response.id)
      if (resolve) resolve(response)
    }
  })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() })
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP request ${requestId} timed out`)) }, 20000)
    server.done.then(() => { if (pending.delete(requestId)) { clearTimeout(timer); reject(new Error('MCP connection closed before response')) } })
    pending.set(requestId, response => { clearTimeout(timer); resolve(response) })
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'real-editor-e2e', version: '1' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools as { name: string }[]
  const toolName = (method: string) => `design_${method.replaceAll('.', '_')}`
  const call = async (method: string, params: Json = {}, fences: Json = {}) => {
    expect(tools.some(tool => tool.name === toolName(method))).toBe(true)
    const response = await rpc('tools/call', { name: toolName(method), arguments: { params, ...fences } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    return response.result as Json
  }
  // Explicit file-saving client behavior; model-facing tools/call remains metadata-only.
  const materialize = async (value: Json) => {
    const result = { ...value.result }
    for (const ref of result.resources ?? []) {
      const response = await rpc('resources/read', { uri: ref.uri })
      expect(response.error).toBeUndefined()
      const content = response.result.contents[0]
      const data = ref.encoding === 'json' ? JSON.parse(content.text) : ref.encoding === 'base64' ? content.blob : ref.encoding === 'data-url' ? `data:${ref.mimeType};base64,${content.blob}` : content.text
      if (ref.field === '$metadata') Object.assign(result, data)
      else result[ref.field] = data
    }
    return { ...value, result } as AutomationResponse & { result: Json }
  }
  const read = async (method: string, params: Json = {}) => {
    const response = await call(method, params)
    expect(response.isError, response.structuredContent.ok ? undefined : JSON.stringify(response.structuredContent.error)).toBe(false)
    return materialize(response.structuredContent)
  }
  const mutate = async (method: string, params: Json = {}) => {
    const state = await read('document.get')
    return call(method, params, { documentId: state.documentId, session: state.session, expectedRevision: state.revision })
  }
  return { editor, api, rpc, call, read, mutate, tools, materialize }
}

function documentFixture() {
  const doc = blank(), a = node('rectangle', 90, 100, 30, 20), b = node('rectangle', 10, 20, 40, 20)
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  return { doc, a, b }
}
test('real NDJSON MCP discovers add/remove, reflows, reads back, undoes/redoes and replays exact receipt', async () => {
  const d = documentFixture(), f = await fixture(d.doc), before = f.editor.state.doc
  expect(f.tools.map(t => t.name)).toContain('design_layout_add')
  expect(f.tools.map(t => t.name)).toContain('design_layout_remove')
  const initial = await f.read('document.get')
  const fences = { documentId: initial.documentId, session: initial.session, expectedRevision: initial.revision }
  const add = await f.call('batch.apply', { mutationId: 'layout-add-once', operations: [{ method: 'layout.add', params: { ids: [d.a.id, d.b.id], mode: 'horizontal', gap: 9, padding: { top: 4, right: 4, bottom: 4, left: 4 } } }] }, fences)
  expect(add.isError, JSON.stringify(add)).toBe(false)
  const after = f.editor.state.doc, wrapper = after.nodes[after.pages[0].children[0]]
  expect(wrapper.children).toEqual([d.b.id, d.a.id]); expect(after.nodes[d.b.id].transform[4]).toBe(4)
  for (const id of [wrapper.id, d.a.id, d.b.id]) await f.read('node.get', { id })
  const replay = await f.call('batch.apply', { mutationId: 'layout-add-once', operations: [{ method: 'layout.add', params: { ids: [d.a.id, d.b.id], mode: 'horizontal', gap: 9, padding: { top: 4, right: 4, bottom: 4, left: 4 } } }] }, fences)
  expect(replay.isError).toBe(false); expect(f.editor.state.doc).toBe(after)
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
  expect((await f.mutate('history.redo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(after)
  const geometry = wrapper.children.map(id => { const n = after.nodes[id]; return [n.transform, n.width, n.height] })
  expect((await f.mutate('layout.remove', { ids: [wrapper.id] })).isError).toBe(false)
  expect(f.editor.state.doc.nodes[wrapper.id].layout).toBeUndefined()
  expect(wrapper.children.map(id => { const n = f.editor.state.doc.nodes[id]; return [n.transform, n.width, n.height] })).toEqual(geometry)
})
test('real NDJSON rejects locked mixed selection and dirty batch atomically; retry remains available', async () => {
  const d = documentFixture(); d.a.locked = true
  const f = await fixture(d.doc), before = f.editor.state.doc
  const denied = await f.mutate('layout.add', { ids: [d.a.id, d.b.id], mode: 'horizontal' })
  expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'locked_node' } })
  expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  const dirty = await f.mutate('batch.apply', { operations: [{ method: 'node.update', params: { ids: [d.b.id], patch: { width: 100 } } }, { method: 'layout.add', params: { ids: [d.b.id], mode: 'vertical' } }] })
  expect(dirty.structuredContent).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } })
  expect(f.editor.state.doc).toBe(before)
})
test('read-only NDJSON hides add/remove and direct calls cannot bypass scope', async () => {
  const d = documentFixture(), f = await fixture(d.doc, 'read'), before = f.editor.state.doc
  expect(f.tools.map(t => t.name)).not.toContain('design_layout_add')
  expect(f.tools.map(t => t.name)).not.toContain('design_layout_remove')
  const denied = await f.rpc('tools/call', { name: 'design_layout_add', arguments: { params: { ids: [d.a.id], mode: 'horizontal' } } })
  expect(!!denied.error || denied.result?.isError === true).toBe(true)
  expect(f.editor.state.doc).toBe(before)
})
test.each(['target', 'ancestor', 'child'] as const)('real NDJSON in-place add/remove retain authored locked %s with native undo/redo', async lock => {
  const doc = blank(), outer = node('frame', 0, 0, 800, 600), frame = node('frame', 20, 30, 400, 200), child = node('rectangle', 30, 40, 30, 20)
  outer.children = [frame.id]; frame.children = [child.id]; doc.pages[0].children = [outer.id]
  for (const n of [outer, frame, child]) doc.nodes[n.id] = n
  doc.nodes[lock === 'target' ? frame.id : lock === 'ancestor' ? outer.id : child.id].locked = true
  const f = await fixture(doc), before = f.editor.state.doc
  const added = await f.mutate('layout.add', { ids: [frame.id], mode: 'horizontal' })
  expect(added.isError, JSON.stringify(added)).toBe(false)
  const active = f.editor.state.doc, n = active.nodes[child.id], geometry = [n.transform, n.width, n.height]
  expect(active.nodes[frame.id].layout?.mode).toBe('horizontal')
  expect((await f.mutate('layout.remove', { ids: [frame.id] })).isError).toBe(false)
  const removed = f.editor.state.doc.nodes[child.id]
  expect([removed.transform, removed.width, removed.height]).toEqual(geometry)
  for (const id of [outer.id, frame.id, child.id]) expect(f.editor.state.doc.nodes[id].locked).toBe(before.nodes[id].locked)
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(active)
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
  expect((await f.mutate('history.redo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(active)
})
