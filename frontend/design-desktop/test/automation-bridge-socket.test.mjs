import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { stat, access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalAutomationBridge, registerAutomationBridge, MAX_AUTOMATION_FRAME_BYTES } from '../src/automation-bridge.mjs'
import { assertSender, APP_URL } from '../src/security.mjs'
import { startLoopbackFigmaMcp } from '../../design-mcp/src/figma-http.mjs'

const methods = [
  { name: 'document.get', description: 'Read', inputSchema: {}, mutates: false },
  { name: 'node.create', description: 'Write', inputSchema: {}, mutates: true },
]
const editor = { documentId: 'doc-one', session: 3, name: 'Selected design', methods }
const capabilities = { capabilities: { version: 1, methods, limits: {}, unsupported: [] }, documentId: editor.documentId, session: editor.session, revision: 7 }
const payload = (method = 'document.get') => ({ method, documentId: editor.documentId, session: editor.session, ...(method === 'node.create' ? { expectedRevision: 7 } : {}) })

async function connect(config) {
  const socket = net.connect(config.endpoint)
  socket.on('error', () => {})
  await once(socket, 'connect')
  let buffer = '', serial = 0
  const waiting = new Map(), queued = []
  socket.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      if (waiting.has(value.id)) { waiting.get(value.id)(value); waiting.delete(value.id) }
      else queued.push(value)
    }
  })
  const send = (method, params) => {
    const id = `request-${++serial}`
    const result = new Promise(resolve => waiting.set(id, resolve))
    socket.write(`${JSON.stringify({ id, method, params })}\n`)
    return Object.assign(result, { id })
  }
  const auth = () => send('capabilities', { protocolVersion: 1, sessionId: config.sessionId, token: config.token })
  return { socket, send, auth, queued }
}
async function fixture(t, options = {}) {
  const dispatched = []
  const bridge = new LocalAutomationBridge({ dispatch: async (request, signal) => { dispatched.push(request); return request.kind === 'capabilities' ? capabilities : { ok: true, request: request.request } }, ...options })
  t.after(() => bridge.close())
  bridge.setEditor(editor)
  return { bridge, dispatched }
}

test('off by default; explicit session enable creates a private local endpoint and cleanup removes it', async t => {
  const { bridge } = await fixture(t)
  assert.equal(bridge.active, null)
  const config = await bridge.enable('read')
  assert.equal(config.scope, 'read')
  assert.equal(config.token.length, 64)
  if (process.platform !== 'win32') {
    assert.equal((await stat(config.endpoint)).mode & 0o777, 0o600)
    assert.equal((await stat(bridge.active.directory)).mode & 0o777, 0o700)
  }
  const client = await connect(config), handshake = await client.auth()
  assert.equal(handshake.result.protocolVersion, 1)
  assert.equal(handshake.result.sessionId, config.sessionId)
  assert.equal(handshake.result.documentId, editor.documentId)
  const closed = once(client.socket, 'close')
  await bridge.close(); await closed
  if (process.platform !== 'win32') await assert.rejects(access(config.endpoint))
})

test('a long Unicode temporary directory still permits a private socket and revocation', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bridge-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const temporaryRoot = path.join(directory, '工作'.repeat(35))
  await mkdir(temporaryRoot)
  const { bridge } = await fixture(t, { temporaryRoot })
  const config = await bridge.enable('read')
  assert.equal((await stat(bridge.active.directory)).mode & 0o777, 0o700)
  assert.equal((await stat(config.endpoint)).mode & 0o777, 0o600)
  const client = await connect(config)
  assert.equal((await client.auth()).result.documentId, editor.documentId)
  const closed = once(client.socket, 'close')
  await bridge.close()
  await closed
  await assert.rejects(access(config.endpoint))
})

test('rejects unauthenticated and incorrect capabilities without dispatching to the editor', async t => {
  const { bridge, dispatched } = await fixture(t)
  const config = await bridge.enable('read')
  const first = await connect(config)
  assert.equal((await first.send('execute', payload())).error.code, 'AUTH_REQUIRED')
  first.socket.destroy()
  const second = await connect({ ...config, token: '0'.repeat(64) })
  assert.equal((await second.auth()).error.code, 'AUTH_FAILED')
  second.socket.destroy()
  assert.equal(dispatched.length, 0)
})

test('read-only grant rejects writes, unknown methods, foreign session and unbounded authority', async t => {
  const { bridge, dispatched } = await fixture(t)
  const client = await connect(await bridge.enable('read')); await client.auth()
  assert.equal((await client.send('execute', payload())).result.ok, true)
  assert.equal((await client.send('execute', payload('node.create'))).error.code, 'PERMISSION_DENIED')
  assert.equal((await client.send('execute', { ...payload(), method: 'system.eval' })).error.code, 'METHOD_NOT_FOUND')
  assert.equal((await client.send('execute', { ...payload(), session: 4 })).error.code, 'STALE_SESSION')
  assert.equal((await client.send('execute', { ...payload(), path: '/etc/passwd' })).error.code, 'INVALID_REQUEST')
  assert.equal(dispatched.length, 2)
})

test('write calls require an observed revision and preserve all supplied fences', async t => {
  const { bridge } = await fixture(t)
  const client = await connect(await bridge.enable('write')); await client.auth()
  const { expectedRevision, ...unfenced } = payload('node.create')
  assert.equal((await client.send('execute', unfenced)).error.code, 'REVISION_REQUIRED')
  const request = { ...payload('node.create'), id: 'client-call', expectedRevision: 2, params: { name: 'Kept' } }
  assert.deepEqual((await client.send('execute', request)).result.request, request)
})

test('document/session replacement immediately revokes an existing connection', async t => {
  const { bridge } = await fixture(t)
  const config = await bridge.enable('read'), client = await connect(config); await client.auth()
  const closed = once(client.socket, 'close')
  bridge.setEditor({ ...editor, session: 4 })
  assert.equal(bridge.active, null)
  await closed
  const next = await bridge.enable('read')
  assert.notEqual(next.sessionId, config.sessionId)
  assert.notEqual(next.token, config.token)
})

test('timeouts and explicit cancellation abort renderer work and leave the connection usable', async t => {
  let aborted = 0
  const { bridge } = await fixture(t, { timeoutMs: 30, dispatch: async (request, signal) => {
    if (request.kind === 'capabilities') return capabilities
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(signal.reason) }, { once: true }))
  } })
  const client = await connect(await bridge.enable('read')); await client.auth()
  assert.equal((await client.send('execute', payload())).error.code, 'TIMEOUT')
  const cancelled = client.send('execute', payload())
  client.socket.write(`${JSON.stringify({ method: 'cancel', params: { requestId: cancelled.id } })}\n`)
  assert.equal((await cancelled).error.code, 'CANCELLED')
  assert.equal((await client.send('capabilities')).result.documentId, editor.documentId)
  assert.ok(aborted >= 1 && aborted <= 2)
})

test('frame limit closes oversize input and errors on oversize output', async t => {
  const { bridge } = await fixture(t, { frameBytes: 2048, dispatch: async request => request.kind === 'capabilities' ? capabilities : { value: 'x'.repeat(3000) } })
  const config = await bridge.enable('read'), client = await connect(config); await client.auth()
  assert.equal((await client.send('execute', payload())).error.code, 'FRAME_TOO_LARGE')
  const closed = once(client.socket, 'close')
  client.socket.write('x'.repeat(2049))
  await closed
  assert.equal(MAX_AUTOMATION_FRAME_BYTES, 32 * 1024 * 1024)
})

test('duplicate pending requests and concurrency overflow are rejected', async t => {
  const { bridge } = await fixture(t, { dispatch: async request => request.kind === 'capabilities' ? capabilities : new Promise(() => {}) })
  const client = await connect(await bridge.enable('read')); await client.auth()
  for (let i = 0; i < 8; i++) void client.send('execute', payload())
  const overflow = await client.send('execute', payload())
  assert.equal(overflow.error.code, 'BUSY')
  client.socket.write(`${JSON.stringify({ id: 'request-2', method: 'execute', params: payload() })}\n`)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(client.queued.length, 0, 'duplicate error resolves only its matching pending id')
})

test('IPC only binds the trusted main frame and menu enable is the only granting route', async t => {
  const handlers = new Map()
  const frame = { url: APP_URL }, window = { isDestroyed: () => false, webContents: { mainFrame: frame, send() {} } }
  const api = registerAutomationBridge({ ipcMain: { handle: (name, callback) => handlers.set(name, callback) }, getWindow: () => window, assertSender, dialog: {}, clipboard: {} })
  t.after(() => api.close())
  const bind = handlers.get('design-desktop:automation-register')
  assert.throws(() => bind({ sender: {}, senderFrame: frame }, editor), /Untrusted/)
  assert.throws(() => bind({ sender: window.webContents, senderFrame: { url: APP_URL } }, editor), /Untrusted/)
  assert.deepEqual(bind({ sender: window.webContents, senderFrame: frame }, editor), { status: 'ok' })
  assert.equal(handlers.has('design-desktop:automation-enable'), true)
  assert.equal(handlers.has('design-desktop:automation-status'), true)
  assert.equal(api.menu.label, 'Automation')
})

test('loopback HTTP rejects malformed UTF-8 before dispatching through a real desktop grant', async t => {
  const identity = { documentId: 'local-pin-proof', session: 12, revision: 5 }
  const methods = ['page.list', 'node.query'].map(name => ({
    name, description: 'Read local design', inputSchema: { type: 'object' }, mutates: false,
  }))
  const forwarded = []
  const bridge = new LocalAutomationBridge({ dispatch: async ({ kind, request }) => {
    if (kind === 'capabilities') {
      return { ...identity, capabilities: { version: 1, methods, limits: {}, unsupported: [] } }
    }
    assert.equal(request.method, 'page.list')
    forwarded.push(request.method)
    return { ok: true, ...identity, method: request.method, result: { pages: [{ id: 'page', name: '画板' }] } }
  } })
  t.after(() => bridge.close())
  bridge.setEditor({ documentId: identity.documentId, name: 'Local Unicode fixture', session: identity.session, methods })
  const { endpoint, sessionId, token } = await bridge.enable('read')
  const http = await startLoopbackFigmaMcp({ endpoint, sessionId, token })
  t.after(() => http.close())
  if (process.platform !== 'win32') assert.equal((await stat(endpoint)).isSocket(), true)

  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }
  const post = (body, extra = {}) => fetch(http.url, { method: 'POST', headers: { ...headers, ...extra }, body })
  const rpc = (method, id, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params })
  const initialize = rpc('initialize', 1, {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Local transport test', version: '1' },
  })
  const denied = await post(initialize)
  assert.equal(denied.status, 401)
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer')
  const authorization = `Bearer ${token}`
  async function open() {
    const response = await post(initialize, { authorization })
    assert.equal(response.status, 200)
    const session = response.headers.get('mcp-session-id')
    assert.ok(session)
    const active = {
      authorization,
      'mcp-session-id': session,
      'mcp-protocol-version': (await response.json()).result.protocolVersion,
    }
    assert.equal((await post(rpc('notifications/initialized'), active)).status, 202)
    return active
  }

  const first = await open()
  const second = await open()
  assert.notEqual(first['mcp-session-id'], second['mcp-session-id'])
  const activeSession = first['mcp-session-id']
  const metadata = rpc('tools/call', 2, {
    name: 'get_metadata', arguments: { sessionId: activeSession, fileKey: 'fixture-key' },
  })
  const foreign = (await (await post(metadata, second)).json()).result
  assert.equal(foreign.structuredContent.error.code, 'invalid_local_session')
  assert.deepEqual(forwarded, [])

  const [head, tail] = metadata.split('fixture-key')
  const invalid = Buffer.concat([Buffer.from(head), Buffer.from([0xc3, 0x28]), Buffer.from(tail)])
  const rejected = await post(invalid, first)
  assert.equal(rejected.status, 400)
  assert.equal((await rejected.json()).error.code, -32700)
  assert.deepEqual(forwarded, [])

  const recovered = (await (await post(metadata, first)).json()).result
  assert.equal(recovered.isError, false)
  assert.equal(recovered.structuredContent.result.pages[0].name, '画板')
  assert.deepEqual(forwarded, ['page.list'])
})
