import test from 'node:test'
import assert from 'node:assert/strict'
import { LocalAutomationBridge, registerAutomationBridge } from '../src/automation-bridge.mjs'
import { attachFigmaMcp, desktopMcpClientConfig } from '../src/figma-mcp-host.mjs'
import { APP_URL, assertSender } from '../src/security.mjs'

const editor = {
  documentId: 'doc-one', session: 3, name: 'Selected design',
  methods: [{ name: 'document.get', description: 'Read', inputSchema: {}, mutates: false }],
}

test('published Figma MCP status omits the bridge token and closes with the session', async () => {
  const bridge = new LocalAutomationBridge({ dispatch: async () => ({}) })
  let closed = 0
  const figma = attachFigmaMcp(bridge, async config => {
    assert.equal(config.token, 'secret-token-value')
    return { url: 'http://127.0.0.1:9/mcp', close: async () => { closed += 1 } }
  })
  bridge.active = {
    sessionId: 'session-1', scope: 'read', grants: {}, token: 'secret-token-value', endpoint: '/tmp/bridge.sock',
    editor: { documentId: 'doc-one', session: 3 }, sockets: new Set(), pending: new Set(), server: { close: callback => callback() },
  }
  const shown = await figma.afterEnable({ sessionId: 'session-1', token: 'secret-token-value', endpoint: '/tmp/bridge.sock' })
  assert.equal(shown.figmaMcp.url, 'http://127.0.0.1:9/mcp')
  assert.equal(JSON.stringify(bridge.status()).includes('secret-token-value'), false)
  assert.equal(bridge.connection().token, 'secret-token-value')
  assert.equal(bridge.connection().figmaMcp.url, 'http://127.0.0.1:9/mcp')
  await bridge.close()
  assert.equal(closed, 1)
  assert.equal(bridge.status().enabled, false)
})

test('a failed loopback start is redacted and does not block the existing socket grant', async () => {
  const bridge = new LocalAutomationBridge({ dispatch: async () => ({}) })
  bridge.active = {
    sessionId: 'session-1', scope: 'read', grants: {}, token: 'secret-token-value', endpoint: '/tmp/bridge.sock',
    editor: { documentId: 'doc-one', session: 3 }, sockets: new Set(), pending: new Set(), server: { close: callback => callback() },
  }
  const figma = attachFigmaMcp(bridge, async () => { throw new Error('bind failed for secret-token-value') })
  const shown = await figma.afterEnable({ sessionId: 'session-1', token: 'secret-token-value' })
  assert.equal(shown.figmaMcp.available, false)
  assert.equal(shown.figmaMcp.reason.includes('secret-token-value'), false)
  assert.match(shown.figmaMcp.reason, /\[redacted\]/)
  assert.equal(JSON.stringify(bridge.status()).includes('secret-token-value'), false)
  await bridge.close()
})

test('stdio config survives a replaced environment and omits unrelated secrets', () => {
  const token = 'a'.repeat(64)
  const config = desktopMcpClientConfig(
    { endpoint: '\\\\.\\pipe\\futureox-design-session', sessionId: 'session-1', token },
    'C:/Program Files/Futureox/resources/design-mcp/src/cli.mjs',
    'C:/Program Files/Futureox/futureox-desgin.exe',
    { env: { Path: 'C:/Windows', PathExt: '.EXE', NODE_OPTIONS: '--inspect', SECRET_TOKEN: token, LD_PRELOAD: '/tmp/lib.so' }, platform: 'win32' },
  ).mcpServers.futureox_design
  assert.equal(config.command, 'C:/Program Files/Futureox/futureox-desgin.exe')
  assert.deepEqual(config.args, ['C:/Program Files/Futureox/resources/design-mcp/src/cli.mjs'])
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(config.env.Path, 'C:/Windows')
  assert.equal(config.env.PathExt, '.EXE')
  assert.equal(config.env.FUTUREOX_DESIGN_BRIDGE_TOKEN, token)
  assert.equal(config.env.NODE_OPTIONS, undefined)
  assert.equal(config.env.LD_PRELOAD, undefined)
  assert.equal(config.env.SECRET_TOKEN, undefined)
})

test('confirmed enable publishes the loopback URL without putting the token in status', async t => {
  const details = []
  const handlers = new Map()
  const frame = { url: APP_URL }
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame, send() {} } }
  const api = registerAutomationBridge({
    ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
    getWindow: () => window,
    assertSender,
    dialog: { showMessageBox: async (...args) => { const options = args.at(-1); details.push(options?.detail || ''); return { response: details.length === 1 ? 1 : 0 } } },
    clipboard: { writeText() {} },
    figmaMcp: async () => ({ url: 'http://127.0.0.1:9/mcp', close: async () => {} }),
  })
  t.after(() => api.close())
  const event = { sender: window.webContents, senderFrame: frame }
  const call = (method, value) => handlers.get(`design-desktop:automation-${method}`)(event, value)
  assert.deepEqual(call('register', editor), { status: 'ok' })
  const status = await call('enable', { scope: 'read' })
  assert.equal(status.enabled, true)
  assert.equal(status.figmaMcp.url, 'http://127.0.0.1:9/mcp')
  assert.equal('token' in status, false)
  assert.match(details[1], /127\.0\.0\.1:9\/mcp/)
  assert.match(details[1], /Authorization: Bearer/)
})
