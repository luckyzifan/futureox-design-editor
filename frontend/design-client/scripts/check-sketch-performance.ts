// Real 117 import, warm zoom, pan and group editing. All authored writes use
// the production UI. The workspace bridge is a read-only persistence oracle;
// worker/canvas probes only record metadata and never replace render results.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { _electron, chromium, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, electron: { type: 'boolean' },
  app: { type: 'string' }, output: { type: 'string' },
  gestures: { type: 'boolean' },
  'navigation-only': { type: 'boolean' },
  zooms: { type: 'string' },
  'assert-cached-zoom': { type: 'boolean' },
} })
assert.ok(values.fixture && path.isAbsolute(values.fixture), '--fixture requires an absolute Sketch/FD path')
assert.match(values.fixture, /\.(sketch|fd)$/i)
assert.ok(!values.app || (values.electron && path.isAbsolute(values.app)), '--app requires --electron and an absolute executable')
assert.ok(!values.output || path.isAbsolute(values.output), '--output requires an absolute new directory')
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.resolve(client, '../design-desktop')
const fixture = values.fixture, electronMode = !!values.electron
const output = values.output || await mkdtemp(path.join(tmpdir(), 'futureox-sketch-performance-'))
if (values.output) { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output) }
const digest = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const original = await readFile(fixture), errors: string[] = []
const report: Record<string, any> = {
  status: 'running', mode: electronMode ? 'electron' : 'web', fixture: path.basename(fixture),
  fixtureHash: digest(original), startedAt: new Date().toISOString(), stages: [], errors,
  metricContract: {
    preview: 'CSS reprojection of existing sampled pixels; does not prove newly edited content',
    pixelWrite: 'A production drawImage/putImageData call wrote a mounted tile canvas; may write unchanged bytes',
    contentToken: 'Sparse digest of worker byte output, when present; bitmap-only output has no digest',
    exact: 'Production presentation-ready=true, no preview/fallback/error, latest requested camera/revision',
    screenshot: 'Actual composite at each completed stage; no substituted pixels',
  },
}
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let server: Awaited<ReturnType<typeof createServer>> | undefined
let page: Page | undefined
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))

function installProbe() {
  const probe = (window as any).__sketchPerformance = {
    trace: [] as any[], writes: [] as any[], frames: [] as any[], running: false,
  }
  const owners = new WeakMap<Worker, number>(); let next = 0
  // Sparse tokens deliberately avoid copying megabytes or synchronously
  // reading GPU canvases during a performance run. They are not equality
  // certificates; the report names them accordingly.
  const token = (data: ArrayBuffer | ArrayBufferView | undefined) => {
    if (!data) return undefined
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) :
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    let hash = 2166136261
    const step = Math.max(1, Math.floor(bytes.length / 1024))
    for (let i = 0; i < bytes.length; i += step) hash = Math.imul(hash ^ bytes[i], 16777619)
    return `${bytes.byteLength}:${hash >>> 0}`
  }
  const originalSend = Worker.prototype.postMessage as (...args: any[]) => void
  Worker.prototype.postMessage = function (data: any, ...transfer: any[]) {
    let worker = owners.get(this)
    if (worker === undefined) {
      worker = ++next; owners.set(this, worker)
      const owner = worker
      this.addEventListener('message', ({ data }) => {
        if (!data || typeof data.id !== 'number') return
        probe.trace.push({ at: performance.now(), kind: 'receive', worker: owner, id: data.id,
          backend: data.backend || data.tile?.backend, error: data.error, reason: data.reason,
          damage: data.damage, tileKey: data.tile?.key, tileZoom: data.tile?.zoom,
          cached: data.tile?.cached, bitmap: !!data.tileBitmap,
          contentToken: token(data.buffer || data.linearBuffer),
          milliseconds: data.milliseconds ?? data.tile?.milliseconds, loadMs: data.loadMs,
          compileMs: data.compileMs ?? data.tile?.compileMs,
          graphMs: data.graphMs ?? data.tile?.graphMs, finishMs: data.finishMs ?? data.tile?.finishMs,
          checkpointMs: data.checkpointMs ?? data.tile?.checkpointMs, tilesRendered: data.previewTiles,
          previewLeaves: data.previewLeaves, injectedBudgetFailures: data.injectedBudgetFailures,
          tileCacheHits: data.tileCacheHits, certifiedTileHits: data.certifiedTileHits,
          tileCacheBytes: data.tileCacheBytes, tileCacheEvictions: data.tileCacheEvictions,
          drawCalls: data.drawCalls, commandSubmissions: data.commandSubmissions, triangles: data.triangles,
          hybridEffects: data.hybridEffects ?? data.tile?.hybridEffects,
          peakTextureBytes: data.peakTextureBytes, finishTransientBytes: data.finishTransientBytes,
        })
      })
    }
    if (typeof data?.id === 'number' || data?.command === 'cancel-preview') {
      const patch = typeof data.documentPatch === 'string' ? JSON.parse(data.documentPatch) : undefined
      probe.trace.push({ at: performance.now(), kind: 'send', worker, id: data.id,
        command: data.command, revision: data.documentRevision, baseRevision: data.baseDocumentRevision,
        backend: data.backend, fullDocumentBytes: data.document?.length,
        patchBytes: data.documentPatch?.length, patchNodes: patch ? Object.keys(patch.nodes || {}) : undefined,
        patchFields: patch ? Object.keys(patch.fields || {}) : undefined,
        pageId: data.options?.pageId, view: data.options?.view,
        width: data.options?.width, height: data.options?.height,
        tiles: data.options?.tileViewport?.map((tile: any) => ({ key: tile.key, x: tile.x,
          y: tile.y, zoom: tile.zoom, width: tile.width, height: tile.height })),
        residentTiles: data.options?.residentTiles, tileOwner: data.options?.tileOwner,
      })
    }
    originalSend.call(this, data, ...transfer)
  }
  for (const method of ['drawImage', 'putImageData'] as const) {
    const original = CanvasRenderingContext2D.prototype[method] as (...args: any[]) => any
    ;(CanvasRenderingContext2D.prototype as any)[method] = function (...args: any[]) {
      const result = original.apply(this, args)
      if (this.canvas?.dataset?.tileKey) probe.writes.push({ at: performance.now(), method,
        tileKey: this.canvas.dataset.tileKey, revision: this.canvas.dataset.tileRevision,
        width: this.canvas.width, height: this.canvas.height })
      return result
    }
  }
}

async function startFrames(current: Page) {
  return current.evaluate(() => {
    const probe = (window as any).__sketchPerformance
    probe.frames = []; probe.running = true
    const start = performance.now(); let previous = ''
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    const tick = () => {
      if (!probe.running) return
      const host = document.querySelector<HTMLElement>('.kernel-presentation')
      const surface = document.querySelector<HTMLElement>('.kernel-tiles')
      const outline = document.querySelector<SVGElement>('[data-testid="canvas-selection-outline"]')
      const visible = [...document.querySelectorAll<HTMLCanvasElement>('canvas[data-tile-key]')]
        .filter(canvas => canvas.dataset.frameVisible === 'true' && getComputedStyle(canvas).visibility === 'visible')
      const canvasBounds = document.querySelector('[data-testid="canvas"]')?.getBoundingClientRect()
      const rectangles = visible.map(canvas => canvas.getBoundingClientRect())
      let uncovered = 0
      if (canvasBounds) for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) for (const fy of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        const x = canvasBounds.x + canvasBounds.width * fx, y = canvasBounds.y + canvasBounds.height * fy
        if (!rectangles.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) uncovered++
      }
      const frame = { at: performance.now(), host: { ...host?.dataset }, surface: { ...surface?.dataset },
        uncovered,
        selection: outline && getComputedStyle(outline).visibility === 'visible' ? rect(outline) : null,
        tiles: visible.map(canvas => ({ key: canvas.dataset.tileKey, revision: canvas.dataset.tileRevision,
          zoom: canvas.dataset.tileZoom, lod: canvas.dataset.lod, ...rect(canvas) })),
        pixelWrites: probe.writes.length,
      }
      const signature = JSON.stringify({ ...frame, at: 0 })
      if (signature !== previous && probe.frames.length < 8192) { probe.frames.push(frame); previous = signature }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    return { at: start, trace: probe.trace.length, writes: probe.writes.length }
  })
}

try {
  if (electronMode) {
    const requireDesktop = createRequire(path.join(desktop, 'package.json'))
    const profiles = path.join(output, 'profiles'); await mkdir(profiles)
    const env = Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
    application = await _electron.launch({ executablePath: values.app || requireDesktop('electron'),
      args: [...(values.app ? [] : [desktop]), '--desktop-gui-test'], env: { ...env, TMPDIR: profiles },
      chromiumSandbox: true, timeout: 45_000 })
    page = await application.firstWindow({ timeout: 45_000 })
    report.host = await application.evaluate(({ app, BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { packaged: app.isPackaged, profile: app.getPath('userData'), sandbox: prefs.sandbox,
        contextIsolation: prefs.contextIsolation, webSecurity: prefs.webSecurity, nodeIntegration: prefs.nodeIntegration }
    })
    assert.equal(report.host.sandbox, true); assert.equal(report.host.contextIsolation, true)
    assert.equal(report.host.webSecurity, true); assert.equal(report.host.nodeIntegration, false)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
    await page.addInitScript(installProbe); await page.reload()
  } else {
    server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })
    await page.addInitScript(installProbe); await page.goto(server.resolvedUrls!.local[0])
  }
  const current = page!
  current.on('pageerror', error => errors.push(String(error))); current.setDefaultTimeout(30_000)
  const canvas = current.getByTestId('canvas'), presentation = current.locator('.kernel-presentation')
  const name = path.basename(fixture).replace(/\.(sketch|fd)$/i, '')
  const stored = () => current.evaluate(async ({ electronMode, name }) => {
    if (electronMode) {
      const bridge = window.coreDesktop?.workspace
      if (!bridge) throw new Error('Missing real workspace bridge')
      const list = await bridge.list(); if (list.status !== 'ok') throw new Error('Workspace list failed')
      const item = list.documents.find(entry => entry.name === name && !entry.deleted)
      if (!item) return null
      const opened = await bridge.open({ id: item.id })
      if (opened.status !== 'ok') throw new Error('Workspace open failed')
      return JSON.parse(opened.documentJson)
    }
    const { localOpen } = await import('/src/local-store.ts')
    const opened = await localOpen(); return opened?.document.name === name ? opened.document : null
  }, { electronMode, name })
  const snapshot = () => current.evaluate(() => ({
    host: { ...document.querySelector<HTMLElement>('.kernel-presentation')?.dataset },
    surface: { ...document.querySelector<HTMLElement>('.kernel-tiles')?.dataset },
  }))
  const settle = async () => {
    await current.waitForFunction(() => document.querySelector('.kernel-status.error') ||
      document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.fallbackPhase === 'pending' ||
      document.querySelector<HTMLElement>('.kernel-presentation')?.dataset.presentationReady === 'true', null, { timeout: 120_000 })
    assert.deepEqual(await current.locator('.kernel-status.error').allTextContents(), [])
    await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
    await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'true')
    await expect(presentation).toHaveAttribute('data-preview-active', 'false')
  }
  const stage = async (name: string, action: () => Promise<void>, verify?: () => Promise<void>) => {
    const before = await snapshot(), marker = await startFrames(current)
    console.log(`SKETCH_PERFORMANCE_START ${name}`)
    await action(); const actionDone = await current.evaluate(() => performance.now())
    await settle(); const exactDone = await current.evaluate(() => performance.now())
    await verify?.()
    const result = await current.evaluate(({ marker }) => {
      const probe = (window as any).__sketchPerformance; probe.running = false
      return { trace: probe.trace.slice(marker.trace), writes: probe.writes.slice(marker.writes), frames: probe.frames }
    }, { marker })
    const after = await snapshot()
    assert.ok(result.frames.length > 0, 'Frame probe must observe the real canvas')
    if (name !== 'import') assert.ok(result.frames.every((frame: any) => frame.tiles.length > 0), 'Camera/editing must retain visible tiles')
    const previews = result.frames.filter((frame: any) => frame.host.previewActive === 'true')
    const workerTiles = result.trace.filter((entry: any) => entry.kind === 'receive' && entry.tileKey)
    const finishes = result.trace.filter((entry: any) => entry.kind === 'receive' && entry.tilesRendered !== undefined)
    const summary = { name, actionMs: actionDone - marker.at, exactMs: exactDone - marker.at,
      firstPreviewMs: previews.length ? previews[0].at - marker.at : null,
      firstPixelWriteMs: result.writes.length ? result.writes[0].at - marker.at : null,
      workerTileCount: workerTiles.length, workerFreshTiles: workerTiles.filter((tile: any) => !tile.cached).length,
      totalReportedDrawCalls: finishes.reduce((sum: number, entry: any) => sum + (entry.drawCalls || 0), 0),
      damage: result.trace.filter((entry: any) => entry.damage).map((entry: any) => entry.damage),
      before, after, ...result,
    }
    report.stages.push(summary)
    await current.screenshot({ path: path.join(output, `${String(report.stages.length).padStart(2, '0')}-${name}.png`) })
    await save()
    console.log(`SKETCH_PERFORMANCE ${JSON.stringify({ name, exactMs: summary.exactMs,
      firstPreviewMs: summary.firstPreviewMs, firstPixelWriteMs: summary.firstPixelWriteMs,
      workerFreshTiles: summary.workerFreshTiles, damage: summary.damage })}`)
    return summary
  }
  await expect(current.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  await stage('import', async () => {
    await current.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
    await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name, { timeout: 60_000 })
    await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  }, async () => { await expect.poll(async () => !!await stored(), { timeout: 60_000 }).toBe(true) })
  const imported = await stored(), documentHash = digest(JSON.stringify(imported))
  report.imported = { nodes: Object.keys(imported.nodes).length, pages: imported.pages.length,
    text: Object.values(imported.nodes).filter((node: any) => node.kind === 'text').length,
    documentHash, dpr: await current.evaluate(() => devicePixelRatio) }
  report.adapter = await current.evaluate(async () => {
    const info = (await navigator.gpu?.requestAdapter())?.info
    return info && { vendor: info.vendor, architecture: info.architecture, description: info.description }
  })
  if (path.basename(fixture) === '117.sketch') {
    assert.equal(report.imported.nodes, 752); assert.equal(report.imported.text, 106)
  }
  const notice = current.getByRole('complementary', { name: '导入兼容提示' })
  if (await notice.count()) await notice.getByRole('button', { name: '关闭导入提示' }).click()
  const completedCameras = new Set<string>()
  const zooms = values.zooms ? values.zooms.split(',').map(Number) : [50, 100, 200, 50]
  assert.ok(zooms.length && zooms.every(value => Number.isFinite(value) && value > 0), 'Invalid zoom sequence')
  for (const zoom of zooms) {
    const result = await stage(`zoom-${zoom}${completedCameras.size >= 2 ? '-return' : ''}`, async () => {
    await current.getByLabel('缩放与视图设置', { exact: true }).click()
    await current.getByRole('button', { name: `${zoom}%`, exact: true }).click()
    await expect(presentation).toHaveAttribute('data-requested-camera-zoom', String(zoom / 100))
  })
    const camera = JSON.stringify([result.after.host.cameraX, result.after.host.cameraY, result.after.host.cameraZoom])
    if (values['assert-cached-zoom'] && completedCameras.has(camera)) {
      assert.equal(result.after.surface.viewportTilesRendered, result.before.surface.viewportTilesRendered,
        'A cached camera return must issue zero new visible tile rasters')
      assert.equal(result.workerFreshTiles, 0, 'Cached return must not deliver a fresh raster in this observation window')
      result.cachedReturnVerified = true
    }
    assert.ok(Number(result.after.surface.samplingDensity) >= report.imported.dpr, 'Canvas must retain physical DPR')
    completedCameras.add(camera)
  }
  await stage('pan', async () => {
    const before = await snapshot(), box = await canvas.boundingBox(); assert.ok(box)
    await canvas.focus(); await current.keyboard.down('Space')
    await current.mouse.move(box.x + box.width * .6, box.y + box.height * .6)
    await current.mouse.down(); await expect(canvas).toHaveAttribute('data-transform-gesture', 'pan')
    await current.mouse.move(box.x + box.width * .6 + 80, box.y + box.height * .6 + 40, { steps: 12 })
    await current.mouse.up(); await current.keyboard.up('Space')
    await expect.poll(async () => (await snapshot()).host.requestedCameraX).not.toBe(before.host.requestedCameraX)
  })
  assert.equal(digest(JSON.stringify(await stored())), documentHash, 'Camera gestures must not author document changes')
  if (!values['navigation-only']) {
  const group = Object.values(imported.nodes).find((node: any) => node.kind === 'group' && /^组合\s*23$/.test(node.name)) as any
  assert.ok(group, '117 must contain the actual editable group 23')
  report.editedGroup = { id: group.id, name: group.name, children: group.children.length, initialTransform: group.transform }
  await current.getByPlaceholder('搜索图层…').fill(group.name)
  await current.getByTestId(`layer-${group.id}`).click()
  await expect(current.locator('.inspector')).toHaveAttribute('data-node-id', group.id)
  await settle()
  await expect(current.getByTestId('canvas-selection-outline')).toBeVisible()
  const x = current.getByLabel('X', { exact: true }), initialX = Number(await x.inputValue())
  await stage('move-group-23', async () => {
    await x.fill(String(initialX + 24)); await x.press('Enter')
    await expect(x).toHaveValue(String(initialX + 24))
  }, async () => {
    await expect.poll(async () => (await stored()).nodes[group.id].transform[4], { timeout: 60_000 })
      .toBe(group.transform[4] + 24)
  })
  const edited = await stored()
  assert.equal(Object.keys(edited.nodes).length, report.imported.nodes)
  assert.equal(edited.nodes[group.id].transform[5], group.transform[5])
  for (const [id, node] of Object.entries(imported.nodes)) {
    if (id === group.id) continue
    assert.equal(digest(JSON.stringify(edited.nodes[id])), digest(JSON.stringify(node)), 'A group translation must preserve all untouched authored nodes')
  }
  await stage('undo-group-23', async () => {
    await canvas.focus(); await current.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
    await expect(x).toHaveValue(String(initialX))
  }, async () => {
    await expect.poll(async () => digest(JSON.stringify(await stored())), { timeout: 60_000 }).toBe(documentHash)
  })
  }
  if (values.gestures) {
    const gesture = await stage('continuous-fractional-zoom', async () => {
      const box = await canvas.boundingBox(); assert.ok(box)
      await current.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await current.keyboard.down('Control')
      for (const delta of [-12, -12, -12, -12, -12, -12, 12, 12, 12, 12, 12, 12])
        await current.mouse.wheel(0, delta)
      await current.keyboard.up('Control')
    })
    assert.ok(gesture.frames.every((frame: any) => frame.uncovered === 0), 'Cached zoom gesture must keep viewport coverage')
    const delivered = gesture.trace.filter((entry: any) => entry.kind === 'receive' && entry.tileKey)
    assert.ok(delivered.length < 40, 'Continuous zoom must coalesce intermediate native-density plans')
    report.gesture = { frames: gesture.frames.length, maxUncovered: Math.max(...gesture.frames.map((f: any) => f.uncovered)),
      firstPreviewMs: gesture.firstPreviewMs, deliveredTiles: delivered.length,
      cachedPreviewFrames: gesture.frames.filter((f: any) => Number(f.surface.cachedPreviewTiles) > 0).length }
    // Revisit a previously completed camera and compare actual composite pixels.
    const zoomMenu = async () => {
      await current.getByLabel('缩放与视图设置', { exact: true }).click()
      await current.getByRole('button', { name: '50%', exact: true }).click()
    }
    await zoomMenu(); await settle()
    const beforeCamera = await snapshot(), firstPixels = digest(await canvas.screenshot())
    await current.getByLabel('缩放与视图设置', { exact: true }).click()
    await current.getByRole('button', { name: '100%', exact: true }).click(); await settle()
    await zoomMenu(); await settle()
    const afterCamera = await snapshot()
    assert.equal(afterCamera.host.cameraX, beforeCamera.host.cameraX)
    assert.equal(afterCamera.host.cameraY, beforeCamera.host.cameraY)
    assert.equal(digest(await canvas.screenshot()), firstPixels, 'Zoom round trip must preserve the actual visible content')
    report.gesture.roundTripPixelsEqual = true
  }
  const trace = await current.evaluate(() => (window as any).__sketchPerformance.trace)
  assert.deepEqual(trace.filter((entry: any) => entry.error && entry.error !== 'PREVIEW_CANCELLED'), [])
  assert.deepEqual(trace.filter((entry: any) => entry.backend === 'cpu' || entry.error?.includes('PREVIEW_CPU_FALLBACK')), [])
  assert.equal(digest(await readFile(fixture)), report.fixtureHash)
  assert.deepEqual(errors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
  if (page) {
    report.diagnostics = await page.evaluate(() => ({
      bodyText: document.body.innerText,
      status: [...document.querySelectorAll<HTMLElement>('.kernel-status')].map(element => ({ text: element.textContent, detail: element.title })),
      presentation: { ...document.querySelector<HTMLElement>('.kernel-presentation')?.dataset },
      probe: (window as any).__sketchPerformance,
    })).catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  }
  throw error
} finally {
  report.finishedAt = new Date().toISOString(); await save()
  await browser?.close()
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await application.close().catch(() => {})
  }
  await server?.close()
  console.log(`SKETCH_PERFORMANCE_OUTPUT ${output}`)
}
