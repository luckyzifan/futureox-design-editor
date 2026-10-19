/** Current live preview vs deterministic GPU reference, including both drivers. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-preview-materials-')))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20000)
    server.on('exit', (c) => {
      clearTimeout(timer)
      reject(Error(`Vite ${c}`))
    })
    server.stdout.on('data', (c) => {
      const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage()
  const gpuProfiles: unknown[] = []
  page.on('console', (message) => {
    if (message.text().startsWith('DESIGN_TILE_BUDGET')) console.log(message.text())
    if (message.text().startsWith('DESIGN_GPU_PROFILE ')) gpuProfiles.push(JSON.parse(message.text().slice('DESIGN_GPU_PROFILE '.length)))
  })
  await page.goto(`${base}/gpu-check.html`)
  const rows = await page.evaluate(async (quick) => {
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { initializePicking } = await import('/src/kernel/picking.ts')
    await initializePicking()
    const { precisionCases } = await import('/src/parity-fixtures.ts')
    const corpus = precisionCases(),
      rows = []
    const selected = [
      8,
      9,
      12,
      18,
      19,
      20,
      128,
      129,
      130,
      141,
      142,
      143,
      144,
      145,
      146,
      147,
      148,
      149,
      150,
      157,
      158,
      ...Array.from({ length: 32 }, (_, i) => 217 + i),
    ]
    for (const backend of ['webgpu', 'webgl2'] as const) {
      const client = new KernelClient()
      try {
        for (const index of (quick ? [8, 141, 217, 230] : selected)) {
          const input = corpus[index],
            options = { ...input.options, rasterProfile: input.options.rasterProfile || input.document.rasterProfile || (input.document.colorManagement ? 'figma' as const : 'analytic' as const) }
          let tile: any
          try {
            const full = await client.render(input.document, options, false, backend, true)
            const result = await client.render(
              input.document,
              {
                ...options,
                tileViewport: [
                  {
                    key: 'probe',
                    x: -options.view.x,
                    y: -options.view.y,
                    zoom: options.view.zoom,
                    width: options.width,
                    height: options.height,
                  },
                ],
              },
              false,
              backend,
              true,
              false,
              undefined,
              (t) => {
                tile = t
              },
            )
            if (!tile) throw Error('No preview pixels')
            let maxByte = 0,
              byteViolations = 0,
              floatBitViolations = 0,
              maxFloat = 0,
              maxRelative = 0
            for (let i = 0; i < full.bytes.length; i++) {
              const d = Math.abs(full.bytes[i] - tile.bytes[i])
              maxByte = Math.max(maxByte, d)
              if (d !== 0) byteViolations++
            }
            if (tile.bytes.length !== full.bytes.length) throw Error('Pixel dimensions differ')
            if (!!full.linear !== !!tile.linear) throw Error('Float transport differs')
            if (full.linear) {
              if (full.linear.byteLength !== tile.linear.byteLength) throw Error('Float dimensions differ')
              const referenceBits = new Uint32Array(full.linear.buffer, full.linear.byteOffset, full.linear.length)
              const previewBits = new Uint32Array(tile.linear.buffer, tile.linear.byteOffset, tile.linear.length)
              for (let i = 0; i < referenceBits.length; i++)
                if (referenceBits[i] !== previewBits[i]) floatBitViolations++
            }
            if (full.linear)
              for (let i = 0; i < full.linear.length; i++) {
                const d = Math.abs(full.linear[i] - tile.linear[i])
                maxFloat = Math.max(maxFloat, d)
                maxRelative = Math.max(maxRelative, d / (1 + Math.abs(full.linear[i])))
              }
            rows.push({
              index,
              name: input.document.name,
              backend,
              maxByte,
              byteViolations,
              floatBitViolations,
              profile: options.rasterProfile,
              maxFloat,
              maxRelative,
              referenceMs: full.milliseconds,
              previewMs: result.milliseconds,
              compileMs: tile.compileMs,
              graphMs: tile.graphMs,
              finishMs: tile.finishMs,
              checkpointMs: tile.checkpointMs,
            })
            full.bitmap?.close()
          } catch (error) {
            rows.push({ index, name: input.document.name, backend, error: String(error) })
          }
        }
        const { demo } = await import('/src/model.ts')
        const { defaultColorSettings } = await import('/src/color.ts')
        const { planTiles, devicePixelPhase } = await import('/src/kernel/tile-cache.ts')
        // Unlike the single-tile contract above, these views cross multiple world
        // tiles and carry nonzero device-pixel phase in both directions.
        for (const managed of [false, true]) {
          const document = demo()
          if (managed) {
            document.colorManagement = defaultColorSettings()
            document.rasterProfile = 'figma'
          }
          for (const view of [{ x: 160.375, y: 180.625, zoom: 0.2 }, { x: -35.25, y: 92.75, zoom: 0.375 }]) {
            const options = { pageId: document.pages[0].id, width: 385, height: 337, view,
              transparent: false, grid: true, rasterProfile: document.rasterProfile || 'analytic' as const }
            const name = `multi-tile-${managed ? 'HDR' : 'SDR'}-${view.x},${view.y}@${view.zoom}`
            try {
              const full = await client.render(document, options, false, backend, true)
              const plan = planTiles({ x: -view.x / view.zoom, y: -view.y / view.zoom,
                width: options.width / view.zoom, height: options.height / view.zoom }, view.zoom, 256,
                { x: devicePixelPhase(view.x, 1), y: devicePixelPhase(view.y, 1) })
              const bytes = new Uint8Array(full.bytes.length), bits = full.linear ? new Uint32Array(full.linear.length) : undefined
              const covered = new Uint8Array(options.width * options.height)
              let compileMs = 0, graphMs = 0, finishMs = 0, checkpointMs = 0
              const result = await client.render(document, { ...options, tileViewport: plan }, false, backend, true, false, undefined, (tile: any) => {
                compileMs += tile.compileMs; graphMs += tile.graphMs; finishMs += tile.finishMs; checkpointMs += tile.checkpointMs
                const sourceBits = tile.linear && new Uint32Array(tile.linear.buffer, tile.linear.byteOffset, tile.linear.length)
                const px = tile.x + Math.floor(view.x), py = tile.y + Math.floor(view.y)
                for (let y = 1; y < tile.height - 1; y++) for (let x = 1; x < tile.width - 1; x++) {
                  const dx = px + x, dy = py + y
                  if (dx < 0 || dy < 0 || dx >= options.width || dy >= options.height) continue
                  const target = dy * options.width + dx, source = y * tile.width + x
                  covered[target]++
                  bytes.set(tile.bytes.subarray(source * 4, source * 4 + 4), target * 4)
                  if (bits) bits.set(sourceBits.subarray(source * 4, source * 4 + 4), target * 4)
                }
              })
              const byteViolations = bytes.reduce((n, b, i) => n + Number(b !== full.bytes[i]), 0)
              const expectedBits = full.linear && new Uint32Array(full.linear.buffer, full.linear.byteOffset, full.linear.length)
              const floatBitViolations = bits?.reduce((n, b, i) => n + Number(b !== expectedBits![i]), 0) || 0
              if (covered.some((n) => n !== 1)) throw Error('World tiles overlap or leave uncovered output pixels')
              const revisit = await client.render(document, { ...options, tileViewport: plan }, false, backend, true, false, undefined, () => {})
              if (revisit.previewTiles !== 0 || revisit.tileCacheHits !== plan.length) throw Error('Exact same camera revisit missed cached tiles')
              rows.push({ name, backend, profile: options.rasterProfile, tiles: plan.length,
                byteViolations, floatBitViolations, maxByte: bytes.reduce((m, b, i) => Math.max(m, Math.abs(b - full.bytes[i])), 0),
                referenceMs: full.milliseconds, previewMs: result.milliseconds, compileMs, graphMs, finishMs, checkpointMs,
                cacheHits: revisit.tileCacheHits,
                mismatches: bits ? Array.from(bits).flatMap((b, i) => b === expectedBits![i] ? [] : [{
                  x: Math.floor(i / 4) % options.width, y: Math.floor(i / 4 / options.width), c: i % 4,
                  actual: b.toString(16), expected: expectedBits![i].toString(16),
                }]).slice(0, 20) : [] })
              full.bitmap?.close()
            } catch (error) { rows.push({ name, backend, error: String(error) }) }
          }
        }
      } finally {
        client.dispose()
      }
    }
    return rows
  }, process.env.FORMA_QUICK === '1')
  await writeFile(join(output, 'results.json'), JSON.stringify(rows, null, 2))
  if (gpuProfiles.length) await writeFile(join(output, 'gpu-profiles.json'), JSON.stringify(gpuProfiles, null, 2))
  const failures = rows.filter((r) => r.error || r.byteViolations || r.floatBitViolations)
  console.log(
    JSON.stringify({
      output,
      cases: rows.length,
      failures,
      maxByte: Math.max(...rows.map((r) => r.maxByte || 0)),
      maxRelative: Math.max(...rows.map((r) => r.maxRelative || 0)),
    }),
  )
  expect(failures).toEqual([])
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
