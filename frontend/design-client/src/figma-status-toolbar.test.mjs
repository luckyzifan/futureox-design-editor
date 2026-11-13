// Headed Chrome measurement of the Figma status capsule against the real
// stylesheet. The filed overlap was the wrapped desk pill covering 「设计已打开」.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { figmaStatusClearance } from './figma-toolbar-layout.ts'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const chromeSource = await readFile(new URL('./EditorChrome.tsx', root), 'utf8')

test('status clearance follows the rendered pill and does not invent a pill size', () => {
  assert.equal(figmaStatusClearance(12, 78.03), 99)
  assert.equal(figmaStatusClearance(12, 44.03), 65)
  assert.equal(figmaStatusClearance(12, 54.03), 75)
  assert.equal(figmaStatusClearance(0, 0), 0)
  assert.equal(figmaStatusClearance(Number.NaN, 40), 0)
  assert.equal(figmaStatusClearance(-1, 40), 0)
  const pill = styles.match(/\.editor-shell\[data-ui-mode="figma"\] \.floating-toolbar \{[^}]+\}/)?.[0]
  assert.ok(pill)
  assert.match(pill, /width:\s*max-content/)
  assert.match(pill, /flex-wrap:\s*nowrap/)
  assert.match(pill, /max-width:\s*calc\(100% - 24px\)/)
  assert.doesNotMatch(pill, /width:\s*\d+px/)
  assert.doesNotMatch(pill, /height:\s*\d+px/)
  const footer = styles.match(/\.editor-shell\[data-ui-mode="figma"\] > footer \{[^}]+\}/)?.[0]
  assert.ok(footer)
  assert.match(footer, /pointer-events:\s*auto/)
  assert.match(footer, /max\(78px, var\(--floating-toolbar-status-clearance, 78px\)\)/)
  assert.match(chromeSource, /figmaStatusClearance\(bottom, height\)/)
  const sketch = styles.match(/\.editor-shell\[data-ui-mode="sketch"\] \.floating-toolbar \{[^}]+\}/)?.[0]
  assert.match(sketch, /position: relative/)
  assert.match(sketch, /flex-wrap: nowrap/)
})

test('Figma 「设计已打开」 stays clear of the tool pill at 1440, 1180, 1000, and 900', { timeout: 40_000 }, async () => {
  const measured = await measureStatus()
  assert.equal(measured.length, 4)
  for (const row of measured) {
    assert.equal(row.viewport.w, row.asked.w, JSON.stringify(row.viewport))
    assert.equal(row.viewport.h, row.asked.h)
    assert.equal(row.wrap, 'nowrap', row.asked.w)
    assert.ok(row.toolbar.w < row.canvas.w - 16, `pill filled the canvas at ${row.asked.w}: ${row.toolbar.w} vs ${row.canvas.w}`)
    assert.ok(row.toolbar.x >= row.canvas.x - 0.5 && row.toolbar.x + row.toolbar.w <= row.canvas.x + row.canvas.w + 0.5, JSON.stringify(row))
    assert.equal(row.intersection.hit, false, JSON.stringify({ asked: row.asked, toolbar: row.toolbar, footer: row.footer, intersection: row.intersection }))
    assert.ok(row.footer.y + row.footer.h <= row.toolbar.y + 0.5, JSON.stringify(row))
    assert.equal(row.missed.length, 0, JSON.stringify(row.missed))
    assert.ok(row.footerHits.length >= 4)
    assert.ok(row.footerHits.every(point => point.inFooter), JSON.stringify(row.footerHits))
    assert.equal(row.textHit, true, JSON.stringify(row.text))
    assert.equal(row.textIntersection.hit, false, JSON.stringify(row.text))
    assert.equal(row.footerText.includes('设计已打开'), true)
    const expected = figmaStatusClearance(row.toolbarBottom, row.toolbar.h)
    assert.equal(row.clearance, expected > 78 ? expected : 78, JSON.stringify(row))
  }
  const at = (width) => measured.find(row => row.asked.w === width)
  const narrow = at(1000), tighter = at(900), wide = at(1440), desk = at(1180)
  assert.equal(narrow.density, 'desk')
  assert.equal(tighter.density, 'desk')
  assert.equal(wide.density, 'wide')
  assert.equal(desk.density, 'desk')
  assert.ok(narrow.toolbar.h < 60 && tighter.toolbar.h < 60, 'desk pill grew into a second row')
  assert.ok(wide.toolbar.h < 66, JSON.stringify(wide.toolbar))
})

function toolbarMarkup() {
  const popover = (id) => `<div class="tool-popover"><button type="button" id="${id}" aria-label="${id}">T</button><button type="button" class="tool-picker-arrow" aria-label="${id} menu"></button></div>`
  const button = (id) => `<button type="button" id="${id}" aria-label="${id}">T</button>`
  return `<div class="tool-group">${popover('move')}${popover('region')}${popover('shape')}${popover('drawing')}${button('comments')}${button('text')}${popover('utility')}</div><i></i><div class="tool-group">${button('undo')}${button('redo')}${button('arrange')}${button('search')}</div>`
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" data-ui-mode="figma" data-density="wide" id="shell" style="--workspace-layers-width:min(248px, var(--workspace-panel-cap, max(260px, 26vw)));--workspace-inspector-width:min(280px, var(--workspace-panel-cap, max(260px, 26vw)))">
  <header class="editor-header"><div class="brand"></div><div class="document-title"><input aria-label="文档名称" value="未命名"><button type="button" aria-label="收起界面">▣</button></div><div class="header-right"><button type="button">Figma</button></div></header>
  <main class="editor-workspace">
    <nav class="workspace-rail"></nav>
    <div class="adaptive-layers-shell"><div class="layers-panel"></div></div>
    <div class="canvas-workspace" id="canvas"><div class="toolbar floating-toolbar" id="toolbar">${toolbarMarkup()}</div></div>
    <div class="properties-workspace"></div>
  </main>
  <footer id="status"><span><span class="footer-dot"></span>设计已打开</span><div>隐藏</div></footer>
</div>
<script>
function place(toolbar, canvas) {
  const shell = toolbar.closest('.editor-shell')
  const box = canvas.getBoundingClientRect(), half = toolbar.getBoundingClientRect().width / 2
  toolbar.style.left = Math.max(half + 8, Math.min(innerWidth / 2 - box.left, box.width - half - 8)) + 'px'
  const bottom = Number.parseFloat(getComputedStyle(toolbar).bottom)
  const height = toolbar.getBoundingClientRect().height
  const clearance = Number.isFinite(bottom) && height > 0 ? Math.ceil(bottom + height + 8) : 0
  if (clearance > 0) shell.style.setProperty('--floating-toolbar-status-clearance', clearance + 'px')
  else shell.style.removeProperty('--floating-toolbar-status-clearance')
}
function rect(el) { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) } }
function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return { x: +x.toFixed(2), y: +y.toFixed(2), hit: x > 0.5 && y > 0.5 }
}
window.__measure = (density) => {
  const shell = document.getElementById('shell')
  shell.setAttribute('data-density', density)
  const toolbar = document.getElementById('toolbar'), canvas = document.getElementById('canvas'), footer = document.getElementById('status')
  toolbar.style.removeProperty('left')
  place(toolbar, canvas)
  place(toolbar, canvas)
  const bar = rect(toolbar), foot = rect(footer)
  const textNode = [...footer.querySelector('span').childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes('设计已打开'))
  const range = document.createRange(); range.selectNodeContents(textNode)
  const text = rect(range)
  const buttons = [...toolbar.querySelectorAll('button')].map(button => {
    const b = button.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    return { id: button.id || button.getAttribute('aria-label'), ok: !!hit && (hit === button || button.contains(hit)), via: hit ? (hit.id || hit.className || hit.tagName) : null }
  })
  const hits = [2, foot.w * 0.25, foot.w * 0.5, foot.w * 0.75, Math.max(2, foot.w - 2)].map(dx => {
    const x = foot.x + dx, y = foot.y + foot.h / 2
    const hit = document.elementFromPoint(x, y)
    return { x: +x.toFixed(2), y: +y.toFixed(2), inFooter: !!hit && (hit === footer || footer.contains(hit)), via: hit ? (hit.id || hit.className || hit.tagName) : null }
  })
  const textPoint = document.elementFromPoint(text.x + text.w / 2, text.y + text.h / 2)
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    density, wrap: getComputedStyle(toolbar).flexWrap,
    toolbar: bar, footer: foot, canvas: rect(canvas),
    intersection: overlap(bar, foot), text, textIntersection: overlap(bar, text),
    textHit: !!textPoint && (textPoint === footer || footer.contains(textPoint)),
    footerText: footer.textContent, missed: buttons.filter(button => !button.ok), footerHits: hits,
    toolbarBottom: Number.parseFloat(getComputedStyle(toolbar).bottom),
    clearance: Number.parseFloat(getComputedStyle(footer).bottom),
  }
}
</script></body></html>`
}

async function measureStatus() {
  const binary = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'].find(existsSync)
  assert.ok(binary, 'Chrome is required to measure the status capsule')
  const dir = await mkdtemp(join(tmpdir(), 'figma-status-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--disable-gpu',
    `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`,
    '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':1' } })
  chrome.stderr?.resume()
  try {
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const client = cdp(ws)
    await client.send('Page.enable')
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const sizes = [
      { w: 1440, h: 900, density: 'wide' },
      { w: 1180, h: 800, density: 'desk' },
      { w: 1000, h: 640, density: 'desk' },
      { w: 900, h: 640, density: 'desk' },
    ]
    const rows = []
    for (const size of sizes) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false })
      const evaluated = await client.send('Runtime.evaluate', { expression: `window.__measure(${JSON.stringify(size.density)})`, returnByValue: true })
      assert.equal(evaluated.exceptionDetails, undefined)
      rows.push({ asked: size, ...evaluated.result.value })
    }
    ws.close()
    return rows
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
