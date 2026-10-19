import test from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'
import { SocketDesignBackend, validateEndpoint } from '../src/socket-backend.mjs'
import { JsonLineReader } from '../src/framing.mjs'
const token = 'ephemeral-token-never-echo-12345678'
const capabilities = { version: 1, methods: [{ name: 'document.inspect', description: 'Inspect', inputSchema: { type: 'object', properties: {} }, mutates: false }, { name: 'nodes.create', description: 'Create', inputSchema: { type: 'object', properties: {} }, mutates: true }] }
function fixture(t, { scope = 'write', execute, handshakeError, handshakeResult, timeoutMs = 1000 } = {}) {
  const messages = [], validations = []
  let stream
  const transport = {
    validateEndpoint: async endpoint => validations.push(endpoint),
    createConnection: ({ path }) => {
      assert.equal(path, '/private/bridge.sock')
      const reader = new JsonLineReader({ onError: error => { throw error }, onLine: line => {
        const request = JSON.parse(line); messages.push(request)
        if (request.method === 'cancel') return
        if (request.method === 'capabilities') {
          assert.equal(request.params.token, token)
          queueMicrotask(() => stream.push(JSON.stringify(handshakeError ? { id: request.id, error: { code: 'unauthorized', message: `Rejected ${token}` } } : { id: request.id, result: handshakeResult ?? { protocolVersion: 1, sessionId: 'sid', scope, capabilities, documentId: 'doc', session: 3, revision: 7 } }) + '\n'))
        } else {
          Promise.resolve(execute ? execute(request.params) : { ok: true, method: request.params.method, documentId: 'doc', session: 3, revision: 7, result: { source: 'shared operation boundary' } }).then(result => {
            if (result !== undefined && !stream.destroyed) stream.push(JSON.stringify({ id: request.id, result }) + '\n')
          })
        }
      } })
      stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { reader.push(chunk); callback() } })
      queueMicrotask(() => stream.emit('connect'))
      return stream
    },
  }
  const backend = new SocketDesignBackend({ endpoint: '/private/bridge.sock', sessionId: 'sid', token, transport, timeoutMs })
  t.after(() => backend.close())
  return { backend, messages, validations, stream: () => stream }
}
test('socket client framing authenticates once and forwards exact real-operation envelope', async t => {
  const f = fixture(t)
  assert.equal((await f.backend.listTools()).length, 2)
  const response = await f.backend.callTool('design_document_inspect', {}, { requestId: 42 })
  assert.equal(response.result.source, 'shared operation boundary')
  assert.deepEqual(f.messages[1].params, { id: 42, method: 'document.inspect', params: {}, documentId: 'doc', session: 3 })
  assert.deepEqual(f.validations, ['/private/bridge.sock'])
  await f.backend.listTools(); assert.equal(f.messages.filter(message => message.method === 'capabilities').length, 1)
})
test('read-scope descriptor filtering and abort notification use same authenticated connection', async t => {
  const f = fixture(t, { scope: 'read', execute: () => undefined })
  assert.equal((await f.backend.listTools()).length, 1)
  const controller = new AbortController()
  const response = f.backend.callTool('design_document_inspect', {}, { signal: controller.signal })
  while (f.messages.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  controller.abort(new Error('cancelled'))
  await assert.rejects(response, /cancelled/)
  assert.deepEqual(f.messages.at(-1), { method: 'cancel', params: { requestId: 'mcp-2' } })
  assert.equal(f.backend.pending.size, 0)
})
test('bridge errors cannot echo token and invalid sessions fail closed', async t => {
  const f = fixture(t, { handshakeError: true })
  await assert.rejects(f.backend.listTools(), error => !error.message.includes(token) && /redacted/.test(error.message))
  assert.equal(f.backend.closed, true)
  const g = fixture(t, { handshakeResult: { protocolVersion: 1, sessionId: 'wrong', scope: 'read', capabilities } })
  await assert.rejects(g.backend.listTools(), /handshake/)
  assert.equal(g.backend.closed, true)
})
test('timeouts cancel outstanding wire requests and release resources', async t => {
  const f = fixture(t, { execute: () => undefined, timeoutMs: 10 })
  await f.backend.listTools()
  await assert.rejects(f.backend.callTool('design_document_inspect', {}), /may have committed/)
  assert.equal(f.backend.pending.size, 0)
  assert.equal(f.messages.at(-1).method, 'cancel')
})
test('malformed peer output fails all pending work and closes connection', async t => {
  const f = fixture(t, { execute: () => undefined })
  await f.backend.listTools()
  const pending = f.backend.callTool('design_document_inspect', {})
  while (f.messages.length < 2) await new Promise(resolve => setTimeout(resolve, 1))
  f.stream().push('{bad}\n')
  await assert.rejects(pending, /Malformed/)
  assert.equal(f.backend.closed, true)
})
test('client rejects nonlocal endpoints and invalid configuration before connection', async () => {
  await assert.rejects(validateEndpoint('http://127.0.0.1:1234'), /absolute/)
  await assert.rejects(validateEndpoint('\\\\.\\pipe\\untrusted', 'win32'), /Futureox/)
  await validateEndpoint('\\\\.\\pipe\\futureox-design-abc_123', 'win32')
  assert.throws(() => new SocketDesignBackend({ endpoint: '/socket', sessionId: '', token }), /session/)
  assert.throws(() => new SocketDesignBackend({ endpoint: '/socket', sessionId: 'id', token: 'short' }), /token/)
})
