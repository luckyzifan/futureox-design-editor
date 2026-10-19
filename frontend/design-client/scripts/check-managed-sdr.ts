/** Managed colors, translucent images and alpha blends keep exact CPU/GPU
 * semantics with HDR display disabled. Runs real workers and both GPU drivers. */
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-managed-sdr-'))
process.env.VITE_DESIGN_HDR = '0'
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  await page.goto(server.resolvedUrls!.local[0] + 'gpu-check.html')
  const rows = await page.evaluate(async () => {
    const { KernelClient, renderExecutionPolicy } = await import('/src/kernel/client.ts')
    const { blank, node, paint } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    if (renderExecutionPolicy.hdrCompositing) throw new Error('This regression requires SDR output')
    const source = document.createElement('canvas')
    source.width = 2; source.height = 2
    source.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray([
      255, 32, 0, 128, 0, 128, 255, 255,
      16, 255, 32, 64, 192, 0, 255, 192,
    ]), 2, 2), 0, 0)
    const client = new KernelClient(), rows: unknown[] = []
    const differences = (a: Uint8Array, b: Uint8Array) => {
      if (a.length !== b.length) throw new Error(`Readback size mismatch ${a.length}/${b.length}`)
      let changed = 0, maximum = 0
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) changed++
        maximum = Math.max(maximum, Math.abs(a[i] - b[i]))
      }
      return { changed, maximum }
    }
    try {
      for (const transparent of [false, true]) {
        const doc = blank('Managed SDR alpha'), background = node('rectangle', 3, 2, 54, 42), image = node('rectangle', 17, 9, 30, 28)
        doc.colorManagement = defaultColorSettings(); doc.schemaVersion = 4; doc.rasterProfile = 'figma'
        background.fills = [paint('#1f7feb')]; background.opacity = 0.35
        image.fills = [{ ...paint('#ffffff'), kind: 'image', image: source.toDataURL('image/png'), fit: 'stretch' }]
        image.opacity = 0.625
        doc.nodes = { [background.id]: background, [image.id]: image }; doc.pages[0].children = [background.id, image.id]
        const options = { pageId: doc.pages[0].id, width: 64, height: 48, view: { x: 0, y: 0, zoom: 1 }, transparent, grid: false, rasterProfile: 'figma' as const }
        const cpu = await client.render(doc, options, false, 'cpu', true)
        const cpuSdr = await client.render(doc, options, false, 'cpu', false)
        const cpuEncoding = differences(cpu.bytes, cpuSdr.bytes)
        if (cpuEncoding.changed) throw new Error(`CPU SDR encoding diverged: ${JSON.stringify(cpuEncoding)}`)
        for (const backend of ['webgpu', 'webgl2'] as const) {
          const gpu = await client.render(doc, options, false, backend, true)
          const frame = differences(cpu.bytes, gpu.bytes)
          if (gpu.backend !== backend || frame.changed) throw new Error(`Managed SDR frame ${JSON.stringify({ backend, transparent, frame, reason: gpu.reason })}`)
          let tile: { bytes: Uint8Array; linear?: Float32Array } | undefined
          const tiled = await client.render(doc, { ...options, tileViewport: [{ key: 'managed-sdr', x: 0, y: 0, width: 64, height: 48, zoom: 1 }] }, false, backend, true, false, undefined,
            (result) => { tile = result })
          if (!tile) throw new Error('No real managed SDR tile was delivered')
          const pixels = differences(cpu.bytes, tile.bytes)
          if (tile.linear || pixels.changed) throw new Error(`Managed SDR tile ${JSON.stringify({ backend, transparent, pixels, floatPayload: !!tile.linear })}`)
          rows.push({ backend, transparent, frame, tile: pixels, floatPayload: false, ms: tiled.milliseconds,
            peakTextureBytes: tiled.peakTextureBytes, finishTransientBytes: tiled.finishTransientBytes })
        }
      }
    } finally { client.dispose() }
    return rows
  })
  expect(rows).toHaveLength(4)
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', hdr: false, dpr: 2, rows, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: rows.length, output }))
} catch (error) {
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), output }, null, 2))
  throw error
} finally { await browser?.close(); await server.close() }
