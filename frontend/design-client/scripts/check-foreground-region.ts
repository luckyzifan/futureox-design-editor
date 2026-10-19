/** Real RGBA32F bit parity for foreground-only regional compilation and mask
 * lifetime changes. The reference is the unchanged full-frame compilation. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = await mkdtemp(join(tmpdir(), 'fd-foreground-region-'))
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
await server.listen()
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--use-angle=metal'] })
  const page = await browser.newPage()
  page.on('console', message => { if (message.text().startsWith('FOREGROUND ')) console.log(message.text()) })
  await page.goto(server.resolvedUrls!.local[0] + 'gpu-check.html')
  const rows = await page.evaluate(async () => {
    const { initializePicking } = await import('/src/kernel/picking.ts')
    const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { createGpu } = await import('/src/kernel/gpu/factory.ts')
    await initializePicking()
    const color = defaultColorSettings(), rows = []
    const diff = (a: Float32Array, b: Float32Array, bw: number, x: number, y: number, w: number, h: number) => {
      const aa = new Uint32Array(a.buffer, a.byteOffset, a.length), bb = new Uint32Array(b.buffer, b.byteOffset, b.length)
      let count = 0
      for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) for (let c = 0; c < 4; c++)
        count += Number(aa[(yy * w + xx) * 4 + c] !== bb[((yy + y) * bw + xx + x) * 4 + c])
      return count
    }
    for (const variant of ['inner', 'outer', 'blur', 'nested', 'luminance', 'translucent-mask', 'solid'])
      for (const zoom of [1, 1.375]) for (const profile of ['figma', 'figmaSubpixel']) {
        const fx = (kind: string, radius: number, spread = 0) => ({ kind, radius, spread, x: 2.25, y: -1.5, color: '#236699', opacity: .65 })
        const document = { schemaVersion: 5, id: 'region', name: variant, colorManagement: color,
          pages: [{ id: 'p', name: 'p', background: '#556677', children: ['frame'] }], nodes: {
            frame: { id: 'frame', kind: 'frame', width: 170, height: 140, clip: true, transform: [1, 0, 0, 1, 10.125, 8.375],
              fills: [{ kind: 'solid', color: '#ddeeff' }], children: ['group'] },
            group: { id: 'group', kind: 'group', width: 160, height: 135, blend: 'normal', opacity: .875,
              children: ['mask', 'shape', 'sibling'], effects: variant === 'nested' ? [fx('blur', 2.5)] : [] },
            mask: { id: 'mask', kind: 'ellipse', width: 146, height: 110, transform: [1, 0, 0, 1, 4.25, 6.125],
              mask: true, maskType: variant === 'luminance' ? 'luminance' : 'alpha',
              fills: [{ kind: 'solid', color: '#ffffff', opacity: variant === 'translucent-mask' ? .5 : 1 }] },
            shape: { id: 'shape', kind: 'rectangle', width: 110, height: 90, transform: [1, .125, -.25, 1, 16.375, 12.25],
              radii: [6, 6, 6, 6], fills: [{ kind: variant === 'solid' ? 'solid' : 'linear', color: '#bb7733', stops: [{ offset: 0, color: '#de7834' }, { offset: 1, color: '#1357bd' }] }],
              effects: variant === 'solid' ? [] : [fx(variant === 'inner' ? 'inner-shadow' : variant === 'outer' ? 'shadow' : 'blur', 5.25, variant === 'inner' ? 4.5 : 0)] },
            sibling: { id: 'sibling', kind: 'rectangle', width: 34, height: 65, transform: [1, 0, 0, 1, 90.375, 55.125],
              fills: [{ kind: 'solid', color: '#329955', opacity: .7 }], effects: variant === 'solid' ? [] : [fx('shadow', 3.25, 1.5)] },
          } }
        const kernel = new VectorEngine(), gpu = await createGpu('webgpu', true, false, color), reference = await createGpu('webgpu', false, false, color)
        try {
          kernel.load_document(JSON.stringify(document))
          const options = { pageId: 'p', width: 224, height: 192, view: { x: .125, y: .375, zoom }, transparent: true, grid: false, rasterProfile: profile }
          const scene = JSON.parse(kernel.compile_gpu(JSON.stringify(options)))
          console.log('FOREGROUND ' + JSON.stringify({ variant, zoom, profile, phase: 'full' }))
          const full = await gpu.render(scene, true, false)
          console.log('FOREGROUND reference')
          const unoptimized = await reference.render(scene, true, false)
          if (!full.linear || !unoptimized.linear) throw Error('Missing float readback')
          const optimizationDifferences = diff(full.linear, unoptimized.linear, 224, 0, 0, 224, 192)
          const crop = { x: 33, y: 27, w: 89, h: 77 }
          const regional = JSON.parse(kernel.compile_gpu(JSON.stringify({ ...options, width: crop.w, height: crop.h, gpuViewport: crop })))
          console.log('FOREGROUND region')
          const actual = await gpu.render(regional, true, false)
          if (!actual.linear) throw Error('Missing regional readback')
          const cropDifferences = diff(actual.linear, full.linear, 224, crop.x, crop.y, crop.w, crop.h)
          rows.push({ variant, zoom, profile, optimizationDifferences, cropDifferences, peak: actual.peakTextureBytes })
        } finally { gpu.dispose(); reference.dispose(); kernel.free() }
      }
    return rows
  })
  const failures = rows.filter(r => r.optimizationDifferences || r.cropDifferences)
  await writeFile(join(output, 'results.json'), JSON.stringify({ rows, failures }, null, 2))
  console.log(JSON.stringify({ output, checks: rows.length, failures }))
  if (failures.length) process.exitCode = 1
} finally { await browser?.close(); await server.close() }
