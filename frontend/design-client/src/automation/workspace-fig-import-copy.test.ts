// Source-only candidate tests. Not executed; Worker and default storage are doubles.
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
import { pickingGeometryEpoch } from '../kernel/picking'
import * as picking from '../kernel/picking'
import { FIG_WARNINGS_TRUNCATED } from '../import-warnings'
// @ts-expect-error Shared native host is JavaScript without declarations.
import { WorkspaceAutomationHost } from '../../../design-desktop/src/workspace-automation.mjs'
import { OperationBackend } from '../../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../../design-mcp/src/server.mjs'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); FigWorker.instances = [] })
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
  const params = (mutationId = 'copy-one'): any => ({ rootHandle: grant.rootHandle, format: 'native-json', content: JSON.stringify(source), mutationId })
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

class FigWorker {
  static instances: FigWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  payload: any
  terminate = vi.fn()
  constructor() { FigWorker.instances.push(this) }
  postMessage(payload: unknown) { this.payload = payload }
  reply(result: unknown) { this.onmessage?.({ data: { result } } as MessageEvent) }
}
const figParams = (f: Awaited<ReturnType<typeof fixture>>, mutationId = 'fig-copy') => ({ rootHandle: f.grant.rootHandle, format: 'fig', base64: 'Zmln', mutationId })
async function waitingWorker() {
  await vi.waitFor(() => expect(FigWorker.instances).toHaveLength(1))
  return FigWorker.instances[0]
}

it('FIG NDJSON copy replaces format identity before admission and preserves graph/report across exact retry without editor effects', async () => {
  vi.stubGlobal('Worker', FigWorker)
  const f = await fixture(), { fontTestBytes } = await import('../font-test-fixtures')
  f.source.fonts = { embedded: { family: 'Noto Sans SC Latin subset', data: fontTestBytes('noto-latin').toString('base64'), index: 0 } }
  f.source.id = '11111111-1111-4111-8111-111111111111'
  const original = structuredClone(f.source), before = snapshot(f), epoch = pickingGeometryEpoch()
  const activate = vi.spyOn(picking, 'activateDocumentFonts'), layout = vi.spyOn(picking, 'kernelLayout')
  const params = figParams(f), fences = f.fence(), running = f.call(params, fences)
  const worker = await waitingWorker()
  expect(worker.payload).toMatchObject({ name: 'Imported FIG.fig', format: 'fig' })
  expect([...new Uint8Array(worker.payload.bytes)]).toEqual([102, 105, 103])
  worker.reply({ document: f.source, warnings: ['Unsupported source effect', FIG_WARNINGS_TRUNCATED], droppedOccurrences: 4 })
  const response = await running
  expect(response.isError).not.toBe(true)
  const envelope = response.structuredContent ?? JSON.parse(response.content[0].text)
  expect(envelope.ok).toBe(true)
  expect(envelope.result).toMatchObject({ sourceFormat: 'fig', fidelity: 'compatibility', lossless: false,
    activated: false, droppedOccurrences: 4, warnings: [{ code: 'FIG_COMPATIBILITY' }, { code: 'FIG_CODEC_NOTICE' }, { code: 'FIG_CODEC_NOTICE' }] })
  expect(await f.call(params, fences)).toEqual(response)
  expect(FigWorker.instances).toHaveLength(1); expect(f.commits).toHaveLength(1)
  const saved = f.commits[0].document
  expect(saved.id).toMatch(/^[0-9a-f-]{36}$/); expect(saved.id).not.toBe(original.id)
  expect(saved).toEqual({ ...original, id: saved.id }); expect(f.source).toEqual(original)
  expect(snapshot(f)).toEqual(before); expect(pickingGeometryEpoch()).toBe(epoch)
  expect(activate).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled(); expect(f.adapterExecute).not.toHaveBeenCalled()
  expect(worker.terminate).toHaveBeenCalledTimes(1)
})

it.each(['edit', 'session', 'busy', 'pending', 'gesture', 'root', 'revoke', 'cancel'] as const)(
  'FIG worker completion rechecks %s without writing storage', async reason => {
    vi.stubGlobal('Worker', FigWorker)
    const f = await fixture(), controller = new AbortController(), running = f.run(figParams(f), controller.signal)
    const codes = { edit: 'REVISION_CONFLICT', session: 'STALE_SESSION', busy: 'BUSY', pending: 'PENDING_EDITS', gesture: 'INTERACTION_ACTIVE', root: 'WRONG_ROOT', revoke: 'SESSION_CLOSED', cancel: 'CANCELLED' }
    const rejected = expect(running).rejects.toMatchObject({ code: codes[reason] }), worker = await waitingWorker()
    if (reason === 'edit') f.editor.change('User edit', doc => { doc.name = 'Keep new edit' })
    if (reason === 'session') f.editor.load(blank('Different document'))
    if (reason === 'busy') f.state.busy = true
    if (reason === 'pending') cleanup.push(registerPendingEdit(f.editor, { dirty: () => true, commit: () => { throw Error('Do not commit pending input') } }))
    if (reason === 'gesture') vi.spyOn(f.editor, 'interactionActive', 'get').mockReturnValue(true)
    if (reason === 'root') f.changeRoot()
    if (reason === 'revoke') f.host.revoke('import-owner')
    if (reason === 'cancel') controller.abort(error('CANCELLED'))
    worker.reply({ document: f.source, warnings: [] })
    await rejected
    expect(f.commits).toHaveLength(0); expect(f.adapterExecute).not.toHaveBeenCalled()
  },
)

it('FIG unknown durable outcome keeps its receipt and blocks a new mutation identity', async () => {
  vi.stubGlobal('Worker', FigWorker)
  const f = await fixture(), params = figParams(f)
  f.storage.mockImplementationOnce(async () => { throw error('CONNECTION_LOST') })
  const running = f.run(params), rejected = expect(running).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  const worker = await waitingWorker(); worker.reply({ document: f.source, warnings: [] })
  await rejected
  await expect(f.run(params)).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  await expect(f.run(figParams(f, 'new-id'))).rejects.toMatchObject({ code: 'IMPORT_COPY_OUTCOME_UNKNOWN' })
  expect(FigWorker.instances).toHaveLength(1); expect(f.storage).toHaveBeenCalledTimes(1)
})

it.each([
  { warnings: [FIG_WARNINGS_TRUNCATED] },
  { warnings: [], droppedOccurrences: 1 },
  { warnings: [FIG_WARNINGS_TRUNCATED], droppedOccurrences: 0 },
  { warnings: ['界'.repeat(342)] },
  { warnings: Array.from({ length: 129 }, (_, index) => `warning ${index}`) },
])('FIG malformed compatibility report is rejected before storage: %j', async report => {
  vi.stubGlobal('Worker', FigWorker)
  const f = await fixture(), running = f.run(figParams(f)), rejected = expect(running).rejects.toBeDefined()
  const worker = await waitingWorker(); worker.reply({ document: f.source, ...report })
  await rejected; expect(f.commits).toHaveLength(0)
})

it.each([
  { sourceFormat: 'sketch' }, { lossless: true }, { fidelity: 'lossless' },
  { droppedOccurrences: 1 },
  { warnings: [{ code: 'SKETCH_COMPATIBILITY', message: 'Not a FIG report' }] },
  { warnings: [{ code: 'FIG_COMPATIBILITY', message: '界'.repeat(342) }] },
])('native host rejects forged FIG prepared report before commit: %j', async patch => {
  const f = await fixture(), dispatch = f.dispatch.getMockImplementation()!
  f.dispatch.mockImplementation(async (payload, signal) => {
    if (payload.hostOperation.method !== 'workspace.importCopy') return dispatch(payload, signal)
    const id = payload.hostOperation.params.newDocumentId
    return { format: 'native-json', id, documentJson: JSON.stringify({ ...f.source, id }), sourceFormat: 'fig',
      fidelity: 'compatibility', lossless: false, warnings: [{ code: 'FIG_COMPATIBILITY', message: 'Compatibility only' }], ...patch }
  })
  await expect(f.run(figParams(f))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  expect(f.commits).toHaveLength(0)
})

it('concurrent exact FIG requests share worker, UUID, report and commit', async () => {
  vi.stubGlobal('Worker', FigWorker)
  const f = await fixture(), params = figParams(f), first = f.run(params), second = f.run(params)
  const worker = await waitingWorker()
  worker.reply({ document: f.source, warnings: [FIG_WARNINGS_TRUNCATED], droppedOccurrences: 7 })
  const [one, two] = await Promise.all([first, second])
  expect(one).toEqual(two); expect(one.result.droppedOccurrences).toBe(7)
  expect(f.grant.receipts.get(params.mutationId).importReport).toMatchObject({ droppedOccurrences: 7, sourceFormat: 'fig' })
  expect(FigWorker.instances).toHaveLength(1); expect(f.commits).toHaveLength(1)
})

it.skipIf(!process.env.FUTUREOX_REAL_FIG_TEST_FILE || !process.env.FUTUREOX_BACKEND_TEST_BINARY)(
  'actual user FIG parser reaches NDJSON host and real SQLite with identical prepared graph and exact retry', async () => {
    // This proves actual parser + protocol + SQLite, NOT a browser Worker runtime.
    const { readFileSync } = await import('node:fs')
    const { createHash } = await import('node:crypto')
    const { importFig } = await import('../import-fig')
    const bytes = readFileSync(process.env.FUTUREOX_REAL_FIG_TEST_FILE!)
    expect(bytes.byteLength).toBe(661892)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('3b2f071aebe931a1cfee60f04d5a1b49ea438dc9134ea628d584cce38949716c')
    let decoded: ReturnType<typeof importFig> | undefined
    class RealParserWorker extends FigWorker {
      override postMessage(payload: { bytes: ArrayBuffer; name: string }) {
        super.postMessage(payload)
        queueMicrotask(() => {
          try { decoded = importFig(new Uint8Array(payload.bytes), payload.name); this.reply(decoded) }
          catch (error) { this.onmessage?.({ data: { error: error instanceof Error ? error.message : String(error) } } as MessageEvent) }
        })
      }
    }
    vi.stubGlobal('Worker', RealParserWorker)
    const f = await fixture(true), before = snapshot(f), epoch = pickingGeometryEpoch()
    const activate = vi.spyOn(picking, 'activateDocumentFonts'), layout = vi.spyOn(picking, 'kernelLayout')
    const params = { ...figParams(f, 'actual-user-fig'), base64: bytes.toString('base64') }, fence = f.fence()
    const response = await f.call(params, fence)
    expect(response.isError).not.toBe(true)
    expect(decoded).toBeDefined()
    expect(f.commits).toHaveLength(1)
    const saved = f.commits[0].document
    expect(saved).toEqual({ ...decoded!.document, id: saved.id })
    expect(saved.id).not.toBe(decoded!.document.id)
    const opened = await f.sidecar.request('workspace.open', { id: saved.id, revision: 1 })
    expect(opened.document).toEqual(saved)
    expect(await f.call(params, fence)).toEqual(response)
    expect(f.commits).toHaveLength(1); expect(FigWorker.instances).toHaveLength(1)
    expect(snapshot(f)).toEqual(before); expect(pickingGeometryEpoch()).toBe(epoch)
    expect(activate).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled()
    expect(createHash('sha256').update(readFileSync(process.env.FUTUREOX_REAL_FIG_TEST_FILE!)).digest('hex'))
      .toBe('3b2f071aebe931a1cfee60f04d5a1b49ea438dc9134ea628d584cce38949716c')
  }, 60_000,
)
