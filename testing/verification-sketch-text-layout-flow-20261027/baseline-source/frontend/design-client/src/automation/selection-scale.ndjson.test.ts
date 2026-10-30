import { afterEach, describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Editor } from '../engine'
import { blank, node, stroke, effect, type DesignDocument } from '../model'
import { createEditorDesignAutomation } from './index'
import type { AutomationPermissionPolicy } from './permissions'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'

type Json = Record<string, any>
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
function document() {
  const doc = blank('NDJSON scale'), frame = node('frame', 10, 20, 100, 80), child = node('text', 8, 12, 40, 30), other = node('rectangle', 180, 50, 30, 20)
  child.text = 'Scale'; child.fontSize = 12; child.strokes = [{ ...stroke(), width: 2 }]
  child.effects = [{ ...effect('shadow'), radius: 3, x: 2, y: 4, spread: 1 }]
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child, [other.id]: other }; doc.pages[0].children = [frame.id, other.id]
  return { doc, frame, child, other }
}
/** Actual newline-delimited initialize/list/call framing and server adapter,
 * not a direct execute substitute. PassThrough is not an OS socket/CLI claim. */
async function connect(doc: DesignDocument, scope: 'read' | 'write' = 'write', operations?: string[]) {
  const editor = new Editor(structuredClone(doc))
  const policy: AutomationPermissionPolicy | undefined = operations ? { grants: [{ resource: { documentId: doc.id, session: editor.sessionGeneration }, operations, access: scope }] } : undefined
  const api = createEditorDesignAutomation(editor, policy)
  const backend = new OperationBackend({ capabilities: api.capabilities(), execute: request => api.execute(request), scope })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let buffer = '', serial = 0
  const pending = new Map<number, (value: Json) => void>()
  output.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      expect(response.jsonrpc).toBe('2.0')
      const receive = pending.get(response.id); pending.delete(response.id); receive?.(response)
    }
  })
  diagnostics.resume()
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy(); api.dispose(); editor.dispose() })
  const rpc = (method: string, params?: Json): Promise<Json> => new Promise((resolve, reject) => {
    const id = ++serial, timeout = setTimeout(() => { pending.delete(id); reject(Error(`NDJSON scale request ${id} timed out`)) }, 20000)
    server.done.then(() => { if (pending.delete(id)) { clearTimeout(timeout); reject(Error('NDJSON scale stream closed')) } })
    pending.set(id, response => { clearTimeout(timeout); resolve(response) })
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n', split = Math.floor(line.length / 2)
    input.write(line.slice(0, split)); input.write(line.slice(split))
  })
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'selection-scale-ndjson', version: '1' } })
  expect(initialized.result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = (await rpc('tools/list')).result.tools as Json[]
  const call = (method: string, params: Json = {}, fences: Json = {}) => rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...fences } })
  const success = async (method: string, params: Json = {}, fences: Json = {}) => {
    const response = await call(method, params, fences)
    expect(response.error, JSON.stringify(response)).toBeUndefined(); expect(response.result.isError, JSON.stringify(response)).toBe(false)
    return response.result.structuredContent as Json
  }
  const fence = async () => { const state = await success('document.get'); return { documentId: state.documentId, session: state.session, expectedRevision: state.revision } }
  const mutate = async (method: string, params: Json = {}) => success(method, params, await fence())
  return { editor, tools, rpc, call, success, fence, mutate }
}
function denied(response: Json, code: string) {
  expect(response.error, JSON.stringify(response)).toBeUndefined()
  expect(response.result).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code } } })
}

describe('selection.scale actual MCP NDJSON contract', () => {
  it('discovers exact schemas, scales and reads Inspector projection, then undoes/redoes through tools/call', async () => {
    const { doc, frame, child } = document(), f = await connect(doc), before = f.editor.state.doc
    const schema = f.tools.find(t => t.name === 'design_selection_scale')!.inputSchema.properties.params
    expect(schema).toMatchObject({ required: ['ids', 'factor'], additionalProperties: false, properties: { factor: { minimum: .01, maximum: 10000 }, anchor: { minimum: 0, maximum: 8 } } })
    expect(f.tools.find(t => t.name === 'design_node_get')!.inputSchema.properties.params.properties.includeDisplayProperties).toEqual({ type: 'boolean' })
    await f.mutate('selection.scale', { ids: [frame.id], factor: 2, anchor: 0 })
    const plain = (await f.success('node.get', { id: child.id })).result
    const projected = (await f.success('node.get', { id: child.id, includeDisplayProperties: true })).result
    expect(plain).not.toHaveProperty('displayProperties'); expect(projected.node).toEqual(plain.node)
    expect(projected.displayProperties).toMatchObject({ width: 80, height: 60, fontSize: 24, strokes: [{ width: 4 }], effects: [{ radius: 6 }] })
    expect(plain.node.fontSize).toBe(12)
    const after = f.editor.state.doc
    await f.mutate('history.undo'); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
    await f.mutate('history.redo'); expect(f.editor.state.doc).toEqual(after)
  })
  it('uses independent numeric multi-root bounds and matches UI on every anchor including nested selection', async () => {
    for (let anchor = 0; anchor < 9; anchor++) {
      const { doc, frame, child, other } = document(), f = await connect(doc), ui = new Editor(structuredClone(doc))
      try {
        const ids = [frame.id, child.id, other.id]; ui.select(ids); expect(ui.scaleSelection(2, anchor)).toBe(true)
        await f.mutate('selection.scale', { ids, factor: 2, anchor })
        expect(f.editor.state.doc).toEqual(ui.state.doc)
        const ax = 10 + 100 * (anchor % 3), ay = 20 + 40 * Math.floor(anchor / 3)
        expect((await f.success('node.get', { id: frame.id })).result.node.transform).toEqual([2, 0, 0, 2, 20 - ax, 40 - ay])
        expect((await f.success('node.get', { id: other.id })).result.node.transform).toEqual([2, 0, 0, 2, 360 - ax, 100 - ay])
      } finally { ui.dispose() }
    }
  })
  it('rejects factor/anchor/schema/target budget violations at the protocol boundary without mutation', async () => {
    const { doc, frame } = document(), f = await connect(doc), before = f.editor.state.doc
    for (const params of [
      { ids: [frame.id], factor: 0 }, { ids: [frame.id], factor: 10001 }, { ids: [frame.id], factor: 2, anchor: 9 },
      { ids: [frame.id, frame.id], factor: 2 }, { ids: Array.from({ length: 1001 }, (_, i) => String(i)), factor: 2 },
      { ids: [frame.id], factor: 2, selectionGeometryFresh: true }, { ids: [frame.id], factor: 2, width: 120 },
    ]) denied(await f.call('selection.scale', params, await f.fence()), 'invalid_params')
    denied(await f.call('node.get', { id: frame.id, includeDisplayProperties: 'true' }), 'invalid_params')
    expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
  })
  it('rejects hidden, locked, cross-page and instance-internal targets atomically over NDJSON', async () => {
    for (const mode of ['hidden', 'locked', 'page', 'instance'] as const) {
      const { doc, frame, other } = document()
      if (mode === 'hidden') other.visible = false
      if (mode === 'locked') other.locked = true
      if (mode === 'page') { doc.pages.push({ ...doc.pages[0], id: '11111111-1111-4111-8111-111111111111', children: [other.id] }); doc.pages[0].children = [frame.id] }
      const f = await connect(doc); let ids = [frame.id, other.id]
      if (mode === 'instance') {
        const made = await f.mutate('component.create', { nodeIds: [frame.id] })
        const instance = await f.mutate('component.instantiate', { componentId: made.result.operations[0].result.id })
        ids = [f.editor.state.doc.nodes[instance.result.operations[0].result.id].children[0]]
      }
      const before = f.editor.state.doc, version = f.editor.state.version
      denied(await f.call('selection.scale', { ids, factor: 2 }, await f.fence()), ({ hidden: 'invalid_selection', locked: 'locked_node', page: 'different_pages', instance: 'instance_structure' })[mode])
      expect(f.editor.state.doc).toBe(before); expect(f.editor.state.version).toBe(version)
    }
  })
  it('filters read-only/ungranted scale tools and does not turn node.get projection into write authority', async () => {
    const { doc, frame } = document()
    for (const restricted of [false, true]) {
      const f = await connect(doc, 'read', restricted ? ['document.get', 'node.get', 'selection.scale'] : undefined), before = f.editor.state.doc
      expect(f.tools.some(t => t.name === 'design_selection_scale')).toBe(false)
      expect((await f.success('node.get', { id: frame.id, includeDisplayProperties: true })).result.displayProperties.width).toBe(100)
      const response = await f.call('selection.scale', { ids: [frame.id], factor: 2 }, await f.fence())
      expect(response.error).toBeTruthy(); expect(f.editor.state.doc).toBe(before); expect(f.editor.canUndo).toBe(false)
    }
  })
  it('enforces fresh fences and derived-batch atomic rollback while a plain batch has one undo', async () => {
    const { doc, frame, other } = document(), f = await connect(doc), before = f.editor.state.doc
    denied(await f.call('batch.apply', { operations: [
      { method: 'node.update', params: { ids: [frame.id], patch: { name: 'Must roll back' } } },
      { method: 'selection.scale', params: { ids: [frame.id], factor: 2 } },
    ] }, await f.fence()), 'unsupported_derived_batch_geometry')
    expect(f.editor.state.doc).toBe(before)
    const oldFence = await f.fence()
    await f.mutate('batch.apply', { operations: [
      { method: 'node.update', params: { ids: [other.id], patch: { name: 'Scaled' } } },
      { method: 'selection.scale', params: { ids: [other.id], factor: 2, anchor: 0 } },
    ] })
    const scaled = f.editor.state.doc
    denied(await f.call('selection.scale', { ids: [other.id], factor: 2 }, oldFence), 'stale_revision')
    expect(f.editor.state.doc).toBe(scaled)
    await f.mutate('history.undo'); expect(f.editor.state.doc).toEqual(before); expect(f.editor.canUndo).toBe(false)
  })
})
