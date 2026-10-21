import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { LocalAutomationBridge, registerAutomationBridge } from '../src/automation-bridge.mjs'
import { APP_URL, assertSender } from '../src/security.mjs'

// Parser/security tests deliberately use an in-memory byte stream. Real socket
// ownership and permissions are tested separately in automation-bridge-socket.
class MemorySocket extends EventEmitter {
  destroyed = false
  writableLength = 0
  setTimeout() {}
  write(value) { this.emit('reply', JSON.parse(value)); return true }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close') } }
  end() { this.destroy() }
}
const methods = [
  { name: 'document.get', description: 'Read', inputSchema: {}, mutates: false },
  { name: 'node.create', description: 'Write', inputSchema: {}, mutates: true },
]
const editor = { documentId: 'doc-one', session: 3, name: 'Selected design', methods }
const caps = { capabilities: { version: 1, methods, limits: {}, unsupported: [] }, documentId: editor.documentId, session: editor.session, revision: 7 }
const request = (method = 'document.get') => ({ method, documentId: editor.documentId, session: editor.session, ...(method === 'node.create' ? { expectedRevision: 7 } : {}) })
function fixture(t, { scope = 'read', ...options } = {}) {
  const calls = [], journal = []
  const bridge = new LocalAutomationBridge({ dispatch: async payload => { calls.push(payload); return payload.kind === 'capabilities' ? caps : { ok: true, result: payload.request } }, onAudit: value => journal.push(value), ...options })
  bridge.setEditor(editor)
  const state = { scope, token: 'a'.repeat(64), sessionId: randomUUID(), editor: bridge.editor, sockets: new Set(), pending: new Set(), server: { close: cb => cb() } }
  bridge.active = state
  t.after(() => bridge.close())
  const socket = new MemorySocket()
  const replies = [], waiters = new Map()
  socket.on('reply', value => { replies.push(value); waiters.get(value.id)?.(value); waiters.delete(value.id) })
  bridge.accept(state, socket)
  let id = 0
  const send = (method, params, explicitId) => {
    const requestId = explicitId ?? `request-${++id}`
    const reply = new Promise(resolve => waiters.set(requestId, resolve))
    socket.emit('data', Buffer.from(`${JSON.stringify({ id: requestId, method, params })}\n`))
    return Object.assign(reply, { id: requestId })
  }
  const auth = (token = state.token) => send('capabilities', { protocolVersion: 1, sessionId: state.sessionId, token })
  return { bridge, state, socket, send, auth, calls, journal, replies }
}

test('in-memory framing authenticates exactly the explicitly selected capability', async t => {
  const good = fixture(t)
  const result = await good.auth()
  assert.equal(result.result.protocolVersion, 1)
  assert.equal(result.result.documentId, editor.documentId)
  assert.equal((await good.send('execute', request())).result.ok, true)
  assert.equal(good.calls.length, 2)
  const bad = fixture(t)
  assert.equal((await bad.auth('b'.repeat(64))).error.code, 'AUTH_FAILED')
  assert.equal(bad.calls.length, 0)
  assert.equal(bad.socket.destroyed, true)
})

test('in-memory rejects unauthenticated calls, read-only mutations and foreign sessions', async t => {
  const unauthenticated = fixture(t)
  assert.equal((await unauthenticated.send('execute', request())).error.code, 'AUTH_REQUIRED')
  const f = fixture(t); await f.auth()
  assert.equal((await f.send('execute', request('node.create'))).error.code, 'PERMISSION_DENIED')
  assert.equal((await f.send('execute', { ...request(), session: 99 })).error.code, 'STALE_SESSION')
  assert.equal((await f.send('execute', { ...request(), method: 'shell.execute' })).error.code, 'METHOD_NOT_FOUND')
  assert.equal((await f.send('execute', { ...request(), path: '/tmp/private' })).error.code, 'INVALID_REQUEST')
  assert.equal(f.calls.length, 1)
})

test('in-memory write grant requires explicit revision and preserves caller fences', async t => {
  const f = fixture(t, { scope: 'write' }); await f.auth()
  const { expectedRevision, ...missing } = request('node.create')
  assert.equal((await f.send('execute', missing)).error.code, 'REVISION_REQUIRED')
  const original = { ...request('node.create'), expectedRevision: 1, id: 'public-id', params: { title: 'not logged' } }
  assert.deepEqual((await f.send('execute', original)).result.result, original)
  assert.equal(f.journal.at(-1).status, 'ok')
  assert.equal(JSON.stringify(f.journal).includes('not logged'), false)
  assert.equal(JSON.stringify(f.bridge.status()).includes(f.state.token), false)
})

test('in-memory stale selection synchronously revokes connections and pending requests', async t => {
  const f = fixture(t); await f.auth()
  f.bridge.setEditor({ ...editor, session: editor.session + 1 })
  assert.equal(f.bridge.active, null)
  assert.equal(f.socket.destroyed, true)
  assert.equal(f.journal.at(-1).method, 'bridge.disable')
})

test('in-memory rejects excessive frames and rejects excessive responses without dropping the connection', async t => {
  const f = fixture(t, { frameBytes: 2048, dispatch: async payload => payload.kind === 'capabilities' ? caps : { result: 'x'.repeat(3000) } }); await f.auth()
  assert.equal((await f.send('execute', request())).error.code, 'FRAME_TOO_LARGE')
  assert.equal(f.socket.destroyed, false)
  f.socket.emit('data', Buffer.from('x'.repeat(2049)))
  assert.equal(f.socket.destroyed, true)
})

test('in-memory cancellation reaches an outstanding dispatch and timeout is bounded', async t => {
  let aborted = 0
  const f = fixture(t, { timeoutMs: 25, dispatch: async (payload, signal) => {
    if (payload.kind === 'capabilities') return caps
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason) }, { once: true }))
  } }); await f.auth()
  const pending = f.send('execute', request())
  await Promise.resolve()
  f.socket.emit('data', Buffer.from(`${JSON.stringify({ method: 'cancel', params: { requestId: pending.id } })}\n`))
  assert.equal((await pending).error.code, 'CANCELLED')
  assert.equal((await f.send('execute', request())).error.code, 'TIMEOUT')
  assert.equal(aborted, 2)
  assert.equal(f.bridge.status().pendingRequests, 0)
})

test('in-memory parser accepts split/coalesced frames and rejects duplicate IDs and concurrency overflow', async t => {
  const f = fixture(t, { dispatch: async payload => payload.kind === 'capabilities' ? caps : new Promise(() => {}) }); await f.auth()
  for (let i = 0; i < 8; i++) void f.send('execute', request())
  assert.equal((await f.send('execute', request())).error.code, 'BUSY')
  f.socket.emit('data', Buffer.from(JSON.stringify({ id: 'request-2', method: 'execute', params: request() }).slice(0, 10)))
  f.socket.emit('data', Buffer.from(JSON.stringify({ id: 'request-2', method: 'execute', params: request() }).slice(10) + '\n'))
  assert.equal(f.replies.at(-1).error.code, 'DUPLICATE_REQUEST')
})

test('IPC rejects wrong sender/subframe; UI enabling requires native confirmation and status never includes credentials', async t => {
  const handlers = new Map(), messages = []
  const frame = { url: APP_URL }
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame, send: (...args) => messages.push(args) } }
  let confirmations = 0
  const api = registerAutomationBridge({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getWindow: () => window, assertSender, dialog: { showMessageBox: async () => { confirmations++; return { response: 0 } } }, clipboard: { writeText: () => assert.fail('Cancelled grant must never copy credentials') } })
  t.after(() => api.close())
  const trusted = { sender: window.webContents, senderFrame: frame }
  const call = (method, value, event = trusted) => handlers.get(`design-desktop:automation-${method}`)(event, value)
  assert.throws(() => call('register', editor, { sender: {}, senderFrame: frame }), /Untrusted/)
  assert.throws(() => call('register', editor, { sender: window.webContents, senderFrame: { url: APP_URL } }), /Untrusted/)
  assert.deepEqual(call('register', editor), { status: 'ok' })
  assert.equal((await call('enable', { scope: 'write' })).enabled, false)
  assert.equal(confirmations, 1)
  assert.equal((await call('copy-connection')).copied, false)
  assert.equal(call('status').editor.documentId, editor.documentId)
  assert.equal('token' in call('status'), false)
  await call('disable')
})

test('in-memory large imports are narrow, one-at-a-time and release their byte reservation on cancellation', async t => {
  const f = fixture(t, { scope: 'write', dispatch: async payload => payload.kind === 'capabilities' ? caps : new Promise(() => {}) })
  f.state.editor.methods.push(...['font.import', 'document.import', 'batch.apply'].map(name => ({ name, description: 'Import', inputSchema: {}, mutates: true })))
  await f.auth()
  const data = 'x'.repeat(9 * 1024 * 1024)
  assert.equal((await f.send('execute', { ...request(), params: { data } })).error.code, 'FRAME_TOO_LARGE')
  const heavy = { ...request('node.create'), method: 'font.import', params: { data } }
  const first = f.send('execute', heavy)
  assert.ok(f.state.pendingBytes > 9 * 1024 * 1024)
  assert.equal((await f.send('execute', heavy)).error.code, 'BUSY')
  f.socket.emit('data', Buffer.from(`${JSON.stringify({ method: 'cancel', params: { requestId: first.id } })}\n`))
  assert.equal((await first).error.code, 'CANCELLED')
  assert.equal(f.state.pendingBytes, 0)
  const nested = { ...heavy, method: 'batch.apply', params: { operations: [{ method: 'batch.apply', params: { data } }, { method: 'font.import', params: {} }] } }
  assert.equal((await f.send('execute', nested)).error.code, 'FRAME_TOO_LARGE')
  const batch = f.send('execute', { ...heavy, method: 'batch.apply', params: { operations: [{ method: 'font.import', params: { data } }] } })
  f.socket.emit('data', Buffer.from(`${JSON.stringify({ method: 'cancel', params: { requestId: batch.id } })}\n`))
  assert.equal((await batch).error.code, 'CANCELLED')
  assert.equal(f.state.pendingBytes, 0)
})

test('in-memory document export alone can use the larger output envelope', async t => {
  const f = fixture(t, { dispatch: async payload => payload.kind === 'capabilities' ? caps : { ok: true, result: { content: 'x'.repeat(9 * 1024 * 1024) } } })
  f.state.editor.methods.push({ name: 'document.export', description: 'Export', inputSchema: {}, mutates: false })
  await f.auth()
  assert.equal((await f.send('execute', request())).error.code, 'FRAME_TOO_LARGE')
  const response = await f.send('execute', { ...request(), method: 'document.export' })
  assert.equal(response.result.ok, true)
  assert.equal(response.result.result.content.length, 9 * 1024 * 1024)
})

test('committed edit IPC records manual/automation metadata without a grant and rejects stale/duplicate records', async t => {
  const handlers = new Map(), records = [], frame = { url: APP_URL }
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame, send() {} } }
  const api = registerAutomationBridge({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getWindow: () => window, assertSender, dialog: {}, clipboard: {}, audit: async value => { records.push(value) } })
  t.after(() => api.close())
  const event = { sender: window.webContents, senderFrame: frame }
  const call = (method, value) => handlers.get(`design-desktop:automation-${method}`)(event, value)
  call('register', editor)
  assert.equal(call('status').enabled, false)
  const edit = { documentId: editor.documentId, session: editor.session, revision: 1, source: 'user', kind: 'edit', summary: 'Move\nlayer\u0000' }
  assert.equal(call('record-edit', edit).accepted, true)
  assert.equal(call('record-edit', edit).accepted, false)
  assert.equal(call('record-edit', { ...edit, revision: 2, source: 'automation', kind: 'undo', summary: 'API undo' }).accepted, true)
  assert.throws(() => call('record-edit', { ...edit, revision: 3, documentId: 'another-document' }), /Invalid committed edit/)
  assert.throws(() => call('record-edit', { ...edit, revision: 0 }), /Invalid committed edit/)
  assert.throws(() => call('record-edit', { ...edit, revision: 3, document: { content: 'not allowed' } }), /Invalid committed edit/)
  await api.close()
  assert.equal(records.length, 2)
  assert.deepEqual(records.map(record => [record.event, record.source, record.method, record.summary]), [['edit', 'user', 'editor.edit', 'Movelayer'], ['edit', 'automation', 'editor.undo', 'API undo']])
})

test('in-memory parser rejects malformed UTF-8 rather than replacing bytes inside valid JSON', async t => {
  const f = fixture(t); await f.auth()
  const prefix = Buffer.from('{"id":"utf8","method":"execute","params":{"method":"document.get","documentId":"doc-one","session":3,"params":{"value":"')
  f.socket.emit('data', Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), Buffer.from('"}}}\n')]))
  assert.equal(f.replies.at(-1).error.code, 'PARSE_ERROR')
  assert.equal(f.socket.destroyed, true)
  assert.equal(f.calls.length, 1)
})

test('renderer IPC replies require exactly one result or typed error', async t => {
  const handlers = new Map()
  const api = registerAutomationBridge({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getWindow: () => null, assertSender: () => {}, dialog: {}, clipboard: {} })
  t.after(() => api.close())
  const reply = value => handlers.get('design-desktop:automation-response')({}, value)
  for (const value of [{ requestId: 'one' }, { requestId: 'two', result: {}, error: { code: 'X', message: 'x' } }, { requestId: 'three', error: null }, { requestId: 'four', error: { code: 4, message: 'x' } }]) assert.throws(() => reply(value), { code: 'INVALID_RESPONSE' })
  assert.deepEqual(reply({ requestId: 'five', result: null }), { accepted: false })
  assert.deepEqual(reply({ requestId: 'six', error: { code: 'X', message: 'x' } }), { accepted: false })
})

test('large importCopy is standalone workspace-granted input only; it does not expand batch or output budgets', async t => {
  let imports = 0
  const descriptor = { name: 'workspace.importCopy', description: 'Import copy', grant: 'workspace', mutates: true, inputSchema: {} }
  const host = { methods: () => [descriptor], revoke() {}, execute: async () => { imports++; return { ok: true, result: { activated: false } } } }
  const f = fixture(t, { workspaceHost: host }); f.state.grants = { workspace: 'write' }
  await f.auth()
  const content = 'x'.repeat(9 * 1024 * 1024)
  const result = await f.send('execute', { ...request(), method: 'workspace.importCopy', expectedRevision: 7, params: { rootHandle: 'root', mutationId: 'copy', format: 'native-json', content } })
  assert.equal(result.result.ok, true); assert.equal(imports, 1)
  const batch = await f.send('execute', { ...request(), method: 'batch.apply', expectedRevision: 7, params: { operations: [{ method: 'workspace.importCopy', params: { content } }] } })
  assert.equal(batch.error.code, 'FRAME_TOO_LARGE'); assert.equal(imports, 1)
  f.state.grants = { workspace: 'read' }
  assert.equal((await f.send('execute', { ...request(), method: 'workspace.importCopy', expectedRevision: 7, params: {} })).error.code, 'PERMISSION_DENIED')
})
