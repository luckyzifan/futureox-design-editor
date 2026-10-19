// Same edited document, WASM, worker, camera and profile: compare actual GPU
// pixels retained by bounded damage with a forced complete GPU repaint.
// This is a kernel/presentation oracle, not a substituted UI interaction test.
// The separate check-sketch-performance.ts records production UI operations.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const { values } = parseArgs({ options: {
  fixture: { type: 'string' }, document: { type: 'string' }, output: { type: 'string' },
  zoom: { type: 'string', default: '1' }, 'cpu-roi': { type: 'boolean' },
  'gpu-timings': { type: 'boolean' },
} })
assert.ok(values.fixture && path.isAbsolute(values.fixture), '--fixture requires an absolute .sketch path')
assert.match(values.fixture, /\.sketch$/i)
assert.ok(!values.document || path.isAbsolute(values.document), '--document requires an absolute imported JSON path')
assert.ok(!values.output || path.isAbsolute(values.output), '--output requires an absolute new private directory')
const zoom = Number(values.zoom); assert.ok(Number.isFinite(zoom) && zoom >= .25 && zoom <= 4)
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = values.output || await mkdtemp(path.join(tmpdir(), 'futureox-sketch-damage-oracle-'))
if (values.output) { await mkdir(path.dirname(output), { recursive: true }); await mkdir(output) }
const digest = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const original = await readFile(values.fixture), errors: string[] = [], logs: string[] = []
const sourceFiles = ['src/kernel/ProgressiveSurface.tsx', 'src/kernel/render-worker.ts',
  'src/kernel/tile-computation-key.ts', 'public/kernel/design_kernel_bg.wasm',
  '../../design-studio/crates/design-kernel/src/dirty_region.rs',
  '../../design-studio/crates/design-kernel/src/renderer.rs',
  '../../design-studio/crates/design-kernel/src/sketch/interop.rs']
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, digest(await readFile(path.join(client, file)))])))
const report: Record<string, any> = {
  status: 'running', startedAt: new Date().toISOString(), fixture: path.basename(values.fixture),
  fixtureHash: digest(original), inputKind: values.document ? 'saved imported document' : 'production Sketch import',
  sourceHashes: await sourceHashes(), zoom, errors,
  contract: {
    input: 'One unchanged edited document, explicit camera, page, renderer/profile/color policy and worker for local and forced full passes',
    local: 'Real pre-edit GPU tile pixels survive only outside kernel-certified damage; the worker renders every missing tile',
    full: 'Same warm worker; development exact-cache and certified-reuse bypasses force all tiles to compile and rasterize',
    equality: 'Every pixel of every planned tile, including gutters, compared byte for byte after actual production bitmap/byte presentation',
    cpu: 'Optional 64x64 changed-pixel ROI only, independently rendered by the Rust CPU path; not full-document CPU coverage',
    timing: 'Worker milliseconds reported separately from wall time and main-thread verification extraction',
  },
}
let server: Awaited<ReturnType<typeof createServer>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let page: Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>['newPage']>> | undefined
try {
  if (values['gpu-timings']) process.env.VITE_DESIGN_GPU_TIMINGS = '1'
  server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: true },
    plugins: [{ name: 'private-sketch-damage-oracle', configureServer(server) {
      server.middlewares.use('/__sketch_damage_oracle__', (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end('<!doctype html><html><body><input type="file" id="source"></body></html>')
      })
    } }],
  })
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => {
    const text = message.text()
    if (/^DESIGN_GPU_PROFILE |^SKETCH_DAMAGE /.test(text)) logs.push(text)
  })
  await page.goto(`${server.resolvedUrls!.local[0]}__sketch_damage_oracle__`)
  await page.locator('#source').setInputFiles(values.document || values.fixture)
  report.result = await page.evaluate(async ({ zoom, cpuRoi, expect117 }) => {
    const state: any = (window as any).__damageOracle = { phases: [], damages: [], scope: {}, status: 'running' }
    const fail = (message: string): never => { throw new Error(message) }
    const { readDesignFile } = await import('/src/persistence.ts')
    const { initializeKernelModule } = await import('/src/kernel/module.ts')
    const { planTilesAligned } = await import('/src/kernel/tile-plan-aligned.ts')
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { worldMatrix } = await import('/src/geometry.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    await initializeKernelModule()
    const source = document.querySelector<HTMLInputElement>('#source')!.files![0]
    const imported = await readDesignFile(source), doc = imported.document
    const effectCounts: Record<string, number> = {}
    for (const node of Object.values(doc.nodes)) for (const fx of node.effects)
      if (fx.visible) effectCounts[fx.kind] = (effectCounts[fx.kind] || 0) + 1
    const group = Object.values(doc.nodes).find(node => node.kind === 'group' && /^组合\s*23$/.test(node.name))
    if (!group) fail('The source must contain the actual editable group 23')
    if (expect117 && (effectCounts['background-blur'] !== 7 || effectCounts.blur !== 3))
      fail(`117 must use corrected native blur semantics (7 background, 3 foreground), got ${JSON.stringify(effectCounts)}`)
    const page = doc.pages[0]
    const artboard = page.children.map(id => doc.nodes[id]).find(node => node.kind === 'frame')
    if (!artboard) fail('The source must contain a top-level artboard')
    const matrix = worldMatrix(doc, artboard.id)
    if (matrix[1] !== 0 || matrix[2] !== 0 || matrix[0] !== 1 || matrix[3] !== 1)
      fail('This full-artboard oracle requires the original axis-aligned unit-scale artboard')
    const viewport = { x: matrix[4], y: matrix[5], width: artboard.width, height: artboard.height }
    const plan = planTilesAligned(viewport, zoom, 256, { x: 0, y: 0 })
    const options = { pageId: page.id, width: Math.ceil(artboard.width * zoom),
      height: Math.ceil(artboard.height * zoom), view: { x: 0, y: 0, zoom }, transparent: false,
      grid: false, rasterProfile: doc.rasterProfile || (doc.colorManagement ? 'figma' : 'analytic'),
      tileOwner: { documentId: doc.id, sessionEpoch: 1 } }
    const hash = async (bytes: Uint8Array | string) => {
      const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
      const digest = await crypto.subtle.digest('SHA-256', data)
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }
    state.scope = { nodes: Object.keys(doc.nodes).length, text: Object.values(doc.nodes).filter(node => node.kind === 'text').length,
      effectCounts, embeddedFonts: Object.keys(doc.fonts || {}).length, documentHash: await hash(JSON.stringify(doc)),
      artboard: { id: artboard.id, width: artboard.width, height: artboard.height, world: viewport },
      group: { id: group!.id, name: group!.name, children: group!.children.length },
      rasterProfile: options.rasterProfile, colorManagement: doc.colorManagement, zoom, tiles: plan.length }
    const c = new KernelClient(), pixels = new Map<string, Uint8Array>()
    let extractingMs = 0
    const capture = (tile: any) => {
      if (tile.backend !== 'webgpu') fail(`The GPU oracle cannot accept ${tile.backend} pixels`)
      const start = performance.now()
      let bytes: Uint8Array
      try {
        if (tile.bytes.byteLength) bytes = tile.bytes.slice()
        else {
          if (!tile.bitmap) fail('Missing actual tile pixels')
          const canvas = new OffscreenCanvas(tile.width, tile.height)
          const context = canvas.getContext('2d', { alpha: true, colorSpace: 'srgb' })!
          context.drawImage(tile.bitmap, 0, 0)
          bytes = new Uint8Array(context.getImageData(0, 0, tile.width, tile.height).data)
        }
        if (bytes.byteLength !== tile.width * tile.height * 4) fail('Incomplete pixel payload')
        pixels.set(tile.key, bytes)
      } finally { tile.bitmap?.close(); extractingMs += performance.now() - start }
    }
    const render = async (name: string, document: typeof doc, tiles: typeof plan, forceFull = false) => {
      const start = performance.now(), extractionStart = extractingMs
      const result = await c.render(document, { ...options, tileViewport: tiles }, false, 'webgpu', true, false,
        forceFull ? { disableExactTileCache: true, disableCertifiedTileReuse: true } : undefined, capture)
      const entry = { name, wallMs: performance.now() - start, extractionMs: extractingMs - extractionStart,
        requestedTiles: tiles.length, workerMs: result.milliseconds, compileMs: result.compileMs,
        graphMs: result.graphMs, checkpointMs: result.checkpointMs, finishMs: result.finishMs,
        cacheHits: result.tileCacheHits, certifiedHits: result.certifiedTileHits,
        previewTiles: result.previewTiles, drawCalls: result.drawCalls, cacheBytes: result.tileCacheBytes,
        peakTextureBytes: result.peakTextureBytes, reason: result.reason }
      state.phases.push(entry); console.info(`SKETCH_DAMAGE ${JSON.stringify(entry)}`)
      if (result.backend !== 'webgpu' || result.reason) fail(`Unexpected GPU execution/fallback: ${result.reason}`)
      return result
    }
    const fingerprints = async (map: Map<string, Uint8Array>) => Object.fromEntries(await Promise.all(
      plan.map(async tile => { const bytes = map.get(tile.key); if (!bytes) fail(`Missing tile ${tile.key}`)
        return [tile.key, await hash(bytes!)] })))
    const snapshot = () => new Map([...pixels].map(([key, value]) => [key, value.slice()]))
    const intersects = (tile: typeof plan[number], bounds: number[]) => {
      const x = tile.x / tile.zoom, y = tile.y / tile.zoom
      return x < bounds[0] + bounds[2] && x + tile.width / tile.zoom > bounds[0] &&
        y < bounds[1] + bounds[3] && y + tile.height / tile.zoom > bounds[1]
    }
    try {
      await render('baseline-full', doc, plan)
      const baseline = snapshot(); state.baselineHashes = await fingerprints(baseline)
      const transform = [...group!.transform] as typeof group.transform; transform[4] += 24
      const edited = { ...doc, nodes: { ...doc.nodes, [group!.id]: { ...group!, transform } } }
      c.onDamage = damage => {
        state.damages.push(damage)
        if (damage.full) pixels.clear()
        else if (damage.bounds) for (const tile of plan) if (intersects(tile, damage.bounds)) pixels.delete(tile.key)
      }
      await render('patch-sync-zero-tiles', edited, [])
      if (state.damages.length !== 1 || state.damages[0].full) fail('A bounded group edit must yield one bounded damage report')
      const missing = plan.filter(tile => !pixels.has(tile.key))
      if (!missing.length || missing.length >= plan.length) fail('This fixture must exercise both genuinely changed and retained GPU tiles')
      state.retainedTiles = plan.length - missing.length
      await render('bounded-local', edited, missing)
      const local = snapshot(); state.localHashes = await fingerprints(local)
      await render('forced-full-same-worker', edited, plan, true)
      const full = snapshot(); state.fullHashes = await fingerprints(full)
      let mismatchedBytes = 0, changedBytes = 0, maxDelta = 0
      let firstChanged: { x: number; y: number } | undefined
      for (const tile of plan) {
        const a = local.get(tile.key)!, b = full.get(tile.key)!, original = baseline.get(tile.key)!
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) { mismatchedBytes++; maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i])) }
          if (a[i] !== original[i]) {
            changedBytes++
            const pixel = Math.floor(i / 4), tx = pixel % tile.width, ty = Math.floor(pixel / tile.width)
            if (!firstChanged && tx > 0 && ty > 0 && tx < tile.width - 1 && ty < tile.height - 1)
              firstChanged = { x: tile.x + tx, y: tile.y + ty }
          }
        }
      }
      state.gpuEquality = { mismatchedBytes, maxDelta, comparedBytes: [...full.values()].reduce((n, bytes) => n + bytes.length, 0), changedBytes }
      if (mismatchedBytes) fail(`Local/full GPU pixels differ in ${mismatchedBytes} bytes (max ${maxDelta})`)
      if (!changedBytes || !firstChanged) fail('The oracle must cover actual changed design pixels')
      if (cpuRoi) {
        const roi = { x: Math.floor(firstChanged.x / 16) * 16, y: Math.floor(firstChanged.y / 16) * 16, width: 64, height: 64 }
        const engine = new VectorEngine()
        try {
          const font = await fetch('/fonts/NotoSansSC.ttf'); if (!font.ok) fail('Missing actual default font')
          engine.load_font(new Uint8Array(await font.arrayBuffer()))
          engine.load_document(JSON.stringify(edited))
          const started = performance.now(), bytes = engine.render_rgba(JSON.stringify({
            ...options, tileOwner: undefined, width: roi.width, height: roi.height,
            view: { x: -roi.x, y: -roi.y, zoom } }))
          const renderMs = performance.now() - started
          let different = 0, maximum = 0, compared = 0
          for (let y = 0; y < roi.height; y++) for (let x = 0; x < roi.width; x++) {
            const gx = roi.x + x, gy = roi.y + y
            const tile = plan.find(tile => gx >= tile.x + 1 && gx < tile.x + tile.width - 1 &&
              gy >= tile.y + 1 && gy < tile.y + tile.height - 1)
            if (!tile) continue
            const gpu = full.get(tile.key)!, offset = ((gy - tile.y) * tile.width + gx - tile.x) * 4
            for (let channel = 0; channel < 4; channel++) {
              const delta = Math.abs(bytes[(y * roi.width + x) * 4 + channel] - gpu[offset + channel])
              if (delta) different++
              maximum = Math.max(maximum, delta); compared++
            }
          }
          state.cpuRoi = { roi, renderMs, mismatchedBytes: different, maxDelta: maximum, comparedBytes: compared }
          if (different) fail(`Independent CPU ROI differs in ${different} bytes (max ${maximum}); investigate crop/backend parity`)
        } finally { engine.free() }
      }
      state.editedDocumentHash = await hash(JSON.stringify(edited)); state.status = 'passed'
      return state
    } catch (error) { state.status = 'failed'; state.error = String(error); throw error }
    finally { c.dispose() }
  }, { zoom, cpuRoi: !!values['cpu-roi'], expect117: path.basename(values.fixture) === '117.sketch' })
  assert.deepEqual(errors, [])
  assert.equal(digest(await readFile(values.fixture)), report.fixtureHash)
  assert.deepEqual(await sourceHashes(), report.sourceHashes, 'The tested production source/WASM changed during the run')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
  if (page) report.result = await page.evaluate(() => (window as any).__damageOracle).catch(() => null)
  throw error
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  await writeFile(path.join(output, 'gpu-log.json'), JSON.stringify(logs, null, 2))
  await browser?.close(); await server?.close()
  console.log(`SKETCH_DAMAGE_OUTPUT ${output}`)
}
