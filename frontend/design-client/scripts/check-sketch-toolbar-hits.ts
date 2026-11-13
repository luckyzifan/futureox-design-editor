/** Real browser hit tests for Sketch toolbar buttons. DOM presence is not a pass. */
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join('/tmp', 'sketch-toolbar-hits')
await mkdir(output, { recursive: true })

const sizes = [
  { width: 1440, height: 960 },
  { width: 1180, height: 800 },
  { width: 1000, height: 640 },
] as const
const locales = [
  {
    id: 'zh-CN' as const,
    language: '界面语言',
    arrange: '排列与编辑',
    region: '区域工具',
    text: '文字',
    utility: '实用工具',
    undo: '撤销',
  },
  {
    id: 'en' as const,
    language: 'Interface language',
    arrange: 'Arrange and edit',
    region: 'Region tools',
    text: 'Text',
    utility: 'Utility tools',
    undo: 'Undo',
  },
]

type Probe = {
  label: string | null
  disabled: boolean
  box: { x: number; y: number; w: number; h: number }
  x: number
  y: number
  hit: string | null
  ok: boolean
}

const server: ViteDevServer = await createServer({
  root,
  cacheDir: join(output, 'vite'),
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  logLevel: 'error',
})
let browser: Browser | undefined
let page: Page | undefined
const report: Record<string, unknown> = {
  platform: process.platform,
  note: 'Linux CSS-pixel hit tests of the shared editor shell. Not a macOS Electron timing run.',
  cases: [] as unknown[],
}
const failures: string[] = []
try {
  await server.listen()
  const base = server.resolvedUrls?.local?.[0]
  if (!base) throw new Error('Vite did not report a local URL')
  report.base = base
  const headed = process.env.SKETCH_TOOLBAR_HEADED === '1'
  const launchArgs = ['--disable-dev-shm-usage', '--force-device-scale-factor=1', ...(headed ? ['--no-sandbox'] : [])]
  try {
    browser = await chromium.launch({ headless: !headed, chromiumSandbox: !headed, channel: headed ? 'chrome' : undefined, args: launchArgs })
    report.browser = headed ? 'headed-chrome' : 'playwright-chromium'
  } catch (error) {
    report.bundledChromiumError = String(error).split('\n')[0]
    browser = await chromium.launch({ headless: !headed, channel: 'chrome', args: [...launchArgs, '--no-sandbox'] })
    report.browser = headed ? 'headed-chrome-channel' : 'chrome-channel'
  }
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  await page.addInitScript(() => {
    const host = window as Window & { coreDesktop?: { version: number } }
    if (host.coreDesktop?.version === 1) return
    host.coreDesktop = {
      version: 1,
      readRecovery: async () => ({ status: 'cancelled' }),
      writeRecovery: async () => ({ status: 'ok' }),
      clearRecovery: async () => ({ status: 'ok' }),
      setDirty: async () => {},
      onCommand: () => () => {},
      onCloseRequested: () => () => {},
      respondToClose: async () => ({ accepted: true }),
    }
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(base)
  await expect(page.locator('.editor-shell')).toBeVisible()
  const create = page.getByRole('button', { name: '新建设计', exact: true })
  await expect(create).toBeEnabled({ timeout: 90_000 })
  await create.click()
  await expect(page.locator('.local-home')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.floating-toolbar')).toBeVisible()
  report.pageErrors = errors

  const probe = () => page!.evaluate(() => {
    const describe = (element: Element | null) => element ? `${element.tagName.toLowerCase()}[${element.getAttribute('aria-label') || element.getAttribute('role') || element.className}]` : null
    const boxOf = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
    }
    const shown = (element: HTMLElement) => {
      const details = element.closest('details')
      if (details && !details.open && !element.closest('summary')) return false
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
      const box = boxOf(element)
      return box.w >= 2 && box.h >= 2
    }
    const sample = (element: HTMLElement): Probe => {
      const box = boxOf(element)
      const x = box.x + box.w / 2, y = box.y + box.h / 2
      const hit = document.elementFromPoint(x, y)
      return {
        label: element.getAttribute('aria-label') || element.textContent?.trim() || null,
        disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        box, x, y, hit: describe(hit),
        ok: !!hit && (hit === element || element.contains(hit)),
      }
    }
    const toolbar = [...document.querySelectorAll<HTMLElement>('.floating-toolbar button')].filter(shown)
    const header = [...document.querySelectorAll<HTMLElement>('.header-right button, .header-right select, .header-right summary')].filter(shown)
    const intersects = (a: Probe['box'], b: Probe['box']) => a.x + 0.5 < b.x + b.w - 0.5 && a.x + a.w - 0.5 > b.x + 0.5 && a.y + 0.5 < b.y + b.h - 0.5 && a.y + a.h - 0.5 > b.y + 0.5
    const toolbarHits = toolbar.map(sample)
    const headerHits = header.map(sample)
    const overlaps = toolbarHits.flatMap(button => headerHits.filter(control => intersects(button.box, control.box)).map(control => ({
      button: button.label, control: control.label,
    })))
    const shell = document.querySelector<HTMLElement>('.editor-shell')
    const bar = document.querySelector<HTMLElement>('.floating-toolbar')
    const style = bar ? getComputedStyle(bar) : null
    const workspace = document.querySelector<HTMLElement>('.canvas-workspace')
    const windowBar = document.querySelector<HTMLElement>('.editor-header')
    const rectOf = (element: Element | null) => {
      if (!element) return null
      const rect = element.getBoundingClientRect()
      return { x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2) }
    }
    const zoom = document.querySelector<HTMLElement>('[data-testid="zoom-readout"]')
    const preview = document.querySelector<HTMLElement>('.prototype-preview-button')
    const layers = document.querySelector<HTMLElement>('.adaptive-layers-shell')
    const inspector = document.querySelector<HTMLElement>('.properties-workspace')
    return {
      mode: shell?.getAttribute('data-ui-mode'),
      density: shell?.getAttribute('data-density'),
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      inlineLeft: bar?.style.left || '',
      position: style?.position,
      transform: style?.transform,
      canvasRow: workspace ? getComputedStyle(workspace).gridRow : '',
      toolbarInHeader: !!bar && !!windowBar && windowBar.contains(bar),
      zoomInHeader: !!zoom && !!windowBar && windowBar.contains(zoom),
      previewInHeader: !!preview && !!windowBar && windowBar.contains(preview),
      geometry: {
        toolbar: rectOf(bar),
        header: rectOf(windowBar),
        canvas: rectOf(workspace),
        zoom: rectOf(zoom),
        preview: rectOf(preview),
        layers: rectOf(layers),
        inspector: rectOf(inspector),
      },
      panels: {
        left: layers?.getBoundingClientRect().width || 0,
        right: inspector?.getBoundingClientRect().width || 0,
      },
      toolbarHits, headerHits, overlaps,
    }
  })

  for (const size of sizes) {
    await page.setViewportSize({ width: size.width, height: size.height })
    const density = size.width <= 900 ? 'narrow' : size.width <= 1180 ? 'desk' : 'wide'
    await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-density')).toBe(density)
    const toggles = page.locator('.canvas-panel-toggle')
    for (let index = 0; index < await toggles.count(); index += 1) {
      const toggle = toggles.nth(index)
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
    }
    for (const mode of ['sketch', 'figma'] as const) {
      await page.getByRole('button', { name: mode === 'sketch' ? 'Sketch' : 'Figma', exact: true }).click()
      await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-ui-mode')).toBe(mode)
      for (const locale of locales) {
        await page.locator('.locale-switch select').selectOption(locale.id)
        await expect(page.locator('.locale-switch select')).toHaveValue(locale.id)
        await expect(page.getByRole('button', { name: locale.arrange, exact: true })).toBeVisible()
        await page.mouse.move(2, 2)
        const hit = await probe()
        const required = [locale.arrange, locale.region, locale.text, locale.utility, locale.undo]
        const missing = required.filter(label => !hit.toolbarHits.some(button => button.label === label))
        const covered = hit.toolbarHits.filter(button => !button.ok)
        const headerMisses = hit.headerHits.filter(control => !control.ok)
        const language = hit.headerHits.find(control => control.label === locale.language)
        const shot = join(output, `${mode}-${locale.id}-${size.width}x${size.height}.png`)
        await page.screenshot({ path: shot })
        const entry: Record<string, unknown> = {
          size, mode, locale: locale.id, hit, missing, covered, headerMisses, overlaps: hit.overlaps, screenshot: shot,
        }
        const canvasRow = hit.canvasRow.replace(/\s/g, '')
        const near = (value: number, target: number) => Math.abs(value - target) <= 0.75
        const insideBar = (box: { x: number; y: number; w: number; h: number } | null, bar: { x: number; y: number; w: number; h: number } | null) =>
          !!box && !!bar && box.y >= bar.y - 0.75 && box.y + box.h <= bar.y + bar.h + 0.75 && box.x >= bar.x - 0.75 && box.x + box.w <= bar.x + bar.w + 0.75
        if (mode === 'sketch') {
          const bar = hit.geometry.header
          const tools = hit.geometry.toolbar
          if (!hit.toolbarInHeader || hit.position !== 'relative' || hit.inlineLeft !== '')
            failures.push(`${size.width} sketch tools left the window toolbar position=${hit.position} inlineLeft=${hit.inlineLeft} inHeader=${hit.toolbarInHeader}`)
          if (!bar || !near(bar.h, 52) || !near(bar.y, 0) || !near(bar.x, 0))
            failures.push(`${size.width} sketch window toolbar ${JSON.stringify(bar)}`)
          if (!tools || tools.y < -0.75 || tools.y + tools.h > 52.75)
            failures.push(`${size.width} sketch tool cluster is a second bar ${JSON.stringify(tools)}`)
          if (!hit.geometry.canvas || !near(hit.geometry.canvas.y, 53) || !/^3(\/auto)?$/.test(canvasRow))
            failures.push(`${size.width} sketch content ${JSON.stringify(hit.geometry.canvas)} row=${hit.canvasRow}`)
          if (hit.geometry.layers && !near(hit.geometry.layers.y, 53))
            failures.push(`${size.width} sketch layers ${JSON.stringify(hit.geometry.layers)}`)
          if (hit.geometry.inspector && !near(hit.geometry.inspector.y, 53))
            failures.push(`${size.width} sketch inspector ${JSON.stringify(hit.geometry.inspector)}`)
          if (!hit.zoomInHeader || !insideBar(hit.geometry.zoom, bar))
            failures.push(`${size.width} sketch zoom ${JSON.stringify(hit.geometry.zoom)}`)
          if (!hit.previewInHeader || !insideBar(hit.geometry.preview, bar))
            failures.push(`${size.width} sketch preview ${JSON.stringify(hit.geometry.preview)}`)
        }
        if (mode === 'figma') {
          const tools = hit.geometry.toolbar
          if (hit.toolbarInHeader || !tools || tools.y + tools.h < size.height - 40)
            failures.push(`${size.width} figma bottom pill moved ${JSON.stringify(tools)} inHeader=${hit.toolbarInHeader}`)
        }
        if (hit.panels.left < 180 || hit.panels.right < 180)
          failures.push(`${size.width} ${mode} panels closed left=${hit.panels.left} right=${hit.panels.right}`)
        if (missing.length) failures.push(`${size.width} ${mode} ${locale.id} missing ${missing.join(',')}`)
        if (covered.length) failures.push(`${size.width} ${mode} ${locale.id} covered ${covered.map(button => `${button.label}->${button.hit}`).join('; ')}`)
        if (!language?.ok) failures.push(`${size.width} ${mode} ${locale.id} language select ${language?.hit || 'missing'}`)
        if (headerMisses.length) failures.push(`${size.width} ${mode} ${locale.id} header ${headerMisses.map(control => `${control.label}->${control.hit}`).join('; ')}`)
        if (hit.overlaps.length) failures.push(`${size.width} ${mode} ${locale.id} overlap ${JSON.stringify(hit.overlaps)}`)
        if (!covered.length && !missing.length) {
          const clicks: Record<string, string> = {}
          for (const label of mode === 'sketch' ? [locale.arrange, locale.region, locale.text] : [locale.arrange]) {
            try {
              await page.getByRole('button', { name: label, exact: true }).click({ timeout: 5_000 })
              if (label === locale.text) {
                await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true')
                clicks[label] = 'pressed'
              } else {
                await expect(page.getByRole('menu', { name: label, exact: true })).toBeVisible()
                clicks[label] = 'menu'
                await page.keyboard.press('Escape')
                await expect(page.getByRole('menu', { name: label, exact: true })).toHaveCount(0)
              }
            } catch (error) {
              clicks[label] = String(error).split('\n')[0]
              failures.push(`${size.width} ${mode} ${locale.id} click ${label}: ${clicks[label]}`)
              await page.keyboard.press('Escape').catch(() => undefined)
            }
          }
          entry.clicks = clicks
        }
        ;(report.cases as unknown[]).push(entry)
        console.log(JSON.stringify({ size, mode, locale: locale.id, covered: covered.map(button => button.hit), overlaps: hit.overlaps.length, missing }))
      }
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
  await page?.close().catch(() => undefined)
  await browser?.close().catch(() => undefined)
  await server.close()
}
