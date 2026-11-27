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
    extensions: true,
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

test('figma-compatible mode accepts the published no-header loopback config and still rejects a wrong bearer', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), token, figmaCompatible: true, port: 0 })
  t.after(() => server.close())
  assert.equal(server.anonymous, true)
  const init = await post(server.url, initialize)
  assert.equal(init.status, 200)
  const sessionId = init.headers.get('mcp-session-id')
  assert.ok(sessionId)
  const headers = { 'mcp-session-id': sessionId, 'mcp-protocol-version': (await init.json()).result.protocolVersion }
  assert.equal((await post(server.url, initializedNote, undefined, headers)).status, 202)
  const list = await post(server.url, listRequest, undefined, headers)
  assert.equal(list.status, 200)
  assert.ok((await list.json()).result.tools.some(tool => tool.name === 'get_selection'))
  const wrong = await post(server.url, listRequest, 'Bearer not-the-token', headers)
  assert.equal(wrong.status, 401)
  const get = await fetch(server.url, { headers: { ...headers, accept: 'text/event-stream' } })
  assert.equal(get.status, 405)
})

test('figma-compatible mode can run without a token when a backend is injected', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), figmaCompatible: true, port: 0 })
  t.after(() => server.close())
  const init = await post(server.url, initialize)
  assert.equal(init.status, 200)
  assert.match(init.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
})

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

test('HTTP validates a tool session assertion against the current client before forwarding', async t => {
  const backend = facade()
  const execute = backend.execute
  const forwarded = []
  backend.execute = (request, context) => { forwarded.push(request); return execute(request, context) }
  const server = await startLoopbackFigmaMcp({ backend, token })
  t.after(() => server.close())
  const [first, second] = await Promise.all([openClient(server.url), openClient(server.url)])
  const request = { ...selectionRequest, params: { ...selectionRequest.params, arguments: { sessionId: first['mcp-session-id'] } } }
  const denied = (await (await post(server.url, request, authorization, second)).json()).result
  assert.equal(denied.isError, true)
  assert.equal(denied.structuredContent.error.code, 'invalid_local_session')
  assert.deepEqual(forwarded, [])
  const allowed = (await (await post(server.url, request, authorization, first)).json()).result
  assert.equal(allowed.isError, false)
  assert.deepEqual(forwarded.map(request => request.method), ['selection.get', 'node.get'])
  assert.ok(forwarded.every(request => !Object.hasOwn(request.params, 'sessionId')))
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

test('HTTP exposes all twenty local assets atomically as resources in the exporting session', async t => {
  const backend = new FigmaFacade({
    methods: ['document.get', 'vector.export'].map(name => ({ name })),
    scope: 'read',
    execute: async request => ({
      ok: true, method: request.method, documentId: 'doc', session: 1, revision: 2,
      result: request.method === 'vector.export'
        ? { content: `<svg xmlns="http://www.w3.org/2000/svg"><title>${request.params.nodeIds[0]}</title></svg>` } : {},
    }),
  })
  const server = await startLoopbackFigmaMcp({ backend, token })
  t.after(() => server.close())
  const [exporter, peer] = await Promise.all([openClient(server.url), openClient(server.url)])
  const nodeIds = Array.from({ length: 20 }, (_, i) => `shape-${i}`)
  const response = await post(server.url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'download_assets', arguments: { nodeIds, defaultFormat: 'svg' },
  } }, authorization, exporter)
  const result = (await response.json()).result
  assert.equal(result.isError, false)
  assert.deepEqual(result.structuredContent.result.assets.map(asset => asset.nodeId), nodeIds)
  assert.ok(result.structuredContent.result.assets.every(asset => !Object.hasOwn(asset, 'base64')))
  const links = result.content.filter(item => item.type === 'resource_link')
  assert.equal(links.length, 20)
  for (const [i, artifact] of links.entries()) {
    const read = { jsonrpc: '2.0', id: 10 + i, method: 'resources/read', params: { uri: artifact.uri } }
    const own = await (await post(server.url, read, authorization, exporter)).json()
    assert.equal(own.result.contents[0].mimeType, 'image/svg+xml')
    assert.match(Buffer.from(own.result.contents[0].blob, 'base64').toString(), new RegExp(`<title>${nodeIds[i]}</title>`))
    if (i === 0) {
      const other = await (await post(server.url, read, authorization, peer)).json()
      assert.equal(other.error.code, -32002)
    }
  }
})

test('IPv6 loopback publishes its own reachable URL', async t => {
  const server = await startLoopbackFigmaMcp({ backend: facade(), token, host: '::1' })
  t.after(() => server.close())
  assert.match(server.url, /^http:\/\/\[::1\]:\d+\/mcp$/)
  const response = await fetch(server.url)
  assert.equal(response.status, 401)
})

test('single and batched PDF exports are resource links without inline images', async t => {
  const pdf = id => Buffer.from(`%PDF-1.4\n% ${id}\n%%EOF\n`).toString('base64')
  const backend = new FigmaFacade({
    methods: ['document.get', 'preview.capture'].map(name => ({ name })),
    scope: 'read',
    execute: async request => ({
      ok: true, method: request.method, documentId: 'doc', session: 1, revision: 2,
      result: request.method === 'preview.capture' && request.params.format === 'pdf'
        ? { format: 'futureox.design-preview.v1', mimeType: 'application/pdf',
            dataUrl: `data:application/pdf;base64,${pdf(request.params.nodeIds[0])}` } : {},
    }),
  })
  const server = await startLoopbackFigmaMcp({ backend, token })
  t.after(() => server.close())
  const headers = await openClient(server.url)
  let requestId = 2
  for (const nodeIds of [['one'], ['one', 'two']]) {
    const capture = { jsonrpc: '2.0', id: requestId++, method: 'tools/call', params: {
      name: 'download_assets', arguments: { nodeIds, defaultFormat: 'pdf' },
    } }
    const result = (await (await post(server.url, capture, authorization, headers)).json()).result
    assert.equal(result.isError, false)
    assert.equal(result.content.some(item => item.type === 'image'), false)
    const links = result.content.filter(item => item.type === 'resource_link')
    assert.equal(links.length, nodeIds.length)
    for (const [i, link] of links.entries()) {
      assert.match(link.name, /\.pdf$/)
      assert.equal(link.mimeType, 'application/pdf')
      const read = { jsonrpc: '2.0', id: requestId++, method: 'resources/read', params: { uri: link.uri } }
      const resource = await (await post(server.url, read, authorization, headers)).json()
      assert.equal(resource.result.contents[0].blob, pdf(nodeIds[i]))
    }
  }
})
