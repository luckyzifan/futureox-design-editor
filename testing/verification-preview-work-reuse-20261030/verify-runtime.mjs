// Sequential production-planner A/B and real-browser preview integration.
// Synthetic fixtures, no whole-editor/GPU throughput or real117 claim.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const out = dirname(fileURLToPath(import.meta.url)), repo = resolve(out, '../..'), client = resolve(repo, 'frontend/design-client')
const require = createRequire(resolve(client, 'package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium } = require('@playwright/test')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const baseline = JSON.parse(await readFile(resolve(out, 'baseline.json'), 'utf8'))
const sourceHashes = async () => Object.fromEntries(await Promise.all(Object.keys(baseline.files).map(async p => [p, hash(await readFile(resolve(repo, p)))])))
const before = await sourceHashes()
for (const [p, expected] of Object.entries(baseline.files)) assert.equal(hash(await readFile(resolve(out, 'before', p))), expected)
const original = async relative => (await readFile(resolve(out, 'before/frontend/design-client/src', relative), 'utf8'))
  .replace(/(from\s+|import\s*)['"](\.[^'"]+)['"]/g, (_all, prefix, specifier) =>
    `${prefix}${JSON.stringify('/src/' + resolve('/' + dirname(relative), specifier).slice(1))}`)
const server = await createServer({ root: client, plugins: [{ name: 'frozen-preview-preimage',
  resolveId(id) { if (id.startsWith('/__work_reuse_')) return id },
  async load(id) {
    if (id === '/__work_reuse_layers.ts') return original('kernel/interaction-layers.ts')
    if (id === '/__work_reuse_preview.tsx') return original('CanvasEditPreview.tsx')
    if (id === '/__work_reuse_deps') return `export {default as React} from 'react';export {createRoot} from 'react-dom/client';export {flushSync} from 'react-dom'`
  },
  configureServer(s) { s.middlewares.use('/__work-reuse', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    void s.transformIndexHtml('/__work-reuse', '<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="margin:0"></body></html>').then(html => res.end(html))
  }) },
}], server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser
try {
  if (!process.argv.includes('--browser-only')) {
  const { initializePicking } = await server.ssrLoadModule('/src/kernel/picking.ts')
  await initializePicking({ wasm: new Uint8Array(await readFile(resolve(client, 'public/kernel/design_kernel_bg.wasm'))),
    font: new Uint8Array(await readFile(resolve(client, 'public/fonts/NotoSansSC.ttf'))) })
  const { blank, node, effect } = await server.ssrLoadModule('/src/model.ts')
  const { CanvasSceneSnapshots } = await server.ssrLoadModule('/src/canvas-scene-snapshots.ts')
  const current = await server.ssrLoadModule('/src/kernel/interaction-layers.ts')
  const old = await server.ssrLoadModule('/__work_reuse_layers.ts')
  const camera = i => ({ x: i * 37.125 - 250, y: i * 3.25 - 15, width: 640 + i * 10.5, height: 480 })
  let comparisons = 0
  for (let seed = 0; seed < 160; seed++) {
    const doc = blank(), roots = []
    for (let r = 0; r < 9; r++) {
      const root = node('group', r * 100.125, (r % 3) * 75.25, 80, 60)
      root.blend = seed % 2 ? 'normal' : 'pass-through'; root.fills = []; root.strokes = []
      root.transform = [1, .125 * (seed % 3), -.25, 1, r * 100.125, r * 75.25]
      for (let c = 0; c < 3; c++) {
        const child = node('rectangle', c * 17.25, c * 21.125, 15.125 + seed / 3, 25.375)
        if (seed % 5 === 0) child.effects = [{ ...effect('shadow'), radius: 5.125, spread: 2, x: -7.375, y: 9.625 }]
        if (seed % 11 === 0 && c === 1) child.effects = [effect('glass')]
        if (seed % 13 === 0 && r === 8 && c === 2) child.effects = [{ ...effect('blur'), kind: 'unknown' }]
        if (seed % 17 === 0 && c === 0) child.visible = false
        root.children.push(child.id); doc.nodes[child.id] = child
      }
      doc.nodes[root.id] = root; roots.push(root)
    }
    doc.pages[0].children = roots.map(r => r.id)
    const ids = seed % 3 ? [roots[1].id, roots[4].id, roots[7].id] : [roots[1].children[1], roots[4].children[2]]
    const store = new CanvasSceneSnapshots(), page = doc.pages[0].id
    store.begin({}, 1, page, true); store.currentScene(doc, page)
    const options = { scene: store.borrowCurrentScene(doc, page, 1), epoch: 1, neutralPageGroup: seed % 2 === 0 }
    const planner = new current.InteractionLayerPlanner()
    for (let i = 0; i < 8; i++) {
      const view = i ? camera(i) : undefined, expected = old.planInteractionLayers(doc, page, ids, view, options)
      assert.deepEqual(current.planInteractionLayers(doc, page, ids, view, options), expected)
      assert.deepEqual(planner.plan(doc, page, ids, view, options), expected)
      comparisons += 2
    }
  }
  const metrics = []
  for (const count of [300, 3000, 20000]) {
    const doc = blank(), roots = []
    for (let i = 0; i < count; i++) {
      const root = node('rectangle', (i % 100) * 31.125, Math.floor(i / 100) * 35.375, 20.5, 25.25)
      doc.nodes[root.id] = root; roots.push(root.id)
    }
    doc.pages[0].children = roots
    const page = doc.pages[0].id, ids = Array.from({ length: 16 }, (_, i) => roots[Math.floor((i + 1) * count / 17)])
    const store = new CanvasSceneSnapshots(); store.begin({}, 1, page, true); store.currentScene(doc, page)
    const options = { scene: store.borrowCurrentScene(doc, page, 1), epoch: 1 }, planner = new current.InteractionLayerPlanner()
    assert.deepEqual(planner.plan(doc, page, ids, camera(0), options), old.planInteractionLayers(doc, page, ids, camera(0), options))
    const rounds = { baseline: [], candidate: [], coldCandidate: [] }
    for (let round = -1; round < 7; round++) {
      for (const label of (round % 2 === 0 ? ['candidate', 'baseline'] : ['baseline', 'candidate'])) {
        const started = performance.now()
        for (let i = 0; i < 20; i++) (label === 'baseline' ? old.planInteractionLayers(doc, page, ids, camera(i), options)
          : planner.plan(doc, page, ids, camera(i), options))
        if (round >= 0) rounds[label].push((performance.now() - started) / 20)
      }
      planner.clear()
      const started = performance.now(); planner.plan(doc, page, ids, camera(0), options)
      if (round >= 0) rounds.coldCandidate.push(performance.now() - started)
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
    metrics.push({ count, selected: 16, units: 'milliseconds per planner call', rounds,
      median: Object.fromEntries(Object.entries(rounds).map(([key, values]) => [key, median(values)])) })
  }
  await writeFile(resolve(out, 'planner-results.json'), JSON.stringify({ comparisons, metrics, evidence: 'CPU isolated, production TS/WASM planner; synthetic vector fixtures' }, null, 2))
  console.log(JSON.stringify({ comparisons, metrics: metrics.map(({ count, median }) => ({ count, median })) }))
  }

  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 })
  const errors = []; page.on('pageerror', error => errors.push(String(error)))
  await page.goto(server.resolvedUrls.local[0] + '__work-reuse')
  await page.evaluate(async () => {
    const { React, createRoot, flushSync } = await import('/__work_reuse_deps')
    const { initializePicking } = await import('/src/kernel/picking.ts'); await initializePicking()
    const { blank, node, paint } = await import('/src/model.ts')
    const { CanvasEditPreview: candidate } = await import('/src/CanvasEditPreview.tsx')
    const { CanvasEditPreview: baseline } = await import('/__work_reuse_preview.tsx')
    const { supportsEditPreview } = await import('/src/edit-preview.ts')
    const doc = blank(), rootNode = node('rectangle', 50, 50, 80, 80)
    doc.pages[0].background = '#ffffff'
    rootNode.fills = [paint('#ff0000')]; doc.nodes[rootNode.id] = rootNode; doc.pages[0].children = [rootNode.id]
    const source = document.createElement('div'); Object.assign(source.style, { position: 'relative', width: '320px', height: '240px' })
    source.innerHTML = '<div class="kernel-presentation" data-presentation-ready="true"><canvas width="320" height="240" style="width:320px;height:240px"></canvas></div>'
    const mount = document.createElement('div'); source.append(mount); document.body.replaceChildren(source)
    const canvas = source.querySelector('canvas'), ctx = canvas.getContext('2d')
    let reactRoot, component
    const props = { document: doc, baseDocument: doc, selection: [rootNode.id], pageId: doc.pages[0].id,
      view: { x: 0, y: 0, zoom: 1 }, size: { width: 320, height: 240 }, visible: false, inputAt: 0,
      sourceHost: { current: source }, control: { current: null }, canCapture: true, vectorSupported: false, epoch: 1,
      vectorSupport: { document: doc, pageId: doc.pages[0].id, supported: supportsEditPreview(doc, doc.pages[0].id) } }
    const probe = window.__reuse = { copies: 0, props, start(label, vectorSupported = false) {
      reactRoot && flushSync(() => reactRoot.unmount()); reactRoot = createRoot(mount); component = label === 'baseline' ? baseline : candidate
      props.view = { x: 0, y: 0, zoom: 1 }; props.visible = false; props.vectorSupported = vectorSupported
      this.copies = 0; this.paint()
    }, paint() {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 320, 240); ctx.fillStyle = '#ff0000'; ctx.fillRect(50 + props.view.x, 50, 80, 80)
      props.captureFrame = { document: doc, pageId: props.pageId, epoch: 1, view: props.view, width: 320, height: 240, pixelRatio: 1 }
      flushSync(() => reactRoot.render(React.createElement(component, props)))
    }, pan(x) { props.view = { x, y: 0, zoom: 1 }; this.paint() },
    move() { return props.control.current.apply(doc, rootNode.id, [1, 0, 0, 1, 60, 50]) },
    destroy() { flushSync(() => reactRoot.unmount()) } }
    const drawImage = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function(...args) { probe.copies++; return drawImage.apply(this, args) }
  })
  const results = [], screenshots = {}
  for (const label of ['baseline', 'candidate']) {
    await page.evaluate(label => window.__reuse.start(label), label)
    await page.waitForTimeout(200)
    const initialCopies = await page.evaluate(() => window.__reuse.copies)
    assert.equal(initialCopies, 2)
    assert.equal(await page.evaluate(() => window.__reuse.move()), true)
    screenshots[label] = await page.screenshot({ path: resolve(out, `${label}-bitmap-move.png`) })
    await page.evaluate(() => window.__reuse.props.control.current.restore())
    const burst = await page.evaluate(async () => {
      const p = window.__reuse, before = p.copies
      for (let x = 1; x <= 30; x++) { p.pan(x); await new Promise(resolve => setTimeout(resolve, 16)) }
      return p.copies - before
    })
    await page.waitForTimeout(200)
    const finalCopies = await page.evaluate(() => window.__reuse.copies)
    assert.equal(burst, label === 'baseline' ? 60 : 0)
    assert.equal(finalCopies, label === 'baseline' ? 62 : 4)
    results.push({ label, initialCopies, burstCopies: burst, finalCopies })
  }
  assert.deepEqual(screenshots.candidate, screenshots.baseline, 'same moved bitmap must produce identical browser screenshot bytes')
  await page.evaluate(() => window.__reuse.start('candidate', true)); await page.waitForTimeout(200)
  assert.equal(await page.evaluate(() => window.__reuse.copies), 0)
  assert.equal(await page.evaluate(() => window.__reuse.move()), true)
  const svgScreenshot = await page.screenshot({ path: resolve(out, 'candidate-svg-move.png') })
  assert.deepEqual(svgScreenshot, screenshots.candidate, 'simple vector and bitmap moves agree with the same source fixture')
  await page.evaluate(() => window.__reuse.destroy())
  assert.deepEqual(errors, [])
  await writeFile(resolve(out, 'browser-results.json'), JSON.stringify({ results, svgCopies: 0, sameMovedBitmap: true,
    browser: await browser.version(), evidence: 'Chromium headless real React/SVG/Canvas2D and screenshots; not whole-app/hardware-GPU acceptance' }, null, 2))
  assert.deepEqual(await sourceHashes(), before, 'production sources changed during validation')
  await writeFile(resolve(out, 'runtime-sources.json'), JSON.stringify({ sources: before,
    wasm: hash(await readFile(resolve(client, 'public/kernel/design_kernel_bg.wasm'))), node: process.version }, null, 2))
  console.log(JSON.stringify({ browser: results, screenshotEqual: true }))
} finally { await browser?.close(); await server.close() }
