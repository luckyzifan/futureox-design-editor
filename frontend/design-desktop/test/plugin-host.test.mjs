import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPluginDirectoryHost, readPluginFile } from '../src/plugin-package.mjs'
import { createPluginUiHost, jsonPluginMessage, pluginUiSize, wrapPluginUiDocument } from '../src/plugin-ui.mjs'

test('plugin folder reads stay inside the selected directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-outside-'))
  try {
    await writeFile(path.join(root, 'manifest.json'), '{"name":"Demo"}')
    await writeFile(path.join(root, 'code.js'), 'figma.closePlugin()')
    await mkdir(path.join(root, 'nested'))
    await writeFile(path.join(root, 'nested', 'ui.html'), '<p>UI</p>')
    await writeFile(path.join(outside, 'secret.js'), 'secret')
    await symlink(path.join(outside, 'secret.js'), path.join(root, 'escape.js'))
    const host = createPluginDirectoryHost()
    const opened = await host.take(root)
    assert.equal(opened.displayName, path.basename(root))
    assert.match(opened.manifestText, /Demo/)
    const read = await host.read(opened.grant, ['code.js', 'nested/ui.html'])
    assert.equal(read.files['code.js'], 'figma.closePlugin()')
    assert.equal(read.files['nested/ui.html'], '<p>UI</p>')
    await assert.rejects(() => host.read(opened.grant, ['../secret.js']))
    await assert.rejects(() => readPluginFile(root, 'escape.js'))
    await assert.rejects(() => host.read('00000000-0000-4000-8000-000000000000', ['code.js']))
    host.clear()
    await assert.rejects(() => host.read(opened.grant, ['code.js']))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('plugin ui window is sandboxed and only its messages reach the editor', async () => {
  assert.deepEqual(pluginUiSize(10, 9000), { width: 200, height: 800 })
  const wrapped = wrapPluginUiDocument('<main>Labels</main>')
  assert.match(wrapped, /connect-src 'none'/)
  assert.match(wrapped, /<main>Labels<\/main>/)
  assert.throws(() => jsonPluginMessage(undefined))
  assert.deepEqual(jsonPluginMessage({ type: 'create', count: 1 }), { type: 'create', count: 1 })
  const sent = []
  const windows = []
  const listeners = new Map()
  const host = createPluginUiHost({
    BrowserWindow: class extends EventEmitter {
      constructor(options) {
        super()
        this.options = options
        this.webContents = new EventEmitter()
        this.webContents.setWindowOpenHandler = () => {}
        this.webContents.send = (...args) => sent.push(args)
        this.destroyed = false
        windows.push(this)
      }
      isDestroyed() { return this.destroyed }
      loadURL(url) { this.url = url; return Promise.resolve() }
      close() { this.destroyed = true; this.emit('closed') }
    },
    session: { fromPartition() { return { setPermissionRequestHandler() {}, webRequest: { onBeforeRequest() {} } } } },
    ipcMain: { on: (name, fn) => listeners.set(name, fn) },
    preloadPath: '/plugin-ui-preload.cjs',
    send: (channel, value) => sent.push([channel, value]),
  })
  await host.open({ html: '<main>Labels</main>', width: 300, height: 220, title: 'Labeled rectangles', parent: { isDestroyed: () => false } })
  const window = windows[0]
  assert.equal(window.options.webPreferences.sandbox, true)
  assert.equal(window.options.webPreferences.nodeIntegration, false)
  assert.equal(window.options.webPreferences.contextIsolation, true)
  assert.match(window.url, /^data:text\/html/)
  const listener = listeners.get('design-desktop:plugin-ui-message')
  listener({ sender: { id: 'other' } }, { pluginMessage: { type: 'nope' } })
  assert.equal(sent.some(entry => entry[0] === 'design-desktop:plugin-ui-message'), false)
  listener({ sender: window.webContents }, { pluginMessage: { type: 'create', count: 2 } })
  assert.deepEqual(sent.at(-1), ['design-desktop:plugin-ui-message', { pluginMessage: { type: 'create', count: 2 } }])
  host.post({ type: 'created' })
  assert.deepEqual(sent.at(-1), ['design-desktop:plugin-ui-deliver', { pluginMessage: { type: 'created' } }])
  host.close()
  assert.equal(sent.some(entry => entry[0] === 'design-desktop:plugin-ui-closed'), false)
})
