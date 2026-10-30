import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const output = process.env.DESIGN_TEST_OUTPUT || (await mkdtemp(join(tmpdir(), 'forma-authoring-')))
const server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite exited ${code}`))
    })
    server.stdout.on('data', (chunk) => {
      const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (m) {
        clearTimeout(timer)
        resolve(m[0])
      }
    })
  })
  browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    args: [
      ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    ],
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
  })
  await page.goto(`${base}/authoring-check.html`)
  await page.getByRole('button', { name: '执行回归', exact: true }).click()
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#authoring-status')?.textContent
      return s === '通过' || s?.startsWith('Error:')
    },
    {},
    { timeout: 120000 },
  )
  if ((await page.locator('#authoring-status').innerText()) !== '通过') {
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify(
        { status: await page.locator('#authoring-status').innerText(), errors },
        null,
        2,
      ),
    )
    console.log(
      JSON.stringify({
        output,
        errors,
        gpu: await page.evaluate(async () => {
          const a = await navigator.gpu?.requestAdapter()
          return a
            ? {
                vendor: a.info.vendor,
                architecture: a.info.architecture,
                device: a.info.device,
                description: a.info.description,
              }
            : null
        }),
      }),
    )
    throw new Error(await page.locator('#authoring-status').innerText())
  }
  const rendering = JSON.parse(await page.locator('#authoring-results').innerText())
  // Exercise the same canvas text host used by the product, including selection styling.
  await page.getByRole('button', { name: '设计系统与原型', exact: true }).click()
  await page.getByRole('button', { name: '新建集合', exact: true }).click()
  await expect(page.getByLabel('主题 当前模式')).toBeVisible()
  await page.getByRole('button', { name: '+ color', exact: true }).click()
  await page.getByLabel('变量名称').fill('Brand')
  await page.getByLabel('主题 当前模式').selectOption('Dark')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.canvas').dblclick({ position: { x: 90, y: 65 } })
  const text = page.getByLabel('画布文字编辑')
  await expect(text).toBeAttached()
  await text.fill('中文编辑\nMixed text')
  await text.press('ControlOrMeta+A')
  await page.getByTitle('下划线', { exact: true }).click()
  await page.screenshot({ path: join(output, 'rich-text.png'), fullPage: true })
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await expect(page.getByLabel('文字内容')).toHaveValue('中文编辑\nMixed text')
  await page.getByRole('button', { name: '设计系统与原型', exact: true }).click()
  await page.getByRole('button', { name: '交互原型', exact: true }).click()
  await page.getByRole('button', { name: '将选中图层设为起点', exact: true }).click()
  await page.getByRole('button', { name: '播放原型', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '交互原型预览' })).toBeVisible()
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.screenshot({ path: join(output, 'authoring.png'), fullPage: true })
  if (errors.length) throw new Error(errors.join('\n'))
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      { rendering, variableUi: true, richTextUi: true, prototypeUi: true, errors },
      null,
      2,
    ),
  )
  console.log(
    JSON.stringify({
      output,
      rendering,
      variableUi: true,
      richTextUi: true,
      prototypeUi: true,
      errors,
    }),
  )
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
