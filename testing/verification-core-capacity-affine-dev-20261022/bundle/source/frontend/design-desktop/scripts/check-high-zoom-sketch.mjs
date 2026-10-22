// Real Electron/WebGPU acceptance. Private fixtures and screenshots stay in
// the caller's output directory; the normal desktop profile is never opened.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNativeZoomFrame, zoomReplayTargets } from './lib/high-zoom-contract.mjs'

const requireClient = createRequire(new URL('../../design-client/package.json', import.meta.url))
const desktop = fileURLToPath(new URL('..', import.meta.url))
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const zoomReplay = process.argv.includes('--zoom-replay')
const editAfterZoom = process.argv.includes('--edit-after-zoom')
if (process.argv.includes('--help')) {
  console.log('node scripts/check-high-zoom-sketch.mjs --fixture=/absolute/file.sketch [--output=/absolute/directory] [--application=/absolute/app] [--layer-name=exact-layer-name] [--zoom-replay] [--edit-after-zoom] [--measure-motion] [--motion-only]')
  console.log('--zoom-replay checks 32→1/2/3/4/5 readiness; --edit-after-zoom additionally requires --layer-name and checks X edit + undo at each low zoom. DOM publication and screenshots are not an independent pixel oracle.')
  process.exit(0)
}
assert.ok(!editAfterZoom || (zoomReplay && option('layer-name')), '--edit-after-zoom requires --zoom-replay and --layer-name')
assert.ok(!process.argv.includes('--motion-only') || (process.argv.includes('--measure-motion') && !zoomReplay && !editAfterZoom), '--motion-only requires --measure-motion and cannot skip requested zoom/edit replay')
const fixture = option('fixture')
assert.ok(fixture && path.isAbsolute(fixture), '--fixture requires an absolute .sketch path')
const output = option('output') || await mkdtemp(path.join(tmpdir(), 'futureox-high-zoom-'))
await mkdir(output, { recursive: true })
const application = option('application') || desktop
const { _electron } = requireClient('playwright')
const app = await _electron.launch({
  executablePath: path.join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [application, '--desktop-isolated-profile'], chromiumSandbox: true, timeout: 30000,
})
const report = { status: 'running', scope: 'Real Electron input and published renderer readiness contracts; screenshots retained for separate pixel review', pixelAcceptance: 'not-run', overallVisualAcceptance: 'incomplete-without-independent-pixel-oracle', profile: { zoomReplay, editAfterZoom }, fixture: path.basename(fixture), steps: [], errors: [] }
const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2))
try {
  const page = await app.firstWindow({ timeout: 20000 })
  page.on('pageerror', error => report.errors.push(String(error)))
  await page.locator('.app-shell[data-editor-ready="true"]').waitFor({ timeout: 45000 })
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  const name = path.basename(fixture).replace(/\.sketch$/i, '')
  await page.waitForFunction(name => document.querySelector('input[aria-label="文档名称"]')?.value === name,
    name, { timeout: 45000 })
  const compatibility = page.getByRole('button', { name: '关闭导入提示' })
  if (await compatibility.count()) await compatibility.click()
  const state = () => page.evaluate(() => ({
    dpr: devicePixelRatio,
    status: [...document.querySelectorAll('.kernel-status')].map(node => node.textContent),
    tiles: [...document.querySelectorAll('.kernel-tiles')].map(node => ({ ...node.dataset })),
    presentation: [...document.querySelectorAll('.kernel-presentation')].map(node => ({ ...node.dataset })),
    compositor: [...document.querySelectorAll('.kernel-compositor')].map(node => ({ ...node.dataset })),
  }))
  const settle = async (label, zoom, afterRevision) => {
    const started = Date.now()
    let current
    do {
      current = await state()
      if (current.status.some(text => /Error|超限|超过|失败/.test(text))) break
      try { assertNativeZoomFrame(current, { zoom, afterRevision }); break } catch { /* Wait, then fail with the same contract below. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() - started < 60000)
    const step = { label, milliseconds: Date.now() - started, state: current }
    report.steps.push(step)
    await page.screenshot({ path: path.join(output, `${label}.png`) })
    await save()
    assertNativeZoomFrame(current, { zoom, afterRevision })
    console.log(JSON.stringify({ label, milliseconds: step.milliseconds, status: current.status }))
    return current
  }
  await settle('initial')
  if (option('layer-name')) {
    const layer = option('layer-name')
    await page.getByRole('textbox', { name: '搜索图层', exact: true }).fill(layer)
    await page.getByRole('treeitem', { name: layer, exact: true }).first().click()
    await page.getByLabel('缩放与视图设置').click()
    await page.getByRole('button', { name: '适合选择　⇧2', exact: true }).click()
    await settle('selection-fit')
  }
  if (process.argv.includes('--measure-motion')) {
    await page.evaluate(() => {
      window.__zoomTrace = []; window.__zoomRecording = true
      let previous = performance.now()
      const tick = now => {
        if (!window.__zoomRecording) return
        const tile = document.querySelector('.kernel-tiles'), frame = document.querySelector('.kernel-presentation')
        window.__zoomTrace.push({ milliseconds: now - previous, zoom: Number(tile?.dataset.requestedCameraZoom),
          cameraLag: Math.abs(Number(frame?.dataset.requestedCameraX) - Number(frame?.dataset.visualCameraX)) })
        previous = now; requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    const box = await page.getByTestId('canvas').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.keyboard.down('Control')
    const initial = Number((await state()).tiles[0].requestedCameraZoom)
    const delta = -Math.log(32 / initial) / .003 / 60
    for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, delta); await new Promise(resolve => setTimeout(resolve, 16)) }
    // Cross the upper bound so a floating accumulation cannot stop one ulp
    // below the exact 32x camera while the UI already rounds to "3200%".
    await page.mouse.wheel(0, -1)
    await page.keyboard.up('Control')
    const trace = await page.evaluate(() => { window.__zoomRecording = false; return window.__zoomTrace })
    const times = trace.map(frame => frame.milliseconds).sort((a, b) => a - b)
    report.motion = { kind: 'main-thread-rAF-during-real-wheel-input', frames: times.length,
      p50: times[Math.floor(times.length * .5)], p95: times[Math.floor(times.length * .95)],
      max: times.at(-1), over33ms: times.filter(value => value > 33.5).length, trace }
    console.log(JSON.stringify({ motion: { ...report.motion, trace: undefined } }))
    if (process.argv.includes('--motion-only')) { report.status = 'diagnostic-only'; await save(); }
    else await settle('motion-settled-3200', 32)
  }
  if (!process.argv.includes('--motion-only')) {
    const renderedRevision = snapshot => Math.max(...snapshot.tiles.filter(tile => tile.detailReady === 'true' && tile.previewActive === 'false' && tile.renderer === 'webgpu').map(tile => Number(tile.revision)))
    const editAndUndo = async (zoom, before) => {
      const x = page.getByLabel('X', { exact: true })
      assert.equal(await x.count(), 1, 'Select one editable layer with a unique X inspector before replay')
      const oldX = Number(await x.inputValue())
      assert.ok(Number.isFinite(oldX), 'Selected layer X is not numeric')
      const nextX = oldX + 1
      assert.notEqual(nextX, oldX, 'Selected layer X cannot represent a unit edit')
      await x.fill(String(nextX)); await x.press('Enter')
      await page.waitForFunction(value => Number(document.querySelector('input[aria-label="X"]')?.value) === value, nextX, { timeout: 15000 })
      const edited = await settle(`edit-after-zoom-${zoom}`, zoom, renderedRevision(before))
      assert.equal(Number(await x.inputValue()), nextX, 'Inspector edit was lost after rendering')
      await page.getByTestId('canvas').focus(); await page.keyboard.press('Meta+z')
      await page.waitForFunction(value => Number(document.querySelector('input[aria-label="X"]')?.value) === value, oldX, { timeout: 15000 })
      await settle(`undo-after-zoom-${zoom}`, zoom, renderedRevision(edited))
      assert.equal(Number(await x.inputValue()), oldX, 'Undo did not restore the edited value')
    }
    const targets = zoomReplayTargets(zoomReplay)
    for (const [index, zoom] of targets.entries()) {
      const percent = zoom * 100
      await page.getByLabel('缩放与视图设置').click()
      const field = page.getByRole('spinbutton', { name: '缩放比例', exact: true })
      await field.fill(String(percent)); await field.press('Enter')
      await page.getByLabel('缩放与视图设置').click()
      const settled = await settle(`zoom-${percent}${zoomReplay ? `-step-${index}` : ''}`, zoom)
      if (editAfterZoom && zoom <= 5) await editAndUndo(zoom, settled)
    }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.status = process.argv.includes('--motion-only') ? 'diagnostic-only' : 'readiness-contracts-passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
  console.error(error)
} finally {
  await save(); console.log(`HIGH_ZOOM_REPORT ${output}`)
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
