/** Mip-chain tile gate: image-heavy document at heavy minification, mips and
 * atlas packing on. Asserts (1) the wasm sampler actually selects levels,
 * (2) the GPU frame is byte-identical to the CPU reference with the same
 * policy bits — atlas slots are zero-padded so packing cannot move a byte,
 * (3) the surface ledger stays within budget. Mirrors check-hdr-memory.ts. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const project = fileURLToPath(new URL('..', import.meta.url))
const output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-mip-tiles-')))
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
await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
const hashes: Record<string, string> = {}
for (const file of ['gpu/renderer.ts', 'render-worker.ts', 'render-policy.ts', 'client.ts', 'gpu/factory.ts'])
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
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2))
console.log(JSON.stringify({ output }))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Mips ship off by default; the gate forces the opt-in bits for this
    // server so the worker CPU reference and the GPU path run level-selected
    // with atlas-packed slots (both must stay byte-exact against the CPU).
    env: { ...process.env, VITE_DESIGN_MIPS: '1', VITE_DESIGN_IMAGE_ATLAS: '1' },
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
  await page.goto(base + '/gpu-check.html')
  const rows = await page.evaluate(async () => {
    // 1024² gradient PNG: at zoom 1/8 the fill integrates 8×8 texel boxes,
    // selecting level 3 of the chain.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1024
    const ctx = canvas.getContext('2d')!
    const gradient = ctx.createLinearGradient(0, 0, 1024, 1024)
    gradient.addColorStop(0, '#402050')
    gradient.addColorStop(1, '#e0a030')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 1024, 1024)
    ctx.fillStyle = '#ffffff'
    for (let i = 0; i < 1024; i += 8) ctx.fillRect(i, 0, 4, 1024)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const uri = `data:image/png;base64,${btoa(binary)}`
    const doc = {
      schemaVersion: 4,
      id: 'mip-gate',
      name: 'Mip gate',
      pages: [{ id: 'p', name: 'p', children: ['img'], background: '#ffffff' }],
      nodes: {
        img: {
          id: 'img',
          kind: 'rectangle',
          width: 1024,
          height: 1024,
          fills: [{ kind: 'image', color: '#000000', image: uri, fit: 'stretch' }],
        },
      },
    }
    const options = {
      pageId: 'p',
      width: 512,
      height: 512,
      transparent: false,
      rasterProfile: 'figma',
      view: { x: 0, y: 0, zoom: 0.125 },
    }
    const rows: unknown[] = []
    // 1. The wasm sampler must select levels: identical engines, bit flips
    //    only with the switch.
    const kernel = await import('/src/generated/design-kernel/design_kernel')
    await kernel.default({ module_or_path: '/kernel/design_kernel_bg.wasm' })
    const renderWith = async (mips: boolean) => {
      const engine = new kernel.VectorEngine()
      engine.load_document(JSON.stringify(doc))
      engine.set_image_mips(mips)
      return engine.render_rgba(JSON.stringify(options))
    }
    const off = await renderWith(false)
    const on = await renderWith(true)
    const differing = off.reduce((n, v, i) => n + (v !== on[i] ? 1 : 0), 0)
    rows.push({ check: 'wasm-sampler-selects-levels', differing, bytes: on.length })
    // 2. GPU frame parity against the worker CPU reference under mips on.
    const { KernelClient } = await import('/src/kernel/client.ts')
    const client = new KernelClient()
    try {
      const cpu = await client.render(doc, options, false, 'cpu')
      const gpu = await client.render(doc, options, false, 'webgpu', true)
      const gpuBytes = gpu.bytes ?? gpu.rgba
      let mismatched = -1
      if (gpuBytes && cpu.bytes) {
        mismatched = 0
        for (let i = 0; i < cpu.bytes.length; i++)
          if (cpu.bytes[i] !== gpuBytes[i]) mismatched++
      }
      rows.push({
        check: 'gpu-cpu-parity-mips-on',
        backend: gpu.backend,
        mismatched,
        bytes: gpuBytes?.length,
        cpuBytes: cpu.bytes?.length,
        peakTextureBytes: gpu.peakTextureBytes,
      })
      if (mismatched !== 0) throw Error(`GPU/CPU parity under mips violated (${mismatched} bytes)`)
      if ((gpu.peakTextureBytes || 0) > 256 * 1024 * 1024) throw Error('Surface budget exceeded')
      if (differing === 0) throw Error('Mip switch did not change minified output; level selection is not wired')
      rows.push({ check: 'gpu-frame-complete' })
    } finally {
      client.dispose()
    }
    return rows
  })
  await writeFile(join(output, 'results.json'), JSON.stringify({ rows }, null, 2))
  console.log(JSON.stringify(rows))
  const parity = rows.find((row) => (row as { check?: string }).check === 'gpu-cpu-parity-mips-on') as
    | { mismatched?: number; backend?: string }
    | undefined
  if (!parity || parity.mismatched !== 0 || parity.backend !== 'webgpu')
    throw Error('Mip tile gate failed; see results.json')
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
