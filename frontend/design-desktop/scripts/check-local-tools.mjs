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
let app, page, probe, peerApp, profile, saved, kernelSaved, closed = false
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
  scope: `Fresh packaged Electron window using ${hdrFixturePath ? 'the production GPU renderer with a real pending HDR frame' : softwareFixturePath ? 'the production GPU renderer with software-profile menu and persistence checks' : 'the production renderer without an HDR workload'}, real Playwright renderer mouse/keyboard, unmodified preload/host and real bundled Rust/SQLite. Not physical stylus/trackpad, Finder or frame-rate acceptance.`,
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
    executablePath: executable, args: ['--desktop-gui-test'], cwd: path.dirname(executable),
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
  const authoredName = `Electron Tools ${runId.slice(0, 8)}`
  let activeName=authoredName
  const stored = (name = activeName) => page.evaluate(async name => {
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
  await click('document name',title);await key('Meta+A');await page.keyboard.type(authoredName);await key('Enter');await canvas.focus();await key('Meta+A');await key('Backspace');await saveCount(0)
  const savedWhen=async check=>{await expect.poll(async()=>check((await stored())?.document),{timeout:20000}).toBe(true);await settle();return (await stored()).document}
  const at=async(x,y)=>{const box=await canvas.boundingBox();return{x:box.x+x,y:box.y+y}}
  const dragTool=async(a,b)=>{await mouse('move',a);await mouse('down',{});await mouse('move',b,{steps:10});await mouse('up',{})}
  const menu=async(group,label,radio=false)=>{await click(group,page.getByRole('button',{name:group,exact:true}));await click(label,page.getByRole(radio?'menuitemradio':'menuitem',{name:label,exact:true}));if(label==='代码块'){await expect(canvas).toHaveClass(/canvas-code-block/);await expect(canvas).toHaveAttribute('aria-busy','false',{timeout:45000})}}
  await key('r');await dragTool(await at(160,140),await at(320,260));let doc=await savedWhen(d=>Object.keys(d?.nodes||{}).length===1);const rectangle=Object.values(doc.nodes)[0]
  checked('rectangle created through actual input and persisted')
  // Exercise rendered hit regions through trusted input, then inspect the
  // document saved by Rust. No Editor/model mutation is used by these checks.
  const cornerPoint=async index=>page.getByTestId(`rotate-corner-${index}`).evaluate(el=>{
    const p=new DOMPoint(Number(el.getAttribute('data-anchor-x')),Number(el.getAttribute('data-anchor-y'))).matrixTransform(el.getScreenCTM())
    return{x:p.x,y:p.y}
  })
  const rotatePointer=async(index,degrees,shift=false)=>{
    const start=await cornerPoint(index),corners=await page.locator('.selection > polygon').first().evaluate(el=>{
      const m=el.getScreenCTM();return[...el.points].map(p=>new DOMPoint(p.x,p.y).matrixTransform(m)).map(p=>({x:p.x,y:p.y}))
    }),c={x:corners.reduce((s,p)=>s+p.x,0)/4,y:corners.reduce((s,p)=>s+p.y,0)/4},r=degrees*Math.PI/180
    const end={x:c.x+(start.x-c.x)*Math.cos(r)-(start.y-c.y)*Math.sin(r),y:c.y+(start.x-c.x)*Math.sin(r)+(start.y-c.y)*Math.cos(r)}
    await mouse('move',start)
    assert.equal(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.getAttribute('data-testid'),start),`rotate-corner-${index}`)
    assert.match(await page.getByTestId(`rotate-corner-${index}`).evaluate(el=>getComputedStyle(el).cursor),/data:image\/svg\+xml/)
    await mouse('down',{});if(shift)await modifier('Shift',true);await mouse('move',end,{steps:10})
    await expect(page.getByTestId('rotation-feedback')).toBeVisible();await mouse('up',{});if(shift)await modifier('Shift',false)
  }
  for(let corner=0;corner<4;corner++){
    await rotatePointer(corner,90)
    const rotated=await savedWhen(d=>Math.abs(d?.nodes[rectangle.id]?.transform[1]-1)<1e-8),n=rotated.nodes[rectangle.id]
    assert.equal(n.width,rectangle.width);assert.equal(n.height,rectangle.height)
    assert.ok(Math.abs(n.transform[4]+n.transform[0]*n.width/2+n.transform[2]*n.height/2-(rectangle.transform[4]+rectangle.width/2))<1e-8)
    assert.ok(Math.abs(n.transform[5]+n.transform[1]*n.width/2+n.transform[3]*n.height/2-(rectangle.transform[5]+rectangle.height/2))<1e-8)
    if(corner===0)await page.screenshot({path:path.join(output,'05-corner-rotation.png')})
    await key('Meta+z');await savedWhen(d=>JSON.stringify(d?.nodes[rectangle.id])===JSON.stringify(rectangle))
  }
  checked('all four exterior corners hover with oriented cursors, rotate around the center and undo exactly once')
  await page.getByLabel('旋转 °',{exact:true}).fill('17');await page.getByLabel('旋转 °',{exact:true}).press('Enter')
  await savedWhen(d=>Math.abs(d?.nodes[rectangle.id]?.transform[1]+Math.sin(17*Math.PI/180))<1e-8)
  await rotatePointer(1,28,true)
  await savedWhen(d=>Math.abs(d?.nodes[rectangle.id]?.transform[1]-Math.sin(15*Math.PI/180))<1e-8)
  await key('Meta+z');await savedWhen(d=>Math.abs(d?.nodes[rectangle.id]?.transform[1]+Math.sin(17*Math.PI/180))<1e-8)
  await key('Meta+z');await savedWhen(d=>JSON.stringify(d?.nodes[rectangle.id])===JSON.stringify(rectangle))
  checked('Shift snaps resulting rotation to 15 degrees from an existing 17-degree orientation')
  const edge=await page.getByTestId('resize-edge-1').boundingBox(),densityView=await page.locator('.kernel-presentation').getAttribute('data-camera-zoom')
  assert.ok(edge);const edgeStart={x:edge.x+edge.width/2,y:edge.y+edge.height/2}
  await dragTool(edgeStart,{x:edgeStart.x+40*Number(densityView),y:edgeStart.y+20*Number(densityView)})
  await savedWhen(d=>Math.abs(d?.nodes[rectangle.id]?.width-rectangle.width-40)<1e-8&&Math.abs(d?.nodes[rectangle.id]?.height-rectangle.height)<1e-8)
  await key('Meta+z');await savedWhen(d=>JSON.stringify(d?.nodes[rectangle.id])===JSON.stringify(rectangle))
  checked('dragging a selection edge resizes only its local axis and restores exact geometry with Undo')
  await canvas.focus();await key('i');const samplePoint=await at(50,50);await mouse('move',samplePoint);
  // GPU pixel sampling completes asynchronously through the render worker.
  // Wait for each published marker, without relaxing the device-pixel delta.
  await expect.poll(async()=>{const b=await page.getByTestId('color-sample-point').boundingBox();return b&&Math.abs(b.x+b.width/2-samplePoint.x)}).toBeLessThan(0.02)
  const sampleBefore=await page.getByTestId('color-sample-point').boundingBox();await key('ArrowRight');
  const sampleDpr=await page.evaluate(()=>devicePixelRatio)
  await expect.poll(async()=>{const b=await page.getByTestId('color-sample-point').boundingBox();return b&&Math.abs(b.x-sampleBefore.x-1/sampleDpr)}).toBeLessThan(0.02)
  await key('Enter');await savedWhen(d=>d?.nodes[rectangle.id]?.fills[0].color==='#f5f5f5');await selection(rectangle.id);checked('I eyedropper samples the actual published pixel; arrow keys move by one device pixel and Enter applies without changing selection')
  await canvas.focus();await key('Meta+z');await savedWhen(d=>d?.nodes[rectangle.id]?.fills[0].color===rectangle.fills[0].color)
  await click('property eyedropper',page.getByRole('button',{name:'吸取颜色',exact:true}));await mouse('move',await at(60,60));await mouse('click',await at(60,60));await savedWhen(d=>d?.nodes[rectangle.id]?.fills[0].color==='#f5f5f5');checked('property eyedropper writes only the requested color through real canvas input')
  await canvas.focus();await key('Meta+z');await savedWhen(d=>d?.nodes[rectangle.id]?.fills[0].color===rectangle.fills[0].color)
  const beforeCancel=(await stored()).revision;await key('i');await key('Escape');await expect(canvas).toHaveClass(/canvas-select/);assert.equal((await stored()).revision,beforeCancel);checked('Escape cancels the canvas picker without creating a revision')
  await key('Escape');await selection();const noSelection=(await stored()).document
  const oldClipboard=await page.evaluate(()=>window.coreDesktop.clipboard.read())
  try{
    await key('i');await mouse('move',await at(50,50));await expect(page.locator('.canvas-color-pick-hint')).toContainText('#F5F5F5')
    await key('Tab');await expect(page.locator('.canvas-color-pick-hint')).toContainText('rgb(245, 245, 245)')
    await mouse('click',await at(50,50));await expect(canvas).toHaveClass(/canvas-select/)
    await expect.poll(()=>page.evaluate(async()=>(await window.coreDesktop.clipboard.read()).text)).toBe('rgb(245, 245, 245)')
    assert.deepEqual((await stored()).document,noSelection)
    await key('i');await mouse('move',await at(50,50));await key('Tab');await expect(page.locator('.canvas-color-pick-hint')).toContainText('hsl(0, 0%, 96%)')
    await key('Tab');await expect(page.locator('.canvas-color-pick-hint')).toContainText('hsb(0, 0%, 96%)')
    await key('Tab');await expect(page.locator('.canvas-color-pick-hint')).toContainText('#F5F5F5');await key('Escape')
    checked('unselected eyedropper copies the sampled value to the real clipboard; Tab cycles HEX/RGB/HSL/HSB without document edits')
  }finally{
    if(oldClipboard.status==='ok')await page.evaluate(value=>window.coreDesktop.clipboard.write(value),Object.fromEntries(Object.entries(oldClipboard).filter(([key])=>['text','svg','image','forma'].includes(key))))
  }
  await click('restore rectangle selection',page.getByTestId(`layer-${rectangle.id}`));await selection(rectangle.id)
  await canvas.focus();await key('s');await dragTool(await at(145,125),await at(335,275));doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.kind==='slice'));const slice=Object.values(doc.nodes).find(n=>n.kind==='slice');assert.equal(doc.schemaVersion,10);assert.deepEqual(slice.fills,[])
  await click('add slice export',page.getByRole('button',{name:'添加图层导出设置',exact:true}));await click('generate slice',page.getByRole('button',{name:'预览并导出此图层',exact:true}));await expect(page.getByAltText('图层导出预览 1')).toBeVisible({timeout:45000});await page.screenshot({path:path.join(output,'01-slice-export.png')});checked('slice retains geometry and exports covered artwork')
  const exported = {}, decoded = {}
  for(const format of ['png','webp','jpeg','pdf']) {
    if(format!=='png') {
      await recordInput('select export format',{format})
      await page.getByLabel('导出格式 1',{exact:true}).selectOption(format)
      await savedWhen(d=>d?.nodes[slice.id]?.exportSettings?.[0]?.format===format)
      await click('generate '+format,page.getByRole('button',{name:'预览并导出此图层',exact:true}))
    }
    const link=page.locator('.node-export-preview a')
    await expect(link).toHaveCount(1,{timeout:45000})
    const extension=format==='jpeg'?'jpg':format
    const destination=path.join(output,'slice-export.'+extension)
    // Keep production CSP and download admission intact. This test supplies an
    // owned destination through DownloadItem; native picker UX is a separate check.
    await app.evaluate(({BrowserWindow},destination)=>{
      const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('design-app:'))
      globalThis.__formaDownload=new Promise((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(Error('Export download timed out')),30000)
        window.webContents.session.once('will-download',(_event,item)=>{
          if(!item.getURL().startsWith('blob:design-app://app/')){clearTimeout(timeout);reject(Error('Unexpected export origin'));return}
          item.setSavePath(destination)
          item.once('done',(_event,state)=>{clearTimeout(timeout);state==='completed'?resolve(state):reject(Error('Export '+state))})
        })
      });void globalThis.__formaDownload.catch(()=>{})
    },destination)
    await click('save exported '+format,link)
    await app.evaluate(async()=>{await globalThis.__formaDownload;delete globalThis.__formaDownload})
    exported[format]=await readFile(destination)
    const bytes=[...exported[format]]
    if(format==='pdf') assert.ok(exported.pdf.subarray(0,8).toString().startsWith('%PDF-1.4'))
    else {
      const preview=page.locator('.node-export-preview img')
      await expect.poll(()=>preview.evaluate(img=>img.complete&&img.naturalWidth>0),{timeout:15000}).toBe(true)
      const image=await preview.evaluate(img=>{const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {width:c.width,height:c.height,rgba:Array.from(ctx.getImageData(0,0,c.width,c.height).data)}})
      const size={width:image.width,height:image.height};decoded[format]=Buffer.from(image.rgba)
      assert.ok(size.width>0&&size.height>0&&decoded[format].some((v,i)=>i%4===3&&v>0))
      if(format==='png')report.exportSize=size
      else assert.deepEqual(size,report.exportSize)
      if(format==='webp'){assert.equal(exported.webp.subarray(0,4).toString(),'RIFF');assert.equal(exported.webp.subarray(8,12).toString(),'WEBP')}
      if(format==='jpeg')assert.deepEqual([...exported.jpeg.subarray(0,2)],[255,216])
    }
    checked('desktop '+format+' export runs through the actual layer inspector and Rust encoder')
  }
  const webpEqual=decoded.png.equals(decoded.webp)
  assert.equal(webpEqual,true);checked('lossless WebP decoded pixels equal the PNG exported by the same UI')
  await expect(page.getByRole('heading',{name:'外观',exact:true})).toHaveCount(0)
  await page.getByLabel('导出格式 1',{exact:true}).selectOption('png')
  await page.getByLabel('旋转 °',{exact:true}).fill('90');await page.getByLabel('旋转 °',{exact:true}).press('Enter')
  await savedWhen(d=>Math.abs(d?.nodes[slice.id]?.transform[1]+1)<1e-8)
  await click('generate rotated slice',page.getByRole('button',{name:'预览并导出此图层',exact:true}))
  await expect.poll(()=>page.locator('.node-export-preview img').evaluate(img=>img.complete?{width:img.naturalWidth,height:img.naturalHeight}:null),{timeout:45000}).toEqual(report.exportSize)
  await canvas.focus();await key('Meta+z');await savedWhen(d=>Math.abs(d?.nodes[slice.id]?.transform[1])<1e-8)
  checked('rotated slice exports in its own axes and inspector omits non-painting properties')
  await canvas.focus();await key('c');await mouse('click',await at(380,140));await page.getByLabel('评论正文').fill('本地评论：验证 Rust SQLite');await click('save comment',page.getByRole('button',{name:'保存评论',exact:true}));await savedWhen(d=>d?.reviews?.length===1)
  await page.getByLabel('回复正文').fill('回复保留在自有格式');await click('reply',page.getByRole('button',{name:'保存回复',exact:true}));await savedWhen(d=>d?.reviews?.[0]?.messages.length===2);await click('resolve',page.getByRole('button',{name:'标为已解决',exact:true}));await savedWhen(d=>d?.reviews?.[0]?.resolved===true);await page.screenshot({path:path.join(output,'02-local-reviews.png')});await click('close comments',page.getByRole('button',{name:'关闭评论',exact:true}));checked('local comment, reply and resolution persist')
  const boardCases=[['便签','sticky'],['表格','table'],['代码块','code-block'],['白板矩形','shape-whiteboard-square'],['白板椭圆','shape-whiteboard-ellipse'],['白板圆角矩形','shape-whiteboard-rounded-rectangle'],['白板上三角','shape-whiteboard-triangle-up'],['白板下三角','shape-whiteboard-triangle-down'],['白板菱形','shape-whiteboard-diamond'],['响应式套件','sites-responsive-set']]
  for(const [label,kind] of boardCases){const before=await stored();await menu('排列与编辑',label);await dragTool(await at(400,180),await at(580,330));doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.board?.kind===kind));const root=Object.values(doc.nodes).find(n=>n.board?.kind===kind);assert.ok(root.children.length);if(kind==='code-block'){const text=doc.nodes[root.children[0]];assert.ok(/Menlo|Monaco|Mono|Consolas|Courier/i.test(doc.fonts[text.textStyle.fontId].family));await page.getByLabel('代码语言',{exact:true}).selectOption('rust');await page.getByLabel('文字内容',{exact:true}).fill('fn main() { let answer = 42; }');await page.getByLabel('文字内容',{exact:true}).press('Tab');await savedWhen(d=>d?.nodes[root.id]?.board.language==='rust'&&d.nodes[text.id].textRuns?.some(r=>r.color==='#ff7b72'));checked('code block retains its local monospace font and Rust lexical colors')}if(kind==='table'){await page.getByLabel('表格行数',{exact:true}).fill('4');await page.getByLabel('表格行数',{exact:true}).press('Enter');await savedWhen(d=>d?.nodes[root.id]?.children.length===12)}await canvas.focus();await key('Meta+z');if(kind==='table')await key('Meta+z');if(kind==='code-block'){await key('Meta+z');await key('Meta+z')}await savedWhen(d=>JSON.stringify(d?.nodes)===JSON.stringify(before.document.nodes));checked(label+' creates editable content and undoes')}
  await menu('绘图工具','马克笔',true);await dragTool(await at(400,360),await at(540,420));doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.name==='马克笔路径'));const marker=Object.values(doc.nodes).find(n=>n.name==='马克笔路径');assert.equal(marker.opacity,.4);assert.equal(marker.strokes[0].width,24);checked('marker has independent width and opacity')
  await menu('绘图工具','橡皮');await dragTool(await at(450,380),await at(505,403));await savedWhen(d=>!!d&&!d.nodes[marker.id]);await canvas.focus();await key('Meta+z');await savedWhen(d=>!!d?.nodes[marker.id]);checked('eraser removes strokes and undo restores them')
  await canvas.focus();await key('l');await dragTool(await at(170,380),await at(330,380));doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.kind==='line'));const line=Object.values(doc.nodes).find(n=>n.kind==='line')
  await menu('绘图工具','弯折');await dragTool(await at(250,380),await at(250,430));doc=await savedWhen(d=>!!d?.nodes[line.id]?.network?.edges[0]?.c1);assert.equal(doc.nodes[line.id].kind,'vector');checked('bend edits native cubic handles')
  await menu('绘图工具','裁切路径');await mouse('click',await at(250,430));await savedWhen(d=>d?.nodes[line.id]?.network?.edges.length===2);checked('cut splits cubic topology')
  await canvas.focus();await key('v');await click('rectangle layer',page.getByTestId('layer-'+rectangle.id));await menu('绘图工具','油漆桶');const cp=await center(rectangle);await mouse('click',cp);await savedWhen(d=>d?.nodes[rectangle.id]?.network?.filledFaces?.length===0);await mouse('click',cp);await savedWhen(d=>d?.nodes[rectangle.id]?.network?.filledFaces?.length===1);checked('paint bucket toggles an enclosed region')
  await menu('绘图工具','偏移路径');await dragTool(cp,{x:cp.x+10,y:cp.y});await savedWhen(d=>d?.nodes[rectangle.id]?.pathOffset>0);checked('path offset is retained and editable')
  await canvas.focus();await key('v');await click('rectangle layer',page.getByTestId('layer-'+rectangle.id));await menu('绘图工具','路径文本');await mouse('click',cp);doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.textPath));const text=Object.values(doc.nodes).find(n=>n.textPath);await page.getByLabel('文字内容',{exact:true}).fill('Forma 路径文字');await page.getByLabel('文字内容',{exact:true}).press('Tab');await savedWhen(d=>d?.nodes[text.id]?.text==='Forma 路径文字');await page.screenshot({path:path.join(output,'03-path-text.png')});checked('path text shapes and saves the actual edited string')
  await menu('绘图工具','和纸胶带',true);await dragTool(await at(400,455),await at(535,455));doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.name==='和纸胶带'));const tape=Object.values(doc.nodes).find(n=>n.name==='和纸胶带');assert.equal(tape.strokes[0].cap,'square');assert.equal(tape.effects[0].kind,'noise');checked('washi tape retains its own stroke and material parameters')
  await menu('排列与编辑','标注');await mouse('click',await at(760,380));await page.getByLabel('评论正文').fill('本地标注');await click('save annotation',page.getByRole('button',{name:'保存标注',exact:true}));await savedWhen(d=>d?.reviews?.some(r=>r.kind==='annotation'));await click('close annotation',page.getByRole('button',{name:'关闭评论',exact:true}));checked('annotation pin persists as metadata')
  const rectangleIds=new Set(Object.keys((await stored()).document.nodes));await canvas.focus();await key('r');await dragTool(await at(450,520),await at(530,580));await savedWhen(d=>Object.keys(d?.nodes||{}).some(id=>!rectangleIds.has(id)));let firstDoc=await stored();const a=Object.values(firstDoc.document.nodes).find(n=>!rectangleIds.has(n.id));rectangleIds.add(a.id)
  await canvas.focus();await key('r');await dragTool(await at(630,520),await at(710,580));doc=await savedWhen(d=>Object.keys(d?.nodes||{}).some(id=>!rectangleIds.has(id)));const b=Object.values(doc.nodes).find(n=>!rectangleIds.has(n.id))
  await canvas.focus();await key('v');await mouse('click',await at(760,60));await menu('绘图工具','多选');await mouse('click',await center(a));await mouse('click',await center(b));await selection(a.id,b.id);const beforeLasso=await stored()
  await menu('绘图工具','套索');await mouse('move',await at(430,500));await mouse('down',{});for(const p of [[550,500],[550,600],[430,600],[430,500]])await mouse('move',await at(...p),{steps:5});await mouse('up',{});await selection(a.id);assert.equal((await stored()).revision,beforeLasso.revision);checked('multiselect toggles layers and freeform lasso changes selection without saving geometry')
  await menu('绘图工具','套索');await mouse('move',await at(430,500));await mouse('down',{});for(const p of [[550,500],[550,600],[430,600],[430,500]])await mouse('move',await at(...p),{steps:5});await mouse('up',{});await expect(canvas).toHaveClass(/canvas-vector/);await key('Shift+ArrowRight');doc=await savedWhen(d=>d?.nodes[a.id]?.kind==='vector');assert.equal(doc.nodes[a.id].network.vertices.length,4);assert.ok(Math.abs(Math.min(...doc.nodes[a.id].network.vertices.map(v=>v.x))-10)<1e-8);await key('Meta+z');await savedWhen(d=>d?.nodes[a.id]?.kind==='rectangle');checked('lasso-selected vertices move as one group through Rust and undo restores the native shape')
  for(const [label,style] of [['直线连接器','straight'],['折线连接器','elbow']]){
    const current=(await stored()).document,zoom=+(await page.locator('.kernel-presentation').getAttribute('data-camera-zoom')),ca=await center(current.nodes[a.id]),cb=await center(current.nodes[b.id]);await menu('排列与编辑',label)
    await dragTool({x:ca.x+current.nodes[a.id].width*zoom/2-1,y:ca.y},{x:cb.x-current.nodes[b.id].width*zoom/2+1,y:cb.y})
    doc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.connector?.style===style));const connector=Object.values(doc.nodes).find(n=>n.connector?.style===style);assert.equal(connector.connector.from.nodeId,a.id);assert.equal(connector.connector.to.nodeId,b.id);const before=connector.transform[4]+connector.network.vertices.at(-1).x
    await click('move connector target',page.getByTestId('layer-'+b.id));await key('Shift+ArrowRight');doc=await savedWhen(d=>d?.nodes[b.id]?.transform[4]===current.nodes[b.id].transform[4]+10);const moved=doc.nodes[connector.id];assert.ok(Math.abs(moved.transform[4]+moved.network.vertices.at(-1).x-before-10)<1e-8);checked(label+' attaches to shapes and follows actual keyboard movement')
  }
  await menu('排列与编辑','测量');const beforeMeasure=await stored(),measureZoom=+(await page.locator('.kernel-presentation').getAttribute('data-camera-zoom'));assert.ok(measureZoom>0);await dragTool(await at(350,80),await at(470,170));await expect(page.getByTestId('utility-gesture')).toContainText((150/measureZoom).toFixed(2));assert.equal((await stored()).revision,beforeMeasure.revision);await key('Escape');checked('measurement does not write a document revision')
  await canvas.focus();await key('Meta+s');await settle()
  const cameraBefore=await page.locator('.kernel-presentation').evaluate(e=>({x:e.dataset.cameraX,y:e.dataset.cameraY,zoom:e.dataset.cameraZoom}))
  const beforePeer=(await stored()).document,peerNonce=randomUUID()
  peerApp=await _electron.launch({executablePath:executable,args:[`--local-peer=${peerNonce}`],env:{...env,TMPDIR:profileRoot,FORMA_LOCAL_WORKSPACE_ROOT:profile,FORMA_LOCAL_DOCUMENT_ID:beforePeer.id},chromiumSandbox:true,timeout:45000})
  const peerPage=await peerApp.firstWindow();peerPage.on('pageerror',e=>errors.push(String(e)));await expect(peerPage.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:45000});await expect(peerPage.getByLabel('文档名称',{exact:true})).toHaveValue(authoredName)
  const peerHost=await peerApp.evaluate(({app,BrowserWindow})=>({profile:app.getPath('userData'),preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}));assert.ok(path.relative(profile,await realpath(peerHost.profile)).startsWith('local-window-'));for(const k of ['sandbox','contextIsolation','webSecurity'])assert.equal(peerHost.preferences[k],true)
  await expect(page.locator('[data-local-peers]')).toHaveAttribute('data-local-peers','1',{timeout:15000});await expect(peerPage.locator('[data-local-peers]')).toHaveAttribute('data-local-peers','1',{timeout:15000})
  await peerPage.getByTestId('layer-'+b.id).click();await peerPage.keyboard.press('Shift+ArrowRight');await expect(peerPage.locator('.save-status')).toHaveText('已保存到本机',{timeout:15000})
  const remoteX=beforePeer.nodes[b.id].transform[4]+10;await savedWhen(d=>d?.nodes[b.id]?.transform[4]===remoteX)
  await expect.poll(async()=>Number(await page.getByLabel('X',{exact:true}).inputValue()),{timeout:15000}).toBe(remoteX);await settle();assert.deepEqual(await page.locator('.kernel-presentation').evaluate(e=>({x:e.dataset.cameraX,y:e.dataset.cameraY,zoom:e.dataset.cameraZoom})),cameraBefore)
  const peerBox=await peerPage.getByTestId('canvas').boundingBox();await peerPage.mouse.move(peerBox.x+100,peerBox.y+100);await expect(page.locator('[data-peer-id]')).toHaveCount(1,{timeout:15000});await expect(page.locator(`[data-peer-selection="${b.id}"]`)).toHaveCount(1,{timeout:15000});await page.screenshot({path:path.join(output,'04-local-windows.png')});checked('two real sandboxed windows share Rust SQLite, refresh a clean edit and retain the camera; peer cursor and selection are visible')
  await peerApp.close();peerApp=null;await expect(page.locator('[data-local-peers]')).toHaveAttribute('data-local-peers','0',{timeout:15000});checked('closing the owned peer removes its local presence')
  await expect(page.locator('.kernel-presentation')).toHaveAttribute('data-presentation-backend','gpu');await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-renderer','webgpu');await expect(page.locator('.kernel-tiles')).toHaveAttribute('data-detail-ready','true');const density=await page.locator('.kernel-presentation').getAttribute('data-pixel-ratio');assert.equal(Number(density),await page.evaluate(()=>devicePixelRatio));checked('actual WebGPU preview retains the complete device pixel density')
  // Exercise the new canvas surface in a separate FD document through its real
  // import control. Persistence still goes through the bundled Rust/SQLite host.
  const fixture=structuredClone((await stored()).document),ids=[randomUUID(),randomUUID(),randomUUID()]
  fixture.id=randomUUID();fixture.name=`Electron Alignment ${runId.slice(0,8)}`;fixture.schemaVersion=11
  fixture.pages=[{id:randomUUID(),name:'Alignment',children:ids,background:'#f5f5f5'}]
  fixture.nodes=Object.fromEntries(ids.map((id,i)=>[id,{...structuredClone(rectangle),id,name:`Alignment ${i+1}`,width:60,height:60,transform:[1,0,0,1,70+i*100,80],fills:[{...rectangle.fills[0],color:i===0?'#b531f7':'#33aacc'}]}]))
  for(const field of ['prototype','animations','reviews','designSystem'])delete fixture[field]
  const fixturePath=path.join(output,'alignment.fd');await writeFile(fixturePath,JSON.stringify(fixture));activeName=fixture.name
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixturePath)
  await expect(title).toHaveValue(activeName);await savedWhen(d=>d?.name===fixture.name&&ids.every(id=>!!d.nodes[id]));await canvas.focus();await key('Meta+a');await selection(...ids);await settle()
  const handlePoint=async locator=>{const b=await locator.boundingBox();assert.ok(b);return{x:b.x+b.width/2,y:b.y+b.height/2}}
  let view=await page.locator('.kernel-presentation').evaluate(e=>({zoom:+e.dataset.cameraZoom,x:+e.dataset.cameraX,y:+e.dataset.cameraY}))
  let start=await handlePoint(page.getByTestId('smart-gap-x').first())
  await dragTool(start,{x:start.x+20*view.zoom,y:start.y});await savedWhen(d=>d?.nodes[ids[1]]?.transform[4]===190&&d?.nodes[ids[2]]?.transform[4]===310)
  await key('Meta+z');await savedWhen(d=>d?.nodes[ids[1]]?.transform[4]===170)
  start=await handlePoint(page.locator(`[data-testid="smart-reorder"][data-node-id="${ids[0]}"]`));const last=await handlePoint(page.locator(`[data-testid="smart-reorder"][data-node-id="${ids[2]}"]`))
  await dragTool(start,last);await savedWhen(d=>d?.nodes[ids[0]]?.transform[4]===270&&d?.nodes[ids[1]]?.transform[4]===70)
  assert.deepEqual((await stored()).document.pages[0].children,ids);await key('Meta+z');await savedWhen(d=>d?.nodes[ids[0]]?.transform[4]===70)
  checked('smart spacing and centre reorder run in actual Electron WebGPU; layers keep their hierarchy and undo restores positions')
  const savedClipboard=await page.evaluate(()=>window.coreDesktop.clipboard.read())
  try{
    await click('source style',page.getByTestId('layer-'+ids[0]));await canvas.focus();await key('Meta+Alt+c')
    await expect.poll(()=>page.evaluate(async()=>(await window.coreDesktop.clipboard.read()).text?.startsWith('FUTUREOX-DESGIN-PROPERTIES-V1'))).toBe(true)
    await click('target style',page.getByTestId('layer-'+ids[1]));await canvas.focus();await key('Meta+Alt+v')
    await savedWhen(d=>d?.nodes[ids[1]]?.fills[0].color==='#b531f7');assert.deepEqual((await stored()).document.nodes[ids[1]].transform,[1,0,0,1,170,80]);await key('Meta+z');await savedWhen(d=>d?.nodes[ids[1]]?.fills[0].color==='#33aacc')
    checked('native Option+Command C/V reaches preload, uses the OS property clipboard, persists appearance and keeps geometry')
  }finally{if(savedClipboard.status==='ok')await page.evaluate(value=>window.coreDesktop.clipboard.write(value),Object.fromEntries(Object.entries(savedClipboard).filter(([key])=>['text','svg','image','forma'].includes(key))))}
  await canvas.focus();await key('Meta+a');await key('Shift+a');const layoutDoc=await savedWhen(d=>Object.values(d?.nodes||{}).some(n=>n.layout?.mode==='horizontal')),frame=Object.values(layoutDoc.nodes).find(n=>n.layout?.mode==='horizontal')
  await settle();start=await handlePoint(page.getByTestId('layout-handle-top'));view=await page.locator('.kernel-presentation').evaluate(e=>({zoom:+e.dataset.cameraZoom}))
  const padding=frame.layout.padding[0]+12
  await modifier('Alt',true);await modifier('Shift',true);await dragTool(start,{x:start.x,y:start.y+12*view.zoom});await modifier('Shift',false);await modifier('Alt',false)
  await savedWhen(d=>d?.nodes[frame.id]?.layout.padding.every(v=>v===padding))
  checked('actual Electron padding handle applies Option+Shift to all sides and relayouts through Rust')
  await canvas.focus();await key('Shift+r');await expect(page.getByTestId('horizontal-ruler')).toBeVisible();const viewport=await canvas.boundingBox()
  await dragTool({x:viewport.x+200,y:viewport.y+10},{x:viewport.x+200,y:viewport.y+280})
  await savedWhen(d=>d?.nodes[frame.id]?.guides?.length===1&&d.schemaVersion===11)
  await page.screenshot({path:path.join(output,'06-alignment-rulers.fd.png')});checked('frame-owned ruler guide is created by native input and reaches SQLite schema 11')
  const final=await stored();await page.reload();await expect(page.locator('.app-shell')).toHaveAttribute('data-desktop-ready','true',{timeout:45000});await settle();assert.deepEqual((await stored()).document,final.document);checked('all new properties survive real renderer reload')
  report.documentId=final.id;await closeOwned()
  probe=new Sidecar(sidecarBinary,path.join(output,'independent-recovery'),{workspaceDb:path.join(profile,'workspace-v1.sqlite3')});const opened=await probe.request('workspace.open',{id:final.id});assert.deepEqual(opened.document,final.document)
  const portable=path.join(output,'portable.fd');await probe.request('save',{path:portable,document:opened.document,expectedHash:null});assert.equal((await readFile(portable)).subarray(0,4).toString(),'FXDK');assert.deepEqual((await probe.request('open',{path:portable})).document,final.document);checked('independent Rust reopens SQLite and binary FD without field loss')
  assert.deepEqual(errors,[]);report.status='passed'
}catch(error){errors.push(String(error.stack||error));report.status='failed';if(page){
  await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  await page.evaluate(()=>({inputs:window.__nativeInputEvidence,canvas:document.querySelector('[data-testid="canvas"]')?.className,active:{tag:document.activeElement?.tagName,aria:document.activeElement?.getAttribute('aria-label')},status:[...document.querySelectorAll('[role="status"],.canvas-status,.kernel-status')].map(e=>e.textContent)})).then(value=>writeFile(path.join(output,'failure-inputs.json'),JSON.stringify(value,null,2))).catch(()=>{});
}process.exitCode=1}
finally{if(peerApp)await peerApp.close().catch(()=>{});if(probe)await probe.stop();await closeOwned();await writeFile(path.join(output,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,status:report.status,checks:checks.length,inputs:inputs.length}));}
