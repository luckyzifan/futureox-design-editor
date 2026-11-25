import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createPluginUiNetwork } from '../src/plugin-ui-network.mjs'
import { createPluginUiHost } from '../src/plugin-ui.mjs'

const url = 'https://cdn.example.test/icon'
const publicAddress = '93.184.216.34'
const pattern = ['https://cdn.example.test']
const query = { url, method: 'GET', accept: 'image/png' }

function incoming({ status = 200, headers = {}, bytes = Buffer.from('icon') } = {}) {
  return Object.assign(Readable.from([bytes]), { statusCode: status, headers })
}

test('the UI fetch broker pins the manifest-approved public DNS answer', async () => {
  let opened = 0
  const service = createPluginUiNetwork(pattern, {
    lookup: async (host, options) => {
      assert.equal(host, 'cdn.example.test')
      assert.deepEqual(options, { family: 4, all: true })
      return [{ address: publicAddress, family: 4 }]
    },
    request(address, options, callback) {
      const outgoing = new EventEmitter()
      outgoing.end = () => {
        opened += 1
        assert.equal(address.href, url)
        assert.equal(options.servername, 'cdn.example.test')
        assert.equal(options.rejectUnauthorized, true)
        assert.equal(options.agent, false)
        assert.deepEqual(options.headers, { accept: 'image/png', 'accept-encoding': 'identity', origin: 'null' })
        options.lookup('cdn.example.test', {}, (error, connected, family) => {
          assert.equal(error, null)
          assert.equal(connected, publicAddress)
          assert.equal(family, 4)
        })
        callback(incoming({ headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png', 'set-cookie': 'ignored' } }))
      }
      return outgoing
    },
  })
  assert.deepEqual(await service.fetch(query), {
    status: 200, url, headers: { 'content-type': 'image/png' }, base64: Buffer.from('icon').toString('base64'),
  })
  await assert.rejects(() => service.fetch({ ...query, url: 'https://other.example.test/icon' }))
  await assert.rejects(() => service.fetch({ ...query, method: 'POST' }))
  assert.equal(opened, 1)
  service.close()
  await assert.rejects(() => service.fetch(query))
})

test('UI network refuses private resolver results, redirects, non-public responses and oversized bodies', async () => {
  let opened = 0
  const privateNetwork = createPluginUiNetwork(pattern, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: () => { opened += 1 },
  })
  await assert.rejects(() => privateNetwork.fetch(query))
  assert.equal(opened, 0)
  for (const options of [
    { status: 302, headers: { 'access-control-allow-origin': '*', location: url } },
    { status: 200, headers: {} },
    { headers: { 'access-control-allow-origin': '*' }, bytes: Buffer.alloc(1024 * 1024 + 1) },
  ]) {
    const service = createPluginUiNetwork(pattern, {
      lookup: async () => [{ address: publicAddress, family: 4 }],
      request: (_address, _resolved, callback) => Object.assign(new EventEmitter(), { end: () => callback(incoming(options)) }),
    })
    await assert.rejects(() => service.fetch(query))
  }
})

test('the desktop UI fetch handler accepts only its active sandbox window and main frame', async () => {
  let handler
  let window
  let cancelled = false
  const request = { status: 200, headers: {}, url, base64: '' }
  const host = createPluginUiHost({
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super()
        this.webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler() {} })
        window = this
      }
      isDestroyed() { return false }
      loadURL() { return Promise.resolve() }
      close() { this.emit('closed') }
    },
    session: { fromPartition() { return { setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    ipcMain: { on() {}, handle(_channel, callback) { handler = callback } },
    preloadPath: '/plugin-ui-preload.cjs',
    send() {},
    network: domains => {
      assert.deepEqual(domains, pattern)
      return { fetch: async () => request, close() { cancelled = true } }
    },
  })
  await host.open({ html: '<p>Plugin UI</p>', allowedDomains: pattern })
  const sender = window.webContents
  const active = { sender, senderFrame: sender.mainFrame }
  assert.equal((await handler({ sender, senderFrame: {} }, query)).ok, false)
  assert.deepEqual(await handler(active, query), { ok: true, response: request })
  host.close()
  assert.equal(cancelled, true)
  assert.equal((await handler(active, query)).ok, false)
})
