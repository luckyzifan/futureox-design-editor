/** Real product-page component and variable journeys on Web and packaged Electron.
 * Read persistence as an oracle; all edits go through visible controls. */
import { chromium, _electron, expect } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { blank, node, paint } from '../src/model'

const output = await mkdtemp(join(tmpdir(), 'forma-design-system-ui-'))
const desktop = process.env.DESIGN_ELECTRON_APP
const document = blank('Design system UI acceptance')
const frame = node('frame', 40, 40, 128, 64), child = node('rectangle', 8, 8, 70, 30)
frame.name = 'Control'; frame.fills = [paint('#335577')]; frame.children = [child.id]
document.nodes = { [frame.id]: frame, [child.id]: child }; document.pages[0].children = [frame.id]
const fixture = join(output, 'components.fd'); await writeFile(fixture, JSON.stringify(document))
let server: Awaited<ReturnType<typeof createServer>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
let page: import('@playwright/test').Page | undefined
const checks: string[] = [], errors: string[] = []
try {
  if (desktop) {
    app = await _electron.launch({ executablePath: desktop, args: ['--desktop-gui-test'], chromiumSandbox: true,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key))), TMPDIR: output } })
    page = await app.firstWindow(); await page.waitForURL(/^design-app:/)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 960))
    await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready', 'true', { timeout: 60000 })
  } else {
    server = await createServer({ root: resolve(import.meta.dir, '..'), server: { host: '127.0.0.1', port: 0, strictPort: true } })
    await server.listen()
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); await page.goto(server.resolvedUrls!.local[0])
  }
  const p = page
  p.on('pageerror', error => errors.push(String(error)))
  await expect(p.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60000 })
  const read = () => p.evaluate(async native => {
    if (!native) return (await (await import('/src/local-store.ts')).localOpen())!.document
    const bridge = (window as any).coreDesktop
    const list = await bridge.workspace.list(); if (list.status !== 'ok') throw Error('Workspace list failed')
    const latest = [...list.documents].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const opened = await bridge.workspace.open({ id: latest.id }); if (opened.status !== 'ok') throw Error('Workspace open failed')
    return JSON.parse(opened.documentJson)
  }, !!desktop)
  const saved = async (predicate: (doc: any) => boolean) => {
    await expect.poll(async () => predicate(await read()), { timeout: 30000 }).toBe(true)
    return read()
  }
  const settle = async () => {
    await expect(p.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 60000 })
    expect(await p.locator('.kernel-status.error').allTextContents()).toEqual([])
  }
  await p.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await expect(p.getByLabel('文档名称', { exact: true })).toHaveValue(document.name, { timeout: 60000 })
  await expect(p.locator('.save-status')).toHaveText('已保存到本机', { timeout: 60000 })
  await saved(d => d.name === document.name); await settle()
  await p.getByTestId(`layer-${frame.id}`).click()
  await p.getByRole('button', { name: '◇ 创建组件', exact: true }).click()
  let doc = await saved(d => Object.values(d.nodes).some((n: any) => !!n.component))
  const master: any = Object.values(doc.nodes).find((n: any) => n.component)
  await p.getByRole('button', { name: '创建实例', exact: true }).click()
  doc = await saved(d => Object.values(d.nodes).some((n: any) => n.instance?.componentId === master.id))
  const instance: any = Object.values(doc.nodes).find((n: any) => n.instance?.componentId === master.id)
  await p.getByLabel('透明度 %', { exact: true }).fill('50'); await p.getByLabel('透明度 %', { exact: true }).press('Enter')
  await saved(d => d.nodes[instance.id].opacity === .5)
  await p.getByRole('button', { name: '重置全部覆盖', exact: true }).click()
  await saved(d => d.nodes[instance.id].opacity === 1)
  await p.getByRole('button', { name: '分离实例', exact: true }).click()
  await saved(d => !d.nodes[instance.id].instance)
  await p.getByTestId('canvas').focus(); await p.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
  await saved(d => d.nodes[instance.id].instance?.componentId === master.id)
  checks.push('create component and instance; override, reset, detach and undo persist through real UI')
  await p.getByTestId(`layer-${master.id}`).click()
  await p.getByRole('button', { name: '添加变体', exact: true }).click()
  await saved(d => Object.values(d.nodes).filter((n: any) => n.component).length === 2 && Object.values(d.nodes).some((n: any) => n.componentSet))
  checks.push('variant creation retains a component set')
  await p.getByRole('button', { name: '资源', exact: true }).click()
  await p.getByLabel('搜索组件', { exact: true }).fill('Control')
  await p.locator('.component-asset').first().click()
  doc = await saved(d => Object.values(d.nodes).filter((n: any) => n.instance).length === 2)
  const inserted: any = Object.values(doc.nodes).find((n: any) => n.instance && n.id !== instance.id)
  checks.push('asset search and insertion create another live instance')
  await p.getByRole('button', { name: '变量', exact: true }).click()
  const dialog = p.getByRole('dialog', { name: '设计系统与交互', exact: true })
  await dialog.getByLabel('集合名称').fill('QA theme'); await dialog.getByRole('button', { name: '新建集合', exact: true }).click()
  await dialog.getByRole('button', { name: '+ color', exact: true }).click()
  await dialog.getByLabel('变量名称', { exact: true }).fill('Accent')
  await dialog.getByLabel('变量名称', { exact: true }).press('Enter')
  await dialog.getByLabel('Accent Light', { exact: true }).fill('#123456')
  await dialog.getByLabel('Accent Light', { exact: true }).press('Enter')
  await dialog.getByLabel('Accent Dark', { exact: true }).fill('#654321')
  await dialog.getByLabel('Accent Dark', { exact: true }).press('Enter')
  doc = await saved(d => Object.values(d.designSystem?.variables || {}).some((v: any) => v.name === 'Accent' && v.values.Dark === '#654321'))
  const [variableId] = Object.entries(doc.designSystem.variables).find(([, v]: any) => v.name === 'Accent')!
  await dialog.getByLabel('绑定变量', { exact: true }).selectOption(variableId)
  await dialog.getByLabel('QA theme 当前模式', { exact: true }).selectOption('Dark')
  doc = await saved(d => d.nodes[inserted.id].bindings?.['fills.0.color'] === variableId && Object.values(d.designSystem.activeModes).includes('Dark'))
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await settle()
  const bounds = await p.getByTestId('canvas-selection-outline').first().boundingBox()
  if (!bounds) throw Error('Missing bound instance selection')
  const pixel = await p.evaluate(({ x, y }) => {
    const source = document.querySelector('.kernel-presentation canvas[data-frame-visible="true"]') as HTMLCanvasElement
    const r = source.getBoundingClientRect(), copy = document.createElement('canvas'); copy.width = copy.height = 1
    const context = copy.getContext('2d')!
    context.drawImage(source, Math.floor((x - r.x) * source.width / r.width), Math.floor((y - r.y) * source.height / r.height), 1, 1, 0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }, { x: bounds.x + bounds.width * .9, y: bounds.y + bounds.height * .9 })
  expect(pixel).toEqual([101, 67, 33, 255])
  checks.push('variable collection, per-mode values and instance binding persist; published Dark pixels equal #654321')
  await p.reload(); await expect(p.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60000 })
  await settle(); expect(await read()).toEqual(doc)
  checks.push('complete component/variable document survives product-page reload without field loss')
  expect(errors).toEqual([])
  await p.screenshot({ path: join(output, 'verified.png') })
  if (desktop) { await p.getByTestId('canvas').focus(); await p.keyboard.press('Meta+s'); await expect(p.locator('.save-status')).toHaveText('已保存到本机'); await read() }
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', desktop: !!desktop, checks, errors }, null, 2))
  console.log(JSON.stringify({ status: 'passed', desktop: !!desktop, output, checks: checks.length }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, errors, error: String(error) }, null, 2))
  console.error(JSON.stringify({ status: 'failed', output, error: String(error) })); process.exitCode = 1
} finally { await browser?.close(); await server?.close(); if (app) { const child = app.process(); let timer; try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned Electron close timed out')), 30000) })]) } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') } } }
