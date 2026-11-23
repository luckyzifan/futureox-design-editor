// Issue #816. Narrow header Export must stay recognizable, and must not cover
// the prototype preview, layout switch, or settings entry.
// Run: node --test src/export-button-narrow.test.mjs
// Screenshots: EXPORT_NARROW_SHOTS=/tmp/export-816 node --test src/export-button-narrow.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const shots = process.env.EXPORT_NARROW_SHOTS || ''
const styles = await readFile(new URL('./styles.css', root), 'utf8')

test('compact Export turns the download glyph back on while the labeled control stays a word and chevron', () => {
  assert.match(styles, /\.editor-shell \.header-right>\.primary>svg:first-child\{display:none\}/)
  assert.match(styles, /\.editor-shell\[data-density="desk"\] \.header-right > \.primary > svg:first-child \{ display: block; \}/)
  assert.match(styles, /\.editor-shell\[data-density="desk"\] \.header-right > \.primary \{ font-size: 0; padding: 6px; \}/)
  const desk = styles.slice(styles.indexOf('@media (min-width: 901px) and (max-width: 1180px)'), styles.indexOf('/* Warm, quiet chrome'))
  assert.match(desk, /\.editor-shell \.header-right > \.primary > svg:first-child \{ display: block; \}/)
  const sketch = styles.slice(styles.indexOf('@media (max-width: 1000px)'), styles.indexOf('.editor-shell[data-ui-mode="sketch"] .sketch-window-zoom'))
  assert.match(sketch, /\.editor-shell\[data-ui-mode="sketch"\] \.header-right > \.primary > svg:first-child \{ display: block; \}/)
  assert.match(styles, /\.editor-shell \{[^}]*--editor-chrome-row:\s*38px/)
  assert.match(styles, /\.editor-shell\[data-ui-mode="sketch"\] \{[^}]*grid-template-rows:\s*52px/)
})

test('1000, 1024, and 1200 keep Export identifiable without covering its neighbors', { timeout: 40_000 }, async () => {
  const measured = await measureNarrow()
  assert.match(measured.browser, /Chrome\/\d+/)
  assert.equal(measured.rows.length, 8)
  for (const row of measured.rows) {
    assert.equal(row.viewport.w, row.asked.w, JSON.stringify(row.viewport))
    assert.equal(row.viewport.h, row.asked.h)
    assert.equal(row.viewport.dpr, 1)
    assert.equal(row.name, '导出', row.id)
    assert.equal(row.enabled, true, row.id)
    assert.equal(row.tag, 'button', row.id)
    assert.ok(row.tabIndex >= 0, `${row.id} tabIndex ${row.tabIndex}`)
    assert.equal(row.focused, true, row.id)
    assert.equal(row.clicked, 1, row.id)
    assert.equal(row.header.h, row.mode === 'figma' ? 38 : 52, `${row.id} header ${row.header.h}`)
    assert.equal(row.headerBg, row.mode === 'figma' ? 'rgb(233, 235, 236)' : 'rgb(232, 235, 236)', row.id)
    assert.equal(row.fill, row.mode === 'figma' ? 'rgb(7, 104, 207)' : 'rgb(0, 99, 204)', row.id)
    assert.equal(row.ink, 'rgb(255, 255, 255)', row.id)
    assert.ok(row.title.w >= 80, `${row.id} title crushed to ${row.title.w}`)
    assert.ok(row.button.w >= 24 && row.button.h >= 32, `${row.id} button ${row.button.w}×${row.button.h}`)
    assert.equal(inside(row.button, row.header), true, `${row.id} export left the header`)
    assert.ok(row.button.x + row.button.w <= row.asked.w + 0.5, `${row.id} export past the window`)
    for (const id of ['preview', 'figma', 'sketch', 'settings']) {
      assert.equal(row.overlaps[id], false, `${row.id} covers ${id} ${JSON.stringify(row.controls[id])} vs ${JSON.stringify(row.button)}`)
      assert.equal(inside(row.controls[id], row.header), true, `${row.id} ${id} left the header`)
      assert.equal(row.hits[id].self, true, `${row.id} ${id} hit ${JSON.stringify(row.hits[id])}`)
    }
    assert.equal(row.overlaps.title, false, row.id)
    assert.equal(row.overlaps.canvas, false, row.id)
    assert.equal(row.overlaps.tool, false, row.id)
    assert.equal(row.hits.export.self, true, `${row.id} export hit ${JSON.stringify(row.hits.export)}`)
    assert.equal(row.icons.length, 2, row.id)
    assert.ok(row.icons[1].display !== 'none' && row.icons[1].w >= 12 && row.icons[1].h >= 12, `${row.id} chevron ${JSON.stringify(row.icons[1])}`)
    if (row.compact) {
      assert.equal(row.font, '0px', row.id)
      assert.ok(row.text.w < 1, `${row.id} compact label laid out at ${row.text.w}`)
      assert.notEqual(row.icons[0].display, 'none', `${row.id} hid the download glyph`)
      assert.ok(row.icons[0].w >= 12 && row.icons[0].h >= 12, `${row.id} download ${row.icons[0].w}×${row.icons[0].h}`)
      assert.equal(inside(row.icons[0], row.button), true, `${row.id} download glyph left the button`)
      assert.ok(row.iconHits >= 1, `${row.id} download glyph was not hit`)
    } else {
      assert.equal(row.font, '12px', row.id)
      assert.ok(row.text.w >= 12, `${row.id} label width ${row.text.w}`)
      assert.equal(row.icons[0].display, 'none', `${row.id} labeled state showed the download glyph`)
      assert.equal(inside(row.text, row.button), true, `${row.id} label left the button`)
    }
  }
  const at = (mode, width) => measured.rows.find((row) => row.mode === mode && row.asked.w === width)
  assert.equal(at('figma', 1000).compact, true)
  assert.equal(at('figma', 1024).compact, true)
  assert.equal(at('figma', 1200).compact, false)
  assert.equal(at('sketch', 1000).compact, true)
  assert.equal(at('sketch', 1024).compact, true)
  assert.equal(at('sketch', 1200).compact, false)
  assert.equal(at('figma', 800).compact, false)
  assert.equal(at('sketch', 800).compact, true)
})

function inside(child, parent) {
  return child.x >= parent.x - 0.5 && child.y >= parent.y - 0.5
    && child.x + child.w <= parent.x + parent.w + 0.5
    && child.y + child.h <= parent.y + parent.h + 0.5
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  const icon = (size, body) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${body}</svg>`
  const download = icon(14, '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>')
  const chevron = icon(12, '<path d="m6 9 6 6 6-6"/>')
  const spark = icon(16, '<path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/>')
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" data-density="desk" style="width:1000px;height:640px">
  <header class="editor-header" id="header">
    <div class="sketch-workspace-switch" role="group" aria-label="侧栏">
      <button type="button" aria-label="显示画布">C</button>
      <button type="button" aria-label="显示组件">P</button>
    </div>
    <div class="document-title" id="title">
      <button type="button" class="brand" aria-label="文件菜单"><span class="brand-mark"></span></button>
      <button type="button" class="document-location">本机设计</button>
      <input aria-label="文档名称" value="未命名设计">
      <button type="button" aria-pressed="false" aria-label="收起界面">▣</button>
    </div>
    <div class="toolbar floating-toolbar" id="tools"><div class="tool-group"><button type="button" id="tool">选</button></div></div>
    <div class="header-right" id="right">
      <details class="workspace-actions"><summary aria-label="更多操作">${spark}</summary></details>
      <span class="save-status" role="status" title="已自动保存到工作副本">${spark}<span class="save-status-label">已自动保存到工作副本</span></span>
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" id="figma" aria-pressed="true">Figma</button>
        <button type="button" id="sketch" aria-pressed="false">Sketch</button>
      </div>
      <label class="locale-switch"><select aria-label="语言"><option>中文</option></select></label>
      <button type="button" class="design-agent-toggle" id="agent">${spark}<span>设计助手</span></button>
      <button type="button" class="prototype-preview-button" id="preview" aria-label="预览原型">${spark}<span>预览</span></button>
      <button type="button" class="primary" id="export" aria-label="导出">${download}导出${chevron}</button>
      <button type="button" class="app-settings-button" id="settings" aria-label="打开设置">${spark}<span>设置</span></button>
    </div>
  </header>
  <div class="canvas-workspace" id="canvas"></div>
</div>
<script>
const round = (n) => Math.round(n * 100) / 100
function box(el) {
  const r = el.getBoundingClientRect()
  return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }
}
function overlap(a, b) {
  return a.w > 0 && b.w > 0 && a.x < b.x + b.w - 0.5 && a.x + a.w > b.x + 0.5 && a.y < b.y + b.h - 0.5 && a.y + a.h > b.y + 0.5
}
function hit(el) {
  const r = el.getBoundingClientRect()
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 16))
  return { self: !!top && (top === el || el.contains(top)), via: top ? (top.id || top.tagName) : null }
}
window.__measure = (mode, width, height) => {
  const shell = document.getElementById('shell')
  const density = width <= 900 ? 'narrow' : width <= 1180 ? 'desk' : 'wide'
  shell.dataset.uiMode = mode
  shell.dataset.density = density
  shell.style.width = width + 'px'
  shell.style.height = height + 'px'
  const figma = document.getElementById('figma')
  const sketch = document.getElementById('sketch')
  figma.setAttribute('aria-pressed', mode === 'figma' ? 'true' : 'false')
  sketch.setAttribute('aria-pressed', mode === 'sketch' ? 'true' : 'false')
  const button = document.getElementById('export')
  button.dataset.clicks = '0'
  if (!button.dataset.bound) {
    button.dataset.bound = '1'
    button.addEventListener('click', () => { button.dataset.clicks = String(Number(button.dataset.clicks) + 1) })
  }
  const textNode = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes('导出'))
  const range = document.createRange()
  range.selectNodeContents(textNode)
  const text = box(range)
  const icons = [...button.querySelectorAll('svg')].map((svg) => {
    const rect = svg.getBoundingClientRect()
    return { display: getComputedStyle(svg).display, x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
  })
  let iconHits = 0
  const glyph = button.querySelector('svg')
  if (glyph && getComputedStyle(glyph).display !== 'none') {
    const rect = glyph.getBoundingClientRect()
    for (let y = 1; y < rect.height; y += 2) {
      for (let x = 1; x < rect.width; x += 2) {
        const top = document.elementFromPoint(rect.x + x, rect.y + y)
        if (top && (top === glyph || glyph.contains(top))) iconHits += 1
      }
    }
  }
  const ids = ['preview', 'figma', 'sketch', 'settings', 'export', 'tool']
  const controls = Object.fromEntries(ids.map((id) => [id, box(document.getElementById(id))]))
  const header = box(document.getElementById('header'))
  const title = box(document.getElementById('title'))
  const canvas = box(document.getElementById('canvas'))
  const style = getComputedStyle(button)
  button.focus()
  button.click()
  const compact = (width >= 901 && width <= 1180) || (mode === 'sketch' && width <= 1000)
  return {
    id: mode + '-' + width, mode, compact, density,
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    name: button.getAttribute('aria-label'),
    enabled: !button.disabled,
    tag: button.tagName.toLowerCase(),
    tabIndex: button.tabIndex,
    focused: document.activeElement === button,
    clicked: Number(button.dataset.clicks),
    font: style.fontSize,
    fill: style.backgroundColor,
    ink: style.color,
    text, icons, iconHits, button: box(button), header, title, canvas, controls,
    headerBg: getComputedStyle(document.getElementById('header')).backgroundColor,
    overlaps: {
      preview: overlap(controls.export, controls.preview),
      figma: overlap(controls.export, controls.figma),
      sketch: overlap(controls.export, controls.sketch),
      settings: overlap(controls.export, controls.settings),
      title: overlap(controls.export, title),
      canvas: overlap(controls.export, canvas),
      tool: overlap(controls.export, controls.tool),
    },
    hits: Object.fromEntries(ids.map((id) => [id, hit(document.getElementById(id))])),
  }
}
</script></body></html>`
}

const views = [
  { w: 800, h: 640 },
  { w: 1000, h: 640 },
  { w: 1024, h: 720 },
  { w: 1200, h: 750 },
]

async function measureNarrow() {
  const binary = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome'].filter(Boolean).find(existsSync)
  assert.ok(binary, 'Chrome is required to measure the narrow export control')
  const dir = await mkdtemp(join(tmpdir(), 'export-narrow-'))
  const port = 9500 + Math.floor(Math.random() * 400)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    '--force-color-profile=srgb', '--hide-scrollbars', '--window-size=1200,750',
    `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeLog = ''
  chrome.stderr?.on('data', (chunk) => { chromeLog = (chromeLog + chunk.toString()).slice(-4000) })
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find((item) => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, chromeLog)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const client = cdp(ws)
    await client.send('Page.enable')
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const rows = []
    for (const mode of ['figma', 'sketch']) {
      for (const view of views) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width: view.w, height: view.h, deviceScaleFactor: 1, mobile: false,
        })
        const evaluated = await client.send('Runtime.evaluate', {
          expression: `window.__measure(${JSON.stringify(mode)}, ${view.w}, ${view.h})`,
          returnByValue: true,
        })
        assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
        const row = { asked: view, ...evaluated.result.value }
        if (shots) await saveHeader(client, row)
        rows.push(row)
      }
    }
    ws.close()
    return { browser: version.Browser, rows }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${chromeLog}`)
  } finally {
    chrome.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
  }
}

async function saveHeader(client, row) {
  await mkdir(shots, { recursive: true })
  const captured = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: row.asked.w, height: Math.max(row.header.h, 52), scale: 1 },
  })
  await writeFile(join(shots, `${row.mode}-${row.asked.w}x${row.asked.h}.png`), Buffer.from(captured.data, 'base64'))
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
    wait(method) { return new Promise((resolve) => waiting.push({ method, resolve })) },
  }
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${url} did not become ready (${last})`)
}
