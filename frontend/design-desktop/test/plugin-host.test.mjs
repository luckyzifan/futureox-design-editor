import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPluginDirectoryHost, parseDeclaredPluginManifest, readPluginFile, scanDeclaredPlugins } from '../src/plugin-package.mjs'
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

test('startup scan enables declared plugins and ignores symlinks, FigJam, duplicates and escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-scan-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-scan-out-'))
  const manifest = (name, id, extra = {}) => ({ name, id, api: '1.0.0', main: 'code.js', editorType: ['figma'], ...extra })
  try {
    const sample = await readFile(new URL('../../design-client/plugins/labeled-rectangles/manifest.json', import.meta.url), 'utf8')
    assert.equal(parseDeclaredPluginManifest(sample).id, 'futureox.sample.labeled-rectangles')
    assert.equal(parseDeclaredPluginManifest(sample).ui, 'ui.html')
    assert.throws(() => parseDeclaredPluginManifest('{"name":"A","id":"a","api":"1","main":"code.js","editorType":["figjam"]}'), /manifest/)
    assert.deepEqual(await scanDeclaredPlugins(path.join(root, 'missing')), { plugins: [], skipped: 0, truncated: false })

    const plugins = path.join(root, 'plugins')
    await mkdir(plugins)
    await writeFile(path.join(plugins, 'notes.txt'), 'not a plugin')
    await writePlugin(path.join(plugins, 'b-second'), manifest('Second', 'local.second'))
    await writePlugin(path.join(plugins, 'a-first'), manifest('First', 'local.first', { ui: 'nested/ui.html' }), { 'code.js': 'first()', 'nested/ui.html': '<p>ok</p>' })
    await writePlugin(path.join(plugins, 'c-duplicate'), manifest('Duplicate', 'local.first'))
    await writePlugin(path.join(plugins, 'figjam-only'), manifest('FigJam only', 'local.figjam', { editorType: ['figjam'] }))
    await writePlugin(path.join(plugins, 'missing-main'), manifest('Missing', 'local.missing'), {})
    await mkdir(path.join(plugins, '.hidden'))
    await writeFile(path.join(plugins, '.hidden', 'manifest.json'), JSON.stringify(manifest('Hidden', 'local.hidden')))
    await writeFile(path.join(outside, 'secret.js'), 'secret')
    await mkdir(path.join(plugins, 'escape-link'))
    await writeFile(path.join(plugins, 'escape-link', 'manifest.json'), JSON.stringify(manifest('Escape', 'local.escape', { main: 'escape.js' })))
    await symlink(path.join(outside, 'secret.js'), path.join(plugins, 'escape-link', 'escape.js'))
    await symlink(outside, path.join(plugins, 'linked-dir'), 'dir')

    const scanned = await scanDeclaredPlugins(plugins)
    assert.deepEqual(scanned.plugins.map(plugin => plugin.id), ['local.first', 'local.second'])
    assert.equal(scanned.plugins[0].name, 'First')
    assert.equal(scanned.truncated, false)
    assert.equal(scanned.skipped, 4)
    assert.equal(JSON.stringify(scanned.plugins).includes('secret'), false)
    const linkedRoot = path.join(root, 'linked-root')
    await symlink(plugins, linkedRoot, 'dir')
    assert.deepEqual((await scanDeclaredPlugins(linkedRoot)).plugins.map(plugin => plugin.id), ['local.first', 'local.second'])
    const capped = await scanDeclaredPlugins(plugins, { enableLimit: 1, scanLimit: 1 })
    assert.deepEqual(capped.plugins.map(plugin => plugin.name), ['First'])
    assert.equal(capped.truncated, true)
    await assert.rejects(() => scanDeclaredPlugins(plugins, { scanLimit: 65 }), /Invalid plugin scan limit/)

    const host = createPluginDirectoryHost()
    const enabled = host.enableDeclared(scanned.plugins)
    assert.equal(enabled.length, 2)
    assert.equal(Object.hasOwn(enabled[0], 'root'), false)
    const read = await host.read(enabled[0].grant, ['code.js', 'nested/ui.html'])
    assert.equal(read.files['code.js'], 'first()')
    assert.equal(read.files['nested/ui.html'], '<p>ok</p>')
    await assert.rejects(() => host.read(enabled[0].grant, ['../secret.js']))
    const picked = await host.take(path.join(plugins, 'b-second'))
    assert.equal(picked.displayName, 'b-second')
    const replaced = await host.take(path.join(plugins, 'a-first'))
    await assert.rejects(() => host.read(picked.grant, ['code.js']))
    host.clear()
    await assert.rejects(() => host.read(replaced.grant, ['code.js']))
    assert.equal((await host.read(enabled[1].grant, ['code.js'])).files['code.js'], 'figma.closePlugin()')
    const again = host.enableDeclared([scanned.plugins[0]])
    await assert.rejects(() => host.read(enabled[0].grant, ['code.js']))
    assert.equal((await host.read(again[0].grant, ['code.js'])).files['code.js'], 'first()')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

async function writePlugin(dir, manifest, files = { 'code.js': 'figma.closePlugin()' }) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, body)
  }
}
