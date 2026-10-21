import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
import { createDesignAutomation } from './core'
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
  const tools = (await rpc('tools/list')).result.tools as Json[]
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
function success(result: Json) {
  expect(result.isError, JSON.stringify(result.structuredContent?.error)).toBe(false)
  expect(result.structuredContent.ok).toBe(true)
  return result.structuredContent
}
function rejected(result: Json) {
  expect(result.isError).toBe(true)
  expect(result.structuredContent.ok).toBe(false)
}
function populated() {
  const document = blank('Schema contract'), rectangle = node('rectangle', 10, 20, 30, 40)
  document.nodes[rectangle.id] = rectangle
  document.pages[0].children.push(rectangle.id)
  return { document, rectangle }
}
const fences = (f: Awaited<ReturnType<typeof fixture>>) => ({ documentId: f.editor.state.doc.id, session: f.editor.sessionGeneration, expectedRevision: f.editor.state.version })

it('actual NDJSON node.find uses code points, with ASCII and astral boundaries', async () => {
  const f = await fixture(), before = f.editor.state.doc, revision = f.editor.state.version
  const catalog = f.tools.find(t => t.name === 'design_node_find')!
  expect(catalog.inputSchema.properties.params.properties.name.maxLength).toBe(200)
  for (const name of ['😀'.repeat(200), 'a'.repeat(200), '😀'.repeat(100) + 'a'.repeat(100)]) success(await f.call('node.find', { name }))
  for (const name of ['😀'.repeat(201), 'a'.repeat(201)]) rejected(await f.call('node.find', { name }))
  expect(f.editor.state.doc).toBe(before)
  expect(f.editor.state.version).toBe(revision)
  await f.read('document.get')
})
it('document.rename retains its independent native UTF-16 authored limit', async () => {
  const f = await fixture(), descriptor = f.tools.find(t => t.name === 'design_document_rename')!
  expect(descriptor.inputSchema.properties.params.properties.name.description).toContain('200 UTF-16')
  success(await f.mutate('document.rename', { name: '😀'.repeat(100) }))
  const before = f.editor.state.doc, revision = f.editor.state.version, undo = f.editor.canUndo
  for (const name of ['😀'.repeat(101), '😀'.repeat(200), '😀'.repeat(201), 'a'.repeat(201)]) rejected(await f.mutate('document.rename', { name }))
  expect(f.editor.state.doc).toBe(before)
  expect(f.editor.state.version).toBe(revision)
  expect(f.editor.canUndo).toBe(undo)
  success(await f.mutate('document.rename', { name: 'a'.repeat(200) }))
})
it('real catalog requires params exactly when empty params cannot satisfy the registry schema', async () => {
  const { document, rectangle } = populated(), f = await fixture(document)
  for (const name of ['design_node_get', 'design_clipboard_export', 'design_clipboard_paste']) expect(f.tools.find(t => t.name === name)!.inputSchema.required).toContain('params')
  for (const name of ['design_document_get', 'design_page_list']) {
    expect(f.tools.find(t => t.name === name)!.inputSchema.required).not.toContain('params')
    const response = await f.rpc('tools/call', { name, arguments: {} })
    expect(response.error).toBeUndefined(); success(response.result)
  }
  const omitted = await f.rpc('tools/call', { name: 'design_node_get', arguments: {} })
  expect(omitted.error).toBeUndefined(); rejected(omitted.result)
  rejected(await f.call('node.get', {}))
  rejected(await f.call('node.get', { id: rectangle.id, extra: true }))
  success(await f.call('node.get', { id: rectangle.id }))
})
it('clipboard actual anyOf branches retain required/additionalProperties and separate fences', async () => {
  const { document, rectangle } = populated(), f = await fixture(document), guard = fences(f)
  const descriptor = f.tools.find(t => t.name === 'design_clipboard_export')!
  expect(descriptor.inputSchema.required).toEqual(['documentId', 'session', 'expectedRevision', 'params'])
  expect(descriptor.inputSchema.properties.params.anyOf).toHaveLength(2)
  const exported = success(await f.call('clipboard.export', { nodeIds: [rectangle.id], kind: 'nodes' }, guard))
  const packet = (await f.materialize(exported)).result.content as string
  expect(typeof packet).toBe('string')
  success(await f.call('clipboard.export', { nodeIds: [rectangle.id], kind: 'properties' }, guard))
  for (const params of [
    { nodeIds: [rectangle.id], kind: 'wrong' }, { nodeIds: [], kind: 'nodes' },
    { nodeIds: [rectangle.id, rectangle.id], kind: 'nodes' },
    { nodeIds: Array(65).fill(rectangle.id), kind: 'nodes' },
    { nodeIds: [rectangle.id, rectangle.id], kind: 'properties' },
    { nodeIds: [rectangle.id], kind: 'nodes', propertyKind: 'all' },
  ]) rejected(await f.call('clipboard.export', params, guard))
  const before = f.editor.state.doc, revision = f.editor.state.version
  for (const params of [
    { packet, pageId: document.pages[0].id, mode: 'here' },
    { packet, pageId: document.pages[0].id, mode: 'inPlace', position: { x: 0, y: 0 } },
    { packet, pageId: document.pages[0].id, mode: 'here', position: { x: 0, y: 0, extra: true } },
  ]) rejected(await f.call('clipboard.paste', params, guard))
  expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(revision)
  success(await f.mutate('clipboard.paste', { packet, pageId: document.pages[0].id, mode: 'inPlace' }))
  success(await f.mutate('clipboard.paste', { packet, pageId: document.pages[0].id, mode: 'here', position: { x: 100, y: 100 } }))
  await f.read('document.get')
})
it('published safe integer fences, missing fences, and mutationId failures remain atomic', async () => {
  const f = await fixture(), guard = fences(f), before = f.editor.state.doc, revision = f.editor.state.version
  const descriptor = f.tools.find(t => t.name === 'design_batch_apply')!
  expect(descriptor.inputSchema.properties.params.properties.mutationId.pattern).toBe('^[A-Za-z0-9_-]{1,128}$')
  const operations = [{ method: 'document.rename', params: { name: 'Receipted' } }]
  for (const key of ['session', 'expectedRevision']) {
    expect(descriptor.inputSchema.properties[key].maximum).toBe(Number.MAX_SAFE_INTEGER)
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) rejected(await f.call('document.get', {}, { [key]: value }))
  }
  for (const key of ['documentId', 'session', 'expectedRevision']) {
    const missing: Json = { ...guard }; delete missing[key]
    rejected(await f.call('batch.apply', { operations }, missing))
  }
  rejected(await f.call('batch.apply', { operations, mutationId: 'bad id' }, guard))
  expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(revision); expect(f.editor.canUndo).toBe(false)
  const params = { operations, mutationId: 'schema_contract_1' }
  success(await f.call('batch.apply', params, guard))
  const committed = f.editor.state.doc
  expect(success(await f.call('batch.apply', params, guard)).result.receipt.replayed).toBe(true)
  expect(f.editor.state.doc).toBe(committed)
  await f.read('document.get')
})

// Defense-in-depth validator regression, not a claim that the live registry had
// an exploitable anyOf sibling combination. Production branches are tested above.
it('anyOf success does not bypass sibling assertions in a trusted extension', () => {
  const editor = new Editor(blank()), api = createDesignAutomation(editor, [{
    name: 'contract.inspect', description: 'Test-only sibling contract', mutates: false,
    inputSchema: { type: 'object', anyOf: [{ type: 'object' }], properties: { name: { type: 'string', maxLength: 2 } }, required: ['name'], additionalProperties: false },
    execute: (_document, params) => params,
  }])
  try {
    for (const params of [{}, { name: 'abc' }, { name: 'ok', extra: true }]) expect(api.execute({ method: 'contract.inspect', params }).ok).toBe(false)
    expect(api.execute({ method: 'contract.inspect', params: { name: '😀😀' } }).ok).toBe(true)
  } finally { api.dispose(); editor.dispose() }
})
