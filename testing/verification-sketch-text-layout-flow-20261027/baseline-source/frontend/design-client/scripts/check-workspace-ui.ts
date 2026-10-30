/** Isolated browser workspace acceptance. Uses real React/WASM; no user's browser/profile. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, paint } from '../src/model'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-workspace-ui-'))
const doc = blank('本机工作区交互验收'), a = node('rectangle', 30, 40, 120, 100), b = node('rectangle', 200, 40, 180, 100), frame = node('frame', 450, 20, 200, 180)
a.name = '蓝色图层'; a.fills = [paint('#0d99ff')]; b.name = '珊瑚图层'; b.fills = [paint('#ff846b')]; frame.name = '目标画板'
doc.nodes = { [a.id]: a, [b.id]: b, [frame.id]: frame }; doc.pages[0].children = [a.id, b.id, frame.id]
const fixture = join(output, 'workspace.fd'); await writeFile(fixture, JSON.stringify(doc))
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let currentPage: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined
const checks: string[] = [], errors: string[] = []
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => { clearTimeout(timer); reject(Error(`Vite exited ${code}`)) })
    server.stdout.on('data', (chunk) => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2 })
  currentPage = page
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(url)
  await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30000 })
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(page.getByLabel('文档名称')).toHaveValue(doc.name, { timeout: 30000 })
  await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready', 'true', { timeout: 60000 })
  const canvas = page.getByTestId('canvas')
  const stored = () => page.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())!.document })
  for (const width of [1440, 1000]) {
    await page.setViewportSize({ width, height: 940 })
    await expect(page.locator('.workspace-rail')).toBeVisible()
    await expect(page.getByRole('tab', { name: '设计', exact: true })).toBeVisible()
    const bounds = await canvas.boundingBox(), toolbar = await page.getByRole('toolbar', { name: '设计工具' }).boundingBox()
    expect(bounds && toolbar).toBeTruthy()
    expect(toolbar!.x).toBeGreaterThanOrEqual(bounds!.x)
    expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
    expect(toolbar!.y + toolbar!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
    await page.getByRole('button', { name: '形状工具', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '矩形', exact: true }).click()
    await expect(canvas).toHaveClass(/canvas-rectangle/)
    await page.mouse.move(bounds!.x + bounds!.width * .35, bounds!.y + bounds!.height * .65)
    await page.mouse.down(); await page.mouse.move(bounds!.x + bounds!.width * .55, bounds!.y + bounds!.height * .75, { steps: 8 }); await page.mouse.up()
    await expect(page.getByRole('treeitem')).toHaveCount(4)
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(page.getByRole('treeitem')).toHaveCount(3)
    await page.getByRole('button', { name: '形状工具', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '椭圆', exact: true }).click()
    await expect(canvas).toHaveClass(/canvas-ellipse/)
    await page.getByRole('button', { name: '选择', exact: true }).click()
    await page.getByRole('tab', { name: '原型', exact: true }).click()
    await expect(page.getByRole('region', { name: '原型属性' })).toBeVisible()
    await page.getByRole('tab', { name: '设计', exact: true }).click()
    await page.screenshot({ path: join(output, `workspace-${width}.png`) })
    checks.push(`${width}px: toolbelt inside canvas; rectangle creation + undo; shape picker; Design/Prototype`)
  }
  await page.getByTestId(`layer-${a.id}`).click()
  await page.getByRole('tab', { name: '原型', exact: true }).click()
  await page.getByRole('button', { name: '添加交互', exact: true }).click()
  await expect(page.getByLabel('交互触发', { exact: true })).toHaveValue('click')
  await page.getByLabel('交互触发', { exact: true }).selectOption('hover')
  expect(await page.locator('.embedded-design-tools').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: join(output, 'workspace-1000-prototype.png') })
  await page.getByRole('tab', { name: '设计', exact: true }).click()
  checks.push('prototype interaction controls edit the document without panel overflow at 1000px')
  await page.getByTestId(`layer-${b.id}`).click({ modifiers: ['Meta'] })
  await expect(page.getByLabel('W', { exact: true })).toHaveAttribute('placeholder', '混合')
  await page.getByLabel('W', { exact: true }).fill('210'); await page.getByLabel('W', { exact: true }).press('Enter')
  await expect.poll(async () => { const d = await stored(); return [d.nodes[a.id].width, d.nodes[b.id].width] }).toEqual([210, 210])
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByLabel('W', { exact: true })).toHaveAttribute('placeholder', '混合')
  checks.push('mixed width is blank; explicit shared value updates both; one undo restores both')
  await page.getByTestId(`layer-${a.id}`).dblclick()
  await page.getByLabel('重命名图层', { exact: true }).fill('内联命名')
  await page.getByLabel('重命名图层', { exact: true }).press('Enter')
  await expect(page.getByTestId(`layer-${a.id}`)).toHaveAccessibleName('内联命名')
  await page.getByTestId(`layer-${a.id}`).click()
  await page.getByTestId(`layer-${frame.id}`).click({ modifiers: ['Shift'] })
  await expect(page.locator('[role=treeitem][aria-selected=true]')).toHaveCount(3)
  checks.push('inline rename and Shift range select all displayed layers')
  await page.getByTestId(`layer-${a.id}`).click()
  await page.getByTestId(`layer-${b.id}`).click({ modifiers: ['Meta'] })
  await page.getByTestId(`layer-${a.id}`).dragTo(page.getByTestId(`layer-${frame.id}`))
  await expect.poll(async () => (await stored()).nodes[frame.id].children.length).toBe(2)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await stored()).nodes[frame.id].children.length).toBe(0)
  checks.push('selected roots drag into frame together; one undo restores siblings')
  const separator = page.getByRole('separator', { name: '调整图层面板宽度' })
  await separator.focus(); await separator.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '250')
  const board = await canvas.boundingBox(), belt = await page.getByRole('toolbar', { name: '设计工具' }).boundingBox()
  expect(belt!.x).toBeGreaterThanOrEqual(board!.x)
  expect(belt!.x + belt!.width).toBeLessThanOrEqual(board!.x + board!.width)
  await page.screenshot({ path: join(output, 'workspace-1000-mixed.png') })
  checks.push('keyboard panel resize preserves canvas/toolbelt bounds at 1000px')
  await page.getByRole('button', { name: '形状工具', exact: true }).click()
  await page.getByRole('menuitemradio', { name: '矩形', exact: true }).click()
  await page.mouse.move(board!.x + 50, board!.y + 110)
  await page.mouse.down(); await page.mouse.move(board!.x + 90, board!.y + 150); await page.mouse.up()
  await expect(page.getByRole('treeitem')).toHaveCount(4)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(page.getByRole('treeitem')).toHaveCount(3)
  checks.push('settled canvas also accepts a single-move rapid draw gesture')
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks, output }))
} catch (error) {
  await currentPage?.screenshot({ path: join(output, 'failure.png') })
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally { await browser?.close(); server.kill('SIGTERM') }
