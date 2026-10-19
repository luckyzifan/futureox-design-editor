import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer, PROTOCOL_VERSION } from '../src/server.mjs'

const descriptor = { name: 'design_inspect', description: 'Read real state', inputSchema: { type: 'object', properties: {} } }
const init = (id = 1, protocolVersion = PROTOCOL_VERSION) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } } })
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
function fixture(t, backend = {}, limits = {}) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  let bytes = '', logs = ''
  const messages = []
  output.on('data', chunk => { bytes += chunk; let index; while ((index = bytes.indexOf('\n')) !== -1) { messages.push(JSON.parse(bytes.slice(0, index))); bytes = bytes.slice(index + 1) } })
  diagnostics.on('data', chunk => { logs += chunk })
  const server = new DesignMcpServer({ input, output, diagnostics, limits, backend: { listTools: async () => [descriptor], callTool: async () => ({ ok: true, revision: 1, result: { name: 'Actual backend result' } }), ...backend } }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const send = message => input.write(JSON.stringify(message) + '\n')
  const wait = async (count = messages.length + 1) => { const end = Date.now() + 1000; while (messages.length < count) { if (Date.now() > end) throw new Error(`Expected ${count} messages, got ${messages.length}`); await delay(2) }; return messages.at(-1) }
  const ready = async () => { send(init()); await wait(1); send({ jsonrpc: '2.0', method: 'notifications/initialized' }) }
  return { input, messages, server, send, wait, ready, logs: () => logs }
}
test('initialization negotiates explicit pinned protocol and catalog is unavailable early', async t => {
  const f = fixture(t)
  f.send(request('early', 'tools/list'))
  assert.equal((await f.wait(1)).error.code, -32000)
  f.send(init('init', '2099-01-01'))
  const response = await f.wait(2)
  assert.equal(response.result.protocolVersion, '2025-11-25')
  assert.deepEqual(response.result.capabilities, { tools: {}, resources: {}, prompts: {} })
  f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  f.send(request('tools', 'tools/list'))
  assert.equal((await f.wait(3)).result.tools[0].name, descriptor.name)
})
test('ping works during lifecycle; duplicate initialization and reused IDs rejected', async t => {
  const f = fixture(t)
  f.send(request(0, 'ping')); assert.deepEqual((await f.wait(1)).result, {})
  f.send(init()); await f.wait(2)
  f.send(init(2)); assert.equal((await f.wait(3)).error.code, -32602)
  f.send(request(0, 'ping')); assert.equal((await f.wait(4)).error.code, -32600)
})
test('calls real injectable backend and preserves structured response and tool errors', async t => {
  const calls = []
  const f = fixture(t, { callTool: async (name, args, context) => { calls.push({ name, args, context }); return { ok: false, error: { code: 'stale_revision', message: 'Revision changed' }, revision: 4 } } })
  await f.ready()
  f.send(request(2, 'tools/call', { name: descriptor.name, arguments: { key: 'value' } }))
  const response = await f.wait(2)
  assert.equal(calls.length, 1); assert.equal(calls[0].context.requestId, 2)
  assert.deepEqual(calls[0].args, { key: 'value' })
  assert.equal(response.result.isError, true)
  assert.equal(response.result.structuredContent.error.code, 'stale_revision')
  assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent)
})
test('unknown tools, method and malformed arguments use protocol errors without dispatch', async t => {
  let count = 0
  const f = fixture(t, { callTool: async () => { count++; return {} } })
  await f.ready()
  const cases = [ ['tools/call', { name: 'does_not_exist' }, -32602], ['tools/call', { name: descriptor.name, arguments: [] }, -32602], ['tools/list', { cursor: 'invented' }, -32602], ['unknown', {}, -32601], ['tools/call', { name: descriptor.name, task: {} }, -32602] ]
  for (const [i, [method, params, code]] of cases.entries()) { f.send(request(i + 2, method, params)); assert.equal((await f.wait(i + 2)).error.code, code) }
  assert.equal(count, 0)
})
test('parse errors, invalid IDs, batches and invalid JSONRPC are bounded and recoverable', async t => {
  const f = fixture(t)
  for (const line of ['{', '[]', '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{"jsonrpc":"2.0","id":0.5,"method":"ping"}', '{"jsonrpc":"1.0","id":1,"method":"ping"}']) f.input.write(line + '\n')
  await f.wait(5)
  assert.deepEqual(f.messages.map(m => m.error.code), [-32700, -32600, -32600, -32600, -32600])
  assert.equal('id' in f.messages[0], false)
  f.send(request(100, 'ping')); assert.deepEqual((await f.wait(6)).result, {})
})
test('valid notifications never get replies or run tools', async t => {
  let calls = 0
  const f = fixture(t, { callTool: async () => { calls++; return {} } })
  await f.ready()
  f.send({ jsonrpc: '2.0', method: 'unknown' })
  f.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: descriptor.name } })
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'unknown' } })
  await delay(20)
  assert.equal(f.messages.length, 1); assert.equal(calls, 0)
})
test('cancellation propagates AbortSignal and suppresses reply', async t => {
  let signal, complete
  const f = fixture(t, { callTool: (_name, _args, context) => { signal = context.signal; return new Promise(resolve => { complete = resolve }) } })
  await f.ready()
  f.send(request('slow', 'tools/call', { name: descriptor.name }))
  while (!signal) await delay(1)
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } })
  assert.equal(signal.aborted, true)
  complete({ ok: true }); await delay(20)
  assert.equal(f.messages.length, 1)
})
test('timeouts abort work and expose uncertain mutation outcome', async t => {
  let signal
  const f = fixture(t, { callTool: (_name, _args, context) => { signal = context.signal; return new Promise(() => {}) } }, { requestTimeoutMs: 20 })
  await f.ready(); f.send(request('slow', 'tools/call', { name: descriptor.name }))
  const response = await f.wait(2)
  assert.equal(response.error.code, -32000)
  assert.match(response.error.message, /may already have committed/)
  assert.equal(signal.aborted, true)
})
test('session and concurrency limits prevent unbounded requests', async t => {
  const f = fixture(t, { callTool: () => new Promise(() => {}) }, { concurrentRequests: 1, sessionRequests: 3 })
  await f.ready(); f.send(request(2, 'tools/call', { name: descriptor.name })); await delay(5)
  f.send(request(3, 'tools/list')); assert.match((await f.wait(2)).error.message, /concurrent/)
  f.send(request(4, 'tools/list')); assert.match((await f.wait(3)).error.message, /Session request limit/)
})
test('resources expose actual backend tool schemas without filesystem access', async t => {
  const f = fixture(t); await f.ready()
  f.send(request(2, 'resources/list')); const list = await f.wait(2)
  f.send(request(3, 'resources/read', { uri: list.result.resources[0].uri }))
  const resource = await f.wait(3)
  assert.equal(JSON.parse(resource.result.contents[0].text).tools[0].name, descriptor.name)
  f.send(request(4, 'resources/read', { uri: 'file:///etc/passwd' })); assert.equal((await f.wait(4)).error.code, -32002)
})
test('oversized input and output fail boundedly without leaking partial data', async t => {
  const f = fixture(t, { callTool: async () => ({ ok: true, result: { data: 'x'.repeat(10000) } }) }, { messageBytes: 2048 })
  await f.ready()
  f.input.write('x'.repeat(3000) + '\n'); assert.equal((await f.wait(2)).error.code, -32000)
  f.send(request(2, 'tools/call', { name: descriptor.name })); assert.equal((await f.wait(3)).error.code, -32000)
  f.send(request(3, 'ping')); assert.deepEqual((await f.wait(4)).result, {})
})
test('EOF cancels pending operations, closes backend and stops accepting input', async t => {
  let closed = false, signal
  const f = fixture(t, { close: () => { closed = true }, callTool: (_name, _args, context) => { signal = context.signal; return new Promise(() => {}) } })
  await f.ready(); f.send(request(2, 'tools/call', { name: descriptor.name })); while (!signal) await delay(1)
  f.input.end(); await f.server.done
  assert.equal(closed, true); assert.equal(signal.aborted, true); assert.equal(f.server.phase, 'closed')
})
test('large import admission is method-scoped and only one heavy request can stay in flight', async t => {
  let release
  const heavyTool = { ...descriptor, name: 'design_font_import' }
  const f = fixture(t, { listTools: async () => [descriptor, heavyTool], callTool: async (_name, args) => new Promise(resolve => { release = () => resolve({ ok: true, result: { received: args.params.base64.length } }) }) }, { messageBytes: 8192, standardMessageBytes: 1024, pendingInputBytes: 4096 })
  await f.ready()
  f.send(request('ordinary', 'tools/call', { name: descriptor.name, arguments: { params: { base64: 'a'.repeat(1500) } } }))
  assert.match((await f.wait(2)).error.message, /Ordinary requests/)
  f.send(request('first', 'tools/call', { name: heavyTool.name, arguments: { params: { base64: 'a'.repeat(1500) } } }))
  while (!release) await delay(1)
  f.send(request('second', 'tools/call', { name: heavyTool.name, arguments: { params: { base64: 'b'.repeat(1500) } } }))
  assert.match((await f.wait(3)).error.message, /Pending input budget/)
  assert.equal(f.server.heavyRequests, 1)
  release(); assert.equal((await f.wait(4)).result.structuredContent.result.received, 1500)
  await delay(1)
  assert.equal(f.server.pendingBytes, 0); assert.equal(f.server.heavyRequests, 0)
})
test('prompts are discoverable with bounded, validated arguments', async t => {
  const f = fixture(t); await f.ready()
  f.send(request(2, 'prompts/list')); assert.equal((await f.wait(2)).result.prompts.length, 2)
  f.send(request(3, 'prompts/get', { name: 'design_generation', arguments: { brief: 'Create a dashboard' } }))
  assert.match((await f.wait(3)).result.messages[0].content.text, /finite client-side iteration budget/)
  f.send(request(4, 'prompts/get', { name: 'design_generation', arguments: { brief: 'x'.repeat(16001) } }))
  assert.equal((await f.wait(4)).error.code, -32602)
})
test('request IDs have a bounded retained size', async t => {
  const f = fixture(t)
  f.send(request('x'.repeat(257), 'ping'))
  const message = await f.wait(1)
  assert.equal(message.error.code, -32600); assert.equal('id' in message, false)
  assert.equal(f.server.seen.size, 0)
})

test('sequential already-drained large responses do not retain stale output charges', async t => {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  diagnostics.resume()
  const pending = new Map()
  output.on('data', chunk => { const response = JSON.parse(chunk.toString()); pending.get(response.id)?.(response); pending.delete(response.id) })
  const server = new DesignMcpServer({ input, output, diagnostics, limits: { queuedOutputBytes: 120000 }, backend: { listTools: () => [descriptor], callTool: () => ({ ok: true, result: { content: 'x'.repeat(90000) } }) } }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  let id = 0
  const rpc = (method, params) => new Promise(resolve => { const next = ++id; pending.set(next, resolve); input.write(JSON.stringify(request(next, method, params)) + '\n') })
  await rpc('initialize', init().params)
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  for (let i = 0; i < 3; i++) {
    const response = await rpc('tools/call', { name: descriptor.name })
    assert.equal(response.result.structuredContent.result.content.length, 90000)
    assert.equal(server.closed, false)
  }
  assert.equal(server.queuedBytes, 0)
})

test('undrained output still enforces the queue budget and closes boundedly', async t => {
  const input = new PassThrough(), diagnostics = new PassThrough()
  diagnostics.resume()
  const output = new Writable({ write(_chunk, _encoding, callback) { setTimeout(callback, 30) } })
  const server = new DesignMcpServer({ input, output, diagnostics, limits: { queuedOutputBytes: 50000 }, backend: { listTools: () => [], callTool: () => ({ ok: true, result: {} }) } }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const first = server.write({ jsonrpc: '2.0', id: 1, result: { value: 'x'.repeat(30000) } })
  await Promise.resolve()
  assert.ok(server.queuedBytes > 30000)
  await server.write({ jsonrpc: '2.0', id: 2, result: { value: 'y'.repeat(30000) } })
  assert.equal(server.closed, true)
  await first; await server.done
  assert.equal(server.queuedBytes, 0)
})

test('tools/call bounds model output and makes actual file bytes an explicit resources/read action', async t => {
  const base64 = Buffer.alloc(1024 * 1024, 7).toString('base64')
  const f = fixture(t, { callTool: () => ({ ok: true, method: 'sketch.export', result: { format: 'futureox.design-sketch.v1', mimeType: 'application/zip', encoding: 'base64', base64, lossless: false } }) })
  await f.ready(); f.send(request(2, 'tools/call', { name: descriptor.name }))
  const tool = await f.wait(2)
  assert.ok(Buffer.byteLength(JSON.stringify(tool)) < 256 * 1024)
  assert.equal(tool.result.structuredContent.result.base64, undefined)
  const uri = tool.result.structuredContent.result.resources[0].uri
  f.send(request(3, 'resources/read', { uri }))
  assert.equal((await f.wait(3)).result.contents[0].blob, base64)
  f.server.artifacts.clear()
  f.send(request(4, 'resources/read', { uri })); assert.equal((await f.wait(4)).error.code, -32002)
})

test('oversized unpageable output and uncacheable exports return bounded explicit errors without inline bytes', async t => {
  const payload = 'secret-payload-'.repeat(30000)
  const f = fixture(t, { callTool: (_name, args) => ({ ok: true, result: args.native ? { format: 'futureox.design-document.v1', mimeType: 'application/json', content: payload } : { nodes: [payload] } }) })
  await f.ready(); f.send(request(2, 'tools/call', { name: descriptor.name }))
  const query = await f.wait(2)
  assert.equal(query.result.structuredContent.error.code, 'result_too_large')
  assert.equal(JSON.stringify(query).includes('secret-payload'), false)
  f.server.artifacts.maxBytes = 100
  f.send(request(3, 'tools/call', { name: descriptor.name, arguments: { native: true } }))
  const file = await f.wait(3)
  assert.equal(file.result.structuredContent.error.code, 'artifact_unavailable')
  assert.match(file.result.structuredContent.error.message, /narrow or split/)
  assert.equal(JSON.stringify(file).includes('secret-payload'), false)
})
