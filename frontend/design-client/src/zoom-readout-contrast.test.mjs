// Issue #331. The inspector zoom summary is 12px. #858798 is 3.55:1 on white
// and 2.84:1 on the Sketch property tab #e6e6e6. This measures the production
// stylesheets in Chrome, on the same shell classes the editor uses for that
// summary. Linux Chrome is not Electron, Metal, or a macOS window.
// Run: node --test src/zoom-readout-contrast.test.mjs
// Headed, same viewport and DPR as issue #331:
// ZOOM_READOUT_HEADED=1 ZOOM_READOUT_OUT=/tmp/zoom-readout node --test --test-name-pattern live src/zoom-readout-contrast.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = new URL('.', import.meta.url)
const styles = await readFile(new URL('./styles.css', root), 'utf8')
const polish = await readFile(new URL('./chrome-polish.css', root), 'utf8')
const outDir = process.env.ZOOM_READOUT_OUT || ''
const headed = process.env.ZOOM_READOUT_HEADED === '1'
const views = [
  { w: 1440, h: 960 },
  { w: 1180, h: 960 },
  { w: 1000, h: 960 },
]
const modes = ['figma', 'sketch']
// Recorded in the issue and the fix request. Do not substitute nearby grays.
const WHITE = '#ffffff'
const SKETCH_TAB = '#e6e6e6'
const OFFICIAL_FIGMA_TOP = '#e9ebec' // RGB 233, 235, 236
const OFFICIAL_SKETCH_TOP = '#e8ebec' // RGB 232, 235, 236
const OLD_INK = '#858798'
const READOUT_INK = '#5d6673'
const SKETCH_MUTED = '#6e6e73'

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
function rgbHex(rgb) {
  return `#${[rgb.r, rgb.g, rgb.b].map(part => Math.round(part).toString(16).padStart(2, '0')).join('')}`
}
function parseCssColor(color) {
  const match = String(color).match(/rgba?\(([^)]+)\)/i)
  if (!match) return null
  const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number)
  const [r, g, b, a = 1] = parts
  return { r, g, b, a: parts.length > 3 ? a : 1 }
}

test('the old zoom ink fails 4.5:1 and the shared secondary ink does not', () => {
  const onWhite = contrast(OLD_INK, WHITE)
  const onSketchTab = contrast(OLD_INK, SKETCH_TAB)
  assert.ok(Math.abs(onWhite - 3.55) < 0.01, onWhite)
  assert.ok(Math.abs(onSketchTab - 2.84) < 0.01, onSketchTab)
  assert.ok(onWhite < 4.5)
  assert.ok(onSketchTab < 4.5)
  assert.ok(contrast(OLD_INK, OFFICIAL_FIGMA_TOP) < 4.5)
  assert.ok(contrast(OLD_INK, OFFICIAL_SKETCH_TOP) < 4.5)
  // Sketch's own muted token still misses the tab and the recorded top fill.
  assert.ok(contrast(SKETCH_MUTED, SKETCH_TAB) < 4.5)
  assert.ok(contrast(SKETCH_MUTED, OFFICIAL_SKETCH_TOP) < 4.5)
  assert.ok(contrast(SKETCH_MUTED, OFFICIAL_FIGMA_TOP) < 4.5)
  for (const background of [WHITE, SKETCH_TAB, OFFICIAL_FIGMA_TOP, OFFICIAL_SKETCH_TOP, '#f5f5f5']) {
    assert.ok(contrast(READOUT_INK, background) >= 4.5, `${background} ${contrast(READOUT_INK, background)}`)
  }
  const zoom = styles.match(/\.properties-zoom \.canvas-controls \{[^}]+\}/)?.[0]
  const summary = styles.match(/\.compact-controls > \.view-menu > summary \{[^}]+\}/)?.[0]
  assert.ok(zoom)
  assert.ok(summary)
  assert.match(zoom, /color:\s*#5d6673/)
  assert.match(summary, /color:\s*#5d6673/)
  assert.match(polish, /--workspace-muted:\s*#5d6673/)
  assert.doesNotMatch(zoom, /#858798/)
  assert.doesNotMatch(summary, /#858798/)
})

test('the live Figma and Sketch zoom readouts clear 4.5:1', { timeout: 90_000 }, async () => {
  const measured = await measureZoom()
  if (outDir) {
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, 'report.json'), JSON.stringify(measured, null, 2))
  }
  const lines = measured.shots.map(shot => `${shot.mode} ${shot.viewport.w} ${shot.color} on ${shot.backgroundHex} ${shot.ratios.live.toFixed(3)} y=${shot.box.y} hit=${shot.centerHit} clipped=${shot.clipped}`)
  console.log(lines.join('\n'))
  assert.equal(measured.shots.length, views.length * modes.length)
  assert.equal(new Set(measured.shots.map(shot => shot.colorHex)).size, 1)
  for (const shot of measured.shots) {
    const where = `${shot.mode} ${shot.viewport.w} ${JSON.stringify(shot)}`
    assert.equal(shot.text, '100%', where)
    assert.equal(shot.label, '缩放与视图设置', where)
    assert.equal(shot.fontSize, '12px', where)
    assert.equal(shot.colorHex, READOUT_INK, where)
    assert.equal(shot.viewport.w, shot.requestedWidth)
    assert.equal(shot.viewport.h, shot.requestedHeight)
    assert.equal(shot.backgroundHex, shot.mode === 'sketch' ? OFFICIAL_SKETCH_TOP : WHITE, where)
    for (const [name, ratio] of Object.entries(shot.ratios)) {
      assert.ok(ratio >= 4.5, `${where} ${name}=${ratio}`)
    }
    assert.equal(shot.centerHit, true, where)
    assert.equal(shot.clipped, false, where)
    assert.equal(shot.inControls, true, where)
    assert.equal(shot.intersectsToolbar, false, where)
    assert.ok(shot.box.y >= -0.5, where)
    if (shot.mode === 'sketch') assert.ok(shot.box.y < 52, where)
    assert.ok(shot.box.y + shot.box.h <= shot.viewport.h + 0.5, where)
    assert.ok(shot.pixelDelta <= 2, where)
    assert.ok(contrast(hexRgb(shot.colorHex), shot.pixelBackground) >= 4.5, where)
    assert.ok(luminance(shot.darkestPixel) + 0.02 < luminance(hexRgb(OLD_INK)), where)
  }
})

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;background:#fff}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" data-density="wide" data-host="web"
  style="--workspace-layers-width: min(248px, var(--workspace-panel-cap, max(260px, 26vw))); --workspace-inspector-width: min(280px, var(--workspace-panel-cap, max(260px, 26vw)));">
  <header class="editor-header">
    <button type="button" class="brand" aria-label="文件">F</button>
    <div class="document-title">
      <button type="button" class="document-location">本机设计</button>
      <input aria-label="文档名称" value="未命名">
      <button type="button" aria-pressed="false" aria-label="收起界面">▣</button>
    </div>
    <div class="header-right">
      <details class="workspace-actions"><summary aria-label="更多操作">≡</summary></details>
      <span class="save-status">已保存</span>
      <button type="button">本机文件</button>
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" aria-pressed="true">Figma</button>
        <button type="button" aria-pressed="false">Sketch</button>
      </div>
      <label class="locale-switch"><select aria-label="语言"><option>中文</option></select></label>
      <button type="button" class="prototype-preview-button" aria-label="预览原型"><span>预览</span></button>
      <button type="button" class="primary">导出</button>
      <div class="sketch-window-zoom"></div>
      <button type="button" class="app-settings-button"><span>设置</span></button>
    </div>
  </header>
  <main class="editor-workspace">
    <nav class="workspace-rail" aria-label="工作区"></nav>
    <div class="adaptive-layers-shell"><aside class="layers-panel"></aside></div>
    <div class="canvas-workspace"><div class="toolbar floating-toolbar" id="toolbar"><button type="button">选择</button><div class="figma-view-tools"><div class="figma-view-zoom"></div></div></div></div>
    <div class="properties-workspace">
      <div class="properties-tabs">
        <div class="properties-tab-buttons" role="tablist" aria-label="属性">
          <button type="button" aria-selected="true">设计</button>
          <button type="button">原型</button>
        </div>
        <div class="properties-zoom">
          <div class="canvas-controls compact-controls">
            <details class="view-menu">
              <summary aria-label="缩放与视图设置" data-testid="zoom-readout">100%</summary>
            </details>
          </div>
        </div>
      </div>
      <div class="properties-content"><aside class="inspector"></aside></div>
    </div>
  </main>
</div>
<script>
function parseColor(color) {
  const match = String(color).match(/rgba?\\(([^)]+)\\)/i)
  if (!match) return null
  const parts = match[1].split(/[,\\s/]+/).filter(Boolean).map(Number)
  const [r, g, b, a = 1] = parts
  return { r, g, b, a: parts.length > 3 ? a : 1 }
}
function compositeBackground(element) {
  const layers = []
  for (let node = element; node; node = node.parentElement) {
    const color = parseColor(getComputedStyle(node).backgroundColor)
    if (!color || color.a === 0) continue
    layers.push(color)
    if (color.a >= 0.999) break
  }
  let red = 255, green = 255, blue = 255
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const color = layers[index]
    red = color.r * color.a + red * (1 - color.a)
    green = color.g * color.a + green * (1 - color.a)
    blue = color.b * color.a + blue * (1 - color.a)
  }
  return { r: Math.round(red), g: Math.round(green), b: Math.round(blue) }
}
function round(value) { return Math.round(value * 100) / 100 }
function boxOf(element) {
  const rect = element.getBoundingClientRect()
  return { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
}
function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}
function clipped(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return true
  if (rect.y < -0.5 || rect.x < -0.5 || rect.bottom > innerHeight + 0.5 || rect.right > innerWidth + 0.5) return true
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'contents') continue
    const clipsY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY)
    const clipsX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX)
    if (!clipsY && !clipsX) continue
    const host = node.getBoundingClientRect()
    if (host.width < 1 || host.height < 1) continue
    if (clipsY && (rect.y < host.y - 0.5 || rect.bottom > host.bottom + 0.5)) return true
    if (clipsX && (rect.x < host.x - 0.5 || rect.right > host.right + 0.5)) return true
  }
  return false
}
window.__readZoom = (mode) => {
  const shell = document.getElementById('shell')
  const width = innerWidth
  shell.dataset.uiMode = mode
  shell.dataset.density = width <= 900 ? 'narrow' : width <= 1180 ? 'desk' : 'wide'
  const summary = document.querySelector('[data-testid="zoom-readout"]')
  const host = document.querySelector(mode === 'figma' ? '.figma-view-zoom' : '.sketch-window-zoom')
  host.append(summary.closest('.canvas-controls'))
  const style = getComputedStyle(summary)
  const color = parseColor(style.color)
  const background = compositeBackground(summary)
  const box = boxOf(summary)
  const x = box.x + box.w / 2
  const y = box.y + box.h / 2
  const hit = document.elementFromPoint(x, y)
  const toolbar = document.getElementById('toolbar')
  const toolbarBox = toolbar ? boxOf(toolbar) : null
  const controls = summary.closest(mode === 'figma' ? '.figma-view-tools' : '.sketch-window-zoom')
  return {
    mode,
    density: shell.dataset.density,
    text: summary.textContent,
    label: summary.getAttribute('aria-label'),
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    color: style.color,
    colorRgb: color,
    background,
    box,
    sample: { x: round(box.x + 2), y: round(box.y + 2) },
    centerHit: !!hit && (hit === summary || summary.contains(hit)),
    hit: hit ? (hit.getAttribute('aria-label') || hit.id || hit.className || hit.tagName) : null,
    clipped: clipped(summary),
    inControls: !!controls,
    toolbar: toolbarBox,
    intersectsToolbar: !!(toolbarBox && toolbarBox.w > 2 && toolbarBox.h > 2 && intersects(box, toolbarBox)),
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  }
}
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

export function decodePng(bytes) {
  const png = Buffer.from(bytes)
  if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('screenshot is not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 0
  let bitDepth = 0
  const idat = []
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('interlaced screenshot')
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels || bitDepth !== 8) throw new Error(`unsupported PNG type ${colorType} depth ${bitDepth}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  let source = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const row = Buffer.from(raw.subarray(source, source + stride))
    source += stride
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? row[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      if (filter === 1) row[index] = (row[index] + left) & 255
      else if (filter === 2) row[index] = (row[index] + up) & 255
      else if (filter === 3) row[index] = (row[index] + Math.floor((left + up) / 2)) & 255
      else if (filter === 4) row[index] = (row[index] + paeth(left, up, upLeft)) & 255
      else if (filter !== 0) throw new Error(`PNG filter ${filter}`)
    }
    for (let x = 0; x < width; x += 1) {
      const input = x * channels
      const output = (y * width + x) * 4
      pixels[output] = row[input]
      pixels[output + 1] = row[input + 1]
      pixels[output + 2] = row[input + 2]
      pixels[output + 3] = channels === 4 ? row[input + 3] : 255
    }
    previous = row
  }
  return { width, height, pixels }
}

function pixelAt(image, x, y) {
  const px = Math.min(image.width - 1, Math.max(0, Math.round(x)))
  const py = Math.min(image.height - 1, Math.max(0, Math.round(y)))
  const index = (py * image.width + px) * 4
  return { r: image.pixels[index], g: image.pixels[index + 1], b: image.pixels[index + 2] }
}

function darkestPixel(image, box, scaleX, scaleY) {
  const x0 = Math.max(0, Math.floor(box.x * scaleX))
  const y0 = Math.max(0, Math.floor(box.y * scaleY))
  const x1 = Math.min(image.width - 1, Math.ceil((box.x + box.w) * scaleX))
  const y1 = Math.min(image.height - 1, Math.ceil((box.y + box.h) * scaleY))
  let best = { r: 255, g: 255, b: 255 }
  let bestLum = Infinity
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const index = (y * image.width + x) * 4
      const pixel = { r: image.pixels[index], g: image.pixels[index + 1], b: image.pixels[index + 2] }
      const lum = luminance(pixel)
      if (lum < bestLum) {
        bestLum = lum
        best = pixel
      }
    }
  }
  return best
}

async function measureZoom() {
  const binary = [process.env.CHROME_PATH, '/usr/local/bin/google-chrome', '/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)
  assert.ok(binary, 'Chrome is required to measure the zoom readout')
  const dir = await mkdtemp(join(tmpdir(), 'zoom-readout-'))
  const port = 9400 + Math.floor(Math.random() * 500)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  const args = [
    ...(headed ? [] : ['--headless=new']),
    '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', '--hide-scrollbars',
    '--force-color-profile=srgb', `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ]
  const chrome = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  chrome.stderr?.resume()
  const shots = []
  try {
    const version = await waitJson(`http://127.0.0.1:${port}/json/version`)
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
    for (const view of views) {
      await client.send('Emulation.setDeviceMetricsOverride', { width: view.w, height: view.h, deviceScaleFactor: 1, mobile: false })
      for (const mode of modes) {
        const evaluated = await client.send('Runtime.evaluate', {
          expression: `window.__readZoom(${JSON.stringify(mode)})`,
          returnByValue: true,
        })
        assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
        const shot = evaluated.result.value
        assert.equal(shot.viewport.w, view.w)
        assert.equal(shot.viewport.h, view.h)
        const imageResult = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
        const png = Buffer.from(imageResult.data, 'base64')
        const image = decodePng(png)
        const scaleX = image.width / view.w
        const scaleY = image.height / view.h
        const pixelBackground = pixelAt(image, shot.sample.x * scaleX, shot.sample.y * scaleY)
        const darkest = darkestPixel(image, shot.box, scaleX, scaleY)
        const background = shot.background
        const foreground = shot.colorRgb
        const ratios = {
          live: contrast(foreground, background),
          white: contrast(foreground, WHITE),
          sketchTab: contrast(foreground, SKETCH_TAB),
          officialFigma: contrast(foreground, OFFICIAL_FIGMA_TOP),
          officialSketch: contrast(foreground, OFFICIAL_SKETCH_TOP),
        }
        const pixelDelta = Math.max(
          Math.abs(pixelBackground.r - background.r),
          Math.abs(pixelBackground.g - background.g),
          Math.abs(pixelBackground.b - background.b),
        )
        const row = {
          ...shot,
          requestedWidth: view.w,
          requestedHeight: view.h,
          colorHex: rgbHex(foreground),
          backgroundHex: rgbHex(background),
          pixelBackground,
          darkestPixel: darkest,
          pixelDelta,
          ratios,
          chrome: version.Browser,
        }
        if (outDir) {
          await mkdir(outDir, { recursive: true })
          const name = `${mode}-${view.w}x${view.h}.png`
          await writeFile(join(outDir, name), png)
          row.screenshot = name
        }
        shots.push(row)
      }
    }
    ws.close()
    return { headed, chrome: version.Browser, shots }
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
