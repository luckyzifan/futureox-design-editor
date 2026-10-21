import { afterEach, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationResponse } from './types'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

// Independent wire contract constants, not the implementation's own validator.
const V = '2026-07-28'
const K = { version: 'io.modelcontextprotocol/protocolVersion', capabilities: 'io.modelcontextprotocol/clientCapabilities', clientInfo: 'io.modelcontextprotocol/clientInfo' } as const

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
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params: { ...params, _meta: { [K.version]: V, [K.capabilities]: {}, [K.clientInfo]: { name: 'real-editor-modern', version: '1' } } } }) + '\n')
  })
  const tools = (await rpc('tools/list')).result.tools as Json[]
  const toolName = (method: string) => `design_${method.replaceAll('.', '_')}`
  const call = async (method: string, params: Json = {}, fences: Json = {}) => {
    expect(tools.some(tool => tool.name === toolName(method))).toBe(true)
    const response = await rpc('tools/call', { name: toolName(method), arguments: { params, ...fences } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    expect(response.result.resultType).toBe('complete')
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

/** Real Editor + matching WASM behind the modern NDJSON adapter.
 * PassThrough transport is not a CLI, OS socket or physical GUI claim. */
it('modern per-request metadata reaches real Editor read/write/undo and resource reads without initialize', async () => {
  const f = await fixture(), before = f.editor.state.doc
  expect((await f.rpc('server/discover')).result.resultType).toBe('complete')
  const initial = await f.read('document.get')
  expect(initial.documentId).toBe(before.id)
  success(await f.mutate('document.rename', { name: 'Modern edited document' }))
  expect(f.editor.state.doc.name).toBe('Modern edited document')
  expect(f.editor.canUndo).toBe(true)
  const changed = f.editor.state.doc
  const exported = success(await f.call('document.export', { format: 'native-json' }))
  expect(exported.result.resources.length).toBeGreaterThan(0)
  const materialized = await f.materialize(exported)
  expect(JSON.parse(materialized.result.content)).toEqual(changed)
  success(await f.mutate('history.undo'))
  expect(f.editor.state.doc).toEqual(before)
  expect(f.editor.canUndo).toBe(false)
  success(await f.mutate('history.redo'))
  expect(f.editor.state.doc).toEqual(changed)
})
