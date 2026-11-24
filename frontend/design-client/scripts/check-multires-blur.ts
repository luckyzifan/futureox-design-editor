// Real-fixture hardware-GPU pixel probe for the display-only multires Gaussian
// prototype. Spawns the worktree Vite dev server (build-time flag from env),
// launches headless Chromium with a real Metal WebGPU adapter, imports the
// private .sketch through the production kernel and compares the WebGPU display
// lane against the exact CPU reference. Observation: target pixel readback.
import { chromium } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = process.env.MULTIRES_FIXTURE
if (!fixture) throw new Error('MULTIRES_FIXTURE must point at an absolute .sketch path')
const flag = process.env.VITE_DESIGN_MULTIRES_BLUR === '1' ? '1' : 'off'
const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'futureox-multires-')))
await mkdir(output, { recursive: true })
const bytes = new Uint8Array(await readFile(fixture))
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, VITE_DESIGN_MULTIRES_BLUR: flag === '1' ? '1' : '' },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const report: Record<string, unknown> = { status: 'running', flag, fixture: fixture.split('/').pop(), startedAt: new Date().toISOString() }
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 30000)
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)) })
    server.stdout.on('data', chunk => { const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]) } })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ deviceScaleFactor: 2 })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(String(e)))
  const dbg: string[] = []
  page.on('console', m => { const t = m.text(); if (t.startsWith('MULTIRES_DBG')) dbg.push(t) })
  await page.goto(`${base}/multires-blur-check.html`)
  await page.waitForFunction(() => typeof (window as any).__multiresCheck === 'function', { timeout: 30000 })
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter(); if (!a) throw new Error('A real WebGPU adapter is required')
    const info = await a.requestAdapterInfo?.()
    return { vendor: info?.vendor, architecture: info?.architecture, description: info?.description }
  })
  report.adapter = adapter
  await page.evaluate(async b => { await (window as any).__multiresCheck(new Uint8Array(b)) }, Array.from(bytes))
  await page.waitForFunction(() => {
    const t = document.querySelector('#results')?.textContent ?? ''
    try { return JSON.parse(t).status !== 'running' } catch { return false }
  }, { timeout: 180000 })
  const result = await page.evaluate(() => JSON.parse(document.querySelector('#results')!.textContent!))
  Object.assign(report, result)
  report.pageErrors = errors
  if (dbg.length) report.debug = dbg.slice(0, 12)
  if (errors.length) report.status = 'failed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
} finally {
  await writeFile(join(output, `multires-${flag}.json`), JSON.stringify(report, null, 2))
  console.log(`MULTIRES_REPORT ${join(output, `multires-${flag}.json`)}`)
  console.log(JSON.stringify(report, null, 2))
  await browser?.close()
  server.kill('SIGTERM')
}