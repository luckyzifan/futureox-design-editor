import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, chmod, rm, symlink, realpath } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { JsonLineReader } from '../src/framing.mjs'
import { SocketDesignBackend, validateEndpoint } from '../src/socket-backend.mjs'
import { parseOptions } from '../src/cli.mjs'

const capabilities = { version: 1, methods: [
  { name: 'document.inspect', description: 'Inspect document', inputSchema: { type: 'object', properties: {} }, mutates: false },
  { name: 'nodes.create', description: 'Create nodes', inputSchema: { type: 'object', properties: {} }, mutates: true },
], limits: {}, unsupported: [] }
const token = 'ephemeral-test-token-1234567890'
const sessionId = 'session-test'
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

async function bridge(t, { scope = 'write', execute, handshakeError } = {}) {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'design-mcp-test-'))
  await chmod(directory, 0o700)
  const endpoint = path.join(directory, 'bridge.sock')
  const sockets = new Set(), requests = [], cancellations = []
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    const reader = new JsonLineReader({ onError: () => socket.destroy(), onLine: async line => {
      const request = JSON.parse(line); requests.push(request)
      if (request.method === 'cancel') { cancellations.push(request.params.requestId); return }
      if (request.method === 'capabilities') {
        assert.deepEqual(request.params, { protocolVersion: 1, sessionId, token })
        socket.write(JSON.stringify(handshakeError ? { id: request.id, error: { code: 'unauthorized', message: `Rejected ${token}` } } : { id: request.id, result: { protocolVersion: 1, sessionId, scope, capabilities, documentId: 'document-1', session: 3, revision: 7 } }) + '\n')
      } else {
        const result = execute ? await execute(request.params) : { ok: true, method: request.params.method, documentId: 'document-1', session: 3, revision: 7, result: { source: 'bridge' } }
        if (result !== undefined && !socket.destroyed) socket.write(JSON.stringify({ id: request.id, result }) + '\n')
      }
    } })
    socket.on('data', bytes => reader.push(bytes))
  })
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  await chmod(endpoint, 0o600)
  return { endpoint, directory, requests, cancellations, server, sockets }
}

test('socket client authenticates once, uses actual operation boundary and fences reads', async t => {
  const host = await bridge(t)
  const backend = new SocketDesignBackend({ endpoint: host.endpoint, sessionId, token })
  t.after(() => backend.close())
  const tools = await backend.listTools()
  assert.equal(tools.length, 2)
  const result = await backend.callTool('design_document_inspect', {}, { requestId: 4 })
  assert.equal(result.result.source, 'bridge')
  assert.deepEqual(host.requests[1].params, { id: 4, method: 'document.inspect', params: {}, documentId: 'document-1', session: 3 })
  await backend.listTools()
  assert.equal(host.requests.filter(r => r.method === 'capabilities').length, 1)
})
test('socket client filters read scope and propagates cancellation without fake mutation', async t => {
  const host = await bridge(t, { scope: 'read', execute: async () => undefined })
  const backend = new SocketDesignBackend({ endpoint: host.endpoint, sessionId, token })
  t.after(() => backend.close())
  assert.equal((await backend.listTools()).length, 1)
  const controller = new AbortController()
  const pending = backend.callTool('design_document_inspect', {}, { signal: controller.signal })
  while (!host.requests.some(r => r.method === 'execute')) await new Promise(resolve => setTimeout(resolve, 1))
  controller.abort(new Error('cancelled'))
  await assert.rejects(pending, /cancelled/)
  while (!host.cancellations.length) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(host.cancellations[0], 'mcp-2')
})
test('socket connection errors redact the ephemeral token', async t => {
  const host = await bridge(t, { handshakeError: true })
  const backend = new SocketDesignBackend({ endpoint: host.endpoint, sessionId, token })
  t.after(() => backend.close())
  await assert.rejects(backend.listTools(), error => !error.message.includes(token) && error.message.includes('[redacted]'))
})
test('endpoint validation rejects public modes, symlinks, TCP and arbitrary Windows pipes', async t => {
  const host = await bridge(t)
  await validateEndpoint(host.endpoint)
  await chmod(host.endpoint, 0o666)
  await assert.rejects(validateEndpoint(host.endpoint), /owner-private/)
  await chmod(host.endpoint, 0o600)
  const alias = path.join(host.directory, 'alias.sock'); await symlink(host.endpoint, alias)
  await assert.rejects(validateEndpoint(alias), /symbolic/)
  await assert.rejects(validateEndpoint('http://127.0.0.1:1234'), /absolute/)
  await assert.rejects(validateEndpoint('\\\\.\\pipe\\untrusted', 'win32'), /Futureox/)
  await validateEndpoint('\\\\.\\pipe\\futureox-design-abc_123', 'win32')
})
test('stdio executable handshake, real socket forwarding and EOF shutdown keep stdout protocol-clean', async t => {
  const host = await bridge(t)
  const child = spawn(process.execPath, [cli, '--socket', host.endpoint, '--session', sessionId], { env: { ...process.env, FUTUREOX_DESIGN_BRIDGE_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const messages = []; let stderr = ''
  const reader = new JsonLineReader({ onLine: line => messages.push(JSON.parse(line)), onError: error => { throw error } })
  child.stdout.on('data', bytes => reader.push(bytes)); child.stderr.on('data', bytes => { stderr += bytes })
  const wait = async n => { const end = Date.now() + 3000; while (messages.length < n) { if (Date.now() > end) throw new Error(`CLI response timeout: ${stderr}`); await new Promise(resolve => setTimeout(resolve, 2)) }; return messages.at(-1) }
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } } })
  assert.equal((await wait(1)).result.protocolVersion, '2025-11-25')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal((await wait(2)).result.tools.length, 2)
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'design_document_inspect' } })
  assert.equal((await wait(3)).result.structuredContent.result.source, 'bridge')
  const exit = once(child, 'exit'); child.stdin.end()
  const [code] = await exit
  assert.equal(code, 0)
  assert.equal(stderr, '')
  assert.equal(messages.every(message => message.jsonrpc === '2.0'), true)
})
