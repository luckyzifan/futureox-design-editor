/** Headed layout measurement for the Figma hand/zoom group above the bottom pill.
 *  DOM presence is not a pass: the control center must hit itself at 1440×960 and 1440×600. */
import { chromium, expect, type Browser, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join('/tmp', 'figma-view-tools')
await mkdir(output, { recursive: true })

type Box = { x: number; y: number; w: number; h: number }
type Probe = {
  dpr: number
  viewport: { w: number; h: number }
  mode: string | null
  pill: Box
  hand: Box
  zoom: Box
  group: Box
  zoomText: string
  handHit: string | null
  zoomHit: string | null
  handOk: boolean
  zoomOk: boolean
  aboveCount: number
  zoomInInspector: boolean
  panels: { left: number; right: number }
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
  headed: true,
  note: 'Headed Chrome CSS-pixel measurement. DPR is forced to 1. Pill width and height are recorded, not compared to an official Figma size.',
  cases: [] as unknown[],
}
const failures: string[] = []

function intersects(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}
function insideViewport(box: Box, width: number, height: number) {
  return box.x >= -0.5 && box.y >= -0.5 && box.x + box.w <= width + 0.5 && box.y + box.h <= height + 0.5 && box.w >= 8 && box.h >= 8
}

try {
  await server.listen()
  const base = server.resolvedUrls?.local?.[0]
  if (!base) throw new Error('Vite did not report a local URL')
  report.base = base
  const launch = { headless: false, args: ['--disable-dev-shm-usage', '--window-size=1440,960'] } as const
  try {
    browser = await chromium.launch({ ...launch, chromiumSandbox: true })
    report.browser = 'playwright-chromium-headed'
  } catch (error) {
    report.bundledChromiumError = String(error).split('\n')[0]
    browser = await chromium.launch({ ...launch, channel: 'chrome' })
    report.browser = 'chrome-channel-headed'
  }
  page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(String(error)))
  // The shared shell mounts only when the desktop bridge is present. This stub
  // has no workspace and no native window, so Chrome measures the same editor
  // chrome without launching Electron.
  await page.addInitScript(() => {
    const ok = async () => ({ status: 'ok' })
    const cancelled = async () => ({ status: 'cancelled' })
    Object.defineProperty(window, 'coreDesktop', {
      configurable: true,
      value: {
        version: 1,
        renderPolicy: { cpuOnly: true },
        readRecovery: cancelled,
        writeRecovery: ok,
        clearRecovery: ok,
        setDirty: async () => {},
        openDocument: cancelled,
        saveDocument: cancelled,
        acceptDocument: ok,
        onCommand: () => () => {},
        onCloseRequested: () => () => {},
        respondToClose: async () => ({ accepted: true }),
      },
    })
  })
  await page.goto(base)
  await expect(page.locator('.editor-shell')).toBeVisible({ timeout: 90_000 })
  const create = page.getByRole('button', { name: '新建设计', exact: true })
  await expect(create).toBeEnabled({ timeout: 90_000 })
  await create.click()
  await expect(page.locator('.local-home')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.locator('.floating-toolbar')).toBeVisible()
  report.pageErrors = errors

  const measure = () => page!.evaluate(() => {
    const describe = (element: Element | null) => element ? `${element.tagName.toLowerCase()}[${element.getAttribute('aria-label') || element.getAttribute('data-testid') || element.className}]` : null
    const boxOf = (element: Element) => {
      const rect = element.getBoundingClientRect()
      return { x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2) }
    }
    const pill = document.querySelector<HTMLElement>('.floating-toolbar')
    const hand = document.querySelector<HTMLElement>('[data-testid="figma-view-tools"] > button')
    const zoom = document.querySelector<HTMLElement>('[data-testid="zoom-readout"]')
    const group = document.querySelector<HTMLElement>('[data-testid="figma-view-tools"]')
    if (!pill || !hand || !zoom || !group) return { missing: { pill: !pill, hand: !hand, zoom: !zoom, group: !group } }
    const hitOf = (element: HTMLElement) => {
      const box = boxOf(element)
      const hit = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2)
      return { hit: describe(hit), ok: !!hit && (hit === element || element.contains(hit)) }
    }
    const pillBox = boxOf(pill)
    const buttons = [...document.querySelectorAll<HTMLElement>('button')].filter(button => {
      const box = boxOf(button)
      const above = box.y + box.h <= pillBox.y + 0.5 && box.y + box.h > pillBox.y - 80
      const across = box.x < pillBox.x + pillBox.w && box.x + box.w > pillBox.x
      const style = getComputedStyle(button)
      return above && across && style.display !== 'none' && style.visibility !== 'hidden' && box.w >= 2 && box.h >= 2
    })
    const handHit = hitOf(hand)
    const zoomHit = hitOf(zoom)
    return {
      dpr: window.devicePixelRatio,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      mode: document.querySelector('.editor-shell')?.getAttribute('data-ui-mode') ?? null,
      pill: pillBox,
      hand: boxOf(hand),
      zoom: boxOf(zoom),
      group: boxOf(group),
      zoomText: zoom.textContent?.trim() ?? '',
      handHit: handHit.hit,
      zoomHit: zoomHit.hit,
      handOk: handHit.ok,
      zoomOk: zoomHit.ok,
      aboveCount: buttons.length,
      zoomInInspector: !!zoom.closest('.properties-tabs,.properties-zoom'),
      panels: {
        left: document.querySelector('.adaptive-layers-shell')?.getBoundingClientRect().width || 0,
        right: document.querySelector('.properties-workspace')?.getBoundingClientRect().width || 0,
      },
    }
  })

  for (const size of [{ width: 1440, height: 960 }, { width: 1440, height: 600 }] as const) {
    await page.setViewportSize({ width: size.width, height: size.height })
    const session = await page.context().newCDPSession(page)
    await session.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false })
    await page.getByRole('button', { name: 'Figma', exact: true }).click()
    await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-ui-mode')).toBe('figma')
    await expect(page.locator('[data-testid="figma-view-tools"] [data-testid="zoom-readout"]')).toBeVisible()
    const hit = await measure() as Probe | { missing: Record<string, boolean> }
    if (!('pill' in hit)) {
      failures.push(`${size.width}x${size.height} missing ${JSON.stringify(hit)}`)
      continue
    }
    const pill = hit.pill
    const center = pill.x + pill.w / 2
    const gap = (box: Box) => +(pill.y - (box.y + box.h)).toFixed(2)
    const problems: string[] = []
    if (Math.abs(hit.dpr - 1) > 0.02) problems.push(`dpr ${hit.dpr}`)
    if (hit.viewport.w !== size.width || hit.viewport.h !== size.height) problems.push(`viewport ${hit.viewport.w}x${hit.viewport.h}`)
    if (Math.abs(center - size.width / 2) > 4) problems.push(`pill center ${center}`)
    if (pill.w > size.width * 0.7 || pill.w < 300) problems.push(`pill width ${pill.w}`)
    if (pill.h < 40 || pill.h > 70) problems.push(`pill height ${pill.h}`)
    const bottomGap = size.height - (pill.y + pill.h)
    if (bottomGap < 8 || bottomGap > 20) problems.push(`pill bottom gap ${bottomGap}`)
    if (pill.y < size.height * 0.7) problems.push(`pill top ${pill.y}`)
    for (const [name, box] of [['hand', hit.hand], ['zoom', hit.zoom]] as const) {
      if (!insideViewport(box, size.width, size.height)) problems.push(`${name} outside ${JSON.stringify(box)}`)
      if (intersects(box, pill)) problems.push(`${name} intersects pill`)
      const space = gap(box)
      if (space < 4 || space > 20) problems.push(`${name} gap ${space}`)
      if (pill.y - box.y > 80) problems.push(`${name} farther than 80px`)
      if (!(box.x < pill.x + pill.w && box.x + box.w > pill.x)) problems.push(`${name} misses pill horizontally`)
    }
    if (!hit.handOk) problems.push(`hand hit ${hit.handHit}`)
    if (!hit.zoomOk) problems.push(`zoom hit ${hit.zoomHit}`)
    if (hit.aboveCount < 1) problems.push(`above count ${hit.aboveCount}`)
    if (hit.zoomInInspector) problems.push('zoom still in inspector')
    if (!/%$/.test(hit.zoomText)) problems.push(`zoom text ${hit.zoomText}`)
    if (hit.panels.right < 180) problems.push(`inspector closed ${hit.panels.right}`)
    const shot = join(output, `figma-${size.width}x${size.height}.png`)
    await page.screenshot({ path: shot })
    let clicks: Record<string, string> = {}
    let menu: Box | null = null
    if (!problems.length) {
      try {
        await page.locator('[data-testid="figma-view-tools"] > button').click({ timeout: 5_000 })
        await expect(page.locator('[data-testid="figma-view-tools"] > button')).toHaveAttribute('aria-pressed', 'true')
        clicks.hand = 'pressed'
        await page.getByTestId('zoom-readout').click({ timeout: 5_000 })
        const menuLocator = page.locator('.figma-view-tools .view-menu-body')
        await expect(menuLocator).toBeVisible()
        menu = await menuLocator.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { x: +rect.x.toFixed(2), y: +rect.y.toFixed(2), w: +rect.width.toFixed(2), h: +rect.height.toFixed(2) }
        })
        if (!insideViewport(menu, size.width, size.height)) problems.push(`menu clipped ${JSON.stringify(menu)}`)
        if (menu.y + menu.h > pill.y + 0.5) problems.push(`menu opens into the pill ${menu.y + menu.h} > ${pill.y}`)
        const preset = menuLocator.getByRole('button', { name: '100%', exact: true })
        const presetHit = await preset.evaluate(element => {
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return !!hit && (hit === element || element.contains(hit))
        })
        if (!presetHit) problems.push('zoom preset center is covered')
        else clicks.zoom = 'menu'
        await page.keyboard.press('Escape')
        await expect(menuLocator).toBeHidden()
      } catch (error) {
        clicks.error = String(error).split('\n')[0]
        problems.push(clicks.error)
        await page.keyboard.press('Escape').catch(() => undefined)
      }
    }
    await page.getByRole('button', { name: 'Sketch', exact: true }).click()
    await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-ui-mode')).toBe('sketch')
    const sketch = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('.floating-toolbar')
      const rect = bar?.getBoundingClientRect()
      const button = bar?.querySelector<HTMLElement>('button')
      const buttonRect = button?.getBoundingClientRect()
      const hit = buttonRect ? document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2) : null
      return {
        tools: document.querySelectorAll('[data-testid="figma-view-tools"]').length,
        position: bar ? getComputedStyle(bar).position : null,
        top: rect ? +rect.top.toFixed(2) : null,
        buttonOk: !!button && !!hit && (hit === button || button.contains(hit)),
      }
    })
    if (sketch.tools !== 0) problems.push('sketch still has the figma hand/zoom group')
    if (sketch.position !== 'relative' || sketch.top === null || sketch.top > 180) problems.push(`sketch toolbar moved ${sketch.position} top=${sketch.top}`)
    if (!sketch.buttonOk) problems.push('sketch toolbar button center is covered')
    if (problems.length) failures.push(`${size.width}x${size.height} ${problems.join('; ')}`)
    ;(report.cases as unknown[]).push({ size, hit, menu, clicks, sketch, screenshot: shot, problems })
    console.log(JSON.stringify({ size, pill: hit.pill, hand: hit.hand, zoom: hit.zoom, group: hit.group, zoomText: hit.zoomText, handOk: hit.handOk, zoomOk: hit.zoomOk, aboveCount: hit.aboveCount, menu, problems }))
    await page.getByRole('button', { name: 'Figma', exact: true }).click()
    await expect.poll(async () => page!.locator('.editor-shell').getAttribute('data-ui-mode')).toBe('figma')
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
