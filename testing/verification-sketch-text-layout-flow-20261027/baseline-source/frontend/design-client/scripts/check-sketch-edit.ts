// Owned Electron journey: real 117 archive, UI-only writes, SQLite read oracle.
// Do not run concurrently with GPU benchmarks. All profiles and evidence are private.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { inflateSync } from 'node:zlib'
import { chromium, _electron, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'
import type { DesignDocument, DesignNode } from '../src/model'

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, app: { type: 'string' }, output: { type: 'string' },
  web: { type: 'boolean' },
} })
assert.ok(values.fixture && path.isAbsolute(values.fixture), '--fixture requires an absolute private Sketch file')
assert.match(values.fixture, /\.sketch$/i)
assert.ok(!values.app || path.isAbsolute(values.app), '--app requires an absolute Electron executable')
assert.ok(!(values.web && values.app), '--web cannot use a native --app')
assert.ok(!values.output || path.isAbsolute(values.output), '--output requires an absolute new evidence directory')
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.resolve(client, '../design-desktop')
const fixture = values.fixture
const output = values.output || await mkdtemp(path.join(tmpdir(), 'futureox-sketch-edit-'))
if (values.output) { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output) }
const profiles = path.join(output, 'profiles'); await mkdir(profiles)
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const sourceHash = digest(await readFile(fixture)), errors: string[] = []
const report: Record<string, unknown> = {
  status: 'running', startedAt: new Date().toISOString(), fixture: path.basename(fixture), fixtureHash: sourceHash,
  checks: [] as unknown[], pageErrors: errors,
  mode: values.web ? 'web' : 'electron',
  scope: `${values.web ? 'Real Chromium/Vite/IndexedDB' : 'Real native Electron/sidecar/SQLite'}/Worker/WASM; UI-only document mutations; isolated profile`,
}
const checks = report.checks as unknown[]
const checked = (name: string, details: Record<string, unknown> = {}) => {
  checks.push({ name, ...details }); console.log(`SKETCH_EDIT ${name}`)
}
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
let page: Page | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let server: Awaited<ReturnType<typeof createServer>> | undefined
let typographyEngine: import('../src/generated/design-kernel/design_kernel').VectorEngine | undefined

// Playwright screenshots are 8-bit non-interlaced RGB/RGBA PNGs. Decode only
// this bounded format so the outline check examines captured display pixels,
// not an SVG attribute or a second rendering of the authored scene.
function screenshotPixels(png: Buffer) {
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  let width = 0, height = 0, channels = 0
  const chunks: Buffer[] = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), kind = png.subarray(at + 4, at + 8).toString()
    const bytes = png.subarray(at + 8, at + 8 + length)
    if (kind === 'IHDR') {
      width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4)
      assert.equal(bytes[8], 8); assert.ok(bytes[9] === 2 || bytes[9] === 6); assert.equal(bytes[12], 0)
      channels = bytes[9] === 6 ? 4 : 3
    }
    if (kind === 'IDAT') chunks.push(bytes)
    at += length + 12
  }
  assert.ok(width > 0 && height > 0 && width * height < 40_000_000)
  const scan = inflateSync(Buffer.concat(chunks)), stride = width * channels
  assert.equal(scan.length, height * (stride + 1))
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = scan[y * (stride + 1)]
    assert.ok(filter <= 4)
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, a = x >= channels ? pixels[at - channels] : 0,
        b = y ? pixels[at - stride] : 0, c = y && x >= channels ? pixels[at - stride - channels] : 0
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      pixels[at] = (scan[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  return { width, height, channels, pixels }
}

try {
  if (!values.web) {
  const requireDesktop = createRequire(path.join(desktop, 'package.json'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
  application = await _electron.launch({ executablePath: values.app || requireDesktop('electron'),
    args: [...(values.app ? [] : [desktop]), '--desktop-gui-test'],
    env: { ...env, TMPDIR: profiles }, chromiumSandbox: true, timeout: 45_000 })
  page = await application.firstWindow({ timeout: 45_000 })
  report.host = await application.evaluate(({ app, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents as unknown as {
      getLastWebPreferences(): { sandbox: boolean; contextIsolation: boolean; webSecurity: boolean; nodeIntegration: boolean }
    }
    const p = contents.getLastWebPreferences()
    return { packaged: app.isPackaged, profile: app.getPath('userData'), sandbox: p.sandbox,
      contextIsolation: p.contextIsolation, webSecurity: p.webSecurity, nodeIntegration: p.nodeIntegration }
  })
  const host = report.host as { profile: string; sandbox: boolean; contextIsolation: boolean; webSecurity: boolean; nodeIntegration: boolean }
  assert.ok(host.sandbox && host.contextIsolation && host.webSecurity && !host.nodeIntegration)
  assert.ok(host.profile.startsWith(await import('node:fs/promises').then(fs => fs.realpath(profiles))))
  } else {
    server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
    page = await browser.newPage({ viewport: { width: 1440, height: 908 }, deviceScaleFactor: 2 })
    await page.goto(server.resolvedUrls!.local[0])
    report.host = { sandboxRequested: true, isolatedBrowser: true, persistence: 'actual IndexedDB' }
  }
  const current = page!
  current.on('pageerror', error => errors.push(String(error)))
  current.setDefaultTimeout(30_000)
  const name = path.basename(fixture).replace(/\.sketch$/i, '')
  const canvas = current.getByTestId('canvas'), presentation = current.locator('.kernel-presentation')
  const read = async (): Promise<DesignDocument> => {
    // An oracle read must not race the user's automatic save. The native host
    // serializes recovery/file operations and can briefly report BUSY even
    // after the SQLite commit is acknowledged. Retry only this read operation.
    await expect(current.locator('.save-status')).toHaveText('已保存到本机', { timeout: 60_000 })
    return current.evaluate(async ({ name, web }) => {
    if (web) {
      const modulePath = '/src/local-store.ts'
      const { localOpen } = await import(modulePath)
      const opened = await localOpen()
      const activeId = document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.requestedDocument
      if (!opened || opened.document.name !== name || opened.document.id !== activeId) throw Error('Active IndexedDB document is not durable yet')
      return opened.document
    }
    const workspace = window.coreDesktop?.workspace
    if (!workspace) throw Error('Missing actual native SQLite workspace')
    const list = await workspace.list()
    if (list.status !== 'ok') throw Error('Native list failed')
    const activeId = document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.requestedDocument
    const entry = list.documents.find(item => item.id === activeId && item.name === name && !item.deleted)
    if (!entry) throw Error('Native imported document is not durable yet')
    for (let attempt = 0; attempt < 40; attempt++) {
      const opened = await workspace.open({ id: entry.id })
      if (opened.status === 'ok') return JSON.parse(opened.documentJson)
      if (opened.status !== 'error' || opened.code !== 'BUSY')
        throw Error(`Native read failed: ${opened.status === 'error' ? opened.code : opened.status}`)
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw Error('Native read stayed BUSY after its bounded read-only retry budget')
  }, { name, web: !!values.web })
  }
  const exact = async () => {
    const started = performance.now()
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'true', { timeout: 150_000 })
    await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
    await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
    assert.deepEqual(await current.locator('.kernel-status.error').allTextContents(), [])
    return performance.now() - started
  }
  const nodeFields = (node: DesignNode) => ({ id: node.id, name: node.name, kind: node.kind,
    transform: node.transform, width: node.width, height: node.height, text: node.text,
    fontSize: node.fontSize, textStyle: node.textStyle, textRuns: node.textRuns,
    fills: node.fills, locked: node.locked, visible: node.visible, children: node.children })
  const authoredHash = (doc: DesignDocument) => digest(JSON.stringify({ nodes: doc.nodes, pages: doc.pages }))
  const rasterHashes = () => current.locator('.kernel-tiles canvas[data-lod=exact][data-frame-visible=true]').evaluateAll(async elements => {
    const rows = await Promise.all(elements.map(async element => {
      const canvas = element as HTMLCanvasElement, context = canvas.getContext('2d')
      if (!context) throw Error('Expected an actual SDR display tile, not a synthetic raster')
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      const sha = await crypto.subtle.digest('SHA-256', pixels)
      return { x: Number(canvas.dataset.tileX), y: Number(canvas.dataset.tileY),
        zoom: Number(canvas.dataset.tileZoom), phaseX: Number(canvas.dataset.tilePhaseX), phaseY: Number(canvas.dataset.tilePhaseY),
        width: canvas.width, height: canvas.height,
        hash: [...new Uint8Array(sha)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
    }))
    if (!rows.length) throw Error('No visible exact display tiles')
    return rows.sort((a, b) => a.y - b.y || a.x - b.x)
  })
  const geometry = () => current.getByTestId('canvas-selection-outline').evaluate(element => {
    const polygon = element as SVGPolygonElement, matrix = polygon.getScreenCTM()
    if (!matrix) throw Error('Selection has no screen transform')
    const points = [...polygon.points].map(point => new DOMPoint(point.x, point.y).matrixTransform(matrix))
      .map(point => ({ x: point.x, y: point.y }))
    const rect = polygon.getBoundingClientRect(), host = document.querySelector('[data-testid=canvas]')!.getBoundingClientRect()
    return { points, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      host: { x: host.x, y: host.y, width: host.width, height: host.height },
      visible: getComputedStyle(polygon).visibility, stroke: getComputedStyle(polygon).stroke,
      stageZ: getComputedStyle(polygon.closest('svg')!).zIndex,
      tileZ: getComputedStyle(document.querySelector('.kernel-tiles')!).zIndex }
  })
  const selectionPixels = async (label: string, expectedColor?: [number, number, number]) => {
    const position = await geometry()
    assert.equal(position.visible, 'visible')
    const png = await current.screenshot({ path: path.join(output, `${String(checks.length).padStart(2, '0')}-${label}.png`) })
    const pixels = screenshotPixels(png), viewport = await current.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const sx = pixels.width / viewport.width, sy = pixels.height / viewport.height
    let sampled = 0, blue = 0
    for (let edge = 0; edge < position.points.length; edge++) {
      const a = position.points[edge], b = position.points[(edge + 1) % position.points.length]
      const length = Math.hypot(b.x - a.x, b.y - a.y), steps = Math.max(1, Math.ceil(length / 3))
      for (let i = 0; i <= steps; i++) {
        // The real corner handles have white interiors. Exclude their six CSS
        // pixel neighborhoods rather than treating expected handles as occlusion.
        if (length * i / steps < 6 || length * (steps - i) / steps < 6) continue
        const x = a.x + (b.x - a.x) * i / steps, y = a.y + (b.y - a.y) * i / steps
        if (x < position.host.x + 3 || y < position.host.y + 3 || x > position.host.x + position.host.width - 3 || y > position.host.y + position.host.height - 3) continue
        sampled++
        let found = false
        for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) {
          const px = Math.round(x * sx) + dx, py = Math.round(y * sy) + dy
          if (px < 0 || py < 0 || px >= pixels.width || py >= pixels.height) continue
          const at = (py * pixels.width + px) * pixels.channels, r = pixels.pixels[at], g = pixels.pixels[at + 1], b = pixels.pixels[at + 2]
          if (r < 70 && g > 90 && g < 205 && b > 215 && b - g > 35) { found = true; break }
        }
        if (found) blue++
      }
    }
    assert.ok(sampled >= 8 && blue / sampled > .65, `Actual selection outline is missing/covered: ${blue}/${sampled}`)
    let textColorPixels = 0
    if (expectedColor) {
      const rect = position.bounds
      const left = Math.max(0, Math.ceil((rect.x + 2) * sx)), top = Math.max(0, Math.ceil((rect.y + 2) * sy))
      const right = Math.min(pixels.width, Math.floor((rect.x + rect.width - 2) * sx))
      const bottom = Math.min(pixels.height, Math.floor((rect.y + rect.height - 2) * sy))
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const at = (y * pixels.width + x) * pixels.channels
        if (expectedColor.every((channel, i) => Math.abs(pixels.pixels[at + i] - channel) <= 25)) textColorPixels++
      }
      assert.ok(textColorPixels >= 4, `The changed text fill is absent from actual display pixels: ${textColorPixels}`)
    }
    return { ...position, blueSamples: blue, edgeSamples: sampled, textColorPixels: expectedColor ? textColorPixels : undefined, screenshotHash: digest(png) }
  }
  const select = async (id: string, label: string) => {
    const doc = await read(), target = doc.nodes[id]
    assert.ok(target)
    await current.getByLabel('搜索图层', { exact: true }).fill(target.name)
    const row = current.getByTestId(`layer-${id}`)
    await row.scrollIntoViewIfNeeded()
    const readyAtClick = await presentation.getAttribute('data-presentation-ready')
    const started = performance.now()
    await row.click()
    await expect(row).toHaveAttribute('aria-selected', 'true')
    await expect(current.locator('.inspector[data-node-id]')).toHaveAttribute('data-node-id', id)
    await expect(current.getByTestId('canvas-selection-outline')).toBeVisible()
    await expect.poll(async () => {
      const { bounds: rect, host } = await geometry()
      return rect.x < host.x + host.width && rect.y < host.y + host.height && rect.x + rect.width > host.x && rect.y + rect.height > host.y
    }, { timeout: 3_000 }).toBe(true)
    const latency = performance.now() - started
    const visual = await selectionPixels(label)
    const rect = visual.bounds, host = visual.host
    assert.ok(rect.x < host.x + host.width && rect.y < host.y + host.height && rect.x + rect.width > host.x && rect.y + rect.height > host.y,
      'A tree selection must pan the target into the actual canvas')
    checked(label, { selected: nodeFields(target), readyAtClick, firstOutlineMs: latency, visual, exactWaitMs: await exact() })
    return row
  }
  const edit = async (label: string, id: string, action: () => Promise<unknown>, matches: (node: DesignNode) => boolean, expectedColor?: [number, number, number]) => {
    const before = await read()
    const previousRevision = await current.locator('.kernel-tiles').getAttribute('data-requested-revision')
    const started = performance.now()
    await action()
    const visualCompletion = (async () => {
      await expect(current.locator('.kernel-tiles')).not.toHaveAttribute('data-requested-revision', previousRevision!, { timeout: 60_000 })
      await exact()
      return { ms: performance.now() - started }
    })().catch(error => ({ error: String(error) }))
    await expect.poll(async () => matches((await read()).nodes[id]), { timeout: 60_000 }).toBe(true)
    const changed = await read()
    assert.notEqual(authoredHash(changed), authoredHash(before), 'The UI command must actually edit the durable document')
    const documentMs = performance.now() - started, completed = await visualCompletion
    if ('error' in completed) throw Error(completed.error)
    const exactWaitMs = await exact()
    const visual = await selectionPixels(label, expectedColor)
    checked(label, { before: nodeFields(before.nodes[id]), after: nodeFields(changed.nodes[id]), documentMs,
      exactAfterEditMs: completed.ms, exactWaitAfterPersistenceMs: exactWaitMs, visual })
    await canvas.focus(); await current.keyboard.press('Meta+z')
    await expect.poll(async () => isDeepStrictEqual((await read()).nodes, before.nodes), { timeout: 60_000 }).toBe(true)
    assert.ok(isDeepStrictEqual((await read()).pages, before.pages), 'Undo must restore page ancestry too')
    await current.keyboard.press('Meta+Shift+z')
    await expect.poll(async () => isDeepStrictEqual((await read()).nodes, changed.nodes), { timeout: 60_000 }).toBe(true)
    assert.ok(isDeepStrictEqual((await read()).pages, changed.pages), 'Redo must restore page ancestry too')
    checked(`${label}: exact authored Undo/Redo`, { beforeHash: authoredHash(before), afterHash: authoredHash(changed) })
    await exact()
    return changed
  }
  await expect(current.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  const importedAt = performance.now()
  await current.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name, { timeout: 60_000 })
  await expect(current.getByRole('complementary', { name: '导入兼容提示' })).toBeVisible({ timeout: 60_000 })
  await current.getByRole('button', { name: '关闭导入提示' }).click()
  await expect.poll(async () => { try { return Object.keys((await read()).nodes).length } catch { return 0 } }, { timeout: 60_000 }).toBe(752)
  const imported = await read()
  assert.equal(Object.values(imported.nodes).filter(node => node.kind === 'text').length, 106)
  const importedExact = await exact()
  checked('real 117 archive imports all 752 nodes and 106 text layers', { importToExactMs: performance.now() - importedAt, finalExactWaitMs: importedExact, sourceHash })
  const codec = await import('../src/generated/design-kernel/design_kernel.js')
  const wasmBytes = new Uint8Array(await readFile(path.join(client, 'public/kernel/design_kernel_bg.wasm')))
  await codec.default({ module_or_path: wasmBytes })
  typographyEngine = new codec.VectorEngine()
  const fontBytes = new Uint8Array(await readFile(path.join(client, 'public/fonts/NotoSansSC.ttf')))
  typographyEngine.load_font(fontBytes)
  typographyEngine.load_document_fonts(JSON.stringify(imported.fonts || {}))
  report.typographyOracleWasmHash = digest(wasmBytes)
  report.typographyOracleDefaultFontHash = digest(fontBytes)
  const runtimeAssets = await current.evaluate(async () => {
    const hash = async (pathname: string) => {
      const response = await fetch(new URL(pathname, location.href))
      if (!response.ok) throw Error(`Runtime asset read failed: ${pathname}`)
      const bytes = await response.arrayBuffer(), sha = await crypto.subtle.digest('SHA-256', bytes)
      return [...new Uint8Array(sha)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }
    return { wasmHash: await hash('/kernel/design_kernel_bg.wasm'), fontHash: await hash('/fonts/NotoSansSC.ttf'),
      dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } }
  })
  assert.equal(runtimeAssets.wasmHash, report.typographyOracleWasmHash, 'Typography oracle must use the running app shared-kernel artifact')
  assert.equal(runtimeAssets.fontHash, report.typographyOracleDefaultFontHash, 'Typography oracle must use the running app font artifact')
  report.runtimeAssets = runtimeAssets
  const text = Object.values(imported.nodes).find(node => node.kind === 'text' && node.text === '温度')
    || Object.values(imported.nodes).find(node => node.kind === 'text' && node.fontSize >= 28 && node.text.trim())
  const group = Object.values(imported.nodes).find(node => node.kind === 'group' && node.name === '组合 23')
    || Object.values(imported.nodes).find(node => node.kind === 'group' && node.name.replace(/\s/g, '') === '组合23')
  assert.ok(text && group, '117 needs a visible text target and the source chart group 23')
  report.targets = { text: nodeFields(text), group: nodeFields(group) }
  await select(text.id, 'tree-text-visible-outline')
  await edit('text-content', text.id, async () => {
    const input = current.getByLabel('文字内容', { exact: true })
    await input.fill(`${text.text} 26`); await input.press('Tab')
  }, node => node.text === `${text.text} 26`)
  const currentText = (await read()).nodes[text.id]
  const displayedFont = Number(await current.getByLabel('字号', { exact: true }).inputValue())
  const nextDisplayedFont = displayedFont + 6, nextFont = currentText.fontSize * nextDisplayedFont / displayedFont
  const beforeTypography = JSON.parse(typographyEngine.text_layout(JSON.stringify(currentText)))
  await edit('text-size', text.id, async () => {
    const input = current.getByLabel('字号', { exact: true }); await input.fill(String(nextDisplayedFont)); await input.press('Enter')
  }, node => node.fontSize !== currentText.fontSize)
  assert.ok(Math.abs((await read()).nodes[text.id].fontSize - nextFont) < 1e-9)
  const afterTypography = JSON.parse(typographyEngine.text_layout(JSON.stringify((await read()).nodes[text.id])))
  checked('text-size: actual shaped glyphs', { beforeBounds: beforeTypography.bounds, afterBounds: afterTypography.bounds,
    beforeSizes: [...new Set(beforeTypography.glyphs.map((glyph: { size: number }) => glyph.size))],
    afterSizes: [...new Set(afterTypography.glyphs.map((glyph: { size: number }) => glyph.size))] })
  assert.ok(afterTypography.glyphs.length > 0 && afterTypography.glyphs.every((glyph: { size: number }) => Math.abs(glyph.size - nextFont) < 1e-9),
    'Real shared-kernel shaped glyphs must use the edited size; line-height or baseline changes alone do not prove it')
  assert.ok((await read()).nodes[text.id].textRuns?.every(run => run.fontSize === undefined || run.fontSize === nextFont) ?? true,
    'A whole-layer font size change must reach every imported run')
  await edit('text-color', text.id, async () => {
    const color = current.locator('.inspector input[aria-label="颜色"]').first()
    await color.fill('#ff3366')
    if (await color.getAttribute('type') !== 'color') await color.press('Enter')
  }, node => node.fills.some(fill => fill.color.toLowerCase() === '#ff3366'), [255, 51, 102])
  await current.getByLabel('缩放与视图设置', { exact: true }).click()
  await current.getByRole('button', { name: '100%', exact: true }).click()
  // Select an initially off-screen chart while the new zoom is refining.
  // Its outline/reveal must work before waiting for a new exact raster.
  await select(group.id, 'tree-chart-after-zoom-visible-outline')
  await edit('chart-pointer-move', group.id, async () => {
    const bounds = (await geometry()).bounds
    const x = bounds.x + bounds.width * .6, y = bounds.y + bounds.height * .4
    await current.mouse.move(x, y); await current.mouse.down()
    await expect(canvas).toHaveAttribute('data-transform-gesture', 'move')
    await current.mouse.move(x + 44, y + 26, { steps: 12 }); await current.mouse.up()
  }, node => node.transform[4] !== group.transform[4] || node.transform[5] !== group.transform[5])
  const beforeCopy = await read()
  await canvas.focus(); await current.keyboard.press('Meta+d')
  const descendants = (doc: DesignDocument, id: string): number => 1 + doc.nodes[id].children.reduce((sum, child) => sum + descendants(doc, child), 0)
  await expect.poll(async () => Object.keys((await read()).nodes).length, { timeout: 60_000 }).toBe(752 + descendants(beforeCopy, group.id))
  const copied = await read(), copyId = await current.locator('.inspector[data-node-id]').getAttribute('data-node-id')
  assert.ok(copyId && copyId !== group.id && copied.nodes[copyId]?.kind === 'group')
  assert.ok(isDeepStrictEqual(copied.nodes[group.id], beforeCopy.nodes[group.id]), 'Duplicate must preserve the source group')
  assert.equal(copied.nodes[copyId].children.length, group.children.length)
  checked('chart-copy', { beforeNodes: Object.keys(beforeCopy.nodes).length, afterNodes: Object.keys(copied.nodes).length,
    source: nodeFields(copied.nodes[group.id]), copy: nodeFields(copied.nodes[copyId]), exactWaitMs: await exact(), visual: await selectionPixels('chart-copy') })
  await canvas.focus(); await current.keyboard.press('Meta+z')
  await expect.poll(async () => isDeepStrictEqual((await read()).nodes, beforeCopy.nodes), { timeout: 60_000 }).toBe(true)
  await current.keyboard.press('Meta+Shift+z')
  await expect.poll(async () => isDeepStrictEqual((await read()).nodes, copied.nodes), { timeout: 60_000 }).toBe(true)
  checked('chart-copy: exact authored Undo/Redo', { beforeHash: authoredHash(beforeCopy), afterHash: authoredHash(copied) })
  await select(copyId, 'tree-chart-copy-visible-outline')
  await edit('chart-scale', copyId, async () => {
    await canvas.focus(); await current.keyboard.press('k')
    const input = current.getByLabel('缩放倍率', { exact: true }); await input.fill('1.2x'); await input.press('Enter')
  }, node => node.transform[0] !== copied.nodes[copyId].transform[0])
  const lockedBefore = await read(), row = await select(copyId, 'tree-chart-copy-before-lock')
  await row.getByTitle('锁定图层', { exact: true }).click()
  await expect.poll(async () => (await read()).nodes[copyId].locked).toBe(true)
  await expect(current.getByTestId('canvas-selection-reason')).toBeVisible()
  await canvas.focus(); await current.keyboard.press('ArrowRight')
  assert.ok(isDeepStrictEqual((await read()).nodes[copyId].transform, lockedBefore.nodes[copyId].transform), 'Locked layers must reject keyboard movement')
  checked('chart-lock-rejects-keyboard-edit', { node: nodeFields((await read()).nodes[copyId]), reason: await current.getByTestId('canvas-selection-reason').textContent() })
  await row.getByTitle('解锁图层', { exact: true }).click()
  await expect.poll(async () => (await read()).nodes[copyId].locked).toBe(false)
  await exact()
  const shownRaster = await rasterHashes()
  await row.getByTitle('隐藏图层', { exact: true }).click()
  await expect.poll(async () => (await read()).nodes[copyId].visible).toBe(false)
  await exact()
  await expect(row).toHaveClass(/hidden-layer/)
  const hiddenRaster = await rasterHashes()
  assert.ok(!isDeepStrictEqual(hiddenRaster, shownRaster), 'Hiding the scaled chart must change actual display pixels, independently of selection overlays')
  await current.screenshot({ path: path.join(output, 'chart-hidden.png') })
  checked('chart-hide', { node: nodeFields((await read()).nodes[copyId]), shownRaster, hiddenRaster })
  await row.getByTitle('显示图层', { exact: true }).click()
  await expect.poll(async () => (await read()).nodes[copyId].visible).toBe(true)
  await exact(); await selectionPixels('chart-shown')
  const restoredRaster = await rasterHashes()
  assert.ok(isDeepStrictEqual(restoredRaster, shownRaster), 'Showing the chart again must restore the same exact display pixels')
  checked('chart-show-restores-exact-pixels', { restoredRaster })
  const saved = await read(), portable = path.join(output, 'edited-117.fd')
  if (application) {
    await application.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }) }, portable)
    await current.locator('.brand').click(); await current.getByRole('button', { name: '另存为设计文件…', exact: true }).click()
  } else {
    await current.locator('.brand').click()
    const download = current.waitForEvent('download')
    await current.getByRole('button', { name: /保存设计文件/ }).click()
    await (await download).saveAs(portable)
  }
  await expect.poll(async () => { try { return (await readFile(portable)).subarray(0, 4).toString() } catch { return '' } }, { timeout: 60_000 }).toBe('FXDK')
  await current.locator('.brand').click(); await current.getByRole('button', { name: '新建设计', exact: true }).click()
  await expect(current.getByLabel('文档名称', { exact: true })).not.toHaveValue(name)
  if (application) {
    await application.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] }) }, portable)
    await current.locator('.brand').click(); await current.getByRole('button', { name: /打开本机设计文件/ }).click()
  } else await current.locator('input[type=file][accept*=".fd"]').setInputFiles(portable)
  await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name, { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0)
  await expect.poll(async () => isDeepStrictEqual((await read()).nodes, saved.nodes), { timeout: 60_000 }).toBe(true)
  assert.ok(isDeepStrictEqual((await read()).pages, saved.pages))
  await exact(); await current.reload()
  await expect(current.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
  await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name)
  await expect.poll(async () => isDeepStrictEqual((await read()).nodes, saved.nodes), { timeout: 60_000 }).toBe(true)
  assert.ok(isDeepStrictEqual((await read()).pages, saved.pages))
  await exact()
  checked('native portable save/reopen and renderer restart retain actual edited text, styling, group geometry and duplicated ancestry',
    { authoredHash: authoredHash(saved), nodes: Object.keys(saved.nodes).length, text: nodeFields(saved.nodes[text.id]), group: nodeFields(saved.nodes[copyId]), portableHash: digest(await readFile(portable)) })
  assert.equal(digest(await readFile(fixture)), sourceHash)
  assert.deepEqual(errors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  const finalSourceHash = digest(await readFile(fixture))
  report.finalFixtureHash = finalSourceHash
  report.sourceUnchanged = finalSourceHash === sourceHash
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  typographyEngine?.free()
  await application?.close()
  await browser?.close()
  await server?.close()
  console.log(`SKETCH_EDIT_OUTPUT ${output}`)
  assert.equal(finalSourceHash, sourceHash, 'The source archive changed during this journey')
}
