/** Small real-GPU gate for default-on and explicit-off prefix configuration. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

let output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-exact-prefix-')))
const rows: {
  mode: string
  prefixFrames: number
  acceptedPixels: number
  frameScratchBytes: number
  scratchAfterFinish: number
  floatComponents: number
}[] = []
let reference: Uint32Array | undefined

const project = fileURLToPath(new URL('..', import.meta.url))
const shaderRoot = fileURLToPath(
  new URL('../../../design-studio/crates/design-kernel/shaders', import.meta.url),
)
const browserErrors: { mode: string; type: string; message: string }[] = []
let ownedOutput = false
let inputsBefore: Record<string, string> | undefined
let inputsAfter: Record<string, string> | undefined

async function inputHashes() {
  const hashes: Record<string, string> = {}
  async function walk(
    root: string,
    directory: string,
    label: string,
    ancestors = new Set<string>(),
  ) {
    const canonical = await realpath(directory)
    if (ancestors.has(canonical)) throw Error(`Input symlink cycle: ${directory}`)
    const next = new Set(ancestors).add(canonical)
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name)
      const info = await stat(path)
      if (info.isDirectory()) await walk(root, path, label, next)
      else if (info.isFile())
        hashes[`${label}/${relative(root, path).replaceAll('\\', '/')}`] = createHash('sha256')
          .update(await readFile(path))
          .digest('hex')
      else throw Error(`Unsupported input type: ${path}`)
    }
  }
  await walk(join(project, 'src'), join(project, 'src'), 'src')
  await walk(join(project, 'public/kernel'), join(project, 'public/kernel'), 'public/kernel')
  await walk(shaderRoot, shaderRoot, 'shaders')
  for (const name of [
    'scripts/check-exact-prefix.ts',
    'gpu-check.html',
    'vite.config.ts',
    'package.json',
    'tsconfig.json',
    'public/fonts/NotoSansSC.ttf',
  ])
    hashes[name] = createHash('sha256')
      .update(await readFile(join(project, name)))
      .digest('hex')
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)))
}
function changedInputs(before?: Record<string, string>, after?: Record<string, string>) {
  if (!before || !after) return []
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (name) => before[name] !== after[name],
  )
}
async function evidence(name: string, value: unknown) {
  await writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
}

try {
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length)
    throw Error(`Refusing non-empty evidence directory: ${output}`)
  // Exclusive ownership prevents two invocations from overwriting one directory.
  await evidence('run-owner.json', { pid: process.pid, startedAt: new Date().toISOString() })
  ownedOutput = true
  inputsBefore = await inputHashes()
  await evidence('inputs-before.json', inputsBefore)
  for (const mode of ['default', 'off']) {
    const env = { ...process.env }
    delete env.VITE_PRIVATE_PREFIX
    if (mode === 'off') env.VITE_DESIGN_EXACT_PREFIX = '0'
    else delete env.VITE_DESIGN_EXACT_PREFIX
    const server = spawn(
      'bun',
      ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
      {
        cwd: new URL('..', import.meta.url),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    const counters: { acceptedPixels: number }[] = []
    try {
      const base = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20_000)
        server.once('exit', (code) => {
          clearTimeout(timer)
          reject(Error(`Vite exited ${code}`))
        })
        server.stdout.on('data', (chunk) => {
          const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
          if (match) {
            clearTimeout(timer)
            resolve(match[0])
          }
        })
      })
      browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
      })
      const page = await browser.newPage()
      page.on('pageerror', (error) =>
        browserErrors.push({ mode, type: 'pageerror', message: error.stack || error.message }),
      )
      await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }))
      page.on('console', (message) => {
        if (message.type() === 'error')
          browserErrors.push({ mode, type: 'console.error', message: message.text() })
        if (message.text().startsWith('DESIGN_GPU_PREFIX '))
          counters.push(JSON.parse(message.text().slice('DESIGN_GPU_PREFIX '.length)))
      })
      await page.goto(`${base}/gpu-check.html`)
      const result = await page.evaluate(async () => {
        const { initializePicking } = await import('/src/kernel/picking.ts')
        const { VectorEngine } = await import('/src/generated/design-kernel/design_kernel.js')
        const { blank, node, effect } = await import('/src/model.ts')
        const { defaultColorSettings } = await import('/src/color.ts')
        const { createGpu } = await import('/src/kernel/gpu/factory.ts')
        await initializePicking()
        const document = blank('Exact prefix configuration gate')
        document.schemaVersion = 3
        document.rasterProfile = 'figma'
        document.colorManagement = defaultColorSettings()
        const shape = node('rectangle', 32, 32, 64, 64)
        shape.effects = [{ ...effect('blur'), radius: 32 }]
        document.nodes[shape.id] = shape
        document.pages[0].children = [shape.id]
        const kernel = new VectorEngine()
        kernel.load_document(JSON.stringify(document))
        const scene = JSON.parse(
          kernel.compile_gpu(
            JSON.stringify({
              pageId: document.pages[0].id,
              width: 128,
              height: 128,
              view: { x: 0, y: 0, zoom: 1 },
              transparent: false,
              grid: false,
              rasterProfile: 'figma',
            }),
          ),
        )
        kernel.free()
        const renderer = await createGpu(
          'webgpu',
          true,
          false,
          document.colorManagement,
          undefined,
          true,
          true,
        )
        try {
          if (renderer.driver.scratchBytes)
            throw Error('Scratch was allocated before an eligible pass')
          const result = await renderer.render(scene, true, false)
          if (!result.linear) throw Error('Missing real GPU float readback')
          return {
            frameScratchBytes: renderer.driver.frameScratchBytes || 0,
            scratchAfterFinish: renderer.driver.scratchBytes || 0,
            bits: Array.from(
              new Uint32Array(result.linear.buffer, result.linear.byteOffset, result.linear.length),
            ),
          }
        } finally {
          renderer.dispose()
        }
      })
      const bits = Uint32Array.from(result.bits)
      await writeFile(join(output, `${mode}.f32`), new Uint8Array(bits.buffer), { flag: 'wx' })
      if (reference) {
        if (
          reference.length !== bits.length ||
          bits.some((value, index) => value !== reference![index])
        )
          throw Error('Prefix default/off float bits differ')
      } else reference = bits
      const acceptedPixels = counters.reduce((sum, row) => sum + row.acceptedPixels, 0)
      if (
        mode === 'default'
          ? acceptedPixels <= 0 || result.frameScratchBytes !== 4 * 1024 * 1024
          : counters.length !== 0 || result.frameScratchBytes !== 0
      )
        throw Error(`Prefix ${mode} did not exercise the expected implementation`)
      if (result.scratchAfterFinish !== 0) throw Error('Prefix scratch survived completed frame')
      rows.push({
        mode,
        prefixFrames: counters.length,
        acceptedPixels,
        frameScratchBytes: result.frameScratchBytes,
        scratchAfterFinish: result.scratchAfterFinish,
        floatComponents: bits.length,
      })
    } finally {
      await browser?.close()
      server.kill('SIGTERM')
    }
  }
  inputsAfter = await inputHashes()
  await evidence('inputs-after.json', inputsAfter)
  const changed = changedInputs(inputsBefore, inputsAfter)
  if (browserErrors.length) throw Error(`${browserErrors.length} browser error events occurred`)
  if (changed.length) throw Error(`Inputs changed during the gate: ${changed.join(', ')}`)
  await evidence('results.json', {
    status: 'passed',
    scope:
      'Real WebGPU: absent flag exercises useful prefix work; explicit zero disables it; all float bits equal. Complete src, shaders, public/kernel, font and launcher inputs unchanged.',
    rows,
    browserErrors,
    sourceHashes: inputsAfter,
  })
  console.log(JSON.stringify({ output, status: 'passed', rows }))
} catch (error) {
  const requestedOutput = output
  if (!ownedOutput) output = await mkdtemp(join(tmpdir(), 'forma-exact-prefix-failure-'))
  let hashError: string | undefined
  if (inputsBefore && !inputsAfter) {
    try {
      inputsAfter = await inputHashes()
    } catch (failure) {
      hashError = String(failure)
    }
  }
  await evidence('failure.json', {
    status: 'failed',
    requestedOutput,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
    rows,
    browserErrors,
    inputsBefore,
    inputsAfter,
    changedInputs: changedInputs(inputsBefore, inputsAfter),
    hashError,
  })
  console.error(JSON.stringify({ output, status: 'failed', error: String(error) }))
  process.exitCode = 1
}
