/** Actual worker pixels and cache certificates across preview/settled tiers. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = await mkdtemp(join(tmpdir(), 'design-render-cache-'))
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage()
  await page.goto(server.resolvedUrls!.local[0] + 'gpu-check.html')
  const rows = await page.evaluate(async () => {
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { blank, node, paint } = await import('/src/model.ts')
    const documentOwner = window.document
    const document = blank('preview tier cache')
    const shape = node('ellipse', 8.25, 10.75, 36, 29)
    shape.fills = [paint('#df532a')]; document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
    const c = new KernelClient(), rows = [], frames: Uint8Array[] = []
    try {
      for (const renderIntent of ['settled', 'preview', 'settled', 'preview'] as const) {
        let pixels: Uint8Array | undefined, cached = false
        const result = await c.render(document, { pageId: document.pages[0].id, width: 64, height: 64,
          view: { x: 0, y: 0, zoom: 1 }, transparent: false, grid: false, rasterProfile: 'analytic', renderIntent,
          tileViewport: [{ key: 'origin', x: 0, y: 0, width: 64, height: 64, zoom: 1 }] },
          false, 'webgpu', true, false, undefined, tile => {
            cached = !!tile.cached
            const canvas = documentOwner.createElement('canvas'); canvas.width = 64; canvas.height = 64
            const context = canvas.getContext('2d', { willReadFrequently: true })!
            if (tile.bitmap) context.drawImage(tile.bitmap, 0, 0)
            else context.putImageData(new ImageData(new Uint8ClampedArray(tile.bytes), 64, 64), 0, 0)
            pixels = new Uint8Array(context.getImageData(0, 0, 64, 64).data)
            tile.bitmap?.close()
          })
        if (!pixels || result.backend !== 'webgpu') throw new Error('Missing actual WebGPU tile')
        if (rows.length >= 2 && !cached) throw new Error('Changing preview tier evicted the other tier')
        const earlier = frames[rows.length % 2]
        if (earlier && !pixels.every((v, i) => v === earlier[i])) throw new Error('Cached tile pixels changed')
        frames.push(pixels); rows.push({ renderIntent, cached, bytes: pixels.length, cacheBytes: result.tileCacheBytes })
      }
    } finally { c.dispose() }
    return rows
  })
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', rows }, null, 2))
  console.log(JSON.stringify({ status: 'passed', rows, output }))
} finally { await browser?.close(); await server.close() }
