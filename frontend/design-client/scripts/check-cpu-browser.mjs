/** Real Chromium + React + Rust/WASM CPU integration; bridge is a test double.
 * Does not validate Electron, native IPC, or the Rust filesystem sidecar.
 * No build, dependency installation, external service, or GPU execution.
 */
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const run = await mkdtemp(join(tmpdir(), 'forma-cpu-browser-'))
const profile = join(run, 'profile')
const output = process.env.DESIGN_TEST_OUTPUT ? resolve(process.env.DESIGN_TEST_OUTPUT) : join(run, 'evidence')
await mkdir(output, { recursive: true })
const documentPath = join(run, 'Owned.fd')
const errors = [], forbidden = []
let server, context, page, failure
// The outer timeout is a last resort. Normal error cleanup closes only owned resources.
const deadline = setTimeout(async () => {
  console.error('CPU browser smoke exceeded 180 seconds')
  const forcedExit = setTimeout(() => process.exit(124), 5_000)
  await context?.close().catch(() => {})
  await server?.close().catch(() => {})
  clearTimeout(forcedExit); process.exit(124)
}, 180_000)
try {
  // This intentionally bypasses package dev/build scripts: prebuilt CPU WASM is required.
  await readFile(join(root, 'public/kernel/design_kernel_bg.wasm'))
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, proxy: {} } })
  await server.listen()
  const address = server.httpServer.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Expected owned loopback server')
  const base = `http://127.0.0.1:${address.port}`
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, chromiumSandbox: true, serviceWorkers: 'block',
    // Playwright otherwise opts into SwiftShader; this smoke must never do so.
    ignoreDefaultArgs: ['--enable-unsafe-swiftshader', '--unsafely-disable-devtools-self-xss-warnings'],
    viewport: { width: 1440, height: 1000 },
    args: [
      '--disable-gpu', '--disable-software-rasterizer', '--disable-webgl',
      '--disable-webgl2', '--disable-accelerated-2d-canvas',
      '--disable-features=WebGPU,Vulkan', '--disable-background-networking',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    ],
  })
  context.setDefaultTimeout(15_000)
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== base || url.pathname.startsWith('/api/') || url.pathname.startsWith('/health') || /\/kernel\/(gpu\/|color-presenter)/.test(url.pathname)) {
      forbidden.push(url.href)
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  // Actual test-owned disk bytes; this capability binding is NOT the Rust sidecar.
  await context.exposeBinding('__cpuFile', async (_source, operation, documentJson) => {
    if (operation === 'save') {
      JSON.parse(documentJson)
      await writeFile(`${documentPath}.tmp`, documentJson, { mode: 0o600 })
      await rename(`${documentPath}.tmp`, documentPath)
      return { status: 'ok', handle: 'owned:file', displayName: 'Owned.fd' }
    }
    if (operation === 'open') return { status: 'ok', handle: 'owned:file', displayName: 'Owned.fd', documentJson: await readFile(documentPath, 'utf8') }
    throw new Error('Unexpected file operation')
  })
  await context.addInitScript(() => {
    const state = { command: () => {}, close: () => {}, mode: 'ok', openMode: 'ok', requests: 0, results: 0, violations: [], dirty: true, finishSave: null, saves: 0 }
    Object.defineProperty(window, '__cpuSmoke', { value: state })
    const forbidden = (what) => { state.violations.push(what); throw new Error(`CPU-only violation: ${what}`) }
    // Guards never invoke a graphics API. They fail closed if application code attempts one.
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: false, get: () => forbidden('navigator.gpu') })
    const wrapCanvas = (prototype) => {
      const original = prototype.getContext
      prototype.getContext = function (kind, ...args) {
        if (/webgl|webgpu|experimental-webgl/i.test(String(kind))) return forbidden(`getContext(${kind})`)
        return original.call(this, kind, ...args)
      }
    }
    wrapCanvas(HTMLCanvasElement.prototype)
    if (typeof OffscreenCanvas !== 'undefined') wrapCanvas(OffscreenCanvas.prototype)
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options)
        if (!String(url).includes('render-worker')) return
        const send = this.postMessage.bind(this)
        this.postMessage = (message, ...args) => {
          if (message.executionPolicy?.cpuOnly !== true || message.backend !== 'cpu' || message.command) return forbidden('non-CPU worker envelope')
          state.requests++
          return send(message, ...args)
        }
        this.addEventListener('message', ({ data }) => {
          if (data.error) { state.violations.push(`CPU worker error: ${data.error}`); return }
          if (data.backend !== 'cpu' || data.compileMs !== 0) return forbidden('non-CPU worker response')
          state.results++
        })
      }
    }
    const ok = { status: 'ok' }
    // Pinned before main.tsx evaluates, including KernelClient's module-level policy.
    const bridge = Object.freeze({
      version: 1, renderPolicy: Object.freeze({ cpuOnly: true }),
      openDocument: async () => state.openMode === 'cancel' ? { status: 'cancelled' } : state.openMode === 'bad' ? { status: 'ok', handle: 'bad:file', displayName: 'Bad.fd', documentJson: '{' } : window.__cpuFile('open'),
      acceptDocument: async () => ok,
      saveDocument: async (request) => {
        state.saves++
        if (state.mode === 'fail') return { status: 'error', code: 'IO_ERROR', message: 'Owned smoke write failure' }
        if (state.mode === 'delay') await new Promise((resolve) => { state.finishSave = resolve })
        return window.__cpuFile('save', request.documentJson)
      },
      readRecovery: async () => ({ status: 'cancelled' }), acceptRecovery: async () => ok,
      writeRecovery: async () => ok, clearRecovery: async () => ok,
      setDirty: async (dirty) => { state.dirty = dirty },
      onCommand: (callback) => { state.command = callback; return () => {} },
      onCloseRequested: (callback) => { state.close = callback; return () => {} },
      respondToClose: async () => ({ accepted: true }),
      listCatalog: async () => ({ status: 'ok', projects: [], directories: [], files: [] }),
      selectCatalogDirectory: async () => ({ status: 'cancelled' }),
      scanCatalogDirectory: async () => ({ status: 'cancelled' }),
      openCatalogFile: async () => ({ status: 'cancelled' }),
    })
    Object.defineProperty(window, 'coreDesktop', { value: bridge, writable: false, configurable: false })
    Object.defineProperty(window, 'indexedDB', { get: () => { throw new Error('Desktop flow unexpectedly used IndexedDB') } })
  })
  page = await context.newPage()
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-desktop-ready="true"]')).toBeVisible({ timeout: 45_000 })
  const name = page.getByLabel('文档名称')
  const status = page.locator('.save-status')
  const command = (value) => page.evaluate((value) => window.__cpuSmoke.command(value), value)
  await page.getByRole('button', { name: '矩形', exact: true }).click()
  const canvas = await page.getByTestId('canvas').boundingBox()
  if (!canvas) throw new Error('Canvas has no layout bounds')
  await page.mouse.move(canvas.x + 150, canvas.y + 150)
  await page.mouse.down()
  await page.mouse.move(canvas.x + 350, canvas.y + 270, { steps: 4 })
  await page.mouse.up()
  await name.fill('CPU saved document')
  await command('save')
  await expect(status).toHaveText('已保存到文件')
  const initialSaved = JSON.parse(await readFile(documentPath, 'utf8'))
  expect(initialSaved.name).toBe('CPU saved document')
  expect(Object.values(initialSaved.nodes).some((node) => node.kind === 'rectangle')).toBe(true)
  await command('new')
  await expect(name).not.toHaveValue('CPU saved document')
  await command('open')
  const prompt = page.getByRole('alertdialog')
  // A new untitled document can require an explicit discard decision.
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(name).toHaveValue('CPU saved document')
  await name.fill('Unsaved session must survive')
  await page.evaluate(() => { window.__cpuSmoke.openMode = 'cancel' })
  await command('open'); await expect(name).toHaveValue('Unsaved session must survive')
  await page.evaluate(() => { window.__cpuSmoke.openMode = 'bad' })
  await command('open'); await expect(status).toHaveText('●操作失败，修改已保留')
  await expect(name).toHaveValue('Unsaved session must survive')
  await page.evaluate(() => { window.__cpuSmoke.mode = 'fail' })
  await command('save'); await expect(status).toHaveText('●操作失败，修改已保留')
  await expect(name).toHaveValue('Unsaved session must survive')
  expect(JSON.parse(await readFile(documentPath, 'utf8')).name).toBe('CPU saved document')
  await page.screenshot({ path: join(output, 'error-preserves-session.png') })
  await page.evaluate(() => { window.__cpuSmoke.mode = 'delay' })
  await command('save'); await expect(status).toHaveText('●保存中…')
  const saves = await page.evaluate(() => window.__cpuSmoke.saves)
  await command('save'); await command('saveAs')
  expect(await page.evaluate(() => window.__cpuSmoke.saves)).toBe(saves)
  await name.fill('Newer edit survives old acknowledgement')
  await page.evaluate(() => window.__cpuSmoke.finishSave())
  await expect(status).toHaveText('●未保存到文件')
  await expect(name).toHaveValue('Newer edit survives old acknowledgement')
  await page.evaluate(() => { window.__cpuSmoke.mode = 'ok' })
  await command('save'); await expect(status).toHaveText('已保存到文件')
  await expect.poll(() => page.evaluate(() => window.__cpuSmoke.results), { timeout: 30_000 }).toBeGreaterThan(0)
  const beforeReload = await page.evaluate(() => ({ requests: window.__cpuSmoke.requests, results: window.__cpuSmoke.results, violations: window.__cpuSmoke.violations }))
  expect(beforeReload.violations).toEqual([])
  // Reload destroys the React session; only the owned on-disk file survives.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-desktop-ready="true"]')).toBeVisible({ timeout: 45_000 })
  await command('open')
  await expect(prompt).toBeVisible()
  await prompt.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(name).toHaveValue('Newer edit survives old acknowledgement')
  await expect.poll(() => page.evaluate(() => window.__cpuSmoke.results), { timeout: 30_000 }).toBeGreaterThan(0)
  const observed = await page.evaluate(() => ({ requests: window.__cpuSmoke.requests, results: window.__cpuSmoke.results, violations: window.__cpuSmoke.violations, cpuOnly: window.coreDesktop.renderPolicy.cpuOnly }))
  expect(observed.cpuOnly).toBe(true); expect(observed.violations).toEqual([])
  expect(errors).toEqual([]); expect(forbidden).toEqual([])
  await page.screenshot({ path: join(output, 'cpu-react-reopened.png') })
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'passed', scope: 'Chromium React + Rust/WASM CPU; test-double bridge with owned disk file', electron: 'not_run', rustSidecar: 'not_run', beforeReload, observed, errors, forbidden }, null, 2))
  console.log(JSON.stringify({ output, status: 'passed' }))
} catch (error) {
  failure = error
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {})
  await writeFile(join(output, 'results.json'), JSON.stringify({ status: 'failed', error: String(error), errors, forbidden }, null, 2))
  console.error(error)
} finally {
  await context?.close().catch(() => {})
  await server?.close().catch(() => {})
  // Preserve documents/screenshots/logs; remove only this run's disposable browser profile.
  await rm(profile, { recursive: true, force: true })
  clearTimeout(deadline)
  console.log(JSON.stringify({ run, output, profileCleaned: true }))
}
if (failure) process.exitCode = 1
