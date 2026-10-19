import { expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Editor } from '../../design-client/src/engine'
import { blank, type DesignDocument } from '../../design-client/src/model'
import { createEditorDesignAutomation } from '../../design-client/src/automation'
import { OperationBackend } from '../src/operation-backend.mjs'
import { DesignMcpServer } from '../src/server.mjs'

export type Json = Record<string, any>
export const sha256 = (data: string | Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex')

// This is a real NDJSON protocol client around the actual server and Editor.
// Only transport is in-memory; operation results and WASM are not mocked.
export async function connect(document: DesignDocument = blank('Forma / local design studio')) {
  const editor = new Editor(document), api = createEditorDesignAutomation(editor)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request) })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  const transcript: Json[] = [], pending = new Map<number, (response: Json) => void>()
  let buffer = '', sequence = 0
  output.on('data', chunk => {
    buffer += chunk
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      const resolve = pending.get(response.id); pending.delete(response.id); resolve?.(response)
    }
  })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  const summarize = (value: any): any => {
    if (typeof value === 'string' && value.length > 4096) return { omittedLargeString: true, characters: value.length, sha256: sha256(value) }
    if (Array.isArray(value)) return value.map(summarize)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, summarize(entry)]))
    return value
  }
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const id = ++sequence, started = performance.now()
    const request = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} request ${id} timed out`)) }, 60000)
    server.done.then(() => { if (pending.delete(id)) { clearTimeout(timer); reject(new Error('MCP closed before response')) } })
    pending.set(id, response => {
      clearTimeout(timer)
      transcript.push({ sequence: id, elapsedMs: Math.round(performance.now() - started), request: summarize(request), response: summarize(response), responseBytes: Buffer.byteLength(JSON.stringify(response)) })
      resolve(response)
    })
    input.write(JSON.stringify(request) + '\n')
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'agent-authored-forma-generation', version: '1.0.0' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools
  const call = async (method: string, params: Json = {}, fences: Json = {}) => {
    const name = `design_${method.replaceAll('.', '_')}`
    expect(tools.some((tool: Json) => tool.name === name), `Advertised tool ${name}`).toBe(true)
    const response = await rpc('tools/call', { name, arguments: { params, ...fences } })
    expect(response.error, JSON.stringify(response.error)).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(256 * 1024)
    return response.result as Json
  }
  // Read resources only for saving actual artifacts, never as model context.
  const materialize = async (response: Json) => {
    const value = response.structuredContent ?? response, result = { ...value.result }
    for (const ref of result.resources ?? []) {
      const response = await rpc('resources/read', { uri: ref.uri })
      expect(response.error, JSON.stringify(response.error)).toBeUndefined()
      const payload = response.result.contents[0]
      const data = ref.encoding === 'json' ? JSON.parse(payload.text) : ref.encoding === 'base64' ? payload.blob : ref.encoding === 'data-url' ? `data:${ref.mimeType};base64,${payload.blob}` : payload.text
      if (ref.field === '$metadata') Object.assign(result, data)
      else result[ref.field] = data
    }
    return { ...value, result }
  }
  const read = async (method: string, params: Json = {}) => {
    const response = await call(method, params)
    expect(response.isError, JSON.stringify(response.structuredContent.error)).toBe(false)
    return materialize(response)
  }
  const mutate = async (method: string, params: Json, allowError = false) => {
    const state = await read('document.get')
    const response = await call(method, params, { documentId: state.documentId, session: state.session, expectedRevision: state.revision })
    if (!allowError) expect(response.isError, JSON.stringify(response.structuredContent.error)).toBe(false)
    return response
  }
  return { editor, api, tools, transcript, rpc, call, read, mutate, materialize,
    close: async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() },
  }
}
