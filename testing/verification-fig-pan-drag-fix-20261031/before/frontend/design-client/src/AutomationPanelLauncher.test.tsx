// Actual React/DOM lifecycle under controlled module-load latency. This is not
// a browser/network/GPU startup measurement.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AutomationPanel } from './AutomationPanelLauncher'
import { Editor } from './engine'
import { blank } from './model'
import type { DesktopBridge } from './desktop'

type Loaded = Pick<typeof import('./AutomationPanel'), 'AutomationDialog'>
let dom: any, root: Root, mount: HTMLDivElement, editor: Editor, actual: Loaded
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let pending: ReturnType<typeof deferred<Loaded>>, load: ReturnType<typeof vi.fn<() => Promise<Loaded>>>
const disabled = { enabled: false, connectedClients: 0, pendingRequests: 0, journal: [] }
let status: ReturnType<typeof vi.fn>, subscribe: ReturnType<typeof vi.fn>, unsubscribe: ReturnType<typeof vi.fn>, enable: ReturnType<typeof vi.fn>
let desktop: DesktopBridge
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'KeyboardEvent']) vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  editor = new Editor(blank('Lazy dialog'))
  actual = await vi.importActual<typeof import('./AutomationPanel')>('./AutomationPanel')
  pending = deferred<Loaded>(); load = vi.fn(() => pending.promise)
  vi.doMock('./AutomationPanel', load)
  status = vi.fn(async () => disabled); unsubscribe = vi.fn(); subscribe = vi.fn(() => unsubscribe); enable = vi.fn()
  desktop = { automation: { status, onStatus: subscribe, enable } } as unknown as DesktopBridge
})
afterEach(async () => {
  await act(async () => root.unmount())
  editor.dispose(); dom.window.close(); vi.doUnmock('./AutomationPanel'); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const trigger = () => [...mount.querySelectorAll('button')].find(button => button.textContent === 'AI / MCP')!
const close = () => mount.querySelector<HTMLButtonElement>('[aria-label="关闭设计 API 与 MCP"]')!
const dialog = () => mount.querySelector<HTMLElement>('[role="dialog"]')
const key = (target: HTMLElement, value: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, shiftKey })
  target.dispatchEvent(event); return event
}
async function render(onHistory?: () => void) { await act(async () => root.render(<AutomationPanel editor={editor} desktop={desktop} onHistory={onHistory} />)) }
async function open() {
  await act(async () => trigger().click())
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
}
async function loaded() { await act(async () => { pending.resolve(actual); await vi.dynamicImportSettled() }) }

test('closed launcher loads no dialog; opening immediately shows focused cancellable loading with no MCP side effects', async () => {
  await render(); expect(load).not.toHaveBeenCalled(); expect(dialog()).toBeNull()
  await open()
  expect(dialog()?.getAttribute('aria-label')).toBe('设计 API 与 MCP')
  expect(dialog()?.getAttribute('aria-modal')).toBe('true')
  expect(mount.querySelector('[role="status"]')?.textContent).toContain('正在载入')
  expect(document.activeElement).toBe(close())
  expect(status).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled(); expect(enable).not.toHaveBeenCalled()
  await act(async () => { expect(key(close(), 'Tab').defaultPrevented).toBe(true); expect(key(close(), 'Tab', true).defaultPrevented).toBe(true) })
  expect(document.activeElement).toBe(close())
  await loaded(); expect(mount.textContent).not.toContain('正在载入')
  expect(status).toHaveBeenCalledTimes(1); expect(subscribe).toHaveBeenCalledTimes(1); expect(enable).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(close())
})

test('closing before resolution returns focus and late success cannot mount or subscribe', async () => {
  await render(); await open(); await act(async () => close().click())
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger())
  await loaded(); expect(dialog()).toBeNull(); expect(status).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled()
})

test('Escape during loading closes synchronously and an old failure stays silent', async () => {
  await render(); await open()
  await act(async () => { expect(key(close(), 'Escape').defaultPrevented).toBe(true) })
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger())
  await act(async () => { pending.reject(new Error('retired import')); await vi.dynamicImportSettled() })
  expect(mount.querySelector('[role="alert"]')).toBeNull(); expect(dialog()).toBeNull()
})

test('loaded close/reopen returns focus, unsubscribes and resets workspace/settings scopes', async () => {
  await render(); await open(); await loaded()
  const workspace = mount.querySelector<HTMLSelectElement>('[aria-label="工作区 MCP 权限"]')!
  const settings = mount.querySelector<HTMLSelectElement>('[aria-label="设置 MCP 权限"]')!
  await act(async () => {
    workspace.value = 'write'; workspace.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    settings.value = 'read'; settings.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  expect(enable).not.toHaveBeenCalled()
  await act(async () => { key(close(), 'Escape') })
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger()); expect(unsubscribe).toHaveBeenCalledTimes(1)
  await act(async () => trigger().click())
  expect(dialog()).not.toBeNull(); expect(load).toHaveBeenCalledTimes(1)
  expect(mount.querySelector<HTMLSelectElement>('[aria-label="工作区 MCP 权限"]')!.value).toBe('none')
  expect(mount.querySelector<HTMLSelectElement>('[aria-label="设置 MCP 权限"]')!.value).toBe('none')
  expect(document.activeElement).toBe(close()); expect(subscribe).toHaveBeenCalledTimes(2)
})

test('close/reopen while loading adopts only the newest open and unmount retires unfinished work', async () => {
  await render(); await open(); await act(async () => close().click()); await act(async () => trigger().click())
  await loaded(); expect(dialog()).not.toBeNull(); expect(subscribe).toHaveBeenCalledTimes(1)
  await act(async () => root.render(<div />)); expect(unsubscribe).toHaveBeenCalledTimes(1)
  // A fresh mounted launcher has its own lifetime even when the module resolves later.
  pending = deferred<Loaded>(); load = vi.fn(() => pending.promise); vi.doMock('./AutomationPanel', load)
  await render(); await open(); await act(async () => root.render(<div />)); await loaded()
  expect(dialog()).toBeNull(); expect(subscribe).toHaveBeenCalledTimes(1)
})

test('load failure is visible, focus stays trapped, and explicit retry recovers without enabling MCP', async () => {
  await render(); await open()
  await act(async () => { pending.reject(new Error('chunk unavailable')); await vi.dynamicImportSettled() })
  // Vitest wraps rejected module factories; assert the actual visible failure,
  // rather than assuming that mock-runner wrapper has a browser error message.
  expect(mount.querySelector('[role="alert"]')?.textContent).toContain('面板载入失败：')
  const retry = [...mount.querySelectorAll('button')].find(button => button.textContent === '重试')!
  await act(async () => { expect(key(close(), 'Tab', true).defaultPrevented).toBe(true) })
  expect(document.activeElement).toBe(retry)
  await act(async () => { expect(key(retry, 'Tab').defaultPrevented).toBe(true) }); expect(document.activeElement).toBe(close())
  pending = deferred<Loaded>(); load = vi.fn(() => pending.promise); vi.doMock('./AutomationPanel', load)
  await act(async () => retry.click()); await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
  expect(mount.querySelector('[role="alert"]')).toBeNull(); expect(mount.textContent).toContain('正在载入'); expect(document.activeElement).toBe(close())
  await loaded(); expect(status).toHaveBeenCalledTimes(1); expect(enable).not.toHaveBeenCalled(); expect(document.activeElement).toBe(close())
})

test('history callback still closes and returns focus before opening the destination', async () => {
  const history = vi.fn(() => expect(document.activeElement).toBe(trigger()))
  await render(history); await open(); await loaded()
  const historyButton = [...mount.querySelectorAll('button')].find(button => button.textContent === '文档版本与恢复')!
  await act(async () => historyButton.click())
  expect(history).toHaveBeenCalledTimes(1); expect(dialog()).toBeNull(); expect(unsubscribe).toHaveBeenCalledTimes(1)
})

test('production uses the lightweight entry and preserves all dialog code and desktop registration wiring', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const previous = read('../../../testing/verification-optional-startup/AutomationPanel.before.tsx'), current = read('./AutomationPanel.tsx')
  const retained = previous.slice(previous.indexOf('export function AutomationDialog('))
  const before = 'download(out.filename,out.content,out.mimeType)'
  const after = 'download(out.filename,out.content ?? Uint8Array.from(atob(out.base64!), c => c.charCodeAt(0)),out.mimeType)'
  expect(retained.split(before)).toHaveLength(2)
  // SVGZ resource support is the sole permitted dialog-body change. Retain
  // the immutable old source rather than regenerating a passing baseline.
  expect(current.slice(current.indexOf('export function AutomationDialog('))).toBe(retained.replace(before, after))
  const app = read('./App.tsx'), oldApp = read('../../../testing/verification-optional-startup/App.before.tsx')
  const start = "  useEffect(() => {\n    if (!ready || !desktop?.automation) return"
  const end = '  }, [ready, desktop, editor, desktopSession])'
  const bridge = (text: string) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)) + end.length)
  // Source workspaces intentionally do not register ordinary-document automation.
  const normalized = app.replace('if (!ready || !desktop?.automation || source || largeDocument) return',
    'if (!ready || !desktop?.automation) return').replace('  }, [ready, desktop, editor, desktopSession, largeDocument])', end)
  expect(app).toContain('if (!ready || !desktop?.automation || source || largeDocument) return')
  expect(bridge(normalized)).toBe(bridge(oldApp)); expect(bridge(normalized)).toContain('const detach = attachDesktopAutomation(editor, desktop.automation, { host })')
  expect(app).toContain("import { AutomationPanel } from './AutomationPanelLauncher'")
  expect(app).toContain("import { attachDesktopAutomation } from './automation/bridge'")
})
