// Real local Sketch import/edit/history/persistence in Chromium or Electron.
// The fixture stays outside the repository; only hashes and counts enter the report.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { unzipSync, strFromU8 } from 'fflate'
import { chromium, _electron, expect, type Page } from '@playwright/test'
import { createServer } from 'vite'

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.resolve(client, '../design-desktop')
const args = process.argv.slice(2)
const option = (key: string) => args.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3)
const fixture = option('fixture')
assert.ok(fixture && path.isAbsolute(fixture), '--fixture must be an absolute private .sketch path')
const electronMode = args.includes('--electron')
const output = option('output') || await mkdtemp(path.join(tmpdir(), 'futureox-sketch-local-'))
await mkdir(output, { recursive: true })
const original = await readFile(fixture)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const report: Record<string, unknown> = {
  mode: electronMode ? 'electron' : 'web', fixture: path.basename(fixture), fixtureHash: digest(original),
  startedAt: new Date().toISOString(), status: 'running', checks: [] as string[],
}
const checks = report.checks as string[], errors: string[] = []
const checked = (message: string) => { checks.push(message); console.log(`SKETCH_LOCAL ${message}`) }
let server: Awaited<ReturnType<typeof createServer>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
let page: Page | undefined
try {
  if (electronMode) {
    const requireDesktop = createRequire(path.join(desktop, 'package.json'))
    const executablePath = option('app') || requireDesktop('electron')
    const profiles = path.join(output, 'profiles'); await mkdir(profiles, { recursive: true })
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
    application = await _electron.launch({ executablePath,
      args: [...(option('app') ? [] : [desktop]), '--desktop-gui-test'],
      env: { ...env, TMPDIR: profiles }, chromiumSandbox: true, timeout: 45_000,
    })
    page = await application.firstWindow({ timeout: 45_000 })
    report.host = await application.evaluate(({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { packaged: app.isPackaged, profile: app.getPath('userData'), sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation, webSecurity: preferences.webSecurity, nodeIntegration: preferences.nodeIntegration }
    })
    assert.ok((report.host as { sandbox: boolean }).sandbox)
  } else {
    let base = option('base')
    if (!base) {
      server = await createServer({ root: client, configFile: path.join(client, 'vite.config.ts'),
        server: { host: '127.0.0.1', port: 0, strictPort: true } })
      await server.listen(); base = server.resolvedUrls!.local[0]
    }
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/?$/)
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      args: process.platform === 'darwin' ? ['--use-angle=metal'] : [] })
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
    await page.goto(base)
  }
  const current = page!
  current.on('pageerror', error => errors.push(String(error)))
  current.setDefaultTimeout(30_000)
  await expect(current.getByLabel('文档名称', { exact: true })).toBeVisible()
  await expect(current.locator('.app-shell')).toHaveAttribute('data-editor-ready', 'true', { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0, { timeout: 60_000 })
  assert.equal(await current.getByRole('button', { name: '云端文件', exact: true }).count(), 0)
  checked('both hosts expose the local editor without a cloud entry')
  await current.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  const name = path.basename(fixture).replace(/\.sketch$/i, '')
  const admission = await current.waitForFunction(expected => {
    const message = document.querySelector('footer')?.textContent?.trim() || ''
    if (/^(Error|TypeError|RangeError):/.test(message)) return { error: message }
    return document.querySelector<HTMLInputElement>('input[aria-label="文档名称"]')?.value === expected ? { ok: true } : false
  }, name, { timeout: 60_000 })
  const admitted = await admission.jsonValue()
  if ('error' in admitted) throw new Error(admitted.error)
  await expect(current.getByLabel('文档名称', { exact: true })).toHaveValue(name, { timeout: 60_000 })
  const compatibility = current.getByRole('complementary', { name: '导入兼容提示' })
  await expect(compatibility).toBeVisible({ timeout: 60_000 })
  if (await compatibility.count()) {
    report.warnings = await compatibility.locator('li').allTextContents()
    assert.equal(await current.locator('.feature-backdrop').count(), 0)
    const canvas = current.getByTestId('canvas'), box = await canvas.boundingBox()
    assert.ok(box)
    await canvas.focus()
    await current.keyboard.down('Space')
    await current.mouse.move(box.x + box.width * .65, box.y + box.height * .65)
    await current.mouse.down()
    await expect(canvas).toHaveAttribute('data-transform-gesture', 'pan')
    await current.mouse.move(box.x + box.width * .65 + 60, box.y + box.height * .65 + 30, { steps: 5 })
    await current.mouse.up()
    await current.keyboard.up('Space')
    checked('compatibility information does not block canvas panning while rendering is pending')
    await compatibility.getByRole('button', { name: '关闭导入提示' }).click()
  }
  const savedDocument = async (expectedName: string) => current.evaluate(async ({ electronMode, expectedName }) => {
    if (electronMode) {
      const bridge = window.coreDesktop?.workspace
      if (!bridge) throw Error('Missing real local workspace')
      const list = await bridge.list()
      if (list.status !== 'ok') return null
      const item = list.documents.find(document => document.name === expectedName && !document.deleted)
      if (!item) return null
      const opened = await bridge.open({ id: item.id })
      return opened.status === 'ok' ? JSON.parse(opened.documentJson) : null
    }
    const { localOpen } = await import('/src/local-store.ts')
    const opened = await localOpen()
    return opened?.document.name === expectedName ? opened.document : null
  }, { electronMode, expectedName })
  await expect.poll(async () => !!await savedDocument(name), { timeout: 60_000 }).toBe(true)
  const imported = await savedDocument(name)
  const nodes = Object.values(imported.nodes) as { kind: string; id: string; text: string }[]
  report.imported = { pages: imported.pages.length, nodes: nodes.length,
    text: nodes.filter(node => node.kind === 'text').length, vector: nodes.filter(node => node.kind === 'vector').length }
  if (path.basename(fixture) === '117.sketch') {
    const modes: Record<string, number> = {}
    let checkedText = 0
    const visit = (layer: Record<string, any>) => {
      if (layer._class === 'text') {
        const actual = imported.nodes[layer.do_objectID]
        assert.ok(actual, 'Every source text layer must remain editable')
        const mode = layer.textBehaviour ?? 0
        assert.equal(actual.textStyle?.wrap ?? false, mode !== 0, 'Official Sketch text behaviour must determine soft wrapping')
        assert.ok(actual.text === layer.attributedString.string, 'Source text and explicit newlines must be retained')
        modes[mode] = (modes[mode] || 0) + 1
        checkedText++
      }
      for (const child of layer.layers || []) visit(child)
    }
    for (const [entry, bytes] of Object.entries(unzipSync(original)))
      if (/^pages\/[^/]+\.json$/.test(entry)) visit(JSON.parse(strFromU8(bytes)))
    assert.equal(checkedText, 106)
    assert.deepEqual(modes, { 0: 100, 2: 6 })
    report.sourceTextModes = modes
    checked('all 106 source text layers preserve their string and official soft-wrap mode')
  }
  assert.ok(nodes.length > 0)
  if (path.basename(fixture) === '117.sketch') {
    assert.equal(imported.pages.length, 1); assert.equal(nodes.length, 752)
    assert.equal(nodes.filter(node => node.kind === 'text').length, 106)
  }
  checked('real Sketch archive imports into the shared editable document and durable local store')
  await expect(current.locator('.kernel-presentation')).toHaveAttribute('data-presentation-ready', 'true', { timeout: 120_000 })
  assert.equal(await current.locator('.kernel-status.error').count(), 0)
  report.render = await current.locator('.kernel-tiles').evaluateAll(elements => elements.map(element => ({
    ...(element as HTMLElement).dataset,
  })))
  await current.screenshot({ path: path.join(output, `${report.mode}-import.png`) })
  checked('the production renderer completes the imported document without a page crash')
  const title = current.getByLabel('文档名称', { exact: true }), renamed = `${name} local test`
  await title.fill(renamed); await title.press('Tab')
  await current.getByRole('button', { name: '撤销', exact: true }).click()
  await expect(title).toHaveValue(name)
  await current.getByRole('button', { name: '重做', exact: true }).click()
  await expect(title).toHaveValue(renamed)
  await expect.poll(async () => !!await savedDocument(renamed), { timeout: 60_000 }).toBe(true)
  checked('the shared Graph history undoes and redoes an imported document edit')
  const edited = await savedDocument(renamed)
  assert.equal(Object.keys(edited.nodes).length, nodes.length)
  for (const node of nodes.filter(node => node.kind === 'text')) assert.equal(edited.nodes[node.id].text, node.text)
  const sketchExport = path.join(output, 'compatibility.sketch')
  if (application) await application.evaluate(({ session }, filename) => {
    ;(globalThis as any).__sketchDownload = new Promise(resolve => {
      session.fromPartition('persist:forma-desktop').once('will-download', (_event, item) => {
        item.setSavePath(filename)
        item.once('done', (_doneEvent, state) => resolve({ state, bytes: item.getReceivedBytes() }))
      })
    })
  }, sketchExport)
  await current.locator('.brand').click()
  const exported = application ? undefined : current.waitForEvent('download')
  await current.getByRole('button', { name: '导出 Sketch（兼容格式）', exact: true }).click()
  if (application) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = await Promise.race([
      application.evaluate(() => (globalThis as any).__sketchDownload),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('Native Sketch download did not complete')), 45_000) }),
    ]).finally(() => clearTimeout(timer))
    assert.equal(done.state, 'completed')
    assert.ok(done.bytes > 0)
    await expect.poll(async () => { try { return (await readFile(sketchExport)).subarray(0, 2).toString() } catch { return '' } }, { timeout: 60_000 }).toBe('PK')
  } else await (await exported!).saveAs(sketchExport)
  assert.equal((await readFile(sketchExport)).subarray(0, 2).toString(), 'PK')
  checked('the shared Sketch compatibility export menu creates an actual archive')
  const fd = path.join(output, 'roundtrip.fd')
  if (application) {
    await application.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename })
    }, fd)
    await current.locator('.brand').click()
    await current.getByRole('button', { name: '另存为设计文件…', exact: true }).click()
    await expect.poll(async () => { try { return (await readFile(fd)).subarray(0, 4).toString() } catch { return '' } }, { timeout: 60_000 }).toBe('FXDK')
  } else {
    await current.locator('.brand').click()
    const downloaded = current.waitForEvent('download')
    await current.getByRole('button', { name: /保存设计文件/ }).click()
    await (await downloaded).saveAs(fd)
    assert.equal((await readFile(fd)).subarray(0, 4).toString(), 'FXDK')
  }
  // Give the private FD copy a distinct title. An unsuccessful/no-op open can
  // no longer pass by observing the still-open imported document.
  const codec = await import('../src/generated/design-kernel/design_kernel.js')
  await codec.default({ module_or_path: new Uint8Array(await readFile(path.join(client, 'public/kernel/design_kernel_bg.wasm'))) })
  const exportedReport = JSON.parse(codec.import_sketch_json(new Uint8Array(await readFile(sketchExport))))
  assert.equal(exportedReport.document.pages.length, imported.pages.length)
  assert.equal(Object.keys(exportedReport.document.nodes).length, nodes.length)
  assert.equal(Object.values(exportedReport.document.nodes).filter((node: any) => node.kind === 'text').length,
    nodes.filter(node => node.kind === 'text').length)
  checked('the completed compatibility archive reimports through the real shared kernel')
  const fdDocument = JSON.parse(codec.forma_decode_json(new Uint8Array(await readFile(fd))))
  const reopenedName = `${name} from FD`
  fdDocument.name = reopenedName
  await writeFile(fd, codec.forma_encode_json(JSON.stringify(fdDocument)))
  if (application) {
    await application.evaluate(({ dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] })
    }, fd)
    await current.locator('.brand').click()
    await current.getByRole('button', { name: /打开本机设计文件/ }).click()
  } else await current.locator('input[type=file][accept*=".fd"]').setInputFiles(fd)
  await expect(title).toHaveValue(reopenedName, { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0)
  await expect.poll(async () => !!await savedDocument(reopenedName), { timeout: 60_000 }).toBe(true)
  const reopened = await savedDocument(reopenedName)
  const { id: savedId, ...savedFields } = fdDocument, { id: openedId, ...openedFields } = reopened
  assert.ok(isDeepStrictEqual(openedFields, savedFields), 'FD reopen changed authored document fields')
  assert.equal(Object.keys(reopened.nodes).length, nodes.length)
  for (const node of nodes.filter(node => node.kind === 'text')) assert.equal(reopened.nodes[node.id].text, node.text)
  checked('FD save and reopen retain all imported layers and text')
  await current.reload()
  await expect(title).toHaveValue(reopenedName, { timeout: 60_000 })
  await expect(current.locator('.document-transition')).toHaveCount(0)
  checked('a renderer restart restores the actual local document')
  assert.equal(digest(await readFile(fixture)), report.fixtureHash)
  assert.deepEqual(errors, [])
  checked('the original Sketch archive is unchanged and no page exception occurred')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error)
  if (page) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  throw error
} finally {
  report.finishedAt = new Date().toISOString(); report.pageErrors = errors
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2))
  await browser?.close()
  await application?.close()
  await server?.close()
  console.log(`SKETCH_LOCAL_OUTPUT ${output}`)
}
