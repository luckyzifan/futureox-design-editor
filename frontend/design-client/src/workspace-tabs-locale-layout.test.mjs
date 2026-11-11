// Issue #286 layout gate. Real WorkspaceTabs, LocalHome, styles.css and
// local-home.css in headless Chrome. Widths and elementFromPoint hits are
// measured, not mocked. Linux Chrome is not macOS Electron, Metal, or a
// native window work area.
// Run: node --test src/workspace-tabs-locale-layout.test.mjs
// Needs Chrome plus design-client node_modules (esbuild, react, react-dom, lucide-react).
import assert from 'node:assert/strict'
import { spawn, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const src = new URL('.', import.meta.url).pathname
const repo = new URL('../../..', import.meta.url).pathname
const deps = process.env.TABS_LAYOUT_DEPS || join(src, '..', 'node_modules')
const reportOnly = process.env.TABS_LAYOUT_REPORT === '1'
const overlay = process.env.TABS_LAYOUT_OVERLAY || ''
const views = [
  { w: 1000, h: 640 },
  { w: 1280, h: 800 },
  { w: 1440, h: 960 },
  { w: 1728, h: 1000 },
]
const modes = ['figma', 'sketch']
const locales = ['zh-CN', 'en']
const labels = { 'zh-CN': '设计文档标签', en: 'Design document tabs' }
const newLabels = { 'zh-CN': '新建文档标签', en: 'New document tab' }
const closePrefix = { 'zh-CN': '关闭文档 ', en: 'Close ' }

test('document tabs keep the full shell width and home isolation in both locales', { timeout: 180_000 }, async () => {
  const data = await measure()
  const out = process.env.TABS_LAYOUT_OUT
  if (out) await writeFile(out, JSON.stringify(data, null, 2))
  console.log(summary(data))
  if (reportOnly) return
  assertFixed(data)
})

function assertFixed(data) {
  const styles = data.sources.text.styles
  const homeCss = data.sources.text.homeCss
  const homeTs = data.sources.text.homeTs
  const tabsTs = data.sources.text.tabsTs
  assert.match(styles, /\.editor-shell > nav\[data-workspace-tabs\] \{ grid-column: 1 \/ -1; grid-row: 1; \}/)
  assert.doesNotMatch(styles, /aria-label="设计文档标签"/)
  assert.match(homeCss, /nav\[data-workspace-tabs\]/)
  assert.doesNotMatch(homeCss, /aria-label="设计文档标签"/)
  assert.match(homeTs, /nav\[data-workspace-tabs\]/)
  assert.doesNotMatch(homeTs, /设计文档标签/)
  assert.match(tabsTs, /data-workspace-tabs/)
  assert.match(tabsTs, /Design document tabs/)
  assert.match(tabsTs, /设计文档标签/)
  assert.equal(data.editor.length, views.length * modes.length * locales.length)
  for (const shot of data.editor) {
    assert.equal(shot.innerWidth, shot.requestedWidth, JSON.stringify(shot))
    assert.equal(shot.label, labels[shot.locale], shot.label)
    assert.equal(shot.marker, true)
    same(shot.navWidth, shot.innerWidth, `editor ${shot.mode} ${shot.locale} ${shot.requestedWidth}`)
    assert.match(shot.gridColumn, /1 \/ -1/)
    const enabled = shot.buttons.filter(button => !button.disabled)
    assert.equal(enabled.length, 5, JSON.stringify(enabled.map(button => button.label)))
    for (const button of enabled) {
      assert.equal(button.centerHit, true, `${shot.mode} ${shot.locale} ${shot.requestedWidth} ${button.label} -> ${button.hit}`)
      assert.equal(button.centerInsideNav, true, button.label)
    }
  }
  assert.equal(data.decouple.length, views.length * modes.length * 2)
  for (const shot of data.decouple) {
    same(shot.navWidth, shot.innerWidth, `decouple ${shot.mode} ${shot.requestedWidth} ${shot.label}`)
    assert.equal(shot.marker, true)
  }
  for (const shot of data.home) {
    if (shot.phase === 'nonsense') assert.equal(shot.label, 'not-a-locale-label')
    else assert.equal(shot.label, labels[shot.locale], JSON.stringify({ phase: shot.phase, label: shot.label, mode: shot.mode }))
    assert.equal(shot.innerWidth, 1440, shot.phase)
    same(shot.navWidth, shot.innerWidth, `home ${shot.phase} ${shot.mode} ${shot.locale}`)
    assert.equal(shot.inert, true, `${shot.phase} ${shot.mode} ${shot.locale}`)
    assert.equal(shot.visibility, 'hidden', `${shot.phase} ${shot.mode} ${shot.locale}`)
    for (const part of ['header', 'main', 'nav', 'footer']) assert.equal(shot.placed[part]?.inert, true, `${shot.phase} ${part}`)
    if (shot.phase === 'fresh' || shot.phase === 'reload') assert.equal(shot.searchFocused, true, shot.phase)
    if (shot.tabTrace) {
      assert.equal(shot.tabTrace.length, 18)
      assert.equal(shot.shiftTrace.length, 18)
      assert.equal(shot.tabTrace[0].label, shot.locale === 'en' ? 'Refresh' : '刷新', shot.phase)
      assert.equal(shot.shiftTrace[0].label, shot.locale === 'en' ? 'Open design file' : '打开设计文件', shot.phase)
      for (const step of [...shot.tabTrace, ...shot.shiftTrace]) {
        assert.equal(step.inWorkspaceTabs, false, JSON.stringify(step))
        assert.notEqual(step.label, 'New document tab')
        assert.notEqual(step.label, '新建文档标签')
      }
    }
    if (shot.phase === 'fresh') {
      assert.equal(shot.resume?.centerHit, true, JSON.stringify(shot.resume))
      assert.equal(shot.resumed?.home, false)
      assert.equal(shot.resumed?.inert, false)
      assert.equal(shot.resumed?.visibility, 'visible')
      assert.equal(shot.resumed?.label, labels[shot.locale])
      same(shot.resumed.navWidth, shot.resumed.innerWidth, `resumed ${shot.mode} ${shot.locale}`)
      const enabled = shot.resumed.buttons.filter(button => !button.disabled)
      assert.equal(enabled.length, 5)
      for (const button of enabled) assert.equal(button.centerHit, true, `${shot.locale} ${button.label} -> ${button.hit}`)
    }
  }
  for (const shot of data.saved) {
    assert.equal(shot.label, labels[shot.locale])
    assert.equal(shot.modeAttribute, shot.mode)
    assert.equal(shot.innerWidth, 1440)
    same(shot.navWidth, shot.innerWidth, `saved ${shot.mode} ${shot.locale}`)
    assert.equal(shot.inert, true)
    assert.equal(shot.visibility, 'hidden')
    assert.equal(shot.tabTrace[0].label, shot.locale === 'en' ? 'Refresh' : '刷新')
    for (const step of shot.tabTrace) {
      assert.equal(step.inWorkspaceTabs, false, JSON.stringify(step))
      assert.notEqual(step.label, newLabels[shot.locale])
    }
  }
  for (const shot of data.actions) {
    assert.equal(shot.switched.centerHit, true)
    assert.equal(shot.switched.selected, true)
    assert.ok(shot.switched.actions.includes('switch:qa-b'))
    assert.equal(shot.closed.centerHit, true)
    assert.ok(shot.closed.actions.includes('close:qa-a'))
    assert.deepEqual(shot.closed.names, ['QA Document B'])
    assert.equal(shot.created.centerHit, true)
    assert.deepEqual(shot.created.names, ['QA Document B', '未命名设计'])
    assert.match(shot.created.actions.at(-1), /^new:未命名设计:[0-9a-f-]{36}$/)
    for (const button of shot.created.buttons.filter(button => !button.disabled)) assert.equal(button.centerHit, true, button.label)
  }
}

function same(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.51, `${message}: ${actual} vs ${expected}`)
}

function summary(data) {
  const lines = [`chrome=${data.environment.browser} dpr=${data.environment.deviceScaleFactor} commit=${data.environment.commit}`]
  for (const shot of data.editor) {
    const hits = shot.buttons.filter(button => button.centerHit && !button.disabled).length
    lines.push(`editor ${shot.mode} ${shot.locale} ${shot.requestedWidth} nav=${shot.navWidth} inner=${shot.innerWidth} hits=${hits}/${shot.buttons.length} grid=${shot.gridColumn}`)
  }
  for (const shot of data.decouple) lines.push(`decouple ${shot.mode} ${shot.requestedWidth} label=${JSON.stringify(shot.label)} nav=${shot.navWidth}`)
  for (const shot of data.home) {
    const entered = shot.tabTrace?.filter(step => step.inWorkspaceTabs).length
    lines.push(`home ${shot.phase} ${shot.mode} ${shot.locale} inert=${shot.inert} visibility=${shot.visibility} tabEntered=${entered ?? 'n/a'} nav=${shot.navWidth}`)
  }
  for (const shot of data.saved) lines.push(`saved ${shot.mode} ${shot.locale} label=${shot.label} inert=${shot.inert} visibility=${shot.visibility}`)
  for (const shot of data.actions) lines.push(`actions ${shot.locale} switch=${shot.switched.actions.at(-1)} close=${shot.closed.names.join('|')} new=${shot.created.names.join('|')}`)
  return lines.join('\n')
}

async function measure() {
  const dir = await mkdtemp(join(tmpdir(), 'tabs-locale-'))
  const esbuildMain = join(deps, 'esbuild', 'lib', 'main.js')
  if (!existsSync(esbuildMain)) throw new Error(`esbuild is required at ${esbuildMain}. Install the design-client dependencies, including esbuild, react, react-dom, and lucide-react.`)
  const { build } = await import(pathToFileURL(esbuildMain).href)
  await build({
    absWorkingDir: join(src, '..'),
    entryPoints: [join(src, 'workspace-tabs-locale-probe.tsx')],
    bundle: true,
    outfile: join(dir, 'probe.js'),
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    sourcemap: 'inline',
    legalComments: 'none',
    nodePaths: [deps],
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: overlay ? [overlayPlugin(overlay)] : [],
    logLevel: 'silent',
  })
  await writeFile(join(dir, 'index.html'), html())
  const server = await serve(dir)
  const chrome = await launchChrome()
  try {
    const version = await waitJson(`http://127.0.0.1:${chrome.port}/json/version`)
    const page = await openPage(chrome.port)
    const client = await connect(page.webSocketDebuggerUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const origin = `http://127.0.0.1:${server.address().port}`
    await setView(client, views[2])
    await navigate(client, `${origin}/?editor=1`)
    const editor = []
    for (const view of views) {
      await setView(client, view)
      for (const mode of modes) {
        for (const locale of locales) {
          await call(client, 'setMode', mode)
          await call(client, 'setLocale', locale)
          await call(client, 'setHome', false)
          await call(client, 'resetDocuments')
          const shot = await call(client, 'syncWidth')
          editor.push({ ...shot, requestedWidth: view.w, requestedHeight: view.h, mode, locale })
        }
      }
    }
    const decouple = []
    for (const view of views) {
      await setView(client, view)
      for (const mode of modes) {
        await call(client, 'setMode', mode)
        await call(client, 'setLocale', 'zh-CN')
        await call(client, 'setHome', false)
        for (const name of ['Design document tabs', 'not-a-locale-label']) {
          const shot = await call(client, 'retitle', name)
          decouple.push({ ...shot, requestedWidth: view.w, mode })
        }
        await call(client, 'retitle', null)
      }
    }
    const home = []
    for (const mode of modes) {
      for (const locale of locales) {
        await setView(client, { w: 1440, h: 960 })
        await navigate(client, `${origin}/?fresh=1&home=1&locale=${locale}&mode=${mode}&n=${home.length}`)
        await settled(client)
        const fresh = await call(client, 'read')
        const tabTrace = await traceTabs(client, false)
        const shiftTrace = await traceTabs(client, true)
        const resume = await call(client, 'resumeButton')
        let resumed = null
        if (resume?.centerHit) {
          await mouse(client, resume.x, resume.y)
          resumed = await waitHome(client, false)
        }
        await call(client, 'setHome', true)
        const nonsense = await call(client, 'retitle', 'not-a-locale-label')
        home.push({ ...fresh, phase: 'fresh', mode, locale, tabTrace, shiftTrace, resume, resumed })
        home.push({ ...nonsense, phase: 'nonsense', mode, locale })
        await reload(client)
        await setView(client, { w: 1440, h: 960 })
        await settled(client)
        const again = await call(client, 'read')
        const reloadTrace = await traceTabs(client, false)
        const reloadShift = await traceTabs(client, true)
        home.push({ ...again, phase: 'reload', mode, locale, tabTrace: reloadTrace, shiftTrace: reloadShift })
      }
    }
    const saved = []
    for (const mode of modes) {
      for (const locale of locales) {
        await setView(client, { w: 1440, h: 960 })
        await navigate(client, `${origin}/?fresh=1&home=1&locale=${encodeURIComponent(locale)}&mode=${mode}&n=save-${mode}-${locale}`)
        await navigate(client, `${origin}/?home=1&n=saved-${mode}-${locale}`)
        await settled(client)
        const shot = await call(client, 'read')
        const tabTrace = await traceTabs(client, false)
        saved.push({ ...shot, mode, locale, tabTrace })
      }
    }
    const actions = []
    for (const locale of locales) {
      await setView(client, { w: 1440, h: 960 })
      await navigate(client, `${origin}/?fresh=1&locale=${locale}&mode=figma&n=act-${locale}`)
      await call(client, 'setHome', false)
      await call(client, 'resetDocuments')
      const initial = await call(client, 'read')
      const second = initial.buttons.find(button => button.role === 'tab' && button.label === 'QA Document B')
      const switchedShot = await clickButton(client, second, initial.actions.length)
      const close = switchedShot.buttons.find(button => button.label === `${closePrefix[locale]}Layout and operation QA`)
      const closedShot = await clickButton(client, close, switchedShot.actions.length)
      const createdButton = closedShot.buttons.find(button => button.label === newLabels[locale])
      const createdShot = await clickButton(client, createdButton, closedShot.actions.length)
      actions.push({
        locale,
        switched: { centerHit: !!second?.centerHit, selected: switchedShot.tabNames.find(tab => tab.name === 'QA Document B')?.selected === 'true', actions: switchedShot.actions },
        closed: { centerHit: !!close?.centerHit, names: closedShot.tabNames.map(tab => tab.name), actions: closedShot.actions },
        created: { centerHit: !!createdButton?.centerHit, names: createdShot.tabNames.map(tab => tab.name), actions: createdShot.actions, buttons: createdShot.buttons },
      })
    }
    const errors = await evaluate(client, 'window.__pageErrors || []')
    if (errors.length) throw new Error(`page errors: ${errors.join('\n')}`)
    return {
      environment: {
        browser: version.Browser,
        product: version['User-Agent'],
        platform: process.platform,
        arch: process.arch,
        deviceScaleFactor: 1,
        headless: true,
        electron: false,
        metal: false,
        commit: execSync('git rev-parse HEAD', { cwd: repo }).toString().trim(),
        viewportNote: '1000×640, 1280×800, 1440×960, and 1728×1000 CSS pixels. 1728 is the reported width; this VM has no macOS work area.',
      },
      sources: await sourceText(),
      editor,
      decouple,
      home,
      saved,
      actions,
    }
  } finally {
    chrome.process.kill('SIGKILL')
    server.close()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function html() {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
const q = new URLSearchParams(location.search)
const KEY = 'forma.interface-preferences.v1'
if (q.get('fresh') === '1') localStorage.removeItem(KEY)
if (q.get('locale') || q.get('mode')) {
  const prev = JSON.parse(localStorage.getItem(KEY) || '{}')
  const next = { ...prev }
  if (q.get('locale')) next.locale = q.get('locale')
  if (q.get('mode')) next.uiMode = q.get('mode')
  localStorage.setItem(KEY, JSON.stringify(next))
}
</script><link rel="stylesheet" href="/probe.css"><style>html,body,#root{margin:0;height:100%;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body><div id="root"></div><script type="module" src="/probe.js"></script></body></html>`
}

function overlayPlugin(dir) {
  return {
    name: 'baseline-overlay',
    setup(build) {
      build.onLoad({ filter: /(?:styles\.css|local-home\.css|LocalHome\.tsx)$/ }, async (args) => {
        if (!args.path.includes(`${sep}src${sep}`)) return null
        const file = join(dir, basename(args.path))
        if (!existsSync(file)) return null
        return { contents: await readFile(file, 'utf8'), loader: file.endsWith('.css') ? 'css' : 'tsx' }
      })
    },
  }
}

async function sourceText() {
  const files = { styles: 'styles.css', homeCss: 'local-home.css', homeTs: 'LocalHome.tsx', tabsTs: 'WorkspaceTabs.tsx' }
  const text = {}
  const sha256 = {}
  for (const [key, name] of Object.entries(files)) {
    const overlaid = overlay && existsSync(join(overlay, name)) ? join(overlay, name) : join(src, name)
    text[key] = await readFile(overlaid, 'utf8')
    sha256[key] = createHash('sha256').update(text[key]).digest('hex')
  }
  return { text, sha256, overlay: overlay || null }
}

async function traceTabs(client, shift) {
  await evaluate(client, `document.querySelector('.local-home-filter input').focus()`)
  const trace = []
  for (let step = 0; step < 18; step += 1) {
    await keyTab(client, shift)
    trace.push(await evaluate(client, 'window.__tabsProbe.focus()'))
  }
  return trace
}

async function settled(client) {
  const deadline = Date.now() + 5_000
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(client, 'window.__tabsProbe.read()')
    if (last.homeSettled && last.home) return last
    await delay(20)
  }
  throw new Error(`home did not settle: ${JSON.stringify(last)}`)
}

async function waitHome(client, home) {
  const deadline = Date.now() + 3_000
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(client, 'window.__tabsProbe.read()')
    if (last.home === home) return last
    await delay(20)
  }
  throw new Error(`home stayed ${last?.home}`)
}

async function clickButton(client, button, previous) {
  if (button?.centerHit) await mouse(client, button.x + button.w / 2, button.y + button.h / 2)
  const deadline = Date.now() + 2_000
  let shot = await call(client, 'read')
  while (Date.now() < deadline && shot.actions.length === previous) {
    await delay(20)
    shot = await call(client, 'read')
  }
  return shot
}

async function call(client, name, arg) {
  const expression = arg === undefined ? `window.__tabsProbe.${name}()` : `window.__tabsProbe.${name}(${JSON.stringify(arg)})`
  return evaluate(client, expression)
}

async function navigate(client, url) {
  const loaded = client.wait('Page.loadEventFired')
  await client.send('Page.navigate', { url })
  await loaded
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitProbe(client)
  await evaluate(client, 'document.fonts.ready')
}

async function reload(client) {
  const loaded = client.wait('Page.loadEventFired')
  await client.send('Page.reload', { ignoreCache: true })
  await loaded
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitProbe(client)
}

async function setView(client, view) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: view.w, height: view.h, deviceScaleFactor: 1, mobile: false, screenWidth: view.w, screenHeight: view.h,
  })
}

async function waitProbe(client) {
  const deadline = Date.now() + 10_000
  let last = 'unloaded'
  while (Date.now() < deadline) {
    const value = await evaluate(client, '({ probe: !!window.__tabsProbe, boot: window.__bootError || null, errors: window.__pageErrors || [] })').catch(error => ({ failed: String(error) }))
    if (value.probe) {
      if (value.errors?.length) throw new Error(value.errors.join('\n'))
      return
    }
    last = JSON.stringify(value)
    await delay(30)
  }
  throw new Error(`probe did not boot (${last})`)
}

async function keyTab(client, shift) {
  const modifiers = shift ? 8 : 0
  const event = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers }
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', ...event })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
}

async function mouse(client, x, y) {
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const path = join(dir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    try {
      const body = await readFile(path)
      response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' })
      response.end(body)
    } catch {
      response.writeHead(404)
      response.end('missing')
    }
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function launchChrome() {
  const binary = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(item => item && existsSync(item))
  if (!binary) throw new Error('Chrome is required to measure tab layout')
  const dir = await mkdtemp(join(tmpdir(), 'tabs-chrome-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const chrome = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr?.resume()
  chrome.once('exit', () => { rm(dir, { recursive: true, force: true }).catch(() => {}) })
  return { process: chrome, port }
}

async function openPage(port) {
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
  const page = pages.find(item => item.type === 'page')
  if (!page?.webSocketDebuggerUrl) throw new Error('Chrome did not open a page')
  return page
}

function connect(url) {
  const ws = new WebSocket(url)
  let sequence = 0
  const pending = new Map()
  const waiting = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
    for (let index = waiting.length - 1; index >= 0; index -= 1) {
      if (waiting[index].method === message.method) waiting.splice(index, 1)[0].resolve(message.params)
    }
  })
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve({
      send(method, params = {}) {
        const id = ++sequence
        ws.send(JSON.stringify({ id, method, params }))
        return new Promise((done, fail) => pending.set(id, { resolve: done, reject: fail }))
      },
      wait(method) { return new Promise(done => waiting.push({ method, resolve: done })) },
    }), { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails))
  return result.result?.value
}

async function waitJson(url) {
  const deadline = Date.now() + 10_000
  let last = 'unreachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
      last = `${response.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await delay(50)
  }
  throw new Error(`${url} did not become ready (${last})`)
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
