// Issue #332. Selected select-tool, layers item, and design tab used the accent
// as ink on the pale selected wash. This locks the on-selected ink and measures
// the same controls in Chrome: computed color, then pixels of the live chrome.
// Run: node --test src/selected-chrome-contrast.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const polish = await readFile(new URL('./chrome-polish.css', root), 'utf8')

function channel(value) {
  const scaled = value / 255
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}
function luminance(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
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
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}
function composite(hex, alpha, background) {
  const fg = hexRgb(hex)
  const bg = hexRgb(background)
  return fg.map((part, index) => Math.round(part * alpha + bg[index] * (1 - alpha)))
}
function block(source, selector) {
  const match = source.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]+\\}`))
  assert.ok(match, selector)
  return match[0]
}
function blocks(source, selector) {
  return [...source.matchAll(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]+\\}`, 'g'))].map(match => match[0])
}

test('the measured selected accent fails 4.5:1 and the on-selected ink does not', () => {
  const figmaSelect = contrast('#0d99ff', '#e5f4ff')
  const figmaTab = contrast('#0d99ff', '#ffffff')
  const sketchSelect = contrast('#007aff', '#d6e8ff')
  const sketchTab = contrast('#007aff', '#e6e6e6')
  assert.ok(figmaSelect > 2.66 && figmaSelect < 2.68, figmaSelect)
  assert.ok(figmaTab > 2.98 && figmaTab < 3.0, figmaTab)
  assert.ok(sketchSelect > 3.21 && sketchSelect < 3.24, sketchSelect)
  assert.ok(sketchTab > 3.21 && sketchTab < 3.24, sketchTab)
  assert.ok(figmaSelect < 4.5 && sketchSelect < 4.5)
  // Official selected blue still misses 4.5:1, so it cannot be the glyph.
  assert.ok(contrast('#007be5', '#e5f4ff') < 4.5)
  assert.ok(contrast('#007be5', '#ffffff') < 4.5)
  for (const background of ['#e5f4ff', '#ffffff']) {
    assert.ok(contrast(composite('000000', 0xe5 / 255, background), background) >= 4.5, background)
  }
  assert.ok(contrast('#1d1d1f', '#d6e8ff') >= 4.5)
  assert.ok(contrast('#1d1d1f', '#e6e6e6') >= 4.5)
  assert.ok(contrast('#5d6673', '#ffffff') >= 4.5)
  assert.ok(contrast('#333333', '#ffffff') > 12)

  const figma = block(styles, '.editor-shell[data-ui-mode="figma"]')
  const sketch = block(styles, '.editor-shell[data-ui-mode="sketch"]')
  assert.match(figma, /--workspace-accent:\s*#0d99ff;/)
  assert.match(figma, /--workspace-selected:\s*#e5f4ff;/)
  assert.match(figma, /--workspace-selected-ink:\s*#000000e5;/)
  assert.match(figma, /--workspace-muted:\s*#5d6673;/)
  assert.match(figma, /--workspace-text:\s*#333333;/)
  assert.match(sketch, /--workspace-accent:\s*#007aff;/)
  assert.match(sketch, /--workspace-selected:\s*#d6e8ff;/)
  assert.match(sketch, /--workspace-selected-ink:\s*#1d1d1f;/)
  assert.match(sketch, /--workspace-text:\s*#1d1d1f;/)
  const ink = /color:\s*var\(--workspace-selected-ink,\s*var\(--workspace-accent\)\)/
  for (const rule of blocks(styles, '.workspace-rail button[aria-pressed=true]')) {
    assert.match(rule, ink)
    assert.match(rule, /background:\s*var\(--workspace-selected\)/)
  }
  assert.match(block(styles, '.floating-toolbar .tool-popover > button.active'), ink)
  assert.match(styles, /\.floating-toolbar \.tool-popover > button\.active:hover \{ color: var\(--workspace-selected-ink, var\(--workspace-accent\)\);/)
  const tab = blocks(styles, '.properties-tabs button[aria-selected=true]').at(-1)
  assert.match(tab, ink)
  assert.match(tab, /background:\s*transparent/)
  assert.match(tab, /box-shadow:\s*inset 0 -2px 0 var\(--workspace-accent\)/)
  assert.match(styles, /\.workspace-rail button \{[^}]*color:\s*var\(--workspace-muted\)/)
  assert.match(polish, /--workspace-muted:\s*#5d6673;/)
})

test('live chrome selected tool, layers item, and design tab clear 4.5:1', { timeout: 60_000 }, async () => {
  const measured = await measureChrome()
  const dir = process.env.SELECTED_CONTRAST_DIR
  if (dir) await writeFile(join(dir, 'report.json'), JSON.stringify(measured, null, 2))
  console.log(summary(measured))
  assert.equal(measured.viewport.w, 1440)
  assert.equal(measured.viewport.h, 960)
  assert.ok(Math.abs(measured.viewport.dpr - 1) < 0.02, measured.viewport.dpr)
  if (measured.renderer !== 'none') assert.match(measured.renderer, /SwiftShader|llvmpipe|software/i)
  assertSelected(measured.figma, 'figma')
  assertSelected(measured.sketch, 'sketch')
})

function assertSelected(shot, mode) {
  const select = shot.controls['tool-select']
  const frame = shot.controls['tool-frame']
  const design = shot.controls['design-tab']
  const proto = shot.controls['proto-tab']
  assert.ok(select.computed >= 4.5, `${mode} select computed ${select.computed} ${select.ink}`)
  assert.ok(select.pixels >= 4.5, `${mode} select pixels ${select.pixels}`)
  assert.ok(select.glyphPixels > 20, `${mode} select glyph`)
  assert.ok(design.computed >= 4.5, `${mode} design computed ${design.computed} ${design.ink}`)
  assert.ok(design.pixels >= 4.5, `${mode} design pixels ${design.pixels}`)
  assert.ok(design.glyphPixels > 8, `${mode} design glyph`)
  assert.equal(design.indicator, true, `${mode} design tab lost its accent underline`)
  assert.equal(proto.selectedInk, false, `${mode} unselected tab took the selected ink`)
  assert.notEqual(roundHex(select.background), roundHex(frame.background))
  if (mode === 'figma') {
    assert.ok(select.w >= 39 && select.w <= 41 && select.h >= 39 && select.h <= 41, `${select.w}×${select.h}`)
    assert.equal(roundHex(select.background), '#e5f4ff')
    assert.notEqual(roundHex(select.ink), '#0d99ff')
    const layers = shot.controls.layers
    const assets = shot.controls.assets
    assert.ok(layers.w >= 40 && layers.w <= 52 && layers.h >= 46, `${layers.w}×${layers.h}`)
    assert.equal(roundHex(layers.background), '#e5f4ff')
    assert.ok(layers.computed >= 4.5, `layers computed ${layers.computed}`)
    assert.ok(layers.pixels >= 4.5, `layers pixels ${layers.pixels}`)
    assert.equal(roundHex(assets.ink), '#5d6673')
    assert.ok(assets.computed >= 4.5, `unselected layers item ${assets.computed}`)
    assert.ok(proto.computed >= 4.5, `unselected design tab ${proto.computed}`)
    assert.notEqual(roundHex(assets.background), '#e5f4ff')
    assert.equal(roundHex(frame.ink), '#333333')
  } else {
    assert.ok(select.w >= 33 && select.w <= 35 && select.h >= 33 && select.h <= 35, `${select.w}×${select.h}`)
    assert.equal(roundHex(select.background), '#d6e8ff')
    assert.equal(roundHex(select.ink), '#1d1d1f')
    assert.equal(roundHex(design.ink), '#1d1d1f')
    assert.equal(roundHex(proto.ink), '#6e6e73')
    assert.notEqual(roundHex(proto.ink), '#007aff')
  }
}

function roundHex(rgb) {
  return `#${rgb.map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`
}

function summary(measured) {
  const line = (mode, id) => {
    const row = measured[mode].controls[id]
    if (!row) return `${mode} ${id} missing`
    return `${mode} ${id} ${row.w}×${row.h} ink=${roundHex(row.ink)} bg=${roundHex(row.background)} computed=${row.computed.toFixed(2)} pixels=${row.pixels.toFixed(2)}`
  }
  return [
    `chrome=${measured.browser} dpr=${measured.viewport.dpr} renderer=${measured.renderer} headed=${measured.headed}`,
    line('figma', 'tool-select'), line('figma', 'layers'), line('figma', 'assets'), line('figma', 'design-tab'), line('figma', 'proto-tab'),
    line('sketch', 'tool-select'), line('sketch', 'tool-frame'), line('sketch', 'design-tab'), line('sketch', 'proto-tab'),
  ].join('\n')
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;width:1440px;height:960px;overflow:hidden}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" style="width:1440px;height:960px">
  <header class="editor-header"></header>
  <div class="editor-workspace">
    <nav class="workspace-rail" aria-label="工作区">
      <button type="button" id="layers" aria-pressed="true" title="页面与图层"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.91a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg><span>图层</span></button>
      <button type="button" id="assets" aria-pressed="false" title="组件与资源"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="4" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/></svg><span>资源</span></button>
    </nav>
    <aside class="layers-panel" style="width:248px"></aside>
    <div class="canvas-workspace">
      <div class="toolbar floating-toolbar" role="toolbar" aria-label="设计工具">
        <div class="tool-group">
          <div class="tool-popover"><button type="button" id="tool-select" class="active" aria-pressed="true" aria-label="选择"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.4 3.2 5.6 16.6 9.6 12.8 14 19.6 16.6 18.4 12.2 11.6 17.2 11 5.4 3.2Z"/></svg></button><button type="button" class="tool-picker-arrow" aria-label="移动工具"></button></div>
          <div class="tool-popover"><button type="button" id="tool-frame" aria-pressed="false" aria-label="画板"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="6" y="6" width="12" height="12"/></svg></button></div>
        </div>
      </div>
    </div>
    <div class="properties-workspace">
      <div class="properties-tabs"><div class="properties-tab-buttons" role="tablist">
        <button type="button" role="tab" id="design-tab" aria-selected="true">设计</button>
        <button type="button" role="tab" id="proto-tab" aria-selected="false">原型</button>
      </div></div>
    </div>
  </div>
</div>
<script>
const ids = ['layers','assets','tool-select','tool-frame','design-tab','proto-tab']
function parseColor(value) {
  const match = String(value).match(/rgba?\\(([^)]+)\\)/)
  if (!match) return null
  const parts = match[1].split(',').map(part => Number(part.trim()))
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}
function compositeOver(front, back) {
  const a = front.a
  return { r: front.r * a + back.r * (1 - a), g: front.g * a + back.g * (1 - a), b: front.b * a + back.b * (1 - a), a: 1 }
}
function painted(el) {
  const layers = []
  for (let node = el; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (color) layers.push(color)
  }
  let acc = { r: 255, g: 255, b: 255, a: 1 }
  for (let index = layers.length - 1; index >= 0; index -= 1) acc = compositeOver(layers[index], acc)
  return [Math.round(acc.r), Math.round(acc.g), Math.round(acc.b)]
}
function inkOf(el, background) {
  const color = parseColor(getComputedStyle(el).color)
  const mixed = compositeOver(color, { r: background[0], g: background[1], b: background[2], a: 1 })
  return [Math.round(mixed.r), Math.round(mixed.g), Math.round(mixed.b)]
}
function readControl(id) {
  const el = document.getElementById(id)
  const box = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const background = painted(el)
  return {
    x: box.x, y: box.y, w: box.width, h: box.height,
    color: style.color, font: style.fontSize, weight: style.fontWeight, shadow: style.boxShadow,
    display: style.display, background, ink: inkOf(el, background),
  }
}
function rendererName() {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'none'
  } catch (error) { return String(error) }
}
window.__measure = (mode) => {
  const shell = document.getElementById('shell')
  shell.setAttribute('data-ui-mode', mode)
  return {
    mode,
    controls: Object.fromEntries(ids.map(id => [id, readControl(id)])),
  }
}
window.__env = () => ({
  w: innerWidth, h: innerHeight, dpr: devicePixelRatio, renderer: rendererName(),
})
</script></body></html>`
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const diagonal = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= diagonal) return left
  return upDistance <= diagonal ? up : upLeft
}

function decodePng(bytes) {
  const png = Buffer.from(bytes)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const chunks = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  assert.equal(bitDepth, 8)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  assert.ok(channels, `png color type ${colorType}`)
  const inflated = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let source = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[source]
    source += 1
    const row = Buffer.from(inflated.subarray(source, source + stride))
    source += stride
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? row[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      if (filter === 1) row[index] = (row[index] + left) & 255
      else if (filter === 2) row[index] = (row[index] + up) & 255
      else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) row[index] = (row[index] + paeth(left, up, upLeft)) & 255
      else if (filter !== 0) throw new Error(`png filter ${filter}`)
    }
    for (let x = 0; x < width; x += 1) {
      const index = x * channels
      const target = (y * width + x) * 4
      out[target] = row[index]
      out[target + 1] = row[index + 1]
      out[target + 2] = row[index + 2]
      out[target + 3] = channels === 4 ? row[index + 3] : 255
    }
    previous = row
  }
  return { width, height, data: out }
}

function pixelContrast(image, rect, background, skipBottom) {
  const scaleX = image.width / 1440
  const scaleY = image.height / 960
  const inset = 2
  const x0 = Math.max(0, Math.ceil((rect.x + inset) * scaleX))
  const y0 = Math.max(0, Math.ceil((rect.y + inset) * scaleY))
  const x1 = Math.min(image.width, Math.floor((rect.x + rect.w - inset) * scaleX))
  const y1 = Math.min(image.height, Math.floor((rect.y + rect.h - inset - skipBottom) * scaleY))
  const ratios = []
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4
      const pixel = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      const distance = Math.abs(pixel[0] - background[0]) + Math.abs(pixel[1] - background[1]) + Math.abs(pixel[2] - background[2])
      if (distance < 36) continue
      ratios.push(contrast(pixel, background))
    }
  }
  ratios.sort((a, b) => a - b)
  const rank = ratios.length === 0 ? 0 : ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.9))]
  return { pixels: rank, glyphPixels: ratios.length }
}

function indicatorPresent(image, rect, accent) {
  const scaleX = image.width / 1440
  const scaleY = image.height / 960
  const x0 = Math.max(0, Math.floor((rect.x + 4) * scaleX))
  const x1 = Math.min(image.width, Math.ceil((rect.x + rect.w - 4) * scaleX))
  const y0 = Math.max(0, Math.floor((rect.y + rect.h - 3) * scaleY))
  const y1 = Math.min(image.height, Math.ceil((rect.y + rect.h) * scaleY))
  let blue = 0
  let seen = 0
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4
      const pixel = [image.data[offset], image.data[offset + 1], image.data[offset + 2]]
      seen += 1
      if (pixel[2] > pixel[0] + 40 && pixel[2] > 140) blue += 1
      else if (Math.abs(pixel[0] - accent[0]) < 40 && Math.abs(pixel[2] - accent[2]) < 40) blue += 1
    }
  }
  return seen > 0 && blue >= 2
}

async function measureChrome() {
  const binary = [process.env.CHROME_PATH, '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
  assert.ok(binary, 'Chrome is required to measure selected chrome contrast')
  const headed = process.env.CHROME_HEADLESS !== '1' && Boolean(process.env.DISPLAY)
  const dir = await mkdtemp(join(tmpdir(), 'selected-contrast-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const chrome = spawn(binary, [
    ...(headed ? [] : ['--headless=new']),
    '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
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
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const env = await evaluate(client, 'window.__env()')
    const shots = {}
    for (const mode of ['figma', 'sketch']) {
      const layout = await evaluate(client, `window.__measure(${JSON.stringify(mode)})`)
      const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const image = decodePng(Buffer.from(shot.data, 'base64'))
      const outDir = process.env.SELECTED_CONTRAST_DIR
      if (outDir) await writeFile(join(outDir, `${mode}-1440x960.png`), Buffer.from(shot.data, 'base64'))
      const controls = {}
      for (const [id, rect] of Object.entries(layout.controls)) {
        if (rect.display === 'none' || rect.w < 1 || rect.h < 1) continue
        const skipBottom = id.endsWith('-tab') ? 4 : 0
        const sampled = pixelContrast(image, rect, rect.background, skipBottom)
        controls[id] = {
          ...rect,
          computed: contrast(rect.ink, rect.background),
          pixels: sampled.pixels,
          glyphPixels: sampled.glyphPixels,
          indicator: id === 'design-tab' ? indicatorPresent(image, rect, mode === 'figma' ? [13, 153, 255] : [0, 122, 255]) : false,
          selectedInk: id === 'proto-tab' ? roundHex(rect.ink) === (mode === 'figma' ? '#1a1a1a' : '#1d1d1f') : false,
        }
      }
      shots[mode] = { controls, image: { w: image.width, h: image.height } }
    }
    ws.close()
    return {
      browser: version.Browser,
      headed,
      renderer: env.renderer,
      viewport: { w: env.w, h: env.h, dpr: env.dpr },
      ...shots,
    }
  } finally {
    chrome.kill('SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
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
