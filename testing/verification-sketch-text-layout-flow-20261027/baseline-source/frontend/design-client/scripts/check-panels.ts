/** Real production React/WASM panel controls in an isolated WebGPU browser. */
import { chromium, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { blank, node, paint, type DesignDocument } from '../src/model'
const project = resolve(import.meta.dir, '..'), output = await realpath(await mkdtemp(join(tmpdir(), 'forma-panels-'))), root = join(output, 'snapshot/frontend/design-client')
await mkdir(root, { recursive: true })
await cp(join(project, '../../design-studio/crates/design-kernel/shaders'), join(output, 'snapshot/design-studio/crates/design-kernel/shaders'), { recursive: true })
for (const name of ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'tsconfig.json']) await cp(join(project, name), join(root, name), { recursive: true })
await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'dir')
const sources: Record<string, string> = {}
async function hashTree(folder: string) { for (const entry of await readdir(join(root, folder), { withFileTypes: true })) { const name = `${folder}/${entry.name}`; if (entry.isDirectory()) await hashTree(name); else if (/\.(tsx?|m?js|wasm|css)$/.test(name)) sources[name] = createHash('sha256').update(await readFile(join(root, name))).digest('hex') } }
await hashTree('src'); sources['scripts/check-panels.ts'] = createHash('sha256').update(await readFile(import.meta.path)).digest('hex')
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(sources, null, 2))
const server = await createServer({ root, cacheDir: join(root, '.vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
const checks: { name: string; status: string; error?: string; data?: unknown }[] = [], errors: string[] = []
const record = async (name: string, action: () => Promise<unknown>) => {
  try { const data = await action(); checks.push({ name, status: 'passed', data }) }
  catch (error) { checks.push({ name, status: 'failed', error: String(error) }); await page?.screenshot({ path: join(output, `${checks.length}-failure.png`) }); await page?.keyboard.press('Escape') }
  console.log(JSON.stringify(checks.at(-1)))
}
function fixture() {
  const doc = blank('Panel controls'), bottom = node('rectangle', 30, 40, 80, 60), middle = node('rectangle', 150, 40, 80, 60), top = node('rectangle', 270, 40, 80, 60)
  bottom.name = 'Bottom'; middle.name = 'Middle'; top.name = 'Top'
  doc.nodes = { [bottom.id]: bottom, [middle.id]: middle, [top.id]: top }; doc.pages[0].children = [bottom.id, middle.id, top.id]
  return { doc, bottom, middle, top }
}
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1280, height: 850 }, deviceScaleFactor: 2 })
  const p = page, canvas = p.getByTestId('canvas')
  p.on('pageerror', error => errors.push(String(error)))
  await p.goto(server.resolvedUrls!.local[0]); await expect(p.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30000 })
  const stored = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())!.document })
  let sequence = 0
  const fresh = async (doc: DesignDocument) => { doc.name = `Panel controls ${++sequence}`; const path = join(output, `${sequence}.fd`); await writeFile(path, JSON.stringify(doc)); await p.locator('input[type=file][accept*=".fd"]').setInputFiles(path); await expect(p.getByLabel('文档名称')).toHaveValue(doc.name); await expect.poll(async () => (await stored()).name).toBe(doc.name); await expect(p.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 30000 }) }
  const names = (d: DesignDocument) => [...d.pages[0].children].reverse().map(id => d.nodes[id].name)
  const drag = async (from: string, target: string, fraction: number) => {
    const a = (await p.getByTestId(`layer-${from}`).boundingBox())!, b = (await p.getByTestId(`layer-${target}`).boundingBox())!
    await p.mouse.move(a.x + 80, a.y + a.height / 2); await p.mouse.down(); await p.mouse.move(a.x + 85, a.y + a.height / 2, { steps: 3 }); await p.mouse.move(b.x + 80, b.y + b.height * fraction, { steps: 12 }); await p.mouse.up()
  }
  await record('layer drop above a sibling respects pointer position and one undo', async () => {
    const f = fixture(); await fresh(f.doc)
    await drag(f.bottom.id, f.top.id, .1)
    await expect.poll(async () => names(await stored()), { timeout: 3000 }).toEqual(['Bottom', 'Top', 'Middle'])
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => names(await stored())).toEqual(['Top', 'Middle', 'Bottom'])
  })
  await record('multi-layer drop preserves relative painter order', async () => {
    const f = fixture(); await fresh(f.doc)
    await p.getByTestId(`layer-${f.top.id}`).click(); await p.getByTestId(`layer-${f.middle.id}`).click({ modifiers: ['Shift'] })
    await drag(f.top.id, f.bottom.id, .9)
    await expect.poll(async () => names(await stored()), { timeout: 3000 }).toEqual(['Bottom', 'Top', 'Middle'])
  })
  await record('locked layer inspector width edits persist while retaining lock', async () => {
    const f = fixture(); f.middle.locked = true; await fresh(f.doc)
    await p.getByTestId(`layer-${f.middle.id}`).click()
    await p.getByLabel('W', { exact: true }).fill('137.125'); await p.getByLabel('W', { exact: true }).press('Enter')
    await expect.poll(async () => (await stored()).nodes[f.middle.id].width, { timeout: 3000 }).toBe(137.125)
    expect((await stored()).nodes[f.middle.id].locked).toBe(true)
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => (await stored()).nodes[f.middle.id].width).toBe(80)
  })
  await record('container edges reorder siblings; center nests; page whitespace unnests', async () => {
    const f = fixture(), frame = node('frame', 400, 40, 160, 160); frame.name = 'Container'; f.doc.nodes[frame.id] = frame; f.doc.pages[0].children.push(frame.id)
    await fresh(f.doc); await drag(f.bottom.id, frame.id, .9)
    await expect.poll(async () => names(await stored())).toEqual(['Container', 'Bottom', 'Top', 'Middle'])
    expect((await stored()).nodes[frame.id].children).toEqual([])
    await drag(f.bottom.id, frame.id, .5)
    await expect.poll(async () => (await stored()).nodes[frame.id].children).toEqual([f.bottom.id])
    const row = (await p.getByTestId(`layer-${f.bottom.id}`).boundingBox())!, list = (await p.getByRole('tree', { name: '图层', exact: true }).boundingBox())!
    await p.mouse.move(row.x + 80, row.y + 16); await p.mouse.down(); await p.mouse.move(row.x + 85, row.y + 16); await p.mouse.move(list.x + 90, list.y + list.height - 10, { steps: 12 }); await p.mouse.up()
    await expect.poll(async () => names(await stored())).toEqual(['Container', 'Top', 'Middle', 'Bottom'])
    expect((await stored()).nodes[frame.id].children).toEqual([])
    const restored = (await stored()).nodes[f.bottom.id]; expect(restored.transform).toEqual(f.bottom.transform)
  })
  await record('mixed locked/unlocked property edits use one undo and keep lock bits', async () => {
    const f = fixture(); f.middle.locked = true; f.top.width = 110; await fresh(f.doc)
    await p.getByTestId(`layer-${f.middle.id}`).click(); await p.getByTestId(`layer-${f.top.id}`).click({ modifiers: ['Meta'] })
    await expect(p.getByLabel('W', { exact: true })).toHaveAttribute('placeholder', '混合')
    await p.getByLabel('W', { exact: true }).fill('111.0625'); await p.getByLabel('W', { exact: true }).press('Enter')
    await expect.poll(async () => { const d = await stored(); return [d.nodes[f.middle.id].width, d.nodes[f.top.id].width] }).toEqual([111.0625, 111.0625])
    expect((await stored()).nodes[f.middle.id].locked).toBe(true)
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => { const d = await stored(); return [d.nodes[f.middle.id].width, d.nodes[f.top.id].width] }).toEqual([80, 110])
  })
  await record('locked text content and style commit from the inspector', async () => {
    const doc = blank('Text properties'), text = node('text', 40, 40, 180, 70); text.text = 'Original'; text.name = 'Locked text'; text.locked = true; doc.nodes = { [text.id]: text }; doc.pages[0].children = [text.id]
    await fresh(doc); await p.getByTestId(`layer-${text.id}`).click()
    await p.getByLabel('文字内容', { exact: true }).fill('Exact panel text'); await p.getByLabel('文字内容', { exact: true }).press('Tab')
    await expect.poll(async () => (await stored()).nodes[text.id].text).toBe('Exact panel text')
    await p.getByLabel('字号', { exact: true }).fill('23.5'); await p.getByLabel('字号', { exact: true }).press('Enter')
    await expect.poll(async () => (await stored()).nodes[text.id].fontSize).toBe(23.5)
    await p.getByLabel('字间距', { exact: true }).fill('1.25'); await p.getByLabel('字间距', { exact: true }).press('Enter')
    await expect.poll(async () => (await stored()).nodes[text.id].textStyle?.letterSpacing).toBe(1.25)
    expect((await stored()).nodes[text.id].locked).toBe(true)
  })
  await record('locked frame layout remains property-editable and removal resets fill sizing', async () => {
    const doc = blank('Frame properties'), frame = node('frame', 40, 40, 240, 180), child = node('rectangle', 20, 20, 30, 40); frame.locked = true; frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
    await fresh(doc); await p.getByTestId(`layer-${frame.id}`).click()
    await p.getByTitle('添加自动布局 Shift+A', { exact: true }).click(); await p.getByLabel('排列方式', { exact: true }).selectOption('vertical')
    await p.getByLabel('项目间距', { exact: true }).fill('17.25'); await p.getByLabel('项目间距', { exact: true }).press('Enter')
    await expect.poll(async () => { const d = await stored(); return [d.nodes[frame.id].layout?.mode, d.nodes[frame.id].layout?.gap, d.nodes[frame.id].locked] }).toEqual(['vertical', 17.25, true])
    await p.getByTitle('移除自动布局', { exact: true }).click()
    await expect.poll(async () => (await stored()).nodes[frame.id].layout).toBeUndefined()
    expect((await stored()).nodes[frame.id].locked).toBe(true)
  })
  await record('canvas deep selection reveals collapsed ancestors without taking canvas focus', async () => {
    const doc = blank('Nested'), frame = node('frame', 40, 40, 240, 180), child = node('rectangle', 30, 30, 80, 60)
    frame.name = 'Frame'; child.name = 'Child'; child.fills = [paint('#ff0000')]; frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
    await fresh(doc); await p.getByTestId(`layer-${frame.id}`).locator('.disclosure').click(); await expect(p.getByTestId(`layer-${child.id}`)).toHaveCount(0)
    const camera = await p.locator('.kernel-presentation').evaluate(el => ({ x: +el.getAttribute('data-camera-x')!, y: +el.getAttribute('data-camera-y')!, zoom: +el.getAttribute('data-camera-zoom')! })), rect = (await canvas.boundingBox())!
    await p.keyboard.down('Meta'); await p.mouse.click(rect.x + camera.x + 90 * camera.zoom, rect.y + camera.y + 90 * camera.zoom); await p.keyboard.up('Meta')
    await expect(p.locator('.inspector[data-node-name]')).toHaveAttribute('data-node-name','Child')
    await expect(p.getByTestId(`layer-${child.id}`)).toBeVisible({ timeout: 3000 })
    await expect(canvas).toBeFocused()
  })
  await record('canvas selection scrolls a virtualized offscreen layer into view', async () => {
    const doc = blank('Virtual tree'), target = node('rectangle', 40, 40, 80, 60); target.name = 'Virtual target'; doc.nodes = { [target.id]: target }; doc.pages[0].children = [target.id]
    for (let i = 0; i < 90; i++) { const other = node('rectangle', 1500 + i * 2, 1500, 1, 1); other.name = `Other ${i}`; doc.nodes[other.id] = other; doc.pages[0].children.push(other.id) }
    await fresh(doc); await expect(p.getByTestId(`layer-${target.id}`)).toHaveCount(0)
    const camera = await p.locator('.kernel-presentation').evaluate(el => ({ x: +el.getAttribute('data-camera-x')!, y: +el.getAttribute('data-camera-y')!, zoom: +el.getAttribute('data-camera-zoom')! })), rect = (await canvas.boundingBox())!
    await p.mouse.click(rect.x + camera.x + 70 * camera.zoom, rect.y + camera.y + 70 * camera.zoom)
    await expect(p.locator('.inspector[data-node-name]')).toHaveAttribute('data-node-name','Virtual target')
    await expect(p.getByTestId(`layer-${target.id}`)).toBeVisible()
    expect(await p.getByRole('tree', { name: '图层', exact: true }).evaluate(el => el.scrollTop)).toBeGreaterThan(2000)
    await expect(canvas).toBeFocused()
  })
  await p.screenshot({ path: join(output, 'panels-final.png') })
} catch (error) { checks.push({ name: 'harness', status: 'failed', error: String(error) }) }
finally {
  await browser?.close(); await server.close()
  const status = checks.some(c => c.status === 'failed') || errors.length ? 'failed' : 'passed'
  await writeFile(join(output, 'results.json'), JSON.stringify({ status, execution: 'Real mouse/keyboard/file input; production React/WASM copied to private source snapshot; WebGPU browser, no render mocks.', checks, errors, output }, null, 2)); console.log(JSON.stringify({ status, output, checks: checks.length, errors }))
  if (status === 'failed') process.exitCode = 1
}
