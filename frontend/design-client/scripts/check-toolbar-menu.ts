/** Owned WebGPU browser regression for toolbar focus, keyboard ownership and bounds. */
import { chromium, expect, type Page } from '@playwright/test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node } from '../src/model'
import { acceptanceCounts, enterOwnedEditor, installGuiLayoutPreference, spawnOwnedVite, stopOwnedProcess, type OwnedWorkspace } from './gui-acceptance-entry.ts'

const output = await mkdtemp(join(tmpdir(), 'forma-toolbar-menu-'))
const server = spawnOwnedVite(new URL('..', import.meta.url))
let log = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
server.stdout.on('data', c => { log += String(c) }); server.stderr.on('data', c => { log += String(c) })
const errors: string[] = [], checks: unknown[] = [], failures: string[] = []
let entry: OwnedWorkspace | undefined, failure: unknown
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite timeout')), 20_000)
    const inspect = () => { const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    server.stdout.on('data', inspect); inspect()
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Owned Vite exited ${code}`)) })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
  page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const p = page
  p.on('pageerror', error => errors.push(String(error)))
  await installGuiLayoutPreference(p)
  await p.goto(base)
  entry = await enterOwnedEditor(p, 'new', 'check-toolbar-menu')
  const read = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())!.document })
  let sequence = 0
  const fresh = async (second = false) => {
    const document = blank(`工具栏围栏 ${++sequence}`), shape = node('rectangle', 60, 80, 160, 110)
    document.nodes[shape.id] = shape; document.pages[0].children = [shape.id]
    if (second) { const sibling = node('rectangle', 260, 80, 100, 110); document.nodes[sibling.id] = sibling; document.pages[0].children.push(sibling.id) }
    const path = join(output, `${sequence}.fd`); await writeFile(path, JSON.stringify(document))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(path)
    await expect(p.getByLabel('文档名称')).toHaveValue(document.name)
    await expect.poll(async () => (await read()).name).toBe(document.name)
    await expect(p.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 30_000 })
    await p.getByTestId(`layer-${shape.id}`).click()
    return await read()
  }
  // Keep all three original defects in the red evidence, rather than stopping
  // after ArrowDown. IndexedDB inspection waits beyond the product's 350ms save debounce.
  for (const key of ['ArrowDown', 'Delete', 'Enter']) {
    const before = await fresh()
    await p.getByRole('button', { name: '形状工具', exact: true }).click()
    const focusedBefore = await p.evaluate(() => document.activeElement?.outerHTML)
    await p.keyboard.press(key)
    await p.waitForTimeout(600)
    const after = await read(), toolClass = await p.getByTestId('canvas').getAttribute('class')
    const graphUnchanged = JSON.stringify(after.nodes) === JSON.stringify(before.nodes) && JSON.stringify(after.pages) === JSON.stringify(before.pages)
    const toolCorrect = key === 'Enter' ? !!toolClass?.includes('canvas-rectangle') : !!toolClass?.includes('canvas-select')
    checks.push({ key, graphUnchanged, toolCorrect, toolClass, focusedBefore, before: before.nodes, after: after.nodes })
    if (!graphUnchanged || !toolCorrect) failures.push(`${key}: graphUnchanged=${graphUnchanged}, toolCorrect=${toolCorrect}`)
    await p.screenshot({ path: join(output, `${key}.png`) })
    await p.keyboard.press('Escape')
  }
  if (failures.length) throw Error(failures.join('; '))

  const before = await fresh(), shapeTrigger = p.getByRole('button', { name: '形状工具', exact: true })
  await p.getByTestId('canvas').focus(); await p.keyboard.press('v')
  const moveTrigger = p.getByRole('button', { name: '移动工具', exact: true })
  await moveTrigger.click()
  await expect(p.getByRole('menuitemradio', { name: '选择', exact: true })).toBeFocused()
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter')
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-hand/)
  await expect(p.getByTestId('canvas')).toBeFocused()
  await expect(p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '平移', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await p.keyboard.press('r')
  await p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '平移', exact: true }).click()
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-hand/)
  await moveTrigger.click(); await p.keyboard.press('Escape'); await expect(moveTrigger).toBeFocused()
  await p.getByTestId('canvas').focus(); await p.keyboard.press('v')
  expect((await read()).nodes).toEqual(before.nodes)
  checks.push({ name: 'Move menu activates hand, remembers it across drawing tools, restores focus, and never edits the graph' })
  await shapeTrigger.click()
  const menu = p.getByRole('menu', { name: '形状工具', exact: true })
  await expect(menu).toBeVisible()
  await expect(p.getByRole('menuitemradio', { name: '矩形', exact: true })).toBeFocused()
  await expect(p.getByRole('menuitemradio', { name: '分区', exact: true })).toHaveCount(0)
  await p.keyboard.press('End'); await expect(p.getByRole('menuitemradio', { name: '星形', exact: true })).toBeFocused()
  await p.keyboard.press('Home'); await expect(p.getByRole('menuitemradio', { name: '矩形', exact: true })).toBeFocused()
  await p.keyboard.press('ArrowDown'); await expect(p.getByRole('menuitemradio', { name: '直线', exact: true })).toBeFocused()
  await p.keyboard.press('ArrowDown'); await expect(p.getByRole('menuitemradio', { name: '箭头', exact: true })).toBeFocused()
  await p.keyboard.press('ArrowDown'); await expect(p.getByRole('menuitemradio', { name: '椭圆', exact: true })).toBeFocused()
  await p.keyboard.press('Space'); await expect(menu).toHaveCount(0)
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-ellipse/)
  await expect(p.getByTestId('canvas')).toBeFocused()
  await shapeTrigger.click(); await p.keyboard.press('Escape')
  await expect(menu).toHaveCount(0); await expect(shapeTrigger).toBeFocused()
  await shapeTrigger.click(); await p.keyboard.press('Tab')
  await expect(menu).toHaveCount(0); await expect(shapeTrigger).toBeFocused()
  await shapeTrigger.click()
  await p.getByLabel('文档名称').click(); await expect(menu).toHaveCount(0); await expect(p.getByLabel('文档名称')).toBeFocused()
  await p.getByTestId('canvas').focus(); await p.keyboard.press('v')
  await p.getByRole('button', { name: '绘图工具', exact: true }).click()
  await expect(p.getByRole('menu', { name: '绘图工具', exact: true })).toBeVisible()
  await expect(p.getByRole('menuitemradio', { name: '钢笔', exact: true })).toBeFocused()
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter')
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-pencil/)
  await expect(p.getByTestId('canvas')).toBeFocused()
  await p.waitForTimeout(400); expect((await read()).nodes).toEqual(before.nodes)
  checks.push({ name: 'Roving menu focus, tool activation, Escape/Tab restoration and outside-input focus' })

  const drawingTrigger = p.getByRole('button', { name: '绘图工具', exact: true })
  const pencilButton = p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '铅笔', exact: true })
  await expect(pencilButton).toHaveAttribute('aria-pressed', 'true')
  await pencilButton.hover(); await expect(pencilButton).toHaveCSS('background-color', 'rgb(8, 100, 212)')
  await drawingTrigger.click()
  await expect(p.getByRole('menuitemradio', { name: '铅笔', exact: true })).toBeFocused()
  await expect(p.getByRole('menuitemradio', { name: '铅笔', exact: true })).toHaveAttribute('aria-checked', 'true')
  const brushItem = p.getByRole('menuitemradio', { name: '画笔', exact: true })
  await brushItem.hover(); await expect(brushItem).toBeFocused(); await expect(brushItem).toHaveCSS('background-color', 'rgb(22, 116, 232)')
  const disabledOutline = p.getByRole('menuitem', { name: '轮廓化描边', exact: true })
  await expect(disabledOutline).toBeDisabled(); await disabledOutline.hover()
  await expect(disabledOutline).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(disabledOutline).toHaveCSS('color', 'rgb(160, 162, 165)')
  await expect(brushItem).toBeFocused()
  await p.screenshot({ path: join(output, 'drawing-hover-disabled.png') })
  await p.keyboard.press('Escape'); await expect(drawingTrigger).toBeFocused()
  await expect(drawingTrigger).toHaveCSS('outline-style', 'solid')

  const regionTrigger = p.getByRole('button', { name: '区域工具', exact: true })
  await regionTrigger.click()
  await expect(p.getByRole('menuitemradio', { name: '画板', exact: true })).toBeFocused()
  await expect(p.getByRole('menuitemradio', { name: '分区', exact: true })).toContainText('⇧ S')
  await p.keyboard.press('ArrowDown'); await p.keyboard.press('Enter')
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-section/)
  await expect(p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '分区', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await regionTrigger.click(); await expect(p.getByRole('menuitemradio', { name: '分区', exact: true })).toBeFocused()
  await p.keyboard.press('Home'); await p.keyboard.press('Enter')
  await expect(p.getByTestId('canvas')).toHaveClass(/canvas-frame/)
  await expect(p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '画板', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await regionTrigger.focus(); await p.keyboard.press('ArrowUp')
  await expect(p.getByRole('menuitemradio', { name: '切片', exact: true })).toBeFocused()
  await p.keyboard.press('Escape'); await expect(regionTrigger).toBeFocused()
  await p.keyboard.press('ArrowRight'); await expect(p.getByRole('toolbar', { name: '设计工具' }).getByRole('button', { name: '椭圆', exact: true })).toBeFocused()
  await p.keyboard.press('Enter'); await expect(p.getByTestId('canvas')).toHaveClass(/canvas-ellipse/)
  checks.push({ name: 'Frame/Section/Slice grouping, primary active state, hover/focus/disabled styles and toolbar arrows' })

  await p.getByRole('button', { name: '排列与编辑', exact: true }).click()
  await expect(p.getByRole('menuitem', { name: /^解除编组/ })).toBeDisabled()
  await p.getByRole('menuitem', { name: /^编组/ }).click()
  await expect.poll(async () => Object.keys((await read()).nodes).length).toBe(2)
  await expect(p.getByRole('menu', { name: '排列与编辑' })).toHaveCount(0)
  await expect(p.getByTestId('canvas')).toBeFocused()
  await p.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(async () => (await read()).nodes).toEqual(before.nodes)
  checks.push({ name: 'Explicit menu command passes shared dispatcher, groups once, and one Undo restores original graph' })

  const toolbelt = p.getByRole('toolbar', { name: '设计工具' }), canvas = p.getByTestId('canvas')
  await shapeTrigger.click(); await p.getByRole('menuitemradio', { name: '星形', exact: true }).click()
  await p.keyboard.press('v')
  const starPrimary = toolbelt.getByRole('button', { name: '星形', exact: true })
  await expect(starPrimary).toHaveAttribute('aria-pressed', 'false'); await starPrimary.click()
  await expect(canvas).toHaveClass(/canvas-star/)
  await p.keyboard.press('l'); await p.keyboard.press('v')
  await toolbelt.getByRole('button', { name: '直线', exact: true }).click(); await expect(canvas).toHaveClass(/canvas-line/)
  await p.keyboard.press('b'); await p.keyboard.press('v')
  await toolbelt.getByRole('button', { name: '画笔', exact: true }).click(); await expect(canvas).toHaveClass(/canvas-brush/)
  await p.keyboard.press('Shift+P'); await p.keyboard.press('h')
  await toolbelt.getByRole('button', { name: '铅笔', exact: true }).click(); await expect(canvas).toHaveClass(/canvas-pencil/)
  await expect(toolbelt.getByRole('button', { name: '直线', exact: true })).toBeVisible()
  expect((await read()).nodes).toEqual(before.nodes)
  checks.push({ name: 'Shape/drawing primary independently remember last menu or shortcut tool after selection/hand changes, without editing document' })

  await p.keyboard.press('v'); await canvas.focus(); await p.keyboard.press('F6')
  const selectButton = toolbelt.getByRole('button', { name: '选择', exact: true }), tooltip = p.getByRole('tooltip')
  await expect(selectButton).toBeFocused(); await expect(tooltip).toHaveText('选择 (V)')
  const tooltipId = await tooltip.getAttribute('id')
  await expect(selectButton).toHaveAttribute('aria-describedby', tooltipId!)
  await expect(selectButton).not.toHaveAttribute('title', /.+/)
  await expect(tooltip).toHaveCSS('pointer-events', 'none')
  const hintBounds = (await tooltip.boundingBox())!
  expect(await p.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="tooltip"]'), { x: hintBounds.x + hintBounds.width / 2, y: hintBounds.y + hintBounds.height / 2 })).toBe(false)
  await p.screenshot({ path: join(output, 'f6-keyboard-tooltip.png') })
  await p.keyboard.press('Escape'); await expect(tooltip).toHaveCount(0); await expect(selectButton).toBeFocused()
  await expect(selectButton).not.toHaveAttribute('aria-describedby', /.+/)
  await p.keyboard.press('F6'); await expect(canvas).toBeFocused()
  await p.keyboard.press('Shift+F6'); await expect(selectButton).toBeFocused()
  await p.keyboard.press('Shift+F6'); await expect(canvas).toBeFocused()
  await p.getByLabel('文档名称').focus(); await p.keyboard.press('F6'); await expect(p.getByLabel('文档名称')).toBeFocused()
  await p.getByLabel('更多工作区操作').click()
  await p.getByRole('button', { name: '色彩与 HDR', exact: true }).click()
  const closeColor = p.getByRole('button', { name: '关闭色彩面板', exact: true })
  await closeColor.focus(); await p.keyboard.press('F6'); await expect(closeColor).toBeFocused(); await closeColor.click()
  await shapeTrigger.click(); const initialMenuFocus = await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  await p.keyboard.press('F6'); expect(await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(initialMenuFocus)
  await p.keyboard.press('Escape'); await canvas.focus()
  await toolbelt.getByRole('button', { name: '文字', exact: true }).hover()
  await expect(tooltip).toHaveText('文字 (T)')
  await p.screenshot({ path: join(output, 'hover-tooltip.png') })
  await p.mouse.move(20, 20); await expect(tooltip).toHaveCount(0)
  expect((await read()).nodes).toEqual(before.nodes)
  checks.push({ name: 'F6/Shift-F6 toolbar/canvas cycle respects input/menu/modal ownership; keyboard/hover tooltips link aria-describedby, dismiss and never intercept pointer' })

  for (const [menuName, primaryName, tool] of [['形状工具', '直线', 'line'], ['区域工具', '画板', 'frame'], ['绘图工具', '铅笔', 'pencil']]) {
    await toolbelt.getByRole('button', { name: menuName, exact: true }).click()
    await expect(p.getByRole('menu', { name: menuName, exact: true })).toBeVisible()
    await toolbelt.getByRole('button', { name: primaryName, exact: true }).click()
    await expect(p.getByRole('menu', { name: menuName, exact: true })).toHaveCount(0)
    await expect(canvas).toHaveClass(new RegExp(`canvas-${tool}`)); await expect(canvas).toBeFocused()
    await p.keyboard.press('v')
  }
  checks.push({ name: 'Clicking a same-group shape/region/drawing primary closes its own open menu and returns canvas focus' })

  await p.setViewportSize({ width: 1000, height: 640 })
  for (const label of ['区域工具', '形状工具', '绘图工具', '排列与编辑']) {
    await p.getByRole('button', { name: label, exact: true }).click()
    const opened = p.getByRole('menu', { name: label, exact: true })
    await expect(opened).toBeVisible()
    const bounds = (await opened.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.y).toBeGreaterThanOrEqual(8)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(992)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(632)
    await p.screenshot({ path: join(output, `bounds-${label}.png`) })
    await p.keyboard.press('Escape')
  }
  checks.push({ name: 'Region/shape/drawing/arrangement menus stay within 1000x640 viewport' })
  await canvas.focus(); await p.keyboard.press('F6'); await expect(tooltip).toBeVisible()
  const smallHint = (await tooltip.boundingBox())!
  expect(smallHint.x).toBeGreaterThanOrEqual(8); expect(smallHint.y).toBeGreaterThanOrEqual(8)
  expect(smallHint.x + smallHint.width).toBeLessThanOrEqual(992); expect(smallHint.y + smallHint.height).toBeLessThanOrEqual(632)
  await p.screenshot({ path: join(output, 'tooltip-bounds-1000.png') })

  const navigationDoc = await fresh(true), firstId = navigationDoc.pages[0].children[0]
  const selectedIds = () => p.locator('[role=treeitem][aria-selected=true]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')))
  const selectionBefore = [`layer-${firstId}`]
  const controls = [p.getByTestId(`layer-${firstId}`), p.getByRole('button', { name: '预览原型', exact: true }),
    p.getByLabel('缩放与视图设置', { exact: true })]
  for (const control of controls) {
    await control.focus(); await expect(control).toBeFocused(); await p.keyboard.press('Tab')
    await expect(control).not.toBeFocused(); expect(await selectedIds()).toEqual(selectionBefore)
  }
  expect((await read()).nodes).toEqual(navigationDoc.nodes)
  checks.push({ name: 'With two siblings selected tree/header/zoom-summary/zoom-button Tab navigates controls without changing canvas selection or document' })
  const controlFailures: string[] = [], controlResults: unknown[] = []
  for (const scenario of ['summary-enter', 'zoom-enter', 'zoom-delete']) {
    const original = await fresh(true), summary = p.getByLabel('缩放与视图设置', { exact: true }), zoomIn = p.getByTitle('放大', { exact: true })
    const zoomBefore = Number.parseFloat(await summary.innerText())
    if (await p.locator('.view-menu').getAttribute('open') !== null) await summary.click()
    if (scenario !== 'summary-enter') await summary.click()
    const target = scenario === 'summary-enter' ? summary : zoomIn
    await target.focus(); await p.keyboard.press(scenario === 'zoom-delete' ? 'Delete' : 'Enter')
    await p.waitForTimeout(600)
    const unchanged = JSON.stringify((await read()).nodes) === JSON.stringify(original.nodes)
    const toolClass = await canvas.getAttribute('class'), zoomAfter = Number.parseFloat(await summary.innerText())
    const opened = await p.locator('.view-menu').getAttribute('open') !== null
    let menuBounds: { x: number; y: number; width: number; height: number } | null = null, restoredZoom: number | undefined
    if (scenario === 'summary-enter' || scenario === 'zoom-enter') {
      if (!opened) { await summary.focus(); await p.keyboard.press('Enter') }
      const menuBody = p.locator('.view-menu-body'), canvasBounds = (await canvas.boundingBox())!, viewport = p.viewportSize()!
      await expect(menuBody).toBeVisible(); menuBounds = (await menuBody.boundingBox())!
      expect(menuBounds.x).toBeGreaterThanOrEqual(0)
      expect(menuBounds.y).toBeGreaterThanOrEqual(0)
      expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width)
      expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height)
      if (scenario === 'zoom-enter') {
        await menuBody.getByRole('button', { name: '100%', exact: true }).click()
        await expect(summary).toHaveText('100%')
        await expect(p.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true')
        await expect(p.locator('.kernel-presentation')).toHaveAttribute('data-camera-zoom', '1')
        restoredZoom = Number.parseFloat(await summary.innerText())
      }
    }
    const correct = unchanged && !!toolClass?.includes('canvas-select') &&
      (scenario === 'summary-enter' ? opened : scenario === 'zoom-enter' ? zoomAfter > zoomBefore : zoomAfter === zoomBefore)
    controlResults.push({ scenario, unchanged, toolClass, zoomBefore, zoomAfter, opened, menuBounds, restoredZoom, correct })
    if (!correct) controlFailures.push(scenario)
    await p.screenshot({ path: join(output, `${scenario}.png`) })
  }
  checks.push({ name: 'Zoom summary/native button Enter preserves activation; right-sidebar menu fits viewport and 100% click restores actual presented frame; Delete never edits layers', results: controlResults })
  if (controlFailures.length) throw Error(`ViewControls keyboard ownership: ${controlFailures.join(', ')}`)
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length }))
} catch (error) {
  failure = error
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', checks, failures, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally {
  await writeFile(join(output, 'vite.log'), log)
  console.log(`ACCEPTANCE_COUNTS ${JSON.stringify(acceptanceCounts('check-toolbar-menu', checks, failure, !!entry))}`)
  await browser?.close(); await stopOwnedProcess(server)
}
