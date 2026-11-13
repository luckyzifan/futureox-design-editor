import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const polish = await readFile(new URL('./chrome-polish.css', root), 'utf8')

function channel(value) {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  const red = channel((value >> 16) & 255)
  const green = channel((value >> 8) & 255)
  const blue = channel(value & 255)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}
export function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}
function hex(rgb) {
  const parts = rgb.match(/[\d.]+/g).map(Number)
  return `#${parts.slice(0, 3).map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`
}

test('the reported #888 secondary ink fails 4.5:1 and the Figma token does not', () => {
  const ratio = contrast('#888888', '#ffffff')
  assert.ok(ratio > 3.5 && ratio < 3.6, `expected the measured 3.54:1, got ${ratio}`)
  assert.ok(ratio < 4.5)
  assert.ok(contrast('#333333', '#ffffff') > 12)
  assert.ok(contrast('#5d6673', '#ffffff') >= 4.5)
  assert.ok(contrast('#5d6673', '#f5f5f5') >= 4.5)
  const figma = styles.match(/\.editor-shell\[data-ui-mode="figma"\] \{[^}]+\}/)?.[0]
  assert.ok(figma)
  assert.match(figma, /--workspace-text:\s*#333333/)
  assert.match(figma, /--workspace-muted:\s*#5d6673/)
  assert.doesNotMatch(figma, /#888/)
  assert.match(polish, /\.design-tools\.export-panel \{\s*box-shadow:\s*var\(--workspace-shadow\);/)
  assert.match(styles, /\.editor-shell\[data-ui-mode="figma"\] \.header-right \.ui-mode-switch button \{\s*height: 32px;/)
  assert.match(styles, /min-width: 1181px/)
})

test('Figma chrome at 1440×960 meets the measured targets without resizing Sketch tools', { timeout: 30_000 }, async () => {
  const measured = await measureChrome()
  assert.equal(measured.viewport.w, 1440)
  assert.equal(measured.viewport.h, 960)
  const box = measured.metrics
  assert.equal(box.header.h, 38)
  assert.equal(box.header.w, 1440)
  assert.equal(box.header.bg, 'rgb(233, 235, 236)')
  assert.equal(box.header.borderBottom, '1px')
  for (const id of ['layers', 'canvas', 'inspector']) {
    assert.equal(box[id].y, 38, `${id} starts at ${box[id].y}`)
  }
  assert.equal(box.title.bg, 'rgba(0, 0, 0, 0)')
  assert.ok(box['header-right'].y >= box.header.y - 0.5 && box['header-right'].y + box['header-right'].h <= box.header.y + box.header.h + 0.5, JSON.stringify(box['header-right']))
  assert.equal(box['header-right'].bg, 'rgba(0, 0, 0, 0)')
  assert.equal(box['header-right'].gap, '4px')
  assert.equal(measured.sketch.header.h, 52)
  assert.equal(measured.sketch.header.bg, 'rgb(232, 235, 236)')
  assert.equal(measured.sketch.layers.y, 53)
  assert.equal(measured.sketch.canvas.y, 53)
  assert.equal(measured.sketch.inspector.y, 53)
  assert.ok(measured.sketch.toolbar.y >= 0 && measured.sketch.toolbar.y + measured.sketch.toolbar.h <= 52)
  assert.equal(measured.sketch.toolbar.position, 'relative')
  assert.ok(box.collapse.w >= 32 && box.collapse.h >= 32)
  assert.equal(intersects(box.collapse, box['title-input']), false)
  for (const id of ['mode-figma', 'mode-sketch']) {
    assert.ok(box[id].h >= 32, `${id} height ${box[id].h}`)
    assert.equal(box[id].font, '12px')
    assert.ok(box[id].w <= 56, `${id} grew to ${box[id].w}`)
    assert.equal(inside(box[id], box['header-right']), true, id)
    assert.equal(measured.hit[id].self, true, JSON.stringify(measured.hit[id]))
  }
  assert.ok(contrast(hex(box['mode-sketch'].color), '#ffffff') >= 4.5)
  assert.equal(box['window-count'].font, '12px')
  assert.ok(box.locale.h >= 32)
  assert.equal(inside(box.locale, box['header-right']), true)
  for (const id of ['tool-select', 'tool-frame', 'tool-rect', 'tool-pen', 'tool-eraser']) {
    assert.ok(box[id].w >= 40 && box[id].h >= 40, `${id} ${box[id].w}×${box[id].h}`)
    assert.ok(box[id].w <= 44 && box[id].h <= 44)
    assert.equal(measured.hit[id].self, true, JSON.stringify(measured.hit[id]))
  }
  assert.ok(box['tool-arrow'].h >= 40 && box['tool-arrow'].w <= 16)
  assert.equal(box['prop-label'].font, '12px')
  assert.equal(box['empty-copy'].font, '12px')
  assert.equal(box['num-label'].font, '11px')
  assert.equal(box.h4.font, '11px')
  assert.equal(box.badge.font, '11px')
  for (const id of ['prop-label', 'empty-copy', 'h4', 'badge']) {
    assert.ok(contrast(hex(box[id].color), '#ffffff') >= 4.5, `${id} ${box[id].color}`)
  }
  assert.ok(contrast(hex(box['num-label'].color), hex(box.num.bg)) >= 4.5)
  assert.equal(box['header-right'].color, 'rgb(51, 51, 51)')
  assert.ok(contrast('#333333', '#ffffff') > 12)
  assert.equal(box['export-dialog'].shadow, box['settings-dialog'].shadow)
  assert.match(box['export-dialog'].shadow, /12px 32px/)
  assert.doesNotMatch(box['export-dialog'].shadow, /20px 70px/)
  assert.equal(box['sketch-tool'].w, 34)
  assert.equal(box['sketch-tool'].h, 34)
  assert.equal(box['sketch-mode'].h, 26)
  assert.equal(box['sketch-mode'].font, '11px')
  assert.ok(box['sketch-mode'].w <= 56)
})

function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}
function inside(child, parent) {
  return child.y >= parent.y - 0.5 && child.y + child.h <= parent.y + parent.h + 0.5
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('settings-dialog.css')}">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;width:1440px;height:960px}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" data-ui-mode="figma" style="width:1440px;height:960px">
  <header class="editor-header" id="header">
    <div class="document-title" id="title">
      <button type="button" class="document-location" id="location">本机设计</button>
      <input id="title-input" aria-label="文档名称" value="未命名">
      <button type="button" id="collapse" aria-pressed="false" aria-label="收起界面">▣</button>
    </div>
    <div class="header-right" id="header-right">
      <details class="workspace-actions"><summary>≡</summary></details>
      <span class="save-status">已保存</span>
      <div class="local-window-control"><button type="button" id="windows" aria-label="本机窗口"><span id="window-count">1</span></button></div>
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" id="mode-figma" aria-pressed="true">Figma</button>
        <button type="button" id="mode-sketch" aria-pressed="false">Sketch</button>
      </div>
      <label class="locale-switch"><select id="locale" aria-label="语言"><option>中文</option></select></label>
      <button type="button" class="prototype-preview-button" id="preview" aria-label="预览原型"><span>预览</span></button>
      <button type="button" class="primary" id="export">导出</button>
      <button type="button" class="app-settings-button"><span>设置</span></button>
    </div>
  </header>
  <nav class="workspace-rail" id="rail"><button type="button">图层</button></nav>
  <div class="adaptive-layers-shell" id="layers"><div class="layers-panel">页面</div></div>
  <div class="canvas-workspace" id="canvas">
    <div class="toolbar floating-toolbar">
      <div class="tool-group">
        <div class="tool-popover"><button type="button" id="tool-select">选</button><button type="button" class="tool-picker-arrow" id="tool-arrow"></button></div>
        <div class="tool-popover"><button type="button" id="tool-frame">板</button><button type="button" class="tool-picker-arrow"></button></div>
        <div class="tool-popover"><button type="button" id="tool-rect">矩</button><button type="button" class="tool-picker-arrow"></button></div>
        <div class="tool-popover"><button type="button" id="tool-pen">笔</button><button type="button" class="tool-picker-arrow"></button></div>
        <button type="button" id="tool-eraser">橡</button>
      </div>
    </div>
  </div>
  <div class="properties-workspace" id="inspector"><div class="properties-content"><aside class="inspector">
    <div class="panel-tabs"><b>设计</b><span id="prop-label">属性</span></div>
    <section class="empty-inspector"><p id="empty-copy">选中图层后，在这里编辑颜色、形状与约束。</p></section>
    <div class="number-field" id="num"><span id="num-label">X</span><input value="0"></div>
    <section><h4 id="h4">位置</h4></section>
    <div class="local-badge" id="badge">独立工作空间 · 本地优先</div>
  </aside></div></div>
</div>
<div class="app-shell editor-shell" id="sketch-shell" data-ui-mode="sketch" style="width:1440px;height:200px">
  <header class="editor-header" id="sketch-header">
    <button type="button" class="brand">F</button>
    <div class="document-title"><button type="button" class="document-location">本机设计</button><input value="未命名"></div>
    <div class="header-right"><div class="ui-mode-switch"><button type="button" id="sketch-mode">Sketch</button></div></div>
  </header>
  <div class="adaptive-layers-shell" id="sketch-layers"><div class="layers-panel">页面</div></div>
  <div class="canvas-workspace" id="sketch-canvas"><div class="toolbar floating-toolbar"><div class="tool-group"><button type="button" id="sketch-tool">排</button></div></div></div>
  <div class="properties-workspace" id="sketch-inspector"></div>
</div>
<section class="design-tools export-panel" id="export-dialog"></section>
<section class="settings-dialog" id="settings-dialog"></section>
<script>
const ids = ${JSON.stringify(['collapse','title-input','windows','window-count','mode-figma','mode-sketch','locale','header-right','header','layers','canvas','inspector','rail','title','tool-select','tool-frame','tool-rect','tool-pen','tool-eraser','tool-arrow','prop-label','empty-copy','num-label','num','h4','badge','sketch-mode','sketch-tool','export-dialog','settings-dialog'])};
const box = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), x: +r.x.toFixed(2), y: +r.y.toFixed(2), font: s.fontSize, color: s.color, bg: s.backgroundColor, shadow: s.boxShadow, gap: s.gap, borderBottom: s.borderBottomWidth } };
const relative = (el, shell) => { const value = box(el), origin = shell.getBoundingClientRect(); return { ...value, y: +(value.y - origin.y).toFixed(2), x: +(value.x - origin.x).toFixed(2) } };
const hit = {};
for (const id of ['mode-figma','mode-sketch','locale','tool-select','tool-frame','tool-rect','tool-pen','tool-eraser','collapse']) {
  const el = document.getElementById(id);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  hit[id] = { self: top === el || (!!top && el.contains(top)), via: top ? (top.id || top.className || top.tagName) : null };
}
const sketchShell = document.getElementById('sketch-shell');
const sketch = {
  header: relative(document.getElementById('sketch-header'), sketchShell),
  layers: relative(document.getElementById('sketch-layers'), sketchShell),
  canvas: relative(document.getElementById('sketch-canvas'), sketchShell),
  inspector: relative(document.getElementById('sketch-inspector'), sketchShell),
  toolbar: { ...relative(document.getElementById('sketch-tool').closest('.floating-toolbar'), sketchShell), position: getComputedStyle(document.getElementById('sketch-tool').closest('.floating-toolbar')).position },
};
window.__chrome = { viewport: { w: innerWidth, h: innerHeight }, metrics: Object.fromEntries(ids.map(id => [id, box(document.getElementById(id))])), hit, sketch };
</script></body></html>`
}

async function measureChrome() {
  const binary = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)
  assert.ok(binary, 'Chrome is required to measure computed chrome')
  const dir = await mkdtemp(join(tmpdir(), 'figma-chrome-'))
  const port = 9300 + Math.floor(Math.random() * 600)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
    `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr?.resume()
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl)
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
    const client = cdp(ws)
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 2, mobile: false })
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const evaluated = await client.send('Runtime.evaluate', { expression: 'window.__chrome', returnByValue: true })
    assert.equal(evaluated.exceptionDetails, undefined)
    assert.ok(evaluated.result?.value?.metrics)
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
