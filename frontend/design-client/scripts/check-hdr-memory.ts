/** Frozen production GPU workload: exact Figma profile, HDR, DPR 2, 100/200% camera. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const project = fileURLToPath(new URL('..', import.meta.url))
if (process.env.VITE_PRIVATE_PREFIX !== undefined)
  throw Error('VITE_PRIVATE_PREFIX is obsolete; use VITE_DESIGN_EXACT_PREFIX=0 or 1')
const exactPrefixEnabled = process.env.VITE_DESIGN_EXACT_PREFIX !== '0'
const output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-hdr-memory-')))
const root = join(output, 'snapshot/frontend/design-client')
await mkdir(root, { recursive: true })
for (const name of [
  'src',
  'public',
  'scripts',
  'gpu-check.html',
  'index.html',
  'vite.config.ts',
  'package.json',
  'tsconfig.json',
])
  await cp(join(project, name), join(root, name), { recursive: true })
await cp(
  join(project, '../../design-studio/crates/design-kernel/shaders'),
  join(output, 'snapshot/design-studio/crates/design-kernel/shaders'),
  { recursive: true },
)
await cp(
  join(project, '../../testing/fixtures/design'),
  join(output, 'snapshot/testing/fixtures/design'),
  { recursive: true },
)
await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
const hashes: Record<string, string> = {}
for (const file of [
  'gpu/renderer.ts',
  'gpu/webgpu.ts',
  'gpu/webgl.ts',
  'gpu/types.ts',
  'gpu/texture-prefix.ts',
  'gpu/prefix-module.ts',
  'gpu/prefix-int128.wgsl',
  'gpu/texture-prefix.wgsl',
  'render-worker.ts',
  'preview-tiles.ts',
  'client.ts',
])
  hashes[file] = createHash('sha256')
    .update(await readFile(join(root, 'src/kernel', file)))
    .digest('hex')
for (const file of [
  'public/kernel/design_kernel_bg.wasm',
  'src/generated/design-kernel/design_kernel.js',
  'public/fonts/NotoSansSC.ttf',
])
  hashes[file] = createHash('sha256')
    .update(await readFile(join(root, file)))
    .digest('hex')
for (const file of ['vector.wgsl', 'sampling.wgsl', 'byte-sampling.wgsl', 'area.wgsl', 'coverage64.wgsl', 'rational-filter.wgsl', 'certified-rational.wgsl'])
  hashes[`shaders/${file}`] = createHash('sha256').update(await readFile(join(output, 'snapshot/design-studio/crates/design-kernel/shaders', file))).digest('hex')
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2))
const input = process.env.DESIGN_BENCH_FIXTURE
  ? JSON.parse(await readFile(process.env.DESIGN_BENCH_FIXTURE, 'utf8'))
  : undefined
console.log(JSON.stringify({ output }))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The frozen workload exists to gate the HDR float path, which the app
    // now ships disabled by default. Force the opt-in bit for this server so
    // the assertion still exercises managed RGBA32F compositing.
    env: { ...process.env, VITE_DESIGN_HDR: '1' },
  },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Vite timeout')), 20000)
    server.stdout.on('data', (c) => {
      const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
    server.on('exit', () => reject(Error('Vite exited')))
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--use-angle=metal'],
  })
  const page = await browser.newPage()
  const messages: string[] = []
  page.on('console', (m) => {
    if (m.text().startsWith('DESIGN_GPU_') || m.text().startsWith('DESIGN_TILE_'))
      messages.push(m.text())
  })
  await page.exposeFunction('hdrProgress', (record: unknown) =>
    writeFile(join(output, 'progress.json'), JSON.stringify(record)),
  )
  await page.exposeFunction('hdrFixture', (document: unknown) =>
    writeFile(join(output, 'fixture.fd'), JSON.stringify(document)),
  )
  await page.goto(base + '/gpu-check.html')
  const rows = await page.evaluate(async ({ repeat, input }) => {
    const { demo } = await import('/src/model.ts')
    const { defaultColorSettings } = await import('/src/color.ts')
    const { KernelClient } = await import('/src/kernel/client.ts')
    const { planTiles, devicePixelPhase } = await import('/src/kernel/tile-cache.ts')
    const d = input || demo()
    d.colorManagement = defaultColorSettings()
    d.rasterProfile = 'figma'
    await (window as any).hdrFixture(d)
    const rows = [],
      c = new KernelClient()
    try {
      for (let iteration = 0; iteration < (repeat ? 2 : 1); iteration++) {
        if (iteration) d.id = crypto.randomUUID()
        for (const zoom of [2, 4]) {
          const view =
              zoom === 2
                ? { x: -213.33333333333326, y: -194, zoom }
                : { x: -1306.6666666666665, y: -1250, zoom },
            width = 1760,
            height = 1724
          const tiles = planTiles(
            { x: -view.x / zoom, y: -view.y / zoom, width: width / zoom, height: height / zoom },
            zoom,
            256,
            { x: devicePixelPhase(view.x, 1), y: devicePixelPhase(view.y, 1) },
          )
          const start = performance.now()
          let count = 0
          const contractErrors: string[] = []
          try {
            const r = await c.render(
              d,
              {
                pageId: d.pages[0].id,
                width,
                height,
                view,
                transparent: false,
                grid: true,
                rasterProfile: 'figma',
                tileViewport: tiles,
              },
              false,
              'webgpu',
              true,
              false,
              undefined,
              (tile) => {
                count++
                if (
                  tile.backend !== 'webgpu' ||
                  tile.bytes.length !== tile.width * tile.height * 4 ||
                  !(tile.linear instanceof Float32Array) ||
                  tile.linear.length !== tile.width * tile.height * 4
                )
                  contractErrors.push('Exact HDR tile dimensions or backend changed')
                ;(window as any).hdrProgress({
                  zoom,
                  count,
                  total: tiles.length,
                  elapsed: performance.now() - start,
                  peakTextureBytes: tile.peakTextureBytes,
                  finishTransientBytes: tile.finishTransientBytes,
                  workingTextureBytes: tile.workingTextureBytes,
                })
              },
            )
            if (
              contractErrors.length ||
              count !== tiles.length ||
              r.backend !== 'webgpu' ||
              r.tileCacheHits !== 0 ||
              (r.peakTextureBytes || 0) > 256 * 1024 * 1024 ||
              // The finish-transient ledger must be wired and observed: the
              // frozen HDR workload always presents, so a zero here means the
              // accounting regressed, not that the memory disappeared.
              !(r.finishTransientBytes > 0)
            )
              throw Error(
                contractErrors.join('; ') ||
                  'GPU tile coverage, intermediate pool budget or finish-transient ledger violated',
              )
            const { bytes, linear, bitmap, ...meta } = r
            bitmap?.close()
            rows.push({
              iteration,
              documentId: d.id,
              width,
              height,
              view,
              cacheState: iteration ? 'new document, warm backend' : 'first camera sequence',
              zoom,
              tiles: tiles.length,
              count,
              elapsed: performance.now() - start,
              ...meta,
            })
          } catch (e) {
            rows.push({
              iteration,
              zoom,
              count,
              elapsed: performance.now() - start,
              error: String(e),
            })
            break
          }
        }
      }
    } finally {
      c.dispose()
    }
    return rows
  }, { repeat: process.env.DESIGN_BENCH_REPEAT === '1', input })
  const prefixStats = messages.filter((message) => message.startsWith('DESIGN_GPU_PREFIX '))
    .map((message) => JSON.parse(message.slice('DESIGN_GPU_PREFIX '.length)) as { acceptedLines: number; declinedLines: number; acceptedPixels: number })
  const exactPrefix = {
    enabled: exactPrefixEnabled,
    frames: prefixStats.length,
    acceptedLines: prefixStats.reduce((sum, row) => sum + row.acceptedLines, 0),
    declinedLines: prefixStats.reduce((sum, row) => sum + row.declinedLines, 0),
    acceptedPixels: prefixStats.reduce((sum, row) => sum + row.acceptedPixels, 0),
    capacityFallbacks: messages.filter((message) => message.startsWith('DESIGN_GPU_PREFIX_BUDGET_FALLBACK ')).length,
  }
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      {
        scope:
          'Exact production worker/world-tile workload, same demo and cameras as prior HDR smoke; 1760×1724 physical pixels (880×862 CSS at DPR 2). No native display timing claim.',
        rows,
        messages,
        exactPrefix,
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(rows))
  if (rows.some((row) => row.error)) throw Error('HDR workload did not complete')
  if (exactPrefixEnabled ? exactPrefix.acceptedPixels === 0 : exactPrefix.frames !== 0)
    throw Error('Exact-prefix on/off execution did not match VITE_DESIGN_EXACT_PREFIX; see saved counters')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
