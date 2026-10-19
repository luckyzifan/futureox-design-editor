import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Editor } from '../engine'
import { blank, node, paint } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationResponse } from './types'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

type Json = Record<string, any>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture(document = blank('MCP live document')) {
  const editor = new Editor(document)
  const api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request) })
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
const ids = {
  frame: '10000000-0000-4000-8000-000000000001',
  title: '10000000-0000-4000-8000-000000000002',
  input: '10000000-0000-4000-8000-000000000003',
  button: '10000000-0000-4000-8000-000000000004',
  label: '10000000-0000-4000-8000-000000000005',
}
const operations = [
  { method: 'node.create', params: { id: ids.frame, kind: 'frame', width: 400, height: 340, patch: { name: 'Login card', fills: [paint('#ffffff')] } } },
  { method: 'layout.set', params: { ids: [ids.frame], layout: { mode: 'vertical', gap: 16, padding: [24, 24, 24, 24] } } },
  { method: 'node.create', params: { id: ids.title, kind: 'text', parentId: ids.frame, width: 320, height: 40 } },
  { method: 'text.set', params: { ids: [ids.title], text: 'Sign in', fontSize: 28 } },
  { method: 'node.create', params: { id: ids.input, kind: 'rectangle', parentId: ids.frame, width: 320, height: 48, patch: { name: 'Email field', fills: [paint('#f0f2f6')], radii: [8, 8, 8, 8] } } },
  { method: 'node.create', params: { id: ids.button, kind: 'frame', parentId: ids.frame, width: 320, height: 48, patch: { name: 'Submit button', fills: [paint('#2155ee')] } } },
  { method: 'node.create', params: { id: ids.label, kind: 'text', parentId: ids.button, x: 12, y: 10, width: 200, height: 28 } },
  { method: 'text.set', params: { ids: [ids.label], text: 'Continue', fontSize: 18 } },
]

describe('MCP JSON-RPC -> shared operation API -> real Editor/WASM', () => {
  it('creates a login design, inspects/checks, fine-edits and exports exact code resources', async () => {
    const f = await fixture()
    expect(f.tools.length).toBe(f.api.capabilities().methods.length)
    const before = f.editor.state.version
    const created = await f.mutate('batch.apply', { operations, label: 'Create login card' })
    expect(created.isError, JSON.stringify(created.structuredContent)).toBe(false)
    expect(f.editor.state.version).toBe(before + 1)
    expect(Object.keys(f.editor.state.doc.nodes)).toHaveLength(5)
    expect(f.editor.state.doc.nodes[ids.frame].children).toEqual([ids.title, ids.input, ids.button])
    expect(f.editor.state.doc.nodes[ids.frame].layout?.mode).toBe('vertical')
    const context = await f.read('context.get', { nodeIds: [ids.frame], limit: 20 })
    expect(context.result.format).toBe('futureox.design-context.v1')
    const check = await f.read('design.check', { nodeIds: [ids.frame], limit: 20 })
    expect(check.result.format).toBe('futureox.design-check.v1')
    const edited = await f.mutate('text.set', { ids: [ids.title], text: 'Welcome back', fontSize: 30 })
    expect(edited.isError).toBe(false)
    expect(f.editor.state.doc.nodes[ids.title].text).toBe('Welcome back')
    const code = await f.call('code.export', { nodeIds: [ids.frame] })
    expect(code.isError, JSON.stringify(code.structuredContent)).toBe(false)
    expect(code.structuredContent.result.html).toBeUndefined()
    const result = (await f.materialize(code.structuredContent)).result
    expect(result.fidelity).toBe('approximate')
    expect(result.html).toContain('Welcome back')
    expect(result.css).toContain('flex-direction:column')
    expect(result.nodeIdMap[ids.title]).toBeTruthy()
    const htmlLink = code.content.find((entry: Json) => entry.type === 'resource_link' && entry.mimeType === 'text/html')
    expect(htmlLink).toBeTruthy()
    const resource = await f.rpc('resources/read', { uri: htmlLink.uri })
    expect(resource.result.contents[0].text).toBe(result.html)
    const listed = await f.rpc('resources/list')
    expect(listed.result.resources.some((entry: Json) => entry.uri === htmlLink.uri)).toBe(true)
  }, 30000)

  it('losslessly exports and reimports structure with remapped IDs, then undoes/redoes one transaction', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const exported = await source.read('document.export')
    expect(exported.result.lossless).toBe(true)
    const raw = JSON.parse(exported.result.content)
    expect(raw.nodes[ids.title].text).toBe('Sign in')
    const destination = await fixture(blank('Import destination'))
    const before = destination.editor.state.doc
    const imported = await destination.mutate('document.import', { format: 'native-json', content: exported.result.content })
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBe(false)
    const mapping = imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(mapping[ids.frame]).not.toBe(ids.frame)
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].children).toEqual([mapping[ids.title], mapping[ids.input], mapping[ids.button]])
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].layout?.mode).toBe('vertical')
    expect((await destination.mutate('history.undo')).isError).toBe(false)
    expect(destination.editor.state.doc).toBe(before)
    expect((await destination.mutate('history.redo')).isError).toBe(false)
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
  }, 30000)

  it('exports true native .fd bytes as a blob resource and imports them through the real decoder', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const exported = await source.call('document.export', { format: 'fd' })
    expect(exported.isError, JSON.stringify(exported.structuredContent)).toBe(false)
    expect(exported.structuredContent.result.base64).toBeUndefined()
    const result = (await source.materialize(exported.structuredContent)).result
    expect(result.nativeFormat).toBe('fd')
    expect(result.encoding).toBe('base64')
    expect(result.mimeType).toBe('application/vnd.futureox-desgin')
    const bytes = Buffer.from(result.base64, 'base64')
    expect(bytes.length).toBe(result.bytes)
    expect(bytes.subarray(0, 1).toString()).not.toBe('{')
    const blobLink = exported.content.find((entry: Json) => entry.type === 'resource_link' && entry.name === 'design.fd')
    expect(blobLink).toBeTruthy()
    const resource = await source.rpc('resources/read', { uri: blobLink.uri })
    expect(resource.result.contents[0].blob).toBe(result.base64)
    expect(resource.result.contents[0].text).toBeUndefined()
    const destination = await fixture(blank('FD destination'))
    const imported = await destination.mutate('document.import', { format: 'fd', base64: result.base64 })
    expect(imported.isError, JSON.stringify(imported.structuredContent)).toBe(false)
    const mapping = imported.structuredContent.result.operations[0].result.nodeIdMap
    expect(destination.editor.state.doc.nodes[mapping[ids.title]].text).toBe('Sign in')
    expect(destination.editor.state.doc.nodes[mapping[ids.frame]].children).toEqual([mapping[ids.title], mapping[ids.input], mapping[ids.button]])
  }, 30000)

  it('stale writes and invalid multi-operation edits never partially commit', async () => {
    const f = await fixture()
    expect((await f.mutate('batch.apply', { operations })).isError).toBe(false)
    const stale = await f.read('document.get')
    expect((await f.mutate('text.set', { ids: [ids.title], text: 'Changed by another edit' })).isError).toBe(false)
    const rejected = await f.call('node.delete', { ids: [ids.frame] }, { documentId: stale.documentId, session: stale.session, expectedRevision: stale.revision })
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredContent.error.code).toBe('stale_revision')
    const before = f.editor.state.doc, version = f.editor.state.version
    const invalid = await f.mutate('batch.apply', { operations: [
      { method: 'text.set', params: { ids: [ids.title], text: 'Must roll back' } },
      { method: 'node.move', params: { ids: [ids.title], parentId: 'missing' } },
    ] })
    expect(invalid.isError).toBe(true)
    expect(f.editor.state.doc).toBe(before)
    expect(f.editor.state.version).toBe(version)
    expect(f.editor.state.doc.nodes[ids.title].text).toBe('Changed by another edit')
  }, 30000)

  it('exports actual native SVG geometry, with no preview renderer substitute', async () => {
    const f = await fixture()
    expect((await f.mutate('node.create', { id: ids.input, kind: 'rectangle', width: 123, height: 45, patch: { fills: [paint('#ff0000')] } })).isError).toBe(false)
    const svg = await f.read('vector.export', { nodeIds: [ids.input] })
    expect(svg.result.mimeType).toBe('image/svg+xml')
    expect(svg.result.content).toContain('<svg')
    expect(svg.result.sourceNodeIds).toEqual([ids.input])
    expect(svg.result.content).toMatch(/123|45/)
  }, 30000)

  it('imports the actual 17.77 MB bundled font then returns sequential full FD and JSON exports', async () => {
    const f = await fixture(), started = performance.now()
    const font = await readFile(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))
    const imported = await f.mutate('font.import', { id: 'mcp-full-font', data: font.toString('base64'), embeddingAllowed: true })
    expect(imported.isError).toBe(false)
    const binaryWire = await f.call('document.export', { format: 'fd' })
    expect(Buffer.byteLength(JSON.stringify(binaryWire))).toBeLessThan(256 * 1024)
    expect(binaryWire.structuredContent.result.base64).toBeUndefined()
    const binary = await f.materialize(binaryWire.structuredContent)
    expect(binary.result.base64.length).toBeGreaterThan(30 * 1024 * 1024)
    const direct = f.api.execute({ method: 'document.export', params: { format: 'fd' } })
    expect(direct.ok).toBe(true)
    if (!direct.ok) throw new Error(direct.error.message)
    const digest = (data: string) => createHash('sha256').update(data).digest('hex')
    expect(digest(binary.result.base64)).toBe(digest((direct.result as Json).base64))
    expect(Buffer.byteLength(JSON.stringify(direct))).toBeGreaterThan(30 * 1024 * 1024)
    expect(Buffer.from(binary.result.base64, 'base64').subarray(0, 4).toString()).toBe('FXDK')
    const nativeWire = await f.call('document.export')
    expect(Buffer.byteLength(JSON.stringify(nativeWire))).toBeLessThan(256 * 1024)
    expect(nativeWire.structuredContent.result.content).toBeUndefined()
    const native = await f.materialize(nativeWire.structuredContent)
    const expired = await f.rpc('resources/read', { uri: binaryWire.structuredContent.result.resources[0].uri })
    expect(expired.error.code).toBe(-32002)
    expect(JSON.parse(native.result.content).fonts['mcp-full-font'].data).toBe(font.toString('base64'))
    expect((await f.rpc('ping')).result).toEqual({})
    console.info(JSON.stringify({ benchmark: 'mcp-full-font-sequential-native-exports', fontBytes: font.length, fdBase64Bytes: binary.result.base64.length, jsonBytes: native.result.bytes, fdToolBytes: Buffer.byteLength(JSON.stringify(binaryWire)), jsonToolBytes: Buffer.byteLength(JSON.stringify(nativeWire)), elapsedMs: Math.round(performance.now() - started) }))
  }, 30000)

  it('returns real Sketch ZIP resources and reimports the authored structure through MCP', async () => {
    const source = await fixture()
    expect((await source.mutate('batch.apply', { operations })).isError).toBe(false)
    const wire = await source.call('sketch.export')
    expect(wire.isError).toBe(false)
    expect(wire.structuredContent.result.base64).toBeUndefined()
    expect(wire.structuredContent.result.lossless).toBe(false)
    const exported = await source.materialize(wire.structuredContent)
    expect(Buffer.from(exported.result.base64, 'base64').subarray(0, 2).toString()).toBe('PK')
    const destination = await fixture(blank('Sketch destination'))
    const imported = await destination.mutate('sketch.import', { base64: exported.result.base64, name: 'mcp-example.sketch' })
    expect(imported.isError, JSON.stringify(imported.structuredContent.error)).toBe(false)
    expect(Object.values(destination.editor.state.doc.nodes).some(item => item.text === 'Sign in')).toBe(true)
  }, 30000)

  it('handles 3,000 native nodes with bounded paginated reads and one targeted edit', async () => {
    const document = blank('Large MCP scene')
    for (let index = 0; index < 3000; index++) {
      const item = node('rectangle', (index % 60) * 12, Math.floor(index / 60) * 12, 10, 10)
      item.name = `Cell ${index}`; document.nodes[item.id] = item; document.pages[0].children.push(item.id)
    }
    const start = performance.now(), f = await fixture(document)
    let cursor: string | undefined, count = 0, firstId: string | undefined, pages = 0
    do {
      const result = await f.read('node.find', { limit: 500, ...(cursor ? { cursor } : {}) })
      count += result.result.nodes.length; firstId ??= result.result.nodes[0]?.id; cursor = result.result.nextCursor; pages++
      expect(result.result.nodes.length).toBeLessThanOrEqual(500)
    } while (cursor)
    expect(count).toBe(3000); expect(pages).toBe(6)
    expect((await f.mutate('node.update', { ids: [firstId], patch: { name: 'Fine-edited cell' } })).isError).toBe(false)
    expect(f.editor.state.doc.nodes[firstId!].name).toBe('Fine-edited cell')
    expect(Object.keys(f.editor.state.doc.nodes)).toHaveLength(3000)
    // Record a measurement without making hardware-dependent performance promises.
    console.info(JSON.stringify({ benchmark: 'mcp-real-editor-3000-nodes', nodes: count, pages, elapsedMs: Math.round(performance.now() - start) }))
  }, 60000)
})
