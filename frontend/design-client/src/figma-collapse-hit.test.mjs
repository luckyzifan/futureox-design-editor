/** Headed Chrome hit test for the Figma title collapse control.
 * innerWidth 900 can miss (max-width: 900px) when device pixels are fractional.
 * Density must follow that query, and the click center must still be the button. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const binary = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
const shotDir = join(tmpdir(), 'figma-collapse-hits')

test('Figma collapse center hits itself at 900 and at a narrower and a wider width', { timeout: 90_000 }, async () => {
  assert.ok(binary, 'headed Chrome is required')
  assert.match(styles, /\.editor-shell\[data-ui-mode="figma"\]\[data-density="desk"\] \.editor-header \.header-right \{[^}]*min-width:\s*0/)
  await mkdir(shotDir, { recursive: true })
  const session = await launch()
  try {
    const cases = [
      [900, 640],
      [800, 640],
      [640, 640],
      [560, 640],
      [1000, 640],
      [1180, 800],
      [1440, 960],
    ]
    const measured = []
    for (const [width, height] of cases) {
      const fitted = await session.fit(width, height)
      for (const mode of ['figma', 'sketch']) {
        const hit = await session.measure(mode, 'zh-CN')
        measured.push({ ask: { width, height }, fitted, ...hit })
        if (mode === 'figma') assertFigma(hit, fitted)
        else if (width >= 900) assertSketchStable(hit)
      }
    }
    const fractional = measured.find(item => item.ask.width === 900 && item.mode === 'figma')
    const wider = measured.find(item => item.ask.width === 1440 && item.mode === 'figma')
    assert.equal(fractional.inner.w, 900)
    assert.equal(fractional.density === 'narrow', fractional.narrowMedia)
    assert.ok(wider.inner.w > 1180)
    await session.fit(900, 640)
    const wideLabels = await session.measure('figma', 'en')
    assert.equal(wideLabels.inner.w, 900)
    assertFigma(wideLabels, wideLabels.inner)
    await session.emulate(900, 640, 1)
    const exact = await session.measure('figma', 'zh-CN')
    assert.equal(exact.inner.w, 900)
    assert.equal(exact.density === 'narrow', exact.narrowMedia)
    assertFigma(exact, exact.inner)
    await session.clearEmulation()
    await session.fit(900, 640)
    await session.measure('figma', 'zh-CN')
    await writeFile(join(shotDir, 'figma-900.png'), await session.screenshot())
    await session.fit(1440, 960)
    await session.measure('figma', 'zh-CN')
    await writeFile(join(shotDir, 'figma-1440.png'), await session.screenshot())
    console.log(JSON.stringify({
      shotDir,
      dpr: fractional.dpr,
      cases: measured.map(item => ({
        ask: item.ask,
        inner: item.inner,
        mode: item.mode,
        density: item.density,
        narrowMedia: item.narrowMedia,
        collapse: item.collapse,
        figma: item.figma,
        sketch: item.sketch,
        header: item.header,
        collapseHit: item.collapseHit,
        figmaHit: item.figmaHit,
        sketchHit: item.sketchHit,
        overlap: item.overlap,
      })),
      exactDpr: { dpr: exact.dpr, density: exact.density, narrowMedia: exact.narrowMedia, collapse: exact.collapse, figma: exact.figma, collapseHit: exact.collapseHit },
      wideLabels: { collapseHit: wideLabels.collapseHit, figmaHit: wideLabels.figmaHit, sketchHit: wideLabels.sketchHit, overlap: wideLabels.overlap },
    }, null, 2))
  } finally {
    await session.close()
  }
})

function assertFigma(hit, fitted) {
  const where = `${hit.mode} ${hit.inner.w}×${hit.inner.h} density=${hit.density} media900=${hit.narrowMedia}`
  assert.equal(hit.collapseHit.self, true, `${where} collapse -> ${hit.collapseHit.label}`)
  assert.equal(hit.figmaHit.self, true, `${where} Figma -> ${hit.figmaHit.label}`)
  assert.equal(hit.sketchHit.self, true, `${where} Sketch -> ${hit.sketchHit.label}`)
  assert.equal(hit.overlap.w < 0.5 || hit.overlap.h < 0.5, true, `${where} overlap ${hit.overlap.w}×${hit.overlap.h}`)
  for (const control of hit.covered) assert.fail(`${where} ${control.label} covers collapse by ${control.overlap.w}×${control.overlap.h}`)
  if (fitted.w >= 1400 || hit.inner.w >= 1400) {
    assert.equal(hit.header.w, 280, where)
    assert.equal(hit.header.h, 48, where)
  }
}

function assertSketchStable(hit) {
  const where = `sketch ${hit.inner.w}`
  assert.equal(hit.collapseHit.self, true, `${where} -> ${hit.collapseHit.label}`)
  assert.equal(hit.figmaHit.self, true, where)
  assert.equal(hit.sketchHit.self, true, where)
}

function overlaps(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return { w: Math.max(0, +w.toFixed(2)), h: Math.max(0, +h.toFixed(2)) }
}

function probeHtml() {
  const href = name => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;height:100%}#shell{width:100vw;height:100vh}svg{width:16px;height:16px;display:block}</style>
</head><body>
<div id="shell" class="app-shell editor-shell" data-ui-mode="figma" data-density="desk">
  <header class="editor-header">
    <button class="brand" aria-label="文件菜单"><strong>Futureox Design</strong></button>
    <div class="document-title">
      <button type="button" class="document-location">本机设计</button>
      <input aria-label="文档名称" value="未命名">
      <button type="button" id="collapse" aria-pressed="false" aria-label="收起界面"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4zM9 5v14"/></svg></button>
    </div>
    <div class="header-right" id="header-right">
      <details class="workspace-actions"><summary aria-label="更多操作"><svg viewBox="0 0 24 24"></svg></summary></details>
      <span class="save-status" id="save">已自动保存到工作副本</span>
      <button type="button" id="files" aria-label="本机文件"><svg viewBox="0 0 24 24"></svg>本机文件</button>
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" id="mode-figma" aria-pressed="true">Figma</button>
        <button type="button" id="mode-sketch" aria-pressed="false">Sketch</button>
      </div>
      <label class="locale-switch"><select id="locale" aria-label="界面语言"><option>中文</option><option>English</option></select></label>
      <button type="button" class="design-agent-toggle" aria-label="设计助手"><svg viewBox="0 0 24 24"></svg><span>设计助手</span></button>
      <button type="button" class="prototype-preview-button" aria-label="预览原型"><svg viewBox="0 0 24 24"></svg><span>预览</span></button>
      <button type="button" class="primary" id="export"><svg viewBox="0 0 24 24"></svg>导出</button>
      <button type="button" class="app-settings-button" id="settings" aria-label="设置"><svg viewBox="0 0 24 24"></svg><span id="settings-label">设置</span></button>
    </div>
  </header>
  <div class="editor-workspace">
    <nav class="workspace-rail"><button type="button">图层</button></nav>
    <div class="adaptive-layers-shell"><div class="layers-panel"></div></div>
    <div class="canvas-workspace"><div class="toolbar floating-toolbar"><button type="button" aria-label="选择">选</button></div></div>
    <div class="properties-workspace"></div>
  </div>
  <footer><span>设计已打开</span></footer>
</div>
<script>
  const shell = document.getElementById('shell')
  const NARROW = '(max-width: 900px)'
  const DESK = '(max-width: 1180px)'
  const WIDE = '(min-width: 1181px)'
  function density() {
    const narrow = matchMedia(NARROW).matches, desk = matchMedia(DESK).matches, wide = matchMedia(WIDE).matches
    if (narrow || desk || wide) return narrow ? 'narrow' : desk ? 'desk' : 'wide'
    return innerWidth <= 900 ? 'narrow' : innerWidth <= 1180 ? 'desk' : 'wide'
  }
  function apply(mode, locale) {
    shell.setAttribute('data-ui-mode', mode)
    shell.style.setProperty('--workspace-layers-width', 'min(248px, var(--workspace-panel-cap, max(260px, 26vw)))')
    shell.style.setProperty('--workspace-inspector-width', 'min(280px, var(--workspace-panel-cap, max(260px, 26vw)))')
    shell.setAttribute('data-density', density())
    const english = locale === 'en'
    document.getElementById('files').lastChild.textContent = english ? 'Local files' : '本机文件'
    document.getElementById('settings-label').textContent = english ? 'Settings' : '设置'
    document.getElementById('export').lastChild.textContent = english ? 'Export' : '导出'
    document.getElementById('save').textContent = english ? 'Saved to the working copy' : '已自动保存到工作副本'
    document.getElementById('collapse').setAttribute('aria-label', english ? 'Collapse interface' : '收起界面')
    document.getElementById('locale').options[0].selected = !english
    document.getElementById('locale').options[1].selected = english
  }
  window.__apply = apply
  window.__measure = () => {
    shell.setAttribute('data-density', density())
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
    const hitOf = (el) => {
      const r = el.getBoundingClientRect()
      const x = r.x + r.width / 2, y = r.y + r.height / 2
      const hit = document.elementFromPoint(x, y)
      const owner = hit && (hit.closest('button,select,summary,[role="group"]') || hit)
      return { x: +x.toFixed(2), y: +y.toFixed(2), self: !!hit && (hit === el || el.contains(hit)), label: owner?.getAttribute?.('aria-label') || owner?.textContent?.trim()?.slice(0, 40) || null }
    }
    const collapse = document.getElementById('collapse')
    const collapseBox = box(collapse)
    const controls = [...document.querySelectorAll('#header-right button, #header-right select, #header-right summary')]
    const covered = controls.map(control => ({ label: control.getAttribute('aria-label') || control.id || control.textContent.trim(), box: box(control), overlap: null }))
    for (const control of covered) {
      const w = Math.min(collapseBox.x + collapseBox.w, control.box.x + control.box.w) - Math.max(collapseBox.x, control.box.x)
      const h = Math.min(collapseBox.y + collapseBox.h, control.box.y + control.box.h) - Math.max(collapseBox.y, control.box.y)
      control.overlap = { w: Math.max(0, +w.toFixed(2)), h: Math.max(0, +h.toFixed(2)) }
    }
    return {
      inner: { w: innerWidth, h: innerHeight }, dpr: devicePixelRatio,
      narrowMedia: matchMedia(NARROW).matches, density: shell.getAttribute('data-density'), mode: shell.getAttribute('data-ui-mode'),
      collapse: collapseBox, figma: box(document.getElementById('mode-figma')), sketch: box(document.getElementById('mode-sketch')),
      header: box(document.getElementById('header-right')),
      collapseHit: hitOf(collapse), figmaHit: hitOf(document.getElementById('mode-figma')), sketchHit: hitOf(document.getElementById('mode-sketch')),
      covered: covered.filter(control => control.overlap.w >= 0.5 && control.overlap.h >= 0.5),
    }
  }
</script></body></html>`
}

async function launch() {
  const dir = await mkdtemp(join(tmpdir(), 'figma-collapse-'))
  const port = 9400 + Math.floor(Math.random() * 400)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu',
    `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`,
    '--window-size=1100,800', '--window-position=0,0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } })
  chrome.stderr?.resume()
  const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
  assert.equal(String(version.Browser || '').includes('Headless'), false)
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
  const page = pages.find(item => item.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  const client = cdp(ws)
  await client.send('Page.enable')
  const { windowId } = await client.send('Browser.getWindowForTarget')
  const loaded = client.wait('Page.loadEventFired')
  await client.send('Page.navigate', { url: pathToFileURL(file).href })
  await loaded
  return {
    async fit(width, height) {
      let outerW = width + 16, outerH = height + 90
      let size = { w: 0, h: 0 }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await client.send('Browser.setWindowBounds', { windowId, bounds: { width: Math.max(200, outerW), height: Math.max(200, outerH), windowState: 'normal' } })
        await new Promise(resolve => setTimeout(resolve, 80))
        size = await evalJson(client, '({w:innerWidth,h:innerHeight})')
        if (size.w === width && size.h === height) return size
        outerW += width - size.w
        outerH += height - size.h
      }
      return size
    },
    async emulate(width, height, deviceScaleFactor) {
      await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false })
    },
    async clearEmulation() {
      await client.send('Emulation.clearDeviceMetricsOverride')
    },
    async measure(mode, locale) {
      await evalJson(client, `window.__apply(${JSON.stringify(mode)}, ${JSON.stringify(locale)})`)
      const hit = await evalJson(client, 'window.__measure()')
      const header = hit.header
      const collapse = hit.collapse
      hit.overlap = overlaps(collapse, header)
      return hit
    },
    async screenshot() {
      const shot = await client.send('Page.captureScreenshot', { format: 'png' })
      return Buffer.from(shot.data, 'base64')
    },
    async close() {
      ws.close()
      chrome.kill('SIGKILL')
      await new Promise(resolve => setTimeout(resolve, 150))
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

function cdp(ws) {
  let sequence = 0
  const pending = new Map()
  const waiting = []
  ws.addEventListener('message', (event) => {
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
  return {
    send(method, params = {}) {
      const id = ++sequence
      ws.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    wait(method) { return new Promise(resolve => waiting.push({ method, resolve })) },
  }
}

async function evalJson(client, expression) {
  const evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
  return evaluated.result.value
}

async function waitJson(url) {
  const deadline = Date.now() + 15_000
  let last = 'unreachable'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json()
      last = `${response.status}`
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`${url} did not become ready (${last})`)
}
