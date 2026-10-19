// Real Sketch panning in an isolated Chromium profile or the actual Electron
// package. Records exact-frame latency separately from coarse visual response.
// Source archives and document contents stay private; reports contain hashes,
// layer counts, camera/tile metadata, timings and screenshots only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium, _electron, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'

type Camera = { x: number; y: number; zoom: number }
type Position = { x: number; y: number }
type FrameSample = {
  at: number; requested: Camera; visual: Position; ready: boolean; preview: boolean
  documentId?: string; rasterRevision?: string
  title: ({ id: string } & Position) | null
  selection: Position | null
  tile: ({ key: string; visible: boolean } & Position) | null
}
type WorkerTrace = {
  at: number; worker: number; kind: 'send' | 'receive'; id?: number; command?: string
  revision?: number; pageId?: string; backend?: string; error?: string; reason?: string
  tileKey?: string; milliseconds?: number; loadMs?: number; compileMs?: number
  graphMs?: number; finishMs?: number; checkpointMs?: number
  width?: number; height?: number; tiles?: number
}
type Probe = {
  trace: WorkerTrace[]; frames: FrameSample[]; running: boolean
  titleId: string; tileKey: string
}
declare global { interface Window { __sketchPanProbe: Probe } }

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, electron: { type: 'boolean' },
  app: { type: 'string' }, output: { type: 'string' },
} })
assert.ok(values.fixture && path.isAbsolute(values.fixture), '--fixture must be an absolute private Sketch path')
assert.match(values.fixture, /\.sketch$/i)
assert.ok(!values.app || (values.electron && path.isAbsolute(values.app)), '--app requires --electron and an absolute executable path')
assert.ok(!values.output || path.isAbsolute(values.output), '--output must be an absolute, new private directory')
const fixture = values.fixture, electronMode = !!values.electron
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.resolve(client, '../design-desktop')
let output: string
if (values.output) {
  output = values.output
  await mkdir(path.dirname(output), { recursive: true })
  // Never overwrite a prior run or use another test's profile/evidence folder.
  await mkdir(output)
} else output = await mkdtemp(path.join(tmpdir(), 'futureox-sketch-pan-'))
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const original = await readFile(fixture), errors: string[] = []
const report: Record<string, unknown> = {
  status: 'running', mode: electronMode ? 'electron' : 'web',
  fixture: path.basename(fixture), fixtureHash: digest(original),
  startedAt: new Date().toISOString(), gestures: [], pageErrors: errors,
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
let server: Awaited<ReturnType<typeof createServer>> | undefined
let page: Page | undefined
const saveReport = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))

function installProbe() {
  const probe: Probe = window.__sketchPanProbe = {
    trace: [], frames: [], running: false, titleId: '', tileKey: '',
  }
  const owners = new WeakMap<Worker, number>()
  let nextWorker = 0
  const originalSend = Worker.prototype.postMessage as (...args: unknown[]) => void
  Worker.prototype.postMessage = function (message: unknown, ...transfer: unknown[]) {
    let worker = owners.get(this)
    if (worker === undefined) {
      worker = ++nextWorker
      owners.set(this, worker)
      const owner = worker
      this.addEventListener('message', ({ data }) => {
        if (!data || typeof data.id !== 'number') return // Import payloads contain private document data.
        probe.trace.push({ at: performance.now(), worker: owner, kind: 'receive', id: data.id,
          backend: data.backend || data.tile?.backend, error: data.error, reason: data.reason,
          tileKey: data.tile?.key, milliseconds: data.milliseconds ?? data.tile?.milliseconds,
          loadMs: data.loadMs, compileMs: data.compileMs, graphMs: data.graphMs,
          finishMs: data.finishMs, checkpointMs: data.checkpointMs })
      })
    }
    const request = (message && typeof message === 'object' ? message : {}) as { id?: number; command?: string; documentRevision?: number; backend?: string;
      options?: { width: number; height: number; pageId: string; tileViewport?: unknown[] } }
    if (typeof request.id === 'number' || request.command === 'cancel-preview')
      probe.trace.push({ at: performance.now(), worker, kind: 'send', id: request.id,
        command: request.command, revision: request.documentRevision, backend: request.backend,
        pageId: request.options?.pageId, width: request.options?.width,
        height: request.options?.height, tiles: request.options?.tileViewport?.length })
    originalSend.call(this, message, ...transfer)
  }
}

async function beginFrames(current: Page, titleId: string, tileKey: string) {
  await current.evaluate(({ titleId, tileKey }) => {
    const probe = window.__sketchPanProbe
    probe.frames = []; probe.running = true; probe.titleId = titleId; probe.tileKey = tileKey
    let previous = ''
    const tick = () => {
      if (!probe.running) return
      const host = document.querySelector<HTMLElement>('.kernel-presentation')!
      const surface = document.querySelector<HTMLElement>('.kernel-tiles')!
      const title = [...document.querySelectorAll<SVGElement>('[data-frame-title]')]
        .find(element => element.dataset.frameTitle === probe.titleId)
      const selection = document.querySelector<SVGElement>('.selection > polygon:first-child')
      const tile = [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-lod=coarse]')]
        .find(element => element.dataset.tileKey === probe.tileKey &&
          element.dataset.tileRevision === surface.dataset.requestedRevision && element.getAttribute('aria-hidden') === 'false')
      const rect = (element: Element) => {
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y }
      }
      const sample: FrameSample = {
        at: performance.now(),
        requested: { x: Number(host.dataset.requestedCameraX), y: Number(host.dataset.requestedCameraY), zoom: Number(host.dataset.requestedCameraZoom) },
        visual: { x: Number(host.dataset.visualCameraX), y: Number(host.dataset.visualCameraY) },
        ready: host.dataset.presentationReady === 'true', preview: host.dataset.previewActive === 'true',
        documentId: host.dataset.requestedDocument, rasterRevision: surface.dataset.requestedRevision,
        title: title ? { id: probe.titleId, ...rect(title) } : null,
        selection: selection && getComputedStyle(selection).visibility === 'visible' ? rect(selection) : null,
        tile: tile ? { key: probe.tileKey, visible: tile.dataset.frameVisible === 'true', ...rect(tile) } : null,
      }
      const signature = JSON.stringify({ ...sample, at: 0 })
      if (signature !== previous) {
        if (probe.frames.length >= 4096) throw new Error('Pan frame trace exceeded its bounded sample budget')
        probe.frames.push(sample); previous = signature
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, { titleId, tileKey })
}

try {
  if (electronMode) {
    const requireDesktop = createRequire(path.join(desktop, 'package.json'))
    const profiles = path.join(output, 'profiles'); await mkdir(profiles)
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
    application = await _electron.launch({ executablePath: values.app || requireDesktop('electron'),
      args: [...(values.app ? [] : [desktop]), '--desktop-gui-test'],
      env: { ...env, TMPDIR: profiles }, chromiumSandbox: true, timeout: 45_000 })
    page = await application.firstWindow({ timeout: 45_000 })
    report.host = await application.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { packaged: app.isPackaged, profile: app.getPath('userData'), sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation, webSecurity: preferences.webSecurity,
        nodeIntegration: preferences.nodeIntegration }
    })
    assert.ok((report.host as { sandbox: boolean }).sandbox)
    assert.ok((report.host as { contextIsolation: boolean }).contextIsolation)
    assert.ok((report.host as { webSecurity: boolean }).webSecurity)
    assert.equal((report.host as { nodeIntegration: boolean }).nodeIntegration, false)
    // firstWindow may precede its initial load; wait before the traced reload.
    await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
    await page.addInitScript(installProbe)
    await page.reload()
  } else {
    server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })
    await page.addInitScript(installProbe)
    await page.goto(server.resolvedUrls!.local[0])
  }
  const current = page
  current.on('pageerror', error => errors.push(String(error)))
  current.setDefaultTimeout(30_000)
  const presentation = current.locator('.kernel-presentation'), canvas = current.getByTestId('canvas')
  const surface = current.locator('.kernel-tiles')
  const camera = () => presentation.evaluate(element => {
    const data = (element as HTMLElement).dataset
    return { x: Number(data.requestedCameraX), y: Number(data.requestedCameraY), zoom: Number(data.requestedCameraZoom) }
  })
  const settle = async () => {
    await current.waitForFunction(() => document.querySelector('.kernel-status.error') ||
      document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.fallbackPhase === 'pending' ||
      document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.presentationReady === 'true', null, { timeout: 120_000 })
    assert.deepEqual(await current.locator('.kernel-status.error').allTextContents(), [], 'The renderer reported a real failure')
    await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
    await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'true')
    await expect(presentation).toHaveAttribute('data-preview-active', 'false')
  }
  await expect(current.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  const importStarted = Date.now()
  await current.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  const name = path.basename(fixture).replace(/\.sketch$/i, '')
  await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name, { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  const stored = () => current.evaluate(async ({ electronMode, name }) => {
    if (electronMode) {
      const bridge = window.coreDesktop?.workspace
      if (!bridge) throw new Error('Missing real workspace bridge')
      const list = await bridge.list()
      if (list.status !== 'ok') throw new Error('Workspace list failed')
      const entry = list.documents.find(item => item.name === name && !item.deleted)
      if (!entry) return null
      const opened = await bridge.open({ id: entry.id })
      if (opened.status !== 'ok') throw new Error('Workspace open failed')
      return JSON.parse(opened.documentJson)
    }
    const { localOpen } = await import('/src/local-store.ts')
    const opened = await localOpen()
    return opened?.document.name === name ? opened.document : null
  }, { electronMode, name })
  await expect.poll(async () => !!await stored(), { timeout: 60_000 }).toBe(true)
  await settle()
  report.importToExactMs = Date.now() - importStarted
  const document = await stored(), documentHash = digest(JSON.stringify(document))
  const dpr = await current.evaluate(() => devicePixelRatio)
  report.dpr = dpr
  report.imported = { nodes: Object.keys(document.nodes).length, pages: document.pages.length, documentHash }
  assert.ok(dpr >= 1, 'The actual display density must be recorded')
  const baseline = await surface.evaluate(element => ({ ...(element as HTMLElement).dataset }))
  assert.ok(Number(baseline.lodScale) > 0, 'This fixture/camera must exercise the coarse LOD path')
  const title = current.locator('[data-frame-title]').first()
  const titleId = await title.getAttribute('data-frame-title')
  assert.ok(titleId, 'This acceptance fixture needs an artboard title')
  await current.getByTestId(`layer-${titleId}`).click()
  // The outline is followed by separate polygon handles for resize/rotation.
  await expect(current.locator('.selection > polygon:first-child')).toHaveCount(1)
  await canvas.focus()
  const tileKey = await current.locator('canvas[data-lod=coarse]').evaluateAll((elements, baseline) => {
    const element = elements.find(element => (element as HTMLElement).dataset.tileRevision === baseline.requestedRevision &&
      Number((element as HTMLElement).dataset.tileZoom) === Number(baseline.lodScale) && element.getAttribute('aria-hidden') === 'false')
    return (element as HTMLElement | undefined)?.dataset.tileKey
  }, baseline)
  assert.ok(tileKey, 'The imported document must publish a reusable coarse canvas')
  const box = await canvas.boundingBox(); assert.ok(box)
  const point = { x: box.x + box.width * .62, y: box.y + box.height * .65 }
  const drag = async (dx: number, dy: number, button: 'left' | 'middle' = 'left') => {
    await current.mouse.move(point.x, point.y)
    await current.mouse.down({ button })
    await expect(canvas).toHaveAttribute('data-transform-gesture', 'pan')
    await current.mouse.move(point.x + dx, point.y + dy, { steps: 10 })
    await current.mouse.up({ button })
  }
  const gestures: { name: string; delta?: Position; run(): Promise<void> }[] = [
    { name: 'space-left', delta: { x: 100, y: 40 }, async run() {
      await current.keyboard.down('Space')
      await expect(canvas).toHaveClass(/canvas-space-held/)
      await drag(100, 40)
      await current.keyboard.up('Space')
    } },
    { name: 'hand-tool', delta: { x: -80, y: -25 }, async run() {
      await current.keyboard.press('h')
      await expect(canvas).toHaveClass(/canvas-hand/)
      await drag(-80, -25)
      await current.keyboard.press('v')
    } },
    { name: 'middle', delta: { x: 60, y: 20 }, async run() { await drag(60, 20, 'middle') } },
    { name: 'wheel', async run() {
      await current.mouse.move(point.x, point.y)
      await current.mouse.wheel(30, 40)
    } },
  ]
  report.baseline = baseline
  if (path.basename(fixture) === '117.sketch')
    await expect(current.getByRole('complementary', { name: '导入兼容提示' })).toBeVisible()
  report.compatibilityNoticeVisible = await current.getByRole('complementary', { name: '导入兼容提示' }).isVisible()
  assert.equal(await current.locator('.feature-backdrop').count(), 0, 'Compatibility details must not capture the canvas')
  const initialTraceCount = await current.evaluate(() => window.__sketchPanProbe.trace.length)
  const close = (actual: number, expected: number, message: string, tolerance = .01) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} / ${expected}`)
  for (const gesture of gestures) {
    await canvas.focus()
    const before = await camera()
    await beginFrames(current, titleId, tileKey)
    const started = Date.now()
    console.log(`SKETCH_PAN_START ${gesture.name}`)
    await gesture.run()
    // Wheel dispatch returns before its animation-frame handler on some hosts.
    await expect.poll(async () => {
      const next = await camera()
      return next.x !== before.x && next.y !== before.y
    }, { timeout: 3_000 }).toBe(true)
    const immediate = await camera(), inputMs = Date.now() - started
    if (gesture.delta) {
      close(immediate.x - before.x, gesture.delta.x, `${gesture.name} horizontal pan`)
      close(immediate.y - before.y, gesture.delta.y, `${gesture.name} vertical pan`)
    } else assert.ok(immediate.x !== before.x && immediate.y !== before.y, 'Wheel must pan both axes')
    close(immediate.zoom, before.zoom, 'A pan must not change zoom', 1e-9)
    await settle()
    const exactWaitMs = Date.now() - started
    const frames = await current.evaluate(() => {
      window.__sketchPanProbe.running = false
      return window.__sketchPanProbe.frames
    })
    const previews = frames.filter(frame => frame.preview && frame.tile?.visible && frame.title && frame.selection)
    assert.ok(previews.length, `${gesture.name} must move real coarse pixels before the exact frame completes`)
    const first = frames[0], preview = previews[0]
    assert.ok(first.title && first.selection && first.tile)
    assert.ok(preview.at - first.at < 1_000, 'Coarse visual response must not wait for the expensive exact frame')
    for (const sample of previews) {
      assert.equal(sample.ready, false, 'A coarse presentation cannot claim exact completion')
      assert.equal(sample.rasterRevision, baseline.requestedRevision, 'Panning must not change the raster document revision')
      assert.equal(sample.documentId, document.id, 'Preview must belong to the imported document')
      close(sample.visual.x, sample.requested.x, 'Preview overlay uses the requested horizontal camera')
      close(sample.visual.y, sample.requested.y, 'Preview overlay uses the requested vertical camera')
      const dx = sample.requested.x - first.requested.x, dy = sample.requested.y - first.requested.y
      close(sample.title!.x - first.title.x, dx, 'Artboard title follows the image horizontally')
      close(sample.title!.y - first.title.y, dy, 'Artboard title follows the image vertically')
      close(sample.selection!.x - first.selection.x, dx, 'Selection follows the image horizontally')
      close(sample.selection!.y - first.selection.y, dy, 'Selection follows the image vertically')
      close(sample.tile!.x - first.tile.x, dx, 'Coarse pixels follow horizontal input', 1 / dpr + .01)
      close(sample.tile!.y - first.tile.y, dy, 'Coarse pixels follow vertical input', 1 / dpr + .01)
    }
    const after = await surface.evaluate(element => ({ ...(element as HTMLElement).dataset }))
    assert.equal(after.requestedRevision, baseline.requestedRevision)
    assert.ok(Number(after.lodCacheHits) > Number(baseline.lodCacheHits), 'Pans must reuse existing coarse tiles')
    assert.ok(Number(after.lodCacheBytes) <= Number(after.lodCacheBudget), 'LOD cache exceeded its byte ceiling')
    const exact = await presentation.evaluate(element => ({ ...(element as HTMLElement).dataset }))
    close(Number(exact.cameraX), immediate.x, 'The completed exact frame reaches the latest horizontal camera')
    close(Number(exact.cameraY), immediate.y, 'The completed exact frame reaches the latest vertical camera')
    const result = { gesture: gesture.name, inputMs, firstPreviewMs: preview.at - first.at, exactWaitMs,
      before, immediate, after, exact, frames, compatibilityNoticeVisible:
        await current.getByRole('complementary', { name: '导入兼容提示' }).isVisible() }
    if (path.basename(fixture) === '117.sketch')
      assert.equal(result.compatibilityNoticeVisible, true, 'Compatibility information remains nonblocking throughout panning')
    ;(report.gestures as unknown[]).push(result)
    await saveReport()
    console.log(`SKETCH_PAN ${JSON.stringify({ gesture: gesture.name, inputMs,
      firstPreviewMs: result.firstPreviewMs, exactWaitMs, rasterRevision: after.requestedRevision,
      coarseCacheHits: after.lodCacheHits })}`)
  }
  const trace = await current.evaluate(start => window.__sketchPanProbe.trace.slice(start), initialTraceCount)
  const sends = trace.filter(entry => entry.kind === 'send' && entry.pageId === document.pages[0].id)
  assert.ok(sends.length > 0)
  assert.equal(new Set(sends.map(entry => entry.revision)).size, 1, 'Panning must reuse one immutable worker document')
  assert.ok(trace.some(entry => entry.command === 'cancel-preview'), 'A newer camera must cancel superseded work')
  assert.ok(trace.some(entry => entry.error === 'PREVIEW_CANCELLED'), 'Cancelled work must not consume every intermediate camera')
  assert.deepEqual(trace.filter(entry => entry.error && entry.error !== 'PREVIEW_CANCELLED'), [])
  assert.deepEqual(trace.filter(entry => entry.backend === 'cpu' || entry.error?.includes('PREVIEW_CPU_FALLBACK')), [])
  report.trace = trace
  assert.equal(digest(JSON.stringify(await stored())), documentHash, 'Pan gestures must not alter authored document data')
  assert.equal(digest(await readFile(fixture)), report.fixtureHash, 'The original Sketch archive must remain unchanged')
  assert.deepEqual(errors, [])
  await current.screenshot({ path: path.join(output, 'pan-final.png') })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
  if (page) {
    report.diagnostics = await page.evaluate(() => ({
      status: [...document.querySelectorAll<HTMLElement>('.kernel-status')].map(element => ({ text: element.textContent, detail: element.title })),
      presentation: { ...document.querySelector<HTMLElement>('.kernel-presentation')?.dataset },
      trace: window.__sketchPanProbe?.trace, frames: window.__sketchPanProbe?.frames,
    })).catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await saveReport()
  await browser?.close()
  // Only this invocation's isolated test application is closed. app.exit avoids
  // waiting on native close confirmation after an assertion failed mid-gesture.
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await application.close().catch(() => {})
  }
  await server?.close()
  console.log(`SKETCH_PAN_OUTPUT ${output}`)
}
