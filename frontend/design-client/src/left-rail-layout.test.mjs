// Issue #334. Computed boxes at 1440×960, DPR 1, from the real shell stylesheet.
// A hidden rail class is not enough: the first grid track must also be 0px,
// or the pages/layers sidebar and the canvas stay shifted by 57 or 44.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)

test('Figma and Sketch sidebars start at the window edge and the canvas starts at the sidebar', { timeout: 30_000 }, async () => {
  const measured = await measureChrome()
  assert.equal(measured.viewport.w, 1440)
  assert.equal(measured.viewport.h, 960)
  assert.equal(measured.viewport.dpr, 1)
  for (const mode of ['figma', 'sketch']) {
    const box = measured[mode]
    assert.equal(box.rail.display, 'none', mode)
    assert.equal(box.rail.w, 0, `${mode} rail ${box.rail.w}`)
    assert.equal(box.rail.h, 0, `${mode} rail height`)
    assert.equal(box.sidebar.x, 0, `${mode} sidebar x ${box.sidebar.x}`)
    assert.equal(box.sidebar.w, 248, `${mode} sidebar width is a different ticket`)
    assert.equal(box.canvas.x, box.sidebar.x + box.sidebar.w, `${mode} canvas x ${box.canvas.x}`)
    assert.equal(box.inspector.w, 280, `${mode} inspector width is a different ticket`)
    assert.equal(box.inspector.x, 1440 - box.inspector.w, `${mode} inspector x`)
    assert.ok(box.brand.w > 0 && box.brand.w <= 24, `${mode} mark ${box.brand.w}`)
    assert.ok(box.brand.x >= box.sidebar.x && box.brand.x + box.brand.w <= box.sidebar.x + box.sidebar.w, `${mode} mark column ${JSON.stringify(box.brand)}`)
    assert.equal(box.columns.startsWith('0px'), true, box.columns)
  }
  assert.equal(measured.figma.canvas.y, 38)
  assert.equal(measured.figma.sidebar.y, 38)
  assert.equal(measured.sketch.canvas.y, 53)
  assert.equal(measured.sketch.sidebar.y, measured.sketch.canvas.y)
  assert.match(measured.sketch.canvas.gridRow, /^3(?:\s|\/|$)/, measured.sketch.canvas.gridRow)
})

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;width:1440px;height:960px}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" data-ui-mode="figma" data-density="wide" style="width:1440px;height:960px;--workspace-layers-width:min(248px, var(--workspace-panel-cap, max(260px, 26vw)));--workspace-inspector-width:min(280px, var(--workspace-panel-cap, max(260px, 26vw)))">
  <header class="editor-header">
    <span class="header-divider"></span>
    <div class="document-title">
      <button type="button" class="brand" id="brand" aria-label="文件菜单"><img class="brand-mark" alt="" width="28" height="28"><strong>Futureox Design</strong></button>
      <button type="button" class="document-location">本机设计</button>
      <input aria-label="文档名称" value="未命名">
      <button type="button" aria-pressed="false" aria-label="收起界面">收</button>
    </div>
    <div class="header-right"></div>
  </header>
  <main class="editor-workspace">
    <nav class="workspace-rail" id="rail" aria-label="工作区">
      <button type="button">文件</button>
      <button type="button">图层</button>
      <button type="button">资源</button>
      <button type="button">工具</button>
      <button type="button">变量</button>
    </nav>
    <div class="adaptive-layers-shell" id="sidebar"><aside class="layers-panel"></aside></div>
    <div class="canvas-workspace" id="canvas"></div>
    <div class="properties-workspace" id="inspector"></div>
  </main>
</div>
<script>
const shell = document.querySelector('.editor-shell')
const box = (el) => {
  const r = el.getBoundingClientRect()
  const s = getComputedStyle(el)
  return { x: r.x, y: r.y, w: r.width, h: r.height, display: s.display }
}
const read = (mode) => {
  shell.setAttribute('data-ui-mode', mode)
  const canvas = document.getElementById('canvas')
  return {
    rail: box(document.getElementById('rail')),
    sidebar: box(document.getElementById('sidebar')),
    canvas: { ...box(canvas), gridRow: getComputedStyle(canvas).gridRow },
    inspector: box(document.getElementById('inspector')),
    brand: box(document.getElementById('brand')),
    columns: getComputedStyle(shell).gridTemplateColumns,
  }
}
window.__chrome = {
  viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  figma: read('figma'),
  sketch: read('sketch'),
}
</script></body></html>`
}

async function measureChrome() {
  const binary = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)
  assert.ok(binary, 'Chrome is required to measure computed chrome')
  const dir = await mkdtemp(join(tmpdir(), 'left-rail-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr?.resume()
  try {
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const client = cdp(ws)
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const evaluated = await client.send('Runtime.evaluate', { expression: 'window.__chrome', returnByValue: true })
    assert.equal(evaluated.exceptionDetails, undefined)
    assert.ok(evaluated.result?.value?.figma)
    ws.close()
    return evaluated.result.value
  } finally {
    chrome.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
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

async function waitJson(url) {
  const deadline = Date.now() + 10_000
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
