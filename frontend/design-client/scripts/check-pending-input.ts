/** Private CPU browser + real WASM. Only render dispatch is held by the test;
 * input events, geometry, persistence and returned pixels are never replaced. */
import { chromium, expect, type Page } from '@playwright/test'
import { createServer, type Plugin } from 'vite'
import { cp, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { blank, node, uid, defaultLayout, type DesignDocument } from '../src/model'
import { acceptanceCounts, enterOwnedEditor, freezeAcceptanceSnapshot, installGuiLayoutPreference, type OwnedWorkspace } from './gui-acceptance-entry.ts'

const project = resolve(import.meta.dir, '..'), output = await realpath(await mkdtemp(join(tmpdir(), 'forma-pending-input-')))
const frozen = await freezeAcceptanceSnapshot(project, output), root = frozen.clientRoot
const baseline = process.env.DESIGN_INPUT_BASELINE
const reviewCase = process.env.DESIGN_INPUT_REVIEW_CASE
const sourceOverride = process.env.DESIGN_INPUT_SOURCE_DIR
if (baseline) for (const name of ['Canvas.tsx', 'engine.ts']) {
  await writeFile(join(root, 'src', name), execFileSync('git', ['show', `${baseline}:frontend/design-client/src/${name}`], { cwd: project }))
}
if (sourceOverride) for (const name of ['Canvas.tsx', 'engine.ts'])
  await cp(join(sourceOverride, name), join(root, 'src', name))
const hashes = Object.fromEntries(await Promise.all(['Canvas.tsx', 'engine.ts', 'canvas-published-input.ts', 'kernel/Surface.tsx', 'kernel/client.ts'].map(async name =>
  [name, createHash('sha256').update(await readFile(join(root, 'src', name))).digest('hex')])) )
Object.assign(hashes, frozen.dependencyHashes)
await writeFile(join(output, 'source-hashes.json'), JSON.stringify(hashes, null, 2))
const wrapper = `
const __realInputRender = KernelClient.prototype.render;
KernelClient.prototype.render = async function(...args) {
  const probe = window.__inputProbe;
  if (probe?.enabled && !args[2]) {
    probe.held++;
    await new Promise(resolve => probe.gates.push(resolve));
  }
  return __realInputRender.apply(this,args);
};`
const injection: Plugin = { name: 'private-render-dispatch-gate', enforce: 'pre', transform(source, id) {
  if (id.split('?')[0] === join(root, 'src/kernel/client.ts')) return source + wrapper
} }
const server = await createServer({ root, cacheDir: join(root, '.vite-cache'), plugins: [injection], server: { host: '127.0.0.1', port: 0, strictPort: true } })
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined, page: Page | undefined
let entry: OwnedWorkspace | undefined, failure: unknown
const checks: unknown[] = [], errors: string[] = []
const passed = (name: string, data?: unknown) => { checks.push({ name, data }); console.log(`PENDING_INPUT ${name}`) }
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-gpu'] })
  page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
  const p = page, canvas = p.getByTestId('canvas'), presentation = p.locator('.kernel-presentation')
  await p.addInitScript(() => {
    localStorage.setItem('forma-render-backend', 'cpu')
    ;(window as any).__inputProbe = { enabled: false, held: 0, gates: [] as (() => void)[],
      release() { this.enabled = false; for (const release of this.gates.splice(0)) release() } }
  })
  p.on('pageerror', error => errors.push(String(error)))
  await installGuiLayoutPreference(p)
  await p.goto(server.resolvedUrls!.local[0])
  const stored = () => p.evaluate(async () => { const { localOpen } = await import('/src/local-store.ts'); return (await localOpen())! })
  const doc = async () => (await stored()).document as DesignDocument
  const settle = async () => {
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'true', { timeout: 30000 })
    await expect(p.locator('canvas[data-frame-visible=true]')).toHaveAttribute('data-renderer', 'cpu')
  }
  const release = async () => { await p.evaluate(() => (window as any).__inputProbe.release()); await settle() }
  const camera = () => presentation.evaluate(el => ({ x: +el.getAttribute('data-camera-x')!, y: +el.getAttribute('data-camera-y')!, zoom: +el.getAttribute('data-camera-zoom')! }))
  const pixelHash = () => p.locator('canvas[data-frame-visible=true]').evaluate(c => (c as HTMLCanvasElement).toDataURL())
  const point = async (x: number, y: number) => { const b = (await canvas.boundingBox())!; return { x: b.x + x, y: b.y + y } }
  const worldPoint = async (x: number, y: number) => { const b = (await canvas.boundingBox())!, v = await camera(); return { x: b.x + v.x + x * v.zoom, y: b.y + v.y + y * v.zoom } }
  const key = async (key: string) => { await canvas.focus(); await p.keyboard.press(key) }
  const gesture = async (from: { x: number; y: number }, to: { x: number; y: number }, cancel = false) => {
    await p.mouse.move(from.x, from.y); await p.mouse.down(); await p.mouse.move(to.x, to.y, { steps: 6 })
    if (cancel) await p.keyboard.press('Escape')
    await p.mouse.up()
  }
  let sequence = 0, holdSequence = 0
  const fresh = async (document = blank('Pending input')) => {
    await release()
    document.name = `Pending input ${++sequence}`
    const file = join(output, `${sequence}.fd`); await writeFile(file, JSON.stringify(document))
    await p.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
    await expect(p.getByLabel('文档名称')).toHaveValue(document.name)
    await expect.poll(async () => (await doc()).name).toBe(document.name)
    await settle(); return await doc()
  }
  const holdAfterRename = async () => {
    const pixels = await pixelHash()
    await p.evaluate(() => { const probe = (window as any).__inputProbe; probe.enabled = true; probe.held = 0 })
    await p.getByLabel('文档名称').fill(`Pending input held ${sequence}-${++holdSequence}`); await p.getByLabel('文档名称').press('Enter')
    await expect.poll(() => p.evaluate(() => (window as any).__inputProbe.held)).toBeGreaterThan(0)
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'false')
    return pixels
  }
  entry = await enterOwnedEditor(p, 'new', 'check-pending-input'); await settle()
  if (!reviewCase) {
  await fresh(); const oldPixels = await holdAfterRename(), view = await camera()
  const a = await point(100, 150), z = await point(200, 210)
  await key('o'); await expect(canvas).toHaveClass(/canvas-ellipse/); await gesture(a, z)
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(1)
  await key('r'); await gesture(await point(300, 170), await point(370, 240))
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(2)
  const created = Object.values((await doc()).nodes)
  expect(created.map(n => n.kind).sort()).toEqual(['ellipse', 'rectangle'])
  expect(created.find(n => n.kind === 'ellipse')!.width).toBeCloseTo(Math.round(100 / view.zoom), 6)
  expect(await pixelHash()).toBe(oldPixels)
  await p.screenshot({ path: join(output, '01-accepted-before-presentation.png') })
  await release(); await p.screenshot({ path: join(output, '02-two-exact-shapes.png') })
  passed('rename + two rapid creations persist before renderer completion; old exact pixels retained until release')

  const fixture = blank(), shape = node('rectangle', 100, 100, 100, 70), sibling = node('ellipse', 310, 100, 70, 70)
  fixture.nodes = { [shape.id]: shape, [sibling.id]: sibling }; fixture.pages[0].children = [shape.id, sibling.id]
  await fresh(fixture); const at = await worldPoint(150, 135); await holdAfterRename()
  await key('v'); await gesture(at, { x: at.x + 20, y: at.y })
  await expect.poll(async () => (await doc()).nodes[shape.id].transform[4]).toBe(120)
  // It is still painted at the original position. A second drag must hit that
  // visible shape, then apply its delta to the current authoritative geometry.
  await gesture(at, { x: at.x + 20, y: at.y })
  await expect.poll(async () => (await doc()).nodes[shape.id].transform[4]).toBe(140)
  expect((await doc()).nodes[sibling.id].transform).toEqual(sibling.transform)
  await key('Meta+z'); await expect.poll(async () => (await doc()).nodes[shape.id].transform[4]).toBe(120)
  await key('Meta+z'); await expect.poll(async () => (await doc()).nodes[shape.id].transform[4]).toBe(100)
  await release(); passed('two drags hit displayed geometry while applying to live IDs; one Undo per gesture')

  await fresh(fixture); const gone = await worldPoint(150, 135); await holdAfterRename()
  await p.getByTestId(`layer-${shape.id}`).click(); await key('Delete')
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(1)
  await p.mouse.click(gone.x, gone.y)
  await expect(p.locator('[role=treeitem][aria-selected=true]')).toHaveCount(0)
  await p.mouse.click(gone.x, gone.y, { button: 'right' })
  await expect(p.getByRole('menu')).toBeVisible(); await p.keyboard.press('Escape')
  expect(Object.keys((await doc()).nodes)).toEqual([sibling.id])
  await release(); passed('visible stale pixels cannot select or resurrect a deleted object; pending context menu still opens')

  await fresh(); const beforeCancel = await holdAfterRename()
  await key('o'); await gesture(await point(120, 170), await point(250, 260), true)
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(0)
  expect(await pixelHash()).toBe(beforeCancel)
  await release(); passed('Escape cancels a draft during a pending frame without saving geometry')

  await fresh(); const oldView = await camera(); await holdAfterRename()
  await p.getByLabel('缩放与视图设置').click(); await p.getByRole('button', { name: '200%', exact: true }).click()
  await expect(presentation).toHaveAttribute('data-requested-camera-zoom', '2')
  await p.getByLabel('缩放与视图设置').click()
  await key('o'); await gesture(await point(130, 160), await point(230, 240))
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(1)
  const geometry = Object.values((await doc()).nodes)[0]
  expect(geometry.width).toBeCloseTo(Math.round(100 / oldView.zoom), 6)
  expect(await camera()).toEqual(oldView)
  await release(); expect((await camera()).zoom).toBe(oldView.zoom)
  passed('pending zoom cannot remap an incoming creation away from the camera actually displayed')

  const twoPages = blank(); twoPages.pages.push({ ...twoPages.pages[0], id: uid(), name: 'Other page', children: [] })
  await fresh(twoPages); await holdAfterRename()
  await p.getByRole('button', { name: /Other page/ }).click(); await key('o')
  await gesture(await point(130, 160), await point(230, 240))
  expect(Object.keys((await doc()).nodes)).toHaveLength(0)
  await release(); await key('o'); await gesture(await point(130, 160), await point(230, 240))
  await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(1)
  const last = await doc(); expect(last.pages[0].children).toHaveLength(0); expect(last.pages[1].children).toHaveLength(1)
  await settle(); passed('old page presentation cannot accept edits into a newly selected page; ready new page accepts normally')
  }
  const setX = async (id: string, x: number) => {
    await p.getByTestId(`layer-${id}`).click()
    await p.getByLabel('X', { exact: true }).fill(String(x)); await p.getByLabel('X', { exact: true }).press('Enter')
    await expect.poll(async () => (await doc()).nodes[id].transform[4]).toBe(x)
  }
  if (!reviewCase || reviewCase === 'pen') {
    const vectorDoc = blank('Pending pen'), vector = node('vector', 100, 100, 100, 70)
    vector.network = { vertices: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 100, y: 70 }],
      edges: [{ id: 'ab', from: 'a', to: 'b' }], fillRule: 'evenodd' }
    vectorDoc.nodes = { [vector.id]: vector }; vectorDoc.pages[0].children = [vector.id]
    await fresh(vectorDoc)
    const oldEnd = await worldPoint(200, 170), oldCamera = await camera()
    await holdAfterRename(); await setX(vector.id, 140); await key('p')
    await gesture(oldEnd, { x: oldEnd.x, y: oldEnd.y + 20 * oldCamera.zoom })
    const addedAt = await worldPoint(340, 210); await p.mouse.click(addedAt.x, addedAt.y); await key('Enter')
    await expect.poll(async () => (await doc()).nodes[vector.id].network?.vertices.length).toBe(3)
    const network = (await doc()).nodes[vector.id].network!
    expect(network.vertices.find(v => v.id === 'b')).toEqual({ id: 'b', x: 100, y: 70 })
    const continuation = network.edges.find(edge => edge.id !== 'ab')!
    expect(continuation.from).toBe('b')
    expect(continuation.c1!.x).toBeCloseTo(100, 6); expect(continuation.c1!.y).toBeCloseTo(90, 6)
    expect((await doc()).nodes[vector.id].transform[4]).toBe(140)
    await release(); await p.screenshot({ path: join(output, '03-pen-stable-endpoint.png') })
    passed('pending translated vector: pen reuses visible endpoint ID and handle delta; one new vertex, exact live transform')
  }
  if (!reviewCase || reviewCase === 'layout') {
    const layoutDoc = blank('Pending layout'), frame = node('frame', 100, 100, 200, 100), left = node('rectangle', 0, 0, 50, 40), right = node('rectangle', 0, 0, 50, 40)
    frame.layout = { ...defaultLayout(), mode: 'horizontal', padding: [0, 0, 0, 0], gap: 10 }; frame.children = [left.id, right.id]
    layoutDoc.nodes = { [frame.id]: frame, [left.id]: left, [right.id]: right }; layoutDoc.pages[0].children = [frame.id]
    const laidOut = await fresh(layoutDoc), original = laidOut.nodes[right.id]
    const shown = await worldPoint(100 + original.transform[4] + original.width / 2, 100 + original.transform[5] + original.height / 2)
    await holdAfterRename(); await setX(frame.id, 500); await key('v')
    await p.keyboard.down('Meta'); await gesture(shown, { x: shown.x, y: shown.y + 4 }); await p.keyboard.up('Meta')
    await expect(p.getByTestId(`layer-${right.id}`)).toHaveAttribute('aria-selected', 'true')
    // Allow the existing autosave debounce to expose an erroneous reorder.
    await p.waitForTimeout(900)
    expect((await doc()).nodes[frame.id].children).toEqual([left.id, right.id])
    expect((await doc()).nodes[frame.id].transform[4]).toBe(500)
    await release(); passed('pending translated auto-layout parent: vertical child drag cannot reorder horizontal siblings')
  }
  if (!reviewCase || reviewCase === 'hover') {
    const hoverDoc = blank('Pending hover'), target = node('rectangle', 100, 100, 100, 70)
    hoverDoc.nodes = { [target.id]: target }; hoverDoc.pages[0].children = [target.id]
    await fresh(hoverDoc); const oldAt = await worldPoint(150, 135)
    await holdAfterRename(); await setX(target.id, 400); await key('Escape')
    await p.mouse.move(oldAt.x, oldAt.y)
    await expect(p.getByTestId(`layer-${target.id}`)).toHaveAttribute('data-hovered', 'true')
    await release()
    await expect(p.getByTestId(`layer-${target.id}`)).toHaveAttribute('data-hovered', 'false')
    await expect(p.getByTestId('canvas-hover-outline')).toHaveCount(0)
    await p.getByTestId(`layer-${target.id}`).hover()
    await expect(p.getByTestId(`layer-${target.id}`)).toHaveAttribute('data-hovered', 'true')
    await holdAfterRename(); await release()
    await expect(p.getByTestId(`layer-${target.id}`)).toHaveAttribute('data-hovered', 'true')
    passed('new frame clears stale canvas hover without clearing a stationary Layers hover')
  }
  if (!reviewCase || reviewCase === 'drop') {
    const dropDoc = blank('Pending drop'); dropDoc.pages.push({ ...dropDoc.pages[0], id: uid(), name: 'Drop destination', children: [] })
    await fresh(dropDoc); await holdAfterRename()
    await p.getByRole('button', { name: /Drop destination/ }).click()
    const dropAt = await point(150, 180)
    const imageDrop = async () => {
      // Synthetic DOM drop is explicit: Chromium automation cannot carry an OS
      // file drag. The real image decoder, Canvas drop handler and storage run.
      const transfer = await p.evaluateHandle(() => {
        const transfer = new DataTransfer(), bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='), c => c.charCodeAt(0))
        transfer.items.add(new File([bytes], 'pending-input.png', { type: 'image/png' })); return transfer
      })
      try { await canvas.dispatchEvent('drop', { dataTransfer: transfer, clientX: dropAt.x, clientY: dropAt.y }) }
      finally { await transfer.dispose() }
    }
    await imageDrop()
    // Negative assertion waits through image decode and the 600 ms autosave.
    await p.waitForTimeout(1200)
    expect(Object.keys((await doc()).nodes)).toHaveLength(0)
    await release(); await imageDrop()
    await expect.poll(async () => Object.keys((await doc()).nodes).length).toBe(1)
    const imported = await doc(); expect(imported.pages[0].children).toHaveLength(0); expect(imported.pages[1].children).toHaveLength(1)
    passed('pending page rejects image drop; ready destination accepts real image decode/save', 'Synthetic DOM drop only; actual File, decoder, production handler and storage.')
  }
  expect(errors).toEqual([])
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', baseline, reviewCase, sourceOverride, checks, errors, output, injection: 'Only CPU render dispatch is delayed; actual pixels, WASM and UI events unchanged' }, null, 2))
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, output }))
} catch (error) {
  failure = error
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', baseline, reviewCase, sourceOverride, checks, errors, error: String(error), output }, null, 2))
  console.error(JSON.stringify({ status: 'failed', error: String(error), output })); process.exitCode = 1
} finally {
  console.log(`ACCEPTANCE_COUNTS ${JSON.stringify(acceptanceCounts('check-pending-input', checks, failure, !!entry))}`)
  await browser?.close(); await server.close()
}
