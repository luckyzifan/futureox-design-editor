/** Real React/WASM UI against a capability mock; native IPC/filesystem is tested by design-desktop. */
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, node } from '../src/model'
import type { DesktopBridge, DesktopCommand } from '../src/desktop'

type TestState = {
  open: Awaited<ReturnType<DesktopBridge['openDocument']>>
  recovery: Awaited<ReturnType<DesktopBridge['readRecovery']>>
  saves: Parameters<DesktopBridge['saveDocument']>[0][]
  clears: Parameters<DesktopBridge['clearRecovery']>[0][]
  closeResponses: Parameters<DesktopBridge['respondToClose']>[0][]
  saveMode: 'ok' | 'fail' | 'delay'
  closeAccepted: boolean
  dirty?: boolean
  command: Parameters<DesktopBridge['onCommand']>[0]
  close: Parameters<DesktopBridge['onCloseRequested']>[0]
  finishSave: () => void
}
declare global { interface Window { __desktopTest: TestState } }


const output = process.env.DESIGN_TEST_OUTPUT || await mkdtemp(join(tmpdir(), 'forma-desktop-ui-'))
const server = spawn('bun', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '0', '--strictPort'], {
  cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite startup timeout')), 20000)
    server.on('exit', (code) => { clearTimeout(timer); reject(new Error(`Vite exited ${code}`)) })
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  browser = await chromium.launch({ headless: true, chromiumSandbox: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = [], remoteRequests: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('request', (request) => { if (request.url().includes('/api/')) remoteRequests.push(request.url()) })
  await page.addInitScript(() => {
    const state: TestState = { open: { status: 'cancelled' }, recovery: { status: 'cancelled' }, saves: [], clears: [], closeResponses: [], saveMode: 'ok', closeAccepted: true, command: () => {}, close: () => {}, finishSave: () => {} }
    const ok = { status: 'ok' } as const
    const saved = { status: 'ok', handle: 'test:file', displayName: 'Native.fd' } as const
    Object.defineProperty(window, '__desktopTest', { value: state })
    Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Desktop unexpectedly used browser IndexedDB') } })
    const bridge: DesktopBridge = {
      version: 1,
      openDocument: async () => state.open,
      acceptDocument: async () => ok,
      saveDocument: async (request) => {
        state.saves.push(request)
        if (state.saveMode === 'fail') return { status: 'error', code: 'IO_ERROR', message: 'Test write failure' }
        if (state.saveMode === 'delay') return new Promise((resolve) => { state.finishSave = () => resolve(saved) })
        return saved
      },
      readRecovery: async () => state.recovery,
      acceptRecovery: async () => ok,
      writeRecovery: async () => ok,
      clearRecovery: async (request) => { state.clears.push(request); return ok },
      setDirty: async (dirty: boolean) => { state.dirty = dirty },
      onCommand: (callback) => { state.command = callback; return () => {} },
      onCloseRequested: (callback) => { state.close = callback; return () => {} },
      respondToClose: async (response) => { state.closeResponses.push(response); return { accepted: state.closeAccepted } },
    }
    Object.defineProperty(window, 'coreDesktop', { value: bridge })
  })
  await page.goto(base)
  await expect(page.locator('[data-desktop-ready="true"]')).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.save-status')).toHaveText('●未保存到文件')
  await expect(page.getByRole('button', { name: '云端文件', exact: true })).toHaveCount(0)
  const name = page.getByLabel('文档名称')
  await name.fill('Keep current')
  const original = await name.inputValue()
  const command = (value: DesktopCommand) => page.evaluate((value) => window.__desktopTest.command(value), value)
  await command('open')
  await expect(name).toHaveValue(original)
  await page.evaluate(() => { window.__desktopTest.open = { status: 'ok', handle: 'bad', displayName: 'bad.fd', documentJson: '{' } })
  await command('open')
  await expect(page.locator('.save-status')).toHaveText('●操作失败，修改已保留')
  await expect(name).toHaveValue(original)
  await page.evaluate((documentJson) => { window.__desktopTest.open = { status: 'ok', handle: 'native:open', displayName: 'Native.fd', documentJson } }, JSON.stringify(blank('Native open')))
  await command('open')
  const prompt = page.getByRole('alertdialog')
  await expect(prompt).toBeVisible()
  await page.screenshot({ path: join(output, 'unsaved-modal.png') })
  await prompt.getByRole('button', { name: '取消', exact: true }).click()
  await expect(prompt).toHaveCount(0)
  await expect(name).toHaveValue(original)
  await command('open'); await prompt.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(name).toHaveValue('Native open')
  await expect(page.locator('.save-status')).toHaveText('已保存到文件')
  await name.fill('Save failure')
  await page.evaluate(() => { window.__desktopTest.saveMode = 'fail' })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.save-status')).toHaveText('●操作失败，修改已保留')
  await expect(name).toHaveValue('Save failure')
  await page.evaluate(() => { window.__desktopTest.saveMode = 'delay' })
  await command('save')
  await expect(page.locator('.save-status')).toHaveText('●保存中…')
  const count = await page.evaluate(() => window.__desktopTest.saves.length)
  await command('save'); await command('saveAs')
  expect(await page.evaluate(() => window.__desktopTest.saves.length)).toBe(count)
  await name.fill('Newer edit during save')
  await page.evaluate(() => window.__desktopTest.finishSave())
  await expect(page.locator('.save-status')).toHaveText('●未保存到文件')
  await page.evaluate(() => window.__desktopTest.close({ requestId: 'close-cancel' }))
  await expect(prompt).toBeVisible(); await prompt.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__desktopTest.closeResponses.at(-1))).toEqual({ requestId: 'close-cancel', allow: false })
  await page.evaluate(() => { const state = window.__desktopTest; state.closeAccepted = false; state.close({ requestId: 'stale-close' }) })
  await prompt.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(page.locator('.document-transition')).toHaveCount(0)
  await name.fill('After stale close')
  await expect(name).toHaveValue('After stale close')
  await page.evaluate((documentJson) => { const state = window.__desktopTest; state.recovery = { status: 'ok', recoveryHandle: 'recover:1', displayName: 'Recovered', documentJson }; state.saveMode = 'ok' }, JSON.stringify(blank('Recovered document')))
  await command('recover'); await prompt.getByRole('button', { name: '不保存', exact: true }).click()
  await expect(name).toHaveValue('Recovered document')
  await expect(page.locator('.save-status')).toHaveText('●未保存到文件')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.save-status')).toHaveText('已保存到文件')
  expect(await page.evaluate(() => window.__desktopTest.saves.at(-1)?.handle)).toBeUndefined()
  expect(await page.evaluate(() => window.__desktopTest.clears.some((value) => value?.recoveryHandle === 'recover:1'))).toBe(true)
  // Native commands deliberately do not blur the currently focused DOM field.
  const textDocument = blank('Pending input test'), textNode = node('text', 100, 100, 250, 60)
  textNode.text = 'Original draft'; textDocument.nodes[textNode.id] = textNode; textDocument.pages[0].children = [textNode.id]
  await page.evaluate((documentJson) => { window.__desktopTest.open = { status: 'ok', handle: 'text:open', displayName: 'Text.fd', documentJson } }, JSON.stringify(textDocument))
  await command('open'); await expect(name).toHaveValue('Pending input test')
  const canvas = page.getByTestId('canvas')
  const canvasBounds = await canvas.boundingBox()
  if (!canvasBounds) throw new Error('Desktop canvas is not visible')
  const centeredText = { x: canvasBounds.width / 2, y: canvasBounds.height / 2 }
  await canvas.dblclick({ position: centeredText })
  const canvasText = page.getByLabel('画布文字编辑')
  await expect(canvasText).toBeVisible(); await canvasText.fill('Unblurred native save')
  await command('save')
  await expect.poll(() => page.evaluate((id) => JSON.parse(window.__desktopTest.saves.at(-1)!.documentJson).nodes[id].text, textNode.id)).toBe('Unblurred native save')
  await canvas.dblclick({ position: centeredText })
  await expect(canvasText).toBeVisible(); await canvasText.dispatchEvent('compositionstart')
  const beforeImeSave = await page.evaluate(() => window.__desktopTest.saves.length)
  await command('save')
  await expect.poll(() => page.locator('.save-status').innerText()).not.toContain('保存中')
  expect(await page.evaluate(() => window.__desktopTest.saves.length)).toBe(beforeImeSave)
  await page.evaluate(() => window.__desktopTest.close({ requestId: 'ime-close' }))
  await expect.poll(() => page.evaluate(() => window.__desktopTest.closeResponses.at(-1))).toEqual({ requestId: 'ime-close', allow: false })
  await canvasText.fill('输入完成'); await canvasText.dispatchEvent('compositionend', { data: '输入完成' }); await command('save')
  await expect.poll(() => page.evaluate((id) => JSON.parse(window.__desktopTest.saves.at(-1)!.documentJson).nodes[id].text, textNode.id)).toBe('输入完成')
  const inspectorText = page.getByLabel('文字内容', { exact: true })
  await inspectorText.fill('Inspector unblurred'); await command('save')
  await expect.poll(() => page.evaluate((id) => JSON.parse(window.__desktopTest.saves.at(-1)!.documentJson).nodes[id].text, textNode.id)).toBe('Inspector unblurred')
  const width = page.getByLabel('W', { exact: true })
  await width.fill('300'); await command('save')
  await expect.poll(() => page.evaluate((id) => JSON.parse(window.__desktopTest.saves.at(-1)!.documentJson).nodes[id].width, textNode.id)).toBe(300)
  await page.screenshot({ path: join(output, 'desktop-editor.png') })
  // A separate browser page has no bridge and retains its existing IndexedDB autosave.
  const browserPage = await browser.newPage()
  await browserPage.goto(base)
  await expect(browserPage.locator('.save-status')).toHaveText('已保存到本机', { timeout: 30000 })
  await expect(browserPage.getByRole('button', { name: '云端文件', exact: true })).toBeVisible()
  expect(errors).toEqual([]); expect(remoteRequests).toEqual([])
  const results = { desktopFlows: 16, browserAutosave: true, errors, remoteRequests }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify({ output, ...results }))
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
