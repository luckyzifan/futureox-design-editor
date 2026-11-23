// Sketch toolbar and inspector chrome for #840 #841 #842 #843 #845 #846.
// Measures the production stylesheets in headless Chrome at 1440×960, DPR 1.
// Linux Chrome is not Electron, Metal, or the macOS Sketch window.
// Run: node --test src/sketch-toolbar-chrome.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const polish = await readFile(new URL('./chrome-polish.css', root), 'utf8')
const TOOLBAR = '#e8ebec'
const WHITE = '#ffffff'
const OLD_TAB = '#6e6e73'
const OLD_CHECK = '#9699a7'
const INK = '#5d6673'
const PRESSED = '#1d1d1f'

function channel(value) {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function luminance(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255)
}
function contrast(foreground, background) {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

test('the reported Sketch inks miss 4.5:1 and the shared secondary ink does not', () => {
  const tab = contrast(OLD_TAB, TOOLBAR)
  const check = contrast(OLD_CHECK, WHITE)
  assert.ok(Math.abs(tab - 4.23) < 0.02, tab)
  assert.ok(Math.abs(check - 2.83) < 0.02, check)
  assert.ok(tab < 4.5 && check < 4.5)
  assert.ok(contrast(INK, TOOLBAR) >= 4.5, contrast(INK, TOOLBAR))
  assert.ok(contrast(INK, WHITE) >= 4.5, contrast(INK, WHITE))
  assert.ok(contrast(PRESSED, '#d6e8ff') > 13)
  assert.match(styles, /\.check-row \{[^}]*color:\s*#9699a7/)
  assert.match(styles, /\.editor-shell\[data-ui-mode="sketch"\] \.properties-content \.check-row \{ color: #5d6673; \}/)
  assert.match(styles, /\.editor-shell\[data-ui-mode="sketch"\] \.header-right \.ui-mode-switch button:not\(\[aria-pressed=true\]\) \{ color: #5d6673; \}/)
  assert.match(styles, /button\.sketch-insert-tool \{\s*width: 47px; height: 40px/)
  assert.match(styles, /button\.sketch-main-tool \{\s*width: 49px; height: 40px/)
  assert.match(styles, /button\.sketch-edit-tool,\s*\.editor-shell\[data-ui-mode="sketch"\] \.sketch-window-tools button\.sketch-preview-tool \{\s*width: 48px; height: 52px/)
  assert.match(styles, /--workspace-accent:\s*#0d99ff/)
  assert.match(polish, /--workspace-muted:\s*#5d6673/)
  assert.doesNotMatch(styles, /\.editor-shell\[data-ui-mode="figma"\] \.properties-content \.check-row/)
  assert.doesNotMatch(styles, /\.creation-tool-hint b \{[^}]*#5d6673/)
})

test('live Sketch toolbar targets and inspector ink clear the recorded bars', { timeout: 90_000 }, async () => {
  const measured = await measureChrome()
  const dir = process.env.SKETCH_CHROME_DIR
  if (dir) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'report.json'), JSON.stringify(measured, null, 2))
  }
  console.log(summary(measured))
  assert.equal(measured.viewport.w, 1440)
  assert.equal(measured.viewport.h, 960)
  assert.ok(Math.abs(measured.viewport.dpr - 1) < 0.02, measured.viewport.dpr)
  const sketch = measured.sketch
  assert.equal(sketch.header.h, 52)
  assert.equal(sketch.header.bg, TOOLBAR)
  assert.equal(sketch.figma.font, '11px')
  assert.equal(sketch.figma.colorHex, INK)
  assert.ok(sketch.figma.contrast >= 4.5, sketch.figma.contrast)
  assert.equal(sketch.sketchTab.colorHex, PRESSED)
  assert.notEqual(sketch.sketchTab.colorHex, sketch.figma.colorHex)
  assert.ok(sketch.sketchTab.contrast > 13, sketch.sketchTab.contrast)
  assert.equal(sketch.grid.font, '10px')
  assert.equal(sketch.snap.font, '10px')
  assert.equal(sketch.grid.colorHex, INK)
  assert.equal(sketch.snap.colorHex, INK)
  assert.equal(sketch.grid.bg, WHITE)
  assert.equal(sketch.snap.bg, WHITE)
  assert.ok(sketch.grid.contrast >= 4.5 && sketch.snap.contrast >= 4.5)
  const expectSize = (label, width, height) => {
    const box = sketch.buttons[label]
    assert.ok(box, label)
    assert.equal(box.w, width, `${label} width ${box.w}`)
    assert.equal(box.h, height, `${label} height ${box.h}`)
    assert.equal(box.hit, true, `${label} center missed`)
    assert.equal(box.insideHeader, true, `${label} left the 52px toolbar ${JSON.stringify(box)}`)
    assert.ok(box.y + box.h <= 52.5, `${label} bottom ${box.y + box.h}`)
  }
  expectSize('置入', 47, 40)
  for (const label of ['画框', '图形', '字符', '形状', '矢量']) expectSize(label, 49, 40)
  expectSize('编辑', 48, 52)
  expectSize('预览', 48, 52)
  assert.equal(sketch.buttons['预览'].prototype, false)
  assert.equal(sketch.prototypePreview, null)
  assert.equal(sketch.buttons['搜索'].w, 29)
  assert.equal(sketch.buttons['搜索'].h, 32)
  assert.equal(measured.figma.grid.colorHex, INK)
  assert.equal(measured.figma.grid.font, '10px')
  assert.ok(measured.figma.grid.contrast >= 4.5)
  assert.equal(measured.figma.tool.w, 40)
  assert.equal(measured.figma.tool.h, 40)
  assert.equal(measured.narrow.overlaps, 0)
  assert.equal(measured.desk.overlaps, 0)
  assert.ok(sketch.right <= 1440.5, sketch.right)
  assert.ok(measured.desk.right <= 1180.5, measured.desk.right)
  assert.ok(measured.narrow.right <= 1000.5, measured.narrow.right)
  assert.equal(measured.desk.header.h, 52)
  assert.equal(measured.narrow.header.h, 52)
})

function summary(measured) {
  const line = (id, box) => box ? `${id} ${box.w}×${box.h} ${box.colorHex || ''} on ${box.bg || ''} ${box.contrast ?? ''} y=${box.y}` : `${id} missing`
  const sketch = measured.sketch
  return [
    `chrome dpr=${measured.viewport.dpr} ${measured.viewport.w}×${measured.viewport.h}`,
    line('figma-tab', sketch.figma),
    line('sketch-tab', sketch.sketchTab),
    line('grid', sketch.grid),
    line('snap', sketch.snap),
    ...['置入', '画框', '图形', '字符', '形状', '矢量', '编辑', '预览', '搜索'].map(label => line(label, sketch.buttons[label])),
    `figma-check ${measured.figma.grid.colorHex} ${measured.figma.grid.contrast}`,
    `overlaps desk=${measured.desk.overlaps} narrow=${measured.narrow.overlaps}`,
  ].join('\n')
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="sketch" data-density="wide" style="width:1440px;height:960px">
  <header class="editor-header sketch-window-toolbar">
    <div class="sketch-workspace-switch" role="group"><button type="button" aria-pressed="true">画布</button><button type="button">组件</button></div>
    <div class="document-title"><button type="button" class="brand" aria-label="文件">F</button><input aria-label="文档名称" value="未命名设计"></div>
    <div class="toolbar floating-toolbar sketch-window-tools" role="toolbar">
      <div class="tool-group">
        <button type="button" class="sketch-secondary-tool" aria-label="搜索">S</button>
        <div class="tool-popover"><button type="button" class="sketch-insert-tool" aria-label="置入">+</button></div>
      </div>
      <div class="tool-group">
        <button type="button" class="sketch-main-tool" aria-label="画框">F</button>
        <button type="button" class="sketch-main-tool" aria-label="图形">G</button>
        <button type="button" class="sketch-main-tool" aria-label="字符">T</button>
        <div class="tool-popover"><button type="button" class="sketch-main-tool" aria-label="形状">S</button></div>
        <button type="button" class="sketch-main-tool" aria-label="矢量">V</button>
      </div>
      <div class="tool-group">
        <button type="button" class="sketch-secondary-tool sketch-edit-tool" aria-label="编辑" disabled>E</button>
        <button type="button" class="sketch-preview-tool" aria-label="预览">P</button>
        <div class="tool-popover"><button type="button" aria-label="工具">T</button></div>
      </div>
    </div>
    <div class="header-right">
      <details class="workspace-actions"><summary aria-label="更多操作">≡</summary></details>
      <span class="save-status"><span class="save-status-label">已保存</span></span>
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" id="figma-tab" aria-pressed="false">Figma</button>
        <button type="button" id="sketch-tab" aria-pressed="true">Sketch</button>
      </div>
      <label class="locale-switch"><select aria-label="界面语言"><option>中文</option></select></label>
      <button type="button" class="design-agent-toggle" aria-label="设计助手"><span>设计助手</span></button>
      <div class="sketch-window-zoom"><div class="canvas-controls compact-controls"><details class="view-menu"><summary aria-label="缩放与视图设置" data-testid="zoom-readout">100%</summary></details></div></div>
      <button type="button" class="primary" aria-label="导出"><span class="header-export-label">导出</span></button>
      <button type="button" class="app-settings-button" aria-label="打开设置"><span>设置</span></button>
    </div>
  </header>
  <main class="editor-workspace">
    <div class="adaptive-layers-shell"></div>
    <div class="canvas-workspace">
      <div class="toolbar floating-toolbar" id="figma-tools"><div class="tool-group"><button type="button" id="figma-tool" aria-label="选择">S</button></div></div>
    </div>
    <div class="properties-workspace"><div class="properties-content"><aside class="inspector"><section>
      <label class="check-row" id="grid"><input type="checkbox">显示网格</label>
      <label class="check-row" id="snap"><input type="checkbox">智能吸附</label>
    </section></aside></div></div>
  </main>
</div>
<script>
function parseColor(value) {
  const match = String(value).match(/rgba?\\(([^)]+)\\)/i)
  if (!match) return null
  const parts = match[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}
function composite(front, back) {
  const a = front.a == null ? 1 : front.a
  return { r: front.r * a + back.r * (1 - a), g: front.g * a + back.g * (1 - a), b: front.b * a + back.b * (1 - a), a: 1 }
}
function painted(el) {
  const layers = []
  for (let node = el; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (color && color.a > 0) layers.push(color)
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 }
  for (let index = layers.length - 1; index >= 0; index -= 1) acc = composite(layers[index], acc)
  return { r: Math.round(acc.r), g: Math.round(acc.g), b: Math.round(acc.b) }
}
function hex(color) { return '#' + [color.r, color.g, color.b].map(part => part.toString(16).padStart(2, '0')).join('') }
function channel(value) { const scaled = value / 255; return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4 }
function lum(color) { return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b) }
function contrast(a, b) { const hi = Math.max(lum(a), lum(b)), lo = Math.min(lum(a), lum(b)); return (hi + 0.05) / (lo + 0.05) }
function boxOf(el) {
  if (!el || getComputedStyle(el).display === 'none') return null
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const bg = painted(el)
  const ink = parseColor(style.color)
  const mixed = ink ? composite({ ...ink, a: ink.a == null ? 1 : ink.a }, { ...bg, a: 1 }) : null
  const rounded = mixed ? { r: Math.round(mixed.r), g: Math.round(mixed.g), b: Math.round(mixed.b) } : null
  const header = document.querySelector('.editor-header').getBoundingClientRect()
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
  const hit = document.elementFromPoint(x, y)
  return {
    label: el.getAttribute('aria-label') || el.id,
    x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2),
    font: style.fontSize, colorHex: rounded ? hex(rounded) : null, bg: hex(bg),
    contrast: rounded ? +contrast(rounded, bg).toFixed(3) : null,
    hit: !!(hit && (hit === el || el.contains(hit))),
    insideHeader: rect.y >= header.y - 0.5 && rect.y + rect.height <= header.y + header.height + 0.5,
    prototype: el.classList.contains('prototype-preview-button'),
  }
}
function overlaps() {
  const tools = [...document.querySelectorAll('.sketch-window-tools button')].filter(button => getComputedStyle(button).display !== 'none')
  const header = [...document.querySelectorAll('.header-right button, .header-right select')]
  const rect = element => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, w: box.width, h: box.height } }
  const hit = (a, b) => a.x + 0.5 < b.x + b.w - 0.5 && a.x + a.w - 0.5 > b.x + 0.5 && a.y + 0.5 < b.y + b.h - 0.5 && a.y + a.h - 0.5 > b.y + 0.5
  let count = 0
  for (const tool of tools) for (const control of header) if (hit(rect(tool), rect(control))) count += 1
  return count
}
function sketchShot() {
  const shell = document.getElementById('shell')
  shell.setAttribute('data-ui-mode', 'sketch')
  shell.setAttribute('data-density', innerWidth <= 900 ? 'narrow' : innerWidth <= 1180 ? 'desk' : 'wide')
  const header = document.querySelector('.editor-header').getBoundingClientRect()
  const buttons = {}
  for (const button of document.querySelectorAll('.sketch-window-tools button')) {
    const box = boxOf(button)
    if (box) buttons[box.label] = box
  }
  return {
    header: { x: +header.x.toFixed(2), y: +header.y.toFixed(2), w: +header.width.toFixed(2), h: +header.height.toFixed(2), bg: hex(painted(document.querySelector('.editor-header'))) },
    figma: boxOf(document.getElementById('figma-tab')),
    sketchTab: boxOf(document.getElementById('sketch-tab')),
    grid: boxOf(document.getElementById('grid')),
    snap: boxOf(document.getElementById('snap')),
    buttons,
    prototypePreview: boxOf(document.querySelector('.prototype-preview-button')),
    overlaps: overlaps(),
    right: Math.max(...[...document.querySelectorAll('.editor-header button, .editor-header select, .editor-header summary')].filter(el => getComputedStyle(el).display !== 'none').map(el => el.getBoundingClientRect().right)),
  }
}
function figmaShot() {
  const shell = document.getElementById('shell')
  shell.setAttribute('data-ui-mode', 'figma')
  shell.style.width = '1440px'
  return { grid: boxOf(document.getElementById('grid')), tool: boxOf(document.getElementById('figma-tool')) }
}
window.__measure = (mode) => {
  document.getElementById('shell').style.width = innerWidth + 'px'
  document.getElementById('shell').style.height = innerHeight + 'px'
  if (mode === 'figma') return figmaShot()
  return { ...sketchShot(), overlaps: overlaps() }
}
</script></body></html>`
}

async function measureChrome() {
  const binary = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(binary, 'Chrome is required')
  const dir = await mkdtemp(join(tmpdir(), 'sketch-chrome-'))
  const port = 9600 + Math.floor(Math.random() * 300)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    '--headless=new', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', '--force-color-profile=srgb', '--hide-scrollbars',
    '--window-size=1440,960', `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeLog = ''
  chrome.stderr?.on('data', chunk => { chromeLog += String(chunk) })
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, chromeLog.slice(-400))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const client = cdp(ws)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const env = await evaluate(client, '({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })')
    const sketch = await evaluate(client, 'window.__measure("sketch")')
    const figma = await evaluate(client, 'window.__measure("figma")')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 800, deviceScaleFactor: 1, mobile: false })
    const desk = await evaluate(client, 'window.__measure("sketch")')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false })
    const narrow = await evaluate(client, 'window.__measure("sketch")')
    ws.close()
    return { browser: version.Browser, viewport: env, sketch, figma, desk: { overlaps: desk.overlaps, header: desk.header, right: desk.right }, narrow: { overlaps: narrow.overlaps, header: narrow.header, right: narrow.right } }
  } finally {
    chrome.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 100))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', { expression, returnByValue: true }).then(result => {
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  })
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
  const deadline = Date.now() + 20_000
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
