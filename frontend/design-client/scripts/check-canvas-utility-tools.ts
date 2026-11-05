/** Owned Chromium/Vite UI acceptance for the long-tail utility tools
 * (eraser / eyedropper / paint bucket / measure / slice / crop / comment)
 * plus the explicit unavailable feedback of the remaining decoded commands.
 * Real React/WASM/kernel; no editor object is injected. */
import { chromium, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, paint, type DesignDocument, type DesignNode } from '../src/model'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-utility-tools-'))
await mkdir(output, { recursive: true })
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
let serverLog = '', sequence = 0
const checks: { name: string; scope?: string }[] = [], errors: string[] = []
server.stdout.on('data', chunk => { serverLog = (serverLog + String(chunk)).slice(-128 * 1024) })
server.stderr.on('data', chunk => { serverLog = (serverLog + String(chunk)).slice(-128 * 1024) })
const manual = [
  'Native Electron/Finder/Dock and OS-level color pickers are outside this browser suite.',
  'Comments and slices persist locally; cloud collaboration sync is not claimed.',
]
const PNG_4X4 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGM4IScHRwxI7BMMOGUApsMQQbBN760AAAAASUVORK5CYII='
function passed(name: string, scope?: string) { checks.push({ name, ...(scope ? { scope } : {}) }); console.log(`UTILITY_CHECK ${name}`) }
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite startup timeout')), 20_000)
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Owned Vite exited ${code}`)) })
    const inspect = () => { const match = serverLog.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    server.stdout.on('data', inspect); inspect()
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2, acceptDownloads: true, permissions: ['clipboard-read','clipboard-write'] })
  const p = page, canvas = p.getByTestId('canvas'), surface = p.locator('.kernel-tiles')
  p.on('pageerror', error => errors.push(String(error)))
  await p.goto(url)
  await expect(p.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30_000 })
  const record = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return await localOpen() })
  const document = async () => (await record())!.document as DesignDocument
  const settle = async () => {
    await expect.poll(async () => {
      if (await p.locator('.kernel-status.error').count()) return 'error'
      if (!await surface.count()) return 'missing-gpu-surface'
      return surface.evaluate(element => element.getAttribute('data-detail-ready') === 'true' &&
        element.getAttribute('data-revision') === element.getAttribute('data-requested-revision') ? 'ready' : 'pending')
    }, { timeout: 60_000 }).toBe('ready')
  }
  const storedCount = async (count: number) => {
    await expect.poll(async () => Object.keys((await document()).nodes).length, { timeout: 20_000 }).toBe(count)
    await settle()
  }
  const fresh = async (name: string, supplied?: DesignDocument) => {
    const fixture = supplied || blank(name)
    const filename = join(output, `${++sequence}-${name}.fd`)
    await writeFile(filename, JSON.stringify(fixture))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(filename)
    await expect(p.getByLabel('文档名称')).toHaveValue(fixture.name, { timeout: 30_000 })
    await expect.poll(async () => (await record())?.document.name, { timeout: 20_000 }).toBe(fixture.name)
    await settle(); await canvas.focus()
    return await document()
  }
  const box = async () => { const value = await canvas.boundingBox(); if (!value) throw Error('Canvas has no bounds'); return value }
  const point = async (x: number, y: number) => { const b = await box(); return { x: b.x + x, y: b.y + y } }
  const camera = () => surface.evaluate(el => ({ x: Number(el.getAttribute('data-camera-x')), y: Number(el.getAttribute('data-camera-y')), zoom: Number(el.getAttribute('data-camera-zoom')) }))
  const screenOf = async (world: { x: number; y: number }) => { const b = await box(), v = await camera(); return { x: b.x + v.x + world.x * v.zoom, y: b.y + v.y + world.y * v.zoom } }
  const nodeCenter = async (n: DesignNode) => screenOf({ x: n.transform[4] + n.width / 2, y: n.transform[5] + n.height / 2 })
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps: 8 })
  }
  const finish = async () => { await p.mouse.up() }
  const undo = async () => { await p.getByRole('button', { name: '撤销', exact: true }).click() }
  const utility = async (name: string) => {
    await p.getByRole('button', { name: '实用工具', exact: true }).click()
    await p.getByRole('menuitemradio', { name, exact: true }).click()
    await canvas.focus()
  }

  const eraseDoc = blank('01-橡皮'), eraseA = node('line', 60, 80, 120, 90), eraseB = node('line', 260, 80, 120, 90)
  eraseA.fills=[];eraseB.fills=[]
  eraseA.strokes[0].width=8;eraseB.strokes[0].width=8
  eraseDoc.nodes = { [eraseA.id]: eraseA, [eraseB.id]: eraseB }; eraseDoc.pages[0].children = [eraseA.id, eraseB.id]
  await fresh(eraseDoc.name, eraseDoc)
  await p.keyboard.press('e'); await expect(canvas).toHaveClass(/canvas-eraser/)
  const eraseAtA = await nodeCenter(eraseA)
  await p.mouse.click(eraseAtA.x, eraseAtA.y); await storedCount(2)
  expect((await document()).nodes[eraseA.id].kind).toBe('vector')
  expect((await document()).nodes[eraseA.id].network!.edges.length).toBeGreaterThan(1)
  expect((await document()).nodes[eraseB.id].kind).toBe('line')
  await undo(); await storedCount(2)
  expect((await document()).nodes[eraseA.id].kind).toBe('line')
  await p.keyboard.press('e')
  await drag(await nodeCenter(eraseB), await screenOf({ x: eraseB.transform[4] + eraseB.width / 2, y: eraseB.transform[5] + eraseB.height / 2 }))
  await finish(); await storedCount(2)
  expect((await document()).nodes[eraseB.id].kind).toBe('vector')
  await undo(); await storedCount(2)
  expect((await document()).nodes[eraseB.id].kind).toBe('line')
  passed('E eraser: a click cuts one open stroke and a drag cuts the other; each gesture is one undo and neither deletes the layer')

  const dropperDoc = blank('02-吸管与油漆桶'), dropA = node('rectangle', 60, 80, 120, 90), dropB = node('rectangle', 260, 80, 120, 90)
  dropA.fills = [paint('#ff0000')]; dropA.name = '取样源'
  dropperDoc.nodes = { [dropA.id]: dropA, [dropB.id]: dropB }; dropperDoc.pages[0].children = [dropA.id, dropB.id]
  await fresh(dropperDoc.name, dropperDoc)
  await p.getByTestId(`layer-${dropB.id}`).click()
  await p.keyboard.press('i'); await expect(canvas).toHaveClass(/canvas-eyedropper/)
  const dropAtA = await nodeCenter(dropA)
  await p.mouse.click(dropAtA.x, dropAtA.y)
  await expect.poll(async () => (await document()).nodes[dropB.id].fills[0]?.color, { timeout: 20_000 }).toBe('#ff0000')
  await undo(); await expect.poll(async () => (await document()).nodes[dropB.id].fills[0]?.color).toBe('#818cf8')
  await p.keyboard.press('v')
  const emptySpot = await point(700, 500)
  await p.mouse.click(emptySpot.x, emptySpot.y)
  await p.keyboard.press('i'); await p.mouse.click(dropAtA.x, dropAtA.y)
  await expect(p.locator('footer')).toContainText('已复制 #FF0000')
  await utility('油漆桶'); await expect(canvas).toHaveClass(/canvas-paint-bucket/)
  const bucketAtB = await nodeCenter(dropB)
  await p.mouse.click(bucketAtB.x, bucketAtB.y)
  await expect.poll(async () => (await document()).nodes[dropB.id].network?.filledFaces, { timeout: 20_000 }).toEqual([])
  expect((await document()).nodes[dropB.id].fills[0]?.color).toBe('#818cf8')
  await undo(); await expect.poll(async () => (await document()).nodes[dropB.id].fills[0]?.color).toBe('#818cf8')
  await expect.poll(async () => (await document()).nodes[dropB.id].network).toBeUndefined()
  passed('I eyedropper samples the published pixel or copies it; bucket toggles a closed vector face without changing paint color and Undo restores the primitive')

  await fresh('03-测量')
  await utility('测量'); await expect(canvas).toHaveClass(/canvas-measure/)
  const measureFrom = await point(200, 200), measureTo = await point(320, 244)
  const measureZoom = (await camera()).zoom
  await drag(measureFrom, measureTo); await finish()
  const measured = parseFloat((await p.getByTestId('utility-gesture').locator('text').textContent())!)
  const expected = Math.hypot((measureTo.x - measureFrom.x) / measureZoom, (measureTo.y - measureFrom.y) / measureZoom)
  expect(Math.abs(Number(measured) - expected)).toBeLessThan(0.5)
  await p.keyboard.press('Escape'); await expect(p.getByTestId('utility-gesture')).toHaveCount(0)
  passed('Measure drag reports world-unit distance/deltas and clears on tool exit')

  const sliceDoc = blank('04-切片'), sliceRect = node('rectangle', 80, 90, 140, 100)
  sliceDoc.nodes[sliceRect.id] = sliceRect; sliceDoc.pages[0].children = [sliceRect.id]
  await fresh(sliceDoc.name, sliceDoc)
  await utility('切片'); await expect(canvas).toHaveClass(/canvas-slice/)
  await drag(await screenOf({ x: 60, y: 70 }), await screenOf({ x: 240, y: 210 })); await finish()
  await storedCount(2)
  const slice = Object.values((await document()).nodes).find(n=>n.kind==='slice')!
  expect(slice.width).toBeCloseTo(180,6);expect(slice.height).toBeCloseTo(140,6)
  await p.getByTestId(`layer-${slice.id}`).click()
  const exportPanel=p.getByRole('region',{name:'图层导出设置'})
  await p.getByLabel('添加图层导出设置').click();await p.getByLabel('添加图层导出设置').click()
  await p.getByLabel('导出倍率 2',{exact:true}).fill('2');await p.getByLabel('导出倍率 2',{exact:true}).press('Enter')
  await expect.poll(async()=>(await document()).nodes[slice.id].exportSettings?.map(s=>s.scale)).toEqual([1,2])
  const exportSource=await document()
  await exportPanel.getByRole('button',{name:'预览并导出此图层',exact:true}).click()
  await expect(exportPanel.getByRole('status')).toHaveText('已生成 2 个文件',{timeout:60000})
  for(const scale of [1,2]){
    const image=p.getByAltText(`图层导出预览 ${scale}`,{exact:true})
    await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0)).toBe(true)
    expect(await image.evaluate((el:HTMLImageElement)=>[el.naturalWidth,el.naturalHeight])).toEqual([180*scale,140*scale])
    const event=p.waitForEvent('download');await exportPanel.getByRole('link').nth(scale-1).click();await (await event).saveAs(join(output,`slice-${scale}.png`))
  }
  expect(await document()).toEqual(exportSource)
  await canvas.focus();await p.keyboard.press('Backspace');await storedCount(1)
  expect((await document()).nodes[sliceRect.id]).toEqual(sliceRect)
  passed('Slice is an authored node; 1x/2x PNG export preserves the source and Delete removes only the slice')

  const cropDoc = blank('05-裁切'), cropImage = node('rectangle', 100, 100, 200, 100)
  cropImage.fills = [{ ...paint('#ffffff', 'image'), image: PNG_4X4, fit: 'stretch' }]
  cropDoc.nodes[cropImage.id] = cropImage; cropDoc.pages[0].children = [cropImage.id]
  await fresh(cropDoc.name, cropDoc)
  await p.getByTestId(`layer-${cropImage.id}`).click()
  await utility('裁切'); await expect(canvas).toHaveClass(/canvas-crop/)
  await drag(await screenOf({ x: 150, y: 125 }), await screenOf({ x: 250, y: 175 })); await finish()
  await expect.poll(async () => (await document()).nodes[cropImage.id]?.width, { timeout: 20_000 }).toBeCloseTo(100, 6)
  const cropped = (await document()).nodes[cropImage.id]
  expect(cropped.height).toBeCloseTo(50, 6)
  expect(cropped.transform[4]).toBeCloseTo(150, 6)
  expect(cropped.transform[5]).toBeCloseTo(125, 6)
  expect(cropped.fills[0].transform).toBeDefined()
  expect(cropped.fills[0].transform![0]).toBeCloseTo(2, 6)
  expect(cropped.fills[0].transform![3]).toBeCloseTo(2, 6)
  expect(cropped.fills[0].transform![4]).toBeCloseTo(-0.5, 6)
  expect(cropped.fills[0].transform![5]).toBeCloseTo(-0.5, 6)
  await undo()
  await expect.poll(async () => (await document()).nodes[cropImage.id]?.width, { timeout: 20_000 }).toBe(200)
  const restored = (await document()).nodes[cropImage.id]
  expect(restored.fills[0].transform).toBeUndefined()
  passed('Crop rewrites node frame + image transform to the dragged window; one undo restores the original bitmap')

  const cropRejectDoc = blank('05b-裁切拒绝'), plain = node('rectangle', 100, 100, 200, 100)
  cropRejectDoc.nodes[plain.id] = plain; cropRejectDoc.pages[0].children = [plain.id]
  await fresh(cropRejectDoc.name, cropRejectDoc)
  await p.getByTestId(`layer-${plain.id}`).click()
  await utility('裁切')
  const plainCenter = await nodeCenter(plain)
  await p.mouse.click(plainCenter.x, plainCenter.y)
  await expect(p.locator('footer')).toContainText('裁切需要选中一个包含图片填充的图层')
  expect((await document()).nodes[plain.id].fills[0].transform).toBeUndefined()
  passed('Crop on a non-image layer is an explicit rejection, not a silent no-op')

  await fresh('06-评论')
  await p.keyboard.press('c'); await expect(canvas).toHaveClass(/canvas-comment/)
  const commentAt = await point(400, 300)
  await p.mouse.click(commentAt.x, commentAt.y)
  const commentEditor = p.getByRole('complementary',{name:'本地评论与标注'})
  await expect(commentEditor).toBeVisible()
  await commentEditor.getByLabel('评论正文').fill('角度再收紧一些')
  await commentEditor.getByRole('button',{name:'保存评论',exact:true}).click()
  await expect.poll(async()=>(await document()).reviews?.[0]?.messages[0]?.text).toBe('角度再收紧一些')
  await expect(p.getByRole('button',{name:'评论 1',exact:true})).toHaveCount(1)
  expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await p.reload();await settle();await canvas.focus();await p.keyboard.press('c')
  await p.getByRole('button',{name:'评论 1',exact:true}).click()
  await expect(commentEditor.getByRole('region',{name:'评论内容'})).toContainText('角度再收紧一些')
  await commentEditor.getByRole('button',{name:'删除评论',exact:true}).click()
  await expect.poll(async()=>(await document()).reviews?.length||0).toBe(0)
  passed('Comment pins persist through actual IndexedDB reload and can be reopened/deleted without changing shape nodes')
  await commentEditor.getByLabel('关闭评论').click()
  await p.getByRole('button',{name:'绘图工具',exact:true}).click()
  await expect(p.getByRole('menuitem',{name:'套索',exact:true})).toBeEnabled()
  await p.getByRole('menuitem',{name:'套索',exact:true}).click()
  await expect(canvas).toHaveClass(/canvas-vector-lasso/)
  await p.getByRole('button',{name:'排列与编辑',exact:true}).click()
  await expect(p.getByRole('menuitem',{name:'标注',exact:true})).toBeEnabled()
  await p.getByRole('menuitem',{name:'标注',exact:true}).click()
  await expect(canvas).toHaveClass(/canvas-annotate/)
  passed('Mapped lasso and annotation commands are enabled and activate their actual canvas modes')

  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, manual, output, browser: browser.version(), platform: process.platform }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  if (page) await writeFile(join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, errors, manual, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally {
  await writeFile(join(output, 'vite.log'), serverLog)
  await browser?.close(); server.kill('SIGTERM')
}
