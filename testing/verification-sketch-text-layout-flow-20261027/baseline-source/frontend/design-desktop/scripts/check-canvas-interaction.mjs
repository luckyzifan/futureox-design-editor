// Real packaged Electron input + its real Rust/SQLite backend. No renderer,
// filesystem bridge, persistence or drawing mocks; no sandbox-relaxing retry.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInputs } from './build-inputs.mjs'
import { Sidecar } from '../src/sidecar.mjs'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const core = path.resolve(desktop, '../..')
const requireClient = createRequire(path.join(core, 'frontend/design-client/package.json'))
const { _electron, expect } = requireClient('@playwright/test')
const args = process.argv.slice(2)
if (args.includes('--help')) {
  console.log('node scripts/check-canvas-interaction.mjs --app=/absolute/tagged/Bundle.app/Contents/MacOS/futureox-desgin [--output=/new/absolute/evidence-directory] [--hdr-fixture=/absolute/managed-fixture.fd | --software-fixture=/absolute/software-fixture.fd] [--cache-probe]')
  process.exit(0)
}
for (const arg of args) assert.ok(arg === '--cache-probe' || arg === '--require-webgpu' || /^--(?:app|output|hdr-fixture|software-fixture)=.+$/.test(arg), `Unknown argument: ${arg}`)
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const hdrFixturePath = option('hdr-fixture')
const requireWebgpu = args.includes('--require-webgpu')
if (requireWebgpu) assert.ok(hdrFixturePath, '--require-webgpu requires --hdr-fixture')
const softwareFixturePath = option('software-fixture')
assert.ok(!(hdrFixturePath && softwareFixturePath), '--hdr-fixture and --software-fixture are mutually exclusive')
const cacheProbe = args.includes('--cache-probe')
if (cacheProbe) assert.ok(hdrFixturePath, '--cache-probe requires --hdr-fixture')
if (hdrFixturePath) assert.ok(path.isAbsolute(hdrFixturePath), '--hdr-fixture must be absolute')
if (softwareFixturePath) assert.ok(path.isAbsolute(softwareFixturePath), '--software-fixture must be absolute')
const requestedApp = option('app')
assert.ok(requestedApp && path.isAbsolute(requestedApp), '--app must name the new packaged executable by absolute path')
assert.equal(process.platform, 'darwin', 'This runner covers the macOS packaged application')
const executable = await realpath(requestedApp)
assert.equal(path.basename(executable), 'futureox-desgin')
assert.equal(path.basename(path.dirname(executable)), 'MacOS')
const contents = path.resolve(path.dirname(executable), '..')
assert.equal(path.basename(contents), 'Contents')
const resources = path.join(contents, 'Resources')
const taggedDirectory = path.dirname(path.dirname(path.dirname(contents)))
const verificationPath = path.join(taggedDirectory, 'package-verification.json')
const archive = path.join(resources, 'app.asar')
const sidecarBinary = path.join(resources, 'sidecar/futureox-design-desktop-backend')
const runId = randomUUID()
const requestedOutput = option('output')
if (requestedOutput) assert.ok(path.isAbsolute(requestedOutput), '--output must be absolute and must not already exist')
const output = requestedOutput
  ? (await mkdir(requestedOutput, { mode: 0o700 }), await realpath(requestedOutput))
  : await realpath(await mkdtemp(path.join(tmpdir(), `forma-electron-interaction-${runId}-`)))
const profileRoot = path.join(output, `profiles-${runId}`)
await mkdir(profileRoot, { mode: 0o700 })
const inputs = [], checks = [], errors = [], logs = []
let app, page, probe, profile, saved, kernelSaved, closed = false
const hash = async filename => {
  const value = createHash('sha256')
  for await (const bytes of createReadStream(filename)) value.update(bytes)
  return value.digest('hex')
}
const recordInput = async (type, detail) => {
  inputs.push({ sequence: inputs.length + 1, at: new Date().toISOString(), type, ...detail })
  await writeFile(path.join(output, 'inputs.json'), JSON.stringify(inputs, null, 2))
}
const checked = (name, detail) => {
  checks.push({ name, ...(detail ? { detail } : {}) })
  console.log(`ELECTRON_INTERACTION ${name}`)
}
const report = {
  format: 1, runId, startedAt: new Date().toISOString(), executable, verificationPath, output,
  scope: `Fresh packaged Electron window using ${hdrFixturePath ? 'the production GPU renderer with a real pending HDR frame' : softwareFixturePath ? 'the production GPU renderer with software-profile menu and persistence checks' : 'the exact CPU renderer'}, real Playwright renderer mouse/keyboard, unmodified preload/host and real bundled Rust/SQLite. Not physical stylus/trackpad, Finder or frame-rate acceptance.`,
  status: 'running', checks, inputs, errors,
}
async function closeOwned() {
  if (!app || closed) return
  const child = app.process()
  let timer
  try {
    await Promise.race([app.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Owned Electron did not close within 30 seconds')), 30000) })])
    closed = true
  } finally {
    clearTimeout(timer)
    // Only the process handle created by this runner is eligible for cleanup.
    if (!closed && child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const force = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 3000)
      force.unref()
    }
  }
}
try {
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'))
  assert.equal(verification.status, 'passed', 'Run package verification for the new tagged bundle first')
  assert.equal(verification.platform, process.platform)
  assert.equal(verification.arch, process.arch)
  assert.deepEqual(await buildInputs(core), verification.build.sources, 'Tagged bundle inputs do not match this source; build/verify again')
  const identities = { archive: await hash(archive), sidecar: await hash(sidecarBinary) }
  assert.equal(identities.archive, verification.artifacts['app.asar'], 'Packaged application archive differs from its verification')
  assert.equal(identities.sidecar, verification.artifacts['sidecar/futureox-design-desktop-backend'], 'Packaged Rust backend differs from its verification')
  report.identities = identities
  checked('new tagged bundle and Rust binary match verified current build inputs')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
  // main.mjs creates a fresh child profile in TMPDIR before single-instance lock.
  // Its UUID parent ensures this test cannot reuse a user's profile/window.
  app = await _electron.launch({
    executablePath: executable, args: ['--desktop-gui-test', ...(!hdrFixturePath && !softwareFixturePath ? ['--core-cpu-only'] : [])], cwd: path.dirname(executable),
    env: { ...env, TMPDIR: profileRoot, ELECTRON_ENABLE_SECURITY_WARNINGS: 'true' },
    chromiumSandbox: true, timeout: 45000,
  })
  app.process().stdout?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 1000) logs.shift() })
  app.process().stderr?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 1000) logs.shift() })
  page = await app.firstWindow({ timeout: 30000 })
  page.on('pageerror', error => errors.push(String(error)))
  await page.waitForURL(/^design-app:/, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const host = await app.evaluate(({ app, BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('design-app:'))
    if (!window) throw Error('Owned design window is absent')
    const p = window.webContents.getLastWebPreferences()
    return { packaged: app.isPackaged, appPath: app.getAppPath(), profile: app.getPath('userData'),
      argv: process.argv, versions: process.versions,
      preferences: { sandbox: p.sandbox, contextIsolation: p.contextIsolation, webSecurity: p.webSecurity,
        nodeIntegration: p.nodeIntegration, nodeIntegrationInWorker: p.nodeIntegrationInWorker, nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames } }
  })
  profile = await realpath(host.profile)
  const relativeProfile = path.relative(await realpath(profileRoot), profile)
  assert.ok(relativeProfile && !relativeProfile.startsWith('..') && !path.isAbsolute(relativeProfile), 'Electron did not use the owned UUID profile')
  assert.equal(host.packaged, true)
  assert.equal(await realpath(host.appPath), await realpath(archive))
  assert.ok(host.argv.includes('--desktop-gui-test'))
  assert.ok(!host.argv.some(arg => /(?:no-sandbox|disable-web-security|disable-setuid-sandbox)/.test(arg)))
  assert.deepEqual(host.preferences, { sandbox: true, contextIsolation: true, webSecurity: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false })
  report.host = host
  await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready', 'true', { timeout: 30000 })
  assert.deepEqual(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: window.coreDesktop?.version })),
    { require: 'undefined', process: 'undefined', bridge: 1 })
  checked('actual packaged window retains sandbox, context isolation and web security in its owned profile')
  const canvas = page.getByTestId('canvas'), title = page.getByLabel('文档名称', { exact: true })
  const settle = async (timeout = 30000) => {
    await expect.poll(async () => {
      const error = await page.locator('.kernel-status.error').allTextContents()
      if (error.length) return `error: ${error.join('; ')}`
      return await page.locator('.kernel-presentation').getAttribute('data-presentation-ready')
    }, { timeout }).toBe('true')
  }
  const key = async value => { await recordInput('keyboard.press', { value }); await page.keyboard.press(value) }
  const mouse = async (operation, point, options) => {
    await recordInput(`mouse.${operation}`, { ...point, ...(options || {}) })
    if (operation === 'move' || operation === 'click') await page.mouse[operation](point.x, point.y, options)
    else await page.mouse[operation](options)
  }
  const click = async (label, locator) => {
    await expect(locator).toBeVisible()
    await locator.scrollIntoViewIfNeeded()
    const box = await locator.boundingBox(); assert.ok(box, `No bounds for ${label}`)
    await mouse('click', { x: box.x + box.width / 2, y: box.y + box.height / 2, target: label })
  }
  const modifier = async (value, held) => {
    await recordInput(`keyboard.${held ? 'down' : 'up'}`, { value })
    await page.keyboard[held ? 'down' : 'up'](value)
  }
  const observeNativeInput = ()=>{
    window.__nativeInputEvidence=[]
    for(const type of ['keydown','keyup','pointerdown','pointerup','wheel','pointercancel','lostpointercapture'])document.addEventListener(type,event=>{
      const el=event.target
      window.__nativeInputEvidence.push({at:Date.now(),type,pointerId:event.pointerId,deltaX:event.deltaX,deltaY:event.deltaY,key:event.key,code:event.code,trusted:event.isTrusted,buttons:event.buttons,x:event.clientX,y:event.clientY,shift:event.shiftKey,alt:event.altKey,meta:event.metaKey,ctrl:event.ctrlKey,target:el.tagName,aria:el.getAttribute?.('aria-label'),title:el.closest?.('button')?.getAttribute('title'),testid:el.closest?.('[data-testid]')?.getAttribute('data-testid'),canvas:document.querySelector('[data-testid="canvas"]')?.className})
    },true)
  }
  await page.addInitScript(observeNativeInput)
  await page.evaluate(observeNativeInput)
  const authoredName = `Electron GUI ${runId.slice(0, 8)}`
  const stored = (name = authoredName) => page.evaluate(async name => {
    const list = await window.coreDesktop.workspace.list()
    if (list.status !== 'ok') throw Error(list.message || 'Workspace list failed')
    const entry = list.documents.find(document => document.name === name)
    if (!entry) return null
    const opened = await window.coreDesktop.workspace.open({ id: entry.id })
    if (opened.status !== 'ok') throw Error(opened.message || 'Workspace open failed')
    return { ...opened, document: JSON.parse(opened.documentJson) }
  }, name)
  const saveCount = async count => {
    await expect.poll(async () => Object.keys((await stored())?.document.nodes || {}).length, { timeout: 15000 }).toBe(count)
    await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 15000 })
    await settle()
    return await stored()
  }
  const selection = async (...ids) => {
    await expect(page.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(ids.length)
    for (const id of ids) await expect(page.getByTestId(`layer-${id}`)).toHaveAttribute('aria-selected', 'true')
  }
  const point = async (x, y) => { const b = await canvas.boundingBox(); assert.ok(b); return { x: b.x + b.width * x, y: b.y + b.height * y } }
  const center = async node => {
    const b = await canvas.boundingBox(); assert.ok(b)
    const view = await page.locator('.kernel-presentation').evaluate(el => ({ x: +el.dataset.cameraX, y: +el.dataset.cameraY, zoom: +el.dataset.cameraZoom }))
    assert.ok([view.x, view.y, view.zoom].every(Number.isFinite))
    return { x: b.x + view.x + (node.transform[4] + node.width / 2) * view.zoom,
      y: b.y + view.y + (node.transform[5] + node.height / 2) * view.zoom }
  }
  const draw = async (tool, start, end) => {
    await click('canvas focus', canvas); await key(tool)
    await expect(canvas).toHaveClass(new RegExp(`canvas-${tool === 'o' ? 'ellipse' : 'rectangle'}`))
    await recordInput('presentation.before-draw', { ready: await page.locator('.kernel-presentation').getAttribute('data-presentation-ready') })
    await mouse('move', start); await mouse('down', {}); await mouse('move', end, { steps: 8 }); await mouse('up', {})
  }
  await settle()
  await canvas.focus();await key('n');await expect(canvas).toHaveClass(/canvas-pencil/);await key('v');await expect(canvas).toHaveClass(/canvas-select/)
  checked('packaged tool shortcuts dispatch through the initialized Rust shortcut table')
  await click('document name', title); await key('Meta+A')
  await recordInput('keyboard.type', { value: authoredName }); await page.keyboard.type(authoredName); await key('Enter')
  // Deliberately start the next gesture without waiting for rename rendering.
  // Initial startup is settled above; pending revisions must not discard input.
  await draw('o', await point(0.17, 0.22), await point(0.36, 0.40))
  let current = await saveCount(1)
  const ellipse = Object.values(current.document.nodes)[0]
  await expect(page.locator('.app-shell')).toHaveAttribute('data-history-backend','graph-api')
  assert.equal(ellipse.kind, 'ellipse'); assert.equal(ellipse.network, undefined)
  await draw('r', await point(0.60, 0.24), await point(0.79, 0.42))
  current = await saveCount(2)
  const rectangle = Object.values(current.document.nodes).find(node => node.id !== ellipse.id)
  await writeFile(path.join(output,'initial-input-evidence.json'),JSON.stringify(await page.evaluate(()=>window.__nativeInputEvidence),null,2))
  await writeFile(path.join(output,'initial-shapes.fd'),JSON.stringify(current.document,null,2))
  assert.equal(rectangle.kind, 'rectangle')
  checked('real Electron keyboard/mouse creates native ellipse and rectangle in actual Rust SQLite')
  await page.screenshot({ path: path.join(output, '01-created-shapes.png') })
  const a = await center(current.document.nodes[ellipse.id]), b = await center(current.document.nodes[rectangle.id])
  // Multi-selection places a smart-reorder grip at each shape's centre.
  // Exercise ordinary interior selection separately from that explicit grip.
  a.x += 18; b.x += 18
  await mouse('click', a); await modifier('Shift', true); await mouse('click', b); await modifier('Shift', false)
  await selection(ellipse.id, rectangle.id)
  const before = await stored()
  await modifier('Shift', true); await mouse('move', a); await mouse('down', {}); await selection(ellipse.id, rectangle.id)
  await mouse('up', {}); await modifier('Shift', false); await selection(rectangle.id)
  await modifier('Shift', true); await mouse('click', a); await modifier('Shift', false); await selection(ellipse.id, rectangle.id)
  await mouse('move', a); await mouse('down', {}); await selection(ellipse.id, rectangle.id); await mouse('up', {}); await selection(ellipse.id)
  await modifier('Shift', true); await mouse('click', b); await modifier('Shift', false); await selection(ellipse.id, rectangle.id)
  assert.deepEqual((await stored()).document, before.document)
  assert.equal((await stored()).revision, before.revision)
  checked('multi-selection click intention changes selection on release without creating a document revision')
  await modifier('Shift', true); await mouse('move', a); await mouse('down', {})
  await mouse('move', { x: a.x + 64, y: a.y + 18 }, { steps: 8 }); await selection(ellipse.id, rectangle.id)
  await mouse('up', {}); await modifier('Shift', false)
  await expect.poll(async () => (await stored()).document.nodes[ellipse.id].transform[4], { timeout: 15000 }).not.toBe(before.document.nodes[ellipse.id].transform[4])
  current = await saveCount(2)
  const delta = id => ({ x: current.document.nodes[id].transform[4] - before.document.nodes[id].transform[4],
    y: current.document.nodes[id].transform[5] - before.document.nodes[id].transform[5] })
  assert.deepEqual(delta(ellipse.id), delta(rectangle.id)); assert.equal(delta(ellipse.id).y, 0); assert.ok(delta(ellipse.id).x > 20)
  await page.screenshot({ path: path.join(output, '02-shift-drag.png') })
  checked('Shift drag retains both selected shapes and locks their shared movement to one axis', delta(ellipse.id))
  await key('Meta+Z')
  await expect.poll(async () => (await stored()).document.nodes[ellipse.id].transform[4], { timeout: 15000 }).toBe(before.document.nodes[ellipse.id].transform[4])
  current = await saveCount(2); assert.deepEqual(current.document, before.document)
  checked('real Electron Undo command restores the entire two-node drag in one transaction')
  await click('ellipse for Scale', page.getByTestId(`layer-${ellipse.id}`))
  const scaleBefore = await stored(), originalScaleNode = scaleBefore.document.nodes[ellipse.id]
  await key('k')
  const scaleInput = page.getByLabel('缩放倍率', { exact: true })
  await expect(scaleInput).toBeFocused(); await expect(scaleInput).toHaveValue('1x')
  await recordInput('keyboard.type', { value: '2x' }); await page.keyboard.type('2x'); await key('Enter')
  await expect(canvas).toHaveClass(/canvas-select/)
  await expect.poll(async () => (await stored()).document.nodes[ellipse.id].transform[0]).toBe(originalScaleNode.transform[0] * 2)
  const scaleAfter = await saveCount(2)
  assert.equal(scaleAfter.document.nodes[ellipse.id].width, originalScaleNode.width)
  assert.equal(scaleAfter.document.nodes[ellipse.id].height, originalScaleNode.height)
  assert.equal(scaleAfter.document.nodes[ellipse.id].transform[3], originalScaleNode.transform[3] * 2)
  await key('Meta+z'); current = await saveCount(2); assert.deepEqual(current.document, scaleBefore.document)
  checked('native K Scale applies once, retains editable geometry and Undo restores the exact Rust SQLite document')
  const navigationBefore = await stored()
  const publishedCamera = () => page.locator('.kernel-presentation').evaluate(el => ({ x: +el.dataset.cameraX, y: +el.dataset.cameraY, zoom: +el.dataset.cameraZoom }))
  const cameraBefore = await publishedCamera()
  await click('move tool menu', page.getByRole('button', { name: '移动工具', exact: true }))
  await click('hand menu item', page.getByRole('menuitemradio', { name: '平移', exact: true }))
  await expect(canvas).toHaveClass(/canvas-hand/); await expect(canvas).toBeFocused()
  const panStart = await point(.5, .65), panEnd = { x: panStart.x + 60, y: panStart.y + 30 }
  await mouse('move', panStart); await mouse('down', {}); await mouse('move', panEnd, { steps: 6 }); await mouse('up', {}); await settle()
  const cameraAfter = await publishedCamera()
  assert.ok(Math.abs(cameraAfter.x - cameraBefore.x - 60) < 1e-9)
  assert.ok(Math.abs(cameraAfter.y - cameraBefore.y - 30) < 1e-9)
  assert.equal(cameraAfter.zoom, cameraBefore.zoom)
  await mouse('move', panEnd); await mouse('down', {}); await mouse('move', panStart, { steps: 6 }); await mouse('up', {}); await settle()
  await key('v')
  assert.deepEqual((await stored()).document, navigationBefore.document)
  assert.equal((await stored()).revision, navigationBefore.revision)
  checked('move menu hand drag publishes exact camera deltas without editing the real SQLite document', { cameraBefore, cameraAfter })
  const menuBefore = await stored()
  await click('shape tool menu', page.getByRole('button', { name: '形状工具', exact: true }))
  await expect(page.getByRole('menu', { name: '形状工具', exact: true })).toBeVisible()
  await key('Delete')
  await expect(page.getByRole('menu', { name: '形状工具', exact: true })).toBeVisible()
  assert.deepEqual((await stored()).document, menuBefore.document); assert.equal((await stored()).revision, menuBefore.revision)
  await page.screenshot({ path: path.join(output, '03-menu-delete-isolated.png') })
  await key('Escape')
  checked('Delete while the shape menu owns focus cannot delete canvas selection or change SQLite revision')
  await key('Meta+S'); saved = await saveCount(2)
  await page.reload(); await expect(title).toHaveValue(authoredName, { timeout: 30000 }); await settle()
  assert.deepEqual((await stored()).document, saved.document)
  await page.screenshot({ path: path.join(output, '04-sqlite-reloaded.png') })
  report.renderer = await page.locator('.kernel-status').allTextContents()
  checked('native Save and renderer reload recover the same document through the real desktop bridge')
  // New native authoring is exercised through the same packaged UI and Rust
  // workspace; reads below only inspect the already-persisted SQLite result.
  await click('ellipse layer for native arc', page.getByTestId(`layer-${ellipse.id}`))
  for (const [label,value] of [['圆弧起始 °','22.5'],['圆弧扫过 °','270'],['圆环内径 %','62.5']]) {
    await click(label,page.getByLabel(label,{exact:true}));await key('Meta+A')
    await recordInput('keyboard.type',{value});await page.keyboard.type(value);await key('Enter')
  }
  await expect.poll(async()=>(await stored()).document.nodes[ellipse.id].arc).toEqual({startAngle:Math.PI/8,sweepAngle:Math.PI*1.5,innerRadius:.625})
  await click('persistent ratio lock',page.getByLabel('锁定宽高比',{exact:true}))
  await click('fractional width expression',page.getByLabel('W',{exact:true}));await key('Meta+A')
  await recordInput('keyboard.type',{value:'*=1.25'});await page.keyboard.type('*=1.25');await key('Enter')
  current=await saveCount(2)
  assert.equal(current.document.schemaVersion,7)
  assert.equal(current.document.nodes[ellipse.id].constrainProportions,true)
  assert.equal(current.document.nodes[ellipse.id].height,saved.document.nodes[ellipse.id].height*1.25)
  const nativeBefore=current.document
  await click('canvas focus before duplicate',page.getByTestId(`layer-${ellipse.id}`));await key('Meta+d')
  current=await saveCount(3)
  const duplicate=Object.values(current.document.nodes).find(n=>!nativeBefore.nodes[n.id])
  assert.deepEqual(duplicate.arc,nativeBefore.nodes[ellipse.id].arc)
  assert.deepEqual(duplicate.transform,nativeBefore.nodes[ellipse.id].transform)
  await key('Meta+Z');current=await saveCount(2);assert.deepEqual(current.document,nativeBefore)
  await page.screenshot({path:path.join(output,'05-native-arc-ratio.png')})
  checked('native schema 7 arc/ring, proportional arithmetic and duplicate/Undo survive actual Rust SQLite')
  const pageName=current.document.pages[0].name
  await click('page actions',page.getByLabel(`页面操作：${pageName}`,{exact:true}))
  await click('duplicate page',page.getByRole('menuitem',{name:'复制页面',exact:true}))
  await expect.poll(async()=>(await stored()).document.pages.length).toBe(2)
  current=await stored()
  assert.equal(Object.keys(current.document.nodes).length,4)
  const copiedArc=current.document.pages[1].children.map(id=>current.document.nodes[id]).find(n=>n.kind==='ellipse')
  assert.deepEqual(copiedArc.arc,nativeBefore.nodes[ellipse.id].arc)
  await key('Meta+Z');current=await saveCount(2);assert.deepEqual(current.document,nativeBefore)
  await key('Meta+S');saved=await saveCount(2)
  await page.reload();await expect(title).toHaveValue(authoredName,{timeout:30000});await settle()
  assert.deepEqual((await stored()).document,saved.document)
  await page.screenshot({path:path.join(output,'06-native-shapes-reopened.png')})
  checked('page duplication retains native geometry; undo and desktop reopen restore exact authored document')
  await click('rectangle layer for export presets',page.getByTestId(`layer-${rectangle.id}`))
  await click('add layer export',page.getByLabel('添加图层导出设置',{exact:true}))
  await click('layer export suffix',page.getByLabel('导出后缀 1',{exact:true}))
  await recordInput('keyboard.type',{value:'-native'});await page.keyboard.type('-native');await key('Enter')
  await expect.poll(async()=>(await stored()).document.nodes[rectangle.id].exportSettings?.[0]?.suffix).toBe('-native')
  await click('generate native layer preview',page.getByRole('button',{name:'预览并导出此图层',exact:true}))
  await expect(page.getByAltText('图层导出预览 1')).toBeVisible({timeout:30000})
  current=await saveCount(2)
  const rectangleSource=current.document.nodes[rectangle.id]
  const previewSize=await page.getByAltText('图层导出预览 1').evaluate(el=>[el.naturalWidth,el.naturalHeight])
  assert.deepEqual(previewSize,[Math.ceil(rectangleSource.width),Math.ceil(rectangleSource.height)])
  await page.screenshot({path:path.join(output,'07-layer-export-preview.png')})
  checked('native per-layer export setting reaches SQLite and generates actual PNG preview', {previewSize})
  await click('rectangle selection before PNG copy',page.getByTestId(`layer-${rectangle.id}`))
  // The system clipboard is shared across owned profiles. Establish the current
  // graph first so an older PNG cannot satisfy the asynchronous copy predicate.
  await key('Meta+C')
  await expect.poll(async()=>{const value=await page.evaluate(()=>window.coreDesktop.clipboard.read());return value.forma && !!JSON.parse(value.forma).document.nodes[rectangle.id]}).toBe(true)
  await key('Meta+Shift+C')
  await expect(page.getByRole('contentinfo')).toContainText('已复制 PNG', {timeout:15000})
  await expect.poll(async()=> (await page.evaluate(()=>window.coreDesktop.clipboard.read())).image?.startsWith('data:image/png;base64,')).toBe(true)
  const copiedImage=await page.evaluate(()=>window.coreDesktop.clipboard.read())
  assert.equal(copiedImage.status,'ok');assert.ok(!copiedImage.forma)
  const png=Buffer.from(copiedImage.image.slice('data:image/png;base64,'.length),'base64')
  assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[Math.ceil(rectangleSource.width*2),Math.ceil(rectangleSource.height*2)])
  await key('Meta+V');current=await saveCount(3)
  const pastedImage=Object.values(current.document.nodes).find(n=>n.id!==ellipse.id && n.id!==rectangle.id)
  assert.equal(pastedImage.fills[0].kind,'image');assert.equal(pastedImage.fills[0].image,copiedImage.image,'Forma clipboard round trip must keep the exact original PNG bytes')
  await key('Meta+Z');current=await saveCount(2)
  checked('actual macOS native menu copies a 2× PNG image, pastes it as an image layer, and undoes once')
  await click('canvas focus before arrow',canvas);await key('Shift+KeyL')
  await expect(canvas).toHaveClass(/canvas-arrow/)
  const arrowStart=await point(.44,.64),arrowEnd=await point(.67,.77)
  await mouse('move',arrowStart);await mouse('down',{});await mouse('move',arrowEnd,{steps:6});await mouse('up',{})
  current=await saveCount(3)
  const arrow=Object.values(current.document.nodes).find(n=>n.id!==ellipse.id && n.id!==rectangle.id)
  assert.equal(arrow.kind,'line');assert.equal(arrow.strokes[0].endMarker,'arrow');assert.equal(current.document.schemaVersion,8)
  await page.screenshot({path:path.join(output,'08-native-arrow.png')})
  await key('Meta+S');saved=await saveCount(3)
  await page.reload();await expect(title).toHaveValue(authoredName,{timeout:30000});await settle()
  assert.deepEqual((await stored()).document,saved.document)
  checked('native Shift+L arrow and schema 8 export settings survive desktop Save and reload')
  {
    const beforeNavigation = await stored(), stage = page.locator('.kernel-presentation')
    const camera = () => stage.evaluate(el => ({ x: Number(el.dataset.cameraX), y: Number(el.dataset.cameraY), zoom: Number(el.dataset.cameraZoom) }))
    await canvas.focus(); await settle()
    const start = await point(.50,.62), end = { x: start.x + 100, y: start.y - 60 }
    const before = await camera()
    await modifier('Space',true);await expect(canvas).toHaveCSS('cursor','grab')
    await mouse('move',start);await mouse('down',{});await expect(canvas).toHaveCSS('cursor','grabbing')
    await mouse('move',end,{steps:18});await mouse('up',{});await modifier('Space',false);await settle()
    const after = await camera();assert.ok(Math.abs(after.x-before.x-100)<0.001);assert.ok(Math.abs(after.y-before.y+60)<0.001)
    await modifier('Shift',true);await recordInput('mouse.wheel',{deltaX:0,deltaY:80});await page.mouse.wheel(0,80);await modifier('Shift',false)
    await expect.poll(async()=> (await camera()).x).toBe(after.x-80);await settle()
    assert.equal((await camera()).y,after.y)
    assert.deepEqual((await stored()).document,beforeNavigation.document)
    checked('native Space/hand drag and Shift wheel preserve exact camera deltas without a document mutation')
    await click('minimize workspace',page.getByRole('button',{name:'收起界面',exact:true}))
    await expect(page.locator('.workspace-rail')).toBeHidden();await expect(page.locator('.layers-panel')).toBeHidden()
    await canvas.focus();await key('Meta+Shift+Backslash');await expect(page.locator('.workspace-rail')).toBeVisible();await expect(page.locator('.layers-panel')).toBeVisible();await settle()
    await page.screenshot({path:path.join(output,'09-native-navigation.png')})
    checked('native minimized workspace and macOS shortcut restore the side panels')
  }
  {
    const fixture = structuredClone(saved.document)
    fixture.id = randomUUID(); fixture.name = `Electron Kernel ${runId.slice(0,8)}`; fixture.schemaVersion = 8
    fixture.nodes = {}; fixture.pages = [{...fixture.pages[0], id:randomUUID(), children:[]}]
    delete fixture.animations; delete fixture.designSystem
    const shape = (kind,name,x,y,width,height) => {
      const n={...structuredClone(rectangle),id:randomUUID(),kind,name,transform:[1,0,0,1,x,y],width,height,children:[],effects:[],strokes:[],radii:[0,0,0,0]}
      delete n.network;delete n.arc;delete n.layout;delete n.exportSettings;delete n.instance;delete n.component
      fixture.nodes[n.id]=n;return n
    }
    const first=shape('frame','推断画板',100,100,132,198),second=shape('frame','目标画板',400,100,170,220)
    first.fills=[{...first.fills[0],color:'#ffffff'}];second.fills=[{...second.fills[0],color:'#ffffff'}]
    fixture.pages[0].children=[first.id,second.id]
    const children=[]
    for(let i=0;i<3;i++){
      const a=shape('rectangle',`项目 ${i+1}`,16,16+i*58,100,50),b=shape('rectangle',`项目 ${i+1}`,24,20+i*60,110,44)
      first.children.push(a.id);second.children.push(b.id);children.push(a)
    }
    first.children.reverse()
    fixture.prototype={startNode:first.id,interactions:{[first.id]:[{trigger:'click',actions:[{kind:'navigate',target:second.id,durationMs:400}]}]}}
    const file=path.join(output,'kernel-adoption-input.fd');await writeFile(file,JSON.stringify(fixture))
    await recordInput('file.import',{file});await page.locator('input[type=file][accept*=".fd"]').setInputFiles(file)
    await expect(title).toHaveValue(fixture.name,{timeout:30000});await settle()
    await click('select inference frame',page.getByTestId(`layer-${first.id}`));await canvas.focus();await key('Shift+KeyA')
    await expect.poll(async()=>(await stored(fixture.name))?.document.nodes[first.id].layout?.mode).toBe('vertical')
    await expect(page.getByLabel('项目间距',{exact:true})).toHaveValue('8')
    for(const label of ['上内边距','右内边距','下内边距','左内边距'])await expect(page.getByLabel(label,{exact:true})).toHaveValue('16')
    await expect.poll(async()=>(await stored(fixture.name))?.document.nodes[first.id].children).toEqual(children.map(n=>n.id))
    checked('packaged Electron Shift+A invokes Rust inferred layout with the measured vertical gap')
    await click('grid layout',page.getByRole('radio',{name:'网格布局',exact:true}));await click('grid column count',page.getByLabel('列数',{exact:true}));await key('Meta+A');await recordInput('keyboard.type',{value:'2'});await page.keyboard.type('2');await key('Enter');await settle()
    await expect(page.getByTestId('layout-grid-cell')).toHaveCount(4)
    const cells=await page.getByTestId('layout-grid-cell').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('points')))
    assert.ok(cells.every(value=>value && !value.includes('NaN')))
    await page.screenshot({path:path.join(output,'10-native-kernel-grid.png')})
    await canvas.focus();await key('Meta+Z');await key('Meta+Z');await settle()
    await expect.poll(async()=>(await stored(fixture.name))?.document.nodes[first.id].layout?.mode).toBe('vertical')
    checked('native grid mode consumes solved Rust cells and Graph history restores the inferred layout')
    await click('gradient blur target',page.getByTestId(`layer-${children[0].id}`))
    await recordInput('selectOption',{label:'添加效果',value:'blur'});await page.getByLabel('添加效果',{exact:true}).selectOption('blur')
    await click('enable gradient blur',page.getByLabel('渐变模糊',{exact:true}))
    await click('gradient end strength',page.getByLabel('终点强度',{exact:true}));await key('Meta+A');await recordInput('keyboard.type',{value:'3'});await page.keyboard.type('3');await key('Enter')
    await expect.poll(async()=>(await stored(fixture.name))?.document.schemaVersion).toBe(9)
    await expect.poll(async()=>(await stored(fixture.name))?.document.nodes[children[0].id].effects[0].gradientBlur?.endCount).toBe(3)
    await settle(120000);await page.screenshot({path:path.join(output,'11-native-gradient-blur.png')})
    await key('Meta+S');kernelSaved=await stored(fixture.name)
    await page.reload();await expect(title).toHaveValue(fixture.name,{timeout:30000});await settle(120000)
    assert.deepEqual((await stored(fixture.name)).document,kernelSaved.document)
    checked('schema 9 gradient blur is editable, renders, persists through real Rust SQLite and survives reload')
    await click('native prototype preview',page.getByRole('button',{name:'预览原型',exact:true}))
    const player=page.getByRole('dialog',{name:'交互原型预览'})
    await expect(player.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:60000})
    await click('prototype navigate',player.getByRole('button',{name:'推断画板',exact:true}))
    await expect(player).toHaveAttribute('data-animation-plan','kernel-baked')
    await expect(player).toHaveAttribute('data-transition-progress','1',{timeout:30000})
    await expect(player.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready','true',{timeout:60000})
    await expect(player.locator('header strong')).toHaveText('原型 · 目标画板')
    await expect(player.locator('.kernel-status.error')).toHaveCount(0)
    await expect(player.getByRole('alert')).toHaveCount(0)
    await expect(player.getByLabel('渲染后端',{exact:true})).toBeHidden()
    await page.screenshot({path:path.join(output,'12-native-kernel-prototype.png')})
    await click('close native prototype',player.getByRole('button',{name:'关闭预览',exact:true}))
    assert.deepEqual((await stored(fixture.name)).document,kernelSaved.document)
    checked('packaged prototype uses the WASM plan, completes a valid frame, and leaves the saved document unchanged')
  }
  if (hdrFixturePath) {
    const fixture = JSON.parse(await readFile(hdrFixturePath, 'utf8'))
    assert.ok(fixture.colorManagement && fixture.rasterProfile === 'figma', 'HDR fixture must retain managed color and the Figma raster profile')
    assert.ok(Object.values(fixture.nodes).some(node => node.effects?.some(effect => effect.visible !== false && effect.kind === 'glass')), 'HDR fixture must exercise actual glass')
    fixture.name = `Electron HDR ${runId.slice(0, 8)}`
    const fixturePath = path.join(output, 'pending-hdr-input.fd')
    await writeFile(fixturePath, JSON.stringify(fixture))
    report.hdrFixture = { original: hdrFixturePath, originalHash: await hash(hdrFixturePath), importedHash: await hash(fixturePath) }
    await recordInput('file.import', { file: fixturePath })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
    await expect(title).toHaveValue(fixture.name, { timeout: 30000 })
    await settle(240000)
    await page.evaluate(() => {
      window.__nativeZoomTrace=[]
      const read=()=>{const p=document.querySelector('.kernel-presentation');return p?{...p.dataset}:null}
      const record=e=>{const t=e.target;const row={at:Date.now(),type:e.type,key:e.key,x:e.clientX,y:e.clientY,target:t?.tagName,label:t?.getAttribute?.('aria-label'),text:t?.textContent?.slice(0,80),camera:read(),busy:document.querySelector('.app-shell')?.getAttribute('aria-busy')};window.__nativeZoomTrace.push(row);setTimeout(()=>{row.prevented=e.defaultPrevented;row.after=read()},0)}
      document.addEventListener('pointerdown',record,true);document.addEventListener('keydown',record,true)
    })
    await click('zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
    await click('200% camera', page.getByRole('button', { name: '200%', exact: true }))
    await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-requested-camera-zoom','2')
    await click('zoom options after preset', page.getByLabel('缩放与视图设置', { exact: true }))
    for (const label of ['智能吸附', '吸附到像素网格']) {
      const checkbox = page.locator('.view-menu').getByRole('checkbox', { name: label, exact: true })
      if (await checkbox.isChecked()) await click(`disable ${label} for coordinate assertion`, checkbox)
    }
    await click('close zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
    await settle(240000)
    const presentation = page.locator('.kernel-presentation')
    await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
    await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
    const displayed = () => presentation.evaluate(element => ({ ...element.dataset, devicePixelRatio: window.devicePixelRatio }))
    const visibleHdrTiles = async () => {
      const tiles = await page.locator('canvas[data-frame-visible="true"]').evaluateAll(elements => elements.map(canvas => {
        const box = canvas.getBoundingClientRect()
        return { label: canvas.getAttribute('aria-label'), renderer: canvas.dataset.renderer,
          width: canvas.width, height: canvas.height, cssWidth: box.width, cssHeight: box.height,
          tileKey: canvas.dataset.tileKey, tileZoom: canvas.dataset.tileZoom }
      }))
      assert.ok(tiles.length > 0)
      const dpr = await page.evaluate(() => window.devicePixelRatio)
      for (const tile of tiles) {
        assert.equal(tile.label, '广色域 HDR 显示瓦片')
        assert.ok(['webgpu', 'webgl2'].includes(tile.renderer), 'Visible HDR tile must come from a real GPU backend')
        if (requireWebgpu) assert.equal(tile.renderer, 'webgpu', 'This run requires real WebGPU presentation without WebGL fallback')
        assert.ok(Math.abs(tile.width - tile.cssWidth * dpr) < 0.01)
        assert.ok(Math.abs(tile.height - tile.cssHeight * dpr) < 0.01)
      }
      return tiles
    }
    const beforeFrame = await displayed()
    assert.equal(Number(beforeFrame.cameraZoom), 2, 'The real canvas must present the requested 200% camera')
    assert.equal(Number(beforeFrame.pixelRatio), beforeFrame.devicePixelRatio, 'HDR presentation must keep physical device pixel density')
    const beforeTiles = await visibleHdrTiles()
    const beforeHdr = await stored(fixture.name)
    assert.ok(beforeHdr)
    const initialIds = new Set(Object.keys(beforeHdr.document.nodes)), pendingName = `${fixture.name} pending`
    const firstStart = await point(0.17, 0.22), firstEnd = await point(0.31, 0.34)
    const secondStart = await point(0.60, 0.24), secondEnd = await point(0.72, 0.36)
    // Observe the real dispatch boundary. This listener neither delays nor
    // modifies the event, rendering request, handler or persisted document.
    await page.evaluate(() => {
      window.__formaHdrPointerEvidence = []
      window.__formaHdrCameraEvidence = []
      const frame = document.querySelector('.kernel-presentation')
      new MutationObserver(() => window.__formaHdrCameraEvidence.push({ at: Date.now(), frame: { ...frame.dataset } })).observe(frame, {attributes:true, attributeFilter:['data-requested-camera-x','data-requested-camera-y','data-requested-camera-zoom','data-camera-x','data-camera-y','data-camera-zoom']})
      const observe = event => {
        const canvas = event.target.closest?.('[data-testid="canvas"]')
        const kind = canvas?.classList.contains('canvas-ellipse') ? 'ellipse'
          : canvas?.classList.contains('canvas-rectangle') ? 'rectangle' : null
        if (!kind || event.button !== 0) return
        const frame = canvas.querySelector('.kernel-presentation'), bounds = canvas.getBoundingClientRect()
        window.__formaHdrPointerEvidence.push({ type: event.type, pointerId: event.pointerId, kind, clientX: event.clientX, clientY: event.clientY,
          canvasX: bounds.x, canvasY: bounds.y, frame: { ...frame.dataset }, devicePixelRatio: window.devicePixelRatio })
      }
      document.addEventListener('pointerdown', observe, true)
      document.addEventListener('pointerup', observe, true)
      window.__formaStopHdrPointerEvidence = () => {
        document.removeEventListener('pointerdown', observe, true)
        document.removeEventListener('pointerup', observe, true)
      }
    })
    await page.screenshot({ path: path.join(output, '05-hdr-before-input.png') })
    await click('HDR document name', title); await key('Meta+A')
    await recordInput('keyboard.type', { value: pendingName }); await page.keyboard.type(pendingName); await key('Enter')
    // GPU tiles already reuse a pure rename. Trigger a real visual document
    // edit through the inspector so the pending condition is naturally present.
    const glassNode = Object.values(beforeHdr.document.nodes).find(node => node.effects?.some(effect => effect.visible !== false && effect.kind === 'glass'))
    await click('glass layer for visual edit', page.getByTestId(`layer-${glassNode.id}`))
    const widthField = page.getByRole('tabpanel', { name: '设计' }).getByLabel('W', { exact: true })
    const shownWidth = Number(await widthField.inputValue())
    assert.ok(Number.isFinite(shownWidth) && shownWidth > 0)
    await click('glass width property', widthField); await key('Meta+A')
    await recordInput('keyboard.type', { value: String(shownWidth + 1) }); await page.keyboard.type(String(shownWidth + 1)); await key('Enter')
    report.hdrPendingTrigger = { kind: 'glass-width-property', id: glassNode.id, originalWidth: glassNode.width, shownWidth, requestedWidth: shownWidth + 1 }
    await expect(presentation).toHaveAttribute('data-presentation-ready', 'false')
    const firstRecord = inputs.length
    await draw('o', firstStart, firstEnd)
    await draw('r', secondStart, secondEnd)
    const pendingStarts = inputs.slice(firstRecord).filter(input => input.type === 'presentation.before-draw')
    assert.equal(pendingStarts.length, 2)
    const pointerEvents = await page.evaluate(() => {
      window.__formaStopHdrPointerEvidence()
      return window.__formaHdrPointerEvidence
    })
    const pointerDowns = pointerEvents.filter(event => event.type === 'pointerdown')
    const pointerUps = pointerEvents.filter(event => event.type === 'pointerup')
    report.hdrPointerDowns = pointerDowns
    report.hdrPointerUps = pointerUps
    assert.equal(pointerDowns.length, 2)
    assert.equal(pointerUps.length, 2)
    for (const event of pointerDowns) {
      assert.equal(event.frame.presentationReady, 'false', 'Both real pointerdown events must occur while an HDR frame is pending')
      assert.equal(event.frame.presentationBackend, 'gpu')
      assert.equal(event.frame.fallbackPhase, 'none')
      assert.equal(Number(event.frame.pixelRatio), event.devicePixelRatio)
      for (const field of ['cameraX', 'cameraY', 'cameraZoom']) assert.equal(event.frame[field], beforeFrame[field])
    }
    await expect.poll(async () => Object.keys((await stored(pendingName))?.document.nodes || {}).length, { timeout: 30000 }).toBe(initialIds.size + 2)
    const afterHdr = await stored(pendingName)
    const added = Object.values(afterHdr.document.nodes).filter(node => !initialIds.has(node.id))
    assert.deepEqual(added.map(node => node.kind).sort(), ['ellipse', 'rectangle'])
    assert.deepEqual(afterHdr.document.colorManagement, beforeHdr.document.colorManagement)
    assert.equal(afterHdr.document.rasterProfile, beforeHdr.document.rasterProfile)
    assert.ok(afterHdr.document.nodes[glassNode.id].width > glassNode.width, 'The inspector edit must actually reach the persisted document')
    report.hdrGeometry = []
    for (const kind of ['ellipse', 'rectangle']) {
      const addedNode = added.find(node => node.kind === kind)
      const down = pointerDowns.find(event => event.kind === kind)
      const up = pointerUps.find(event => event.kind === kind)
      assert.ok(down && up)
      assert.equal(up.pointerId, down.pointerId)
      const zoom = Number(down.frame.cameraZoom), x = Number(down.frame.cameraX), y = Number(down.frame.cameraY)
      const start = { x: (down.clientX - down.canvasX - x) / zoom, y: (down.clientY - down.canvasY - y) / zoom }
      const end = { x: (up.clientX - up.canvasX - x) / zoom, y: (up.clientY - up.canvasY - y) / zoom }
      const expected = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
      // Creation now reparents into a containing frame. Persisted transforms
      // are parent-local; compare the composed world transform to the pointer.
      const parents = new Map(Object.values(afterHdr.document.nodes).flatMap(node => node.children.map(id => [id, node.id])))
      let world = [...addedNode.transform], parent = parents.get(addedNode.id)
      const seen = new Set([addedNode.id])
      while (parent) {
        assert.ok(!seen.has(parent), 'Persisted hierarchy must be acyclic');seen.add(parent)
        const m = afterHdr.document.nodes[parent].transform, n = world
        world = [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3],
          m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]]
        parent = parents.get(parent)
      }
      const actual = { x: world[4], y: world[5],
        width: Math.abs(world[0])*addedNode.width + Math.abs(world[2])*addedNode.height,
        height: Math.abs(world[1])*addedNode.width + Math.abs(world[3])*addedNode.height }
      report.hdrGeometry.push({ kind, expected, actual, localTransform: addedNode.transform, worldTransform: world, tolerance: 1e-9 })
      // Native pointer coordinates can differ from requested Playwright doubles.
      // Compare persisted geometry to actual dispatched endpoints, not a pixel tolerance.
      for (const field of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(actual[field] - expected[field]) <= 1e-9, `${kind} ${field} must follow the actual pointer endpoints and displayed camera`)
    }
    await page.screenshot({ path: path.join(output, '06-hdr-input-saved.png') })
    await settle(240000)
    await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
    await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
    const afterFrame = await displayed()
    const afterTiles = await visibleHdrTiles()
    assert.equal(Number(afterFrame.pixelRatio), afterFrame.devicePixelRatio)
    for (const field of ['cameraX', 'cameraY', 'cameraZoom']) assert.equal(afterFrame[field], beforeFrame[field])
    saved = await stored(pendingName)
    report.hdrPendingInput = { beforeFrame, afterFrame, beforeTiles, afterTiles, pendingStarts, addedIds: added.map(node => node.id), savedRevision: saved.revision }
    await page.screenshot({ path: path.join(output, '07-hdr-exact-frame-complete.png') })
    checked('two real GPU HDR pending-frame creations survive in SQLite and complete at full device pixel density')
    if (cacheProbe) {
      const star = Object.values(saved.document.nodes).find(node => node.kind === 'star')
      assert.ok(star, 'The cache probe requires a star in its HDR fixture')
      await click('cache probe zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
      await click('100% camera for visible edit', page.getByRole('button', { name: '100%', exact: true }))
      if (await page.locator('.view-menu').getAttribute('open') !== null) await click('close cache probe zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
      await settle(240000)
      const tiles = page.locator('.kernel-tiles')
      const beforeCache = await tiles.evaluate(element => ({ ...element.dataset }))
      const probeFrame = await displayed(), probeTiles = await visibleHdrTiles()
      const starRow = page.getByTestId(`layer-${star.id}`)
      await starRow.scrollIntoViewIfNeeded()
      await click('star layer for cache probe', starRow)
      const starWidth = page.getByRole('tabpanel', { name: '设计' }).getByLabel('W', { exact: true })
      const width = Number(await starWidth.inputValue())
      assert.ok(Number.isFinite(width) && width > 0)
      await click('star width property', starWidth); await key('Meta+A')
      await recordInput('keyboard.type', { value: String(width + 1) }); await page.keyboard.type(String(width + 1)); await key('Enter')
      await expect.poll(async () => (await stored(pendingName))?.document.nodes[star.id].width, { timeout: 30000 }).toBeGreaterThan(star.width)
      await settle(240000)
      const afterCache = await tiles.evaluate(element => ({ ...element.dataset }))
      const nextFrame = await displayed()
      const hitDelta = Number(afterCache.cacheHits) - Number(beforeCache.cacheHits)
      assert.ok(hitDelta > 0, 'A real node edit must produce exact tile reuse in the packaged application')
      await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
      await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
      for (const field of ['cameraX', 'cameraY', 'cameraZoom', 'pixelRatio']) assert.equal(nextFrame[field], probeFrame[field])
      const nextTiles = await visibleHdrTiles()
      saved = await stored(pendingName)
      assert.equal(Object.keys(saved.document.nodes).length, initialIds.size + 2)
      report.nativeCacheProbe = { nodeId: star.id, originalWidth: star.width, finalWidth: saved.document.nodes[star.id].width,
        beforeCache, afterCache, hitDelta, beforeFrame: probeFrame, afterFrame: nextFrame,
        beforeTileCount: probeTiles.length, afterTileCount: nextTiles.length,
        scope: 'Actual inspector geometry edit and reported exact hits; no native frame-rate claim.' }
      await page.screenshot({ path: path.join(output, '08-native-cache-edit.png') })
      checked('real inspector edit reuses unchanged exact GPU tiles and persists through Rust SQLite', { hitDelta })
    }
  }
  if (softwareFixturePath) {
    const fixture = JSON.parse(await readFile(softwareFixturePath, 'utf8'))
    assert.equal(fixture.rasterProfile, 'figmaSoftware', 'Software fixture must explicitly select its saved raster profile')
    assert.ok(!fixture.colorManagement, 'Software arithmetic fixture must exercise SDR, not the managed float path')
    assert.ok(Object.values(fixture.nodes).some(node => node.effects?.some(effect =>
      effect.visible !== false && effect.kind === 'glass' && effect.glass)), 'Software fixture must contain actual parameterized glass')
    fixture.name = `Electron software ${runId.slice(0, 8)}`
    const fixturePath = path.join(output, 'software-profile-input.fd')
    await writeFile(fixturePath, JSON.stringify(fixture))
    report.softwareFixture = { original: softwareFixturePath, originalHash: await hash(softwareFixturePath), importedHash: await hash(fixturePath) }
    assert.ok(!host.argv.includes('--core-cpu-only'), 'Software-profile GUI acceptance requires the production GPU path')
    await recordInput('file.import', { file: fixturePath })
    await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
    await expect(title).toHaveValue(fixture.name, { timeout: 30000 })
    await settle(240000)
    await click('software zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
    await click('software 100% camera', page.getByRole('button', { name: '100%', exact: true }))
    if (await page.locator('.view-menu').getAttribute('open') !== null) await click('close software zoom menu', page.getByLabel('缩放与视图设置', { exact: true }))
    const waitSoftwareProfile = async rasterProfile => {
      await expect.poll(async () => (await stored(fixture.name))?.document.rasterProfile,
        { timeout: 30000 }).toBe(rasterProfile)
      await expect(page.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30000 })
      return await stored(fixture.name)
    }
    const softwareFrame = async () => {
      await settle(240000)
      const presentation = page.locator('.kernel-presentation')
      await expect(presentation).toHaveAttribute('data-presentation-backend', 'gpu')
      await expect(presentation).toHaveAttribute('data-fallback-phase', 'none')
      // Import creates a new workspace document ID. Match the actual persisted
      // document, not the source file's pre-import ID.
      const persisted = await stored(fixture.name)
      assert.ok(persisted)
      await expect(presentation).toHaveAttribute('data-displayed-document', persisted.document.id)
      const frame = await presentation.evaluate(element => ({ ...element.dataset, devicePixelRatio: window.devicePixelRatio }))
      assert.equal(Number(frame.cameraZoom), 1, 'Software-profile acceptance must show the requested 100% camera')
      assert.equal(Number(frame.pixelRatio), frame.devicePixelRatio, 'Software profile must retain physical device-pixel density')
      const tileLayer = page.locator('.kernel-tiles')
      await expect(tileLayer).toHaveAttribute('data-detail-ready', 'true', { timeout: 240000 })
      await expect.poll(async () => tileLayer.evaluate(element =>
        element.dataset.revision === element.dataset.requestedRevision), { timeout: 30000 }).toBe(true)
      const tileState = await tileLayer.evaluate(element => ({ ...element.dataset }))
      assert.equal(tileState.detailReady, 'true', 'The current exact frame must be complete')
      assert.equal(tileState.revision, tileState.requestedRevision, 'A previous profile frame cannot satisfy the check')
      const tiles = await page.locator('canvas[data-frame-visible="true"]').evaluateAll(elements => elements.map(canvas => {
        const box = canvas.getBoundingClientRect()
        return { label: canvas.getAttribute('aria-label'), renderer: canvas.dataset.renderer,
          width: canvas.width, height: canvas.height, cssWidth: box.width, cssHeight: box.height,
          tileKey: canvas.dataset.tileKey, tileZoom: canvas.dataset.tileZoom }
      }))
      assert.ok(tiles.length > 0, 'At least one actual raster canvas must be visible')
      for (const tile of tiles) {
        assert.equal(tile.label, '自研矢量渲染瓦片')
        assert.ok(['webgpu', 'webgl2'].includes(tile.renderer), 'Visible software-profile tiles must use a real GPU backend')
        assert.ok(tile.width > 0 && tile.height > 0 && tile.cssWidth > 0 && tile.cssHeight > 0)
        assert.ok(Math.abs(tile.width - tile.cssWidth * frame.devicePixelRatio) < 0.01, 'No horizontal preview downsampling')
        assert.ok(Math.abs(tile.height - tile.cssHeight * frame.devicePixelRatio) < 0.01, 'No vertical preview downsampling')
      }
      return { frame, tileState, tiles }
    }
    const imported = await waitSoftwareProfile('figmaSoftware')
    assert.ok(imported)
    const imageAssets = document => Object.values(document.nodes).flatMap(node =>
      [...(node.fills || []), ...(node.strokes || []).map(stroke => stroke.paint)]
        .filter(paint => paint?.kind === 'image').map(paint => paint.image)).sort()
    const sourceAssets = imageAssets(fixture)
    assert.deepEqual(imageAssets(imported.document), sourceAssets, 'Native admission and Rust SQLite must retain the original source image bytes')
    if (sourceAssets.length) {
      report.softwareFixture.imageAssets = sourceAssets.map(uri => ({
        encodedBytes: Buffer.byteLength(uri), sha256: createHash('sha256').update(uri).digest('hex'),
      }))
      checked('source bitmap assets survive actual native admission and Rust SQLite without byte changes')
    }
    const importedFrame = await softwareFrame()
    await click('software file menu', page.locator('button.brand'))
    const quality = page.getByRole('group', { name: '文件渲染质量', exact: true })
    const softwareButton = quality.getByRole('button', { name: 'Figma 导出兼容', exact: true })
    const previousButton = quality.getByRole('button', { name: '精细（更耗内存）', exact: true })
    await expect(softwareButton).toHaveAttribute('aria-pressed', 'true')
    await expect(previousButton).toHaveAttribute('aria-pressed', 'false')
    await page.screenshot({ path: path.join(output, '05-software-profile-imported.png') })
    checked('software fixture opens with its saved Figma export profile selected and real full-density GPU pixels')
    await click('switch to previous Figma profile', previousButton)
    await expect(previousButton).toHaveAttribute('aria-pressed', 'true')
    await expect(softwareButton).toHaveAttribute('aria-pressed', 'false')
    const previous = await waitSoftwareProfile('figma')
    assert.deepEqual(previous.document, { ...imported.document, rasterProfile: 'figma' })
    assert.ok(previous.revision > imported.revision)
    const previousFrame = await softwareFrame()
    await page.screenshot({ path: path.join(output, '06-software-profile-previous.png') })
    await click('restore Figma export compatibility', softwareButton)
    await expect(softwareButton).toHaveAttribute('aria-pressed', 'true')
    await expect(previousButton).toHaveAttribute('aria-pressed', 'false')
    const restored = await waitSoftwareProfile('figmaSoftware')
    assert.deepEqual(restored.document, imported.document)
    assert.ok(restored.revision > previous.revision)
    const restoredFrame = await softwareFrame()
    await page.screenshot({ path: path.join(output, '07-software-profile-restored.png') })
    checked('real file-menu profile switches persist as distinct Rust SQLite revisions and complete current GPU frames')
    await click('close software file menu', page.locator('button.brand'))
    await key('Meta+S')
    saved = await waitSoftwareProfile('figmaSoftware')
    const beforeReload = saved
    await page.reload()
    await expect(title).toHaveValue(fixture.name, { timeout: 30000 })
    saved = await waitSoftwareProfile('figmaSoftware')
    assert.deepEqual(saved.document, beforeReload.document)
    assert.equal(saved.revision, beforeReload.revision)
    const reloadedFrame = await softwareFrame()
    await click('reloaded software file menu', page.locator('button.brand'))
    await expect(softwareButton).toHaveAttribute('aria-pressed', 'true')
    await expect(previousButton).toHaveAttribute('aria-pressed', 'false')
    await page.screenshot({ path: path.join(output, '08-software-profile-reloaded.png') })
    report.softwareProfile = { importedRevision: imported.revision, previousRevision: previous.revision,
      restoredRevision: restored.revision, savedRevision: saved.revision,
      importedFrame, previousFrame, restoredFrame, reloadedFrame,
      scope: 'Actual menu input, current GPU presentation, canvas density and Rust SQLite profile persistence; no frame-rate or external Figma pixel-parity claim.' }
    report.renderer = await page.locator('.kernel-status').allTextContents()
    checked('renderer reload keeps the software profile, its selected menu state and exact device-pixel density')
  }
  assert.deepEqual(errors, [])
  report.zoomTrace = await page.evaluate(() => window.__nativeZoomTrace || [])
  await closeOwned()
  const database = path.join(profile, 'workspace-v1.sqlite3')
  const sqliteBytes = await readFile(database)
  assert.equal(sqliteBytes.subarray(0, 16).toString(), 'SQLite format 3\0')
  const recovery = path.join(output, 'independent-readback-recovery'); await mkdir(recovery, { mode: 0o700 })
  probe = new Sidecar(sidecarBinary, recovery, { workspaceDb: database })
  const health = await probe.request('health'); assert.equal(health.protocolVersion, 1)
  const reopened = await probe.request('workspace.open', { id: saved.id })
  assert.deepEqual(reopened.document, saved.document); assert.equal(reopened.revision, saved.revision)
  if(kernelSaved){const k=await probe.request('workspace.open',{id:kernelSaved.id});assert.deepEqual(k.document,kernelSaved.document);report.kernelAdoption={id:k.id,revision:k.revision,schemaVersion:k.document.schemaVersion};checked('independent Rust process retains schema 9 and every kernel-adoption document field')}
  assert.equal(await probe.stop(), true); probe = undefined
  report.sqlite = { path: database, bytes: (await stat(database)).size, id: reopened.id, revision: reopened.revision, hash: reopened.hash }
  await writeFile(path.join(output, 'sqlite-reopened.fd'), JSON.stringify(reopened.document, null, 2))
  checked('independent bundled Rust process rereads the real SQLite file after Electron closes')
  assert.equal(await hash(archive), identities.archive); assert.equal(await hash(sidecarBinary), identities.sidecar)
  report.status = 'passed'
} catch (error) {
  try { report.zoomTrace = await page?.evaluate(() => window.__nativeZoomTrace || []) } catch {}
  report.status = 'failed'; report.error = String(error)
  report.failurePolicy = 'No older-bundle fallback, no sandbox changes, no attachment to existing applications'
  if (page && !page.isClosed()) {
    report.diagnosticInputs = await page.evaluate(() => ({ events: window.__nativeInputEvidence, cameras: window.__formaHdrCameraEvidence })).catch(() => null)
    report.failureUI = { url: page.url(), body: await page.locator('body').innerText().catch(() => 'unavailable') }
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  }
  process.exitCode = 1
} finally {
  if (probe) await probe.stop().catch(error => errors.push(String(error)))
  if (!closed) await closeOwned().catch(error => { errors.push(String(error)); report.status = 'failed'; process.exitCode = 1 })
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'host.log'), logs.join(''))
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ output, status: report.status, checks: checks.length, inputs: inputs.length, error: report.error }))
}
