/** Product UI operations and persisted material values, with the real WASM/GPU. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, paint, effect } from '../src/model'
const output =
  process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-editor-flows-')))
const doc = blank('Forma 交互与材质回归')
doc.schemaVersion = 5
const add = (n: ReturnType<typeof node>, parent?: ReturnType<typeof node>) => {
  doc.nodes[n.id] = n
  ;(parent ? parent.children : doc.pages[0].children).push(n.id)
  return n
}
const board = add(node('frame', 40, 35, 800, 520))
board.name = '验收画板'
board.radii = [16, 16, 16, 16]
const base = add(node('rectangle', 55, 100, 360, 270), board)
base.name = '渐变底色'
base.fills = [paint('#686cdb', 'linear')]
const orb = add(node('ellipse', 165, 125, 200, 200), board)
orb.name = '彩色背景'
orb.fills = [paint('#f8bb81', 'radial')]
const glass = add(node('rectangle', 85, 170, 330, 140), board)
glass.name = '玻璃验收'
glass.radii = [18, 18, 18, 18]
glass.fills = [{ ...paint('#ffffff'), opacity: 0.14 }]
glass.effects = [effect('glass')]
const texture = add(node('rectangle', 510, 110, 200, 230), board)
texture.name = '纹理验收'
texture.radii = [20, 20, 20, 20]
texture.fills = [paint('#bba68e', 'linear')]
texture.effects = [effect('texture')]
const heading = add(node('text', 55, 35, 680, 40), board)
heading.text = '玻璃 / 纹理 / 本地交互'
heading.fontSize = 26
await writeFile(join(output, 'materials.fd'), JSON.stringify(doc, null, 2))
const server = spawn(
  'bun',
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'],
  { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(Error('Vite timeout')), 20000)
    server.on('exit', (c) => {
      clearTimeout(t)
      reject(Error(`Vite ${c}`))
    })
    server.stdout.on('data', (c) => {
      const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(t)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: process.platform === 'darwin' ? ['--use-angle=metal'] : [],
  })
  const page = await browser.newPage({
      viewport: { width: 1440, height: 940 },
      deviceScaleFactor: 2,
    }),
    errors: string[] = [],
    steps: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(url)
  await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 20000 })
  await page
    .locator('input[type=file][accept*=".fd"]')
    .setInputFiles(join(output, 'materials.fd'))
  await expect(page.getByLabel('文档名称')).toHaveValue(doc.name, { timeout: 20000 })
  const surface = page.locator('.kernel-tiles'),
    canvas = page.getByTestId('canvas')
  const settle = async () => {
    await expect
      .poll(
        async () =>
          (await page.locator('.kernel-status.error').count())
            ? 'error'
            : await surface.getAttribute('data-detail-ready'),
        { timeout: 60000 },
      )
      .toBe('true')
  }
  const stored = () =>
    page.evaluate(async () => {
      const { localOpen } = await import('/src/local-store.ts')
      return (await localOpen())!.document
    })
  const change = async (label: string, value: string) => {
    const before = await surface.getAttribute('data-revision')
    const input = page.getByLabel(label, { exact: true })
    await input.fill(value)
    await input.press('Enter')
    await expect.poll(() => surface.getAttribute('data-revision')).not.toBe(before)
    await settle()
  }
  await settle()
  steps.push('import forma with glass and texture')
  await page.getByTestId(`layer-${glass.id}`).click()
  await expect(page.getByLabel('深度', { exact: true })).toHaveValue('8')
  const baseline = await canvas.screenshot()
  await change('深度', '24')
  expect((await canvas.screenshot()).equals(baseline)).toBe(false)
  steps.push('glass depth invalidates rendered pixels')
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByLabel('深度', { exact: true })).toHaveValue('8')
  await settle()
  expect((await canvas.screenshot()).equals(baseline)).toBe(true)
  steps.push('undo restores original pixels')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  await expect(page.getByLabel('深度', { exact: true })).toHaveValue('24')
  await settle()
  steps.push('redo restores glass parameters')
  for (const [label, value] of [
    ['折射 %', '65'],
    ['色散 %', '45'],
    ['光线角度', '135'],
    ['照明 %', '70'],
    ['磨砂', '4'],
  ])
    await change(label, value)
  await page.screenshot({ path: join(output, 'glass-controls.png') })
  steps.push('glass refraction dispersion lighting frost controls')
  await page.getByTestId(`layer-${texture.id}`).click()
  await change('纹理尺寸 X', '16')
  await change('纹理尺寸 Y', '32')
  await change('位移半径', '4')
  await page.getByLabel('裁剪到形状', { exact: true }).uncheck()
  await settle()
  steps.push('anisotropic texture displacement and clip toggle')
  await page.screenshot({ path: join(output, 'texture-controls.png') })
  await expect
    .poll(async () => (await stored()).nodes[texture.id]?.effects[0].texture?.noiseSize)
    .toEqual([16, 32])
  const saved = await stored()
  expect(saved.nodes[texture.id].effects[0].texture?.clipToShape).toBe(false)
  expect(saved.nodes[glass.id].effects[0].glass).toMatchObject({
    depth: 24,
    refraction: 0.65,
    dispersion: 0.45,
    lightAngle: 135,
    lightIntensity: 0.7,
  })
  steps.push('material parameters persisted in IndexedDB')
  await page.getByTestId(`layer-${base.id}`).click()
  for (const [value, label] of [
    ['shadow', '投影'],
    ['inner-shadow', '内阴影'],
    ['blur', '图层模糊'],
    ['background-blur', '背景模糊'],
    ['noise', '噪声'],
    ['texture', '纹理'],
    ['glass', '玻璃折射'],
  ]) {
    await page.getByLabel('添加效果', { exact: true }).selectOption(value)
    await settle()
    const card = page
      .locator('.property-card')
      .filter({ has: page.locator('b').filter({ hasText: new RegExp(`^${label}$`) }) })
    await expect(card).toBeVisible()
    await card.getByTitle('切换可见性', { exact: true }).click()
    await settle()
    await card.getByTitle('删除', { exact: true }).click()
    await settle()
    steps.push(`add / hide / remove ${value}`)
  }
  const row = page.getByTestId(`layer-${texture.id}`)
  await row.getByTitle('锁定图层', { exact: true }).click()
  await expect(row.getByTitle('解锁图层', { exact: true })).toBeVisible()
  await row.getByTitle('解锁图层', { exact: true }).click()
  await row.getByTitle('隐藏图层', { exact: true }).click()
  await expect(row).toHaveClass(/hidden-layer/)
  await row.getByTitle('显示图层', { exact: true }).click()
  await settle()
  steps.push('layer lock and visibility toggles')
  await row.click()
  const oldWidth = Number(await page.getByLabel('W', { exact: true }).inputValue())
  await change('W', String(oldWidth + 20))
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByLabel('W', { exact: true })).toHaveValue(String(oldWidth))
  await settle()
  steps.push('resize and undo')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await row.click()
  await page.keyboard.press(`${mod}+d`)
  await expect
    .poll(async () => Object.keys((await stored()).nodes).length)
    .toBe(Object.keys(doc.nodes).length + 1)
  await page.keyboard.press('Backspace')
  await expect
    .poll(async () => Object.keys((await stored()).nodes).length)
    .toBe(Object.keys(doc.nodes).length)
  steps.push('duplicate and delete')
  await page.reload()
  await expect(page.getByLabel('文档名称')).toHaveValue(doc.name)
  await page.getByTestId(`layer-${glass.id}`).click()
  await expect(page.getByLabel('深度', { exact: true })).toHaveValue('24')
  await settle()
  steps.push('reload preserves authored material values')
  const fallbackContext = await browser.newContext({ viewport: { width: 1100, height: 760 } })
  await fallbackContext.route('**/src/kernel/gpu/factory.ts*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      body: "export async function createGpu(){throw new Error('Injected GPU unavailable')} export function straightAlpha(v){return v}",
    }),
  )
  const fallbackPage = await fallbackContext.newPage()
  await fallbackPage.goto(url)
  await expect(fallbackPage.locator('canvas.kernel-surface[data-renderer=cpu]')).toBeVisible({
    timeout: 45000,
  })
  await expect(fallbackPage.locator('.kernel-status')).toHaveAttribute(
    'title',
    /Injected GPU unavailable/,
  )
  await fallbackContext.close()
  steps.push('GPU failure automatically falls back to real CPU rendering')
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ steps, errors, output }, null, 2))
  console.log(JSON.stringify({ checks: steps.length, steps, errors, output }))
} catch (error) {
  console.log(JSON.stringify({ output, error: String(error) }))
  throw error
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
