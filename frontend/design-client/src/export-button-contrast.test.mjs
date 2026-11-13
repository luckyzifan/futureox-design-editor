// Issue #333. Measures the header Export control in headed Chrome at the
// reported 1440×960 target and the ≤1180 icon state. DPR is 1.
// Run: node --test src/export-button-contrast.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

const root = new URL('.', import.meta.url)
const shots = process.env.EXPORT_CONTRAST_SHOTS || ''

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
function hexByte(channelValue) {
  return Math.round(channelValue).toString(16).padStart(2, '0')
}
function hexFromChannels(red, green, blue) {
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}`
}
function hexFromCss(color) {
  const match = color.replace(/\s/g, '').match(/^rgba?\((\d+),(\d+),(\d+)(?:,([\d.]+))?\)$/i)
  assert.ok(match, `expected an rgb color, got ${color}`)
  assert.ok(match[4] === undefined || Number(match[4]) === 1, `${color} is not opaque`)
  return hexFromChannels(Number(match[1]), Number(match[2]), Number(match[3]))
}
function normalizeHex(value) {
  const hex = value.trim().toLowerCase()
  assert.match(hex, /^#[0-9a-f]{6}$/)
  return hex
}

test('the reported export pairs fail 4.5:1 and the replacement fills are the ones that pass', async () => {
  const legacyFigma = contrast('#ffffff', '#0d99ff')
  const legacySketch = contrast('#ffffff', '#007aff')
  const officialHover = contrast('#ffffff', '#007be5')
  const figmaFill = contrast('#ffffff', '#0768cf')
  const sketchFill = contrast('#ffffff', '#0063cc')
  assert.ok(legacyFigma > 2.98 && legacyFigma < 3, `expected the measured 2.99:1, got ${legacyFigma}`)
  assert.ok(legacySketch > 4.01 && legacySketch < 4.03, `expected the measured 4.02:1, got ${legacySketch}`)
  assert.ok(officialHover < 4.5, `official bg-brand-hover must stay a failing candidate, got ${officialHover}`)
  assert.ok(figmaFill >= 4.5, figmaFill)
  assert.ok(sketchFill >= 4.5, sketchFill)
  assert.ok(figmaFill < sketchFill)
  const styles = await readFile(new URL('./styles.css', root), 'utf8')
  const figma = styles.match(/\.editor-shell\[data-ui-mode="figma"\] \{[^}]+\}/)?.[0]
  const sketch = styles.match(/\.editor-shell\[data-ui-mode="sketch"\] \{[^}]+\}/)?.[0]
  assert.ok(figma)
  assert.ok(sketch)
  assert.match(figma, /--workspace-accent:\s*#0d99ff/)
  assert.match(figma, /--workspace-accent-hover:\s*#0b86e0/)
  assert.match(sketch, /--workspace-accent:\s*#007aff/)
  assert.match(sketch, /--workspace-accent-hover:\s*#0063cc/)
  const figmaExport = styles.match(/\.editor-shell\[data-ui-mode="figma"\] \.header-right > \.primary:hover,[\s\S]*?\{[^}]+\}/)?.[0]
  const sketchExport = styles.match(/\.editor-shell\[data-ui-mode="sketch"\] \.header-right > \.primary:hover,[\s\S]*?\{[^}]+\}/)?.[0]
  assert.ok(figmaExport)
  assert.ok(sketchExport)
  assert.match(figmaExport, /background:\s*#0768cf/)
  assert.match(figmaExport, /color:\s*#ffffff/)
  assert.match(sketchExport, /background:\s*#0063cc/)
  assert.match(sketchExport, /color:\s*#ffffff/)
  assert.doesNotMatch(figmaExport, /#0d99ff|#007be5/)
  assert.doesNotMatch(sketchExport, /#007aff/)
  const app = await readFile(new URL('./App.tsx', root), 'utf8')
  assert.match(app, /className="primary"[\s\S]{0,240}导出/)
})

test('headed Chrome measures Export contrast on the live header', { timeout: 120_000 }, async () => {
  const measured = await measureExport()
  console.log(summary(measured))
  for (const shot of measured.shots) {
    assert.equal(shot.viewport.w, shot.requestedWidth, JSON.stringify(shot.viewport))
    assert.equal(shot.viewport.h, shot.requestedHeight)
    assert.equal(shot.viewport.dpr, 1)
    assert.equal(shot.hitSelf, true, JSON.stringify({ id: shot.id, hit: shot.hit }))
    assert.equal(shot.ink, '#ffffff', shot.id)
    assert.ok(shot.contrast >= 4.5, `${shot.id} computed ${shot.contrast}`)
    assert.equal(shot.iconContrast >= 4.5, true, `${shot.id} icon ${shot.iconColor} on ${shot.fill}`)
    assert.ok(shot.visibleIcon, `${shot.id} has no visible icon`)
    assert.ok(shot.button.w + 0.5 >= shot.visibleIcon.w, `${shot.id} button ${shot.button.w} < icon ${shot.visibleIcon.w}`)
    assert.ok(shot.button.h + 0.5 >= shot.visibleIcon.h, `${shot.id} button ${shot.button.h} < icon ${shot.visibleIcon.h}`)
    assert.ok(contains(shot.button, shot.visibleIcon), `${shot.id} icon escapes the button`)
    assert.equal(shot.sampledFill, shot.fill, `${shot.id} painted ${shot.sampledFill} computed ${shot.fill}`)
    assert.equal(shot.hover.fill, shot.fill, `${shot.id} hover ${shot.hover.fill}`)
    assert.equal(shot.hover.ink, '#ffffff')
    assert.ok(shot.hover.contrast >= 4.5, `${shot.id} hover ${shot.hover.contrast}`)
    assert.equal(shot.active.fill, shot.fill, `${shot.id} active ${shot.active.fill}`)
    if (shot.mode === 'figma') {
      assert.equal(shot.fill, '#0768cf', shot.id)
      assert.equal(shot.accent, '#0d99ff', shot.id)
      assert.equal(shot.otherPrimary, '#0d99ff', `${shot.id} retinted a non-export primary`)
    } else {
      assert.equal(shot.fill, '#0063cc', shot.id)
      assert.equal(shot.accent, '#007aff', shot.id)
      assert.equal(shot.otherPrimary, '#007aff', `${shot.id} retinted a non-export primary`)
    }
    if (shot.requestedWidth >= 1181) {
      assert.equal(shot.font, '12px', shot.id)
      assert.equal(shot.density, 'wide', shot.id)
      assert.match(shot.text, /导出/)
      assert.ok(shot.textBox.w >= 12, `${shot.id} label width ${shot.textBox.w}`)
      assert.ok(shot.textInk, `${shot.id} label was not painted`)
      assert.ok(shot.textInk.contrast >= 4.5, `${shot.id} painted text ${shot.textInk.contrast} ${shot.textInk.hex}`)
    } else {
      assert.equal(shot.font, '0px', shot.id)
      assert.equal(shot.density, 'desk', shot.id)
      assert.ok(shot.textBox.w < 1, `${shot.id} icon state still lays out the label at ${shot.textBox.w}`)
    }
  }
  assert.match(measured.environment.browser, /Chrome\/\d+/)
  assert.equal(measured.environment.headed, true)
})

function contains(parent, child) {
  return child.x >= parent.x - 0.5 && child.y >= parent.y - 0.5
    && child.x + child.w <= parent.x + parent.w + 0.5
    && child.y + child.h <= parent.y + parent.h + 0.5
}

function summary(measured) {
  const lines = [`chrome=${measured.environment.browser} headed=${measured.environment.headless === false} dpr=${measured.environment.deviceScaleFactor}`]
  for (const shot of measured.shots) {
    lines.push(`${shot.id} ${shot.button.w.toFixed(2)}×${shot.button.h.toFixed(2)} font=${shot.font} fill=${shot.fill} ink=${shot.ink} contrast=${shot.contrast.toFixed(2)} painted=${shot.sampledFill} hover=${shot.hover.fill}@${shot.hover.contrast.toFixed(2)} text=${shot.textInk ? shot.textInk.hex + '@' + shot.textInk.contrast.toFixed(2) : 'n/a'} icon=${shot.visibleIcon.w.toFixed(1)}×${shot.visibleIcon.h.toFixed(1)}`)
  }
  return lines.join('\n')
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body{margin:0;background:#fff}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" data-density="wide">
  <header class="editor-header">
    <div class="document-title"><input aria-label="文档名称" value="未命名"></div>
    <div class="header-right" id="header-right">
      <div class="ui-mode-switch" role="group" aria-label="界面布局">
        <button type="button" aria-pressed="true">Figma</button>
        <button type="button" aria-pressed="false">Sketch</button>
      </div>
      <label class="locale-switch"><select aria-label="语言"><option>中文</option></select></label>
      <button type="button" class="prototype-preview-button" aria-label="预览原型"><span>预览</span></button>
      <button type="button" class="primary" id="export">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
        导出
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button type="button" class="app-settings-button"><span>设置</span></button>
      <span class="avatar">我</span>
    </div>
  </header>
  <button type="button" class="primary" id="other-primary">完成</button>
</div>
<script>
function readExport() {
  const shell = document.getElementById('shell')
  const wide = matchMedia('(min-width: 1181px)').matches
  const narrow = matchMedia('(max-width: 900px)').matches
  shell.dataset.density = narrow ? 'narrow' : wide ? 'wide' : 'desk'
  const button = document.getElementById('export')
  const style = getComputedStyle(button)
  const box = button.getBoundingClientRect()
  const textNode = [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes('导出'))
  const range = document.createRange()
  range.selectNodeContents(textNode)
  const textBox = range.getBoundingClientRect()
  const icons = [...button.querySelectorAll('svg')].map((svg) => {
    const iconStyle = getComputedStyle(svg)
    const rect = svg.getBoundingClientRect()
    return { display: iconStyle.display, color: iconStyle.color, stroke: iconStyle.stroke, w: rect.width, h: rect.height, x: rect.x, y: rect.y }
  })
  const center = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
  const other = getComputedStyle(document.getElementById('other-primary'))
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    density: shell.dataset.density,
    accent: getComputedStyle(shell).getPropertyValue('--workspace-accent').trim().toLowerCase(),
    font: style.fontSize,
    weight: style.fontWeight,
    color: style.color,
    bg: style.backgroundColor,
    text: button.textContent.replace(/\\s+/g, ''),
    textBox: { x: textBox.x, y: textBox.y, w: textBox.width, h: textBox.height },
    button: { x: box.x, y: box.y, w: box.width, h: box.height },
    icons,
    hit: center ? (center.id || center.tagName.toLowerCase()) : null,
    hitSelf: center === button || (!!center && button.contains(center)),
    otherPrimary: other.backgroundColor,
  }
}
window.__readExport = readExport
</script></body></html>`
}

const views = [
  { width: 1440, height: 960 },
  { width: 1180, height: 960 },
  { width: 1000, height: 960 },
]

async function measureExport() {
  const binary = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync)
  assert.ok(binary, 'Chrome is required to measure the export control')
  const dir = await mkdtemp(join(tmpdir(), 'export-contrast-'))
  const displayNumber = 80 + Math.floor(Math.random() * 40)
  const display = `:${displayNumber}`
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  const port = 9400 + Math.floor(Math.random() * 500)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  await waitForPath(`/tmp/.X11-unix/X${displayNumber}`)
  const chrome = spawn(binary, [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--ozone-platform=x11', '--hide-scrollbars',
    `--window-size=1440,960`, `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: display } })
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
    await client.send('DOM.enable')
    await client.send('CSS.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false })
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const shots = []
    for (const mode of ['figma', 'sketch']) {
      await client.send('Runtime.evaluate', { expression: `document.getElementById('shell').dataset.uiMode=${JSON.stringify(mode)}` })
      for (const view of views) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width: view.width, height: view.height, deviceScaleFactor: 1, mobile: false, screenWidth: view.width, screenHeight: view.height,
        })
        const reading = await readExport(client)
        const nodeId = await exportNode(client)
        const painted = await sampleButton(client, reading)
        await saveShot(painted.png, `${mode}-${view.width}`)
        const hover = await pseudo(client, nodeId, ['hover'])
        const active = await pseudo(client, nodeId, ['active'])
        await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] })
        shots.push(present(mode, view, reading, painted, hover, active))
      }
    }
    ws.close()
    return {
      environment: {
        browser: version.Browser,
        headed: true,
        headless: false,
        deviceScaleFactor: 1,
        protocol: version['Protocol-Version'],
      },
      shots,
    }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${chromeLog}`)
  } finally {
    chrome.kill('SIGKILL')
    xvfb.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
  }
}

function present(mode, view, reading, painted, hover, active) {
  const fill = hexFromCss(reading.bg)
  const ink = hexFromCss(reading.color)
  const visible = reading.icons.find((icon) => icon.display !== 'none' && icon.w > 0 && icon.h > 0)
  const hoverFill = hexFromCss(hover.bg)
  const activeFill = hexFromCss(active.bg)
  return {
    id: `${mode}-${view.width}`,
    mode,
    requestedWidth: view.width,
    requestedHeight: view.height,
    viewport: reading.viewport,
    density: reading.density,
    accent: normalizeHex(reading.accent),
    otherPrimary: hexFromCss(reading.otherPrimary),
    font: reading.font,
    text: reading.text,
    textBox: reading.textBox,
    button: reading.button,
    icons: reading.icons,
    visibleIcon: visible || null,
    iconColor: visible ? hexFromCss(visible.color) : null,
    iconContrast: visible ? contrast(hexFromCss(visible.color), fill) : 0,
    hit: reading.hit,
    hitSelf: reading.hitSelf,
    fill,
    ink,
    contrast: contrast(ink, fill),
    sampledFill: painted.fill,
    textInk: painted.textInk,
    hover: { fill: hoverFill, ink: hexFromCss(hover.color), contrast: contrast(hexFromCss(hover.color), hoverFill) },
    active: { fill: activeFill, ink: hexFromCss(active.color), contrast: contrast(hexFromCss(active.color), activeFill) },
  }
}

async function readExport(client) {
  const evaluated = await client.send('Runtime.evaluate', { expression: 'window.__readExport()', returnByValue: true })
  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
  return evaluated.result.value
}

async function exportNode(client) {
  const document = await client.send('DOM.getDocument', { depth: 1 })
  const found = await client.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#export' })
  assert.ok(found.nodeId)
  return found.nodeId
}

async function pseudo(client, nodeId, forcedPseudoClasses) {
  await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses })
  return readExport(client)
}

async function sampleButton(client, reading) {
  const box = reading.button
  const captured = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: Math.max(1, box.w), height: Math.max(1, box.h), scale: 1 },
  })
  const png = Buffer.from(captured.data, 'base64')
  const image = decodePng(png)
  const scaleX = image.width / box.w
  const scaleY = image.height / box.h
  const fillPixel = pixel(image, 3 * scaleX, (box.h / 2) * scaleY)
  assert.equal(fillPixel[3], 255, `export fill is translucent ${fillPixel.join(',')}`)
  const fill = hexFromChannels(fillPixel[0], fillPixel[1], fillPixel[2])
  let textInk = null
  if (reading.textBox.w >= 2 && reading.textBox.h >= 2) {
    const originX = (reading.textBox.x - box.x) * scaleX
    const originY = (reading.textBox.y - box.y) * scaleY
    const width = reading.textBox.w * scaleX
    const height = reading.textBox.h * scaleY
    let best = null
    for (let y = Math.max(0, Math.floor(originY)); y < Math.min(image.height, Math.ceil(originY + height)); y += 1) {
      for (let x = Math.max(0, Math.floor(originX)); x < Math.min(image.width, Math.ceil(originX + width)); x += 1) {
        const sample = pixel(image, x, y)
        if (sample[3] !== 255) continue
        const hex = hexFromChannels(sample[0], sample[1], sample[2])
        const ratio = contrast(hex, fill)
        if (!best || ratio > best.contrast) best = { hex, contrast: ratio }
      }
    }
    textInk = best
  }
  return { png, fill, textInk }
}

async function saveShot(png, name) {
  if (!shots) return
  const { mkdir } = await import('node:fs/promises')
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, `${name}.png`), png)
}

function pixel(image, x, y) {
  const ix = Math.min(image.width - 1, Math.max(0, Math.round(x)))
  const iy = Math.min(image.height - 1, Math.max(0, Math.round(y)))
  const offset = (iy * image.width + ix) * 4
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]]
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft
  const leftDistance = Math.abs(estimate - left)
  const upDistance = Math.abs(estimate - up)
  const upLeftDistance = Math.abs(estimate - upLeft)
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left
  return upDistance <= upLeftDistance ? up : upLeft
}

function decodePng(bytes) {
  const png = Buffer.from(bytes)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  assert.equal(bitDepth, 8)
  assert.equal(interlace, 0)
  assert.ok(colorType === 2 || colorType === 6, `png color type ${colorType}`)
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let source = 0
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]
    source += 1
    const row = raw.subarray(source, source + stride)
    source += stride
    const reconstructed = Buffer.alloc(stride)
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? reconstructed[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      let value = row[index]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += Math.floor((left + up) / 2)
      else if (filter === 4) value += paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`png filter ${filter}`)
      reconstructed[index] = value & 255
    }
    for (let x = 0; x < width; x += 1) {
      const index = x * channels
      const destination = (y * width + x) * 4
      out[destination] = reconstructed[index]
      out[destination + 1] = reconstructed[index + 1]
      out[destination + 2] = reconstructed[index + 2]
      out[destination + 3] = channels === 4 ? reconstructed[index + 3] : 255
    }
    previous = reconstructed
  }
  return { width, height, data: out }
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

async function waitForPath(file) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (existsSync(file)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`${file} did not appear`)
}
