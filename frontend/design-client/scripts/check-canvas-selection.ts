/** Private CPU Chromium acceptance of actual canvas input. Fixtures enter through
 * the real file input; no Editor instance, selection, or pointer handler is injected.
 * IndexedDB and DOM are read only as evidence. A frozen source copy avoids HMR
 * changes from other work during the run. */
import { chromium, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, worldMatrix } from '../src/geometry'
import { blank, node, uid, type DesignDocument } from '../src/model'
import { acceptanceCounts, enterOwnedEditor, freezeAcceptanceSnapshot, installGuiLayoutPreference, spawnOwnedVite, stopOwnedProcess, type OwnedWorkspace } from './gui-acceptance-entry.ts'

const project = fileURLToPath(new URL('..', import.meta.url))
const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-canvas-selection-'))
const frozen = await freezeAcceptanceSnapshot(project, output)
const snapshot = frozen.clientRoot
const sourceHashes: Record<string, string> = {}
for (const name of ['Canvas.tsx', 'engine.ts', 'Layers.tsx', 'App.tsx', 'modal-keyboard.ts', 'canvas-pointer-intent.ts', 'selection-hierarchy.ts', 'styles.css'])
  sourceHashes[name] = createHash('sha256').update(await readFile(join(snapshot, 'src', name))).digest('hex')
Object.assign(sourceHashes, frozen.dependencyHashes)
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(sourceHashes, null, 2))
const server = spawnOwnedVite(snapshot)
let log = '', browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
let entry: OwnedWorkspace | undefined, failure: unknown
const errors: string[] = [], checks: { name: string; evidence?: unknown }[] = []
server.stdout.on('data', chunk => { log += String(chunk) }); server.stderr.on('data', chunk => { log += String(chunk) })
const scope = [
  'Actual Playwright mouse/keyboard events against React, Rust WASM CPU reference, and IndexedDB in a private Chromium profile.',
  'Fixtures are imported as portable .fd files through the actual file input; model injection does not stand in for selection or dragging.',
  'No Electron, OS-native keyboard behavior, stylus/trackpad, GPU performance, or exact Figma drag threshold is claimed.',
  'During a held drag, locator.focus only establishes keyboard ownership for attempted page/file-menu activation; Enter is real keyboard input.',
]
function passed(name: string, evidence?: unknown) { checks.push({ name, ...(evidence === undefined ? {} : { evidence }) }); console.log(`SELECTION_CHECK ${name}`) }

try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Owned Vite startup timeout')), 20_000)
    const inspect = () => { const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]) } }
    server.stdout.on('data', inspect); inspect()
    server.on('exit', code => { clearTimeout(timer); reject(Error(`Owned Vite exited ${code}`)) })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-gpu'] })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 })
  const p = page, canvas = p.getByTestId('canvas'), surface = p.locator('.kernel-reference'), mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await p.addInitScript(() => localStorage.setItem('forma-render-backend', 'cpu'))
  p.on('pageerror', error => errors.push(String(error)))
  await installGuiLayoutPreference(p)
  await p.goto(base)
  entry = await enterOwnedEditor(p, 'new', 'check-canvas-selection')
  const record = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())! })
  const stored = async () => (await record()).document as DesignDocument
  const settle = async () => {
    await expect(surface).toHaveAttribute('data-detail-ready', 'true', { timeout: 30_000 })
    await expect(p.locator('canvas[data-frame-visible=true]')).toHaveAttribute('data-renderer', 'cpu')
    await expect(p.locator('.kernel-status.error')).toHaveCount(0)
  }
  const selected = () => p.locator('[role=treeitem][aria-selected=true]').evaluateAll(rows => rows.map(row => row.getAttribute('data-testid')!.slice(6)).sort())
  const selection = async (...ids: string[]) => expect.poll(selected).toEqual([...ids].sort())
  const row = (id: string) => p.getByTestId(`layer-${id}`)
  const screenshot = async (name: string) => { await settle(); await p.screenshot({ path: join(output, `${name}.png`) }) }
  let sequence = 0
  const fresh = async (document: DesignDocument) => {
    const filename = join(output, `${++sequence}.fd`)
    await writeFile(filename, JSON.stringify(document))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(filename)
    await expect(p.getByLabel('文档名称')).toHaveValue(document.name)
    await expect.poll(async () => (await stored()).name, { timeout: 20_000 }).toBe(document.name)
    await settle(); await canvas.focus()
    await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }
  const nodePoint = async (id: string) => {
    const d = await stored(), n = d.nodes[id], bounds = (await canvas.boundingBox())!
    const world = apply(worldMatrix(d, id), { x: n.width / 2, y: n.height / 2 })
    const view = await surface.evaluate(el => ({ x: Number(el.getAttribute('data-camera-x')), y: Number(el.getAttribute('data-camera-y')), zoom: Number(el.getAttribute('data-camera-zoom')) }))
    return { x: bounds.x + view.x + world.x * view.zoom, y: bounds.y + view.y + world.y * view.zoom }
  }
  const click = async (id: string, modifiers: string[] = [], double = false) => {
    const at = await nodePoint(id)
    for (const key of modifiers) await p.keyboard.down(key)
    if (double) await p.mouse.dblclick(at.x, at.y)
    else await p.mouse.click(at.x, at.y)
    for (const key of [...modifiers].reverse()) await p.keyboard.up(key)
  }
  const key = async (value: string) => { await canvas.focus(); await p.keyboard.press(value) }
  const unmodified = async (before: Awaited<ReturnType<typeof record>>) => {
    await p.waitForTimeout(500) // Beyond the product's 350 ms save debounce.
    const after = await record()
    expect(after.revision).toBe(before.revision)
    expect(after.document).toEqual(before.document)
    await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }
  const undo = async (before: DesignDocument) => {
    await p.getByRole('button', { name: '撤销', exact: true }).click()
    await expect.poll(async () => (await stored()).nodes, { timeout: 20_000 }).toEqual(before.nodes)
    await expect.poll(async () => (await stored()).pages).toEqual(before.pages)
    await settle(); await expect(p.getByRole('button', { name: '撤销', exact: true })).toBeDisabled()
  }

  const nested = blank('层级选择实际交互'), outer = node('frame', 0, 0, 460, 300), group = node('group', 25, 25, 365, 220), inner = node('frame', 15, 15, 330, 200),
    a = node('rectangle', 20, 20, 65, 55), b = node('ellipse', 115, 20, 65, 55), hidden = node('rectangle', 20, 115, 65, 55), locked = node('rectangle', 225, 20, 65, 55)
  outer.name = '外画板'; group.name = '中间组'; inner.name = '内画板'; a.name = '矩形 A'; b.name = '椭圆 B'; hidden.name = '隐藏形状'; locked.name = '锁定形状'
  hidden.visible = false; locked.locked = true
  outer.children = [group.id]; group.children = [inner.id]; inner.children = [a.id, b.id, hidden.id, locked.id]
  for (const n of [outer, group, inner, a, b, hidden, locked]) nested.nodes[n.id] = n
  nested.pages[0].children = [outer.id]
  await fresh(nested)
  const navigationRecord = await record()
  await click(a.id); await selection(outer.id)
  await click(a.id); await selection(outer.id)
  for (const id of [group.id, inner.id, a.id]) {
    await click(a.id, [], true); await selection(id); await expect(canvas).toHaveClass(/canvas-select/)
    // No extra mouse move: selection itself must retire the previous ancestor
    // hover atomically instead of leaving a stale blue frame until motion.
    await expect(p.getByTestId('canvas-hover-outline')).toHaveCount(0)
    await expect(p.locator('[role=treeitem][data-hovered=true]')).toHaveCount(0)
  }
  await screenshot('01-nested-one-level-double-click')
  await click(a.id, [], true); await expect(canvas).toHaveClass(/canvas-vector/)
  await key('Escape'); await expect(canvas).toHaveClass(/canvas-select/); await selection(a.id)
  await key('Escape'); await selection()
  await click(b.id, [mod]); await selection(b.id)
  await key('Escape'); await selection()
  passed('Ordinary click keeps outer frame; double-click descends frame/group/frame/leaf one level with no stale ancestor hover; selected leaf edits on the next double-click; Cmd deep-select bypasses ancestors')

  await row(outer.id).click()
  await key('Enter'); await selection(group.id)
  await key('Enter'); await selection(inner.id)
  await key('Enter'); await selection(a.id, b.id)
  await key('Shift+Enter'); await selection(inner.id)
  await row(b.id).click(); await key('Tab'); await selection(a.id)
  await key('Shift+Tab'); await selection(b.id)
  await key('Shift+Enter'); await selection(inner.id)
  await key('Shift+Enter'); await selection(group.id)
  await key('Shift+Enter'); await selection(outer.id)
  await key('Shift+Enter'); await selection(outer.id)
  await key('Escape'); await selection()
  await click(locked.id, [mod]); expect(await selected()).not.toContain(locked.id)
  await key('Escape'); await click(hidden.id, [mod]); expect(await selected()).not.toContain(hidden.id)
  await row(locked.id).click(); await selection(locked.id)
  await key('Enter'); await expect(canvas).toHaveClass(/canvas-select/); await selection(locked.id)
  await key('Escape'); await selection()
  await unmodified(navigationRecord)
  await screenshot('02-keyboard-hidden-locked')
  passed('Enter selects visible unlocked direct children, Shift+Enter selects parent, Tab moves among siblings, Esc clears; hidden/locked cannot be deep-clicked and tree-selected locked cannot enter vector edit')

  await row(a.id).hover()
  await expect(row(a.id)).toHaveAttribute('data-hovered', 'true')
  await expect(p.getByTestId('canvas-hover-outline')).toHaveAttribute('data-node-id', a.id)
  await screenshot('03-layers-hover')
  await row(a.id).click()
  const ellipsePoint = await nodePoint(b.id)
  await p.mouse.move(ellipsePoint.x, ellipsePoint.y)
  await expect(row(b.id)).toHaveAttribute('data-hovered', 'true')
  await expect(p.getByTestId('canvas-hover-outline')).toHaveAttribute('data-node-id', b.id)
  expect(await p.getByTestId('canvas-hover-outline').evaluate(el => el.tagName.toLowerCase())).toBe('path')
  await screenshot('04-canvas-ellipse-hover')
  await p.getByLabel('文档名称').hover()
  await expect(p.getByTestId('canvas-hover-outline')).toHaveCount(0)
  await expect(p.locator('[role=treeitem][data-hovered=true]')).toHaveCount(0)
  await row(locked.id).hover(); await expect(p.getByTestId('canvas-hover-outline')).toHaveAttribute('data-node-id', locked.id)
  await row(hidden.id).hover(); await expect(p.getByTestId('canvas-hover-outline')).toHaveCount(0)
  await unmodified(navigationRecord)
  passed('Layers hover outlines canvas; canvas ellipse hover uses its path and highlights the tree; pointer leave clears both; locked tree hover is allowed, hidden hover omitted; no history or save revision')

  const two = () => {
    const document = blank('点击与拖动意图'), first = node('rectangle', 70.125, 80.375, 100, 80), second = node('rectangle', 300.125, 80.375, 100, 80)
    first.name = '拖动 A'; second.name = '拖动 B'
    document.nodes = { [first.id]: first, [second.id]: second }; document.pages[0].children = [first.id, second.id]
    document.pages[0].name = '第一页'; document.pages.push({ ...document.pages[0], id: uid(), name: '第二页', children: [] })
    return { document, first, second }
  }
  const multiple = async (first: string, second: string) => {
    await click(first); await click(second, ['Shift']); await selection(first, second)
  }
  let f = two(); await fresh(f.document); await multiple(f.first.id, f.second.id)
  const intentRecord = await record(), at = await nodePoint(f.first.id)
  await p.keyboard.down('Shift'); await p.mouse.move(at.x, at.y); await p.mouse.down(); await selection(f.first.id, f.second.id)
  await p.mouse.up(); await p.keyboard.up('Shift'); await selection(f.second.id)
  await click(f.first.id, ['Shift']); await selection(f.first.id, f.second.id)
  await p.mouse.move(at.x, at.y); await p.mouse.down(); await selection(f.first.id, f.second.id)
  await p.mouse.up(); await selection(f.first.id)
  await unmodified(intentRecord)
  passed('Shift-click keeps both on pointerdown and removes only on release; ordinary click of a multi-selected member collapses only on release; both are history-free')

  for (const shifted of [true, false]) {
    f = two(); f.document.name += shifted ? ' Shift拖动' : ' 多选拖动'
    await fresh(f.document); await multiple(f.first.id, f.second.id)
    const before = await stored(), start = await nodePoint(f.first.id)
    if (shifted) await p.keyboard.down('Shift')
    await p.mouse.move(start.x, start.y); await p.mouse.down(); await selection(f.first.id, f.second.id)
    await p.mouse.move(start.x + 42, start.y + 17, { steps: 6 })
    await selection(f.first.id, f.second.id)
    await p.mouse.up(); if (shifted) await p.keyboard.up('Shift')
    await expect.poll(async () => (await stored()).nodes[f.first.id].transform[4], { timeout: 20_000 }).not.toBe(before.nodes[f.first.id].transform[4])
    await selection(f.first.id, f.second.id); await settle()
    const after = await stored()
    const delta = (id: string) => ({ x: after.nodes[id].transform[4] - before.nodes[id].transform[4], y: after.nodes[id].transform[5] - before.nodes[id].transform[5] })
    expect(delta(f.first.id)).toEqual(delta(f.second.id))
    expect(Math.abs(delta(f.first.id).x)).toBeGreaterThan(20)
    if (shifted) expect(delta(f.first.id).y).toBe(0)
    else expect(Math.abs(delta(f.first.id).y)).toBeGreaterThan(5)
    await screenshot(shifted ? '05-shift-multiselection-drag' : '06-multiselection-drag')
    await undo(before)
    passed(shifted ? 'Shift drag retains and horizontally moves both selected layers; one Undo restores both' : 'Ordinary drag of a selected member moves the entire selection; one Undo restores both', { delta: delta(f.first.id) })
  }

  f = two(); f.document.name += ' 微抖点击'; await fresh(f.document); await click(f.first.id)
  const jitterRecord = await record(), jitterStart = await nodePoint(f.first.id)
  await p.mouse.move(jitterStart.x, jitterStart.y); await p.mouse.down()
  await p.mouse.move(jitterStart.x + 1.25, jitterStart.y - 1.5); await p.mouse.up()
  await selection(f.first.id); await unmodified(jitterRecord)
  await screenshot('07-fractional-jitter-no-history')
  passed('A fractional 1.25×1.5 CSS pixel jitter remains a click: original transforms, same IndexedDB revision, and disabled Undo', { thresholdScope: 'Forma current 3 CSS px, not measured Figma threshold' })

  // A real held mouse gesture keeps page and file-menu keyboard activation from
  // switching ownership. No synthetic session mutation bypasses that UI fence.
  const start = await nodePoint(f.first.id), beforeBoundary = await stored()
  await p.mouse.move(start.x, start.y); await p.mouse.down(); await p.mouse.move(start.x + 25, start.y + 10)
  await p.getByRole('button', { name: '02 第二页', exact: true }).focus()
  await p.keyboard.press('Enter')
  await expect(p.locator('.page.active')).toContainText('第一页')
  await p.locator('.brand').focus(); await p.keyboard.press('Enter')
  await expect(p.locator('.file-menu')).toHaveCount(0)
  await canvas.focus(); await p.keyboard.press('Escape'); await p.mouse.up()
  await settle(); await unmodified(jitterRecord)
  expect((await stored()).nodes).toEqual(beforeBoundary.nodes)
  await p.getByRole('button', { name: '02 第二页', exact: true }).click()
  await expect(p.locator('.page.active')).toContainText('第二页')
  await p.getByRole('button', { name: '01 第一页', exact: true }).click()
  await settle(); await selection()
  await screenshot('08-drag-page-menu-ownership')
  passed('Held drag rejects keyboard activation of another page and the file menu; Escape cancels without history; after release page navigation works', { documentSwitchScope: 'Public file-menu entry is blocked during the gesture; no forced editor.load injection is counted as GUI coverage' })

  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', scope, sourceHashes, checks, errors, output }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  failure = error
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', scope, sourceHashes, checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); throw error
} finally {
  await writeFile(join(output, 'vite.log'), log)
  console.log(`ACCEPTANCE_COUNTS ${JSON.stringify(acceptanceCounts('check-canvas-selection', checks, failure, !!entry))}`)
  await browser?.close(); await stopOwnedProcess(server)
}
