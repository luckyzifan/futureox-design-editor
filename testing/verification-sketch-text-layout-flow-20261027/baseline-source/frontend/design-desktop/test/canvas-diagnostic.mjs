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
import { buildInputs } from '../scripts/build-inputs.mjs'
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
for (const arg of args) assert.ok(arg === '--cache-probe' || /^--(?:app|output|hdr-fixture|software-fixture)=.+$/.test(arg), `Unknown argument: ${arg}`)
const option = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const hdrFixturePath = option('hdr-fixture')
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
let app, page, probe, profile, saved, closed = false
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
  await page.evaluate(()=>{
    window.__canvasInputEvidence=[]
    for(const type of ['keydown','keyup','pointerdown','pointerup'])document.addEventListener(type,event=>{
      const el=event.target
      window.__canvasInputEvidence.push({type,key:event.key,code:event.code,trusted:event.isTrusted,buttons:event.buttons,x:event.clientX,y:event.clientY,shift:event.shiftKey,alt:event.altKey,meta:event.metaKey,ctrl:event.ctrlKey,target:el.tagName,aria:el.getAttribute?.('aria-label'),title:el.closest?.('button')?.getAttribute('title'),testid:el.closest?.('[data-testid]')?.getAttribute('data-testid'),canvas:document.querySelector('[data-testid="canvas"]')?.className})
    },true)
  })
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
  await click('document name', title); await key('Meta+A')
  await recordInput('keyboard.type', { value: authoredName }); await page.keyboard.type(authoredName); await key('Enter')
  // Deliberately start the next gesture without waiting for rename rendering.
  // Initial startup is settled above; pending revisions must not discard input.
  await draw('o', await point(0.17, 0.22), await point(0.36, 0.40))
  let current = await saveCount(1)
  const ellipse = Object.values(current.document.nodes)[0]
  assert.equal(ellipse.kind, 'ellipse'); assert.equal(ellipse.network, undefined)
  await draw('r', await point(0.60, 0.24), await point(0.79, 0.42))
  current = await saveCount(2)
  const rectangle = Object.values(current.document.nodes).find(node => node.id !== ellipse.id)
  await writeFile(path.join(output,'actual-draw.fd'),JSON.stringify(current.document,null,2))
  await writeFile(path.join(output,'observed-events.json'),JSON.stringify(await page.evaluate(()=>window.__canvasInputEvidence),null,2))
  assert.equal(rectangle.kind, 'rectangle')
  checked('real Electron keyboard/mouse creates native ellipse and rectangle in actual Rust SQLite')
  await page.screenshot({ path: path.join(output, '01-created-shapes.png') })
  report.status='passed'
  await closeOwned()

} catch (error) {
  report.status = 'failed'; report.error = String(error)
  report.failurePolicy = 'No older-bundle fallback, no sandbox changes, no attachment to existing applications'
  if (page && !page.isClosed()) {
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
