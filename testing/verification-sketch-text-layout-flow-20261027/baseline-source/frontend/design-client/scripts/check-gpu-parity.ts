import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-parity-')))
await mkdir(output, { recursive: true })
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const profiles = (process.env.DESIGN_PARITY_PROFILES || 'analytic,figma,figmaSubpixel').split(',')
const selected = process.env.DESIGN_PARITY_CASES?.split(',').map(Number)
const inputs = process.env.DESIGN_PARITY_INPUT
  ? JSON.parse(await readFile(process.env.DESIGN_PARITY_INPUT, 'utf8'))
  : undefined
const records: unknown[] = []
let failures = 0
let numericalFailures = 0
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite exited ${code}`))
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
    args: [
      ...(process.env.DESIGN_GPU_LOG ? ['--enable-logging=stderr', '--v=1'] : []),
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  })
  const page = await browser.newPage()
  if (process.env.VITE_DESIGN_TRACE_PASSES) page.on('console', (message) => {
    if (message.text().startsWith('DESIGN_PASS')) console.log(message.text())
  })
  await page.goto(`${base}/gpu-check.html`)
  const metadata = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter()
    if (!adapter) throw new Error('A real WebGPU adapter is required')
    return {
      userAgent: navigator.userAgent,
      gpu: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
      },
    }
  })
  const arithmetic = await page.evaluate(async () => {
    const { checkArithmetic } = await import('/src/kernel/gpu/arithmetic-probe.ts')
    return checkArithmetic()
  })
  await writeFile(join(output, 'arithmetic.json'), JSON.stringify(arithmetic, null, 2))
  numericalFailures += arithmetic.webgpu.failures + arithmetic.webgl2.failures
  console.log(JSON.stringify({ arithmetic }))
  const sampling = await page.evaluate(async () => {
    const { checkSampling } = await import('/src/kernel/gpu/sampling-probe.ts')
    return checkSampling()
  })
  await writeFile(join(output, 'sampling.json'), JSON.stringify(sampling, null, 2))
  numericalFailures += sampling.webgpu.failures + sampling.webgl2.failures
  console.log(JSON.stringify({ sampling }))
  const filter = await page.evaluate(async () => {
    const { checkFilter } = await import('/src/kernel/gpu/filter-probe.ts')
    return checkFilter()
  })
  await writeFile(join(output, 'filter.json'), JSON.stringify(filter, null, 2))
  numericalFailures += filter.webgpu.failures + filter.webgl2.failures
  console.log(JSON.stringify({ filter }))
  const coverage = await page.evaluate(async () => {
    const { checkCoverage } = await import('/src/kernel/gpu/coverage-probe.ts')
    return checkCoverage()
  })
  await writeFile(join(output, 'coverage.json'), JSON.stringify(coverage, null, 2))
  numericalFailures += coverage.webgpu.failures + coverage.webgl2.failures
  console.log(JSON.stringify({ coverage }))
  const surfaces = await page.evaluate(async () => {
    const { checkSurfaceLifetime } = await import('/src/kernel/gpu/surface-lifetime-probe.ts')
    return checkSurfaceLifetime()
  })
  await writeFile(join(output, 'surfaces.json'), JSON.stringify(surfaces, null, 2))
  numericalFailures += surfaces.failures
  console.log(JSON.stringify({ surfaces }))
  for (const profile of profiles) {
    const result = await page.evaluate(
      async ({ profile, selected, inputs }) => {
        const { KernelClient } = await import('/src/kernel/client.ts')
        const { initializePicking } = await import('/src/kernel/picking.ts')
        await initializePicking()
        const { default: initializeNormalization, GraphApi } = await import('/src/generated/design-kernel/design_kernel.js')
        await initializeNormalization({ module_or_path: '/kernel/design_kernel_bg.wasm' })
        const { precisionCases } = await import('/src/parity-fixtures.ts')
        const client = new KernelClient()
        const results = []
        try {
          const cases = inputs || precisionCases()
          for (const [index, input] of cases.entries()) {
            // Rust corpus rows may omit serde-defaulted arrays/name fields.
            // Use the real kernel's normalization, preserving its contract.
            if (selected && !selected.includes(index)) continue
            let document = input.document
            if (inputs) {
              const normalizer = new GraphApi(JSON.stringify(document))
              try { document = JSON.parse(normalizer.document_json()) }
              finally { normalizer.free() }
            }
            const options = { ...input.options, rasterProfile: profile }
            const renders = []
            const comparisons = []
            const linearComparisons = []
            const errors = []
            let reference: Uint8Array | undefined
            let linearReference: Uint8Array | undefined
            for (const backend of ['cpu', 'webgpu', 'webgl2']) {
              try {
                const result = await client.render(document, options, false, backend, true)
                result.bitmap?.close()
                if (result.backend !== backend)
                  throw new Error(`Requested ${backend}, got ${result.backend}`)
                const bytes = result.bytes
                if (reference) {
                  if (bytes.length !== reference.length)
                    throw new Error('Readback dimensions differ')
                  let maximum = 0,
                    differentBytes = 0,
                    differentPixels = 0
                  for (let i = 0; i < bytes.length; i += 4) {
                    let changed = false
                    for (let c = 0; c < 4; c++) {
                      const delta = Math.abs(bytes[i + c] - reference[i + c])
                      maximum = Math.max(maximum, delta)
                      if (delta) {
                        differentBytes++
                        changed = true
                      }
                    }
                    if (changed) differentPixels++
                  }
                  comparisons.push({ backend, maximum, differentBytes, differentPixels })
                } else reference = bytes
                let linearRgba: string | undefined
                if (document.colorManagement) {
                  if (!result.linear) throw new Error('Missing managed float readback')
                  const linearBytes = new Uint8Array(
                    result.linear.buffer,
                    result.linear.byteOffset,
                    result.linear.byteLength,
                  )
                  if (linearReference) {
                    if (linearBytes.length !== linearReference.length)
                      throw new Error('Float readback dimensions differ')
                    let differentBytes = 0
                    for (let i = 0; i < linearBytes.length; i++)
                      if (linearBytes[i] !== linearReference[i]) differentBytes++
                    linearComparisons.push({ backend, differentBytes })
                  } else linearReference = linearBytes.slice()
                  let binary = ''
                  for (let i = 0; i < linearBytes.length; i += 8192)
                    binary += String.fromCharCode(...linearBytes.subarray(i, i + 8192))
                  linearRgba = btoa(binary)
                }
                let binary = ''
                for (let i = 0; i < bytes.length; i += 8192)
                  binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
                renders.push({
                  backend,
                  rgba: btoa(binary),
                  linearRgba,
                  drawCalls: result.drawCalls,
                  milliseconds: result.milliseconds,
                  compileMs: result.compileMs,
                  intermediateFormat: result.intermediateFormat,
                  description: result.description,
                })
              } catch (error) {
                errors.push({ backend, error: String(error) })
              }
            }
            results.push({
              name: document.name,
              index,
              profile,
              document,
              options,
              renders,
              comparisons,
              linearComparisons,
              errors,
            })
          }
        } finally {
          client.dispose()
        }
        return results
      },
      { profile, selected, inputs },
    )
    for (const row of result) {
      const dir = join(output, `${profile}-${row.index}`)
      await mkdir(dir, { recursive: true })
      await writeFile(
        join(dir, 'request.json'),
        JSON.stringify({ document: row.document, options: row.options }),
      )
      for (const render of row.renders) {
        await writeFile(join(dir, `${render.backend}.rgba`), Buffer.from(render.rgba, 'base64'))
        if (render.linearRgba)
          await writeFile(
            join(dir, `${render.backend}.linear.f32`),
            Buffer.from(render.linearRgba, 'base64'),
          )
      }
      const failed =
        row.errors.length > 0 ||
        row.comparisons.length !== 2 ||
        row.comparisons.some((d) => d.differentBytes !== 0) ||
        (Boolean(row.document.colorManagement) &&
          (row.linearComparisons.length !== 2 ||
            row.linearComparisons.some((d) => d.differentBytes !== 0)))
      if (failed) failures++
      const { document, options, renders, ...record } = row
      records.push({
        ...record,
        failed,
        directory: dir,
        renders: renders.map(({ rgba, linearRgba, ...render }) => render),
      })
    }
    console.log(JSON.stringify({ profile, scenes: result.length, failuresSoFar: failures }))
  }
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ metadata, failures, numericalFailures, records }, null, 2),
  )
  console.log(JSON.stringify({ output, checks: records.length, failures, numericalFailures }))
  if (failures || numericalFailures)
    throw new Error(`${failures} scenes and ${numericalFailures} numeric vectors failed strict parity; artifacts saved in ${output}`)
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
