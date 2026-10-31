import { afterEach, expect, test, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { translate, worldMatrix } from '../geometry'
import { createEditorDesignAutomation } from './index'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
type Json = Record<string, any>
const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals() })
async function fixture(kind: 'rectangle' | 'frame' = 'rectangle') {
  const doc = blank('Committed MCP owner'), item = node(kind, 10, 20, 100, 80); doc.nodes[item.id] = item; doc.pages[0].children = [item.id]
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
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shared-duplicate-regression', version: '1' } })
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (method: string, params: Json, owner: Json) => {
    const response = await rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...owner } })
    expect(response.error).toBeUndefined(); return response.result as Json
  }
  const owner = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const duplicate = async (ids: string[], params: Json = {}) => {
    const response = await call('node.duplicate', { ids, ...params }, owner())
    expect(response.isError, JSON.stringify(response)).toBe(false)
    return response.structuredContent.result.operations[0].result.ids as string[]
  }
  return { doc, item, editor, api, call, owner, duplicate }
}

for (const kind of ['rectangle', 'frame'] as const) test(`real NDJSON duplicate defaults use Core ${kind} placement and select the copy`, async () => {
  const f = await fixture(kind), before = f.editor.state.doc, [copy] = await f.duplicate([f.item.id])
  expect(worldMatrix(f.editor.state.doc, copy)).toEqual([1, 0, 0, 1, kind === 'frame' ? 134 : 10, 20])
  expect(f.editor.state.selection).toEqual([copy]); expect(f.editor.state.version).toBe(1)
  const after = f.editor.state.doc
  expect((await f.call('history.undo', {}, f.owner())).isError).toBe(false); expect(f.editor.state.doc).toEqual(before)
  expect((await f.call('history.redo', {}, f.owner())).isError).toBe(false); expect(f.editor.state.doc).toEqual(after)
})
test('real NDJSON partial explicit offset retains the other axis default 24', async () => {
  const f = await fixture(), [copy] = await f.duplicate([f.item.id], { offsetX: 0 })
  expect(worldMatrix(f.editor.state.doc, copy)).toEqual([1, 0, 0, 1, 10, 44])
})
test('real NDJSON and UI share the same trusted repeat chain', async () => {
  const f = await fixture(); f.editor.select([f.item.id]); f.editor.duplicate(); f.editor.transformSelection(translate(30, 5))
  const current = f.editor.state.selection[0], [copy] = await f.duplicate([current])
  expect(worldMatrix(f.editor.state.doc, copy)).toEqual([1, 0, 0, 1, 70, 30])
  f.editor.duplicate(); expect(worldMatrix(f.editor.state.doc, f.editor.state.selection[0])).toEqual([1, 0, 0, 1, 100, 35])
})
test('real NDJSON exact retry neither duplicates twice nor resets newer repeat facts', async () => {
  const f = await fixture(), owner = f.owner(), params = { mutationId: 'duplicate-exact-retry', operations: [{ method: 'node.duplicate', params: { ids: [f.item.id] } }] }
  expect((await f.call('batch.apply', params, owner)).isError).toBe(false)
  f.editor.transformSelection(translate(30, 0)); const before = f.editor.state, repeat = f.editor.duplicationRepeat()
  const replay = await f.call('batch.apply', params, owner)
  expect(replay.isError).toBe(false); expect(replay.structuredContent.result.receipt.replayed).toBe(true)
  expect(f.editor.state).toBe(before); expect(f.editor.duplicationRepeat()).toEqual(repeat)
  const [copy] = await f.duplicate(f.editor.state.selection)
  expect(worldMatrix(f.editor.state.doc, copy)).toEqual([1, 0, 0, 1, 70, 20])
})
test('real NDJSON same-ID load during duplicate reports old commit and cannot seed the new owner', async () => {
  const f = await fixture(), owner = f.owner(); let loaded = false, adopted: Editor['state'] | undefined
  cleanup.push(f.editor.subscribe(() => {
    if (loaded || f.editor.state.version !== owner.expectedRevision + 1) return
    loaded = true; const next = blank('PRIVATE_NEW_OWNER'); next.id = owner.documentId
    expect(f.editor.load(next)).toBe(true); adopted = f.editor.state
  }))
  const response = await f.call('node.duplicate', { ids: [f.item.id] }, owner)
  expect(response.isError, JSON.stringify(response)).toBe(false)
  expect(response.structuredContent).toMatchObject({ documentId: owner.documentId, session: owner.session, revision: owner.expectedRevision + 1,
    result: { completion: { status: 'committed', superseded: true, contextApplied: false, retry: 'do-not-retry' } } })
  expect(f.editor.state).toBe(adopted); expect(f.editor.state.selection).toEqual([]); expect(f.editor.duplicationRepeat()).toBeNull()
  expect(JSON.stringify(response)).not.toContain('PRIVATE_NEW_OWNER')
})
