import test from 'node:test'
import assert from 'node:assert/strict'
import { FigmaFacade } from '../src/figma-facade.mjs'
import { loopbackAddressAllowed, startLoopbackFigmaMcp } from '../src/figma-http.mjs'

const token = 'ab'.repeat(16)

function facade() {
  const execute = async request => {
    if (request.method === 'selection.get') return { ok: true, method: request.method, documentId: 'doc', session: 1, revision: 2, result: { pageId: 'page', ids: ['node-1'] } }
    if (request.method === 'node.get') return { ok: true, method: request.method, documentId: 'doc', session: 1, revision: 2, result: { id: request.params.id, name: 'Label', kind: 'text', width: 20, height: 8, node: { id: request.params.id } } }
    return { ok: false, method: request.method, documentId: 'doc', session: 1, revision: 1, error: { code: 'missing', message: request.method } }
  }
  return new FigmaFacade({
    execute,
    methods: ['selection.get', 'node.get'].map(name => ({ name, description: 'Read', inputSchema: { type: 'object' }, mutates: false })),
    scope: 'read',
  })
}

async function post(url, body, authorization, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization } : {}), ...headers },
    body: JSON.stringify(body),
  })
}

test('loopback check rejects other addresses', () => {
  assert.equal(loopbackAddressAllowed('127.0.0.1'), true)
  assert.equal(loopbackAddressAllowed('::1'), true)
  assert.equal(loopbackAddressAllowed('::ffff:127.0.0.1'), true)
  assert.equal(loopbackAddressAllowed('10.0.0.8'), false)
})

const authorization = `Bearer ${token}`
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' },
} }
const initializedNote = { jsonrpc: '2.0', method: 'notifications/initialized' }
const listRequest = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
const selectionRequest = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_selection', arguments: {} } }

async function openClient(url, init = initialize) {
  const response = await post(url, init, authorization)
  assert.equal(response.status, 200)
  const id = response.headers.get('mcp-session-id')
  assert.ok(id)
  const version = (await response.json()).result.protocolVersion
  assert.equal(version, '2025-11-25')
  const headers = { 'mcp-session-id': id, 'mcp-protocol-version': version }
  assert.equal((await post(url, initializedNote, authorization, headers)).status, 202)
  return headers
}

test('HTTP server refuses public bind and serves only authorized clients with the negotiated session', async t => {
  await assert.rejects(() => startLoopbackFigmaMcp({ backend: facade(), token, host: '0.0.0.0' }), /loopback/)
  const server = await startLoopbackFigmaMcp({ backend: facade(), token, host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const anonymous = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer')
  const wrong = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'Bearer not-the-token')
  assert.equal(wrong.status, 401)
  const remoteOrigin = await post(server.url, initialize, `Bearer ${token}`, { origin: 'https://example.invalid' })
  assert.equal(remoteOrigin.status, 403)
  const init = await post(server.url, initialize, `Bearer ${token}`, { origin: new URL(server.url).origin })
  assert.equal(init.status, 200)
  const initialized = await init.json()
  assert.equal(initialized.result.protocolVersion, '2025-11-25')
  const sessionId = init.headers.get('mcp-session-id')
  assert.match(sessionId, /^[0-9a-f-]{36}$/)
  const headers = { 'mcp-session-id': sessionId }
  const note = await post(server.url, initializedNote, authorization, headers)
  assert.equal(note.status, 202)
  const badVersion = await post(server.url, listRequest, authorization, { ...headers, 'mcp-protocol-version': 'invalid' })
  assert.equal(badVersion.status, 400)
  const otherVersion = await post(server.url, listRequest, authorization, { ...headers, 'mcp-protocol-version': '2026-07-28' })
  assert.equal(otherVersion.status, 400)
  const list = await post(server.url, listRequest, authorization, { ...headers, 'mcp-protocol-version': '2025-11-25' })
  const tools = await list.json()
  assert.ok(tools.result.tools.every(tool => tool.annotations.readOnlyHint))
  const write = await post(server.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'use_figma', arguments: { description: 'Update selection', operations: [{ op: 'select', nodeIds: [] }] } } }, authorization, headers)
  assert.deepEqual((await write.json()).error, { code: -32602, message: 'Unknown tool name' })
  const call = await post(server.url, selectionRequest, authorization, headers)
  const selected = await call.json()
  assert.equal(selected.result.isError, false)
  assert.match(selected.result.content[0].text, /node-1/)
  const get = await fetch(server.url, { headers: { ...headers, authorization, accept: 'text/event-stream' } })
  assert.equal(get.status, 405)
})

test('two HTTP clients can initialize concurrently and use the same request IDs independently', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), token })
  t.after(() => server.close())
  const [first, second] = await Promise.all([openClient(server.url), openClient(server.url)])
  assert.notEqual(first['mcp-session-id'], second['mcp-session-id'])
  for (const headers of [first, second]) {
    const result = await (await post(server.url, listRequest, authorization, headers)).json()
    assert.ok(result.result.tools.some(tool => tool.name === 'get_selection'))
  }
  assert.equal((await post(server.url, selectionRequest, authorization)).status, 400)
  assert.equal((await post(server.url, initialize, authorization, first)).status, 400)
  const end = await fetch(server.url, { method: 'DELETE', headers: { authorization, ...first } })
  assert.equal(end.status, 204)
  assert.equal((await post(server.url, selectionRequest, authorization, first)).status, 404)
  const alive = await (await post(server.url, selectionRequest, authorization, second)).json()
  assert.match(alive.result.content[0].text, /node-1/)
})

test('a pending HTTP tool can be cancelled and grant revocation retires every client', async t => {
  const grant = new AbortController()
  let started, aborted
  const toolStarted = new Promise(resolve => { started = resolve })
  const toolAborted = new Promise(resolve => { aborted = resolve })
  const backend = {
    terminalSignal: grant.signal,
    listTools: () => facade().listTools(),
    callTool: (_name, _args, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => {
        aborted()
        resolve({ content: [] })
      }, { once: true })
      started()
    }),
  }
  const server = await startLoopbackFigmaMcp({ backend, token })
  t.after(() => server.close())
  const [first, second] = await Promise.all([openClient(server.url), openClient(server.url)])
  const active = post(server.url, selectionRequest, authorization, first)
  await toolStarted
  const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: selectionRequest.id } }
  assert.equal((await post(server.url, cancel, authorization, first)).status, 202)
  await toolAborted
  assert.equal((await active).status, 202)
  grant.abort()
  for (const headers of [first, second]) {
    assert.equal((await post(server.url, listRequest, authorization, headers)).status, 404)
  }
  assert.equal((await post(server.url, initialize, authorization)).status, 404)
})

test('HTTP body and session limits allow recovery without replacing another client', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), token })
  t.after(() => server.close())
  const oversize = await post(server.url, { ...initialize, extra: 'x'.repeat(1024 * 1024) }, authorization)
  assert.equal(oversize.status, 413)
  assert.equal((await oversize.json()).error.code, -32000)
  const clients = await Promise.all(Array.from({ length: 8 }, () => openClient(server.url)))
  const extra = await post(server.url, initialize, authorization)
  assert.equal(extra.status, 429)
  assert.equal((await fetch(server.url, { method: 'DELETE', headers: { authorization, ...clients[1] } })).status, 204)
  const replacement = await openClient(server.url)
  assert.ok(clients.every(headers => headers['mcp-session-id'] !== replacement['mcp-session-id']))
  assert.equal((await post(server.url, listRequest, authorization, clients[0])).status, 200)
})

test('IPv6 loopback publishes its own reachable URL', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), token, host: '::1' })
  t.after(() => server.close())
  assert.match(server.url, /^http:\/\/\[::1\]:\d+\/mcp$/)
  const response = await fetch(server.url)
  assert.equal(response.status, 401)
})
