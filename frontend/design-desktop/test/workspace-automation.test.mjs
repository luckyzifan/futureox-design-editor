import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WorkspaceAutomationHost, WORKSPACE_AUTOMATION_METHODS } from '../src/workspace-automation.mjs'
import { LocalAutomationBridge, registerAutomationBridge } from '../src/automation-bridge.mjs'
import { OperationBackend } from '../../design-mcp/src/operation-backend.mjs'

async function fixture(scopes = { workspace: 'write', settings: 'write' }, overrides = {}) {
  let root = { identity: 'root-one' }, confirmed = 0, writes = 0, settingsRevision = 0
  const state = { documentId: 'doc-one', session: 3, revision: 7, storageRevision: 2, dirty: false, busy: false, pendingEdits: false, interactionActive: false }
  const calls = [], rows = [{ id: 'doc-one', name: 'one', revision: 2, updatedAt: 1 }, { id: 'doc-two', name: 'two', revision: 5, updatedAt: 2 }]
  const values = { snap: true, scrollWheelZoom: false, shortcutProfile: 'figma-like' }
  const host = new WorkspaceAutomationHost({ getRoot: () => root, status: () => ({ displayName: 'Local', isDefault: false, canSwitch: true }),
    select: async () => ({ status: 'ok', selectionId: 'selected-root', displayName: 'Other', isDefault: false }), activate: async () => ({ restarting: true }),
    confirm: async () => { confirmed++; return true },
    storage: async (method, params) => { calls.push([method, params]); return method === 'workspace.list' ? { documents: rows } : { revisions: [{ id: params.id, name: 'old', revision: 1, updatedAt: 1 }], hasMore: false } },
    dispatch: async payload => { const { method, params } = payload.hostOperation; calls.push([method, params]); if (method === 'inspect') return { ...state }; if (method === 'settings.get') return { settingsRevision, values: { ...values }, persistence: 'available' };
      if (method === 'settings.update') { if (params.expectedSettingsRevision !== settingsRevision) throw Object.assign(new Error('settings changed'), { code: 'SETTINGS_REVISION_CONFLICT' }); Object.assign(values, params.patch); settingsRevision++; writes++; return { settingsRevision, values: { ...values }, persistence: 'available' } }
      writes++; return { id: params.id ?? state.documentId, name: 'saved', revision: 3, updatedAt: 3 }
    }, ...overrides })
  const grant = await host.grant('owner-one', scopes)
  const payload = (method, params = {}, extra = {}) => ({ kind: 'execute', sessionId: 'owner-one', scope: 'read', documentId: state.documentId, session: state.session, deadline: Date.now() + 10000,
    request: { method, params, documentId: state.documentId, session: state.session, ...(WORKSPACE_AUTOMATION_METHODS.find(m => m.name === method)?.mutates ? { expectedRevision: state.revision } : {}), ...extra } })
  const run = (method, params = {}, extra = {}) => host.execute(payload(method, params, extra), new AbortController().signal)
  return { host, grant, state, calls, rows, values, payload, run, counters: () => ({ confirmed, writes }), changeRoot: () => { root = {} } }
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code)

test('workspace grants are independent, default-deny and advertise exact bounded tools', async () => {
  const f = await fixture({ workspace: 'read' })
  assert.deepEqual(f.host.methods('owner-one').map(x => x.name), ['workspace.root.status', 'workspace.list', 'workspace.revisions'])
  const backend = new OperationBackend({ capabilities: { version: 1, methods: [ ...WORKSPACE_AUTOMATION_METHODS, { name: 'node.create', description: 'edit', mutates: true, inputSchema: { type: 'object' } } ] }, scope: 'read', grants: { workspace: 'write', settings: 'read' }, execute: () => {} })
  const names = backend.listTools().map(x => x.name)
  assert(names.includes('design_workspace_save')); assert(names.includes('design_settings_get'))
  assert(!names.includes('design_node_create')); assert(!names.includes('design_settings_update'))
  assert.equal(new OperationBackend({ capabilities: { version: 1, methods: WORKSPACE_AUTOMATION_METHODS }, execute: () => {} }).listTools().length, 0)
  await rejects(f.run('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision: 2, mutationId: 'save' }), 'PERMISSION_DENIED')
})

test('opaque handles stay bound to grant, owner, type and root with no paths or raw database IDs', async () => {
  const f = await fixture(), root = (await f.run('workspace.root.status')).result
  const listing = (await f.run('workspace.list', { rootHandle: root.rootHandle, limit: 1 })).result
  assert.equal(listing.documents.length, 1); assert(listing.nextCursor); assert(!('id' in listing.documents[0]))
  assert.equal(JSON.stringify(listing).includes('doc-one'), false)
  assert.equal((await f.run('workspace.list', { rootHandle: root.rootHandle, cursor: listing.nextCursor, limit: 1 })).result.documents[0].name, 'two')
  const other = await f.host.grant('owner-two', { workspace: 'write' })
  await rejects(f.run('workspace.list', { rootHandle: other.rootHandle }), 'WRONG_ROOT')
  await rejects(f.run('workspace.open', { rootHandle: root.rootHandle, documentHandle: 'doc-one', mutationId: 'open-raw' }), 'UNKNOWN_HANDLE')
  await rejects(f.run('workspace.open', { rootHandle: root.rootHandle, documentHandle: listing.nextCursor, mutationId: 'open-cursor' }), 'UNKNOWN_HANDLE')
  const foreign = f.host.issue(other, 'document', 'doc-two')
  await rejects(f.run('workspace.open', { rootHandle: root.rootHandle, documentHandle: foreign, mutationId: 'open-other' }), 'UNKNOWN_HANDLE')
  await rejects(f.run('workspace.list', { rootHandle: root.rootHandle, path: '/tmp/private' }), 'INVALID_PARAMS')
  f.changeRoot(); await rejects(f.run('workspace.list', { rootHandle: root.rootHandle }), 'WRONG_ROOT')
})

test('writes reject stale editor/storage state, drafts, gestures, busy state, dirty navigation and malformed settings', async () => {
  for (const [field, code] of [['pendingEdits', 'PENDING_EDITS'], ['interactionActive', 'INTERACTION_ACTIVE'], ['busy', 'BUSY']]) {
    const f = await fixture(); f.state[field] = true
    await rejects(f.run('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision: 2, mutationId: field }), code)
    assert.equal(f.counters().writes, 0)
  }
  const f = await fixture(), base = { rootHandle: f.grant.rootHandle }
  await rejects(f.run('workspace.save', { ...base, expectedStorageRevision: 2, mutationId: 'stale' }, { expectedRevision: 6 }), 'REVISION_CONFLICT')
  await rejects(f.run('workspace.save', { ...base, expectedStorageRevision: 1, mutationId: 'storage' }), 'STORAGE_REVISION_CONFLICT')
  const handle = (await f.run('workspace.root.status')).result.activeDocumentHandle
  f.state.dirty = true
  await rejects(f.run('workspace.open', { ...base, documentHandle: handle, mutationId: 'dirty' }), 'DIRTY_DOCUMENT')
  assert.equal(f.counters().confirmed, 0)
  for (const patch of [{ token: 'secret' }, { snap: 1 }, { shortcutProfile: 'arbitrary' }, {}, { __proto__: { snap: true } }]) await rejects(f.run('settings.update', { ...base, patch, expectedSettingsRevision: 0, mutationId: 'invalid' }), 'INVALID_PARAMS')
  assert.equal(f.counters().writes, 0)
})

test('native confirmations are cancelled or re-fenced before navigation, restore or restart', async () => {
  const f = await fixture(), base = { rootHandle: f.grant.rootHandle }
  const doc = (await f.run('workspace.root.status')).result.activeDocumentHandle
  const revision = (await f.run('workspace.revisions', { ...base, documentHandle: doc })).result.revisions[0].revisionHandle
  f.host.confirm = async () => false
  await rejects(f.run('workspace.restore', { ...base, revisionHandle: revision, expectedStorageRevision: 2, mutationId: 'decline' }), 'CANCELLED')
  assert.equal(f.counters().writes, 0)
  f.host.confirm = async () => { f.state.revision++; return true }
  await rejects(f.run('workspace.open', { ...base, documentHandle: doc, mutationId: 'changed' }), 'REVISION_CONFLICT')
  assert.equal(f.counters().writes, 0)
  f.host.confirm = async () => { f.host.revoke('owner-one'); return true }
  await rejects(f.run('workspace.open', { ...base, documentHandle: doc, mutationId: 'revoked' }), 'SESSION_CLOSED')
})

test('bounded mutation receipts deduplicate concurrent retries and retain uncertain outcomes', async () => {
  let release, saves = 0
  const f = await fixture(), original = f.host.dispatch
  f.host.dispatch = async payload => { if (payload.hostOperation.method === 'workspace.save') { saves++; await new Promise(resolve => { release = resolve }) }; return original(payload) }
  const params = { rootHandle: f.grant.rootHandle, expectedStorageRevision: 2, mutationId: 'same-save' }
  const first = f.run('workspace.save', params), second = f.run('workspace.save', params)
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal(saves, 1)
  await rejects(f.run('settings.update', { rootHandle: f.grant.rootHandle, patch: { snap: false }, expectedSettingsRevision: 0, mutationId: 'another-action' }), 'BUSY')
  release()
  assert.deepEqual(await first, await second)
  assert.deepEqual(await f.run('workspace.save', params), await first)
  await rejects(f.run('workspace.save', { ...params, expectedStorageRevision: 1 }), 'MUTATION_CONFLICT')
  assert.equal(saves, 1)
  const bad = await fixture({ workspace: 'write' }, { dispatch: async payload => { if (payload.hostOperation.method === 'inspect') return { ...f.state }; throw Object.assign(new Error('outcome unknown'), { code: 'TIMEOUT' }) } })
  const uncertain = { rootHandle: bad.grant.rootHandle, expectedStorageRevision: 2, mutationId: 'uncertain' }
  await rejects(bad.run('workspace.save', uncertain), 'TIMEOUT'); await rejects(bad.run('workspace.save', uncertain), 'TIMEOUT')
  assert.equal(bad.grant.receipts.size, 1)
})

test('settings CAS and idempotence apply to the same explicit scope without document write access', async () => {
  const f = await fixture({ settings: 'write' }), read = (await f.run('settings.get')).result
  const params = { rootHandle: read.rootHandle, patch: { snap: false, shortcutProfile: 'sketch-like' }, expectedSettingsRevision: read.settingsRevision, mutationId: 'settings-one' }
  const result = (await f.run('settings.update', params)).result
  assert.equal(result.values.snap, false); assert.equal(result.settingsRevision, 1)
  assert.deepEqual((await f.run('settings.update', params)).result, result)
  await rejects(f.run('settings.update', { ...params, mutationId: 'settings-two' }), 'SETTINGS_REVISION_CONFLICT')
  assert.equal(f.counters().writes, 1)
  f.host.revoke('owner-one'); await rejects(f.run('settings.get'), 'SESSION_CLOSED')
})

class MemorySocket extends EventEmitter {
  destroyed = false; writableLength = 0
  setTimeout() {}
  write(bytes) { this.emit('response', JSON.parse(bytes)); return true }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
  end() { this.destroy() }
}
test('actual native parser advertises and dispatches independent granted tools; document read cannot mutate', async t => {
  const f = await fixture(), methods = [ { name: 'document.get', description: 'Read', mutates: false, inputSchema: { type: 'object' } }, { name: 'node.create', description: 'Edit', mutates: true, inputSchema: { type: 'object' } } ]
  const bridge = new LocalAutomationBridge({ workspaceHost: f.host, dispatch: async () => ({ capabilities: { version: 1, methods }, ...f.state }) })
  bridge.setEditor({ documentId: f.state.documentId, session: f.state.session, name: 'one', methods })
  bridge.active = { sessionId: 'owner-one', scope: 'read', grants: { workspace: 'write', settings: 'write' }, token: 'a'.repeat(64), editor: bridge.editor, sockets: new Set(), pending: new Set(), server: { close: callback => callback() } }
  const socket = new MemorySocket(); bridge.accept(bridge.active, socket); t.after(() => bridge.close())
  let id = 0; const ask = (method, params) => new Promise(resolve => { socket.once('response', resolve); socket.emit('data', Buffer.from(JSON.stringify({ id: `rpc-${++id}`, method, params }) + '\n')) })
  const auth = await ask('capabilities', { protocolVersion: 1, sessionId: 'owner-one', token: bridge.active.token })
  assert(auth.result.capabilities.methods.some(method => method.name === 'workspace.save'))
  assert(!auth.result.capabilities.methods.some(method => method.name === 'node.create'))
  assert.equal((await ask('execute', f.payload('node.create').request)).error.code, 'PERMISSION_DENIED')
  assert.equal((await ask('execute', f.payload('workspace.root.status').request)).result.ok, true)
  bridge.setEditor({ documentId: 'another', session: 4, name: 'Other', methods })
  assert.equal(socket.destroyed, true); assert.equal(f.host.grants.has('owner-one'), false)
})


test('native grant prompt names the current root and independent scopes; cancelling keeps them disabled', async t => {
  const handlers = new Map(), prompts = [], root = {}, window = { isDestroyed: () => false, webContents: { send() {} } }
  const bridge = registerAutomationBridge({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getWindow: () => window, assertSender() {}, clipboard: {},
    dialog: { showMessageBox: async (_window, prompt) => { prompts.push(prompt); return { response: 0 } } },
    storage: async () => ({}), workspace: { getRoot: () => root, status: () => ({ displayName: 'Authorized root' }) } })
  t.after(() => bridge.close())
  const call = (method, value) => handlers.get(`design-desktop:automation-${method}`)({}, value)
  call('register', { documentId: 'doc', session: 0, name: 'Open document', methods: [] })
  assert.equal((await call('enable', { scope: 'read', workspaceScope: 'write', settingsScope: 'read' })).enabled, false)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].detail, /Authorized root/); assert.match(prompts[0].detail, /workspace: write/); assert.match(prompts[0].detail, /settings: read/)
  assert.equal(call('status').grants, undefined)
  await assert.rejects(call('enable', { scope: 'write', workspaceScope: 'shell' }), { code: 'INVALID_REQUEST' })
  assert.throws(() => call('register', { documentId: 'doc', session: 1, name: 'Forged', methods: [{ name: 'node.create', mutates: true, grant: 'workspace' }] }), { code: 'INVALID_EDITOR' })
})

test('root selection uses only native opaque staging and rechecks dirty state before activation', async () => {
  let selected = 0, activated = 0
  const f = await fixture({ workspace: 'write' }, { select: async useDefault => { selected++; assert.equal(useDefault, true); return { status: 'ok', selectionId: 'native-selection', displayName: 'Default', isDefault: true } }, activate: async selectionId => { activated++; assert.equal(selectionId, 'native-selection'); return { status: 'ok', restarting: true } } })
  const base = { rootHandle: f.grant.rootHandle }
  await rejects(f.run('workspace.root.select', { ...base, path: '/arbitrary', mutationId: 'path' }), 'INVALID_PARAMS')
  const picked = (await f.run('workspace.root.select', { ...base, useDefault: true, mutationId: 'pick' })).result
  assert.equal(selected, 1); assert(!JSON.stringify(picked).includes('native-selection'))
  assert.deepEqual((await f.run('workspace.root.select', { ...base, useDefault: true, mutationId: 'pick' })).result, picked); assert.equal(selected, 1)
  f.state.dirty = true
  await rejects(f.run('workspace.root.activate', { ...base, selectionHandle: picked.selectionHandle, mutationId: 'dirty-restart' }), 'DIRTY_DOCUMENT')
  assert.equal(activated, 0); f.state.dirty = false
  assert.equal((await f.run('workspace.root.activate', { ...base, selectionHandle: picked.selectionHandle, mutationId: 'restart' })).result.restarting, true)
  assert.equal(activated, 1)
})

test('list cursors reject a changed database snapshot and backend root errors do not disclose paths', async () => {
  const f = await fixture(), base = { rootHandle: f.grant.rootHandle }
  const listing = (await f.run('workspace.list', { ...base, limit: 1 })).result
  f.rows[0].revision++
  await rejects(f.run('workspace.list', { ...base, cursor: listing.nextCursor, limit: 1 }), 'STALE_CURSOR')
  f.host.verifyRoot = async () => { throw new Error('ENOENT /private/location/workspace.db') }
  await assert.rejects(f.run('workspace.list', base), error => error.code === 'WORKSPACE_ROOT_STALE' && !error.message.includes('/private'))
})

test('mutation schema and runtime use the exact v5 ASCII identity grammar before reserving receipts', async () => {
  const f = await fixture()
  const schema = WORKSPACE_AUTOMATION_METHODS.find(method => method.name === 'workspace.save').inputSchema.properties.mutationId
  const pattern = new RegExp(schema.pattern)
  for (const mutationId of ['', 'save:1', 'save.1', 'space id', 'é', 'x'.repeat(129), null, 7]) {
    assert.equal(typeof mutationId === 'string' && pattern.test(mutationId), false)
    await rejects(f.run('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision: 2, mutationId }), 'INVALID_PARAMS')
  }
  assert.equal(f.grant.receipts.size, 0); assert.equal(f.counters().writes, 0)
  for (const mutationId of ['A-z_09', 'x'.repeat(128)]) assert.equal(pattern.test(mutationId), true)
  await f.run('workspace.save', { rootHandle: f.grant.rootHandle, expectedStorageRevision: 2, mutationId: 'x'.repeat(128) })
  assert.equal(f.counters().writes, 1)
})

test('history facade paginates all 1001 backend revisions in 100-row pages without omissions', async () => {
  const all = Array.from({ length: 1001 }, (_, index) => ({ id: 'doc-one', name: 'history', revision: 1001 - index, updatedAt: 1 }))
  const f = await fixture({ workspace: 'read' }, { storage: async (_method, params) => {
    const rows = all.filter(row => params.beforeRevision === undefined || row.revision < params.beforeRevision)
    return { revisions: rows.slice(0, 1000), hasMore: rows.length > 1000, nextBeforeRevision: rows.length > 1000 ? rows[999].revision : null }
  } })
  const documentHandle = (await f.run('workspace.root.status')).result.activeDocumentHandle
  const collected = []; let beforeRevision
  do {
    const page = (await f.run('workspace.revisions', { rootHandle: f.grant.rootHandle, documentHandle, ...(beforeRevision ? { beforeRevision } : {}) })).result
    assert(page.revisions.length <= 100); collected.push(...page.revisions.map(row => row.storageRevision))
    assert.equal(page.hasMore, page.nextBeforeRevision !== null)
    if (page.hasMore) assert.equal(page.nextBeforeRevision, page.revisions.at(-1).storageRevision)
    beforeRevision = page.nextBeforeRevision
  } while (beforeRevision)
  assert.deepEqual(collected, all.map(row => row.revision))
})
