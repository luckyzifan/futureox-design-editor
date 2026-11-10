/** Same Sketch hit tests inside Electron 44's Chromium. Requires the desktop Electron binary. */
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
const electronPath = fileURLToPath(new URL('../../design-desktop/node_modules/electron/dist/electron', import.meta.url))
if (!existsSync(electronPath)) throw new Error(`Electron binary is not installed at ${electronPath}`)
const output = join('/tmp', 'sketch-toolbar-hits-electron')
await mkdir(output, { recursive: true })
const host = join(output, 'host.cjs')
await writeFile(host, `const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: Number(process.env.ELECTRON_WIDTH || 1440),
    height: Number(process.env.ELECTRON_HEIGHT || 960),
    show: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  window.loadURL(process.env.VITE_URL)
})
`)
const server: ViteDevServer = await createServer({
  root,
  cacheDir: join(output, 'vite'),
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  logLevel: 'error',
})
let app: ElectronApplication | undefined
let page: Page | undefined
const failures: string[] = []
const report: Record<string, unknown> = { platform: process.platform, electronPath, cases: [] as unknown[] }
try {
  await server.listen()
  const base = server.resolvedUrls?.local?.[0]
  if (!base) throw new Error('Vite did not report a local URL')
  app = await electron.launch({
    executablePath: electronPath,
    args: [host, '--no-sandbox', '--disable-gpu'],
    env: { ...process.env, VITE_URL: base, ELECTRON_WIDTH: '1440', ELECTRON_HEIGHT: '960' },
  })
  const versions = await app.evaluate(async ({ app: electronApp }) => ({
    electron: electronApp.getVersion(),
    chrome: process.versions.chrome,
  }))
  report.versions = versions
  page = await app.firstWindow()
  page.on('pageerror', error => failures.push(`pageerror ${error}`))
  await expect(page.locator('.editor-shell')).toBeVisible({ timeout: 30_000 })
  const create = page.getByRole('button', { name: '新建设计', exact: true })
  await expect(create).toBeEnabled({ timeout: 90_000 })
  await create.click()
  await expect(page.locator('.local-home')).toHaveCount(0)
  const sizes = [{ width: 1440, height: 960 }, { width: 1280, height: 800 }, { width: 1000, height: 640 }]
  const locales = [
    { id: 'zh-CN', language: '界面语言', arrange: '排列与编辑', region: '区域工具', text: '文字' },
    { id: 'en', language: 'Interface language', arrange: 'Arrange and edit', region: 'Region tools', text: 'Text' },
  ]
  for (const size of sizes) {
    await page.setViewportSize(size)
    await app.evaluate(async ({ BrowserWindow }, next) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setContentSize(next.width, next.height)
    }, size)
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-ui-mode')).toBe('sketch')
    for (const locale of locales) {
      await page.locator('.locale-switch select').selectOption(locale.id)
      await expect(page.getByRole('button', { name: locale.arrange, exact: true })).toBeVisible()
      const hit = await page.evaluate((labels) => {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>('.floating-toolbar button')]
          .filter(button => {
            const details = button.closest('details')
            return !details || details.open || !!button.closest('summary')
          })
        const rows = buttons.map(button => {
          const rect = button.getBoundingClientRect()
          const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
          const target = document.elementFromPoint(x, y)
          return {
            label: button.getAttribute('aria-label'),
            ok: !!target && (target === button || button.contains(target)),
            hit: target ? `${target.tagName.toLowerCase()}[${target.getAttribute('aria-label') || ''}]` : null,
          }
        })
        const language = document.querySelector<HTMLElement>(`select[aria-label="${labels.language}"]`)
        const languageRect = language?.getBoundingClientRect()
        const languageHit = languageRect ? document.elementFromPoint(languageRect.x + languageRect.width / 2, languageRect.y + languageRect.height / 2) : null
        return {
          covered: rows.filter(row => !row.ok),
          missing: [labels.arrange, labels.region, labels.text].filter(label => !rows.some(row => row.label === label)),
          languageOk: !!language && !!languageHit && (languageHit === language || language.contains(languageHit)),
        }
      }, locale)
      const shot = join(output, `${locale.id}-${size.width}x${size.height}.png`)
      await page.screenshot({ path: shot })
      if (hit.missing.length || hit.covered.length || !hit.languageOk)
        failures.push(`${size.width} ${locale.id} missing=${hit.missing.join(',')} covered=${hit.covered.map(row => `${row.label}->${row.hit}`).join(';')} language=${hit.languageOk}`)
      else {
        for (const label of [locale.arrange, locale.region, locale.text]) {
          await page.getByRole('button', { name: label, exact: true }).click({ timeout: 5_000 })
          if (label === locale.text) await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
          else {
            await expect(page.getByRole('menu', { name: label, exact: true })).toBeVisible()
            await page.keyboard.press('Escape')
          }
        }
      }
      ;(report.cases as unknown[]).push({ size, locale: locale.id, hit, screenshot: shot })
      console.log(JSON.stringify({ size, locale: locale.id, covered: hit.covered, missing: hit.missing, languageOk: hit.languageOk }))
    }
  }
  if (failures.length) throw new Error(failures.join('\n'))
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  throw error
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await app?.close().catch(() => undefined)
  await server.close()
}
