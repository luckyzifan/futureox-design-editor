import {renderFailures} from './render-failures.mjs'
import { foreground } from './foreground.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { startProfiles, stopProfiles } from './profile-helpers.mjs'
const root = process.cwd(), out = path.join(root, 'testing/verification-drag-response-20261024')
const baseline = JSON.parse(await readFile(path.join(out, 'baseline.json'), 'utf8'))
const kind = process.argv[2], name = process.argv[3], host = process.env.FIG_HOST
const capture = process.env.CAPTURE_MOTION !== '0'
assert(host && ['fig', '117', 'sketch'].includes(kind))
const run = path.join(out, name), tmp = path.join(baseline.runtime, name), frames = path.join(tmp, 'frames')
await mkdir(run); await mkdir(tmp); await mkdir(frames)
const require = createRequire(path.join(root, 'frontend/design-client/package.json')), { _electron, expect } = require('@playwright/test')
const report = { status: 'running', kind, host, scope: 'owned visible Electron; native trusted wheel events; Chromium compositor PNG frames and per-submit quality trace; screenshot instrumentation, not physical scanout or sampler-off timing', frames: [] }
const persist = () => writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2))
let app, page, cdp, traceComplete, traceRunning=false, writes = []
async function settle() {
  await page.waitForTimeout(100)
  await page.waitForFunction(() => document.querySelector('.kernel-status.error') || document.querySelector('.kernel-tiles')?.dataset.detailReady === 'true', null, { timeout: 120000 })
  assert.deepEqual(await page.locator('.kernel-status.error').allTextContents(), [])
}
try {
  app = await _electron.launch({ executablePath: path.join(root, 'frontend/design-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    args: [host, '--desktop-isolated-profile'], cwd: host, env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(k))), TMPDIR: tmp, CORE_RENDER_DIAGNOSTICS: 'detail' }, timeout: 60000 })
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', data => { writes.push(appendFile(path.join(run, 'host.log'), data)) })
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  report.instance = await app.evaluate(({ app, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.show(); w.setTitle('独立运动清晰度验证'); return { pid: process.pid, profile: app.getPath('userData'), visible: w.isVisible() } })
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready', 'true', { timeout: 60000 })
  await page.evaluate(() => document.addEventListener('wheel', e => { e.preventDefault(); window.__calibration = e.deltaY }, { capture: true, passive: false, once: true }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: 1, modifiers: ['control'], hasPreciseScrollingDeltas: true, canScroll: true }))
  await page.waitForFunction(() => window.__calibration !== undefined)
  const sign = await page.evaluate(() => window.__calibration); assert.equal(Math.abs(sign), 1)
  const file = kind === 'fig' ? '/Users/Apple/Downloads/01有料素材 (Copy).fig' : kind === '117' ? '/Users/Apple/Downloads/117.sketch' : '/Users/Apple/Downloads/拓扑素材.sketch'
  report.fixture = file
  if (kind === 'sketch') {
    await page.getByRole('button', { name: '新建设计', exact: true }).click(); await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 60000 })
  }
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
  if (kind === 'sketch') {
    await expect(page.locator('.source-workspace-header strong')).toContainText(path.basename(file), { timeout: 120000 })
    await expect(page.locator('[aria-label="搜索源对象"]')).toBeEnabled({ timeout: 120000 })
    await page.locator('[aria-label="搜索源对象"]').fill('控件'); await page.getByRole('button', { name: '搜索', exact: true }).click()
    const item = page.locator('.source-workspace-rows > div').filter({ hasText: '完整页面' }); await expect(item).toHaveCount(1, { timeout: 30000 })
    report.sourceKey = await item.getAttribute('data-source-key'); await item.locator('button').first().click()
    await expect(page.locator('.source-workspace-status')).toContainText('已载入', { timeout: 120000 }); await settle()
    await page.locator('[aria-label="搜索图层"]').fill('数据名称')
    await page.getByTestId('layer-4F1BF005-CF98-4296-8A6B-9194F5146DAD').click()
  } else {
    await expect(page.locator('[aria-label="文档名称"]')).toHaveValue(kind === 'fig' ? '01有料素材 (Copy)' : '117', { timeout: 60000 })
    await settle(); await page.locator('[aria-label="搜索图层"]').fill(kind === 'fig' ? '01_Dashboard' : '117')
    await page.locator('.layer-name').filter({ hasText: kind === 'fig' ? /^01_Dashboard$/ : /^117$/ }).first().click()
  }
  await page.keyboard.press('Shift+2'); await settle()
  report.initial = await page.locator('.kernel-tiles').evaluate(e => ({ ...e.dataset })); assert.equal(report.initial.nativeVisibleTiles, 'false')
  await page.screenshot({ path: path.join(run, 'before.png') })
  cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', event => {
    const index = report.frames.length, file = path.join(frames, String(index).padStart(4, '0') + '.png')
    report.frames.push({ index, receivedAt: Date.now(), metadata: event.metadata, file })
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
    writes.push(writeFile(file, Buffer.from(event.data, 'base64')))
  })
  report.capture = capture
  if (capture) await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 })
  await page.evaluate(() => { window.__motionInputs = []; document.addEventListener('wheel', e => window.__motionInputs.push({ at: Date.now(), dy: e.deltaY, dx: e.deltaX, ctrl: e.ctrlKey, meta: e.metaKey, x: e.clientX, y: e.clientY, trusted: e.isTrusted }), true) })
  const box = await page.getByTestId('canvas').boundingBox()
  // Fixed 160-event reversal trace, independent of renderer completion.
  const deltas = [...Array(40).fill(-14), ...Array(40).fill(14), ...Array(40).fill(-10), ...Array(40).fill(10)]
  if(process.env.TRACE_MOTION==='1'){
    traceComplete=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve))
    report.traceConfig={recordMode:'recordUntilFull',traceBufferSizeInKb:32768,enableSampling:false,enableSystrace:false,includedCategories:['toplevel','input','latencyInfo','cc','gpu','viz','renderer.scheduler','blink']}
    await cdp.send('Tracing.start',{transferMode:'ReturnAsStream',streamFormat:'json',tracingBackend:'chrome',traceConfig:report.traceConfig});traceRunning=true
  }
  if (process.env.PROFILE_MOTION === '1') report.profiler = await startProfiles(app)
  report.foreground = await foreground(app,page); report.motionStart = Date.now(); await persist()
  report.dispatch = await app.evaluate(async ({ BrowserWindow }, { box, deltas, sign }) => {
    const w = BrowserWindow.getAllWindows()[0], start = performance.now(), times = []
    for (let i = 0; i < deltas.length; i++) {
      const delay = i * 16 - (performance.now() - start); if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      w.webContents.sendInputEvent({ type: 'mouseWheel', x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), deltaX: 0, deltaY: deltas[i] / sign,
        modifiers: ['control'], hasPreciseScrollingDeltas: true, canScroll: true }); times.push(performance.now() - start)
    }
    return times
  }, { box, deltas, sign })
  report.inputStopped = Date.now(); await settle(); report.motionEnd = Date.now()
  if (process.env.PROFILE_MOTION === '1') report.profileResult = await stopProfiles(app, run, host)
  if(traceRunning){
    await cdp.send('Tracing.end');traceRunning=false
    const result=await traceComplete;report.traceResult=result
    if(!result.stream)throw Error('Missing Chrome trace stream')
    const target=path.join(run,'chrome-trace.json');await writeFile(target,'')
    let bytes=0
    try{while(true){const chunk=await cdp.send('IO.read',{handle:result.stream,size:1024*1024}),data=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');bytes+=data.length;if(bytes>64*1024*1024)throw Error('Owned trace output exceeds diagnostic bound');await appendFile(target,data);if(chunk.eof)break}}finally{await cdp.send('IO.close',{handle:result.stream})}
    report.traceBytes=bytes
  }
  await page.waitForTimeout(1000); await cdp.send('Page.stopScreencast')
  report.foregroundEvents = await page.evaluate(()=>window.__ownedForegroundEvents); report.inputs = await page.evaluate(() => window.__motionInputs)
  report.final = await page.locator('.kernel-tiles').evaluate(e => ({ ...e.dataset }))
  await page.screenshot({ path: path.join(run, 'after.png') }); report.status = 'captured'
  assert.equal(report.inputs.length, deltas.length); assert(report.inputs.every(e => e.trusted)); if (capture) assert(report.frames.length > 3)
} catch (error) { report.status = 'failed'; report.error = String(error); process.exitCode = 1 }
finally {
  if(traceRunning)await cdp?.send('Tracing.end').catch(()=>{});
  await cdp?.send('Page.stopScreencast').catch(() => {}); await cdp?.detach().catch(() => {})
  if (app) { const owned = app.process(); let timer; try { await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('owned close timeout')), 15000) })]) }
    catch (error) { report.closeError = String(error); if (owned.exitCode === null && owned.signalCode === null) owned.kill('SIGTERM') } finally { clearTimeout(timer) } }
  await Promise.allSettled(writes); if(report.motionStart&&report.motionEnd){report.renderFailures=await renderFailures(path.join(run,'host.log'),report.motionStart,report.motionEnd);if(report.renderFailures.length&&report.status==='captured'){report.status='failed-render-recovery';process.exitCode=1}} await persist(); console.log(JSON.stringify({ status: report.status, frames: report.frames.length, error: report.error }))
}
