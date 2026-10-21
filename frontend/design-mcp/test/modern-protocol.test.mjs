import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { DesignMcpServer } from '../src/server.mjs'
import { modernKeys as K, MODERN_PROTOCOL_VERSION as V } from '../src/modern-protocol.mjs'
const descriptor = { name: 'design_export', description: 'Fixture operation', inputSchema: { type: 'object' } }
const snapshot = () => ({ ok: true, method: 'document.export', revision: 1, result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content: '{"fixture":true}' } })
const meta = (name = 'client-a', capabilities = {}) => ({ [K.version]: V, [K.capabilities]: capabilities, [K.clientInfo]: { name, version: '1' } })
const request = (id, method, params = {}, metadata = meta()) => ({ jsonrpc: '2.0', id, method, params: { ...params, _meta: metadata } })
const initialize = id => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } })
const until = async predicate => { const end = Date.now() + 1500; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture condition timed out'); await delay(1) } }
function fixture(t, overrides = {}, limits = {}, outputOverride) {
  const input = new PassThrough(), output = outputOverride ?? new PassThrough(), diagnostics = new PassThrough()
  const messages = []; let buffered = ''; let toolCalls = 0, catalogCalls = 0
  const collect = chunk => { buffered += chunk; let i; while ((i = buffered.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffered.slice(0, i))); buffered = buffered.slice(i + 1) } }
  if (!outputOverride) output.on('data', collect)
  const backend = { listTools: async () => { catalogCalls++; return [descriptor] }, callTool: async () => { toolCalls++; return snapshot() }, ...overrides }
  const server = new DesignMcpServer({ backend, input, output, diagnostics, limits }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const send = value => input.write(JSON.stringify(value) + '\n')
  const wait = async count => { await until(() => messages.length >= count); return messages[count - 1] }
  return { server, input, send, wait, messages, collect, counts: () => ({ toolCalls, catalogCalls }) }
}

test('fresh modern calls need no discovery or initialize; identity/capabilities are request-local', async t => {
  const seen = []; let release
  const f = fixture(t, { callTool: async (_name, _args, context) => {
    seen.push(context.requestMetadata)
    if (context.requestMetadata.clientInfo.name === 'a') await new Promise(resolve => { release = resolve })
    return { ok: true, result: { identity: context.requestMetadata.clientInfo.name } }
  } })
  f.send(request('a', 'tools/call', { name: descriptor.name }, meta('a', { alpha: {} })))
  await until(() => release)
  f.send(request('b', 'tools/call', { name: descriptor.name }, meta('b', { beta: {} })))
  assert.equal((await f.wait(1)).result.structuredContent.result.identity, 'b')
  release(); assert.equal((await f.wait(2)).result.structuredContent.result.identity, 'a')
  assert.deepEqual(seen.map(s => s.clientCapabilities), [{ alpha: {} }, { beta: {} }])
  assert.notEqual(seen[0], seen[1]); assert.equal(f.server.phase, 'new')
})

test('discovery is static and does not call backend or consume its credential', async t => {
  const f = fixture(t, { listTools: () => { throw new Error('Discovery accessed backend') }, callTool: () => { throw new Error('Discovery mutated') } })
  f.send(request(1, 'server/discover'))
  const { result } = await f.wait(1)
  assert.deepEqual(result.supportedVersions, [V]); assert.equal(result.resultType, 'complete')
  assert.equal(result.ttlMs, 0); assert.equal(result.cacheScope, 'private')
  assert.equal(result._meta[K.serverInfo].name, 'futureox-design')
  assert.deepEqual(f.counts(), { toolCalls: 0, catalogCalls: 0 })
})

test('modern metadata is mandatory on every request and invalid requests cannot mutate', async t => {
  const f = fixture(t)
  f.send(request(1, 'server/discover')); await f.wait(1)
  const bad = [undefined, {}, { [K.version]: V }, { [K.version]: V, [K.capabilities]: [] }, { ...meta(), [K.clientInfo]: { name: 'x' } }, { ...meta(), [K.version]: 2026 }]
  for (const [i, metadata] of bad.entries()) {
    f.send({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: descriptor.name, ...(metadata === undefined ? {} : { _meta: metadata }) } })
    assert.equal((await f.wait(i + 2)).error.code, -32602)
  }
  f.send(request('unsupported', 'tools/call', { name: descriptor.name }, { ...meta(), [K.version]: '2099-01-01' }))
  const failure = await f.wait(8)
  assert.equal(failure.error.code, -32022); assert.deepEqual(failure.error.data, { requested: '2099-01-01', supported: [V] })
  assert.deepEqual(f.counts(), { toolCalls: 0, catalogCalls: 0 })
})

test('legacy and modern opening/initialized permutations do not cross era admission', async t => {
  const legacy = fixture(t)
  legacy.send({ jsonrpc: '2.0', id: 'early', method: 'tools/list' }); assert.equal((await legacy.wait(1)).error.code, -32000)
  legacy.send(initialize('init')); const initResult = (await legacy.wait(2)).result
  assert.equal(initResult.protocolVersion, '2025-11-25'); assert.equal('resultType' in initResult, false)
  legacy.send(request('mixed-before-ready', 'tools/call', { name: descriptor.name })); assert.equal((await legacy.wait(3)).error.code, -32602)
  legacy.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  legacy.send(request('mixed-after-ready', 'tools/call', { name: descriptor.name })); assert.equal((await legacy.wait(4)).error.code, -32602)
  assert.equal(legacy.counts().toolCalls, 0)
  legacy.send({ jsonrpc: '2.0', id: 'legacy-tool', method: 'tools/list' }); assert.equal('resultType' in (await legacy.wait(5)).result, false)
  const modern = fixture(t)
  modern.send(request('init', 'initialize', initialize(1).params)); assert.equal((await modern.wait(1)).error.code, -32601)
  modern.send(initialize('legacy-init')); assert.equal((await modern.wait(2)).error.code, -32602)
  modern.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  modern.send({ jsonrpc: '2.0', id: 'bare', method: 'tools/call', params: { name: descriptor.name } }); assert.equal((await modern.wait(3)).error.code, -32602)
  assert.equal(modern.server.phase, 'new'); assert.equal(modern.counts().toolCalls, 0)
})

test('malformed discovery does not pin era or invoke backend; valid legacy can follow', async t => {
  const f = fixture(t)
  f.send({ jsonrpc: '2.0', id: 1, method: 'server/discover' }); assert.equal((await f.wait(1)).error.code, -32602)
  assert.equal(f.server.era, 'undecided')
  f.send(initialize(2)); assert.equal((await f.wait(2)).result.protocolVersion, '2025-11-25')
  assert.equal(f.counts().catalogCalls, 0)
})

test('required cache hints and complete results; error envelopes stay JSON-RPC errors', async t => {
  const f = fixture(t)
  const cases = [['tools/list', {}], ['prompts/list', {}], ['resources/list', {}], ['resources/templates/list', {}], ['resources/read', { uri: 'futureox-design://automation/capabilities' }]]
  for (const [i, [method, params]] of cases.entries()) {
    f.send(request(i, method, params)); const value = (await f.wait(i + 1)).result
    assert.equal(value.resultType, 'complete'); assert.equal(value.ttlMs, 0); assert.equal(value.cacheScope, 'private')
  }
  f.send(request(8, 'tools/call', { name: descriptor.name })); const tool = (await f.wait(6)).result
  assert.equal(tool.resultType, 'complete'); assert.equal('ttlMs' in tool, false)
  f.send(request(9, 'prompts/get', { name: 'design_generation', arguments: { brief: 'fixture' } })); const prompt = (await f.wait(7)).result
  assert.equal(prompt.resultType, 'complete'); assert.equal('ttlMs' in prompt, false)
  f.send(request(10, 'resources/read', { uri: 'missing' })); const error = await f.wait(8)
  assert.equal(error.error.code, -32602); assert.equal('result' in error, false)
  f.send(request(11, 'tools/call', { name: 'missing' })); assert.equal((await f.wait(9)).error.code, -32602)
})

test('modern catalog stays fixed after exports, and another metadata identity reads explicit URI under same grant', async t => {
  const terminal = new AbortController(); const f = fixture(t, { terminalSignal: terminal.signal })
  f.send(request(1, 'resources/list')); const before = (await f.wait(1)).result.resources
  f.send(request(2, 'tools/call', { name: descriptor.name }, meta('exporter'))); const link = (await f.wait(2)).result.content.find(c => c.type === 'resource_link')
  assert.ok(link)
  f.send(request(3, 'resources/list')); assert.deepEqual((await f.wait(3)).result.resources, before)
  f.send(request(4, 'resources/read', { uri: link.uri }, meta('reader'))); assert.equal((await f.wait(4)).result.contents[0].text, '{"fixture":true}')
  const other = fixture(t)
  other.send(request(1, 'resources/read', { uri: link.uri })); assert.equal((await other.wait(1)).error.code, -32602)
  terminal.abort(); assert.equal(f.server.artifacts.records.size, 0)
  f.send(request(5, 'resources/read', { uri: link.uri })); assert.equal((await f.wait(5)).error.code, -32000)
})

test('completed modern IDs may be reused while lifetime admission budget is independent', async t => {
  const f = fixture(t, {}, { sessionRequests: 3 })
  for (let i = 1; i <= 3; i++) { f.send(request('same', 'prompts/list')); assert.equal((await f.wait(i)).result.resultType, 'complete'); await until(() => f.server.activeWork.size === 0) }
  f.send(request('same', 'prompts/list')); assert.match((await f.wait(4)).error.message, /Session request limit/)
  assert.equal(f.server.seen.size, 0); assert.equal(f.server.modernRequestCount, 3)
})

test('outstanding duplicate IDs are rejected without invoking another operation', async t => {
  let resolve; let calls = 0
  const f = fixture(t, { callTool: () => { calls++; return new Promise(r => { resolve = r }) } })
  f.send(request(1, 'tools/call', { name: descriptor.name })); await until(() => resolve)
  f.send(request(1, 'tools/call', { name: descriptor.name })); assert.equal((await f.wait(1)).error.code, -32600); assert.equal(calls, 1)
  resolve(snapshot()); await f.wait(2)
})

test('cancelled generation keeps work budget, allows ID reuse, and late cleanup cannot remove replacement', async t => {
  const pending = []
  const f = fixture(t, { callTool: (_n, _a, context) => new Promise(resolve => pending.push({ resolve, signal: context.signal })) }, { concurrentRequests: 2 })
  f.send(request('id', 'tools/call', { name: descriptor.name })); await until(() => pending.length === 1)
  const oldBytes = f.server.pendingBytes
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'id' } })
  assert.equal(pending[0].signal.aborted, true); assert.equal(f.server.requests.has('id'), false); assert.equal(f.server.pendingBytes, oldBytes)
  f.send(request('id', 'tools/call', { name: descriptor.name })); await until(() => pending.length === 2)
  const replacement = f.server.requests.get('id')
  f.send(request('overflow', 'prompts/list')); assert.equal((await f.wait(1)).error.code, -32000)
  pending[0].resolve(snapshot()); await until(() => f.server.activeWork.size === 1)
  assert.equal(f.server.requests.get('id'), replacement); assert.equal(f.server.artifacts.records.size, 0)
  pending[1].resolve(snapshot()); const response = await f.wait(2)
  assert.equal(response.id, 'id'); assert.equal(response.result.isError, false)
  await until(() => f.server.pendingBytes === 0); assert.equal(f.messages.length, 2)
})

test('timeout releases only outstanding identity after error; late result cannot revive resources', async t => {
  let finish
  const f = fixture(t, { callTool: () => new Promise(resolve => { finish = resolve }) }, { requestTimeoutMs: 20 })
  f.send(request(1, 'tools/call', { name: descriptor.name })); const response = await f.wait(1)
  assert.match(response.error.message, /may already have committed/); assert.equal(f.server.activeWork.size, 1)
  f.send(request(1, 'prompts/list')); assert.equal((await f.wait(2)).result.resultType, 'complete')
  finish(snapshot()); await until(() => f.server.activeWork.size === 0)
  assert.equal(f.server.artifacts.records.size, 0); assert.equal(f.messages.length, 2)
})

test('queued response cancellation is checked at write boundary; newer ID generation survives', async t => {
  const pendingWrites = []; const output = new Writable({ write(chunk, _encoding, callback) { pendingWrites.push({ chunk: chunk.toString(), callback }) } })
  const f = fixture(t, {}, {}, output)
  f.send(request('block', 'prompts/list')); await until(() => pendingWrites.length === 1)
  f.send(request('reuse', 'prompts/list')); await until(() => f.server.queuedBytes > Buffer.byteLength(pendingWrites[0].chunk))
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'reuse' } })
  f.send(request('reuse', 'prompts/list'))
  pendingWrites[0].callback(); await until(() => pendingWrites.length === 2)
  const emitted = pendingWrites.map(w => JSON.parse(w.chunk))
  assert.deepEqual(emitted.map(v => v.id), ['block', 'reuse'])
  pendingWrites[1].callback(); await until(() => f.server.activeWork.size === 0)
  assert.equal(pendingWrites.length, 2); assert.equal(f.server.pendingBytes, 0)
})

test('backpressure closes bounded modern output and aborts detached cancelled work', async t => {
  let signal
  const output = new Writable({ write(_chunk, _encoding, _callback) {} })
  const f = fixture(t, { callTool: (_n, _a, context) => { signal = context.signal; return new Promise(() => {}) } }, { queuedOutputBytes: 400 }, output)
  f.send(request('work', 'tools/call', { name: descriptor.name })); await until(() => signal)
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'work' } })
  f.send(request('one', 'server/discover')); await until(() => f.server.closed)
  assert.equal(signal.aborted, true); assert.equal(f.server.pendingBytes, 0); assert.equal(f.server.artifacts.records.size, 0)
})

test('terminal revocation while result is pending prevents late cache recreation', async t => {
  let finish; const terminal = new AbortController()
  const f = fixture(t, { terminalSignal: terminal.signal, callTool: () => new Promise(resolve => { finish = resolve }) })
  f.send(request(1, 'tools/call', { name: descriptor.name })); await until(() => finish)
  terminal.abort(); finish(snapshot())
  const response = await f.wait(1)
  assert.equal(response.error.code, -32000); assert.match(response.error.message, /withheld/); assert.equal('result' in response, false)
  assert.equal(f.server.artifacts.records.size, 0)
})

test('known nested capability and Implementation metadata shapes reject before business dispatch', async t => {
  const f = fixture(t)
  const invalidCaps = [{ extensions: { bad: {} } }, { extensions: { '1bad/name': {} } }, { extensions: { 'a/-bad': {} } }, { elicitation: null }, { roots: [] }, { extensions: [] }, { extensions: { 'example.org/x': true } }, { experimental: { x: 1 } }, { sampling: { tools: null } }]
  let count = 0
  for (const caps of invalidCaps) { f.send(request(++count, 'tools/call', { name: descriptor.name }, meta('bad', caps))); assert.equal((await f.wait(count)).error.code, -32602) }
  for (const fields of [{ icons: null }, { icons: [{ src: 'x', theme: 'neon' }] }, { title: 12 }, { icons: [{ src: 1 }] }]) {
    f.send(request(++count, 'tools/call', { name: descriptor.name }, { ...meta(), [K.clientInfo]: { name: 'bad', version: '1', ...fields } })); assert.equal((await f.wait(count)).error.code, -32602)
  }
  assert.equal(f.counts().catalogCalls, 0); assert.equal(f.counts().toolCalls, 0)
  f.send(request(++count, 'prompts/list', {}, { [K.version]: V, [K.capabilities]: { 'example.org/future': true, tasks: 'opaque-noncore', roots: { listChanged: 'opaque-in-modern' }, extensions: { 'example.org/x': {}, 'a/': {} } } }))
  assert.equal((await f.wait(count)).result.resultType, 'complete') // clientInfo is optional.
})

test('raw overflowing metadata number is rejected rather than normalized or inherited', async t => {
  const f = fixture(t)
  const line = JSON.stringify(request(1, 'tools/call', { name: descriptor.name }, { ...meta(), progressToken: 'OVERFLOW' })).replace('"OVERFLOW"', '1e400')
  f.input.write(line + '\n'); assert.equal((await f.wait(1)).error.code, -32602)
  assert.equal(f.counts().catalogCalls, 0)
})

test('legacy progress metadata and unrelated MCP extensions do not select modern', async t => {
  const f = fixture(t)
  f.send(initialize(1)); await f.wait(1); f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  f.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { progressToken: 1, 'io.modelcontextprotocol/related-task': { taskId: 'opaque' } } } })
  assert.equal('resultType' in (await f.wait(2)).result, false); assert.equal(f.server.era, 'legacy')
})

test('synchronous response-triggered ID reuse sees no outstanding previous generation', async t => {
  const f = fixture(t)
  let issued = false
  // Listener executes inside output.write, before its callback and cleanup.
  f.server.output.on('data', () => { if (!issued) { issued = true; f.send(request('same', 'prompts/list')) } })
  f.send(request('same', 'prompts/list')); await f.wait(2)
  assert.ok(f.messages.every(m => m.result?.resultType === 'complete'))
  await until(() => f.server.activeWork.size === 0); assert.equal(f.server.pendingBytes, 0)
})

test('queued timeout error can be cancelled and ID reused without stale timeout output', async t => {
  const writes = []; const pending = []
  const output = new Writable({ write(chunk, _encoding, callback) { writes.push({ chunk: chunk.toString(), callback }) } })
  const f = fixture(t, { callTool: () => new Promise(resolve => pending.push(resolve)) }, { requestTimeoutMs: 20 }, output)
  f.send(request('block', 'prompts/list')); await until(() => writes.length === 1)
  f.send(request('reuse', 'tools/call', { name: descriptor.name })); await until(() => f.server.requests.get('reuse')?.timedOut)
  f.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'reuse' } })
  f.send(request('reuse', 'prompts/list')); await delay(2)
  writes[0].callback(); await until(() => writes.length === 2)
  assert.equal(JSON.parse(writes[1].chunk).result.resultType, 'complete')
  writes[1].callback(); pending[0](snapshot()); await until(() => f.server.activeWork.size === 0)
  assert.equal(writes.length, 2); assert.equal(f.server.artifacts.records.size, 0)
})

for (const era of ['modern', 'legacy']) for (const method of ['resources/read', 'tools/call', 'tools/list', 'resources/list']) test(`queued ${era} ${method} success is withheld on revocation`, async t => {
  const terminal = new AbortController(), writes = []
  const output = new Writable({ write(chunk, _encoding, callback) { writes.push({ chunk: chunk.toString(), callback }) } })
  const f = fixture(t, { terminalSignal: terminal.signal }, {}, output)
  let base = 0
  const send = (id, method, params = {}) => f.send(era === 'modern' ? request(id, method, params) : { jsonrpc: '2.0', id, method, params })
  if (era === 'legacy') {
    f.send(initialize('init')); await until(() => writes.length === 1); writes[0].callback()
    f.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); await until(() => f.server.activeWork.size === 0)
    base = 1
  }
  send('export', 'tools/call', { name: descriptor.name }); await until(() => writes.length === base + 1)
  const link = JSON.parse(writes[base].chunk).result.content.find(c => c.type === 'resource_link')
  writes[base].callback(); await until(() => f.server.activeWork.size === 0)
  send('block', 'prompts/list'); await until(() => writes.length === base + 2)
  send('sensitive', method, method === 'resources/read' ? { uri: link.uri } : method === 'tools/call' ? { name: descriptor.name } : {})
  await until(() => f.server.queuedBytes > Buffer.byteLength(writes[base + 1].chunk))
  terminal.abort(); assert.equal(f.server.artifacts.records.size, 0)
  writes[base + 1].callback(); await until(() => writes.length === base + 3)
  const actual = JSON.parse(writes[base + 2].chunk)
  assert.equal(actual.error.code, -32000); assert.equal('result' in actual, false); assert.match(actual.error.message, /withheld/)
  writes[base + 2].callback(); await until(() => f.server.activeWork.size === 0)
  // The earlier export response was already written and cannot be recalled.
  assert.ok(JSON.parse(writes[base].chunk).result.content.some(c => c.type === 'resource_link'))
})

test('explicit ephemeral resources expire on eviction without changing modern catalog', async t => {
  const f = fixture(t)
  f.server.artifacts.maxArtifacts = 1
  f.send(request(1, 'tools/call', { name: descriptor.name })); const first = (await f.wait(1)).result.content.find(c => c.type === 'resource_link').uri
  f.send(request(2, 'tools/call', { name: descriptor.name })); const second = (await f.wait(2)).result.content.find(c => c.type === 'resource_link').uri
  assert.notEqual(first, second)
  f.send(request(3, 'resources/read', { uri: first })); assert.equal((await f.wait(3)).error.code, -32602)
  f.send(request(4, 'resources/read', { uri: second })); assert.equal((await f.wait(4)).result.contents[0].text, '{"fixture":true}')
  f.send(request(5, 'resources/list')); assert.deepEqual((await f.wait(5)).result.resources.map(r => r.uri), ['futureox-design://automation/capabilities'])
  assert.equal(f.counts().toolCalls, 2) // No automatic re-export of the missing URI.
})

test('close prevents late tool completion from repopulating resources or sending output', async t => {
  let finish
  const f = fixture(t, { callTool: () => new Promise(resolve => { finish = resolve }) })
  f.send(request(1, 'tools/call', { name: descriptor.name })); await until(() => finish)
  await f.server.close(); finish(snapshot()); await delay(5)
  assert.equal(f.server.artifacts.records.size, 0); assert.equal(f.messages.length, 0); assert.equal(f.server.activeWork.size, 0); assert.equal(f.server.pendingBytes, 0)
})


test('modern removed ping is rejected while legacy ping remains supported', async t => {
  const modern = fixture(t)
  modern.send(request(1, 'ping')); assert.equal((await modern.wait(1)).error.code, -32601)
  const legacy = fixture(t)
  legacy.send({ jsonrpc: '2.0', id: 1, method: 'ping' }); assert.deepEqual((await legacy.wait(1)).result, {})
})

test('claimed modern client identity and capabilities cannot expand a read-only backend grant', async t => {
  const { OperationBackend } = await import('../src/operation-backend.mjs')
  let mutations = 0
  const backend = new OperationBackend({ scope: 'read', capabilities: { version: 1, methods: [
    { name: 'document.inspect', description: 'Read', mutates: false, inputSchema: { type: 'object' } },
    { name: 'document.change', description: 'Write', mutates: true, inputSchema: { type: 'object' } },
  ], limits: {}, unsupported: [] }, execute: () => { mutations++; return { ok: true, result: {} } } })
  const f = fixture(t, { listTools: backend.listTools.bind(backend), callTool: backend.callTool.bind(backend) })
  const forged = meta('administrator', { scope: 'write', grants: { write: true }, authorization: 'allowed' })
  f.send(request(1, 'tools/list', {}, forged)); assert.deepEqual((await f.wait(1)).result.tools.map(tool => tool.name), ['design_document_inspect'])
  f.send(request(2, 'tools/call', { name: 'design_document_change', arguments: { documentId: 'x', session: 1, expectedRevision: 1 } }, forged))
  assert.equal((await f.wait(2)).error.code, -32602); assert.equal(mutations, 0)
})
