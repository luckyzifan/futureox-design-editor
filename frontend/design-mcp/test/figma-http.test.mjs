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

async function post(url, body, authorization) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
    body: JSON.stringify(body),
  })
}

test('loopback check rejects other addresses', () => {
  assert.equal(loopbackAddressAllowed('127.0.0.1'), true)
  assert.equal(loopbackAddressAllowed('::1'), true)
  assert.equal(loopbackAddressAllowed('::ffff:127.0.0.1'), true)
  assert.equal(loopbackAddressAllowed('10.0.0.8'), false)
})

test('HTTP server refuses a public bind, missing token, and then serves one authorized session', async t => {
  await assert.rejects(() => startLoopbackFigmaMcp({ backend: facade(), token, host: '0.0.0.0' }), /loopback/)
  const server = await startLoopbackFigmaMcp({ backend: facade(), token, host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  const anonymous = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(anonymous.status, 401)
  const wrong = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'Bearer not-the-token')
  assert.equal(wrong.status, 401)
  const init = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cursor', version: '1' } } }, `Bearer ${token}`)
  assert.equal(init.status, 200)
  const initialized = await init.json()
  assert.equal(initialized.result.protocolVersion, '2025-11-25')
  const note = await post(server.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, `Bearer ${token}`)
  assert.equal(note.status, 202)
  const list = await post(server.url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, `Bearer ${token}`)
  const tools = await list.json()
  assert.ok(tools.result.tools.some(tool => tool.name === 'use_figma'))
  const call = await post(server.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_selection', arguments: {} } }, `Bearer ${token}`)
  const selected = await call.json()
  assert.equal(selected.result.isError, false)
  assert.match(selected.result.content[0].text, /node-1/)
  const get = await fetch(server.url, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(get.status, 405)
})
