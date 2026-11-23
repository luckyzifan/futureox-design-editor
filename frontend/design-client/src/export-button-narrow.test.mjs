// Issue #816. A narrow Figma window used to zero the Export label and leave the
// download glyph at display:none, so only the chevron remained. Chrome measures
// the production stylesheet at the reported sizes. Electron and macOS are not
// this process.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

const root = new URL('.', import.meta.url)
const shots = join(root.pathname, '../test-results/export-button-narrow')

test('the desk band reveals the download glyph that the wide rule hides', async () => {
  const css = await readFile(new URL('./styles.css', root), 'utf8')
  const app = await readFile(new URL('./App.tsx', root), 'utf8')
  assert.match(css, /\.editor-shell\[data-density="desk"\] \.header-right > \.primary \{ font-size: 0; padding: 6px; \}/)
  assert.match(css, /\.editor-shell \.header-right>\.primary>\.header-export-icon\{display:none\}/)
  assert.match(css, /\.editor-shell\[data-density="desk"\] \.header-right > \.primary > \.header-export-icon \{[^}]*display: block;/)
  assert.match(app, /className="header-export-icon"/)
  assert.match(app, /className="header-export-label"/)
  assert.match(app, /aria-label=\{locale === 'en' \? 'Export' : '导出'\}/)
})

test('narrow Chrome keeps a visible export glyph or label inside the header', { timeout: 180_000 }, async () => {
  const measured = await measure()
  console.log(measured.cases.map(item => `${item.id} font=${item.font} label=${item.labelBox.w.toFixed(1)} download=${item.download.display} ${item.download.w.toFixed(1)}×${item.download.h.toFixed(1)} button=${item.button.w.toFixed(1)}×${item.button.h.toFixed(1)} gap=${item.gap.toFixed(1)}`).join('\n'))
  assert.match(measured.browser, /Chrome\/\d+/)
  assert.equal(measured.electron, 'NOT_RUN')
  assert.equal(measured.macos, 'NOT_RUN')
  for (const item of measured.cases) {
    assert.equal(item.viewport.w, item.requested.w, item.id)
    assert.equal(item.viewport.h, item.requested.h, item.id)
    assert.equal(item.viewport.dpr, 1, item.id)
    assert.equal(item.name, item.locale === 'en' ? 'Export' : '导出', item.id)
    assert.equal(item.disabled, false, item.id)
    assert.equal(item.tabIndex, 0, item.id)
    assert.equal(item.fill, item.mode === 'figma' ? '#0768cf' : '#0063cc', item.id)
    assert.equal(item.hitCenter, true, `${item.id} center -> ${item.centerTag}`)
    assert.equal(item.hitCorners, true, `${item.id} corner clipped`)
    assert.ok(item.button.w >= 32 && item.button.h >= 32, `${item.id} hit ${item.button.w}×${item.button.h}`)
    assert.ok(contains(item.header, item.button), `${item.id} export left the header`)
    assert.ok(item.button.x >= -0.5 && item.button.y >= -0.5, item.id)
    assert.ok(item.button.x + item.button.w <= item.viewport.w + 0.5, `${item.id} export overflows`)
    assert.ok(item.button.y + item.button.h <= item.viewport.h + 0.5, item.id)
    assert.ok(item.headerRight.x + item.headerRight.w <= item.viewport.w + 0.5, `${item.id} header cluster overflows`)
    assert.equal(overlaps(item.button, item.layout), false, `${item.id} covers the layout switch`)
    assert.equal(overlaps(item.button, item.settings), false, `${item.id} covers settings`)
    assert.equal(overlaps(item.title, item.headerRight), false, `${item.id} title covers the cluster`)
    if (item.preview) assert.equal(overlaps(item.button, item.preview), false, `${item.id} covers prototype preview`)
    if (item.docked) assert.equal(overlaps(item.button, item.docked), false, `${item.id} covers the docked preview`)
    assert.notEqual(item.chevron.display, 'none', `${item.id} chevron ${item.chevron.display}`)
    assert.ok(item.chevron.w >= 10 && item.chevron.h >= 10, item.id)
    assert.ok(contains(item.button, item.chevron), `${item.id} chevron clipped`)
    assert.equal(item.hitChevron, true, item.id)
    if (item.expect === 'icon') {
      assert.equal(item.font, '0px', item.id)
      assert.equal(item.labelDisplay, 'none', item.id)
      assert.ok(item.labelBox.w < 1, `${item.id} label still occupies ${item.labelBox.w}`)
      assert.equal(item.download.display, 'block', `${item.id} download ${item.download.display}`)
      assert.ok(item.download.w >= 12 && item.download.h >= 12, `${item.id} download ${item.download.w}×${item.download.h}`)
      assert.ok(contains(item.button, item.download), `${item.id} download clipped`)
      assert.ok(item.gap >= 4 && item.gap <= 10, `${item.id} icon gap ${item.gap}`)
      assert.equal(item.hitDownload, true, item.id)
      assert.equal(overlaps(item.download, item.chevron), false, `${item.id} icons overlap`)
      assert.ok(item.iconInk >= 3, `${item.id} download glyph was not painted (${item.iconInk})`)
    } else {
      assert.equal(item.font, '12px', item.id)
      assert.notEqual(item.labelDisplay, 'none', item.id)
      assert.ok(item.labelBox.w >= 12, `${item.id} label ${item.labelBox.w}`)
      assert.equal(item.download.display, 'none', `${item.id} wide icon returned`)
      assert.ok(contains(item.button, item.labelBox), `${item.id} label clipped`)
      assert.ok(item.textInk >= 3, `${item.id} label was not painted (${item.textInk})`)
    }
  }
  assert.equal(measured.clicks, 2, 'Enter and Space did not both activate the narrow export button')
})

const cases = [
  { id: 'figma-1000x640-zh-inset', w: 1000, h: 640, mode: 'figma', locale: 'zh', inset: true, headerPreview: true, dockedPreview: false, expect: 'icon', keys: true },
  { id: 'figma-1000x640-zh-docked', w: 1000, h: 640, mode: 'figma', locale: 'zh', inset: false, headerPreview: false, dockedPreview: true, expect: 'icon' },
  { id: 'figma-1024x720-zh', w: 1024, h: 720, mode: 'figma', locale: 'zh', inset: false, headerPreview: true, dockedPreview: true, expect: 'icon' },
  { id: 'figma-1200x750-zh', w: 1200, h: 750, mode: 'figma', locale: 'zh', inset: false, headerPreview: true, dockedPreview: true, expect: 'label' },
  { id: 'figma-1200x750-en', w: 1200, h: 750, mode: 'figma', locale: 'en', inset: true, headerPreview: true, dockedPreview: false, expect: 'label' },
  { id: 'figma-1000x640-en-inset', w: 1000, h: 640, mode: 'figma', locale: 'en', inset: true, headerPreview: true, dockedPreview: true, expect: 'icon' },
  { id: 'figma-1000-stale-wide', w: 1000, h: 640, mode: 'figma', locale: 'zh', inset: true, headerPreview: true, dockedPreview: false, density: 'wide', expect: 'icon' },
  { id: 'figma-1180', w: 1180, h: 720, mode: 'figma', locale: 'zh', inset: false, headerPreview: true, dockedPreview: false, expect: 'icon' },
  { id: 'figma-1181', w: 1181, h: 750, mode: 'figma', locale: 'zh', inset: false, headerPreview: true, dockedPreview: false, expect: 'label' },
  { id: 'sketch-1000x640', w: 1000, h: 640, mode: 'sketch', locale: 'zh', inset: false, headerPreview: true, dockedPreview: false, expect: 'icon' },
  { id: 'sketch-1200x750', w: 1200, h: 750, mode: 'sketch', locale: 'zh', inset: false, headerPreview: true, dockedPreview: false, expect: 'label' },
]

function contains(parent, child) {
  return child.x >= parent.x - 0.5 && child.y >= parent.y - 0.5
    && child.x + child.w <= parent.x + parent.w + 0.5
    && child.y + child.h <= parent.y + parent.h + 0.5
}
function overlaps(a, b) {
  return a.x + 0.5 < b.x + b.w && a.x + a.w > b.x + 0.5 && a.y + 0.5 < b.y + b.h && a.y + a.h > b.y + 0.5
}

function probeHtml() {
  const href = (name) => pathToFileURL(join(root.pathname, name)).href
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${href('styles.css')}">
<link rel="stylesheet" href="${href('chrome-polish.css')}">
<style>html,body,#shell{height:100%;width:100%}*,*::before,*::after{animation:none!important;transition:none!important}</style>
</head><body>
<div class="app-shell editor-shell" id="shell" data-ui-mode="figma" data-density="wide" style="--workspace-inspector-width:241px;--workspace-layers-width:240px">
  <header class="editor-header" id="header">
    <div class="document-title" id="title">
      <button type="button" class="brand" aria-label="文件菜单"></button>
      <button type="button" class="document-location">本地设计</button>
      <input aria-label="文档名称" value="未命名设计">
      <button type="button" aria-label="收起界面"></button>
    </div>
    <div class="header-right" id="header-right">
      <details class="workspace-actions"><summary aria-label="更多操作"></summary></details>
      <span class="save-status" role="status"><span class="save-status-label" id="save">已保存</span></span>
      <div class="local-window-control"><button type="button" aria-label="本机窗口"><span>1</span></button></div>
      <div class="ui-mode-switch" id="layout" role="group" aria-label="界面布局">
        <button type="button" aria-pressed="true">Figma</button>
        <button type="button">Sketch</button>
      </div>
      <label class="locale-switch"><select aria-label="语言"><option>中文</option></select></label>
      <button type="button" class="design-agent-toggle" aria-label="设计助手"><svg width="16" height="16"></svg><span id="agent">设计助手</span></button>
      <button type="button" class="prototype-preview-button" id="preview" aria-label="预览原型"><svg width="16" height="16"></svg><span>预览</span></button>
      <button type="button" class="primary" id="export" aria-label="导出">
        <svg class="header-export-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
        <span class="header-export-label" id="label">导出</span>
        <svg id="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <button type="button" class="app-settings-button" id="settings" aria-label="设置"><svg width="16" height="16"></svg><span id="settings-label">设置</span></button>
    </div>
  </header>
  <div class="properties-workspace" id="inspector">
    <div class="figma-properties-actions"><button type="button" class="prototype-preview-button" id="docked" aria-label="预览原型"><svg width="16" height="16"></svg><span>预览</span></button></div>
  </div>
</div>
<script>
let clicks = 0
document.getElementById('export').addEventListener('click', () => { clicks += 1 })
function boxOf(element) {
  if (!element || element.style.display === 'none') return null
  const rect = element.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
  return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
}
function hit(x, y, root) {
  const element = document.elementFromPoint(x, y)
  return { ok: !!element && (element === root || root.contains(element)), tag: element ? (element.id || element.tagName.toLowerCase()) : null }
}
function readExport(config) {
  const shell = document.getElementById('shell')
  shell.dataset.uiMode = config.mode
  shell.dataset.windowControls = config.inset ? 'inset' : ''
  const wide = matchMedia('(min-width: 1181px)').matches
  const narrow = matchMedia('(max-width: 900px)').matches
  shell.dataset.density = config.density || (narrow ? 'narrow' : wide ? 'wide' : 'desk')
  const zh = config.locale !== 'en'
  const button = document.getElementById('export')
  const name = zh ? '导出' : 'Export'
  button.setAttribute('aria-label', name)
  document.getElementById('label').textContent = name
  document.getElementById('settings-label').textContent = zh ? '设置' : 'Settings'
  document.getElementById('settings').setAttribute('aria-label', zh ? '打开设置' : 'Open settings')
  document.getElementById('agent').textContent = zh ? '设计助手' : 'Design agent'
  document.getElementById('save').textContent = zh ? '已保存' : 'Saved'
  document.getElementById('preview').style.display = config.headerPreview ? '' : 'none'
  document.getElementById('docked').style.display = config.dockedPreview ? '' : 'none'
  const style = getComputedStyle(button)
  const label = document.getElementById('label')
  const labelStyle = getComputedStyle(label)
  const download = button.querySelector('.header-export-icon')
  const chevron = document.getElementById('chevron')
  const downloadStyle = getComputedStyle(download)
  const chevronStyle = getComputedStyle(chevron)
  const buttonBox = boxOf(button)
  const downloadBox = boxOf(download)
  const chevronBox = boxOf(chevron)
  const labelBox = boxOf(label)
  const corners = [[buttonBox.w / 2, 2], [buttonBox.w / 2, buttonBox.h - 3], [2, buttonBox.h / 2], [buttonBox.w - 3, buttonBox.h / 2]]
  return {
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    density: shell.dataset.density,
    font: style.fontSize,
    name: button.getAttribute('aria-label'),
    disabled: button.disabled,
    tabIndex: button.tabIndex,
    fill: style.backgroundColor,
    labelDisplay: labelStyle.display,
    labelText: label.textContent,
    button: buttonBox,
    download: { display: downloadStyle.display, ...downloadBox },
    chevron: { display: chevronStyle.display, ...chevronBox },
    labelBox,
    header: boxOf(document.getElementById('header')),
    headerRight: boxOf(document.getElementById('header-right')),
    title: boxOf(document.getElementById('title')),
    layout: boxOf(document.getElementById('layout')),
    settings: boxOf(document.getElementById('settings')),
    preview: boxOf(document.getElementById('preview')),
    docked: boxOf(document.getElementById('docked')),
    gap: chevronBox.x - (downloadBox.x + downloadBox.w),
    hitCenter: hit(buttonBox.x + buttonBox.w / 2, buttonBox.y + buttonBox.h / 2, button).ok,
    centerTag: hit(buttonBox.x + buttonBox.w / 2, buttonBox.y + buttonBox.h / 2, button).tag,
    hitCorners: corners.every(([x, y]) => hit(buttonBox.x + x, buttonBox.y + y, button).ok),
    hitDownload: downloadStyle.display === 'none' ? false : hit(downloadBox.x + downloadBox.w / 2, downloadBox.y + downloadBox.h / 2, button).ok,
    hitChevron: hit(chevronBox.x + chevronBox.w / 2, chevronBox.y + chevronBox.h / 2, button).ok,
    clicks,
  }
}
window.__readExport = readExport
window.__clicks = () => clicks
</script></body></html>`
}

function hexByte(value) { return Math.round(value).toString(16).padStart(2, '0') }
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
function hex(red, green, blue) { return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}` }
function hexFromCss(color) {
  const match = color.replace(/\s/g, '').match(/^rgba?\((\d+),(\d+),(\d+)/i)
  assert.ok(match, color)
  return hex(Number(match[1]), Number(match[2]), Number(match[3]))
}

async function measure() {
  const binary = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync)
  assert.ok(binary, 'Chrome is required')
  const dir = await mkdtemp(join(tmpdir(), 'export-narrow-'))
  const displayNumber = 140 + Math.floor(Math.random() * 40)
  const display = `:${displayNumber}`
  const xvfb = process.platform === 'linux' ? spawn('Xvfb', [display, '-screen', '0', '1600x1200x24', '-nolisten', 'tcp'], { stdio: 'ignore' }) : undefined
  const port = 9600 + Math.floor(Math.random() * 300)
  const file = join(dir, 'probe.html')
  await writeFile(file, probeHtml())
  if (xvfb) await waitForPath(`/tmp/.X11-unix/X${displayNumber}`)
  const chrome = spawn(binary, [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', ...(xvfb ? ['--ozone-platform=x11'] : ['--headless=new']), '--hide-scrollbars',
    '--window-size=1200,750', `--user-data-dir=${join(dir, 'profile')}`, `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...(xvfb ? { DISPLAY: display } : {}) } })
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
    await client.send('Runtime.enable')
    const loaded = client.wait('Page.loadEventFired')
    await client.send('Page.navigate', { url: pathToFileURL(file).href })
    await loaded
    const results = []
    for (const item of cases) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width: item.w, height: item.h, deviceScaleFactor: 1, mobile: false, screenWidth: item.w, screenHeight: item.h,
      })
      const reading = await evaluate(client, `window.__readExport(${JSON.stringify(item)})`)
      const painted = await paint(client, reading)
      if (['figma-1000x640-zh-inset', 'figma-1024x720-zh', 'figma-1200x750-zh'].includes(item.id)) {
        await mkdir(shots, { recursive: true })
        const headerShot = await client.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: item.w, height: Math.max(48, Math.ceil(reading.header.h + 8)), scale: 1 },
        })
        await writeFile(join(shots, `${item.id}.png`), Buffer.from(headerShot.data, 'base64'))
        await writeFile(join(shots, `${item.id}-button.png`), painted.png)
      }
      if (item.keys) {
        await evaluate(client, `document.getElementById('export').focus()`)
        await key(client, 'Enter', 13, '\r')
        await key(client, ' ', 32, ' ')
      }
      results.push({ ...item, requested: { w: item.w, h: item.h }, ...reading, ...painted, fill: hexFromCss(reading.fill) })
    }
    const clicks = await evaluate(client, 'window.__clicks()')
    ws.close()
    return { browser: version.Browser, electron: 'NOT_RUN', macos: 'NOT_RUN', clicks, cases: results }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${chromeLog}`)
  } finally {
    chrome.kill('SIGKILL')
    xvfb?.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 150))
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {})
  }
}

async function paint(client, reading) {
  const box = reading.button
  const captured = await client.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: box.x, y: box.y, width: Math.max(1, box.w), height: Math.max(1, box.h), scale: 1 },
  })
  const png = Buffer.from(captured.data, 'base64')
  const image = decodePng(png)
  const scaleX = image.width / box.w
  const scaleY = image.height / box.h
  const fillPixel = pixel(image, 2 * scaleX, (box.h / 2) * scaleY)
  const fill = hex(fillPixel[0], fillPixel[1], fillPixel[2])
  const best = (region) => {
    if (!region || region.w < 1 || region.h < 1) return 0
    const originX = (region.x - box.x) * scaleX
    const originY = (region.y - box.y) * scaleY
    let score = 0
    for (let y = Math.max(0, Math.floor(originY)); y < Math.min(image.height, Math.ceil(originY + region.h * scaleY)); y += 1) {
      for (let x = Math.max(0, Math.floor(originX)); x < Math.min(image.width, Math.ceil(originX + region.w * scaleX)); x += 1) {
        const sample = pixel(image, x, y)
        if (sample[3] !== 255) continue
        score = Math.max(score, contrast(hex(sample[0], sample[1], sample[2]), fill))
      }
    }
    return score
  }
  return { png, iconInk: best(reading.download), textInk: best(reading.labelBox) }
}

async function key(client, keyName, code, text) {
  const name = keyName === ' ' ? 'Space' : 'Enter'
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code: name, text, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code })
}
async function evaluate(client, expression) {
  const evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
  return evaluated.result.value
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
  let offset = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
  }
  assert.equal(bitDepth, 8)
  assert.equal(interlace, 0)
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let source = 0, previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]; source += 1
    const row = raw.subarray(source, source + stride); source += stride
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
      const index = x * channels, destination = (y * width + x) * 4
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
