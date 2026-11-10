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
  { width: 1280, height: 800 },
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
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--disable-dev-shm-usage'] })
    report.browser = 'playwright-chromium'
  } catch (error) {
    report.bundledChromiumError = String(error).split('\n')[0]
    browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--disable-dev-shm-usage'] })
    report.browser = 'chrome-channel'
  }
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
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
    return {
      mode: shell?.getAttribute('data-ui-mode'),
      density: shell?.getAttribute('data-density'),
      inlineLeft: bar?.style.left || '',
      position: style?.position,
      transform: style?.transform,
      canvasRow: workspace ? getComputedStyle(workspace).gridRow : '',
      panels: {
        left: document.querySelector('.adaptive-layers-shell')?.getBoundingClientRect().width || 0,
        right: document.querySelector('.properties-workspace')?.getBoundingClientRect().width || 0,
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
        if (mode === 'sketch' && (hit.position !== 'relative' || hit.inlineLeft !== '' || !/^3(\/auto)?$/.test(canvasRow)))
          failures.push(`${size.width} sketch placement inlineLeft=${hit.inlineLeft} position=${hit.position} row=${hit.canvasRow}`)
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
