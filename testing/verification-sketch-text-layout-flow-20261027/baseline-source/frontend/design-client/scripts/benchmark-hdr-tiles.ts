/** Frozen local GPU benchmark: compare tile sizes at identical exact camera,
 * sampling and float output. Nothing is injected into a third-party browser. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const sizes = (process.env.DESIGN_TILE_SIDES || '256,384,510').split(',').map(Number)
const repeats = Number(process.env.DESIGN_TILE_REPEATS || 1)
if (!sizes.length || sizes.some((side) => !Number.isSafeInteger(side) || side < 64 || side > 510))
  throw new Error('Tile sides must be integers between 64 and 510')
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error('Repeats must be an integer between 1 and 10')
const root = new URL('..', import.meta.url).pathname,
  output = await mkdtemp(join(tmpdir(), 'forma-hdr-tiles-'))
for (const file of ['src', 'public', 'gpu-check.html', 'vite.config.ts', 'package.json'])
  await cp(join(root, file), join(output, file), { recursive: true })
await symlink(join(root, 'node_modules'), join(output, 'node_modules'))
if (process.env.DESIGN_WEBGPU_SOURCE)
  await cp(process.env.DESIGN_WEBGPU_SOURCE, join(output, 'src/kernel/gpu/webgpu.ts'))
// Mirror external-to-client shader inputs inside the private snapshot. Only the
// import paths change; shader bytes remain identical to the owned source.
await mkdir(join(output, 'src/generated/native-shaders'), { recursive: true })
await cp(
  join(root, '../../design-studio/crates/design-kernel/shaders'),
  join(output, 'src/generated/native-shaders'),
  { recursive: true },
)
if (process.env.DESIGN_VECTOR_SHADER_SOURCE)
  await cp(
    process.env.DESIGN_VECTOR_SHADER_SOURCE,
    join(output, 'src/generated/native-shaders/vector.wgsl'),
  )
for (const [variable, filename] of [
  ['DESIGN_SAMPLING_SHADER_SOURCE', 'sampling.wgsl'],
  ['DESIGN_BYTE_SAMPLING_SHADER_SOURCE', 'byte-sampling.wgsl'],
]) {
  if (process.env[variable])
    await cp(process.env[variable]!, join(output, 'src/generated/native-shaders', filename))
}
for (const filename of await readdir(join(output, 'src/kernel/gpu')))
  if (filename.endsWith('.ts')) {
    const file = join(output, 'src/kernel/gpu', filename)
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replaceAll(
        '../../../../../design-studio/crates/design-kernel/shaders/',
        '../../generated/native-shaders/',
      ),
    )
  }

if (process.env.DESIGN_RENDERER_SOURCE)
  await cp(process.env.DESIGN_RENDERER_SOURCE, join(output, 'src/kernel/gpu/renderer.ts'))
const hashes: Record<string, string> = {}
for (const file of [
  'src/model.ts',
  'src/color.ts',
  'src/kernel/gpu/renderer.ts',
  'src/kernel/gpu/webgpu.ts',
  'src/kernel/render-worker.ts',
  'src/generated/native-shaders/vector.wgsl',
  'src/generated/native-shaders/sampling.wgsl',
  'src/generated/native-shaders/byte-sampling.wgsl',
  'src/generated/design-kernel/design_kernel_bg.wasm',
])
  hashes[file] = createHash('sha256')
    .update(await readFile(join(output, file)))
    .digest('hex')
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  { cwd: output, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
)
let log = '',
  browser: any
const profiles: any[] = [],
  budgetFailures: string[] = []
server.stdout.on('data', (v) => (log += v))
server.stderr.on('data', (v) => (log += v))
console.log(JSON.stringify({ output, phase: 'starting' }))
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite startup timeout')), 20000)
    server.stdout.on('data', () => {
      const m = log.match(/http:\/\/127.0.0.1:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: ['--use-angle=metal'],
  })
  const page = await browser.newPage()
  page.on('console', (message: any) => {
    const text = message.text()
    if (text.startsWith('DESIGN_GPU_PROFILE '))
      profiles.push(JSON.parse(text.slice('DESIGN_GPU_PROFILE '.length)))
    else if (text.startsWith('HDR_TILE_RESULT ') || text.startsWith('HDR_ADAPTER '))
      console.log(text)
    else if (text.startsWith('DESIGN_TILE_BUDGET') || text.startsWith('DESIGN_GPU_BUDGET'))
      budgetFailures.push(text)
  })
  await page.goto(base + '/gpu-check.html')
  const results = await page.evaluate(
    async ({ sizes, repeats, clipEdges }) => {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) throw Error('No WebGPU adapter')
      const adapterInfo = {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      }
      console.log('HDR_ADAPTER ' + JSON.stringify(adapterInfo))
      if (adapterInfo.isFallbackAdapter)
        throw Error('Software adapter cannot certify hardware performance')
      const { KernelClient } = await import('/src/kernel/client.ts'),
        { demo } = await import('/src/model.ts'),
        { defaultColorSettings } = await import('/src/color.ts')
      const doc = demo()
      doc.colorManagement = defaultColorSettings()
      doc.rasterProfile = 'figma'
      const options = {
        pageId: doc.pages[0].id,
        width: 1760,
        height: 1724,
        view: { x: -1258.4681304185542, y: -1187.6861781363686, zoom: 4 },
        grid: true,
        transparent: false,
        rasterProfile: 'figma' as const,
      }
      const client = new KernelClient(),
        rows: any[] = []
      let referenceBytes: Uint8Array | undefined, referenceBits: Uint32Array | undefined
      try {
        for (const side of sizes)
          for (let round = 0; round < repeats; round++) {
            const pixels = new Uint8Array(options.width * options.height * 4),
              floats = new Float32Array(pixels.length),
              tiles = []
            const phase = {
              x: options.view.x - Math.floor(options.view.x),
              y: options.view.y - Math.floor(options.view.y),
            }
            const x0 = Math.floor(-Math.floor(options.view.x) / side),
              y0 = Math.floor(-Math.floor(options.view.y) / side)
            const x1 = Math.ceil((options.width - Math.floor(options.view.x)) / side),
              y1 = Math.ceil((options.height - Math.floor(options.view.y)) / side)
            for (let y = y0; y < y1; y++)
              for (let x = x0; x < x1; x++) {
                const left = clipEdges ? Math.max(x * side, -Math.floor(options.view.x)) : x * side,
                  top = clipEdges ? Math.max(y * side, -Math.floor(options.view.y)) : y * side
                const right = clipEdges
                    ? Math.min((x + 1) * side, options.width - Math.floor(options.view.x))
                    : (x + 1) * side,
                  bottom = clipEdges
                    ? Math.min((y + 1) * side, options.height - Math.floor(options.view.y))
                    : (y + 1) * side
                tiles.push({
                  key: `${side}:${x}:${y}`,
                  x: left - 1,
                  y: top - 1,
                  width: right - left + 2,
                  height: bottom - top + 2,
                  zoom: options.view.zoom,
                  phaseX: phase.x,
                  phaseY: phase.y,
                })
              }
            const tileTimes: any[] = []
            let received = 0
            const started = performance.now()
            const result = await client.render(
              doc,
              { ...options, tileViewport: tiles },
              false,
              'webgpu',
              true,
              false,
              { disableExactTileCache: true },
              (tile) => {
                if (!tile.linear) throw Error('Missing exact float payload')
                received++
                tileTimes.push({
                  x: tile.x,
                  y: tile.y,
                  width: tile.width,
                  height: tile.height,
                  ms: tile.milliseconds,
                  graphMs: (tile as any).graphMs,
                  checkpointMs: (tile as any).checkpointMs,
                  workingTextureBytes: tile.workingTextureBytes,
                })
                const left = tile.x + Math.floor(options.view.x),
                  top = tile.y + Math.floor(options.view.y)
                for (
                  let y = Math.max(0, top + 1);
                  y < Math.min(options.height, top + tile.height - 1);
                  y++
                ) {
                  const fromX = Math.max(0, left + 1),
                    toX = Math.min(options.width, left + tile.width - 1)
                  if (toX <= fromX) continue
                  const start = ((y - top) * tile.width + fromX - left) * 4,
                    end = start + (toX - fromX) * 4,
                    offset = (y * options.width + fromX) * 4
                  pixels.set(tile.bytes.subarray(start, end), offset)
                  floats.set(tile.linear.subarray(start, end), offset)
                }
              },
            )
            const bits = new Uint32Array(floats.buffer)
            let byteDifferences = 0,
              floatBitDifferences = 0
            if (referenceBytes)
              for (let i = 0; i < pixels.length; i++) {
                byteDifferences += Number(pixels[i] !== referenceBytes[i])
                floatBitDifferences += Number(bits[i] !== referenceBits![i])
              }
            else {
              referenceBytes = pixels
              referenceBits = bits
            }
            const hash = async (data: ArrayBuffer) =>
              Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (v) =>
                v.toString(16).padStart(2, '0'),
              ).join('')
            const row = {
              side,
              round,
              received,
              planned: tiles.length,
              slowestTiles: tileTimes.sort((a, b) => b.ms - a.ms).slice(0, 8),
              totalMs: performance.now() - started,
              renderMs: result.milliseconds,
              compileMs: result.compileMs,
              graphMs: result.graphMs,
              finishMs: result.finishMs,
              checkpointMs: result.checkpointMs,
              peakTextureBytes: result.peakTextureBytes,
              drawCalls: result.drawCalls,
              previewLeaves: (result as any).previewLeaves,
              byteDifferences,
              floatBitDifferences,
              rgbaHash: await hash(pixels.buffer),
              floatHash: await hash(floats.buffer),
            }
            rows.push(row)
            console.log('HDR_TILE_RESULT ' + JSON.stringify(row))
            result.bitmap?.close()
          }
      } finally {
        client.dispose()
      }
      return { options, adapterInfo, rows }
    },
    {
      sizes,
      repeats,
      clipEdges: process.env.DESIGN_CLIP_EDGES === '1',
    },
  )
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      {
        scope:
          'Real WebGPU exact worker, fixed device viewport and camera; cache disabled, no UI or display FPS claim',
        budgetFailureCount: budgetFailures.length,
        ...results,
      },
      null,
      2,
    ),
  )
  const totals = new Map<number, { mode: number; count: number; ms: number }>()
  for (const group of profiles)
    for (const row of group) {
      const t = totals.get(row.mode) || { mode: row.mode, count: 0, ms: 0 }
      t.count += row.count
      t.ms += row.ms
      totals.set(row.mode, t)
    }
  await writeFile(join(output, 'budget-failures.json'), JSON.stringify(budgetFailures, null, 2))
  await writeFile(
    join(output, 'gpu-profile.json'),
    JSON.stringify(
      [...totals.values()].sort((a, b) => b.ms - a.ms),
      null,
      2,
    ),
  )
  for (const row of results.rows) {
    expect(row.received).toBe(row.planned)
    expect(row.byteDifferences).toBe(0)
    expect(row.floatBitDifferences).toBe(0)
  }
  if (process.env.DESIGN_BASELINE_RESULTS) {
    const baseline = JSON.parse(await readFile(process.env.DESIGN_BASELINE_RESULTS, 'utf8'))
    const { pageId: _oldPage, ...oldOptions } = baseline.options,
      { pageId: _newPage, ...newOptions } = results.options
    expect(newOptions).toEqual(oldOptions)
    for (const row of results.rows) {
      expect(row.rgbaHash).toBe(baseline.rows[0].rgbaHash)
      expect(row.floatHash).toBe(baseline.rows[0].floatHash)
    }
  }

  console.log(JSON.stringify({ output, status: 'passed' }))
} finally {
  await writeFile(join(output, 'server.log'), log)
  await browser?.close()
  server.kill('SIGTERM')
}
