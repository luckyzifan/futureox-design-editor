/** Real React/WASM and browser-canvas ownership regression. The optional URL
 * points to an already-owned test server; otherwise this script owns Vite. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-lod-lifecycle-'))
const server = process.env.DESIGN_TEST_URL ? undefined : spawn('bun', [
  'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort',
], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined
const errors: string[] = [], checks: string[] = []
try {
  const url = process.env.DESIGN_TEST_URL || await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
    server!.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)) })
    server!.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  browser = await chromium.launch({
    headless: true, chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 })
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(url)
  await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30000 })
  await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'true', { timeout: 60000 })
  await expect.poll(async () => Number(await page!.locator('.kernel-tiles').getAttribute('data-lod-cache-bytes'))).toBeGreaterThan(0)
  checks.push('the real editor paints and publishes active coarse LOD snapshots')

  const ownership = await page.evaluate(async () => {
    const { LodSnapshotCache } = await import('/src/kernel/lod-snapshot-cache.ts')
    const cache = new LodSnapshotCache(32)
    const source = document.createElement('canvas')
    source.width = 2; source.height = 2
    const context = source.getContext('2d')!
    context.fillStyle = '#ff0000'; context.fillRect(0, 0, 2, 2)
    cache.beginRevision(1); cache.publish(1, 'tile', source)
    const renderSelected = cache.borrow(1, 'tile')!
    context.fillStyle = '#0000ff'; context.fillRect(0, 0, 2, 2)
    cache.publish(1, 'tile', source)
    cache.beginRevision(2)
    const staleUnavailable = cache.borrow(2, 'tile') === undefined
    const lateRejected = !cache.publish(1, 'tile', source)
    cache.publish(2, 'tile', source)
    const latest = cache.borrow(2, 'tile')!
    cache.clear()
    source.width = 0 // Producer has now been unmounted/reclaimed.
    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)
    const destination = document.createElement('canvas')
    destination.width = 2; destination.height = 2
    const draw = destination.getContext('2d')!
    draw.drawImage(renderSelected, 0, 0)
    const oldPixels = [...draw.getImageData(0, 0, 1, 1).data]
    draw.drawImage(latest, 0, 0)
    const newPixels = [...draw.getImageData(0, 0, 1, 1).data]
    return { oldPixels, newPixels, staleUnavailable, lateRejected, cacheBytes: cache.bytes }
  })
  expect(ownership).toEqual({
    oldPixels: [255, 0, 0, 255], newPixels: [0, 0, 255, 255],
    staleUnavailable: true, lateRejected: true, cacheBytes: 0,
  })
  checks.push('delayed real drawImage keeps retired pixels valid and rejects stale-document publication')

  const canvas = page.getByTestId('canvas'), bounds = (await canvas.boundingBox())!
  const count = await page.getByRole('treeitem').count()
  for (let i = 0; i < 8; i++) {
    await page.getByRole('button', { name: '形状工具', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '矩形', exact: true }).click()
    await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .65)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width * .55, bounds.y + bounds.height * .75, { steps: 3 })
    await page.mouse.up()
    await expect(page.getByRole('treeitem')).toHaveCount(count + 1)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByRole('treeitem')).toHaveCount(count)
    await page.getByRole('button', { name: '形状工具', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '椭圆', exact: true }).click()
    await expect(canvas).toHaveClass(/canvas-ellipse/)
    expect(Number(await page.locator('.kernel-tiles').getAttribute('data-lod-cache-bytes'))).toBeLessThanOrEqual(16 * 1024 * 1024)
  }
  await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'true', { timeout: 60000 })
  checks.push('eight real rectangle/create/undo/ellipse cycles keep the canvas mounted within the LOD byte budget')
  expect(errors).toEqual([])
  await page.screenshot({ path: join(output, 'lod-lifecycle.png') })
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, ownership, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') })
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error), output }, null, 2))
  throw error
} finally {
  await browser?.close()
  server?.kill('SIGTERM')
}
