/** Owned Chromium/Vite UI acceptance. Real React/WASM/GPU + IndexedDB; no editor
 * object is injected. Synthetic events are limited to explicitly labelled
 * non-owner pointer up/cancel checks, with a real mouse-owned gesture active. */
import { chromium, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node, type DesignDocument, type DesignNode } from '../src/model'

const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-canvas-tools-'))
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
  'Native Electron/Finder/Dock/OS clipboard are outside this browser suite.',
  'Real stylus pressure, tablet drivers, trackpad gestures and macOS Option-produced text require native input acceptance.',
  'Ellipse start/sweep/inner-radius arc controls and custom stretch/scatter brush materials are not claimed.',
]
function passed(name: string, scope?: string) { checks.push({ name, ...(scope ? { scope } : {}) }); console.log(`CANVAS_CHECK ${name}`) }
try {
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite startup timeout')), 20_000)
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Owned Vite exited ${code}`)) })
    const inspect = () => { const match = serverLog.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    server.stdout.on('data', inspect); inspect()
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] })
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
    await expect(surface).toHaveAttribute('data-renderer', /webgpu|webgl2/)
  }
  const storedCount = async (count: number) => {
    await expect.poll(async () => Object.keys((await document()).nodes).length, { timeout: 20_000 }).toBe(count)
    await settle()
  }
  const screenshot = async (name: string) => { await settle(); await p.screenshot({ path: join(output, `${name}.png`) }) }
  const fresh = async (name: string, supplied?: DesignDocument) => {
    const fixture = supplied || blank(name)
    const filename = join(output, `${++sequence}-${name}.fd`)
    await writeFile(filename, JSON.stringify(fixture))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(filename)
    await expect(p.getByLabel('文档名称')).toHaveValue(fixture.name, { timeout: 30_000 })
    // File import intentionally forks the document identity. Read the actual
    // persisted copy instead of treating the portable source ID as authoritative.
    await expect.poll(async () => (await record())?.document.name, { timeout: 20_000 }).toBe(fixture.name)
    await settle(); await canvas.focus()
    return await document()
  }
  const box = async () => { const value = await canvas.boundingBox(); if (!value) throw Error('Canvas has no bounds'); return value }
  const point = async (x: number, y: number) => { const b = await box(); return { x: b.x + x, y: b.y + y } }
  const camera = () => surface.evaluate(el => ({ x: Number(el.getAttribute('data-camera-x')), y: Number(el.getAttribute('data-camera-y')), zoom: Number(el.getAttribute('data-camera-zoom')) }))
  const worldAt = async (screen: { x: number; y: number }) => { const b = await box(), v = await camera(); return { x: (screen.x - b.x - v.x) / v.zoom, y: (screen.y - b.y - v.y) / v.zoom } }
  const nodePoint = async (n: DesignNode) => {
    const b = await box(), v = await camera()
    return { x: b.x + v.x + (n.transform[4] + n.width / 2) * v.zoom, y: b.y + v.y + (n.transform[5] + n.height / 2) * v.zoom }
  }
  const dimensions = async () => ({
    width: Number(await p.getByTestId('creation-dimensions').getAttribute('data-width')),
    height: Number(await p.getByTestId('creation-dimensions').getAttribute('data-height')),
  })
  const selectShape = async (name: string) => {
    await p.getByRole('button', { name: '形状工具', exact: true }).click()
    await p.getByRole('menuitemradio', { name, exact: true }).click()
    await canvas.focus()
  }
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }, modifiers: string[] = []) => {
    for (const modifier of modifiers) await p.keyboard.down(modifier)
    await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps: 8 })
  }
  const finish = async (modifiers: string[] = []) => { await p.mouse.up(); for (const modifier of [...modifiers].reverse()) await p.keyboard.up(modifier) }
  const onlyNode = async () => { const nodes = Object.values((await document()).nodes); expect(nodes).toHaveLength(1); return nodes[0] }
  const undo = async () => { await p.getByRole('button', { name: '撤销', exact: true }).click() }

  await fresh('01-原生椭圆')
  await p.keyboard.press('o'); await expect(canvas).toHaveClass(/canvas-ellipse/)
  await drag(await point(170, 150), await point(350, 260))
  await expect(canvas).toHaveAttribute('data-creation-kind', 'ellipse')
  const ellipsePreview = await dimensions()
  await screenshot('01-ellipse-draft-exact')
  expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await finish(); await storedCount(1)
  const ellipse = await onlyNode()
  expect(ellipse.kind).toBe('ellipse'); expect(ellipse.network).toBeUndefined()
  expect(ellipse.width).toBeCloseTo(ellipsePreview.width, 8); expect(ellipse.height).toBeCloseTo(ellipsePreview.height, 8)
  passed('O ellipse: native draft/final dimensions agree; draft never reaches IndexedDB')

  const ellipseRecord = await record()
  await canvas.focus(); await p.keyboard.press('Enter')
  await expect(canvas).toHaveClass(/canvas-vector/)
  await expect(p.getByTestId('vector-anchor').first()).toBeVisible()
  await p.getByTestId('vector-anchor').first().click()
  await p.keyboard.press('Enter'); await expect(canvas).toHaveClass(/canvas-select/)
  expect((await record())!.revision).toBe(ellipseRecord!.revision)
  expect(await document()).toEqual(ellipseRecord!.document)
  await canvas.focus(); await p.keyboard.press('Enter')
  const anchor = (await p.getByTestId('vector-anchor').first().boundingBox())!
  await drag({ x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 }, { x: anchor.x + anchor.width / 2 + 22, y: anchor.y + anchor.height / 2 + 8 })
  await finish()
  await expect.poll(async () => (await onlyNode()).kind, { timeout: 20_000 }).toBe('vector')
  expect((await onlyNode()).network?.edges.some(edge => edge.c1 || edge.c2)).toBe(true)
  await undo(); await expect.poll(async () => (await onlyNode()).kind).toBe('ellipse')
  expect((await onlyNode()).network).toBeUndefined()
  await p.keyboard.press('Escape'); await screenshot('02-ellipse-vector-roundtrip')
  passed('Enter and stationary anchor click preserve ellipse/revision; first moved anchor converts to curves; one Undo restores native ellipse')

  for (const [name, modifiers] of [['03-Shift圆', ['Shift']], ['04-Option中心', ['Alt']], ['05-ShiftOption中心圆', ['Shift', 'Alt']]] as const) {
    await fresh(name); await p.keyboard.press('o')
    const start = await point(330, 240), expectedCenter = await worldAt(start)
    await drag(start, await point(420, 295), [...modifiers])
    const preview = await dimensions(); await screenshot(name)
    await finish([...modifiers]); await storedCount(1)
    const n = await onlyNode()
    expect(n.width).toBeCloseTo(preview.width, 8); expect(n.height).toBeCloseTo(preview.height, 8)
    if (modifiers.includes('Shift' as never)) expect(n.width).toBe(n.height)
    if (modifiers.includes('Alt' as never)) {
      expect(n.transform[4] + n.width / 2).toBeCloseTo(expectedCenter.x, 6)
      expect(n.transform[5] + n.height / 2).toBeCloseTo(expectedCenter.y, 6)
    }
    passed(`${name}: authored dimensions/center match preview and modifier contract`)
  }

  await fresh('06-单击默认尺寸'); await p.keyboard.press('o')
  const click = await point(250, 210); await p.mouse.click(click.x, click.y)
  await storedCount(1); expect(await onlyNode()).toMatchObject({ kind: 'ellipse', width: 100, height: 100 })
  passed('Single-click ellipse is 100×100 authored geometry')

  await fresh('07-多边形键盘与手柄'); await selectShape('多边形')
  await drag(await point(180, 160), await point(350, 300))
  await expect(canvas).toHaveAttribute('data-creation-kind', 'polygon')
  await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowUp'); await p.keyboard.press('ArrowDown')
  await screenshot('07-polygon-point-count-draft'); await finish(); await storedCount(1)
  const polygon = await onlyNode(); expect(polygon.kind).toBe('polygon'); expect(polygon.points).toBe(4)
  const handle = p.getByTestId('shape-points-handle'); await expect(handle).toHaveAttribute('data-node-id', polygon.id)
  const h = (await handle.boundingBox())!
  await drag({ x: h.x + h.width / 2, y: h.y + h.height / 2 }, { x: h.x + h.width / 2, y: h.y + h.height / 2 - 36 }); await finish()
  await expect.poll(async () => (await onlyNode()).points).not.toBe(4)
  await undo(); await expect.poll(async () => (await onlyNode()).points).toBe(4)
  await undo(); await storedCount(0)
  await selectShape('多边形'); const triangleClick = await point(250, 210); await p.mouse.click(triangleClick.x, triangleClick.y)
  await storedCount(1); expect((await onlyNode()).points).toBe(3)
  passed('Polygon defaults to 3; draft ArrowUp/Down edits count; count-handle gesture is one undo')

  for (const diagonal of [false, true]) {
    await fresh(diagonal ? '09-约束直线' : '08-竖直线'); await p.keyboard.press('l')
    const modifiers = diagonal ? ['Shift'] : []
    await drag(await point(230, 160), await point(diagonal ? 390 : 230, 280), modifiers)
    await expect(canvas).toHaveAttribute('data-creation-kind', 'line')
    const preview = await dimensions(); await screenshot(diagonal ? '09-line-45-draft' : '08-line-vertical-draft')
    await finish(modifiers); await storedCount(1)
    const n = await onlyNode(); expect(n.kind).toBe('line'); expect(n.width).toBe(preview.width); expect(n.height).toBe(preview.height)
    const [a, b] = n.network!.vertices, dx = b.x - a.x, dy = b.y - a.y
    if (diagonal) expect(Math.abs(dx)).toBeCloseTo(Math.abs(dy), 8)
    else { expect(dx).toBe(0); expect(Math.abs(dy)).toBeGreaterThan(20); expect(n.width).toBe(1) }
    passed(diagonal ? 'Shift line is 45° in persisted endpoints and matches preview' : 'Vertical line retains endpoints and 1px internal extent instead of a click fallback')
  }

  await fresh('10-取消与指针归属'); await p.keyboard.press('o')
  await drag(await point(170, 160), await point(330, 290)); await p.keyboard.press('Escape'); await finish()
  await expect(canvas).not.toHaveAttribute('data-creation-kind', /.+/)
  expect(Object.keys((await document()).nodes)).toHaveLength(0); await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  await canvas.focus(); await p.keyboard.press('o'); await drag(await point(180, 170), await point(360, 310))
  const wrong = await point(600, 500)
  await canvas.dispatchEvent('pointerup', { pointerId: 2147483000, pointerType: 'mouse', isPrimary: false, button: 0, clientX: wrong.x, clientY: wrong.y, bubbles: true })
  await canvas.dispatchEvent('pointercancel', { pointerId: 2147483000, pointerType: 'mouse', isPrimary: false, clientX: wrong.x, clientY: wrong.y, bubbles: true })
  await expect(canvas).toHaveAttribute('data-creation-kind', 'ellipse')
  expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await finish(); await storedCount(1)
  passed('Esc cancels without history; non-owner pointerup/cancel cannot end a real mouse gesture', 'Wrong-pointer events are synthetic DOM events only; normal drawing uses Playwright mouse input.')

  await fresh('11-铅笔与压感画笔')
  await p.keyboard.press('Shift+KeyP'); await expect(canvas).toHaveClass(/canvas-pencil/)
  await canvas.focus(); await p.keyboard.press('v'); await p.keyboard.press('Alt+KeyP'); await expect(canvas).toHaveClass(/canvas-pencil/)
  await expect(p.getByLabel('笔宽', { exact: true })).toHaveValue('1')
  await p.getByLabel('笔宽', { exact: true }).fill('3'); await p.getByLabel('笔宽', { exact: true }).press('Enter')
  await canvas.focus(); await p.keyboard.press('b'); await expect(canvas).toHaveClass(/canvas-brush/)
  await expect(p.getByLabel('笔宽', { exact: true })).toHaveValue('12')
  await p.getByLabel('笔宽', { exact: true }).fill('18'); await p.getByLabel('笔宽', { exact: true }).press('Enter')
  await canvas.focus(); await p.keyboard.press('Shift+KeyP'); await expect(p.getByLabel('笔宽', { exact: true })).toHaveValue('3')
  const penStart = await point(160, 190), penMid = await point(260, 245), penEnd = await point(390, 190)
  await p.keyboard.down('Shift'); await p.mouse.move(penStart.x, penStart.y); await p.mouse.down()
  await p.mouse.move(penMid.x, penMid.y, { steps: 5 }); await p.mouse.move(penEnd.x, penEnd.y, { steps: 5 })
  await screenshot('11-pencil-straight-draft'); expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await finish(['Shift']); await storedCount(1)
  const pencil = await onlyNode(); expect(pencil.kind).toBe('vector'); expect(pencil.strokes[0].width).toBe(3); expect(pencil.strokes[0].widthProfile).toBeUndefined()
  for (const vertex of pencil.network!.vertices) expect(vertex.y).toBeCloseTo(pencil.network!.vertices[0].y, 8)
  for (const edge of pencil.network!.edges) for (const control of [edge.c1, edge.c2]) if (control) expect(control.y).toBeCloseTo(pencil.network!.vertices[0].y, 8)
  await undo(); await storedCount(0)
  await canvas.focus(); await p.keyboard.press('b'); await expect(p.getByLabel('笔宽', { exact: true })).toHaveValue('18')
  await p.mouse.move(penStart.x, penStart.y); await p.mouse.down(); await p.mouse.move(penMid.x, penMid.y, { steps: 6 }); await p.mouse.move(penEnd.x, penEnd.y, { steps: 6 }); await p.mouse.up()
  await storedCount(1); const brush = await onlyNode(); expect(brush.strokes[0].width).toBe(18); expect(brush.strokes[0].widthProfile?.length).toBeGreaterThan(0)
  await undo(); await storedCount(0)
  passed('Shift+P/Option+P pencil and B brush keep separate widths; Shift pencil is straight/constant width; each stroke undoes once', 'Mouse uses neutral pressure. Actual variable stylus pressure is a manual device gate.')

  const menuDoc = blank('12-右键语义'), a = node('rectangle', 50, 70, 110, 90), b = node('rectangle', 240, 70, 110, 90)
  a.name = '右键图层 A'; b.name = '右键图层 B'; menuDoc.nodes = { [a.id]: a, [b.id]: b }; menuDoc.pages[0].children = [a.id, b.id]
  await fresh(menuDoc.name, menuDoc)
  const menu = p.getByRole('menu', { name: '画布右键菜单', exact: true })
  const menuAt = async (position: { x: number; y: number }) => { await p.mouse.click(position.x, position.y, { button: 'right' }); await expect(menu).toBeVisible() }
  await menuAt(await point(22, 45)); await expect(menu.getByRole('menuitem', { name: '全选', exact: true })).toBeEnabled()
  const disabledCopy = menu.getByRole('menuitem', { name: '复制', exact: true }); if (await disabledCopy.count()) await expect(disabledCopy).toBeDisabled()
  await p.keyboard.press('Escape'); await expect(menu).toBeHidden()
  await menuAt(await nodePoint(a)); await expect(p.getByTestId(`layer-${a.id}`)).toHaveAttribute('aria-selected', 'true')
  await menu.getByRole('menuitem', { name: '复制', exact: true }).click()
  await expect.poll(() => p.evaluate(async () => (await navigator.clipboard.readText()).startsWith('FORMA-NODES-V1\n'))).toBe(true)
  const pastePoint = await point(430, 360), expectedPaste = await worldAt(pastePoint)
  await menuAt(pastePoint); await menu.getByRole('menuitem', { name: '粘贴到此处', exact: true }).click(); await storedCount(3)
  const pasted = Object.values((await document()).nodes).find(n => n.id !== a.id && n.id !== b.id)!
  expect(pasted.transform[4]).toBeCloseTo(expectedPaste.x, 4); expect(pasted.transform[5]).toBeCloseTo(expectedPaste.y, 4)
  await undo(); await storedCount(2)
  await p.getByTestId(`layer-${a.id}`).click(); await p.getByTestId(`layer-${b.id}`).click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
  await menuAt(await nodePoint(a)); await expect(p.locator('[role=treeitem][aria-selected=true]')).toHaveCount(2)
  await menu.getByRole('menuitem', { name: '创建副本', exact: true }).click(); await storedCount(4)
  await undo(); await storedCount(2)
  await p.getByTestId(`layer-${a.id}`).click(); await menuAt(await nodePoint(a))
  await menu.getByRole('menuitem', { name: '锁定图层', exact: true }).click()
  await expect.poll(async () => (await document()).nodes[a.id].locked).toBe(true)
  await menuAt(await nodePoint(a))
  const unlock = menu.getByRole('menuitem', { name: /^(解锁图层|解锁图层及父级)$/ })
  await expect(unlock).toBeVisible(); await unlock.click()
  await expect.poll(async () => (await document()).nodes[a.id].locked).toBe(false)
  const bounds = await box(); await menuAt({ x: bounds.x + bounds.width - 3, y: bounds.y + bounds.height - 3 })
  const menuBounds = (await menu.boundingBox())!, viewport = p.viewportSize()!
  expect(menuBounds.x).toBeGreaterThanOrEqual(0); expect(menuBounds.y).toBeGreaterThanOrEqual(0)
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height + 1)
  await screenshot('12-context-menu-boundary'); await p.keyboard.press('Escape'); await expect(menu).toBeHidden()
  passed('Context menu handles empty/single/multiple selection, browser clipboard paste-here, duplicate, lock/unlock, Escape and viewport boundaries')

  await fresh('13-手势内快捷键围栏'); await p.keyboard.press('o')
  await drag(await point(180, 160), await point(340, 270))
  const guardedDimensions = await dimensions()
  for (const key of ['Delete', 'ArrowRight', 'Enter']) await p.keyboard.press(key)
  await expect(canvas).toHaveClass(/canvas-ellipse/)
  await expect(canvas).toHaveAttribute('data-creation-kind', 'ellipse')
  expect(await dimensions()).toEqual(guardedDimensions)
  expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await finish(); await storedCount(1); await undo(); await storedCount(0)
  const moveDoc = blank('移动手势事务'), moving = node('rectangle', 70, 90, 100, 70)
  moveDoc.nodes[moving.id] = moving; moveDoc.pages[0].children = [moving.id]
  await fresh(moveDoc.name, moveDoc); await p.getByTestId(`layer-${moving.id}`).click()
  const beforeMove = await document(), moveFrom = await nodePoint(moving)
  await drag(moveFrom, { x: moveFrom.x + 48, y: moveFrom.y + 32 })
  for (const key of ['Delete', 'ArrowRight', 'Enter']) await p.keyboard.press(key)
  await expect(canvas).toHaveClass(/canvas-select/)
  expect((await document()).nodes[moving.id]).toEqual(beforeMove.nodes[moving.id])
  await finish()
  await expect.poll(async () => (await document()).nodes[moving.id]?.transform).not.toEqual(beforeMove.nodes[moving.id].transform)
  await undo(); await expect.poll(async () => (await document()).nodes[moving.id]).toEqual(beforeMove.nodes[moving.id])
  passed('Delete/Arrow/Enter during creation or move cannot edit or switch modes; mouseup commits exactly one undoable gesture')

  const fractionalDoc = blank('14-分数椭圆零位移'), fractional = node('ellipse', 40.125, 60.375, 137.25, 91.375)
  fractionalDoc.nodes[fractional.id] = fractional; fractionalDoc.pages[0].children = [fractional.id]
  await fresh(fractionalDoc.name, fractionalDoc); await p.getByTestId(`layer-${fractional.id}`).click(); await canvas.focus(); await p.keyboard.press('Enter')
  await expect(canvas).toHaveClass(/canvas-vector/); await settle()
  const fractionalBefore = await record()
  const observedDown = async (at: { x: number; y: number }) => {
    // Passive event observation only; no editor/state object is exposed.
    const event = canvas.evaluate(el => new Promise<{ clientX: number; clientY: number; pointerId: number }>(resolve => {
      el.addEventListener('pointerdown', e => { const value = e as PointerEvent; resolve({ clientX: value.clientX, clientY: value.clientY, pointerId: value.pointerId }) }, { capture: true, once: true })
    }))
    await p.mouse.move(at.x, at.y); await p.mouse.down(); return await event
  }
  let fractionalAnchor = (await p.getByTestId('vector-anchor').first().boundingBox())!
  let nativeDown = await observedDown({ x: fractionalAnchor.x + fractionalAnchor.width / 2, y: fractionalAnchor.y + fractionalAnchor.height / 2 })
  await canvas.dispatchEvent('pointermove', { ...nativeDown, pointerType: 'mouse', isPrimary: true, buttons: 1, button: -1, bubbles: true })
  await finish(); await settle()
  expect((await record())!.revision).toBe(fractionalBefore!.revision)
  expect(await document()).toEqual(fractionalBefore!.document)
  await expect(p.locator('.save-status')).toHaveText('已保存到本机')
  fractionalAnchor = (await p.getByTestId('vector-anchor').first().boundingBox())!
  nativeDown = await observedDown({ x: fractionalAnchor.x + fractionalAnchor.width / 2, y: fractionalAnchor.y + fractionalAnchor.height / 2 })
  await p.mouse.move(nativeDown.clientX + 23, nativeDown.clientY + 17, { steps: 4 })
  await p.mouse.move(nativeDown.clientX, nativeDown.clientY, { steps: 4 })
  await finish(); await settle()
  expect((await record())!.revision).toBe(fractionalBefore!.revision)
  expect(await document()).toEqual(fractionalBefore!.document)
  await screenshot('14-fractional-ellipse-restored')
  passed('Fractional ellipse: identical-client pointermove and out-and-back gesture preserve native kind/network/durable revision', 'One stationary pointermove is synthetic using passively observed native down coordinates/id; the out-and-back gesture uses real mouse input.')

  const lockedDoc = blank('15-锁定几何围栏'), lockedEllipse = node('ellipse', 30, 40, 90, 70), lockedGroup = node('group', 220, 40, 140, 100), lockedChild = node('ellipse', 10, 10, 80, 60)
  lockedEllipse.locked = true; lockedEllipse.name = '自身锁定椭圆'; lockedGroup.locked = true; lockedGroup.name = '锁定父级'; lockedChild.name = '父级锁定椭圆'; lockedGroup.children = [lockedChild.id]
  lockedDoc.nodes = { [lockedEllipse.id]: lockedEllipse, [lockedGroup.id]: lockedGroup, [lockedChild.id]: lockedChild }; lockedDoc.pages[0].children = [lockedEllipse.id, lockedGroup.id]
  await fresh(lockedDoc.name, lockedDoc); const lockedBefore = await document()
  for (const id of [lockedEllipse.id, lockedChild.id]) {
    await p.getByTestId(`layer-${id}`).click(); await canvas.focus(); await p.keyboard.press('Enter')
    await expect(canvas).not.toHaveClass(/canvas-vector/); await expect(p.getByTestId('vector-anchor')).toHaveCount(0)
    expect(await document()).toEqual(lockedBefore)
  }
  const vectorDoc = blank('锁定父级矢量钢笔'), vectorParent = node('group', 50, 60, 130, 100), lockedVector = node('vector', 10, 10, 100, 70)
  vectorParent.locked = true; vectorParent.children = [lockedVector.id]
  lockedVector.network = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 70 }], edges: [{ id: 'ab', from: 'a', to: 'b' }], fillRule: 'evenodd' }
  vectorDoc.nodes = { [vectorParent.id]: vectorParent, [lockedVector.id]: lockedVector }; vectorDoc.pages[0].children = [vectorParent.id]
  await fresh(vectorDoc.name, vectorDoc); await p.getByTestId(`layer-${lockedVector.id}`).click(); const lockedVectorBefore = (await document()).nodes[lockedVector.id]
  await canvas.focus(); await p.keyboard.press('p')
  const penOne = await point(430, 170), penTwo = await point(530, 230)
  await p.mouse.click(penOne.x, penOne.y); await p.mouse.click(penTwo.x, penTwo.y); await p.keyboard.press('Enter')
  await storedCount(3)
  expect((await document()).nodes[lockedVector.id]).toEqual(lockedVectorBefore)
  expect((await document()).nodes[vectorParent.id].children).toEqual([lockedVector.id])
  await undo(); await storedCount(2)
  passed('Locked primitives and locked-parent descendants expose no vector handles; P creates a new path instead of modifying a locked vector')

  await fresh('16-钢笔草案生命周期')
  const penDraft = async () => {
    await canvas.focus(); await p.keyboard.press('p')
    for (const at of [await point(180, 160), await point(330, 230)]) await p.mouse.click(at.x, at.y)
    await expect(p.locator('.pen-hint')).toBeVisible()
  }
  await penDraft(); expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await p.keyboard.press('Enter'); await storedCount(1); await expect(p.locator('.pen-hint')).toHaveCount(0)
  await undo(); await storedCount(0)
  await penDraft(); await p.keyboard.press('Escape'); await expect(p.locator('.pen-hint')).toHaveCount(0)
  expect(Object.keys((await document()).nodes)).toHaveLength(0)
  await penDraft(); await p.getByRole('button', { name: '选择', exact: true }).click()
  await storedCount(1); await expect(p.locator('.pen-hint')).toHaveCount(0); await expect(canvas).toHaveClass(/canvas-select/)
  await undo(); await storedCount(0)
  const pagesDoc = blank('钢笔跨页归属'), secondPage = blank().pages[0]
  pagesDoc.pages[0].name = '钢笔页面 A'; secondPage.name = '钢笔页面 B'; pagesDoc.pages.push(secondPage)
  await fresh(pagesDoc.name, pagesDoc); await penDraft()
  await p.locator('.pages button').filter({ hasText: '钢笔页面 B' }).click()
  await storedCount(1); const firstPagePath = (await document()).pages[0].children[0]
  expect((await document()).pages[0].children).toHaveLength(1); expect((await document()).pages[1].children).toHaveLength(0)
  await expect(p.locator('.pen-hint')).toHaveCount(0)
  const committedOldPath = (await document()).nodes[firstPagePath]
  await penDraft(); await p.keyboard.press('Enter'); await storedCount(2)
  expect((await document()).pages[0].children).toEqual([firstPagePath]); expect((await document()).pages[1].children).toHaveLength(1)
  expect((await document()).nodes[firstPagePath]).toEqual(committedOldPath)
  await screenshot('16-pen-page-ownership')
  passed('Pending pen draft: Enter commits once, Esc cancels, tool/page change commits to the original page and cannot leak old points into the next page')

  const outsideDoc = blank('17-手势外侧指针围栏'), outsideShape = node('rectangle', 80, 90, 110, 80)
  outsideDoc.nodes[outsideShape.id] = outsideShape; outsideDoc.pages[0].children = [outsideShape.id]
  await fresh(outsideDoc.name, outsideDoc); await p.getByTestId(`layer-${outsideShape.id}`).click()
  const outsideBefore = await document(), outsideFrom = await nodePoint(outsideShape)
  await drag(outsideFrom, { x: outsideFrom.x + 40, y: outsideFrom.y + 25 })
  for (const target of [p.getByLabel('W', { exact: true }), p.getByRole('button', { name: '绘图工具', exact: true })]) {
    const prevented = await target.evaluate(el => !el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 2147483001, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 })))
    expect(prevented).toBe(true)
  }
  await expect(canvas).toHaveClass(/canvas-select/)
  expect((await document()).nodes[outsideShape.id]).toEqual(outsideBefore.nodes[outsideShape.id])
  await finish(); await expect.poll(async () => (await document()).nodes[outsideShape.id].transform).not.toEqual(outsideBefore.nodes[outsideShape.id].transform)
  await undo(); await expect.poll(async () => (await document()).nodes[outsideShape.id]).toEqual(outsideBefore.nodes[outsideShape.id])
  passed('During an owned move, cancelable second-pointer events on Inspector/tool controls are blocked before another transaction starts', 'Second-pointer control events are synthetic capture-phase gate checks, not physical multi-touch or synthesized OS click acceptance.')

  const presentedCamera = await camera()
  const mapping = await p.evaluate(async ({ view, start, end }) => {
    const { screenToWorld } = await import('/src/canvas-camera.ts')
    const captured = { ...view }
    const other = { x: view.x + 137, y: view.y - 91, zoom: view.zoom * 2 }
    return { start: screenToWorld(captured, start), end: screenToWorld(captured, end), changedEnd: screenToWorld(other, end) }
  }, { view: presentedCamera, start: { x: 100, y: 100 }, end: { x: 150, y: 130 } })
  expect(mapping.end.x - mapping.start.x).toBeCloseTo(50 / presentedCamera.zoom, 8)
  expect(mapping.end.y - mapping.start.y).toBeCloseTo(30 / presentedCamera.zoom, 8)
  expect(mapping.changedEnd).not.toEqual(mapping.end)
  manual.push('Queued zoom whose requested camera has not yet been presented was not deterministically delayed in this run; only pure captured-camera mapping was checked. This is not a passed GPU camera-lag race.')
  passed('Captured presented-camera mapping remains stable when a separate requested camera changes', 'Pure production helper check using observed camera data; the unpresented-worker-zoom timing case remains unverified.')
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, manual, output, browser: browser.version(), platform: process.platform }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks, output }))
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  if (page) await writeFile(join(output, 'failure-ui.txt'), await page.locator('body').innerText().catch(() => 'unavailable'))
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, errors, manual, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally {
  await writeFile(join(output, 'vite.log'), serverLog)
  await browser?.close(); server.kill('SIGTERM')
}
