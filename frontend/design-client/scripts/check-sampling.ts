/** Standalone GPU oracle, isolated from the editor and other running browsers. */
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-bounded-sampling-'))
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let deadline: ReturnType<typeof setTimeout> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => { clearTimeout(timer); reject(Error(`Vite exited ${code}`)) })
    server.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage()
  await page.route('**/__bounded_sampling_probe__', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Exact bounded sampling probe</title>' }))
  await page.goto(`${base}/__bounded_sampling_probe__`)
  const result = await Promise.race([
    page.evaluate(async () => { const { checkSampling } = await import('/src/kernel/gpu/sampling-probe.ts'); return checkSampling() }),
    new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error('Bilinear GPU probe exceeded the fixed 30 second budget')), 30000) }),
  ])
  const passed = Object.values(result).every((backend) => backend.failures === 0 && backend.boundedAccepted > 200 && backend.boundedDeclined > 100)
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: passed ? 'passed' : 'failed', result, output }, null, 2))
  console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', result, output }))
  if (!passed) throw Error('Bilinear GPU oracle failed')
} catch (error) {
  await writeFile(join(output, 'error.json'), JSON.stringify({ error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally { clearTimeout(deadline); await browser?.close(); server.kill('SIGTERM') }
