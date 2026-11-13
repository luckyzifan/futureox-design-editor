import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { expect, test } from 'vitest'

const css = ['styles.css', 'chrome-polish.css'].map(name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')).join('\n')

function pageHtml() {
  return `<!doctype html><html><head><style>${css}</style></head><body>
    <div class="feature-backdrop">
      <section class="design-tools export-panel" role="dialog" aria-label="导出图像">
        <header><strong>导出图像</strong><button type="button">关闭</button></header>
        <fieldset>
          <legend>导出目标</legend>
          <label><input type="radio" name="export-target" checked>全部图层预设</label>
        </fieldset>
        <div class="all-assets-export" role="group" aria-label="全部资产">
          <p>按各层已有预设分别列出任务。</p>
          <fieldset>
            <legend>范围</legend>
            <label><input type="radio" checked>当前页面</label>
            <label><input type="radio">整个文档</label>
          </fieldset>
          <div class="all-assets-filters">
            <label>图层<input aria-label="搜索全部资产" value=""></label>
            <label>格式<select aria-label="按格式筛选资产"><option>全部格式</option><option>PNG</option><option>SVG</option></select></label>
            <label>倍率<select aria-label="按倍率筛选资产"><option>全部倍率</option><option>1x</option></select></label>
          </div>
          <div class="feature-row">
            <button type="button">勾选所列</button>
            <button type="button">取消所列</button>
            <span>已选 4 / 4 项预设</span>
          </div>
          <div class="all-assets-list">
            <section class="all-assets-layer"><label><input type="checkbox" checked><strong>矩形</strong></label>
              <label class="all-assets-task"><input type="checkbox" checked><span>PNG · 1x · @one · 矩形@one.png</span></label>
              <label class="all-assets-task"><input type="checkbox" checked><span>SVG · 1x · @vector · 矩形@vector.svg</span></label>
            </section>
            <section class="all-assets-layer"><label><input type="checkbox" checked><strong>椭圆</strong></label>
              <label class="all-assets-task"><input type="checkbox" checked><span>PNG · 1x · @one · 椭圆@one.png</span></label>
              <label class="all-assets-task"><input type="checkbox" checked><span>SVG · 1x · @vector · 椭圆@vector.svg</span></label>
            </section>
          </div>
          <div class="feature-row"><button type="button" id="export-presets">导出所选预设</button></div>
        </div>
      </section>
    </div>
  </body></html>`
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const rect = (selector: string) => {
      const box = document.querySelector(selector)!.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
    }
    const dialog = rect('.export-panel')
    const button = document.querySelector<HTMLElement>('#export-presets')!
    button.scrollIntoView({ block: 'nearest' })
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog,
      button: rect('#export-presets'),
      search: rect('[aria-label="搜索全部资产"]'),
      checkbox: rect('.all-assets-task input'),
      overflow: getComputedStyle(document.querySelector('.export-panel')!).overflowY,
    }
  })
}

test('the all-assets dialog stays operable at the minimum desktop window', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: 1 })
    await page.setContent(pageHtml(), { waitUntil: 'load' })
    for (const viewport of [{ width: 1000, height: 640 }, { width: 800, height: 640 }, { width: 560, height: 420 }]) {
      await page.setViewportSize(viewport)
      const measured = await boxes(page)
      expect(measured.viewport).toEqual(viewport)
      expect(measured.dialog.width).toBeGreaterThan(280)
      expect(measured.dialog.width).toBeLessThanOrEqual(viewport.width)
      expect(measured.dialog.height).toBeLessThanOrEqual(viewport.height)
      expect(measured.overflow).toBe('auto')
      expect(measured.search.width).toBeGreaterThan(40)
      expect(measured.checkbox.width).toBeGreaterThan(8)
      expect(measured.button.width).toBeGreaterThan(24)
      expect(measured.button.height).toBeGreaterThan(16)
      expect(measured.button.bottom).toBeLessThanOrEqual(viewport.height + 1)
      expect(measured.button.right).toBeLessThanOrEqual(viewport.width + 1)
      expect(measured.button.y).toBeGreaterThanOrEqual(-1)
    }
  } finally {
    await browser.close()
  }
})
