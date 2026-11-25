import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { closeTestElectron, createTestScratch } from '../../../scripts/lib/test-scratch.mjs'
import { assertNativeZoomFrame } from './lib/high-zoom-contract.mjs'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/check-real-canvas-regression.mjs --fixture=/absolute/design.fig [--application=/absolute/desktop] [--output=/new/directory] [--layer=exact-root-name] [--material=exact-source-material-name] [--open-only]')
  process.exit(0)
}
for (const arg of args) assert.match(arg, /^(?:--open-only|--(?:fixture|application|output|layer|material)=.+)$/)
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixture = option('fixture'), application = option('application') ?? desktop
const requestedOutput = option('output')
const openOnly = args.includes('--open-only')
assert.ok(fixture && path.isAbsolute(fixture) && /\.(fig|sketch)$/i.test(fixture), 'Supply a real, absolute .fig or .sketch file')
assert.ok(path.isAbsolute(application) && (!requestedOutput || path.isAbsolute(requestedOutput)))
const { _electron, expect } = createRequire(path.join(application, '../design-client/package.json'))('@playwright/test')
const electron = createRequire(path.join(application, 'package.json'))('electron')
const scratch = await createTestScratch('canvas-real-')
const output = requestedOutput ?? scratch.root
if (requestedOutput) await mkdir(output, { mode: 0o700 })
const hash = async filename => {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filename)) digest.update(chunk)
  return digest.digest('hex')
}
const result = { status: 'running', fixture: path.basename(fixture), steps: [], pageErrors: [] }
const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
const record = async (name, details = {}) => {
  result.steps.push({ name, ...details })
  await save()
  console.log(JSON.stringify({ name, ...details }))
}
let app, page, canvas, child, stage = 'startup'
try {
  const input = await stat(fixture)
  result.input = { bytes: input.size, sha256: await hash(fixture) }
  const build = path.join(application, 'dist')
  const assets = path.join(build, 'renderer/assets')
  const worker = (await readdir(assets)).find(file => /^render-worker-.*\.js$/.test(file))
  assert.ok(worker, 'The production render worker is missing')
  result.build = { manifest: await hash(path.join(build, 'build-manifest.json')),
    wasm: await hash(path.join(build, 'renderer/kernel/design_kernel_bg.wasm')),
    worker: await hash(path.join(assets, worker)),
    prepare: await hash(path.join(build, `bin/design-prepare${process.platform === 'win32' ? '.exe' : ''}`)),
    sidecar: await hash(path.join(build, `sidecar/futureox-design-desktop-backend${process.platform === 'win32' ? '.exe' : ''}`)) }
  const manifest = JSON.parse(await readFile(path.join(build, 'build-manifest.json'), 'utf8'))
  result.build.profile = manifest.profile
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CORE_|VITE_DESIGN_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
  app = await _electron.launch({ executablePath: electron, args: [application, '--desktop-isolated-profile'],
    cwd: application, env: scratch.environment(env), chromiumSandbox: true, timeout: 45000 })
  child = app.process()
  page = await app.firstWindow({ timeout: 45000 })
  page.on('pageerror', error => result.pageErrors.push(String(error)))
  result.window = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('design-app:'))
    window.setContentSize(1280, 820)
    window.setIgnoreMouseEvents(true)
    window.showInactive()
    window.webContents.setBackgroundThrottling(false)
    return { electron: process.versions.electron, size: window.getContentSize() }
  })
  await page.locator('.app-shell[data-editor-ready="true"]').waitFor({ timeout: 45000 })
  canvas = page.getByTestId('canvas')
  const shot = async name => {
    const bounds = await canvas.boundingBox()
    assert.ok(bounds?.width > 100 && bounds.height > 100, 'Missing visible canvas')
    const filename = path.join(output, `${name}.png`)
    await page.screenshot({ path: filename, clip: bounds, timeout: 45000 })
    return hash(filename)
  }
  const notice = page.getByRole('button', { name: '关闭导入提示', exact: true })
  const dismissNotice = async () => { if (await notice.isVisible()) await notice.click() }

  // Read the real Editor behind the canvas to check persisted geometry. All
  // actions below go through input, menus, layer rows or the property panel.
  const authored = id => canvas.evaluate((element, id) => {
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
    while (fiber && !fiber.memoizedProps?.editor) fiber = fiber.return
    const editor = fiber?.memoizedProps.editor
    if (!editor) throw Error('Canvas editor unavailable')
    const { doc, page, selection, version, busy } = editor.state
    const node = doc.nodes[id]
    const describe = node => ({ id: node.id, name: node.name, kind: node.kind, width: node.width,
      height: node.height, visible: node.visible, locked: node.locked, transform: node.transform })
    return { documentId: doc.id, name: doc.name, nodeCount: Object.keys(doc.nodes).length, pageCount: doc.pages.length,
      page, selection, version, busy, active: editor.interactionActive, view: editor.effectiveView(),
      node: node && describe(node), roots: id ? undefined : (doc.pages.find(item => item.id === page)?.children ?? []).map(id => describe(doc.nodes[id])) }
  }, id)
  const frame = () => page.evaluate(() => ({
    dpr: devicePixelRatio,
    status: [...document.querySelectorAll('.kernel-status')].map(node => node.textContent),
    tiles: [...document.querySelectorAll('.kernel-tiles')].map(node => ({ ...node.dataset })),
    presentation: [...document.querySelectorAll('.kernel-presentation')].map(node => ({ ...node.dataset })),
    compositor: [...document.querySelectorAll('.kernel-compositor')].map(node => ({ ...node.dataset })),
  }))
  const ready = async ({ zoom, afterRevision } = {}) => {
    const started = performance.now()
    let current, lastError
    do {
      current = await frame()
      try { assertNativeZoomFrame(current, { zoom, afterRevision }); lastError = undefined; break }
      catch (error) { lastError = error }
      if (current.status.some(message => /Error|超限|超过|失败/.test(message))) break
      await pause(125)
    } while (performance.now() - started < 60000)
    if (lastError) {
      result.lastFrame = current
      throw lastError
    }
    const tile = current.tiles.find(tile => tile.detailReady === 'true' && tile.renderer === 'webgpu')
    return { ms: Math.round(performance.now() - started), revision: Number(tile.revision), density: Number(tile.samplingScale), dpr: current.dpr }
  }
  const sourceStatus = () => page.evaluate(async () => {
    const value = await window.coreDesktop.largeDocument.status()
    return value?.status === 'ok' ? { revision: value.revision, format: value.format, nodes: value.indexedObjects,
      expandedBytes: value.expandedBytes, undoCount: value.undoCount, redoCount: value.redoCount } : null
  })
  const material = option('material')
  const sourceRow = () => page.locator('.source-page-entry').filter({ has: page.getByText(material, { exact: true }) }).first()
  const openMaterial = async () => {
    await expect(sourceRow()).toBeEnabled({ timeout: 120000 })
    await sourceRow().dblclick()
    await expect(page.locator('.source-board-navigation')).toHaveAttribute('data-has-canvas', 'true', { timeout: 120000 })
  }

  stage = 'open'
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  if (material) {
    await expect(sourceRow()).toBeEnabled({ timeout: 120000 })
    await expect.poll(async () => (await sourceStatus())?.format, { timeout: 120000 }).toBe('sketch')
    await record('source-opened', { source: await sourceStatus(), pixelHash: await shot('source-opened') })
    await openMaterial()
  } else {
    await page.waitForFunction(() => !document.querySelector('.local-home') || document.querySelector('.local-home-error')?.textContent, null, { timeout: 90000 })
    const error = await page.locator('.local-home-error').allTextContents()
    assert.deepEqual(error, [], 'The production importer rejected the original file')
  }
  await dismissNotice()
  if (openOnly) {
    const opened = await authored()
    assert.ok(opened.nodeCount > 0 && opened.pageCount > 0, 'The importer did not publish a document')
    await record('open', { nodes: opened.nodeCount, pages: opened.pageCount, ...await ready(), pixelHash: await shot('open') })
  } else {
    const candidates = () => authored().then(state => state.roots.filter(node => node.visible !== false && !node.locked && node.width > 25 && node.height > 25))
    await expect.poll(async () => (await candidates()).length, { timeout: 120000 }).toBeGreaterThan(0)
    const roots = await candidates()
    const layerName = option('layer')
    const target = layerName ? roots.find(node => node.name === layerName) : roots.find(node => node.kind === 'frame') ?? roots[0]
    assert.ok(target, `Editable layer ${layerName} was not found`)
    const layer = page.getByTestId(`layer-${target.id}`)
    const state = () => authored(target.id)
    const start = await state()
    const canvasReady = await ready()
    await record('open', { nodes: start.nodeCount, pages: start.pageCount, layer: target.name,
      ...canvasReady, pixelHash: await shot('open') })

    stage = 'zoom and pan'
    const zoomMenu = page.getByLabel('缩放与视图设置')
    const zoomField = page.getByRole('spinbutton', { name: '缩放比例', exact: true })
    const zoomTo = async percent => {
      if (!await zoomField.isVisible()) await zoomMenu.click()
      await zoomField.fill(String(percent)); await zoomField.press('Enter')
      if (await zoomField.isVisible()) await zoomMenu.click()
    }
    const key = async chord => { await canvas.focus(); await page.keyboard.press(chord) }
    const fit = async () => { await zoomMenu.click(); await page.getByRole('button', { name: /适合选择/ }).click() }
    await layer.click()
    await fit()
    await ready()
    const fitted = (await state()).view
    await zoomTo(3200)
    await record('zoom-3200', { ...await ready({ zoom: 32 }), pixelHash: await shot('zoom-3200') })
    await zoomTo(100)
    await record('zoom-return', { ...await ready({ zoom: 1 }), pixelHash: await shot('zoom-return') })
    const bounds = await canvas.boundingBox()
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await page.mouse.move(center.x, center.y)
    await page.keyboard.down('Control')
    try {
      for (const delta of [-300, -300, -300, 300, 300, 300]) await page.mouse.wheel(0, delta)
    } finally { await page.keyboard.up('Control') }
    await zoomTo(3200)
    await pause(120)
    await zoomTo(100)
    const beforePan = (await state()).view
    await canvas.focus(); await page.keyboard.down('Space')
    try {
      await page.mouse.move(center.x, center.y); await page.mouse.down()
      await page.mouse.move(center.x + 64, center.y - 42, { steps: 8 }); await page.mouse.up()
      await expect.poll(async () => (await state()).view.x).not.toBe(beforePan.x)
      await page.mouse.move(center.x + 64, center.y - 42); await page.mouse.down()
      await page.mouse.move(center.x, center.y, { steps: 8 }); await page.mouse.up()
    } finally { await page.keyboard.up('Space') }
    await expect.poll(async () => (await state()).view).toEqual(beforePan)
    await record('reverse-wheel-and-pan', { ...await ready({ zoom: 1 }), pixelHash: await shot('reverse-wheel-and-pan') })
    await fit()
    const editZoom = Math.max(2, Math.floor((await state()).view.zoom * 80))
    await zoomTo(editZoom)
    await dismissNotice()
    const editFrame = await ready({ zoom: editZoom / 100 })
    const outline = page.getByTestId('canvas-selection-outline')
    const geometry = () => outline.evaluate(element => [...element.points].map(point => {
      const screen = new DOMPoint(point.x, point.y).matrixTransform(element.getScreenCTM())
      return { x: screen.x, y: screen.y }
    }))
    const midpoint = points => ({ x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length })
    const withinCanvas = point => point.x >= bounds.x + 6 && point.x <= bounds.x + bounds.width - 6 &&
      point.y >= bounds.y + 6 && point.y <= bounds.y + bounds.height - 6
    const handle = async (kind, index) => page.getByTestId(`${kind}-${index}`).evaluate(element => {
      const mean = axis => (Number(element.getAttribute(`${axis}1`)) + Number(element.getAttribute(`${axis}2`))) / 2
      const local = element.dataset.anchorX ? new DOMPoint(Number(element.dataset.anchorX), Number(element.dataset.anchorY)) : new DOMPoint(mean('x'), mean('y'))
      const point = local.matrixTransform(element.getScreenCTM())
      return { x: point.x, y: point.y }
    })
    const node = async () => (await state()).node
    const original = await node()
    let previousFrame = editFrame
    const settleEdit = async (name, before, changed) => {
      await expect.poll(async () => changed(await node(), before), { timeout: 30000 }).toBe(true)
      const after = await node()
      previousFrame = await ready({ afterRevision: previousFrame.revision })
      await record(name, { ...previousFrame, geometry: { transform: after.transform, width: after.width, height: after.height },
        pixelHash: await shot(name) })
      return after
    }
    const drag = async (from, to, heldName) => {
      assert.ok(withinCanvas(from) && withinCanvas(to), `Gesture leaves canvas: ${JSON.stringify({ from, to })}`)
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      let heldHash
      if (heldName) {
        await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 })
        heldHash = await shot(`${heldName}-held`)
      }
      await page.mouse.move(to.x, to.y, { steps: 12 })
      await page.mouse.up()
      return heldHash
    }
    const movePoint = async () => {
      const title = page.locator(`[data-frame-title="${target.id}"]`)
      if (await title.count() === 1) {
        const hit = await title.evaluate(element => {
          const rect = element.getBoundingClientRect()
          for (const dy of [0.45, 0.12, 0.8]) {
            for (const dx of [0.8, 0.5, 0.95, 0.15]) {
              const x = rect.x + dx * rect.width, y = rect.y + dy * rect.height
              if (document.elementFromPoint(x, y) === element) return { x, y }
            }
          }
          return null
        })
        if (hit && withinCanvas(hit)) return hit
      }
      return midpoint(await geometry())
    }
    stage = 'move'
    const move = async (name, before, delta) => {
      assert.deepEqual((await state()).selection, [target.id], 'The moving layer is not selected')
      const outlineCenter = midpoint(await geometry())
      const from = await movePoint()
      const to = { x: from.x + delta.x, y: from.y + delta.y }
      const heldHash = await drag(from, to, name)
      result.steps.push({ name: `${name}-held`, pixelHash: heldHash })
      const after = await settleEdit(name, before, (a, b) => Math.hypot(a.transform[4] - b.transform[4], a.transform[5] - b.transform[5]) > 5)
      const current = midpoint(await geometry()), scale = (await state()).view.zoom
      assert.ok(Math.abs(current.x - outlineCenter.x - (after.transform[4] - before.transform[4]) * scale) <= 2 &&
        Math.abs(current.y - outlineCenter.y - (after.transform[5] - before.transform[5]) * scale) <= 2,
      'Selection outline did not follow the committed move')
      return after
    }
    const moved = await move('move', original, { x: 32, y: 19 })

    stage = 'rotate and resize'
    const rotate = async (name, before, radians) => {
      const origin = midpoint(await geometry())
      const from = await handle('rotate-corner', 1)
      const dx = from.x - origin.x, dy = from.y - origin.y
      const to = { x: origin.x + dx * Math.cos(radians) - dy * Math.sin(radians),
        y: origin.y + dx * Math.sin(radians) + dy * Math.cos(radians) }
      const heldHash = await drag(from, to, name)
      result.steps.push({ name: `${name}-held`, pixelHash: heldHash })
      const angle = transform => Math.atan2(transform[1], transform[0])
      return settleEdit(name, before, (a, b) => {
        const change = angle(a.transform) - angle(b.transform)
        return Math.abs(Math.atan2(Math.sin(change - radians), Math.cos(change - radians))) < 0.12
      })
    }
    const rotated = await rotate('rotate', moved, 0.16)
    const reversed = await rotate('rotate-back', rotated, -0.16)
    const edge = await handle('resize-edge', 1)
    const resizeHeld = await drag(edge, { x: edge.x + 23, y: edge.y }, 'resize')
    result.steps.push({ name: 'resize-held', pixelHash: resizeHeld })
    const resized = await settleEdit('resize', reversed, (a, b) => a.width > b.width + 2)
    const movedAgain = await move('move-after-resize', resized, { x: -16, y: 12 })

    stage = 'inspector, history and cancel'
    const x = page.getByLabel('X', { exact: true })
    const property = async increment => {
      const value = Number(await x.inputValue())
      assert.ok(Number.isFinite(value), 'Invalid X inspector value')
      await x.fill(String(value + increment)); await x.press('Enter')
    }
    await property(8)
    const edited = await settleEdit('property-edit', movedAgain, (a, b) => Math.abs(a.transform[4] - b.transform[4] - 8) < 1)
    await key('Meta+z')
    await settleEdit('undo', edited, a => a.transform.every((value, index) => Math.abs(value - movedAgain.transform[index]) < 1e-7))
    await key('Meta+Shift+z')
    await settleEdit('redo', movedAgain, a => a.transform.every((value, index) => Math.abs(value - edited.transform[index]) < 1e-7))
    await property(-5)
    const last = await settleEdit('edit-after-redo', edited, (a, b) => Math.abs(a.transform[4] - b.transform[4] + 5) < 1)
    const cancelledAt = (await state()).version
    const from = await movePoint()
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    await page.mouse.move(from.x + 24, from.y - 15, { steps: 8 })
    assert.ok((await state()).active, 'The cancelled drag never started')
    await page.keyboard.press('Escape'); await page.mouse.up()
    await expect.poll(async () => (await state()).active).toBe(false)
    assert.deepEqual(await node(), last)
    assert.equal((await state()).version, cancelledAt)
    await record('cancel', { ...await ready(), pixelHash: await shot('cancel') })

    stage = 'durable save'
    if (material) {
      await expect(page.locator('.save-status-label')).toHaveText('已自动保存到工作副本', { timeout: 45000 })
      await expect.poll(async () => (await sourceStatus())?.revision ?? 0, { timeout: 30000 }).toBeGreaterThan(0)
      const saved = await sourceStatus()
      await page.getByRole('button', { name: '返回完整画板', exact: true }).click()
      await expect(page.getByRole('button', { name: '返回完整画板', exact: true })).toHaveCount(0)
      await openMaterial()
      await expect.poll(async () => {
        const current = await node()
        return current && Math.abs(current.width - last.width) < 1e-5 && Math.abs(current.height - last.height) < 1e-5 &&
          current.transform.every((value, index) => Math.abs(value - last.transform[index]) < 1e-5)
      }, { timeout: 45000 }).toBe(true)
      await record('source-autosave-reopen', { source: saved, ...await ready(), pixelHash: await shot('source-autosave-reopen') })
    } else {
      // The native desktop serializes file operations. Check autosave first
      // so this read cannot acquire its operation slot ahead of the writer.
      await expect(page.locator('.save-status-label')).toHaveText('已自动保存到工作副本', { timeout: 45000 })
      const reopen = () => page.evaluate(async ({ documentId, nodeId }) => {
        const list = await window.coreDesktop.workspace.list()
        const entry = list.documents?.find(document => document.id === documentId)
        if (!entry) return null
        const opened = await window.coreDesktop.workspace.open({ id: entry.id })
        if (opened.status !== 'ok') return null
        const saved = JSON.parse(opened.documentJson).nodes[nodeId]
        return saved && { transform: saved.transform, width: saved.width, height: saved.height }
      }, { documentId: start.documentId, nodeId: target.id })
      await expect.poll(reopen, { timeout: 30000 }).toEqual({ transform: last.transform, width: last.width, height: last.height })
      await record('sqlite-autosave-reopen')
      if (start.pageCount > 1) {
        const toggle = page.locator('.pages-current')
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
        await page.locator('.pages .page:not([aria-current="page"])').first().click()
        const changed = await state()
        assert.notEqual(changed.page, start.page, 'The requested page did not open')
        await expect(outline).toHaveCount(0)
        await page.locator(`[data-layer-drop-page="${start.page}"] .page`).click()
        await expect.poll(async () => (await state()).page).toBe(start.page)
        await layer.click()
        await expect.poll(async () => (await state()).selection).toEqual([target.id])
        await record('page-roundtrip', { ...await ready(), pixelHash: await shot('page-roundtrip') })
      }
    }
    result.fitted = fitted
  }
  assert.equal(await hash(fixture), result.input.sha256, 'Original design file was modified')
  assert.deepEqual(result.pageErrors, [])
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = { stage, message: String(error) }
  console.error(JSON.stringify(result.error))
  if (page) {
    result.visibleError = await page.locator('[role="alert"]').allTextContents().catch(() => [])
    result.saveStatus = await page.locator('.save-status').getAttribute('title', { timeout: 1000 }).catch(() => null)
    result.diagnostic = await canvas?.evaluate(element => {
      let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))]
      while (fiber && !fiber.memoizedProps?.editor) fiber = fiber.return
      const editor = fiber?.memoizedProps.editor, state = editor?.state
      return state && { selection: state.selection, tool: state.tool, active: editor.interactionActive,
        busy: state.busy, view: editor.effectiveView() }
    }, undefined, { timeout: 2000 }).catch(() => null)
    await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  try { await save() }
  finally { await closeTestElectron(scratch, app, child) }
}
