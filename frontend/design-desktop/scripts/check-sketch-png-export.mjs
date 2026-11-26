import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTestElectron, createTestScratch } from '../../../scripts/lib/test-scratch.mjs'

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixture = option('fixture')
const application = option('application') ?? fileURLToPath(new URL('..', import.meta.url))
const requestedOutput = option('output')
assert.ok(fixture && path.isAbsolute(fixture), 'Supply the original fixture with --fixture=/absolute/117.sketch')
assert.ok(path.isAbsolute(application) && (!requestedOutput || path.isAbsolute(requestedOutput)))

const { _electron, expect } = createRequire(path.join(application, '../design-client/package.json'))('@playwright/test')
const executablePath = createRequire(path.join(application, 'package.json'))('electron')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const originalHash = 'd494693eadf269e7fa29e4cc56e893f5890c02f4d96f4561065c851818a85d70'
assert.equal(hash(await readFile(fixture)), originalHash)

const scratch = await createTestScratch('sketch-png-export-')
const output = requestedOutput ?? scratch.root
const result = { fixture: path.basename(fixture), originalHash, exports: [], pageErrors: [] }
let app, child, scale
try {
  if (requestedOutput) await mkdir(output, { mode: 0o700 })
  const dist = path.join(application, 'dist')
  result.build = {
    manifest: hash(await readFile(path.join(dist, 'build-manifest.json'))),
    wasm: hash(await readFile(path.join(dist, 'renderer/kernel/design_kernel_bg.wasm'))),
    prepare: hash(await readFile(path.join(dist, 'bin', process.platform === 'win32' ? 'design-prepare.exe' : 'design-prepare'))),
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(CORE_|VITE_DESIGN_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|LD_PRELOAD|DYLD_)/.test(key)))
  app = await _electron.launch({ executablePath, args: [application, '--desktop-isolated-profile'],
    cwd: application, env: scratch.environment(env), chromiumSandbox: true, timeout: 45000 })
  child = app.process()
  const page = await app.firstWindow({ timeout: 45000 })
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
  await page.locator('input[type=file][accept*=".fd"]').setInputFiles(fixture)
  await page.getByTestId('layer-ED0CF14B-2E8E-4BE7-97C8-0C061012FEE3').click({ timeout: 60000 })
  const notice = page.getByRole('button', { name: '关闭导入提示', exact: true })
  if (await notice.isVisible()) await notice.click()
  await expect(page.locator('.save-status-label')).toHaveText('已自动保存到工作副本', { timeout: 45000 })
  const panel = page.getByRole('region', { name: '图层导出设置', exact: true })
  const remove = panel.getByRole('button', { name: /^删除导出设置/ })
  while (await remove.count()) await remove.first().click()
  await panel.getByRole('button', { name: '添加图层导出设置', exact: true }).click()
  await panel.getByLabel('导出格式 1', { exact: true }).selectOption('png')
  const field = panel.getByRole('spinbutton', { name: '导出倍率 1', exact: true })
  const generate = panel.getByRole('button', { name: '预览并导出此图层', exact: true })
  for (scale of [1, 2]) {
    const start = performance.now()
    await field.fill(String(scale))
    await field.press('Enter')
    await expect(field).toHaveAttribute('aria-valuenow', String(scale))
    await generate.click()
    await generate.waitFor({ timeout: 120000 })
    const message = await panel.getByRole('status').textContent()
    assert.equal(message, '已生成 1 个文件', `${scale}× export failed: ${message}`)
    const name = scale === 1 ? '117.png' : '117@2x.png'
    const preview = panel.getByAltText('图层导出预览 1', { exact: true })
    await expect.poll(() => preview.evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
    const destination = path.join(output, name)
    // Keep Electron's production download path. Supply a path for the owned
    // test window so a native save picker does not require a person.
    await app.evaluate(({ BrowserWindow }, { destination, name }) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('design-app:'))
      globalThis.sketchExportDownload = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('PNG download timed out')), 20000)
        window.webContents.session.once('will-download', (_event, item, contents) => {
          if (contents !== window.webContents || item.getFilename() !== name) {
            clearTimeout(timer)
            reject(Error('Unexpected download'))
            return
          }
          item.setSavePath(destination)
          item.once('done', (_event, state) => {
            clearTimeout(timer)
            if (state === 'completed') resolve(state)
            else reject(Error(`PNG download ${state}`))
          })
        })
      })
      void globalThis.sketchExportDownload.catch(() => {})
    }, { destination, name })
    await panel.getByRole('link', { name, exact: true }).click()
    await app.evaluate(async () => { await globalThis.sketchExportDownload; delete globalThis.sketchExportDownload })
    const png = await readFile(destination)
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)]
    assert.deepEqual(size, [1922 * scale, 1080 * scale])
    assert.deepEqual(await preview.evaluate(img => [img.naturalWidth, img.naturalHeight]), size)
    const checked = { scale, size, bytes: png.length, sha256: hash(png), wallMs: Math.round(performance.now() - start) }
    result.exports.push(checked)
    console.log(JSON.stringify(checked))
  }
  assert.deepEqual(result.pageErrors, [])
  result.status = 'passed'
} catch (error) {
  result.status = 'failed'
  result.failure = { scale, message: String(error) }
  console.error(error)
  process.exitCode = 1
} finally {
  try {
    assert.equal(hash(await readFile(fixture)), originalHash, 'Original Sketch file changed during export')
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  } finally {
    await closeTestElectron(scratch, app, child)
  }
}
