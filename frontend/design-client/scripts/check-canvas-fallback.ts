/** Private-browser failure acceptance. Only the designated fixture can fail:
 * GPU render throws before touching pixels; CPU requests pause before invoking
 * the real worker. No geometry, shader, CPU result, or comparison is replaced. */
import { chromium, expect, type Page } from '@playwright/test'
import { createServer, type Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { blank, node, paint } from '../src/model'
import { defaultColorSettings } from '../src/color'

const root = resolve(import.meta.dir, '..')
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-canvas-fallback-'))
await mkdir(output, { recursive: true })
const fixture = blank('精确画布故障回退验收')
const marker = node('rectangle', 65, 75, 211, 145)
marker.name = '受控 GPU 故障节点'
marker.fills = [paint('#157ecb')]
const circle = node('ellipse', 320, 130, 135, 135)
circle.fills = [paint('#f58139')]
fixture.nodes = { [marker.id]: marker, [circle.id]: circle }
fixture.pages[0].children = [marker.id, circle.id]
const fixturePath = join(output, 'controlled-fallback.fd')
await writeFile(fixturePath, JSON.stringify(fixture, null, 2))
const injectedGpuEvents: unknown[] = [], transforms: { path: string; hash: string }[] = []
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = ['src/kernel/Surface.tsx', 'src/kernel/ProgressiveSurface.tsx', 'src/kernel/client.ts', 'src/kernel/gpu/renderer.ts', 'src/kernel/color-presenter.ts', 'src/Canvas.tsx']
const sourceBefore = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(root, path)))])))
const cpuWrapper = `
const __fallbackOriginalRender = KernelClient.prototype.render;
KernelClient.prototype.render = function(...args) {
  const [document, options, png = false, backend = backendPreference()] = args;
  const marker = document.nodes[${JSON.stringify(marker.id)}];
  if (!marker || marker.width < 322 || backend !== 'cpu' || png) return __fallbackOriginalRender.apply(this, args);
  const probe = window.__fallbackProbe;
  if (!probe) throw new Error('Missing isolated fallback probe');
  const request = { width: marker.width, documentId: document.id, view: { ...options.view }, stage: 'held' };
  probe.requests.push(request);
  return new Promise(resolve => {
    if (probe.released) resolve(); else probe.gates.push(resolve);
  }).then(async () => {
    if (marker.width >= 433) {
      request.stage = 'injected-error';
      throw new Error('TEST_CPU_FAILURE: controlled fixture CPU failure');
    }
    request.stage = 'rendering-real-cpu';
    const result = await __fallbackOriginalRender.apply(this, args);
    request.stage = 'real-cpu-completed'; request.backend = result.backend;
    request.linearLength = result.linear?.length || 0;
    if (result.linear) {
      let peak = -Infinity; for (const value of result.linear) peak = Math.max(peak, value);
      request.linearPeak = peak;
    }
    return result;
  });
};
`
const managedWrapper = `
const __fallbackOriginalPresent = ColorPresenter.prototype.present;
ColorPresenter.prototype.present = function(...args) {
  if (window.__fallbackProbe?.failManagedDisplay && this.canvas.getAttribute('aria-label') === '广色域 HDR 显示输出') {
    window.__fallbackProbe.managedFailures++;
    throw new Error('TEST_HDR_DISPLAY_FAILURE: controlled managed presenter failure');
  }
  return __fallbackOriginalPresent.apply(this, args);
};
`
const injection: Plugin = {
  name: 'private-canvas-fallback-probe', enforce: 'pre',
  configureServer(server) {
    server.middlewares.use('/__fallback_probe_gpu', (request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk); if (body.length > 4096) request.destroy() })
      request.on('end', () => {
        injectedGpuEvents.push(JSON.parse(body))
        response.writeHead(204); response.end()
      })
    })
  },
  transform(source, id) {
    const path = id.split('?')[0]
    if (path === join(root, 'src/kernel/gpu/renderer.ts')) {
      const anchor = '  async render(scene: GpuScene, readback = false, present = true) {'
      if (source.split(anchor).length !== 2) throw Error('GPU fault-injection anchor changed')
      transforms.push({ path, hash: hash(source) })
      return source.replace(anchor, `${anchor}
        const injectedMarker = scene.nodes[${JSON.stringify(marker.id)}];
        if (injectedMarker && injectedMarker.size[0] >= 322) {
          await fetch('/__fallback_probe_gpu', { method: 'POST', body: JSON.stringify({
            nodeId: injectedMarker.id, width: injectedMarker.size[0], backend: this.driver.name,
            error: 'GPU 表面内存预算超限 [TEST_GPU_FALLBACK]'
          }) });
          throw new Error('GPU 表面内存预算超限 [TEST_GPU_FALLBACK]');
        }
      `)
    }
    if (path === join(root, 'src/kernel/client.ts')) {
      transforms.push({ path, hash: hash(source) })
      return source + cpuWrapper
    }
    if (path === join(root, 'src/kernel/color-presenter.ts')) {
      transforms.push({ path, hash: hash(source) })
      return source + managedWrapper
    }
  },
}
const server = await createServer({ root, plugins: [injection], server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, currentPage: Page | undefined
const cases: unknown[] = [], errors: string[] = []

async function installProbe(page: Page) {
  await page.addInitScript(() => {
    const probe = { requests: [] as any[], gates: [] as (() => void)[], released: false, failManagedDisplay: false, managedFailures: 0,
      running: false, samples: [] as any[], release() { this.released = true; for (const done of this.gates.splice(0)) done() } }
    ;(window as any).__fallbackProbe = probe
    const visible = (element: Element) => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    function sample() {
      if (probe.running) {
        const host = document.querySelector('[data-testid=canvas]')!, bounds = host.getBoundingClientRect()
        const canvases = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible=true]')].filter(visible)
        const rectangles = canvases.map(c => c.getBoundingClientRect())
        let uncovered = 0
        for (const fx of [0.04, 0.25, 0.5, 0.75, 0.96]) for (const fy of [0.04, 0.3, 0.6, 0.96]) {
          const x = bounds.left + bounds.width * fx, y = bounds.top + bounds.height * fy
          if (!rectangles.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) uncovered++
        }
        const overlay = host.querySelector<SVGGElement>('svg.stage > g')?.transform.baseVal.consolidate()?.matrix
        probe.samples.push({ at: performance.now(), uncovered, visible: canvases.length,
          kinds: [...new Set(canvases.map(c => c.dataset.renderer))],
          identity: canvases.map(c => c.dataset.tileKey ? `${c.dataset.tileKey}/${c.dataset.tileSerial}` : `cpu:${c.width}:${c.height}`).sort(),
          overlay: overlay && { x: overlay.e, y: overlay.f, zoom: overlay.a },
          surfaces: [...host.querySelectorAll<HTMLElement>('.kernel-presentation,.kernel-tiles,.kernel-reference')].map(el => ({ ...el.dataset })),
          errors: [...host.querySelectorAll('.kernel-status.error')].map(el => el.textContent),
        })
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}
async function frame(page: Page) {
  return page.locator('[data-testid=canvas]').evaluate(async host => {
    const visible = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible=true]')]
      .filter(c => c.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
    return (await Promise.all(visible.map(async c => ({
      key: c.dataset.tileKey || 'reference', serial: c.dataset.tileSerial || '',
      renderer: c.dataset.renderer, label: c.getAttribute('aria-label'), transport: c.dataset.transport, width: c.width, height: c.height,
      rect: { x: c.getBoundingClientRect().x, y: c.getBoundingClientRect().y, width: c.getBoundingClientRect().width, height: c.getBoundingClientRect().height },
      pixels: [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c.toDataURL())))].map(v => v.toString(16).padStart(2, '0')).join(''),
    })))).sort((a, b) => a.key.localeCompare(b.key) || a.serial.localeCompare(b.serial))
  })
}
async function waitFrames(page: Page, count = 12) {
  await page.evaluate(count => new Promise<void>(resolve => {
    let remaining = count
    const tick = () => --remaining ? requestAnimationFrame(tick) : resolve()
    requestAnimationFrame(tick)
  }), count)
}
async function setWidth(page: Page, value: number) {
  // Re-selecting an already selected layer also recentres the camera. Keep
  // this property-edit fault independent of an unrelated held camera request.
  if (await page.locator('.inspector').getAttribute('data-node-id') !== marker.id)
    await page.getByTestId(`layer-${marker.id}`).click()
  await page.getByLabel('W', { exact: true }).fill(String(value))
  await page.getByLabel('W', { exact: true }).press('Enter')
  await expect.poll(async () => page.evaluate(async id => {
    const { localOpen } = await import('/src/local-store.ts')
    return (await localOpen())?.document.nodes[id].width
  }, marker.id)).toBe(value)
}
async function held(page: Page, width: number) {
  await expect.poll(() => page.evaluate(width => (window as any).__fallbackProbe.requests.some((r: any) => r.width === width && r.stage === 'held'), width), { timeout: 60_000 }).toBe(true)
}
async function release(page: Page) { await page.evaluate(() => (window as any).__fallbackProbe.release()) }
async function probe(page: Page) {
  return page.evaluate(() => { const p = (window as any).__fallbackProbe; return { requests: p.requests, samples: p.samples, managedFailures: p.managedFailures } })
}
async function assertHeld(page: Page, old: Awaited<ReturnType<typeof frame>>, label: string) {
  await waitFrames(page)
  expect(await frame(page)).toEqual(old)
  await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-fallback-phase', 'pending')
  await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'false')
  await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-backend', 'gpu')
  await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'false')
  await expect(page.locator('canvas[data-frame-visible=true][data-renderer=cpu]')).toHaveCount(0)
  await page.screenshot({ path: join(output, `${label}.png`) })
}
try {
  await server.listen()
  const address = server.httpServer!.address()
  if (!address || typeof address === 'string') throw Error('Owned Vite port missing')
  const base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  // A GPU render may succeed while displaying its transferred bitmap fails.
  // Exercise that distinct boundary: the old complete frame must survive,
  // and a failed tile must never publish an incomplete new document.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
    const page = currentPage = await context.newPage()
    page.on('pageerror', error => errors.push(String(error)))
    await installProbe(page)
    await page.addInitScript(() => {
      const draw = CanvasRenderingContext2D.prototype.drawImage
      CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
        if ((window as any).__failTileDisplay && this.canvas.dataset.tileKey && this.canvas.dataset.lod === 'exact')
          throw new Error('TEST_TILE_DISPLAY_FAILURE')
        return (draw as any).apply(this, args)
      }
    })
    await page.goto(base)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
    await expect(page.getByLabel('文档名称')).toHaveValue(fixture.name)
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 60_000 })
    const initial = await frame(page)
    expect(initial.length).toBeGreaterThan(0)
    await page.evaluate(() => { (window as any).__failTileDisplay = true; (window as any).__fallbackProbe.running = true })
    await setWidth(page, 250)
    await expect(page.locator('.kernel-status.error')).toContainText('TEST_TILE_DISPLAY_FAILURE', { timeout: 60_000 })
    await waitFrames(page)
    expect(await frame(page)).toEqual(initial)
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'false')
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'false')
    await page.screenshot({ path: join(output, 'tile-display-failure-retains-frame.png') })
    await page.evaluate(() => { (window as any).__failTileDisplay = false })
    await setWidth(page, 260)
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 60_000 })
    expect(await frame(page)).not.toEqual(initial)
    await page.evaluate(() => { (window as any).__fallbackProbe.running = false })
    const result = await probe(page)
    expect(result.samples.every((s: any) => s.visible > 0 && s.uncovered === 0)).toBe(true)
    cases.push({ label: 'tile-display-failure-and-recovery', ...result })
    await context.close(); currentPage = undefined
  }
  for (const [width, height, dpr] of [[3200, 1800, 2], [2400, 1400, 3]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr })
    const page = currentPage = await context.newPage()
    page.on('pageerror', error => errors.push(String(error)))
    await installProbe(page)
    await page.goto(base)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
    await expect(page.getByLabel('文档名称')).toHaveValue(fixture.name)
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 90_000 })
    await page.evaluate(() => { (window as any).__fallbackProbe.running = true })
    const canvas = page.getByTestId('canvas'), box = await canvas.boundingBox()
    if (!box) throw new Error('Missing high-DPI canvas')
    await canvas.focus(); await page.keyboard.down('Space')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 17, box.y + box.height / 2 + 11, { steps: 5 })
    await page.mouse.up(); await page.keyboard.up('Space')
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 90_000 })
    await waitFrames(page)
    expect(await page.locator('.kernel-status.error').allTextContents()).toEqual([])
    const metrics = await page.locator('.kernel-tiles').evaluate(el => ({ ...(el as HTMLElement).dataset }))
    expect(Number(metrics.residentBytes)).toBeLessThanOrEqual(Number(metrics.residentBudget))
    expect(Number(metrics.pixelRatio)).toBe(dpr)
    await page.evaluate(() => { (window as any).__fallbackProbe.running = false })
    const result = await probe(page)
    expect(result.samples.at(-1)?.uncovered).toBe(0)
    cases.push({ label: `high-dpi-${width}-${dpr}`, metrics, ...result })
    await page.screenshot({ path: join(output, `high-dpi-${width}-${dpr}.png`) })
    await page.setViewportSize({ width: 1280, height: 820 })
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 90_000 })
    await waitFrames(page)
    const resized = await page.locator('.kernel-tiles').evaluate(el => ({ ...(el as HTMLElement).dataset }))
    expect(Number(resized.residentBytes)).toBeLessThanOrEqual(Number(resized.residentBudget))
    expect(Number(resized.residentBudget)).toBeLessThan(Number(metrics.residentBudget))
    Object.assign(cases.at(-1)!, { resized })
    await context.close(); currentPage = undefined
  }
  for (const immediateFailure of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
    const page = currentPage = await context.newPage()
    const label = immediateFailure ? 'first-cpu-fails' : 'cpu-success-then-fails'
    page.on('pageerror', error => errors.push(String(error)))
    await installProbe(page)
    await page.goto(base)
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
    await expect(page.getByLabel('文档名称')).toHaveValue(fixture.name)
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'true', { timeout: 60_000 })
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-renderer', /webgpu|webgl2/)
    const initial = await frame(page)
    expect(initial.length).toBeGreaterThan(0)
    await page.screenshot({ path: join(output, `${label}-initial-real-gpu.png`) })
    await page.evaluate(() => { (window as any).__fallbackProbe.running = true })
    await setWidth(page, immediateFailure ? 433 : 322)
    await held(page, immediateFailure ? 433 : 322)
    await assertHeld(page, initial, `${label}-cpu-held`)
    if (!immediateFailure) {
      await page.getByTestId('canvas').focus()
      await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+=`)
      await expect(page.getByLabel('缩放与视图设置')).toHaveText('200%')
      await assertHeld(page, initial, `${label}-requested-zoom-held`)
    }
    await release(page)
    if (immediateFailure) {
      await expect(page.locator('.kernel-status.error')).toContainText('TEST_CPU_FAILURE', { timeout: 30_000 })
      await waitFrames(page)
      expect(await frame(page)).toEqual(initial)
      await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'false')
    } else {
      await expect(page.locator('canvas.kernel-surface[data-frame-visible=true][data-renderer=cpu]')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.kernel-tiles')).toHaveCount(0)
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-fallback-phase', 'cpu')
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true')
      await waitFrames(page)
      const cpu = await frame(page)
      expect(cpu).toHaveLength(1)
      expect(cpu[0].renderer).toBe('cpu')
      expect(cpu[0].pixels).not.toBe(initial[0].pixels)
      const beforeFailure = await probe(page)
      const cpuSamples = beforeFailure.samples.filter((s: any) => s.kinds.includes('cpu'))
      expect(cpuSamples.length).toBeGreaterThan(0)
      expect(cpuSamples.every((s: any) => s.overlay?.zoom === 2)).toBe(true)
      expect(beforeFailure.requests.some((r: any) => r.stage === 'real-cpu-completed' && r.backend === 'cpu' && r.view.zoom === 2)).toBe(true)
      await page.screenshot({ path: join(output, `${label}-complete-real-cpu.png`) })
      await page.evaluate(() => { const p = (window as any).__fallbackProbe; p.released = false })
      await setWidth(page, 433); await held(page, 433)
      await waitFrames(page); expect(await frame(page)).toEqual(cpu)
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'false')
      await release(page)
      await expect(page.locator('.kernel-status.error')).toContainText('TEST_CPU_FAILURE', { timeout: 30_000 })
      await waitFrames(page); expect(await frame(page)).toEqual(cpu)
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'false')
    }
    await page.screenshot({ path: join(output, `${label}-error-retains-complete-frame.png`) })
    await page.evaluate(() => { (window as any).__fallbackProbe.running = false })
    const result = await probe(page)
    expect(result.samples.length).toBeGreaterThan(20)
    expect(result.samples.every((sample: any) => sample.visible > 0 && sample.uncovered === 0)).toBe(true)
    expect(result.samples.every((sample: any) => sample.kinds.length === 1)).toBe(true)
    cases.push({ label, ...result })
    await writeFile(join(output, `${label}-trace.json`), JSON.stringify(result, null, 2))
    await context.close(); currentPage = undefined
  }
  const hdrFixture = structuredClone(fixture)
  hdrFixture.name = '浮点画布故障回退验收'
  hdrFixture.schemaVersion = 5
  hdrFixture.rasterProfile = 'figma'
  hdrFixture.colorManagement = { ...defaultColorSettings(), documentSpace: 'rec2100-linear' }
  hdrFixture.nodes[marker.id].fills = [paint('color(rec2100-linear 2 0.1 0.1)')]
  const hdrFixturePath = join(output, 'controlled-hdr-fallback.fd')
  await writeFile(hdrFixturePath, JSON.stringify(hdrFixture, null, 2))
  for (const displayFailure of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
    const page = currentPage = await context.newPage()
    const label = displayFailure ? 'hdr-presenter-failure' : 'hdr-cpu-managed-success'
    page.on('pageerror', error => errors.push(String(error)))
    await page.addInitScript(() => localStorage.setItem('forma.render.hdr', '1'))
    await installProbe(page); await page.goto(base)
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(hdrFixturePath)
    await expect(page.getByLabel('文档名称')).toHaveValue(hdrFixture.name)
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'true', { timeout: 60_000 })
    await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-renderer', /webgpu|webgl2/)
    const initial = await frame(page)
    expect(initial.length).toBeGreaterThan(0)
    expect(initial.every(frame => frame.label === '广色域 HDR 显示瓦片' && frame.transport === 'linear-float-buffer')).toBe(true)
    await page.screenshot({ path: join(output, `${label}-initial-managed-gpu.png`) })
    await page.evaluate(fail => { const p = (window as any).__fallbackProbe; p.running = true; p.failManagedDisplay = fail }, displayFailure)
    await setWidth(page, 322); await held(page, 322)
    await assertHeld(page, initial, `${label}-cpu-held`)
    await release(page)
    if (displayFailure) {
      await expect(page.locator('.kernel-status.error')).toContainText('TEST_HDR_DISPLAY_FAILURE', { timeout: 60_000 })
      await waitFrames(page)
      expect(await frame(page)).toEqual(initial)
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'false')
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-backend', 'gpu')
      await expect(page.locator('canvas[data-frame-visible=true][aria-label="自研矢量渲染输出"]')).toHaveCount(0)
    } else {
      await expect(page.locator('canvas[data-frame-visible=true][aria-label="广色域 HDR 显示输出"]')).toBeVisible({ timeout: 60_000 })
      await expect(page.locator('.kernel-tiles')).toHaveCount(0)
      await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true')
      await waitFrames(page)
      const cpu = await frame(page)
      expect(cpu).toHaveLength(1)
      expect(cpu[0]).toMatchObject({ renderer: 'cpu', label: '广色域 HDR 显示输出', transport: 'linear-float-buffer' })
    }
    await page.screenshot({ path: join(output, `${label}-final.png`) })
    await page.evaluate(() => { (window as any).__fallbackProbe.running = false })
    const result = await probe(page)
    expect(result.requests.some((request: any) => request.stage === 'real-cpu-completed' && request.linearLength > 0 && request.linearPeak > 1)).toBe(true)
    expect(result.managedFailures > 0).toBe(displayFailure)
    expect(result.samples.every((sample: any) => sample.visible > 0 && sample.uncovered === 0 && sample.kinds.length === 1)).toBe(true)
    cases.push({ label, ...result })
    await writeFile(join(output, `${label}-trace.json`), JSON.stringify(result, null, 2))
    await context.close(); currentPage = undefined
  }
  expect(errors).toEqual([])
  expect(injectedGpuEvents.length).toBeGreaterThanOrEqual(2)
  expect(transforms.some(item => item.path.endsWith('/gpu/renderer.ts'))).toBe(true)
  expect(transforms.some(item => item.path.endsWith('/client.ts'))).toBe(true)
  const sourceAfter = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(join(root, path)))])))
  expect(sourceAfter).toEqual(sourceBefore)
  const result = { status: 'passed', cases, injectedGpuEvents, transforms, errors, sourceBefore, sourceAfter, output,
    scope: 'Controlled exception and delay injection only. Initial GPU and successful CPU pixels come from unmodified renderer implementations. No claim of natural OOM reproduction, device recovery, physical display behavior or GPU/CPU pixel equivalence.' }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ status: 'passed', cases: cases.length, output }))
} catch (error) {
  await currentPage?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  if (currentPage) {
    await writeFile(join(output, 'failure-ui.txt'), await currentPage.locator('body').innerText().catch(() => 'unavailable'))
    await writeFile(join(output, 'failure-probe.json'), JSON.stringify(await probe(currentPage).catch(() => null), null, 2))
  }
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), cases, injectedGpuEvents, transforms, errors, sourceBefore, output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally {
  await browser?.close()
  await server.close()
}
