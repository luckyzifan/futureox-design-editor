/** Real editor: long pan, cache revisit, zoom anchoring, Retina refinement and HDR. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-camera-')))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(Error('Vite timeout')), 20000)
    server.on('exit', (c) => {
      clearTimeout(t)
      reject(Error(`Vite ${c}`))
    })
    server.stdout.on('data', (c) => {
      const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(t)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 940 },
    deviceScaleFactor: 2,
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(() => {
    ;(window as any).__visibleResizes = 0
    for (const property of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property)!
      Object.defineProperty(HTMLCanvasElement.prototype, property, {
        ...d,
        set(value) {
          if (
            (window as any).__cameraTrace?.running &&
            this.isConnected &&
            this.dataset.frameVisible === 'true'
          )
            (window as any).__visibleResizes++
          d.set!.call(this, value)
        },
      })
    }
  })
  const initialStart = Date.now()
  await page.goto(base)
  const canvas = page.getByTestId('canvas'),
    active = page.locator('.kernel-tiles')
  await page.locator('.kernel-tile[data-frame-visible=true]').first().waitFor({ timeout: 45000 })
  const firstPaintMs = Date.now() - initialStart
  const captureFailure = async (failure: unknown) => {
    await writeFile(join(output, 'failure.json'), JSON.stringify({ failure: String(failure), firstPaintMs,
      browserDpr: await page.evaluate(() => window.devicePixelRatio),
      surface: await page.locator('.kernel-tiles').evaluateAll((elements) => elements.map((el) => ({ ...(el as HTMLElement).dataset }))),
      status: await page.locator('.kernel-status').allTextContents(),
      trace: await page.evaluate(() => (window as any).__cameraTrace),
    }, null, 2))
    await page.screenshot({ path: join(output, 'failure.png') })
  }
  const settle = async () => {
    try {
      await page.waitForFunction(() => document.querySelector('.kernel-status.error') ||
        document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready') === 'true', null, { timeout: 90000 })
    } catch (error) {
      await captureFailure(error)
      throw error
    }
    const failure = await page.locator('.kernel-status.error').allTextContents()
    if (failure.length) {
      await writeFile(join(output, 'failure.json'), JSON.stringify({ failure,
        surface: await active.evaluate((el) => ({ ...(el as HTMLElement).dataset })),
        trace: await page.evaluate(() => (window as any).__cameraTrace),
      }, null, 2))
      await page.screenshot({ path: join(output, 'failure.png') })
      throw Error(failure.join('；'))
    }
  }

  await settle()
  const header = await page.locator('header').boundingBox(),
    box = await canvas.boundingBox()
  if (!box) throw Error('Canvas absent')
  const records: any[] = []
  const snapshot = async (label: string, elapsed?: number) => {
    records.push({
      label,
      elapsed,
      ...(label === 'initial' ? { firstPaintMs } : {}),
      ...(await active.evaluate((el) => ({ ...(el as HTMLElement).dataset }))),
    })
    await writeFile(join(output, 'progress.json'), JSON.stringify(records, null, 2))
  }
  const visibleIdentity = () => page.locator('canvas[data-frame-visible=true]').evaluateAll((tiles) =>
    tiles.map((tile) => `${(tile as HTMLElement).dataset.tileKey}/${(tile as HTMLElement).dataset.tileSerial}`).sort())
  const initialTiles = await visibleIdentity()
  await snapshot('initial', Date.now() - initialStart)
  const initialRendered = await active.getAttribute('data-tiles-rendered')
  await page.getByLabel('文档名称', { exact: true }).fill('精确画布测试 · 元数据更名')
  await page.getByLabel('文档名称', { exact: true }).blur()
  await settle()
  expect(await visibleIdentity()).toEqual(initialTiles)
  expect(await active.getAttribute('data-tiles-rendered')).toBe(initialRendered)
  await snapshot('renameWithoutRepaint')
  const cdp = await page.context().newCDPSession(page)
  const waitForDpr = async (ratio: number) => {
    // data-pixel-ratio describes the last atomically presented full frame.
    // A scale notification is not itself a completed rendering operation.
    await page.waitForFunction((ratio) => document.querySelector('.kernel-status.error') || (
      document.querySelector('.kernel-tiles')?.getAttribute('data-pixel-ratio') === String(ratio) &&
      document.querySelector('.kernel-tiles')?.getAttribute('data-detail-ready') === 'true'
    ), ratio, { timeout: 90000 })
    await settle()
    expect(await active.getAttribute('data-pixel-ratio')).toBe(String(ratio))
  }
  const dpr150Start = Date.now()
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1.5, mobile: false })
  // CDP changes devicePixelRatio without the resize/resolution events emitted
  // by a real monitor transition. Supply the notification explicitly; this is
  // a DPR/cache regression, not evidence of physical macOS monitor migration.
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await waitForDpr(1.5)
  await snapshot('dpr150', Date.now() - dpr150Start)
  const dpr200Start = Date.now()
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false })
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await waitForDpr(2)
  expect(await visibleIdentity()).toEqual(initialTiles)
  // Keep this emulation session alive: detaching clears its scale override in
  // headless Chromium and would silently run the remaining Retina test at 1×.
  await snapshot('dpr200Return', Date.now() - dpr200Start)
  await page.evaluate(() => {
    const t = {
      running: true,
      frames: 0,
      mismatch: 0,
      uncovered: 0,
      misses: [] as unknown[],
      checked: 0,
      intervals: [] as number[],
      last: 0,
      measure: false,
      maxResident: 0,
      mixedRevisions: 0,
      resampledTiles: 0,
      pendingFrames: 0,
      completedCameras: [] as string[],
      cameraWaits: [] as number[],
      pendingSince: 0,
      measuredDisplayChanges: 0,
      measuredFrames: 0,
    }
    ;(window as any).__cameraTrace = t
    function sample(now: number) {
      if (!t.running) return
      t.frames++
      if (t.measure && t.last) t.intervals.push(now - t.last)
      t.last = now
      const host = document.querySelector('[data-testid=canvas]')!,
        surface = host.querySelector<HTMLElement>('.kernel-tiles')!
      const m = { a: Number(surface.dataset.cameraZoom), d: Number(surface.dataset.cameraZoom),
          e: Number(surface.dataset.cameraX), f: Number(surface.dataset.cameraY) },
        overlay = host
          .querySelector<SVGGElement>('svg.stage > g')!
          .transform.baseVal.consolidate()!.matrix
      // Computed CSS matrices serialize translation to six significant digits.
      // 0.01 CSS px stays well below a physical pixel at the tested DPR.
      if (
        Math.abs(m.a - overlay.a) > 0.0001 ||
        Math.abs(m.e - overlay.e) > 0.01 ||
        Math.abs(m.f - overlay.f) > 0.01
      )
        t.mismatch++
      const visible = [...host.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible=true]')]
      if (visible.some((tile) => tile.dataset.tileRevision !== surface.dataset.revision)) t.mixedRevisions++
      const dpr = Number(surface.dataset.pixelRatio), origin = host.getBoundingClientRect()
      for (const tile of visible) {
        const r = tile.getBoundingClientRect()
        if (Math.abs((r.left - origin.left) * dpr - Math.round((r.left - origin.left) * dpr)) > 0.001 ||
            Math.abs((r.top - origin.top) * dpr - Math.round((r.top - origin.top) * dpr)) > 0.001 ||
            Math.abs(r.width * dpr - tile.width) > 0.001 || Math.abs(r.height * dpr - tile.height) > 0.001) t.resampledTiles++
      }
      if (t.measure) t.measuredFrames++
      if (surface.dataset.detailReady !== 'true') {
        t.pendingFrames++
        if (!t.pendingSince) t.pendingSince = now
      } else if (t.pendingSince) {
        t.cameraWaits.push(now - t.pendingSince); t.pendingSince = 0
      }
      const camera = `${m.e},${m.f},${m.a}`
      if (t.completedCameras.at(-1) !== camera) {
        t.completedCameras.push(camera)
        if (t.measure) t.measuredDisplayChanges++
      }
      t.maxResident = Math.max(t.maxResident, Number(surface.dataset.residentBytes))
      const viewport = host.getBoundingClientRect(),
        tiles = [...host.querySelectorAll('canvas[data-frame-visible=true]')].map((c) =>
          c.getBoundingClientRect(),
        )
      for (const wx of [70, 200, 450, 650, 900, 1160])
        for (const wy of [60, 180, 370, 570, 720]) {
          const x = viewport.x + m.e + wx * m.a,
            y = viewport.y + m.f + wy * m.d
          if (
            x < viewport.left + 2 ||
            x > viewport.right - 2 ||
            y < viewport.top + 2 ||
            y > viewport.bottom - 2
          )
            continue
          t.checked++
          if (!tiles.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) {
            t.uncovered++
            if (t.misses.length < 20)
              t.misses.push({
                wx,
                wy,
                x,
                y,
                rev: surface.dataset.revision,
                view: [m.a, m.e, m.f],
                visible: tiles.length,
                phase: (window as any).__phase,
              })
          }
        }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await page.keyboard.press('h')
  const from = { x: box.x + box.width * 0.82, y: box.y + box.height * 0.78 },
    to = { x: box.x + box.width * 0.16, y: box.y + box.height * 0.22 }
  const drag = async (a: typeof from, b: typeof from) => {
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 12 })
    await page.mouse.up()
  }
  await page.evaluate(() => {
    ;(window as any).__cameraTrace.measure = true
  })
  const panStart = Date.now()
  await drag(from, to)
  await settle()
  await snapshot('longPan', Date.now() - panStart)
  const backStart = Date.now()
  await drag(to, from)
  await settle()
  await snapshot('cachedReturn', Date.now() - backStart)
  // A return gesture can legitimately render intermediate cameras. Assert the
  // returned completed pixels are the same resident tile objects, not a global
  // counter that includes those intermediate requests.
  expect(await visibleIdentity()).toEqual(initialTiles)
  for (let i = 0; i < 3; i++) {
    await drag(from, to)
    await drag(to, from)
  }
  await page.evaluate(() => {
    ;(window as any).__cameraTrace.measure = false
  })
  await page.screenshot({ path: join(output, 'long-pan.png') })
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.press(`${mod}+0`)
  await settle()
  const point = { x: 300, y: 250 }
  const worldAt = () =>
    page.evaluate((p) => {
      const m = document
        .querySelector<SVGGElement>('svg.stage > g')!
        .transform.baseVal.consolidate()!.matrix
      return { x: (p.x - m.e) / m.a, y: (p.y - m.f) / m.d, zoom: m.a }
    }, point)
  const beforePinch = await worldAt()
  await page.mouse.move(box.x + point.x, box.y + point.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -30)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await worldAt()).zoom).toBeGreaterThan(beforePinch.zoom)
  const afterPinch = await worldAt()
  expect(afterPinch.x).toBeCloseTo(beforePinch.x, 4)
  expect(afterPinch.y).toBeCloseTo(beforePinch.y, 4)
  await page.keyboard.press(`${mod}+0`)
  const zoomStart = Date.now()
  await page.keyboard.press(`${mod}+=`)
  await expect(page.getByLabel('缩放与视图设置')).toHaveText('200%')
  await settle()
  await snapshot('zoom200', Date.now() - zoomStart)
  await page.keyboard.press(`${mod}+-`)
  await expect(page.getByLabel('缩放与视图设置')).toHaveText('100%')
  await settle()
  await page.evaluate(() => {
    ;(window as any).__phase = 'enable HDR'
  })
  await page.getByLabel('更多工作区操作').click()
  await page.getByRole('button', { name: '色彩与 HDR', exact: true }).click()
  await page.getByRole('button', { name: '启用广色域 / HDR', exact: true }).click()
  await page.getByLabel('关闭色彩面板').click()
  const hdrStart = Date.now()
  await settle()
  await snapshot('hdr100', Date.now() - hdrStart)
  const hdrZoomStart = Date.now()
  await page.keyboard.press(`${mod}+=`)
  await expect(page.getByLabel('缩放与视图设置')).toHaveText('200%')
  await settle()
  await snapshot('hdr200', Date.now() - hdrZoomStart)
  expect(
    await page.locator('canvas[data-frame-visible=true][aria-label="广色域 HDR 显示瓦片"]').count(),
  ).toBeGreaterThan(0)
  const retina = await page.evaluate(async () => {
    const { tilesCoverBounds } = await import('/src/kernel/tile-cache.ts')
    const h = document.querySelector('[data-testid=canvas]')!,
      s = h.querySelector<HTMLElement>('.kernel-tiles')!,
      z = Number(s.dataset.cameraZoom)
    const tiles = [...h.querySelectorAll<HTMLCanvasElement>('canvas[data-frame-visible=true]')]
      .filter((c) => c.dataset.tileRevision === s.dataset.revision)
      .map((c) => ({
        key: c.dataset.tileKey!,
        x: Number(c.dataset.tileX),
        y: Number(c.dataset.tileY),
        zoom: Number(c.dataset.tileZoom),
        phaseX: Number(c.dataset.tilePhaseX), phaseY: Number(c.dataset.tilePhaseY),
        width: c.width,
        height: c.height,
      }))
    return tilesCoverBounds(
      tiles,
      {
        x: -Number(s.dataset.cameraX) / z,
        y: -Number(s.dataset.cameraY) / z,
        width: h.clientWidth / z,
        height: h.clientHeight / z,
      },
      z * devicePixelRatio,
    )
  })
  if (!retina) {
    await writeFile(
      join(output, 'retina-failure.json'),
      JSON.stringify({
        records,
        retina,
        tiles: await page
          .locator('.kernel-tile[data-frame-visible=true]')
          .evaluateAll((list) =>
            list.map((el) => ({
              ...(el as HTMLElement).dataset,
              width: (el as HTMLCanvasElement).width,
              height: (el as HTMLCanvasElement).height,
            })),
          ),
      }),
    )
    console.log(JSON.stringify({ output, records, retina }))
  }
  expect(retina).toBe(true)
  await page.screenshot({ path: join(output, 'hdr-retina-200.png') })
  await page.evaluate(() => {
    ;(window as any).__cameraTrace.measure = true
  })
  await drag(from, to)
  await drag(to, from)
  await page.evaluate(() => {
    ;(window as any).__cameraTrace.measure = false
  })
  await settle()
  await snapshot('hdrReturn')
  const trace = await page.evaluate(() => {
    const t = (window as any).__cameraTrace
    t.running = false
    return t
  })
  console.log(
    JSON.stringify({
      output,
      records,
      traceSummary: {
        frames: trace.frames,
        mismatch: trace.mismatch,
        uncovered: trace.uncovered,
        misses: trace.misses,
      },
      visibleResizes: await page.evaluate(() => (window as any).__visibleResizes),
    }),
  )
  await writeFile(join(output, 'trace.json'), JSON.stringify({ records, trace, errors }, null, 2))
  const intervals = (trace.intervals as number[]).sort((a, b) => a - b)
  const p95 = intervals[Math.floor(intervals.length * 0.95)]
  expect(trace.mismatch).toBe(0)
  expect(trace.uncovered).toBe(0)
  expect(trace.mixedRevisions).toBe(0)
  expect(trace.resampledTiles).toBe(0)
  expect(trace.checked).toBeGreaterThan(100)
  expect(trace.maxResident).toBeLessThanOrEqual(128 * 1024 * 1024)
  expect(p95).toBeLessThan(50)
  expect(await page.evaluate(() => (window as any).__visibleResizes)).toBe(0)
  expect(await page.locator('header').boundingBox()).toEqual(header)
  expect(errors).toEqual([])
  await page.close()
  // Compare actual GPU pixels across tile edges through the sample's glass,
  // gradient and shadows. The HDR case also contains values above SDR white.
  const comparisonPage = await browser.newPage()
  await comparisonPage.goto(`${base}/gpu-check.html`)
  const tiles = await comparisonPage.evaluate(async () => {
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { demo } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { initializePicking } = await import('/src/kernel/picking.ts')
    await initializePicking()
    const rows = []
    for (const managed of [false, true]) {
      const doc = demo(),
        client = new KernelClient()
      if (managed) {
        doc.colorManagement = defaultColorSettings()
        doc.rasterProfile = 'figma'
        const ball = Object.values(doc.nodes).find((node) => node.kind === 'ellipse')!
        ball.fills[0].stops[0].color = 'color(rec2100-linear 4 2 1)'
      }
      try {
        const options = {
          pageId: doc.pages[0].id,
          width: 385,
          height: 337,
          view: { x: 160.3, y: 180.7, zoom: 0.2 },
          transparent: false,
          grid: true,
        }
        const full = await client.render(doc, options, false, 'webgpu', true)
        const tiled = await client.render(
          doc,
          { ...options, livePreview: true },
          false,
          'webgpu',
          true,
          false,
          { forcePreviewTiles: true },
        )
        try {
          const a = managed ? full.linear! : full.bytes,
            b = managed ? tiled.linear! : tiled.bytes
          let max = 0,
            sum = 0,
            peak = 0
          for (let i = 0; i < a.length; i++) {
            const delta = Math.abs(a[i] - b[i])
            max = Math.max(max, delta)
            sum += delta
            peak = Math.max(peak, b[i])
          }
          const bitDifferences = managed
            ? new Uint32Array(a.buffer, a.byteOffset, a.length).reduce((n, v, i) => n + Number(v !== new Uint32Array(b.buffer, b.byteOffset, b.length)[i]), 0)
            : 0
          rows.push({
            managed,
            bitDifferences,
            max,
            mean: sum / a.length,
            peak,
            tiles: tiled.previewTiles,
            length: b.length,
          })
        } finally {
          full.bitmap?.close()
          tiled.bitmap?.close()
        }
      } finally {
        client.dispose()
      }
    }
    return rows
  })
  for (const result of tiles) {
    expect(result.length).toBe(385 * 337 * 4)
    expect(result.tiles).toBe(4)
    expect(result.max).toBe(0)
    expect(result.bitDifferences).toBe(0)
    if (result.managed) expect(result.peak).toBeGreaterThan(1)
  }
  const result = {
    firstPaintMs,
    trace,
    p95,
    records,
    retina,
    pinchAnchor: { before: beforePinch, after: afterPinch },
    tiles,
    errors,
    output,
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
