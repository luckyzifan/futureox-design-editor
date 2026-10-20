/** Real-browser import + render-comparison checks for private fixtures.
 * Usage: bun scripts/check-fixture-import.ts [--fixture=/abs/path]...
 * Defaults to the locally available 111.sketch / .fig set when no --fixture
 * is passed. For each fixture this runs:
 *   1. UI file-input import in Chromium (web mode, Metal/ANGLE, GPU backend)
 *   2. structure report (pages/nodes/text/images) from the durable local store
 *   3. fit-view screenshot
 *   4. webgpu vs cpu render of the same camera, byte-hash + pixel-delta compare
 *   5. rapid zoom smoke: visual update cadence + preview-active fraction
 *   6. zoomed screenshot
 * Fixtures stay outside the repository; only hashes, counts and timings enter
 * the report. Screenshots land in DESIGN_FIXTURE_OUTPUT (default /private/tmp). */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const client = new URL('..', import.meta.url).pathname
const args = process.argv.slice(2)
const fixtureArgs = args.filter((a) => a.startsWith('--fixture=')).map((a) => a.slice(10))
const output = process.env.DESIGN_FIXTURE_OUTPUT || '/private/tmp/fixture-import-checks'
await mkdir(output, { recursive: true })
const fixtures = fixtureArgs.length
  ? fixtureArgs
  : [
      '/Users/Apple/Downloads/111.sketch',
      '/private/tmp/111-sanitized.sketch',
      '/Users/Apple/Downloads/01有料素材 (Copy) (1).fig',
      '/Users/Apple/Downloads/Forma 内核对照验收 2026-10-06.fig',
    ]

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
const server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
await server.listen()
const base = server.resolvedUrls!.local[0]
const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--use-angle=metal'] })

const report: Record<string, unknown>[] = []
try {
  for (const fixture of fixtures) {
    const label = path.basename(fixture).replace(/\.(sketch|fig)$/i, '')
    const entry: Record<string, unknown> = { fixture: path.basename(fixture), bytes: (await readFile(fixture)).length }
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const t0 = Date.now()
    const pageerrors: string[] = []
    page.on('pageerror', (e) => pageerrors.push(String(e).slice(0, 200)))
    page.setDefaultTimeout(180_000)
    try {
      await page.goto(base)
      await page.waitForFunction(() => document.querySelector('.app-shell')?.getAttribute('data-editor-ready') === 'true', null, { timeout: 120_000 })
      await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
      const admitted = await page.waitForFunction((expected) => {
        const message = document.querySelector('footer')?.textContent?.trim() || ''
        if (/^(Error|TypeError|RangeError):/.test(message)) return { error: message }
        const value = document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')?.value
        return value === expected ? { ok: true } : false
      }, label, { timeout: 180_000 })
      const value = await admitted.jsonValue()
      if ('error' in (value as object)) throw new Error((value as { error: string }).error)
      entry.importMs = Date.now() - t0
      const notice = page.getByRole('complementary', { name: '导入兼容提示' })
      if (await notice.count()) {
        const items = await notice.locator('li').allTextContents().catch(() => [])
        if (items.length) entry.importWarnings = items.slice(0, 6)
        const close = notice.getByRole('button', { name: '关闭导入提示' })
        if (await close.count()) await close.click()
      }
      // presentation-ready with progress polling (diagnose stalls)
      {
        const deadline = Date.now() + 240_000
        let ready = false
        while (Date.now() < deadline && !ready) {
          ready = await page.evaluate(() => document.querySelector('.kernel-presentation')?.getAttribute('data-presentation-ready') === 'true')
          if (ready) break
          await page.waitForTimeout(5_000)
          const state = await page.evaluate(() => {
            const p = document.querySelector('.kernel-presentation') as HTMLElement
            const status = document.querySelector('.kernel-status')
            return { state: p?.dataset.presentationState, fallback: p?.dataset.fallbackPhase, error: status?.className || '', errorText: (status?.textContent || '').slice(0, 120), footer: (document.querySelector('footer')?.textContent || '').slice(0, 120) }
          })
          entry.lastPresentationState = state
        }
        if (!ready) {
          await page.screenshot({ path: path.join(output, `${label}-stalled.png`) })
          throw new Error(`presentation never became ready: ${JSON.stringify(entry.lastPresentationState)}`)
        }
      }
      entry.firstRenderMs = Date.now() - t0

      // Structure from the durable local store.
      entry.structure = await page.evaluate(async () => {
        const { localOpen } = await import('/src/local-store.ts')
        const opened = await localOpen()
        if (!opened) return { error: 'document not persisted' }
        const doc = opened.document
        const nodes = Object.values(doc.nodes) as { kind: string }[]
        const kinds: Record<string, number> = {}
        for (const node of nodes) kinds[node.kind] = (kinds[node.kind] || 0) + 1
        return { pages: doc.pages.length, nodes: nodes.length, kinds }
      })
      await page.screenshot({ path: path.join(output, `${label}-fit.png`) })

      // Backend comparison: webgpu vs cpu, identical camera, pixel deltas.
      try {
        entry.backendCompare = await page.evaluate(async () => {
        const { localOpen } = await import('/src/local-store.ts')
        const doc = (await localOpen())!.document
        const { KernelClient } = await import('/src/kernel/client.ts')
        const sha = async (bytes: Uint8Array) =>
          Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 8).map((b) => b.toString(16).padStart(2, '')).join('')
        const p = document.querySelector('.kernel-presentation') as HTMLElement
        const cssZoom = +p.dataset.cameraZoom!, camX = +p.dataset.cameraX!, camY = +p.dataset.cameraY!
        const width = 1440, height = 960
        const cxw = -camX / cssZoom + width / cssZoom / 2, cyw = -camY / cssZoom + height / cssZoom / 2
        const worldX = cxw - width / cssZoom / 2, worldY = cyw - height / cssZoom / 2
        const results: Record<string, unknown> = {}
        const frames: Record<string, Uint8Array> = {}
        for (const backend of ['webgpu', 'cpu'] as const) {
          const c = new KernelClient()
          const start = performance.now()
          let r: any, factorUsed = 1
          // Probe the ladder with webgpu, then render BOTH backends at the
          // same factor so the pixel comparison stays valid.
          const ladder = backend === 'webgpu' ? [1, 8, 64, 256] : [(results as any).zoomFactor ?? 1]
          for (const factor of ladder) {
            const zoom = cssZoom * factor
            const vw = { x: -(cxw - width / zoom / 2) * zoom, y: -(cyw - height / zoom / 2) * zoom, zoom }
            try {
              r = await c.render(doc, { pageId: doc.pages[0].id, width, height, view: vw, transparent: false, grid: false, rasterProfile: 'figma' }, false, backend, true, false, undefined, undefined)
              factorUsed = factor
              ;(results as any).zoomFactor = factor
              break
            } catch (renderError) {
              if (backend === 'cpu' || factor === 256) throw renderError
              // zoom in further to reduce visible path count and retry
            }
          }
          frames[backend] = new Uint8Array(r.bytes)
          results[backend] = { ms: Math.round(performance.now() - start), renderMs: Math.round(r.renderMs),
            graphMs: Math.round(r.graphMs), sha256: await sha(new Uint8Array(r.bytes)), nodes: r.stats?.nodes, zoomFactor: factorUsed }
        }
        const a = frames.webgpu, b = frames.cpu
        if (!a || !b || a.length !== b.length) return { ...results, verdict: 'incomparable' }
        let differing = 0, maxDelta = 0, sumDelta = 0
        for (let i = 0; i < a.length; i += 4) {
          let pixelDelta = 0
          for (let c = 0; c < 4; c++) pixelDelta = Math.max(pixelDelta, Math.abs(a[i + c] - b[i + c]))
          if (pixelDelta > 2) differing++
          if (pixelDelta > maxDelta) maxDelta = pixelDelta
          sumDelta += pixelDelta
        }
        const pixels = a.length / 4
        return { ...results, verdict: 'compared',
          pixels, differingPixels: differing, differingPct: +(differing / pixels * 100).toFixed(3),
          maxChannelDelta: maxDelta, meanPixelDelta: +(sumDelta / pixels).toFixed(3) }
        })
      } catch (compareError) {
        entry.backendCompare = { error: String(compareError).slice(0, 300) }
      }

      // Zoom smoke: one rapid pinch cycle with cadence sampling.
      // (backendCompare errors above already throw into entry.error; to keep
      // the zoom smoke running for diagnostics, wrap it independently below.)
      const canvas = page.getByTestId('canvas')
      const box = await canvas.boundingBox()
      await canvas.focus()
      const cx = box!.x + box!.width / 2, cy = box!.y + box!.height / 2
      const cdp = await context.newCDPSession(page)
      await page.evaluate(() => {
        const w = window as any
        w.__states = []
        const sample = () => {
          const p = document.querySelector('.kernel-presentation') as HTMLElement
          if (p?.dataset) w.__states.push({ t: performance.now(), zoom: +p.dataset.cameraZoom, visual: +p.dataset.visualCameraZoom, preview: p.dataset.previewActive })
          setTimeout(sample, 100)
        }
        sample()
        w.__mark = (name: string) => { w.__marks = w.__marks || {}; w.__marks[name] = performance.now() }
      })
      await page.evaluate(() => (window as any).__mark('burst'))
      for (let i = 0; i < 120; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -220, modifiers: 2 })
        await page.waitForTimeout(14)
      }
      for (let i = 0; i < 120; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: 220, modifiers: 2 })
        await page.waitForTimeout(14)
      }
      await page.evaluate(() => (window as any).__mark('end'))
      await page.waitForTimeout(3000)
      entry.zoomSmoke = await page.evaluate(() => {
        const w = window as any
        const marks = w.__marks
        const states: { t: number; zoom: number; visual: number; preview: string }[] = w.__states
          .filter((s: any) => s.t >= marks.burst - 500 && s.t <= marks.end + 2000)
        const intervals: number[] = []
        for (let i = 1; i < states.length; i++) if (states[i].visual !== states[i - 1].visual) intervals.push(states[i].t - states[i - 1].t)
        const sorted = [...intervals].sort((a, b) => a - b)
        return { gestureMs: Math.round(marks.end - marks.burst),
          zoomRange: [Math.min(...states.map((s) => s.zoom)), Math.max(...states.map((s) => s.zoom))],
          previewActivePct: Math.round(states.filter((s) => s.preview === 'true').length / states.length * 100),
          visualUpdateP50Ms: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(0) : null,
          visualUpdateHz: intervals.length ? +(1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)).toFixed(1) : 0 }
      })
      await page.screenshot({ path: path.join(output, `${label}-zoomed.png`) })
      entry.pageErrors = pageerrors.slice(0, 4)
      entry.status = 'ok'
    } catch (error) {
      entry.status = 'failed'
      entry.error = String(error).slice(0, 400)
      entry.pageErrors = pageerrors.slice(0, 4)
    }
    report.push(entry)
    console.log(`FIXTURE ${JSON.stringify(entry)}`)
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}
console.log(JSON.stringify({ output, report }, null, 1))
