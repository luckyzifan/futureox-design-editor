import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { registerPendingEdit } from '../pending-edits'
import { attachDesktopAutomation, type DesktopAutomationRequest, type DesktopAutomationTransport } from './bridge'
import { createWorkspaceAutomationRenderer } from './workspace-bridge'
import { createEditorDesignAutomation } from './index'
import { exportBinaryDocument } from './export'
import { pickingGeometryEpoch } from '../kernel/picking'
import * as picking from '../kernel/picking'
import { IMPORT_COPY_BYTES } from './workspace-import-copy'
// @ts-expect-error Shared native host is JavaScript without declarations.
import { WorkspaceAutomationHost } from '../../../design-desktop/src/workspace-automation.mjs'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const error = (code: string) => Object.assign(new Error(code), { code })
async function fixture(sqlite = false, scopes: Record<string, string> = { workspace: 'write' }) {
  const source = blank('Imported native design'), rectangle = node('rectangle')
  source.nodes[rectangle.id] = rectangle; source.pages[0].children.push(rectangle.id)
  source.fdCompatibility = { contractVersion: 1, requiredCapabilities: [], extensions: { 'org.example/import': { original: source.id, inert: true } } }
  const editor = new Editor(blank('Keep original')); cleanup.push(() => editor.dispose())
  const state = { storageRevision: null as number | null, dirty: false, busy: false }
  const rows = new Map<string, any>(), commits: any[] = []
  let sidecar: any
  if (sqlite) {
    const { Sidecar } = await import(new URL('../../../design-desktop/src/sidecar.mjs', import.meta.url).href)
    const directory = await mkdtemp(path.join(tmpdir(), 'futureox-import-copy-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') })
    cleanup.push(() => sidecar.stop())
  }
  const storage = vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === 'workspace.commit') {
      commits.push(structuredClone(params))
      if (sidecar) return sidecar.request(method, params)
      const document = structuredClone(params.document)
      if (rows.has(document.id) || params.expectedRevision !== null) throw error('WORKSPACE_CONFLICT')
      const saved = { id: document.id, name: document.name, revision: 1, hash: 'a'.repeat(64), updatedAt: Date.now(), deleted: false, document }
      rows.set(document.id, saved); return saved
    }
    if (sidecar) return sidecar.request(method, params)
    if (method === 'workspace.list') return { documents: [...rows.values()] }
    if (method === 'workspace.open') return rows.get(params.id)
    throw Error(`Unexpected storage ${method}`)
  })
  const adapterExecute = vi.fn(async () => { throw Error('Import must not use activation/save adapter') })
  const renderer = createWorkspaceAutomationRenderer(editor, { inspect: () => state, execute: adapterExecute })
  let receive!: (payload: DesktopAutomationRequest) => void, cancel!: (value: { requestId: string }) => void
  const pending = new Map<string, { resolve: (result: any) => void; reject: (error: any) => void; cleanup: () => void }>()
  const transport: Pick<DesktopAutomationTransport, 'register' | 'recordEdit' | 'onRequest' | 'onCancel' | 'respond'> = {
    register: async () => {}, recordEdit: async () => ({ accepted: true }),
    onRequest: listener => { receive = listener; return () => {} },
    onCancel: listener => { cancel = listener; return () => {} },
    respond: async response => { const record = pending.get(response.requestId); if (!record) return; pending.delete(response.requestId); record.cleanup(); if (response.error) record.reject(Object.assign(Error(response.error.message), { code: response.error.code })); else record.resolve(response.result) },
  }
  cleanup.push(attachDesktopAutomation(editor, transport as DesktopAutomationTransport, { host: renderer }))
  const dispatch = vi.fn((payload: any, signal: AbortSignal): Promise<any> => new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID(), abort = () => { pending.delete(requestId); cancel({ requestId }); reject(signal.reason) }
    if (signal.aborted) { reject(signal.reason); return }
    signal.addEventListener('abort', abort, { once: true })
    pending.set(requestId, { resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
    receive({ ...payload, requestId })
  }))
  let root = {}
  const host = new WorkspaceAutomationHost({ getRoot: () => root, status: () => ({ displayName: 'Test workspace' }), storage, dispatch, confirm: async () => { throw Error('No activation confirmation for import') } })
  const grant = await host.grant('import-owner', scopes)
  const fence = () => ({ documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  const payload = (params: any, fences = fence()) => ({ kind: 'execute', sessionId: 'import-owner', scope: 'read', documentId: editor.state.doc.id, session: editor.sessionGeneration, deadline: Date.now() + 20000, request: { method: 'workspace.importCopy', params, ...fences } })
  const params = (mutationId = 'copy-one') => ({ rootHandle: grant.rootHandle, format: 'native-json', content: JSON.stringify(source), mutationId })
  const run = (p = params(), signal = new AbortController().signal, fences = fence()) => host.execute(payload(p, fences), signal)
  const backend = new OperationBackend({ capabilities: { version: 1, methods: host.methods('import-owner') }, scope: 'read', grants: scopes, target: fence(), execute: (request: any, context: any) => host.execute({ ...payload(request.params), request }, context.signal ?? new AbortController().signal) })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  diagnostics.resume()
  let buffer = '', nextId = 0
  const replies = new Map<number, (response: any) => void>()
  output.on('data', bytes => { buffer += bytes.toString(); let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); replies.get(response.id)?.(response); replies.delete(response.id) } })
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  cleanup.push(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const rpc = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => { const id = ++nextId; const timer = setTimeout(() => reject(Error('MCP timeout')), 20000); replies.set(id, response => { clearTimeout(timer); resolve(response) }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  expect((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'import-copy-test', version: '1' } })).result.protocolVersion).toBe('2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const call = async (p = params(), fences = fence()) => (await rpc('tools/call', { name: 'design_workspace_importCopy', arguments: { params: p, ...fences } })).result
  return { editor, source, rectangle, state, host, grant, rows, commits, storage, dispatch, renderer, adapterExecute, params, run, payload, fence, rpc, call, sidecar, changeRoot: () => { root = {} } }
}
function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return { json: JSON.stringify(f.editor.state.doc), identity: f.editor.state.doc, page: f.editor.state.page, selection: structuredClone(f.editor.state.selection), version: f.editor.state.version, session: f.editor.sessionGeneration, undo: f.editor.canUndo, redo: f.editor.canRedo, dirty: f.state.dirty }
}
it.each(['native-json', 'fd'])('actual NDJSON imports %s as an independent nonactivated copy preserving graph, metadata and editor undo', async format => {
  const f = await fixture()
  f.editor.change('Existing dirty edit', document => { document.name = 'Keep dirty editor' }); f.state.dirty = true
  const before = snapshot(f), params = format === 'fd' ? { rootHandle: f.grant.rootHandle, format, base64: exportBinaryDocument(f.source).base64, mutationId: 'copy-fd' } : f.params()
  expect((await f.rpc('tools/list')).result.tools.some((tool: any) => tool.name === 'design_workspace_importCopy')).toBe(true)
  const response = await f.call(params as any)
  expect(response.isError).toBe(false); expect(response.structuredContent.result).toMatchObject({ activated: false, storageRevision: 1, completion: { status: 'committed', retry: 'do-not-retry' } })
  const result = response.structuredContent.result, id = f.host.resolve(f.grant, result.documentHandle, 'document')
  expect(id).not.toBe(f.source.id); expect(id).not.toBe(f.editor.state.doc.id)
  expect(f.rows.get(id).document).toEqual({ ...f.source, id })
  expect(snapshot(f)).toEqual(before); expect(f.adapterExecute).not.toHaveBeenCalled(); expect(result).not.toHaveProperty('id'); expect(result).not.toHaveProperty('documentJson')
  expect(await f.call(params as any)).toEqual(response); expect(f.commits).toHaveLength(1)
  f.editor.undo(); expect(f.editor.state.doc.name).toBe('Keep original')
})
it('concurrent exact retry reserves one UUID/immutable commit; changed content/fences conflict, distinct mutations make distinct copies', async () => {
  const f = await fixture(), gate = deferred(), started = deferred(), original = f.storage.getMockImplementation()!
  f.storage.mockImplementationOnce(async (method, params) => { started.resolve(); await gate.promise; return original(method, params) })
  const params = f.params(), first = f.run(params), second = f.run(params)
  await started.promise
  await expect(f.run({ ...params, content: JSON.stringify(blank('Different')) })).rejects.toMatchObject({ code: 'MUTATION_CONFLICT' })
  await expect(f.run(params, undefined, { ...f.fence(), expectedRevision: 1 })).rejects.toMatchObject({ code: 'MUTATION_CONFLICT' })
  await expect(f.run(f.params('other-in-flight'))).rejects.toMatchObject({ code: 'BUSY' })
  gate.resolve(); expect(await first).toEqual(await second); expect(f.commits).toHaveLength(1)
  const next = await f.run(f.params('different-copy'))
  expect(next.result.documentHandle).not.toBe((await first).result.documentHandle); expect(f.commits).toHaveLength(2)
  expect(f.commits[0].document.id).not.toBe(f.commits[1].document.id)
})
it.each([{}, { workspace: 'read' }])('no write grant means no discovery or execution: %j', async scopes => {
  const f = await fixture(false, scopes as Record<string, string>)
  expect((await f.rpc('tools/list')).result.tools.some((tool: any) => tool.name === 'design_workspace_importCopy')).toBe(false)
  await expect(f.run()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(f.commits).toHaveLength(0)
})
it('rejects invalid schema, formats, base64/checksum, unsafe metadata and oversized content before storage', async () => {
  const f = await fixture(), before = snapshot(f)
  const invalid = [{ format: 'fig' }, { format: 'pdf' }, { content: '{' }, { content: '' }, { base64: 'AAAA' }, { format: 'fd', content: undefined, base64: 'not-base64' }, { format: 'fd', content: undefined, base64: 'AAAA' }, { path: '/private/file.fd' }, { url: 'https://example.com/file' }, { newDocumentId: f.source.id }, { document: f.source }, { content: 'x'.repeat(IMPORT_COPY_BYTES + 1) }, { content: JSON.stringify({ ...f.source, fdCompatibility: { contractVersion: 1, requiredCapabilities: ['unsupported'], extensions: {} } }) }]
  for (const [i, bad] of invalid.entries()) {
    const params: any = { ...f.params(`invalid-${i}`), ...bad }; if (params.content === undefined) delete params.content
    await expect(f.run(params)).rejects.toBeDefined()
  }
  expect(f.commits).toHaveLength(0); expect(snapshot(f)).toEqual(before)
})
it('foreign roots, document/session/revision fences, pending inputs, gestures and busy state fail without consuming source edits', async () => {
  const f = await fixture(), before = snapshot(f)
  await expect(f.run({ ...f.params(), rootHandle: 'foreign' })).rejects.toMatchObject({ code: 'WRONG_ROOT' })
  await expect(f.run(f.params(), undefined, { ...f.fence(), documentId: 'foreign' })).rejects.toMatchObject({ code: 'STALE_SESSION' })
  await expect(f.run(f.params(), undefined, { ...f.fence(), session: 99 })).rejects.toMatchObject({ code: 'STALE_SESSION' })
  await expect(f.run(f.params('stale'), undefined, { ...f.fence(), expectedRevision: 99 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const commit = vi.fn(() => true), stop = registerPendingEdit(f.editor, { dirty: () => true, commit })
  await expect(f.run(f.params('pending'))).rejects.toMatchObject({ code: 'PENDING_EDITS' }); stop(); expect(commit).not.toHaveBeenCalled()
  const gesture = vi.spyOn(f.editor, 'interactionActive', 'get').mockReturnValue(true)
  await expect(f.run(f.params('gesture'))).rejects.toMatchObject({ code: 'INTERACTION_ACTIVE' }); gesture.mockRestore()
  f.state.busy = true; await expect(f.run(f.params('busy'))).rejects.toMatchObject({ code: 'BUSY' }); f.state.busy = false
  expect(f.commits).toHaveLength(0); expect(snapshot(f)).toEqual(before)
})
it.each(['edit', 'session', 'root', 'revoke'])('rechecks %s after async preparation and never commits a stale prepared copy', async reason => {
  const f = await fixture(), original = f.dispatch.getMockImplementation()!, gate = deferred(), started = deferred()
  f.dispatch.mockImplementation(async (payload, signal) => { const result = await original(payload, signal); if (payload.hostOperation?.method === 'workspace.importCopy') { started.resolve(); await gate.promise }; return result })
  const running = f.run(); await started.promise
  if (reason === 'edit') f.editor.change('Newer edit', document => { document.name = 'Keep newer edit' })
  if (reason === 'session') f.editor.load(blank('New session'))
  if (reason === 'root') f.changeRoot()
  if (reason === 'revoke') f.host.revoke('import-owner')
  const rejected = expect(running).rejects.toBeDefined(); gate.resolve(); await rejected
  expect(f.commits).toHaveLength(0)
})
it.each(['edit', 'revoke', 'root', 'abort'])('retains committed receipt during %s at storage boundary; never reimports or publishes a revoked handle', async reason => {
  const f = await fixture(), original = f.storage.getMockImplementation()!, gate = deferred(), committed = deferred(), controller = new AbortController()
  f.storage.mockImplementationOnce(async (method, params) => { const result = await original(method, params); committed.resolve(); await gate.promise; return result })
  const params = f.params(), fences = f.fence(), running = f.run(params, controller.signal, fences)
  await committed.promise
  if (reason === 'edit') f.editor.change('After commit', document => { document.name = 'Keep later editor change' })
  if (reason === 'revoke') f.host.revoke('import-owner')
  if (reason === 'root') f.changeRoot()
  if (reason === 'abort') controller.abort(error('TIMEOUT'))
  if (reason === 'edit') { gate.resolve(); expect((await running).result.completion.status).toBe('committed'); expect(f.editor.state.doc.name).toBe('Keep later editor change'); expect((await f.run(params, undefined, fences)).result.completion.status).toBe('committed') }
  else { const rejected = expect(running).rejects.toThrow('was saved'); gate.resolve(); await rejected; expect(f.grant.handles.size).toBe(0) }
  expect(f.grant.receipts.get(params.mutationId).completion.status).toBe('committed'); expect(f.commits).toHaveLength(1)
})
it.each(['throw-after-commit', 'invalid-ack'])('unknown outcome %s retains reservation and blocks new-ID retry', async mode => {
  const f = await fixture(), original = f.storage.getMockImplementation()!
  f.storage.mockImplementationOnce(async (method, params) => { const saved = await original(method, params); if (mode === 'throw-after-commit') throw error('TIMEOUT'); return { ...saved, id: 'wrong-id' } })
  await expect(f.run()).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  await expect(f.run()).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  await expect(f.run(f.params('new-id'))).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  expect(f.grant.receipts.get('copy-one').completion.status).toBe('unknown'); expect(f.commits).toHaveLength(1); expect(f.rows.size).toBe(1); expect(f.grant.handles.size).toBe(0)
})
it('definitive storage rejection is not a commit; corrected new request can proceed without automatic retry', async () => {
  const f = await fixture()
  f.storage.mockRejectedValueOnce(error('INVALID_REQUEST'))
  await expect(f.run()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect(f.grant.receipts.get('copy-one').completion.status).toBe('rejected'); expect(f.commits).toHaveLength(0)
  await expect(f.run()).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  expect((await f.run(f.params('corrected'))).result.completion.status).toBe('committed'); expect(f.commits).toHaveLength(1)
})
it('append stays append-only and one undo removes imported groups', async () => {
  const f = await fixture(), api = createEditorDesignAutomation(f.editor); cleanup.push(() => api.dispose())
  const source = structuredClone(f.source); delete source.fdCompatibility
  const id = f.editor.state.doc.id, before = JSON.stringify(f.editor.state.doc)
  expect(api.execute({ method: 'document.import', params: { format: 'native-json', content: JSON.stringify(source) }, ...f.fence() }).ok).toBe(true)
  expect(f.editor.state.doc.id).toBe(id); expect(Object.keys(f.editor.state.doc.nodes).length).toBeGreaterThan(0)
  f.editor.undo(); expect(JSON.stringify(f.editor.state.doc)).toBe(before)
})
it.skipIf(!process.env.FUTUREOX_BACKEND_TEST_BINARY)('actual NDJSON + actual Editor/WASM + native SQLite readback stores one independent native copy', async () => {
  const f = await fixture(true), before = snapshot(f), first = await f.call()
  expect(first.isError).toBe(false)
  const id = f.host.resolve(f.grant, first.structuredContent.result.documentHandle, 'document')
  const saved = await f.sidecar.request('workspace.open', { id })
  expect(saved.document).toEqual({ ...f.source, id }); expect(saved.revision).toBe(1)
  expect(await f.call()).toEqual(first); expect(f.commits).toHaveLength(1)
  expect((await f.sidecar.request('workspace.list', {})).documents).toHaveLength(1)
  expect(snapshot(f)).toEqual(before)
})

it('large real NDJSON input and private renderer response exceed 8 MiB without leaking document content into metadata', async () => {
  const f = await fixture()
  ;(f.source as any).privateBody = 'x'.repeat(9 * 1024 * 1024)
  const response = await f.call()
  expect(response.isError).toBe(false)
  expect(JSON.stringify(response).length).toBeLessThan(4096)
  expect(f.commits[0].document.privateBody.length).toBe(9 * 1024 * 1024)
})
it('pure native storage admission never switches shared fonts or geometry epoch, including malformed native failures', async () => {
  const f = await fixture(), epoch = pickingGeometryEpoch(), activate = vi.spyOn(picking, 'activateDocumentFonts'), layout = vi.spyOn(picking, 'kernelLayout')
  expect((await f.run()).result.completion.verifiedReadback).toBe(true)
  await expect(f.run({ ...f.params('invalid-native'), content: JSON.stringify({ ...f.source, pages: [] }) })).rejects.toBeDefined()
  expect(activate).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(pickingGeometryEpoch()).toBe(epoch)
  expect(f.commits).toHaveLength(1)
})
it.each(['hash', 'contents', 'read-failure'])('acknowledged commit with %s mismatch is retained as committed-unverified, without a new-ID retry', async mode => {
  const f = await fixture(), original = f.storage.getMockImplementation()!
  f.storage.mockImplementation(async (method, params) => {
    const result = await original(method, params)
    if (method !== 'workspace.open') return result
    if (mode === 'read-failure') throw error('WORKSPACE_ERROR')
    if (mode === 'hash') return { ...result, hash: 'b'.repeat(64) }
    return { ...result, document: { ...result.document, name: 'Different bytes' } }
  })
  await expect(f.run()).rejects.toMatchObject({ code: 'IMPORT_COPY_COMMITTED_UNVERIFIED' })
  expect(f.grant.receipts.get('copy-one').completion).toMatchObject({ status: 'committed', verifiedReadback: false })
  await expect(f.run()).rejects.toMatchObject({ code: 'IMPORT_COPY_COMMITTED_UNVERIFIED' })
  await expect(f.run(f.params('new-id'))).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  expect(f.commits).toHaveLength(1); expect(f.grant.handles.size).toBe(0)
})
it('host refuses mismatched prepared UUID before storage, and receipt/handle limits precede preparation', async () => {
  const f = await fixture(), original = f.dispatch.getMockImplementation()!
  f.dispatch.mockImplementation(async (payload, signal) => { const result = await original(payload, signal); return payload.hostOperation.method === 'workspace.importCopy' ? { ...result, documentJson: JSON.stringify({ ...JSON.parse(result.documentJson), id: f.source.id }) } : result })
  await expect(f.run()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(f.commits).toHaveLength(0)
  const g = await fixture()
  for (let i = 0; i < 128; i++) g.grant.receipts.set(`reserved-${i}`, {})
  await expect(g.run()).rejects.toMatchObject({ code: 'RECEIPT_LIMIT' }); expect(g.dispatch).not.toHaveBeenCalled()
  const h = await fixture()
  for (let i = 0; i < 4096; i++) h.grant.handles.set(`handle-${i}`, {})
  await expect(h.run()).rejects.toMatchObject({ code: 'HANDLE_LIMIT' }); expect(h.dispatch.mock.calls.every(call => call[0].hostOperation.method === 'inspect')).toBe(true)
})
it('preserves embedded resources and leaves the existing active font environment untouched', async () => {
  const f = await fixture(), { fontTestBytes } = await import('../font-test-fixtures')
  f.source.fonts = { importedLatin: { family: 'Noto Sans SC Latin subset', data: fontTestBytes('noto-latin').toString('base64'), index: 0 } }
  const paint = f.rectangle.fills[0]
  paint.kind = 'image'; paint.image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const epoch = pickingGeometryEpoch(), before = snapshot(f)
  const response = await f.call()
  expect(response.isError).toBe(false)
  const id = f.host.resolve(f.grant, response.structuredContent.result.documentHandle, 'document')
  expect(f.rows.get(id).document).toEqual({ ...f.source, id }); expect(pickingGeometryEpoch()).toBe(epoch); expect(snapshot(f)).toEqual(before)
})
it('an imported handle follows the existing separately native-confirmed open, with cancellation preserving the current document', async () => {
  const f = await fixture(), imported = await f.run(), before = snapshot(f), confirm = vi.fn(async () => false)
  f.host.confirm = confirm
  const payload = f.payload({ rootHandle: f.grant.rootHandle, documentHandle: imported.result.documentHandle, mutationId: 'open-after-import' })
  payload.request.method = 'workspace.open'
  await expect(f.host.execute(payload, new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(confirm).toHaveBeenCalledWith('workspace.open', expect.objectContaining({ documentHandle: imported.result.documentHandle }))
  expect(f.adapterExecute).not.toHaveBeenCalled(); expect(snapshot(f)).toEqual(before); expect(f.commits).toHaveLength(1)
})

async function sketchParams(f: Awaited<ReturnType<typeof fixture>>, mutationId = 'sketch-copy') {
  const { exportSketchDocument } = await import('./sketch')
  return { rootHandle: f.grant.rootHandle, format: 'sketch', base64: exportSketchDocument(f.source).base64, mutationId }
}
it('Sketch NDJSON copy preserves full decoder graph and bounded warnings through exact retry without editor/font/layout effects', async () => {
  const f = await fixture(), { fontTestBytes } = await import('../font-test-fixtures')
  f.source.fonts = { embedded: { family: 'Noto Sans SC Latin subset', data: fontTestBytes('noto-latin').toString('base64'), index: 0 } }
  f.rectangle.fills[0].kind = 'image'
  f.rectangle.fills[0].image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
  const master = node('frame'), instance = node('frame')
  master.component = { variants: {}, properties: {} }
  instance.instance = { componentId: master.id, overrides: {}, propertyValues: {} }
  f.source.nodes[master.id] = master; f.source.nodes[instance.id] = instance
  f.source.pages[0].children.push(master.id, instance.id)
  const params = await sketchParams(f)
  const { decodeSketchImportCopy } = await import('./sketch')
  const expected = decodeSketchImportCopy(params.base64)
  expect(Object.keys(expected.document.fonts ?? {})).toHaveLength(1)
  expect(Object.values(expected.document.nodes).some(node => node.fills.some(fill => fill.kind === 'image' && !!fill.image))).toBe(true)
  expect(Object.values(expected.document.nodes).some(node => !!node.component)).toBe(true)
  expect(Object.values(expected.document.nodes).some(node => !!node.instance)).toBe(true)
  f.editor.change('Keep dirty source', document => { document.name = 'Existing edit' }); f.state.dirty = true
  const before = snapshot(f), epoch = pickingGeometryEpoch(), activate = vi.spyOn(picking, 'activateDocumentFonts'), layout = vi.spyOn(picking, 'kernelLayout')
  const response = await f.call(params as any)
  expect(response.isError).toBe(false)
  const result = response.structuredContent.result, id = f.host.resolve(f.grant, result.documentHandle, 'document')
  expect(result).toMatchObject({ sourceFormat: 'sketch', fidelity: 'compatibility', lossless: false, activated: false, warnings: expected.warnings, completion: { verifiedReadback: true } })
  expect(f.rows.get(id).document).toEqual({ ...expected.document, id })
  expect(f.grant.receipts.get(params.mutationId).importReport.warnings).toEqual(expected.warnings)
  expect(await f.call(params as any)).toEqual(response); expect(f.commits).toHaveLength(1)
  expect(snapshot(f)).toEqual(before); expect(pickingGeometryEpoch()).toBe(epoch)
  expect(activate).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(f.adapterExecute).not.toHaveBeenCalled()
})
it('Sketch concurrent exact requests commit once; distinct mutations create distinct copies', async () => {
  const f = await fixture(), params = await sketchParams(f), gate = deferred(), started = deferred(), original = f.storage.getMockImplementation()!
  f.storage.mockImplementationOnce(async (method, input) => { started.resolve(); await gate.promise; return original(method, input) })
  const first = f.run(params as any), second = f.run(params as any); await started.promise
  await expect(f.run({ ...params, mutationId: 'other-in-flight' } as any)).rejects.toMatchObject({ code: 'BUSY' })
  gate.resolve(); expect(await first).toEqual(await second); expect(f.commits).toHaveLength(1)
  const next = await f.run({ ...params, mutationId: 'second-sketch-copy' } as any)
  expect(next.result.documentHandle).not.toBe((await first).result.documentHandle); expect(f.commits).toHaveLength(2)
})
it.each(['revoke', 'edit'])('Sketch preparation rechecks %s before storage', async reason => {
  const f = await fixture(), params = await sketchParams(f), original = f.dispatch.getMockImplementation()!, gate = deferred(), started = deferred()
  f.dispatch.mockImplementation(async (payload, signal) => { const result = await original(payload, signal); if (payload.hostOperation.method === 'workspace.importCopy') { started.resolve(); await gate.promise }; return result })
  const running = f.run(params as any); await started.promise
  if (reason === 'revoke') f.host.revoke('import-owner')
  else f.editor.change('Keep newer edit', document => { document.name = 'Newer edit' })
  const rejected = expect(running).rejects.toBeDefined(); gate.resolve(); await rejected; expect(f.commits).toHaveLength(0)
})
it('Sketch rejects invalid ZIP, noncanonical base64 and oversize before commit', async () => {
  const f = await fixture(), params = await sketchParams(f), before = snapshot(f)
  for (const [index, base64] of ['AAAA', 'UEsDBA==', 'UEsDBB==', 'A'.repeat(IMPORT_COPY_BYTES + 4)].entries())
    await expect(f.run({ ...params, base64, mutationId: `bad-sketch-${index}` } as any)).rejects.toBeDefined()
  expect(f.commits).toHaveLength(0); expect(snapshot(f)).toEqual(before)
})
it.each(['missing', 'unknown-code', 'oversize', 'fidelity'])('host rejects Sketch %s notice report rather than silently dropping it', async mode => {
  const f = await fixture(), params = await sketchParams(f), original = f.dispatch.getMockImplementation()!
  f.dispatch.mockImplementation(async (payload, signal) => {
    const result = await original(payload, signal)
    if (payload.hostOperation.method !== 'workspace.importCopy') return result
    if (mode === 'missing') return { ...result, warnings: undefined }
    if (mode === 'fidelity') return { ...result, lossless: true }
    return { ...result, warnings: [...result.warnings, { code: mode === 'unknown-code' ? 'UNKNOWN' : 'SKETCH_CODEC_NOTICE', message: mode === 'oversize' ? 'x'.repeat(16385) : 'notice' }] }
  })
  await expect(f.run(params as any)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }); expect(f.commits).toHaveLength(0)
})
it('Sketch readback failure retains committed warning receipt and blocks unsafe retry', async () => {
  const f = await fixture(), params = await sketchParams(f), original = f.storage.getMockImplementation()!
  f.storage.mockImplementation(async (method, input) => { if (method === 'workspace.open') throw error('WORKSPACE_ERROR'); return original(method, input) })
  await expect(f.run(params as any)).rejects.toMatchObject({ code: 'IMPORT_COPY_COMMITTED_UNVERIFIED' })
  await expect(f.run(params as any)).rejects.toMatchObject({ code: 'IMPORT_COPY_COMMITTED_UNVERIFIED' })
  await expect(f.run({ ...params, mutationId: 'unsafe-new-id' } as any)).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  expect(f.grant.receipts.get(params.mutationId).importReport).toMatchObject({ sourceFormat: 'sketch', lossless: false, warnings: expect.arrayContaining([expect.objectContaining({ code: 'SKETCH_COMPATIBILITY' })]) })
  expect(f.commits).toHaveLength(1); expect(f.grant.handles.size).toBe(0)
})
it.skipIf(!process.env.SKETCH_FIXTURE || !process.env.FUTUREOX_BACKEND_TEST_BINARY)('real117 Sketch actual NDJSON + native SQLite readback matches shared decoder including full containers/resources and warning receipt', async () => {
  const { readFile } = await import('node:fs/promises'), { createHash } = await import('node:crypto')
  const bytes = await readFile(process.env.SKETCH_FIXTURE!)
  expect(bytes.length).toBe(5013257)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('d494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70')
  const f = await fixture(true), { import_sketch_json } = await import('../generated/design-kernel/design_kernel'), { decodeSketchImportCopy } = await import('./sketch')
  const decoded = JSON.parse(import_sketch_json(bytes)), expected = decodeSketchImportCopy(bytes.toString('base64'))
  const before = snapshot(f), epoch = pickingGeometryEpoch(), activate = vi.spyOn(picking, 'activateDocumentFonts'), layout = vi.spyOn(picking, 'kernelLayout')
  const params = { rootHandle: f.grant.rootHandle, format: 'sketch', base64: bytes.toString('base64'), mutationId: 'real117-sketch' }
  const response = await f.call(params as any)
  expect(response.isError).toBe(false)
  const result = response.structuredContent.result, id = f.host.resolve(f.grant, result.documentHandle, 'document')
  const saved = await f.sidecar.request('workspace.open', { id, revision: 1 })
  const { admitDocumentSync } = await import('../document-admission')
  const admitted = admitDocumentSync({ ...decoded.document, id })
  expect(saved.document).toEqual(admitted)
  expect(saved.document.designSystem?.sketchContainers).toEqual(admitted.designSystem?.sketchContainers)
  const negativeZeros = (value: any): number => Object.is(value, -0) ? 1 : value && typeof value === 'object' ? Object.values(value).reduce<number>((sum, child) => sum + negativeZeros(child), 0) : 0
  const normalizationChanges: { path: string; before: string; after: string }[] = []
  const compareRaw = (raw: any, normalized: any, path = '$') => {
    if (Object.is(raw, normalized)) return
    if (raw && normalized && typeof raw === 'object' && typeof normalized === 'object') {
      expect(Object.keys(raw).sort()).toEqual(Object.keys(normalized).sort())
      for (const key of Object.keys(raw)) compareRaw(raw[key], normalized[key], `${path}.${key}`)
      return
    }
    // Only JSON's documented -0 -> 0 normalization is allowed. Any other
    // decoder/admission value change, missing field or resource loss fails.
    expect(Object.is(raw, -0), path).toBe(true)
    expect(Object.is(normalized, 0), path).toBe(true)
    normalizationChanges.push({ path, before: '-0', after: '0' })
  }
  compareRaw({ ...decoded.document, id }, admitted)
  expect(admitted).toEqual(JSON.parse(JSON.stringify({ ...decoded.document, id })))
  expect(saved.document.nodes).toEqual(admitted.nodes)
  expect(saved.document.designSystem).toEqual(admitted.designSystem)
  const evidence = { archiveBytes: bytes.length, decodedJsonBytes: Buffer.byteLength(JSON.stringify(decoded.document)), savedJsonBytes: Buffer.byteLength(JSON.stringify(saved.document)), nodes: Object.keys(saved.document.nodes).length, sourceNegativeZeros: negativeZeros(decoded.document), admittedNegativeZeros: negativeZeros(admitted), normalizationChanges, containers: Object.keys(saved.document.designSystem?.sketchContainers ?? {}), warnings: result.warnings, storageRevision: saved.revision, verifiedReadback: result.completion.verifiedReadback }
  if (process.env.SKETCH_COPY_EVIDENCE) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(process.env.SKETCH_COPY_EVIDENCE, JSON.stringify(evidence, null, 2))
  }
  expect(saved.document.fonts).toEqual(decoded.document.fonts)
  expect(result).toMatchObject({ sourceFormat: 'sketch', fidelity: 'compatibility', lossless: false, warnings: expected.warnings, activated: false, completion: { verifiedReadback: true } })
  expect(result.warnings.filter((notice: any) => notice.code === 'SKETCH_CODEC_NOTICE').map((notice: any) => notice.message)).toEqual(decoded.warnings)
  expect(await f.call(params as any)).toEqual(response); expect(f.commits).toHaveLength(1)
  expect((await f.sidecar.request('workspace.list', {})).documents).toHaveLength(1)
  expect(snapshot(f)).toEqual(before); expect(pickingGeometryEpoch()).toBe(epoch)
  expect(activate).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(f.adapterExecute).not.toHaveBeenCalled()
}, 120000)
it.skipIf(!process.env.FIG_FIXTURE)('real user FIG mislabeled as Sketch is rejected without storage or activation', async () => {
  const { readFile } = await import('node:fs/promises'), bytes = await readFile(process.env.FIG_FIXTURE!)
  expect(bytes.length).toBeGreaterThan(0)
  const f = await fixture(), before = snapshot(f)
  for (const format of ['sketch']) {
    const response = await f.call({ rootHandle: f.grant.rootHandle, format, base64: bytes.toString('base64'), mutationId: `real-fig-as-${format}` } as any)
    expect(response.isError).toBe(true)
  }
  expect(f.commits).toHaveLength(0); expect(snapshot(f)).toEqual(before); expect(f.adapterExecute).not.toHaveBeenCalled()
})
