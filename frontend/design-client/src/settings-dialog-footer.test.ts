import { readFileSync } from 'node:fs'
import { chromium, type Page } from 'playwright'
import { expect, test } from 'vitest'

const css = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

function pageHtml() {
  const sheets = ['settings-dialog.css', 'styles.css', 'chrome-polish.css']
    .map(name => `<style data-file="${name}">${css(name)}</style>`)
    .join('\n')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${sheets}</head><body>
    <footer class="status-bar-control">状态</footer>
    <section class="design-tools export-panel" id="export-sample"><div class="feature-row"><button type="button">生成 PNG</button></div></section>
    <section class="remote-modal" id="remote-sample"></section>
    <div class="settings-backdrop">
      <section class="settings-dialog" role="dialog">
        <header class="settings-header"><div><h2>设置</h2><p>当前应用偏好 · 更改立即生效，保存在当前应用配置中。</p></div><button type="button" aria-label="关闭设置">×</button></header>
        <div class="settings-layout">
          <div class="settings-tabs"><button type="button" aria-selected="true">操作习惯</button><button type="button">画布辅助</button><button type="button">保存与范围</button><button type="button">Nomi 伙伴</button><button type="button">设计助手</button><button type="button">错误日志</button></div>
          <div class="settings-content">
            <h3>键盘</h3>
            <section class="keyboard-profile-settings"><label>快捷键方案</label><select><option>Figma-like</option></select><small>常用快捷键预设，只影响本机；非完整兼容。Windows / Linux 使用 Ctrl。浏览器保留刷新、查找和切换标签页快捷键。</small><small>钢笔 P · 铅笔 Shift P · 切片 S · 适合全部 Shift 1 · 重命名 ⌘ R</small></section>
            <div class="nudge-settings"><h3>键盘微移</h3><p class="settings-help">方向键使用小步长，Shift＋方向键使用大步长。位置、矢量节点与 Sketch-like 尺寸快捷键共用设置；相机平移不受影响。长按为一次撤销，松键或移开焦点完成，Esc 取消。</p><label>小步长 <input type="number" value="1"></label><label>大步长 <input type="number" value="10"></label></div>
            <h3>画布导航</h3>
            <label class="settings-toggle"><input type="checkbox"><span>滚轮围绕鼠标缩放</span></label>
            <p class="settings-help">关闭时，滚轮平移；Ctrl / ⌘＋滚轮及触控板捏合仍可缩放。空格拖动或 H 手形工具平移。</p>
          </div>
        </div>
        <footer class="settings-footer">
          <div class="settings-status">更改立即生效。偏好会尝试保存在当前配置。</div>
          <div class="settings-actions"><button type="button" class="secondary">恢复偏好默认值</button><button type="button" class="primary">完成</button></div>
        </footer>
      </section>
    </div>
  </body></html>`
}

function insideRoundedRect(box: { x: number; y: number; width: number; height: number }, radius: number, x: number, y: number) {
  const right = box.x + box.width
  const bottom = box.y + box.height
  if (x < box.x || y < box.y || x > right || y > bottom) return false
  const corners = [
    [box.x + radius, box.y + radius, x < box.x + radius && y < box.y + radius],
    [right - radius, box.y + radius, x > right - radius && y < box.y + radius],
    [box.x + radius, bottom - radius, x < box.x + radius && y > bottom - radius],
    [right - radius, bottom - radius, x > right - radius && y > bottom - radius],
  ] as const
  return corners.every(([cx, cy, corner]) => !corner || (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 + 0.25)
}

async function measure(page: Page) {
  return page.evaluate(() => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right }
    }
    const dialog = document.querySelector<HTMLElement>('.settings-dialog')!
    const footer = document.querySelector<HTMLElement>('.settings-footer')!
    const status = document.querySelector<HTMLElement>('.settings-status')!
    const buttons = [...footer.querySelectorAll<HTMLElement>('button')]
    const dialogStyle = getComputedStyle(dialog)
    const exportStyle = getComputedStyle(document.querySelector('#export-sample')!)
    const remoteStyle = getComputedStyle(document.querySelector('#remote-sample')!)
    const points = (box: { x: number; y: number; width: number; height: number; bottom: number }) =>
      [1, box.width / 2, box.width - 1].map(dx => ({ x: box.x + dx, y: box.bottom - 0.5 }))
    return {
      viewport: { width: innerWidth, height: innerHeight },
      dialog: { ...rect(dialog), radius: dialogStyle.borderTopLeftRadius, shadow: dialogStyle.boxShadow, overflow: dialogStyle.overflow },
      footer: { ...rect(footer), height: getComputedStyle(footer).height, padding: getComputedStyle(footer).padding },
      status: { ...rect(status), fontSize: getComputedStyle(status).fontSize, text: status.textContent },
      buttons: buttons.map(button => ({ ...rect(button), text: button.textContent, fontSize: getComputedStyle(button).fontSize })),
      bareFooterHeight: getComputedStyle(document.querySelector('footer.status-bar-control')!).height,
      export: { radius: exportStyle.borderTopLeftRadius, shadow: exportStyle.boxShadow },
      remoteShadow: remoteStyle.boxShadow,
      samples: [...points(rect(status)), ...buttons.flatMap(button => points(rect(button)))],
    }
  })
}

test('settings footer is fully inside the rounded dialog and matches the export modal', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 928 }, deviceScaleFactor: 1 })
    await page.setContent(pageHtml(), { waitUntil: 'load' })
    for (const viewport of [{ width: 1440, height: 928 }, { width: 1440, height: 960 }, { width: 1440, height: 600 }]) {
      await page.setViewportSize(viewport)
      const measured = await measure(page)
      expect(measured.viewport).toEqual(viewport)
      expect(measured.buttons.map(button => button.text)).toEqual(['恢复偏好默认值', '完成'])
      expect(measured.status.text).toContain('更改立即生效')
      expect(measured.bareFooterHeight).toBe('29px')
      expect(measured.footer.height).not.toBe('29px')
      expect(measured.footer.height.endsWith('px')).toBe(true)
      expect(parseFloat(measured.footer.height)).toBeGreaterThan(29)
      expect(measured.dialog.radius).toBe('12px')
      expect(measured.dialog.radius).toBe(measured.export.radius)
      expect(measured.dialog.shadow).toBe(measured.export.shadow)
      expect(measured.dialog.overflow).toBe('hidden')
      expect(measured.status.fontSize).toBe('12px')
      const radius = parseFloat(measured.dialog.radius)
      for (const button of measured.buttons) {
        expect(button.fontSize).toBe('12px')
        expect(button.width).toBeGreaterThan(24)
        expect(button.height).toBeGreaterThan(24)
        expect(measured.dialog.bottom - button.bottom).toBeGreaterThanOrEqual(radius)
      }
      expect(measured.dialog.bottom - measured.status.bottom).toBeGreaterThanOrEqual(radius)
      expect(measured.samples.length).toBeGreaterThanOrEqual(9)
      for (const point of measured.samples) {
        expect(insideRoundedRect(measured.dialog, radius, point.x, point.y)).toBe(true)
      }
    }
  } finally {
    await browser.close()
  }
})
