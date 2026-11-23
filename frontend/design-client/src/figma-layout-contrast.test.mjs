// Issues #833 #834 #835 #836. Figma layout contrast for the empty-inspector
// checks, the creation-hint tool name, the selected Design/Draw glyph, and
// the canvas status capsule. Old pairs are the negative control. Chrome
// measures the production stylesheets. Linux Chrome is not Electron or macOS.
// Run: node --test src/figma-layout-contrast.test.mjs
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
const surface = await readFile(new URL('./kernel/Surface.tsx', root), 'utf8')
const progressive = await readFile(new URL('./kernel/ProgressiveSurface.tsx', root), 'utf8')
const outDir = process.env.FIGMA_CONTRAST_DIR || ''
const views = [
  { w: 1440, h: 960 },
  { w: 1024, h: 768 },
  { w: 1000, h: 640 },
]

function channel(value) {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function luminance(rgb) {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}
export function contrast(foreground, background) {
  const fg = typeof foreground === 'string' ? hexRgb(foreground) : foreground
  const bg = typeof background === 'string' ? hexRgb(background) : background
  const lighter = Math.max(luminance(fg), luminance(bg))
  const darker = Math.min(luminance(fg), luminance(bg))
  return (lighter + 0.05) / (darker + 0.05)
}
function hexRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}
function composite(front, alpha, back) {
  return {
    r: Math.round(front.r * alpha + back.r * (1 - alpha)),
    g: Math.round(front.g * alpha + back.g * (1 - alpha)),
    b: Math.round(front.b * alpha + back.b * (1 - alpha)),
  }
}
function block(source, selector) {
  const match = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]+\\}`))
  assert.ok(match, selector)
  return match[0]
}

test('the reported Figma pairs fail and the replacement inks pass', () => {
  const capsule = composite(hexRgb('#ffffff'), 0.94, hexRgb('#e5e5e5'))
  const status = contrast('#777c8e', capsule)
  const statusCanvas = contrast('#777c8e', '#e5e5e5')
  const icon = contrast('#0d99ff', '#ffffff')
  const iconSelected = contrast('#007be5', '#ffffff')
  const iconHover = contrast('#007be5', '#f5f5f5')
  const name = contrast('#0d99ff', '#ffffff')
  const nameCandidate = contrast('#007be5', '#ffffff')
  const nameInk = contrast('#0768cf', '#ffffff')
  const checks = contrast('#9699a7', '#ffffff')
  const checksField = contrast('#9699a7', '#f5f5f5')
  const muted = contrast('#5d6673', '#ffffff')
  const mutedField = contrast('#5d6673', '#f5f5f5')
  const mutedCapsule = contrast('#5d6673', capsule)
  assert.ok(status > 4.07 && status < 4.09, status)
  assert.ok(statusCanvas > 3.29 && statusCanvas < 3.31, statusCanvas)
  assert.ok(status < 4.5 && statusCanvas < 4.5)
  assert.ok(icon > 2.98 && icon < 3, icon)
  assert.ok(name > 2.98 && name < 3, name)
  assert.ok(checks > 2.82 && checks < 2.85, checks)
  assert.ok(checksField > 2.59 && checksField < 2.61, checksField)
  assert.ok(icon < 3 && checks < 3)
  // Icon-selected clears the 3:1 glyph bar and still misses 4.5:1 text.
  assert.ok(iconSelected > 4.22 && iconSelected < 4.24, iconSelected)
  assert.ok(iconSelected >= 3 && iconSelected < 4.5)
  assert.ok(iconHover >= 3, iconHover)
  assert.ok(nameCandidate < 4.5, nameCandidate)
  assert.ok(nameInk >= 4.5, nameInk)
  assert.ok(muted >= 4.5 && mutedField >= 4.5 && mutedCapsule >= 4.5)
  assert.ok(contrast('#bd3b54', capsule) >= 4.5)
  assert.notEqual('#0768cf', '#5d6673')
  assert.notEqual('#007be5', '#333333')

  const figma = block(styles, '.editor-shell[data-ui-mode="figma"]')
  assert.match(figma, /--workspace-accent:\s*#0d99ff;/)
  assert.match(figma, /--workspace-muted:\s*#5d6673;/)
  assert.match(figma, /--workspace-panel:\s*#ffffff;/)
  assert.match(block(styles, '.check-row'), /color:\s*#9699a7;/)
  assert.match(block(styles, '.editor-shell[data-ui-mode="figma"] .check-row'), /color:\s*var\(--workspace-muted\);/)
  assert.match(block(styles, '.editor-shell[data-ui-mode="figma"] .creation-tool-hint b'), /color:\s*#0768cf;/)
  assert.match(block(styles, '.editor-shell[data-ui-mode="figma"] .kernel-status:not(.error)'), /--kernel-status-ink:\s*var\(--workspace-muted\);/)
  assert.match(block(styles, '.figma-toolbelt-mode > [aria-checked="true"]'), /color:\s*#007be5;/)
  assert.match(block(styles, '.figma-toolbelt-mode > [aria-checked="true"]'), /background:\s*var\(--workspace-panel\);/)
  assert.match(styles, /\.creation-tool-hint b \{ color: var\(--workspace-accent\);/)
  const figmaExport = styles.match(/\.editor-shell\[data-ui-mode="figma"\] \.header-right > \.primary:hover,[\s\S]*?\{[^}]+\}/)?.[0]
  assert.ok(figmaExport)
  assert.match(figmaExport, /background:\s*#0768cf/)
  assert.match(figmaExport, /color:\s*#ffffff/)
  assert.match(surface, /color: error \? '#bd3b54' : 'var\(--kernel-status-ink, #777c8e\)'/)
  assert.match(progressive, /color: failure \? '#bd3b54' : 'var\(--kernel-status-ink, #777c8e\)'/)
  assert.match(surface, /fontSize: 12, color: renderFailed \? '#bd3b54' : '#777c8e'/)
  assert.doesNotMatch(block(styles, '.editor-shell[data-ui-mode="sketch"]'), /--kernel-status-ink/)
})

test('headed Chrome measures the four Figma controls', { timeout: 90_000 }, async () => {
  const measured = await measureChrome()
  if (outDir) await writeFile(join(outDir, 'report.json'), JSON.stringify(measured, null, 2))
  console.log(summary(measured))
  assert.match(measured.browser, /Chrome\/157/)
  for (const shot of measured.shots) {
    assert.equal(shot.viewport.w, shot.requested.w)
    assert.equal(shot.viewport.h, shot.requested.h)
    assert.ok(Math.abs(shot.viewport.dpr - 1) < 0.02, shot.viewport.dpr)
    assertFigma(shot)
  }
  const draw = measured.drawSelected.rows.draw
  const design = measured.drawSelected.rows.design
  assert.equal(draw.ink, '#007be5')
  assert.ok(draw.contrast >= 3, draw.contrast)
  assert.equal(design.ink, '#333333')
  assert.notEqual(design.ink, draw.ink)
  assert.equal(measured.drawSelected.hits.find(hit => hit.id === 'draw').self, true)
  const sketch = measured.sketch.rows
  assert.equal(sketch.status.ink, '#777c8e')
  assert.equal(sketch['hint-name'].ink, '#007aff')
  assert.equal(sketch['show-grid'].ink, '#9699a7')
  assert.equal(sketch['smart-snap'].ink, '#9699a7')
  assert.equal(measured.sketch.rows['status-error'].ink, '#bd3b54')
})

function assertFigma(shot) {
  const rows = shot.rows
  const status = rows.status
  const ready = rows['status-ready']
  for (const row of [status, ready]) {
    assert.equal(row.fontSize, '10px', row.id)
    assert.equal(row.ink, '#5d6673', row.id)
    assert.ok(row.contrast >= 4.5, `${row.id} ${row.contrast} on ${row.background}`)
    assert.ok(row.backgroundChannels.every(part => part >= 250), `${row.id} capsule ${row.background}`)
    assert.ok(row.capsuleAlpha > 0.9 && row.capsuleAlpha < 0.98, row.capsuleAlpha)
  }
  assert.equal(rows['status-error'].ink, '#bd3b54')
  assert.equal(rows['status-error'].fontSize, '10px')
  const hint = rows['hint-name']
  assert.equal(hint.fontSize, '11px')
  assert.equal(hint.fontWeight, '600')
  assert.equal(hint.ink, '#0768cf')
  assert.ok(hint.contrast >= 4.5, hint.contrast)
  assert.equal(hint.background, '#ffffff')
  assert.equal(rows['hint-rest'].ink, '#5d6673')
  assert.notEqual(rows['hint-rest'].ink, hint.ink)
  const design = rows.design
  const draw = rows.draw
  assert.equal(design.ink, '#007be5')
  assert.equal(design.background, '#ffffff')
  assert.ok(design.contrast >= 3, design.contrast)
  assert.notEqual(design.ink, '#0d99ff')
  assert.equal(draw.ink, '#333333')
  assert.notEqual(draw.ink, design.ink)
  assert.ok(Math.abs(design.box.w - 30) < 0.6 && Math.abs(design.box.h - 30) < 0.6, `${design.box.w}x${design.box.h}`)
  assert.ok(Math.abs(draw.box.w - 30) < 0.6 && Math.abs(draw.box.h - 30) < 0.6, `${draw.box.w}x${draw.box.h}`)
  for (const id of ['show-grid', 'smart-snap']) {
    const row = rows[id]
    assert.equal(row.fontSize, '10px', id)
    assert.equal(row.ink, '#5d6673', id)
    assert.equal(row.background, '#ffffff')
    assert.ok(row.contrast >= 4.5, `${id} ${row.contrast}`)
    assert.equal(row.fits, true, id)
  }
  if (shot.requested.w === 1440) assert.ok(Math.abs(shot.inspector.w - 241) < 1, shot.inspector.w)
  assert.equal(shot.overlap.statusToolbar, false)
  assert.equal(shot.overlap.readyToolbar, false)
  assert.equal(shot.overlap.statusOpened, false)
  assert.equal(shot.overlap.readyOpened, false)
  assert.equal(shot.overlap.hintToolbar, false)
  assert.ok(status.box.bottom <= shot.toolbar.y + 0.5, `${status.box.bottom} vs ${shot.toolbar.y}`)
  assert.ok(rows.hint.box.bottom <= shot.toolbar.y + 0.5)
  for (const id of ['design', 'draw', 'undo', 'search']) {
    const hit = shot.hits.find(item => item.id === id)
    assert.equal(hit.self, true, JSON.stringify(hit))
  }
  assert.equal(shot.overlap.designUndo, false)
  assert.equal(shot.overlap.designSearch, false)
  assert.equal(shot.overlap.drawUndo, false)
  assert.equal(shot.overlap.drawSearch, false)
}

function summary(measured) {
  const line = (shot, id) => {
    const row = shot.rows[id]
    return `${shot.requested.w} ${id} ${row.fontSize} ${row.ink} on ${row.background} ${row.contrast.toFixed(2)}`
  }
  return [
    measured.browser,
    ...measured.shots.flatMap(shot => ['status', 'hint-name', 'design', 'show-grid'].map(id => line(shot, id))),
    `draw-selected ${measured.drawSelected.rows.draw.ink} ${measured.drawSelected.rows.draw.contrast.toFixed(2)}`,
    `sketch status ${measured.sketch.rows.status.ink} hint ${measured.sketch.rows['hint-name'].ink} grid ${measured.sketch.rows['show-grid'].ink}`,
  ].join('\n')
}

function probeHtml() {
  const href = pathToFileURL(join(root.pathname, 'styles.css')).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href}">
<style>html,body{margin:0;height:100%;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" style="width:100%;height:100%">
  <header class="editor-header"></header>
  <div class="editor-workspace">
    <div class="adaptive-layers-shell"><aside class="layers-panel"></aside></div>
    <div class="canvas-workspace" id="canvas">
      <div id="status" class="kernel-status" role="status" style="position:absolute;right:14px;top:var(--kernel-status-top, 12px);font-size:10px;color:var(--kernel-status-ink, #777c8e);pointer-events:none;z-index:4">正在初始化自研渲染内核…</div>
      <div id="status-error" class="kernel-status error" role="status" style="position:absolute;left:-4000px;top:0;font-size:10px;color:#bd3b54">失败</div>
      <div class="toolbar floating-toolbar" role="toolbar" aria-label="设计工具">
        <div class="creation-tool-hint" id="hint" role="status"><b id="hint-name">矩形</b><span id="hint-rest">拖拽以创建，按住 Shift 约束比例</span></div>
        <div class="tool-group">
          <div class="tool-popover"><button type="button" id="tool-select" class="active" aria-pressed="true" aria-label="选择"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3 6 17 10 13 15 20 18 18 13 11 19 11 5 3Z"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="移动工具"></button></div>
          <div class="tool-popover"><button type="button" aria-label="区域"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="5" width="14" height="14"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="区域菜单"></button></div>
          <div class="tool-popover"><button type="button" aria-label="形状"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="6" y="6" width="12" height="12"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="形状菜单"></button></div>
          <div class="tool-popover"><button type="button" aria-label="绘制工具"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20 16 8l2 2L6 22H4Z"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="绘制菜单"></button></div>
          <button type="button" aria-label="文字">T</button>
          <button type="button" aria-label="评论"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 6h14v9H8l-3 3Z"/></svg></button>
          <div class="tool-popover"><button type="button" aria-label="工具"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="工具菜单"></button></div>
        </div>
        <i></i>
        <div class="tool-group">
          <button type="button" id="undo" aria-label="撤销"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M8 8 4 12l4 4"/><path d="M4 12h10a6 6 0 1 1 0 6"/></svg></button>
          <button type="button" id="redo" aria-label="重做"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m16 8 4 4-4 4"/><path d="M20 12H10a6 6 0 1 0 0 6"/></svg></button>
          <div class="tool-popover"><button type="button" aria-label="排列"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="排列菜单"></button></div>
          <button type="button" id="search" aria-label="搜索"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/></svg></button>
        </div>
        <div class="figma-toolbelt-mode" role="radiogroup" aria-label="工具带模式">
          <button type="button" id="design" role="radio" aria-checked="true" aria-label="设计"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="16" height="16"/></svg></button>
          <button type="button" id="draw" role="radio" aria-checked="false" aria-label="绘制"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        </div>
      </div>
    </div>
    <div class="properties-workspace" id="inspector-host">
      <div class="properties-content">
        <aside class="inspector" id="inspector">
          <div class="panel-tabs"><b>设计</b><span>属性</span></div>
          <section>
            <h3>页面</h3>
            <label class="check-row" id="show-grid"><input type="checkbox" />显示网格</label>
            <label class="check-row" id="smart-snap"><input type="checkbox" />智能吸附</label>
          </section>
        </aside>
      </div>
    </div>
  </div>
  <footer><span id="opened">设计已打开</span><div>hidden</div></footer>
</div>
<script>
function parseColor(value) {
  const text = String(value).trim()
  let match = text.match(/^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?\\s*\\)$/i)
  if (match) return { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] }
  match = text.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\s*\\)$/i)
  if (match) return { r: Math.round(+match[1] * 255), g: Math.round(+match[2] * 255), b: Math.round(+match[3] * 255), a: match[4] === undefined ? 1 : +match[4] }
  return null
}
function composite(front, back) {
  const a = front.a
  return { r: front.r * a + back.r * (1 - a), g: front.g * a + back.g * (1 - a), b: front.b * a + back.b * (1 - a), a: 1 }
}
function painted(el) {
  const layers = []
  for (let node = el; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (color && color.a > 0) layers.push(color)
    if (color && color.a >= 0.999) break
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 }
  for (let index = layers.length - 1; index >= 0; index -= 1) acc = composite(layers[index], acc)
  return { r: Math.round(acc.r), g: Math.round(acc.g), b: Math.round(acc.b) }
}
function channel(value) {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function lum(rgb) { return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b) }
function contrast(fg, bg) {
  const lighter = Math.max(lum(fg), lum(bg))
  const darker = Math.min(lum(fg), lum(bg))
  return (lighter + 0.05) / (darker + 0.05)
}
function hex(rgb) { return '#' + [rgb.r, rgb.g, rgb.b].map(part => Math.round(part).toString(16).padStart(2, '0')).join('') }
function box(el) {
  const rect = el.getBoundingClientRect()
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom }
}
function intersects(a, b) { return a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y }
function read(id) {
  const el = document.getElementById(id)
  const style = getComputedStyle(el)
  const background = painted(el)
  const own = parseColor(style.backgroundColor)
  const ink = parseColor(style.color)
  const mixed = composite({ ...ink, a: ink.a }, { ...background, a: 1 })
  const host = document.getElementById('inspector-host').getBoundingClientRect()
  return {
    id, box: box(el), color: style.color, fontSize: style.fontSize, fontWeight: String(style.fontWeight),
    background: hex(background), backgroundChannels: [background.r, background.g, background.b],
    backgroundRaw: style.backgroundColor, capsuleAlpha: own && own.a < 0.999 ? own.a : null,
    ink: hex(mixed), contrast: contrast(mixed, background),
    fits: el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= host.right + 0.5,
  }
}
function centerHit(id) {
  const el = document.getElementById(id)
  const rect = el.getBoundingClientRect()
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  return { id, hit: hit ? (hit.id || hit.getAttribute('aria-label') || hit.tagName) : null, self: !!(hit && el.contains(hit)) }
}
window.__measure = () => {
  const ids = ['status', 'status-error', 'hint-name', 'hint-rest', 'hint', 'design', 'draw', 'undo', 'search', 'show-grid', 'smart-snap', 'opened']
  const status = document.getElementById('status')
  const previous = status.textContent
  status.textContent = 'CPU · 已显示'
  const ready = read('status')
  ready.id = 'status-ready'
  status.textContent = previous
  const rows = Object.fromEntries(ids.map(id => [id, read(id)]))
  rows['status-ready'] = ready
  const toolbar = box(document.querySelector('.floating-toolbar'))
  const opened = rows.opened.box
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    rows, toolbar, inspector: box(document.getElementById('inspector-host')),
    hits: ['design', 'draw', 'undo', 'search'].map(centerHit),
    overlap: {
      statusToolbar: intersects(rows.status.box, toolbar),
      readyToolbar: intersects(ready.box, toolbar),
      statusOpened: intersects(rows.status.box, opened),
      readyOpened: intersects(ready.box, opened),
      hintToolbar: intersects(rows.hint.box, toolbar),
      designUndo: intersects(rows.design.box, rows.undo.box),
      designSearch: intersects(rows.design.box, rows.search.box),
      drawUndo: intersects(rows.draw.box, rows.undo.box),
      drawSearch: intersects(rows.draw.box, rows.search.box),
    },
  }
}
window.__setMode = (mode) => { document.getElementById('shell').setAttribute('data-ui-mode', mode) }
window.__selectDraw = () => {
  document.getElementById('design').setAttribute('aria-checked', 'false')
  document.getElementById('draw').setAttribute('aria-checked', 'true')
}
</script></body></html>`
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

function evaluate(client, expression) {
  return client.send('Runtime.evaluate', { expression, returnByValue: true }).then(result => {
    assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails))
    return result.result.value
  })
}

async function measureChrome() {
  const binary = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(binary, 'Chrome is required to measure Figma layout contrast')
  const dir = await mkdtemp(join(tmpdir(), 'figma-layout-contrast-'))
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const port = 9600 + Math.floor(Math.random() * 300)
  const chrome = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--force-device-scale-factor=1', '--force-color-profile=srgb', '--hide-scrollbars',
    '--window-size=1440,960', `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let chromeLog = ''
  chrome.stderr?.on('data', chunk => { chromeLog += String(chunk) })
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`)
    const page = pages.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, chromeLog.slice(-500))
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const client = cdp(ws)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    const shots = []
    for (const view of views) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: 1, mobile: false })
      const loaded = client.wait('Page.loadEventFired')
      await client.send('Page.navigate', { url: pathToFileURL(file).href })
      await loaded
      await evaluate(client, 'document.fonts.ready')
      const measured = await evaluate(client, 'window.__measure()')
      if (outDir) {
        await mkdir(outDir, { recursive: true })
        const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
        await writeFile(join(outDir, `after-${view.w}x${view.h}.png`), Buffer.from(shot.data, 'base64'))
        const bottom = await client.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true,
          clip: { x: 0, y: Math.max(0, view.h - 220), width: view.w, height: 220, scale: 2 },
        })
        await writeFile(join(outDir, `after-${view.w}x${view.h}-bottom.png`), Buffer.from(bottom.data, 'base64'))
        const inspector = measured.inspector
        const clip = await client.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true,
          clip: {
            x: Math.max(0, inspector.x),
            y: Math.max(0, inspector.y),
            width: Math.min(inspector.w, view.w - inspector.x),
            height: Math.min(220, inspector.h, view.h - inspector.y),
            scale: 2,
          },
        })
        await writeFile(join(outDir, `after-${view.w}x${view.h}-inspector.png`), Buffer.from(clip.data, 'base64'))
      }
      shots.push({ requested: view, ...measured })
    }
    await evaluate(client, 'window.__selectDraw()')
    const drawSelected = await evaluate(client, 'window.__measure()')
    await evaluate(client, "window.__setMode('sketch')")
    const sketch = await evaluate(client, 'window.__measure()')
    ws.close()
    return { browser: version.Browser, shots, drawSelected, sketch }
  } finally {
    chrome.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
