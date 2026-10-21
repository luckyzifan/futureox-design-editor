import { afterEach, expect, test, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
type Json = Record<string, any>
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
async function fixture() {
  const doc = blank('Committed MCP owner'), item = node('rectangle', 0, 0, 10, 10); doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
  const editor = new Editor(doc), api = createEditorDesignAutomation(editor), backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request), scope: 'write' })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough(), pending = new Map<number, (value: Json) => void>()
  let buffer = '', id = 0
  output.on('data', chunk => {
    buffer += chunk; let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) { const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); const resolve = pending.get(response.id); pending.delete(response.id); resolve?.(response) }
  })
  diagnostics.resume(); const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() })
  const rpc = (method: string, params: Json): Promise<Json> => new Promise((resolve, reject) => {
    const requestId = ++id, timeout = setTimeout(() => { pending.delete(requestId); reject(Error('MCP response timeout')) }, 10000)
    pending.set(requestId, response => { clearTimeout(timeout); resolve(response) }); input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
  })
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'postcommit-regression', version: '1' } })
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (method: string, params: Json, owner: Json) => {
    const response = await rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...owner } })
    expect(response.error).toBeUndefined(); return response.result as Json
  }
  return { doc, item, editor, api, call }
}
for (const method of ['batch.apply', 'history.undo', 'history.redo'] as const) for (const replace of [false, true])
  test(`real MCP ${method} reports accepted commit after throw-once subscriber (same-ID load=${replace})`, async () => {
    const f = await fixture(), errors: unknown[] = [], failure = Error('MCP postcommit subscriber fixture')
    vi.stubGlobal('reportError', (error: unknown) => errors.push(error))
    if (method !== 'batch.apply') { f.editor.change('Before history', doc => { doc.nodes[f.item.id].width = 20 }); if (method === 'history.redo') f.editor.undo() }
    const owner = { documentId: f.editor.state.doc.id, session: f.editor.sessionGeneration, expectedRevision: f.editor.state.version }, events: Json[] = []
    let entered = false, captured: Editor['state'] | undefined, adopted: Editor['state'] | undefined
    cleanup.push(f.editor.subscribeEdits(event => events.push(event)))
    cleanup.push(f.editor.subscribe(() => {
      if (entered || f.editor.state.version !== owner.expectedRevision + 1) return
      entered = true; captured = f.editor.state
      if (replace) { const next = blank('PRIVATE_NEW_OWNER'); next.id = owner.documentId; expect(f.editor.load(next)).toBe(true); adopted = f.editor.state }
      throw failure
    }))
    const params = method === 'batch.apply' ? { mutationId: 'postcommit-ndjson', operations: [{ method: 'node.update', params: { ids: [f.item.id], patch: { width: 20 } } }] } : {}
    const response = await f.call(method, params, owner)
    expect(entered).toBe(true); expect(captured?.doc.nodes[f.item.id].width).toBe(method === 'history.undo' ? 10 : 20)
    expect(response.isError, JSON.stringify(response)).toBe(false)
    expect(response.structuredContent).toMatchObject({ ok: true, documentId: owner.documentId, session: owner.session, revision: owner.expectedRevision + 1, result: { noChange: false } })
    const result = response.structuredContent.result
    expect(JSON.parse(response.content.find((part: Json) => part.type === 'text').text)).toEqual(response.structuredContent)
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ source: 'automation', documentId: owner.documentId, session: owner.session, revision: owner.expectedRevision + 1 })
    await Promise.resolve(); expect(errors).toEqual([failure])
    if (replace) {
      expect(result.completion).toMatchObject({ status: 'committed', superseded: true, retry: 'do-not-retry', contextApplied: false })
      expect(f.editor.state).toBe(adopted); expect(f.editor.canUndo).toBe(false); expect(JSON.stringify(response)).not.toContain('PRIVATE_NEW_OWNER')
      if (method === 'batch.apply') expect(result.receipt.replayAvailable).toBe(false)
    } else {
      expect(result.completion).toBeUndefined() // Normal successful response shape remains unchanged.
      expect(f.editor.state).toBe(captured)
      if (method === 'batch.apply') {
        const replay = await f.call(method, params, owner)
        expect(replay.isError).toBe(false); expect(replay.structuredContent.result.receipt.replayed).toBe(true)
        expect(f.editor.state).toBe(captured); expect(events).toHaveLength(1); expect(errors).toHaveLength(1)
      } else expect(result).toMatchObject({ canUndo: method === 'history.redo', canRedo: method === 'history.undo' })
    }
  })
