/** Owned GPU timestamp probe using the real document and worker pipeline. */
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fixture = process.argv[2]
if (!fixture?.startsWith('/')) throw Error('Pass an absolute .fd fixture path')
process.env.VITE_DESIGN_GPU_TIMINGS = '1'
const output = await mkdtemp(join(tmpdir(), 'design-tile-profile-'))
const server = await createServer({ root: new URL('..', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 })
  const errors: string[] = []; page.on('pageerror', e => errors.push(String(e)))
  await page.goto(server.resolvedUrls!.local[0] + 'canvas-performance-check.html')
  console.log(JSON.stringify({ adapter: await page.evaluate(async () => { const i=(await navigator.gpu.requestAdapter())?.info; return i && {vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description} }) }))
  await page.locator('#file').setInputFiles(fixture)
  await page.locator('#run').click()
  await page.waitForFunction(() => {
    try { return ['passed', 'failed'].includes(JSON.parse(document.querySelector('#results')!.textContent!).status) } catch { return false }
  }, null, { timeout: 180000 })
  const report = JSON.parse(await page.locator('#results').innerText())
  await writeFile(join(output, 'results.json'), JSON.stringify({ ...report, errors }, null, 2))
  console.log(JSON.stringify({ output, status: report.status, error: report.error, rows: report.rows.map((r: any) => ({
    ...r, passTimings: r.passTimings?.slice(0, 8),
  })) }))
  if (report.status !== 'passed' || errors.length) throw Error('GPU profiling failed')
} finally { await browser?.close(); await server.close() }
