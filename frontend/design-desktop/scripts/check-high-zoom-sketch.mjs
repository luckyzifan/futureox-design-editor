// Real Electron/WebGPU acceptance. Private fixtures and screenshots stay in
// the caller's output directory; the normal desktop profile is never opened.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const requireClient = createRequire(new URL('../../design-client/package.json', import.meta.url))
const { _electron } = requireClient('playwright')
const desktop = fileURLToPath(new URL('..', import.meta.url))
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixture = option('fixture')
assert.ok(fixture && path.isAbsolute(fixture), '--fixture requires an absolute .sketch path')
const output = option('output') || await mkdtemp(path.join(tmpdir(), 'futureox-high-zoom-'))
await mkdir(output, { recursive: true })
const application = option('application') || desktop
const app = await _electron.launch({
  executablePath: path.join(desktop, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  args: [application, '--desktop-isolated-profile'], chromiumSandbox: true, timeout: 30000,
})
const report = { status: 'running', fixture: path.basename(fixture), steps: [], errors: [] }
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
  const settle = async (label, zoom) => {
    const started = Date.now()
    let current
    do {
      current = await state()
      if (current.status.some(text => /Error|超限|超过|失败/.test(text))) break
      if (current.tiles.some(tile => tile.detailReady === 'true' &&
          (!zoom || Number(tile.requestedCameraZoom) === zoom)) &&
          current.presentation.some(frame => frame.presentationReady === 'true')) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() - started < 60000)
    const step = { label, milliseconds: Date.now() - started, state: current }
    report.steps.push(step)
    await page.screenshot({ path: path.join(output, `${label}.png`) })
    await save()
    assert.ok(current.status.every(text => !/Error|超限|超过|失败/.test(text)), current.status.join('; '))
    assert.ok(current.tiles.some(tile => tile.detailReady === 'true' && tile.previewActive === 'false' &&
      tile.renderer === 'webgpu' && Number(tile.samplingScale) >= Number(tile.requestedCameraZoom) * current.dpr * .999 &&
      (!zoom || Number(tile.requestedCameraZoom) === zoom)), 'Native-density WebGPU frame did not finish')
    assert.ok(current.compositor.every(canvas => Number(canvas.missingTextureCount || 0) === 0))
    console.log(JSON.stringify({ label, milliseconds: step.milliseconds, status: current.status }))
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
    if (process.argv.includes('--motion-only')) { report.status = 'passed'; await save(); }
    else await settle('motion-settled-3200', 32)
  }
  if (!process.argv.includes('--motion-only')) {
    for (const percent of [800, 3200]) {
      await page.getByLabel('缩放与视图设置').click()
      const field = page.getByRole('spinbutton', { name: '缩放比例', exact: true })
      await field.fill(String(percent)); await field.press('Enter')
      await page.getByLabel('缩放与视图设置').click()
      await settle(`zoom-${percent}`, percent / 100)
    }
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
  console.error(error)
} finally {
  await save(); console.log(`HIGH_ZOOM_REPORT ${output}`)
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
}
