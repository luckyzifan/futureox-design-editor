import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PLUGIN_UI_BYTES, createPluginDirectoryHost, parseDeclaredPluginManifest, readPluginFile, scanDeclaredPlugins } from '../src/plugin-package.mjs'
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
    await assert.rejects(() => host.read(opened.grant, ['dist/code.js']), error =>
      error.code === 'PLUGIN_FILE_MISSING' && /Missing built plugin entry dist\/code\.js/.test(error.message) && !error.message.includes(root))
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
  let requestPolicy
  let permissionPolicy
  const host = createPluginUiHost({
    BrowserWindow: class extends EventEmitter {
      constructor(options) {
        super()
        this.options = options
        this.webContents = new EventEmitter()
        this.webContents.mainFrame = {}
        this.webContents.setWindowOpenHandler = () => {}
        this.webContents.send = (...args) => sent.push(args)
        this.destroyed = false
        windows.push(this)
      }
      isDestroyed() { return this.destroyed }
      loadURL(url) { this.url = url; return Promise.resolve() }
      close() { this.destroyed = true; this.emit('closed') }
    },
    session: { fromPartition() { return {
      setPermissionRequestHandler: handler => { permissionPolicy = handler },
      webRequest: { onBeforeRequest: handler => { requestPolicy = handler } },
    } } },
    ipcMain: { on: (name, fn) => listeners.set(name, fn), handle: (name, fn) => listeners.set(name, fn) },
    preloadPath: '/plugin-ui-preload.cjs',
    send: (channel, value) => sent.push([channel, value]),
  })
  await host.open({ html: '<main>Labels</main>', width: 300, height: 220, title: 'Labeled rectangles', parent: { isDestroyed: () => false } })
  const window = windows[0]
  assert.equal(window.options.webPreferences.sandbox, true)
  assert.equal(window.options.webPreferences.nodeIntegration, false)
  assert.equal(window.options.webPreferences.contextIsolation, true)
  assert.match(window.url, /^data:text\/html/)
  requestPolicy({ url: 'https://example.test/plugin' }, result => assert.deepEqual(result, { cancel: true }))
  requestPolicy({ url: 'about:blank' }, result => assert.deepEqual(result, { cancel: false }))
  permissionPolicy(window.webContents, 'media', allowed => assert.equal(allowed, false))
  const listener = listeners.get('design-desktop:plugin-ui-message')
  listener({ sender: { id: 'other' } }, { pluginMessage: { type: 'nope' } })
  assert.equal(sent.some(entry => entry[0] === 'design-desktop:plugin-ui-message'), false)
  listener({ sender: window.webContents }, { pluginMessage: { type: 'create', count: 2 } })
  assert.deepEqual(sent.at(-1), ['design-desktop:plugin-ui-message', { pluginMessage: { type: 'create', count: 2 } }])
  host.post({ type: 'created' })
  assert.deepEqual(sent.at(-1), ['design-desktop:plugin-ui-deliver', { pluginMessage: { type: 'created' } }])
  host.close()
  assert.equal(sent.some(entry => entry[0] === 'design-desktop:plugin-ui-closed'), false)
  const exact = '测'.repeat(Math.floor(PLUGIN_UI_BYTES / 3)) + 'x'.repeat(PLUGIN_UI_BYTES % 3)
  assert.equal(Buffer.byteLength(exact, 'utf8'), PLUGIN_UI_BYTES)
  await host.open({ html: exact })
  const encoded = windows.at(-1).url.split(',')[1]
  assert.ok(Buffer.from(encoded, 'base64').toString('utf8').includes(exact))
  assert.throws(() => wrapPluginUiDocument(exact + '!'), /UTF-8 bytes/)
  host.close()
})

test('startup scan enables declared plugins and ignores symlinks, FigJam, duplicates and escapes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-scan-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-scan-out-'))
  const manifest = (name, id, extra = {}) => ({ name, id, api: '1.0.0', main: 'code.js', editorType: ['figma'], ...extra })
  try {
    const sample = await readFile(new URL('../../design-client/plugins/labeled-rectangles/manifest.json', import.meta.url), 'utf8')
    assert.equal(parseDeclaredPluginManifest(sample).id, 'futureox.sample.labeled-rectangles')
    assert.equal(parseDeclaredPluginManifest(sample).ui, 'ui.html')
    assert.equal(parseDeclaredPluginManifest(JSON.stringify(manifest('Inspector', 'local.inspector', { editorType: ['dev'] }))).id, 'local.inspector')
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
    assert.equal(again[0].grant, enabled[0].grant)
    await assert.rejects(() => host.read(enabled[1].grant, ['code.js']))
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

test('desktop scan admits named UI and requires every declared page within its shared byte budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-ui-'))
  const manifest = { name: 'Named pages', id: 'named.pages', api: '1.0.0', main: 'code.js', ui: { import: 'nested/import.html', export: 'export.html' } }
  const files = { 'code.js': 'figma.closePlugin()', 'nested/import.html': '<p>Import</p>', 'export.html': '<p>Export</p>' }
  try {
    assert.deepEqual(parseDeclaredPluginManifest(JSON.stringify(manifest)).uiFiles, manifest.ui)
    assert.throws(() => parseDeclaredPluginManifest(JSON.stringify({ ...manifest, ui: { import: '../out.html' } })))
    await writePlugin(path.join(root, 'valid'), manifest, files)
    await writePlugin(path.join(root, 'missing'), { ...manifest, id: 'named.missing' }, { 'code.js': files['code.js'] })
    const page = '测'.repeat(100_000)
    await writePlugin(path.join(root, 'large'), { ...manifest, id: 'named.large' }, { ...files, 'nested/import.html': page, 'export.html': page })
    const scanned = await scanDeclaredPlugins(root)
    assert.deepEqual(scanned.plugins.map(plugin => plugin.id), ['named.pages'])
    assert.equal(scanned.skipped, 2)
    const host = createPluginDirectoryHost()
    const [enabled] = host.enableDeclared(scanned.plugins)
    const loaded = await host.read(enabled.grant, ['nested/import.html', 'export.html'])
    assert.deepEqual(loaded.files, { 'nested/import.html': '<p>Import</p>', 'export.html': '<p>Export</p>' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop plugin ids are stable for locally granted folders and safe JSON numbers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-ids-'))
  const base = { name: 'Local', api: '1.0.0', main: 'code.js' }
  try {
    await writePlugin(path.join(root, 'a'), base)
    await writePlugin(path.join(root, 'b'), base)
    await writePlugin(path.join(root, 'numeric'), { ...base, id: 738167123456 })
    await writePlugin(path.join(root, 'unsafe'), { ...base, id: Number.MAX_SAFE_INTEGER + 1 })
    const first = await scanDeclaredPlugins(root)
    const [a, b, numeric] = first.plugins.map(plugin => plugin.id)
    assert.match(a, /^futureox\.local\.folder:[0-9a-f]{64}$/)
    assert.notEqual(a, b)
    assert.equal(numeric, '738167123456')
    assert.equal(first.skipped, 1)
    await writePlugin(path.join(root, 'reserved'), { ...base, id: a })
    const again = await scanDeclaredPlugins(root)
    assert.deepEqual(again.plugins.map(plugin => plugin.id), [a, b, numeric])
    assert.equal(again.skipped, 2)
    const host = createPluginDirectoryHost()
    const picked = await host.take(path.join(root, 'a'))
    assert.equal(JSON.parse(picked.manifestText).id, a)
    assert.equal(picked.manifestText.includes(root), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop folders load a bounded sibling TypeScript entry without executing its build', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'futureox-plugin-source-'))
  const folder = path.join(root, 'source')
  const manifest = { name: 'Typed plugin', id: 'typed.plugin', api: '1.0.0', main: 'code.js' }
  try {
    await writePlugin(folder, manifest, {
      'code.ts': "const text: string = 'typed'; throw new Error(text)",
      'package.json': '{"scripts":{"build":"node build.mjs"}}',
      'build.mjs': "throw new Error('build was run')",
    })
    const found = await scanDeclaredPlugins(root)
    assert.equal(found.plugins[0].id, manifest.id)
    const host = createPluginDirectoryHost()
    const [enabled] = host.enableDeclared(found.plugins)
    const read = () => host.read(enabled.grant, ['code.js'])
    const typed = (await read()).files['code.js']
    assert.match(typed, /const text\s*= 'typed'/)
    assert.match(typed, /throw new Error/)
    await assert.rejects(() => host.read(enabled.grant, ['code.ts']))
    await writeFile(path.join(folder, 'code.js'), 'figma.closePlugin("compiled")')
    assert.equal((await read()).files['code.js'], 'figma.closePlugin("compiled")')
    await rm(path.join(folder, 'code.js'))
    await writeFile(path.join(folder, 'code.ts'), "import { run } from './helper.js'; run()")
    await assert.rejects(read, error => error.code === 'PLUGIN_SOURCE_UNSUPPORTED')
  } finally { await rm(root, { recursive: true, force: true }) }
})
