/** Frozen-source A/B: actual file input, zoom controls, pointer drag and undo.
 * Browser DOM/rAF timings are explicitly not hardware presentation latency. */
import { chromium, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'

const [source, fixture, output, repetitions = '3'] = process.argv.slice(2)
if (!source || !fixture || !output) throw Error('Usage: benchmark-figma-interaction.ts SOURCE_ROOT FIXTURE_FD OUTPUT [REPETITIONS]')
await mkdir(output, { recursive: true })
const root = resolve(source), rows: unknown[] = [], errors: string[] = []
const fixtureEnvelope = JSON.parse(await readFile(fixture, 'utf8'))
const fixtureDocument = fixtureEnvelope.document ?? fixtureEnvelope
const hashes: Record<string, string> = {}
for (const file of ['src/kernel/ProgressiveSurface.tsx', 'src/kernel/canvas-raster-plan.ts', 'src/kernel/tile-scheduler.ts',
  'src/Canvas.tsx', 'src/CanvasEditPreview.tsx', 'src/engine.ts', 'src/kernel/client.ts', 'src/kernel/render-worker.ts', 'public/kernel/design_kernel_bg.wasm'])
  hashes[file] = createHash('sha256').update(await readFile(join(root, file))).digest('hex')
hashes.fixture = createHash('sha256').update(await readFile(fixture)).digest('hex')
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  for (let repeat = 0; repeat < Number(repetitions); repeat++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 })
    page = await context.newPage(); const p = page
    p.on('pageerror', e => errors.push(String(e)))
    await p.addInitScript(() => localStorage.setItem('forma-render-backend', 'webgpu'))
    await p.goto(server.resolvedUrls!.local[0])
    await expect(p.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60000 })
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
    await expect(p.getByLabel('文档名称', { exact: true })).toHaveValue(fixtureDocument.name, { timeout: 60000 })
    await expect(p.locator('.document-transition')).toHaveCount(0, { timeout: 60000 })
    const canvas = p.getByTestId('canvas'), surface = p.locator('.kernel-tiles')
    const settle = async () => {
      await p.waitForFunction(() => !!document.querySelector('.kernel-status.error') ||
        document.querySelector<HTMLElement>('.kernel-tiles')?.dataset.detailReady === 'true', null, { timeout: 120000 })
      expect(await p.locator('.kernel-status.error').allTextContents()).toEqual([])
      await expect(surface).toHaveAttribute('data-renderer', 'webgpu')
    }
    await settle()
    const snapshot = () => surface.evaluate(el => ({ ...(el as HTMLElement).dataset }))
    const adapter = await p.evaluate(async () => {
      const info = (await navigator.gpu.requestAdapter())?.info
      return info && { vendor: info.vendor, architecture: info.architecture }
    })
    const stored = await p.evaluate(async () => (await (await import('/src/local-store.ts')).localOpen())!.document)
    if (Object.keys(stored.nodes).length !== 752) throw Error('Expected the fixed 752-node document')
    for (const percent of [25, 50, 100, 47.3, 50, 100]) {
      await p.getByLabel('缩放与视图设置', { exact: true }).click()
      const before = await snapshot(), start = performance.now()
      if (percent === 47.3) {
        await p.getByLabel('缩放比例', { exact: true }).fill(String(percent))
        await p.getByLabel('缩放比例', { exact: true }).press('Enter')
        await p.getByLabel('缩放与视图设置', { exact: true }).click()
      } else await p.getByRole('button', { name: `${percent}%`, exact: true }).click()
      await expect(surface).toHaveAttribute('data-requested-camera-zoom', String(percent / 100))
      await settle()
      rows.push({ repeat, operation: 'zoom', percent, wallMs: performance.now() - start, before, after: await snapshot(), adapter })
    }
    await p.mouse.move(5, 5)
    const canvasPixels = await canvas.screenshot({ path: join(output, `canvas-${repeat}.png`) })
    rows.push({ repeat, operation: 'canvas-hash', sha256: createHash('sha256').update(canvasPixels).digest('hex') })
    // Real layer selection and Shift+2 keep the same object visible on both builds.
    const group = Object.values(stored.nodes).find((n: any) => n.name === '组合 51') as any
    if (!group) throw Error('Missing group 51')
    await p.getByLabel('搜索图层', { exact: true }).fill(group.name)
    await p.getByTestId(`layer-${group.id}`).click()
    await p.getByLabel('搜索图层', { exact: true }).fill('')
    await canvas.focus(); await p.keyboard.press('Shift+2'); await settle()
    const bounds = await p.getByTestId('canvas-selection-outline').first().boundingBox()
    if (!bounds) throw Error('Missing selected group bounds')
    const x = bounds.x + bounds.width * .45, y = bounds.y + bounds.height * .55
    await p.mouse.move(x, y)
    await p.evaluate(() => {
      const records: { at: number; x: number; y: number; nextRafMs?: number }[] = []
      const handler = (e: PointerEvent) => {
        if (!e.buttons) return
        const row = { at: performance.now(), x: e.clientX, y: e.clientY, nextRafMs: undefined as number | undefined }
        records.push(row); requestAnimationFrame(() => { row.nextRafMs = performance.now() - row.at })
      }
      const probe = window as any; probe.__figmaInputProbe = { records, handler }
      document.addEventListener('pointermove', handler, true)
    })
    await p.mouse.down(); await p.mouse.move(x + 96, y + 32, { steps: 24 })
    // Resident GPU moves omit the separate DOM preview; observe the actual
    // canvas and verify the committed geometry below on both implementations.
    await expect(p.locator('.canvas-edit-status')).toBeVisible()
    const held = await canvas.evaluate(el => ({ ...(el as HTMLElement).dataset }))
    await p.screenshot({ path: join(output, `drag-${repeat}.png`) })
    const released = performance.now(); await p.mouse.up(); await settle()
    const inputs = await p.evaluate(() => {
      const probe = (window as any).__figmaInputProbe
      document.removeEventListener('pointermove', probe.handler, true)
      return probe.records
    })
    rows.push({ repeat, operation: 'drag', releaseToDetailMs: performance.now() - released, held, inputs, after: await snapshot() })
    expect(inputs.length).toBeGreaterThan(0)
    await expect.poll(() => p.evaluate(async id => (await (await import('/src/local-store.ts')).localOpen())!.document.nodes[id].transform, group.id))
      .not.toEqual(group.transform)
    await canvas.focus(); await p.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z'); await settle()
    await expect.poll(() => p.evaluate(async id => (await (await import('/src/local-store.ts')).localOpen())!.document.nodes[id].transform, group.id))
      .toEqual(group.transform)
    await context.close()
    await writeFile(join(output, 'progress.json'), JSON.stringify({ rows, errors }, null, 2))
  }
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', hashes, rows, errors,
    scope: 'Chromium Metal DPR2; actual input; DOM/rAF observations, not physical FPS or an interactive Figma app comparison' }, null, 2))
  console.log(JSON.stringify({ status: 'passed', output, observations: rows.length }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  const diagnostic = await page?.evaluate(() => ({ text: document.body.innerText,
    tiles: [...document.querySelectorAll('.kernel-tiles')].map(e => ({ ...(e as HTMLElement).dataset })) })).catch(() => null)
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), hashes, rows, errors, diagnostic }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); process.exitCode = 1
} finally { await browser?.close(); await server.close() }
