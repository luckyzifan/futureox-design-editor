import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Sidecar } from '../src/sidecar.mjs'
import { WorkspaceAutomationHost } from '../src/workspace-automation.mjs'
import { OperationBackend } from '../../design-mcp/src/operation-backend.mjs'
import { DesignMcpServer } from '../../design-mcp/src/server.mjs'

// This test uses real MCP JSON-RPC byte streams, the production native capability
// facade, the production stdio Sidecar, and actual SQLite. The editor adapter is
// deterministic; actual Editor/DesktopSession guards are tested in the client.
test('MCP tools/list/call reaches root-bound workspace CAS and history in real temporary SQLite', { skip: !process.env.FUTUREOX_BACKEND_TEST_BINARY }, async t => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'futureox-workspace-mcp-'))
  const options = { workspaceDb: path.join(directory, 'workspace.sqlite3'), catalogDb: path.join(directory, 'catalog.sqlite3') }
  let sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), options)
  t.after(async () => { await sidecar.stop(); await rm(directory, { recursive: true, force: true }) })
  const corpus = JSON.parse(await readFile(new URL('../../../testing/fixtures/design/precision-corpus.json', import.meta.url), 'utf8'))
  let document = structuredClone(corpus.cases[0].document); document.id = randomUUID(); document.name = 'MCP SQLite first'
  const seed = await sidecar.request('workspace.commit', { document, expectedRevision: null, mutationId: randomUUID() })
  const state = { documentId: document.id, session: 0, revision: 0, storageRevision: seed.revision, dirty: false, busy: false, pendingEdits: false, interactionActive: false }
  const settings = { snap: true, shortcutProfile: 'figma-like' }; let settingsRevision = 0, confirmations = 0
  const root = {}, owner = randomUUID()
  const host = new WorkspaceAutomationHost({ getRoot: () => root, status: () => ({ displayName: 'Temporary test workspace', isDefault: false, canSwitch: true }),
    select: async () => assert.fail('No directory picker in this non-GUI test'), activate: async () => assert.fail('No restart in this test'),
    storage: (method, params) => sidecar.request(method, params), confirm: async () => { confirmations++; return true },
    dispatch: async (payload, signal) => {
      assert(!signal.aborted)
      const { method, params } = payload.hostOperation
      if (method === 'inspect') return { ...state }
      if (method === 'settings.get') return { settingsRevision, values: { ...settings }, persistence: 'available' }
      if (method === 'settings.update') {
        if (settingsRevision !== params.expectedSettingsRevision) throw Object.assign(new Error('Settings changed'), { code: 'SETTINGS_REVISION_CONFLICT' })
        Object.assign(settings, params.patch); settingsRevision++
        return { settingsRevision, values: { ...settings }, persistence: 'available' }
      }
      if (method === 'workspace.save') {
        const saved = await sidecar.request('workspace.commit', { document, expectedRevision: params.expectedStorageRevision, mutationId: params.mutationId })
        state.storageRevision = saved.revision; state.dirty = false; return saved
      }
      if (method === 'workspace.restore') {
        const restored = await sidecar.request('workspace.restore', { id: params.id, revision: params.revision, expectedRevision: params.expectedStorageRevision, mutationId: params.mutationId })
        document = restored.document; state.storageRevision = restored.revision; return restored
      }
      if (method === 'workspace.open') {
        const opened = await sidecar.request('workspace.open', { id: params.id }); document = opened.document; state.storageRevision = opened.revision
        return { id: opened.id, revision: opened.revision, opened: true }
      }
      assert.fail(`Unexpected host operation ${method}`)
    } })
  await host.grant(owner, { workspace: 'write', settings: 'write' })
  const backend = new OperationBackend({ capabilities: { version: 1, methods: host.methods(owner) }, scope: 'read', grants: { workspace: 'write', settings: 'write' }, target: { documentId: document.id, session: 0 },
    execute: (request, context) => host.execute({ kind: 'execute', request, sessionId: owner, scope: 'read', documentId: state.documentId, session: 0, deadline: Date.now() + 15000 }, context.signal ?? new AbortController().signal) })
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough(), replies = new Map(); let buffer = '', nextId = 0
  diagnostics.resume()
  output.on('data', bytes => { buffer += bytes.toString(); let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const response = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); replies.get(response.id)?.(response); replies.delete(response.id) } })
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId, timer = setTimeout(() => reject(new Error('MCP response timed out')), 20000); replies.set(id, value => { clearTimeout(timer); resolve(value) }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
  assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workspace-sqlite-test', version: '1' } })).result.protocolVersion, '2025-11-25')
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const catalog = (await rpc('tools/list')).result.tools
  assert.equal(catalog.length, 11)
  assert(catalog.every(tool => !JSON.stringify(tool).includes('filePath')))
  const call = async (method, params = {}, fences = {}) => {
    const response = await rpc('tools/call', { name: `design_${method.replaceAll('.', '_')}`, arguments: { params, ...(method.match(/\.(save|open|restore|update|select|activate)$/) ? { documentId: state.documentId, session: 0, expectedRevision: state.revision } : {}), ...fences } })
    assert.equal(response.error, undefined); return response.result
  }
  const read = async (method, params) => { const response = await call(method, params); assert.equal(response.isError, false, JSON.stringify(response)); return response.structuredContent.result }
  const rootInfo = await read('workspace.root.status'), base = { rootHandle: rootInfo.rootHandle }
  const listing = await read('workspace.list', { ...base, limit: 10 }); assert.equal(listing.documents.length, 1)
  const documentHandle = listing.documents[0].documentHandle
  assert.equal(JSON.stringify(listing).includes(document.id), false)
  document = { ...document, name: 'MCP SQLite second' }; state.revision++; state.dirty = true
  const mutationId = randomUUID(), saveParams = { ...base, expectedStorageRevision: 1, mutationId }
  const saved = await read('workspace.save', saveParams); assert.equal(saved.storageRevision, 2)
  assert.deepEqual(await read('workspace.save', saveParams), saved)
  const conflict = await call('workspace.save', { ...base, expectedStorageRevision: 1, mutationId: randomUUID() })
  assert.equal(conflict.isError, true)
  assert.match(JSON.stringify(conflict), /STORAGE_REVISION_CONFLICT/)
  const history = await read('workspace.revisions', { ...base, documentHandle }); assert.equal(history.revisions.length, 2)
  const first = history.revisions.find(row => row.storageRevision === 1)
  assert(first.revisionHandle)
  const restored = await read('workspace.restore', { ...base, revisionHandle: first.revisionHandle, expectedStorageRevision: 2, mutationId: randomUUID() }); assert.equal(restored.storageRevision, 3)
  assert.equal(document.name, 'MCP SQLite first'); assert.equal(confirmations, 1)
  await read('workspace.open', { ...base, documentHandle, mutationId: randomUUID() }); assert.equal(confirmations, 2)
  const preferences = await read('settings.get')
  const changed = await read('settings.update', { rootHandle: preferences.rootHandle, expectedSettingsRevision: preferences.settingsRevision, patch: { snap: false }, mutationId: randomUUID() })
  assert.equal(changed.values.snap, false)
  const invalid = await call('settings.update', { ...base, expectedSettingsRevision: changed.settingsRevision, patch: { shell: 'not allowed' }, mutationId: randomUUID() }); assert.equal(invalid.isError, true)
  const unknown = await call('workspace.revisions', { ...base, documentHandle: document.id }); assert.equal(unknown.isError, true)
  await sidecar.stop(); sidecar = new Sidecar(process.env.FUTUREOX_BACKEND_TEST_BINARY, path.join(directory, 'recovery'), options)
  const persisted = await sidecar.request('workspace.open', { id: document.id }); assert.equal(persisted.revision, 3); assert.equal(persisted.document.name, 'MCP SQLite first')
  assert.equal((await sidecar.request('workspace.revisions', { id: document.id })).revisions.length, 3)
  host.revoke(owner)
  assert.equal((await call('workspace.list', base)).isError, true)
  t.diagnostic(JSON.stringify({ transport: 'MCP NDJSON in-memory → production native host → production Sidecar stdio → real SQLite', tools: catalog.length, finalStorageRevision: persisted.revision, nativeConfirmations: confirmations, restartVerified: true, gui: false, sockets: false }))
})
