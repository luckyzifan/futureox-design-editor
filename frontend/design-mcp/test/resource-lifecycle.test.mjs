import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpath, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

// The same executable assertions can target the untouched baseline or candidate.
// Never resolve candidate-relative imports through a symlink into another source.
const moduleRoot = process.env.RESOURCE_LIFECYCLE_MODULE_ROOT ?? fileURLToPath(new URL('../src/', import.meta.url))
const bridgePath = process.env.RESOURCE_LIFECYCLE_BRIDGE_SOURCE ?? fileURLToPath(new URL('../../design-desktop/src/automation-bridge.mjs', import.meta.url))
const { DesignMcpServer } = await import(pathToFileURL(path.join(moduleRoot, 'server.mjs')))
const { SocketDesignBackend } = await import(pathToFileURL(path.join(moduleRoot, 'socket-backend.mjs')))
const { LocalAutomationBridge } = await import(pathToFileURL(bridgePath))
for (const filename of ['server.mjs', 'socket-backend.mjs', 'artifacts.mjs']) {
  const canonical = await realpath(path.join(moduleRoot, filename))
  console.log('MODULE_IDENTITY', JSON.stringify({ file: filename, canonical, sha256: createHash('sha256').update(await readFile(canonical)).digest('hex') }))
}

const method = { name: 'document.export', description: 'Export exact immutable test bytes', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutates: false }
const descriptor = { name: 'design_document_export', description: method.description, inputSchema: { type: 'object' } }
const editor = { documentId: 'doc', session: 3, name: 'Test design', methods: [method] }
const exportResponse = () => ({ ok: true, method: method.name, documentId: 'doc', session: 3, revision: 7, result: { format: 'futureox.design-document.v1', mimeType: 'application/json', content: '{"name":"immutable authorized snapshot"}' } })

// Production desktop bridge + socket backend, using paired in-memory bytes only.
// This validates actual auth/revoke code, not OS socket permissions or Electron UI.
class MemorySocket extends EventEmitter {
  destroyed = false
  writableLength = 0
  setTimeout() {}
  write(bytes, callback) {
    queueMicrotask(() => {
      if (!this.destroyed && !this.peer.destroyed) this.peer.emit('data', Buffer.from(bytes))
      callback?.()
    })
    return true
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('close')
    this.peer?.destroy()
  }
  end() { this.destroy() }
}
function connectedBackend(t, { dispatch } = {}) {
  const bridge = new LocalAutomationBridge({ dispatch: dispatch ?? (async payload => payload.kind === 'capabilities'
    ? { capabilities: { version: 1, methods: [method], limits: {}, unsupported: [] }, documentId: 'doc', session: 3, revision: 7 }
    : exportResponse()) })
  bridge.setEditor(editor)
  const state = { scope: 'read', token: 'a'.repeat(64), sessionId: 'resource-lifecycle-test', editor: bridge.editor, sockets: new Set(), pending: new Set(), server: { close: callback => callback() } }
  bridge.active = state
  let client, peer
  const backend = new SocketDesignBackend({ endpoint: '/test-only/bridge.sock', sessionId: state.sessionId, token: state.token, transport: {
    validateEndpoint: async () => {},
    createConnection() {
      client = new MemorySocket(); peer = new MemorySocket(); client.peer = peer; peer.peer = client
      bridge.accept(state, peer)
      queueMicrotask(() => client.emit('connect'))
      return client
    },
  } })
  t.after(async () => { backend.close(); await bridge.close() })
  return { bridge, backend, client: () => client, peer: () => peer }
}
function protocol(t, backend) {
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough()
  const messages = new Map(), waiters = new Map()
  let buffer = '', serial = 0
  output.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
      messages.set(value.id, value); waiters.get(value.id)?.(value); waiters.delete(value.id)
    }
  })
  const server = new DesignMcpServer({ backend, input, output, diagnostics }).start()
  t.after(async () => { await server.close(); input.destroy(); output.destroy(); diagnostics.destroy() })
  const send = (method, params) => {
    const id = `resource-test-${++serial}`
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Protocol response timed out: ${method}`)), 1000)
      waiters.set(id, response => { clearTimeout(timer); resolve(response) })
    })
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n')
    return promise
  }
  const ready = async () => {
    const response = await send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '1' } })
    assert.equal(response.result.protocolVersion, '2025-11-25')
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  }
  const capture = async () => {
    const response = await send('tools/call', { name: descriptor.name })
    assert.equal(response.result.isError, false)
    return response.result.structuredContent.result.resources[0].uri
  }
  return { server, send, ready, capture, messages }
}
const expectEnded = response => {
  assert.equal(response.error?.code, -32000)
  assert.match(response.error.message, /authorization session ended/)
  assert.equal(response.result, undefined)
}

for (const end of ['disable', 'same-ID reopen', 'peer disconnect', 'protocol failure']) {
  test(`negative control: ${end} expires cached export and rejects subsequent resource access`, async t => {
    const connection = connectedBackend(t), f = protocol(t, connection.backend)
    await f.ready(); const uri = await f.capture()
    const before = await f.send('resources/read', { uri })
    assert.equal(before.result.contents[0].text, exportResponse().result.content)
    if (end === 'disable') await connection.bridge.close()
    else if (end === 'same-ID reopen') connection.bridge.setEditor({ ...editor, session: 4 })
    else if (end === 'peer disconnect') connection.peer().destroy()
    else connection.client().emit('data', Buffer.from('{malformed}\n'))
    assert.equal(connection.backend.closed, true)
    // Direct production read still goes through NDJSON, not ArtifactResources.clear().
    expectEnded(await f.send('resources/read', { uri }))
    expectEnded(await f.send('resources/list'))
    assert.equal(f.server.artifacts.bytes, 0)
    assert.deepEqual(f.server.artifacts.list(), [])
    assert.equal(before.result.contents[0].text, exportResponse().result.content, 'previously returned bytes cannot be recalled')
    assert.deepEqual((await f.send('ping')).result, {}, 'MCP remains alive to return explicit errors')
  })
}

test('live exports remain exact and revision-stable until their backend lifetime ends', async t => {
  const c = connectedBackend(t), f = protocol(t, c.backend)
  await f.ready(); const uri = await f.capture()
  const a = await f.send('resources/read', { uri }), b = await f.send('resources/read', { uri })
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result))
  assert.equal(a.result.contents[0].text, exportResponse().result.content)
  assert.equal((await f.send('resources/list')).result.resources.length, 2)
  assert.equal((await f.send('resources/read', { uri: 'futureox-design://artifacts/unknown/file' })).error.code, -32002)
  const dispatch = f.server.dispatch.bind(f.server)
  f.server.dispatch = (name, params, context) => {
    const computed = dispatch(name, params, context)
    if (name === 'resources/read' && params.uri === uri) c.backend.close()
    return computed
  }
  // Computed is not delivered: terminal loss before the actual stdout write
  // withholds this response. The earlier a/b responses were already written
  // and cannot be recalled; their exact snapshot remains unchanged below.
  const accepted = await f.send('resources/read', { uri })
  assert.equal(accepted.error.code, -32000)
  assert.match(accepted.error.message, /result withheld/)
  assert.equal('result' in accepted, false)
  assert.equal(a.result.contents[0].text, exportResponse().result.content)
  assert.equal(JSON.stringify(a.result), JSON.stringify(b.result))
  assert.equal(f.server.artifacts.bytes, 0)
  expectEnded(await f.send('resources/read', { uri }))
})

test('backend termination is one-way, signals once and cannot be supplied by JSON request fields', async t => {
  const c = connectedBackend(t), f = protocol(t, c.backend)
  assert.equal(c.backend.terminalSignal.aborted, false)
  let ended = 0; c.backend.terminalSignal.addEventListener('abort', () => ended++)
  assert.throws(() => { c.backend.terminalSignal = new AbortController().signal }, TypeError)
  await f.ready(); const uri = await f.capture()
  c.backend.fail(new Error('first terminal error')); c.backend.fail(new Error('second terminal error')); c.backend.close()
  assert.equal(ended, 1); assert.equal(c.backend.terminalSignal.aborted, true)
  await assert.rejects(c.backend.connect(), /closed/)
  expectEnded(await f.send('resources/read', { uri, terminalSignal: { aborted: false }, backend: { closed: false } }))
})

test('constructing around an already-terminal backend does not create a fresh resource authority', async t => {
  const c = connectedBackend(t); c.backend.close()
  const f = protocol(t, c.backend); await f.ready()
  expectEnded(await f.send('resources/list'))
  expectEnded(await f.send('resources/read', { uri: 'futureox-design://automation/capabilities' }))
  assert.deepEqual(f.server.artifacts.list(), [])
})

test('late backend completion cannot refill resources after terminal authorization loss', async t => {
  const lifetime = new AbortController()
  let complete, started
  const entered = new Promise(resolve => { started = resolve })
  const f = protocol(t, { terminalSignal: lifetime.signal, listTools: () => [descriptor], callTool: () => { started(); return new Promise(resolve => { complete = resolve }) } })
  await f.ready(); const pending = f.send('tools/call', { name: descriptor.name })
  await entered; lifetime.abort(); complete(exportResponse())
  const response = await pending
  // Tool errors can contain private operation details too. The terminal
  // write fence replaces the entire not-yet-written result, not its commit fact.
  assert.equal(response.error.code, -32000)
  assert.match(response.error.message, /result withheld/)
  assert.match(response.error.message, /may already have completed/)
  assert.equal('result' in response, false)
  assert.equal(JSON.stringify(response).includes(exportResponse().result.content), false)
  assert.deepEqual(f.server.artifacts.list(), [])
  expectEnded(await f.send('resources/list'))
})

test('termination during capability await prevents dispatch and resource capabilities exposure', async t => {
  const lifetime = new AbortController()
  let complete, entered, called = 0
  const started = new Promise(resolve => { entered = resolve })
  const f = protocol(t, { terminalSignal: lifetime.signal, listTools: () => { entered(); return new Promise(resolve => { complete = resolve }) }, callTool: () => { called++; return exportResponse() } })
  await f.ready(); const pending = f.send('resources/read', { uri: 'futureox-design://automation/capabilities' })
  await started; lifetime.abort(); complete([descriptor])
  expectEnded(await pending); assert.equal(called, 0)
  expectEnded(await f.send('tools/call', { name: descriptor.name }))
  assert.equal(called, 0)
})

test('server and renewed authorization isolation rejects foreign/old URI without clearing live unrelated exports', async t => {
  const a = connectedBackend(t), b = connectedBackend(t), fa = protocol(t, a.backend), fb = protocol(t, b.backend)
  await fa.ready(); await fb.ready()
  const old = await fa.capture(), own = await fb.capture()
  assert.equal((await fb.send('resources/read', { uri: old })).error.code, -32002)
  await a.bridge.close()
  expectEnded(await fa.send('resources/read', { uri: old }))
  assert.equal((await fb.send('resources/read', { uri: own })).result.contents[0].text, exportResponse().result.content)
  const fresh = connectedBackend(t), ff = protocol(t, fresh.backend); await ff.ready()
  assert.equal((await ff.send('resources/read', { uri: old })).error.code, -32002)
  const renewed = await ff.capture(); assert.notEqual(renewed, old)
  assert.equal((await ff.send('resources/read', { uri: renewed })).result.contents[0].text, exportResponse().result.content)
})

test('MCP close releases the lifetime listener, clears resources and is idempotent', async t => {
  const c = connectedBackend(t), signal = c.backend.terminalSignal, before = getEventListeners(signal, 'abort').length
  const f = protocol(t, c.backend)
  assert.equal(getEventListeners(signal, 'abort').length, before + 1)
  await f.ready(); await f.capture()
  await f.server.close(); await f.server.close()
  assert.equal(getEventListeners(signal, 'abort').length, 0)
  assert.equal(c.backend.closed, true)
  assert.equal(f.server.artifacts.bytes, 0)
})

test('terminal event releases its once listener and does not change legacy injected-backend lifecycle', async t => {
  const c = connectedBackend(t), f = protocol(t, c.backend); await f.ready(); await f.capture()
  assert.equal(getEventListeners(c.backend.terminalSignal, 'abort').length, 1)
  c.backend.close()
  assert.equal(getEventListeners(c.backend.terminalSignal, 'abort').length, 0)
  const legacy = protocol(t, { listTools: () => [descriptor], callTool: () => exportResponse() })
  await legacy.ready(); const uri = await legacy.capture()
  await turn()
  assert.equal((await legacy.send('resources/read', { uri })).result.contents[0].text, exportResponse().result.content)
  await legacy.server.close(); assert.equal(legacy.server.artifacts.bytes, 0)
})


test('capabilities resource rechecks termination between descriptor validation and response construction', async t => {
  const lifetime = new AbortController()
  let complete, entered
  const catalog = new Promise(resolve => { complete = resolve })
  // This reaction queues abort after listTools resumes, but before its caller's
  // resource formatter. The formatter must not publish authority from that gap.
  catalog.then(() => queueMicrotask(() => lifetime.abort()))
  const started = new Promise(resolve => { entered = resolve })
  const f = protocol(t, { terminalSignal: lifetime.signal, listTools: () => { entered(); return catalog }, callTool: () => exportResponse() })
  await f.ready(); const pending = f.send('resources/read', { uri: 'futureox-design://automation/capabilities' })
  await started; complete([descriptor])
  expectEnded(await pending)
})

test('termination between initialize and initialized retains protocol handshake but grants no resource access', async t => {
  const lifetime = new AbortController()
  const f = protocol(t, { terminalSignal: lifetime.signal, listTools: () => [descriptor], callTool: () => exportResponse() })
  const initialized = await f.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'init-race', version: '1' } })
  assert.equal(initialized.result.protocolVersion, '2025-11-25')
  lifetime.abort()
  f.server.notification({ method: 'notifications/initialized' })
  expectEnded(await f.send('resources/list'))
  expectEnded(await f.send('tools/list'))
  assert.deepEqual((await f.send('ping')).result, {})
})

test('MCP shutdown during capability await removes the listener and suppresses late protocol publication', async t => {
  const lifetime = new AbortController()
  let complete, entered
  const started = new Promise(resolve => { entered = resolve })
  const f = protocol(t, { terminalSignal: lifetime.signal, listTools: () => { entered(); return new Promise(resolve => { complete = resolve }) }, callTool: () => exportResponse(), close: () => lifetime.abort() })
  await f.ready()
  // A raw frame avoids manufacturing a timeout for an intentionally cancelled reply.
  f.server.receiveLine(JSON.stringify({ jsonrpc: '2.0', id: 'closed-capabilities', method: 'resources/read', params: { uri: 'futureox-design://automation/capabilities' } }))
  await started; await f.server.close(); complete([descriptor]); await turn()
  assert.equal(getEventListeners(lifetime.signal, 'abort').length, 0)
  assert.equal(f.messages.has('closed-capabilities'), false)
  assert.equal(f.server.artifacts.bytes, 0)
})
