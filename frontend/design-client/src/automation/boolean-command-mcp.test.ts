import { mkdirSync, writeFileSync } from 'node:fs'
import { afterEach, expect, test } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node, paint } from '../model'
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
  const transcript: Json[] = []
  const pending = new Map<number, (message: Json) => void>()
  output.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, newline)) as Json
      transcript.push({ direction: 'response', message: response })
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
    const message = { jsonrpc: '2.0', id: requestId, method, ...(params ? { params } : {}) }; transcript.push({ direction: 'request', message })
    input.write(JSON.stringify(message) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'real-editor-e2e', version: '1' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools as { name: string; inputSchema: Json }[]
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
  return { editor, api, rpc, call, read, mutate, tools, materialize, transcript }
}

function documentFixture() {
  const doc = blank(), a = node('ellipse', 0, 0, 100, 100), b = node('ellipse', 40, 0, 100, 100)
  a.fills = [paint('#ffcc00')]; b.fills = [paint('#112244')]
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  return { doc, a, b }
}
test.each(['union', 'subtract', 'intersect', 'exclude'])('NDJSON %s creates actual live native geometry, retains operands and replays one receipt', async operation => {
  const d = documentFixture(), f = await fixture(d.doc), before = f.editor.state.doc
  expect(f.tools.map(t => t.name)).toContain('design_vector_boolean_create')
  const initial = await f.read('document.get'), fences = { documentId: initial.documentId, session: initial.session, expectedRevision: initial.revision }
  const params = { mutationId: `boolean-${operation}`, operations: [{ method: 'vector.boolean.create', params: { ids: [d.b.id, d.a.id], operation, id: '30000000-0000-4000-8000-000000000001' } }] }
  const created = await f.call('batch.apply', params, fences)
  expect(created.isError, JSON.stringify(created)).toBe(false)
  const after = f.editor.state.doc, result = after.nodes['30000000-0000-4000-8000-000000000001']
  expect(result.booleanOperation).toBe(operation); expect(result.children).toEqual([d.a.id, d.b.id])
  expect(result.network!.edges.length).toBeGreaterThan(0); expect(result.network!.edges.some(e => e.c1)).toBe(true)
  expect(result.fills).toEqual((operation === 'subtract' ? before.nodes[d.a.id].fills : before.nodes[d.b.id].fills).map(p => ({ ...p, image: p.image ?? null })))
  expect(after.nodes[d.a.id].kind).toBe('ellipse'); expect(after.nodes[d.b.id].kind).toBe('ellipse')
  for (const id of ['30000000-0000-4000-8000-000000000001', d.a.id, d.b.id]) await f.read('node.get', { id })
  const replay = await f.call('batch.apply', params, fences)
  expect(replay.isError).toBe(false); expect(f.editor.state.doc).toBe(after); expect(f.editor.state.version).toBe(1)
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
  expect((await f.mutate('history.redo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(after)
})
test('NDJSON moon changes with editable upper operand, hides it and ungroups without baked replacement', async () => {
  const d = documentFixture(), f = await fixture(d.doc), original = f.editor.state.doc
  expect((await f.mutate('vector.boolean.create', { ids: [d.b.id, d.a.id], operation: 'subtract', id: '30000000-0000-4000-8000-000000000002' })).isError).toBe(false)
  const moon = f.editor.state.doc, originalNetwork = JSON.stringify(moon.nodes['30000000-0000-4000-8000-000000000002'].network)
  expect((await f.mutate('node.update', { ids: [d.b.id], patch: { transform: [1, 0, 0, 1, 60, 0] } })).isError).toBe(false)
  expect(JSON.stringify(f.editor.state.doc.nodes['30000000-0000-4000-8000-000000000002'].network)).not.toBe(originalNetwork)
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(moon)
  expect((await f.mutate('node.update', { ids: [d.b.id], patch: { visible: false } })).isError).toBe(false)
  expect(JSON.stringify(f.editor.state.doc.nodes['30000000-0000-4000-8000-000000000002'].network)).not.toBe(originalNetwork)
  expect((await f.mutate('history.undo')).isError).toBe(false)
  expect((await f.mutate('node.ungroup', { ids: ['30000000-0000-4000-8000-000000000002'] })).isError).toBe(false)
  expect(f.editor.state.doc.nodes['30000000-0000-4000-8000-000000000002']).toBeUndefined(); expect(f.editor.state.doc.pages[0].children).toEqual([d.a.id, d.b.id])
  expect(f.editor.state.doc.nodes[d.a.id].fills).toEqual(original.nodes[d.a.id].fills); expect(f.editor.state.doc.nodes[d.b.id].fills).toEqual(original.nodes[d.b.id].fills)
})
test('NDJSON nested live boolean accepts normalized geometry but dirty batch rejects atomically', async () => {
  const d = documentFixture(), c = node('ellipse', 80, 0, 100, 100); d.doc.nodes[c.id] = c; d.doc.pages[0].children.push(c.id)
  const f = await fixture(d.doc)
  expect((await f.mutate('vector.boolean.create', { ids: [d.a.id, d.b.id], operation: 'union', id: '30000000-0000-4000-8000-000000000003' })).isError).toBe(false)
  const before = f.editor.state.doc
  const dirty = await f.mutate('batch.apply', { operations: [
    { method: 'node.update', params: { ids: [d.a.id], patch: { width: 120 } } },
    { method: 'vector.boolean.create', params: { ids: ['30000000-0000-4000-8000-000000000003', c.id], operation: 'subtract', id: '30000000-0000-4000-8000-000000000004' } },
  ] })
  expect(dirty.structuredContent).toMatchObject({ ok: false, error: { code: 'unsupported_derived_batch_geometry' } }); expect(f.editor.state.doc).toBe(before)
  expect((await f.mutate('vector.boolean.create', { ids: ['30000000-0000-4000-8000-000000000003', c.id], operation: 'subtract', id: '30000000-0000-4000-8000-000000000004' })).isError).toBe(false)
  expect(f.editor.state.doc.nodes['30000000-0000-4000-8000-000000000004'].children).toEqual(['30000000-0000-4000-8000-000000000003', c.id]); expect(f.editor.state.doc.nodes['30000000-0000-4000-8000-000000000003'].children).toEqual([d.a.id, d.b.id])
})
test('NDJSON locked, unsupported, stale and read-only inputs never mutate', async () => {
  const d = documentFixture(); d.a.locked = true
  const f = await fixture(d.doc), before = f.editor.state.doc
  const denied = await f.mutate('vector.boolean.create', { ids: [d.a.id, d.b.id], operation: 'subtract' })
  expect(denied.structuredContent).toMatchObject({ ok: false, error: { code: 'locked_node' } }); expect(f.editor.state.doc).toBe(before)
  const ro = await fixture(documentFixture().doc, 'read')
  expect(ro.tools.map(t => t.name)).not.toContain('design_vector_boolean_create')
  const blocked = await ro.rpc('tools/call', { name: 'design_vector_boolean_create', arguments: { params: { ids: [d.a.id, d.b.id], operation: 'union' } } })
  expect(!!blocked.error || blocked.result?.isError === true).toBe(true); expect(ro.editor.canUndo).toBe(false)
  const u = documentFixture(); u.a.kind = 'text'; const unsupported = await fixture(u.doc), ub = unsupported.editor.state.doc
  expect((await unsupported.mutate('vector.boolean.create', { ids: [u.a.id, u.b.id], operation: 'union' })).structuredContent).toMatchObject({ ok: false, error: { code: 'unsupported_boolean_operand' } })
  expect(unsupported.editor.state.doc).toBe(ub)
  const s = documentFixture(), stale = await fixture(s.doc), read = await stale.read('document.get')
  expect((await stale.mutate('node.update', { ids: [s.a.id], patch: { width: 90 } })).isError).toBe(false)
  const current = stale.editor.state.doc
  const rejected = await stale.call('vector.boolean.create', { ids: [s.a.id, s.b.id], operation: 'union' }, { documentId: read.documentId, session: read.session, expectedRevision: read.revision })
  expect(rejected.isError).toBe(true); expect(stale.editor.state.doc).toBe(current)
})


test('public MCP creates both moon circles, live subtract, exact undo/redo and native/SVG artifacts', async () => {
  const f = await fixture(), a = '40000000-0000-4000-8000-000000000001', b = '40000000-0000-4000-8000-000000000002', moon = '40000000-0000-4000-8000-000000000003'
  for (const [id, x, y] of [[a, 136, 136], [b, 206, 116]] as const) {
    const result = await f.mutate('node.create', { id, kind: 'ellipse', x, y, width: 240, height: 240 })
    expect(result.isError, JSON.stringify(result)).toBe(false)
  }
  const before = f.editor.state.doc
  const result = await f.mutate('vector.boolean.create', { ids: [b, a], operation: 'subtract', id: moon, name: 'Live editable moon' })
  expect(result.isError, JSON.stringify(result)).toBe(false)
  const after = f.editor.state.doc, n = after.nodes[moon]
  expect(n.kind).toBe('vector'); expect(n.booleanOperation).toBe('subtract'); expect(n.children).toEqual([a, b])
  expect(n.network!.edges.length).toBeGreaterThan(0); expect(n.network!.edges.some(e => !!e.c1)).toBe(true)
  expect(after.nodes[a].kind).toBe('ellipse'); expect(after.nodes[b].kind).toBe('ellipse')
  expect(n.fills).toEqual(before.nodes[a].fills.map(p => ({ ...p, image: p.image ?? null })))
  expect((await f.mutate('history.undo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
  expect((await f.mutate('history.redo')).isError).toBe(false); expect(f.editor.state.doc).toEqual(after)
  const native = await f.read('document.export', { format: 'native-json' }), svg = await f.read('vector.export', { nodeIds: [moon] })
  expect(typeof svg.result.content).toBe('string'); expect(svg.result.content).toContain('<path')
  const reopened = new Editor(JSON.parse(native.result.content))
  try { expect(reopened.state.doc.nodes[moon].children).toEqual([a, b]); expect(reopened.state.doc.nodes[moon].booleanOperation).toBe('subtract'); expect(reopened.state.doc.nodes[moon].network).toEqual(n.network) } finally { reopened.dispose() }
  const dir = process.env.BOOLEAN_EVIDENCE_DIR
  if (dir) { mkdirSync(dir, { recursive: true }); writeFileSync(`${dir}/moon-live.design.json`, native.result.content); writeFileSync(`${dir}/moon-live.svg`, svg.result.content); writeFileSync(`${dir}/moon-live.rpc.ndjson`, f.transcript.map(r => JSON.stringify(r)).join('\n') + '\n') }
})


test('boolean names disclose and preserve the independent 200 UTF-16 authored limit', async () => {
  const d = documentFixture(), f = await fixture(d.doc), before = f.editor.state.doc
  const descriptor = f.tools.find(t => t.name === 'design_vector_boolean_create')!
  expect(descriptor.inputSchema.properties.params.properties.name.description).toContain('200 UTF-16')
  const version = f.editor.state.version
  for (const count of [101, 200]) {
    const response = await f.mutate('vector.boolean.create', { ids: [d.a.id, d.b.id], operation: 'union', name: '😀'.repeat(count) })
    expect(response.isError).toBe(true)
    expect(f.editor.state.doc).toBe(before)
    expect(f.editor.state.version).toBe(version)
    expect(f.editor.canUndo).toBe(false)
  }
  const id = '30000000-0000-4000-8000-000000000099', name = '😀'.repeat(100)
  expect((await f.mutate('vector.boolean.create', { ids: [d.a.id, d.b.id], operation: 'union', id, name })).isError).toBe(false)
  const accepted = f.editor.state.doc
  expect(accepted.nodes[id].name).toBe(name)
  expect((await f.mutate('history.undo')).isError).toBe(false)
  expect(f.editor.state.doc).toEqual(before)
  expect(f.editor.canUndo).toBe(false)
  expect((await f.mutate('history.redo')).isError).toBe(false)
  expect(f.editor.state.doc).toEqual(accepted)
})
