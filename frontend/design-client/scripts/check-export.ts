import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { blank, node } from '../src/model'

const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-export-')))
await mkdir(output, { recursive: true })
const doc = blank()
doc.name = 'CPU export acceptance'
const icon = node('frame', -12.375, 7.125, 24, 24)
icon.name = 'Icon 24'
icon.clip = true
const phone = node('frame', 30.25, -20.5, 390, 844)
phone.name = 'Phone 390'
phone.clip = true
const red = node('rectangle', 0, 0, 24, 24)
red.name = 'Icon content'
red.fills[0].color = '#ff0000'
icon.fills = []
icon.children = [red.id]
const text = node('rectangle', 10, 10, 120, 20)
text.name = 'Phone content'
text.fills[0].color = '#3355aa'
phone.children = [text.id]
doc.nodes = Object.fromEntries([icon, phone, red, text].map((value) => [value.id, value]))
doc.pages[0].children = [icon.id, phone.id]
const fixture = join(output, 'export-input.fd')
await writeFile(fixture, JSON.stringify(doc))
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
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
    server.stderr.on('data', (chunk) => process.stderr.write(chunk))
  })
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.DESIGN_CHROMIUM_EXECUTABLE,
    chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const results: unknown[] = []
  for (const dpr of [1, 2, 3]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: dpr,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.addInitScript(() => {
      const NativeWorker = window.Worker
      const evidence = {
        requests: [] as { png: boolean; backend: string }[],
        terminated: 0,
        urls: new Set<string>(),
      }
      ;(window as any).__exportEvidence = evidence
      window.Worker = class extends NativeWorker {
        postMessage(message: any, transfer?: any) {
          evidence.requests.push({ png: !!message.png, backend: message.backend })
          super.postMessage(message, transfer)
        }
        terminate() {
          evidence.terminated++
          super.terminate()
        }
      }
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (blob) => {
        const url = create(blob)
        evidence.urls.add(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        evidence.urls.delete(url)
        revoke(url)
      }
    })
    await page.goto(base)
    await expect(page.locator('.save-status')).not.toHaveText('载入中', { timeout: 60000 })
    await page.locator('input[type=file]').setInputFiles(fixture)
    await expect(page.getByRole('treeitem', { name: 'Icon 24', exact: true })).toBeVisible({
      timeout: 60000,
    })
    const openPanel = async (name: string) => {
      await page.getByRole('treeitem', { name, exact: true }).click()
      await page.getByRole('button', { name: '导出', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '导出图像', exact: true })).toBeVisible()
    }
    const batch = async (name: string, width: number, height: number) => {
      await openPanel(name)
      await page.getByRole('button', { name: '生成 PNG', exact: true }).click()
      await expect(
        page.getByRole('dialog', { name: '导出图像', exact: true }).getByRole('status'),
      ).toHaveText('已生成 3 个 PNG 文件', {
        timeout: 120000,
      })
      const assets = []
      for (const scale of [1, 2, 3]) {
        const img = page.getByAltText(`${scale}x 切图预览`, { exact: true })
        await expect(img).toBeVisible()
        await expect
          .poll(() =>
            img.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
          )
          .toBe(true)
        const size = await img.evaluate((image: HTMLImageElement) => [
          image.naturalWidth,
          image.naturalHeight,
        ])
        expect(size).toEqual([width * scale, height * scale])
        const link = page.getByRole('link', {
          name: `下载 CPU export acceptance-${name}@${scale}x.png`,
          exact: true,
        })
        const event = page.waitForEvent('download')
        await link.click()
        const download = await event
        const path = join(output, `dpr${dpr}-${download.suggestedFilename()}`)
        await download.saveAs(path)
        const bytes = await readFile(path)
        expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual(size)
        assets.push({
          name: download.suggestedFilename(),
          width: size[0],
          height: size[1],
          sha256: createHash('sha256').update(bytes).digest('hex'),
        })
      }
      if (dpr === 1)
        await page.screenshot({ path: join(output, `${name}-export.png`), fullPage: true })
      await page.getByRole('button', { name: '关闭切图', exact: true }).click()
      expect(await page.evaluate(() => (window as any).__exportEvidence.urls.size)).toBe(0)
      return assets
    }
    await openPanel('Icon 24')
    const panel = page.getByRole('dialog', { name: '导出图像', exact: true })
    const savedDocument = () => page.evaluate(async () => {
      const { localOpen } = await import('/src/local-store.ts')
      return JSON.stringify((await localOpen())!.document)
    })
    const beforeKeys = await savedDocument()
    for (const key of ['Delete', 'Backspace', 'Enter', 'ControlOrMeta+z']) {
      await panel.press(key)
      await expect(page.getByRole('treeitem', { name: 'Icon 24', exact: true })).toBeVisible()
      // The product's persistence debounce is 350ms. Check each key before
      // the next key so mutation followed by undo cannot cancel the evidence.
      await page.waitForTimeout(500)
      expect(await savedDocument(), `dialog key ${key} changed the document`).toBe(beforeKeys)
    }
    await page.getByRole('button', { name: '关闭切图', exact: true }).click()
    const iconAssets = await batch('Icon 24', 24, 24)
    const phoneAssets = await batch('Phone 390', 390, 844)
    await openPanel('Icon 24')
    await page.getByRole('radio', { name: '自定义区域', exact: true }).check()
    for (const [key, value] of Object.entries({
      x: '-12.375',
      y: '7.125',
      width: '12.25',
      height: '9.5',
    }))
      await page.getByLabel(`切片 ${key}`, { exact: true }).fill(value)
    await page.getByRole('button', { name: '生成 PNG', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '导出图像', exact: true }).getByRole('status'),
    ).toHaveText('已生成 3 个 PNG 文件', {
      timeout: 60000,
    })
    for (const scale of [1, 2, 3]) {
      await expect
        .poll(() =>
          page
            .getByAltText(`${scale}x 切图预览`, { exact: true })
            .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true)
      expect(
        await page
          .getByAltText(`${scale}x 切图预览`, { exact: true })
          .evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]),
      ).toEqual([Math.ceil(12.25 * scale), Math.ceil(9.5 * scale)])
    }
    await page.getByLabel('切片 width', { exact: true }).fill('-1')
    await page.getByRole('button', { name: '生成 PNG', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '导出图像', exact: true }).getByRole('status'),
    ).toHaveText('切片边界无效')
    expect(await page.locator('.export-assets img').count()).toBe(0)
    await page.getByRole('button', { name: '关闭切图', exact: true }).click()
    await openPanel('Phone 390')
    await page.route('**/fonts/NotoSansSC.ttf', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      await route.continue().catch(() => {})
    })
    await page.getByRole('button', { name: '生成 PNG', exact: true }).click()
    await page.getByRole('button', { name: '取消导出', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '导出图像', exact: true }).getByRole('status'),
    ).toHaveText('已取消导出')
    await page.unroute('**/fonts/NotoSansSC.ttf')
    await page.getByRole('button', { name: '生成 PNG', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '导出图像', exact: true }).getByRole('status'),
    ).toHaveText('已生成 3 个 PNG 文件', {
      timeout: 120000,
    })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '导出图像', exact: true })).toHaveCount(0)
    const evidence = await page.evaluate(() => {
      const evidence = (window as any).__exportEvidence
      return {
        pngRequests: evidence.requests.filter((request: any) => request.png),
        terminated: evidence.terminated,
        activeUrls: evidence.urls.size,
      }
    })
    expect(evidence.pngRequests.length).toBeGreaterThanOrEqual(12)
    expect(evidence.pngRequests.every((request: any) => request.backend === 'cpu')).toBe(true)
    expect(evidence.activeUrls).toBe(0)
    expect(errors).toEqual([])
    results.push({
      dpr,
      iconAssets,
      phoneAssets,
      explicitSlice: true,
      invalidRetry: true,
      cancelRetry: true,
      escapeCleanup: true,
      evidence,
      errors,
    })
    await context.close()
  }
  // DPR affects display pixels, never the exported bytes.
  for (let index = 1; index < results.length; index++) {
    expect((results[index] as any).iconAssets).toEqual((results[0] as any).iconAssets)
    expect((results[index] as any).phoneAssets).toEqual((results[0] as any).phoneAssets)
  }
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify({ browser: browser.version(), cpuOnly: true, results }, null, 2),
  )
  console.log(JSON.stringify({ output, passed: true, dpr: [1, 2, 3], results }, null, 2))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
