import { desktopPet } from './desktop-pet'
// Real React/DOM events and Editor/WASM. jsdom does not claim browser layout/GPU validation.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, StrictMode, useState, useSyncExternalStore } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { SettingsDialog } from './SettingsDialog'
import { ViewControls } from './ViewControls'
import { bindEditorSettings, DEFAULT_CANVAS_SETTINGS, SETTINGS_PREFERENCE_KEY, settingsPreference } from './settings-preference'
import { shortcutPreference, SHORTCUT_PROFILE_KEY } from './shortcut-preference'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { wheelCamera } from './canvas-camera'

let root: Root, mount: HTMLDivElement, canvas: HTMLDivElement, trigger: HTMLButtonElement, dom: any, editor: Editor
const cleanups: (() => void)[] = []
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'StorageEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); settingsPreference.reset(); shortcutPreference.set('figma-like')
  mount = document.createElement('div'); document.body.append(mount); root = createRoot(mount)
  canvas = document.createElement('div'); canvas.tabIndex = 0; canvas.dataset.testid = 'canvas'; document.body.append(canvas)
  trigger = document.createElement('button'); trigger.textContent = 'Settings trigger'; document.body.append(trigger); trigger.focus()
  const doc = blank('Settings DOM'), shape = node('rectangle', 10, 20, 40, 50)
  doc.nodes[shape.id] = shape; doc.pages[0].children.push(shape.id)
  editor = new Editor(doc); editor.select([shape.id])
  cleanups.push(bindEditorSettings(editor))
})
afterEach(async () => {
  await act(async () => root.unmount())
  cleanups.splice(0).forEach(stop => stop()); editor.dispose(); vi.restoreAllMocks(); dom.window.close(); vi.unstubAllGlobals()
})
function key(target: EventTarget, value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value, bubbles: true, cancelable: true, ...options })
  target.dispatchEvent(event); return event
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('.settings-dialog button')].find(item => item.textContent === text)!
const checkbox = (label: string) => [...dialog().querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === label)!.querySelector<HTMLInputElement>('input')!
async function tab(label: string) { await act(async () => button(label).click()) }
function Harness({ desktop = false, busy = false }: { desktop?: boolean; busy?: boolean }) {
  const [open, setOpen] = useState(true)
  useSyncExternalStore(editor.subscribe, editor.snapshot)
  return <><button onClick={() => setOpen(true)}>Reopen</button><ViewControls editor={editor} size={{ width: 1000, height: 700 }} fit={() => {}} />
    {open && <SettingsDialog editor={editor} onClose={() => setOpen(false)} desktop={desktop} returnFocus={trigger} busy={busy}
      workspaceControls={<div data-workspace-control>本机工作区位置<button type="button">选择目录</button></div>} />}</>
}

test('real checkboxes update Editor, persist through close/reopen and preserve document, precision and history', async () => {
  editor.update(editor.state.selection, { opacity: 0.42 })
  const original = editor.state.doc, version = editor.state.version
  editor.set({ view: { x: 0.123456789, y: -543.987654321, zoom: 4.000000123 } })
  const view = editor.state.view
  await act(async () => root.render(<Harness />)); await tab('画布辅助')
  for (const label of ['智能吸附', '吸附到像素网格', '像素网格', '标尺与参考线', '棋盘格背景', '画布网格']) {
    await act(async () => checkbox(label).click())
  }
  expect(editor.state).toMatchObject({ snap: false, snapPixels: false, pixelGrid: false, rulers: true, checkerboard: true, grid: true })
  expect(JSON.parse(localStorage.getItem(SETTINGS_PREFERENCE_KEY)!)).toEqual({ snap: false, snapPixels: false, pixelGrid: false, rulers: true, checkerboard: true, grid: true })
  expect(editor.state.doc).toBe(original); expect(editor.state.view).toBe(view); expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(false)
  await act(async () => button('完成').click()); expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger)
  await act(async () => mount.querySelector('button')!.click()); await tab('画布辅助')
  expect(checkbox('棋盘格背景').checked).toBe(true); expect(checkbox('智能吸附').checked).toBe(false)
})

test('existing ViewControls and unified dialog share values bidirectionally and reuse legacy wheel key', async () => {
  await act(async () => root.render(<Harness />))
  await act(async () => checkbox('滚轮围绕鼠标缩放').click())
  expect(editor.state.scrollWheelZoom).toBe(true)
  expect(localStorage.getItem('forma-scroll-wheel-zoom')).toBe('true')
  const wheel = { deltaX: 0, deltaY: 100, deltaMode: 0 }, viewport = { width: 1000, height: 700 }, anchor = { x: 100, y: 100 }
  const zoomed = wheelCamera(editor.state.view, wheel, viewport, anchor, editor.state.scrollWheelZoom)
  expect(zoomed.zoom).toBeLessThan(editor.state.view.zoom)
  expect(JSON.parse(localStorage.getItem(SETTINGS_PREFERENCE_KEY)!)).not.toHaveProperty('scrollWheelZoom')
  await act(async () => button('完成').click())
  const smartSnap = [...mount.querySelectorAll('label')].find(item => item.textContent?.trim() === '智能吸附')!.querySelector<HTMLInputElement>('input')!
  await act(async () => smartSnap.click())
  await act(async () => mount.querySelector<HTMLInputElement>('input[aria-label="滚轮围绕鼠标缩放"]')!.click())
  expect(editor.state.snap).toBe(false); expect(editor.state.scrollWheelZoom).toBe(false)
  const panned = wheelCamera(editor.state.view, wheel, viewport, anchor, editor.state.scrollWheelZoom)
  expect(panned.zoom).toBe(editor.state.view.zoom); expect(panned.y).toBe(editor.state.view.y - 100)
  await act(async () => mount.querySelector('button')!.click())
  expect(checkbox('滚轮围绕鼠标缩放').checked).toBe(false)
  await tab('画布辅助'); expect(checkbox('智能吸附').checked).toBe(false)
})

test('existing keyboard component changes real shortcut dispatch after close; restore resets all preference owners', async () => {
  await act(async () => root.render(<Harness />))
  const select = dialog().querySelector('select')!
  await act(async () => { select.value = 'sketch-like'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(localStorage.getItem(SHORTCUT_PROFILE_KEY)).toBe('sketch-like')
  await act(async () => checkbox('滚轮围绕鼠标缩放').click()); await tab('画布辅助')
  await act(async () => checkbox('像素网格').click())
  await act(async () => button('完成').click())
  await act(async () => { dispatchEditorShortcut(editor, new KeyboardEvent('keydown', { key: 'p', code: 'KeyP' }), { profile: shortcutPreference.getSnapshot(), platform: 'windows' }) })
  expect(editor.state.tool).toBe('pencil')
  await act(async () => mount.querySelector('button')!.click())
  await act(async () => button('恢复偏好默认值').click())
  expect(settingsPreference.getSnapshot()).toEqual(DEFAULT_CANVAS_SETTINGS)
  expect(editor.state).toMatchObject(DEFAULT_CANVAS_SETTINGS)
  expect(editor.state.scrollWheelZoom).toBe(false); expect(shortcutPreference.getSnapshot()).toBe('figma-like')
  expect(dialog().querySelector('select')!.value).toBe('figma-like')
  expect(dialog().textContent).toContain('已恢复当前配置的偏好默认值')
})

test('Tab trapping, roving tabs, background isolation and Escape restore exact focus and modal cleanup', async () => {
  document.body.style.overflow = 'clip'; canvas.setAttribute('inert', 'prior')
  await act(async () => root.render(<StrictMode><Harness /></StrictMode>))
  const close = document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!
  expect(document.activeElement).toBe(close); expect(document.body.style.overflow).toBe('hidden')
  expect(mount.hasAttribute('inert')).toBe(true)
  await act(async () => { key(close, 'Tab', { shiftKey: true }) }); expect(document.activeElement).toBe(button('完成'))
  await act(async () => { key(button('完成'), 'Tab') }); expect(document.activeElement).toBe(close)
  trigger.focus(); expect(document.activeElement).toBe(close)
  button('操作习惯').focus()
  await act(async () => { key(button('操作习惯'), 'ArrowRight') })
  expect(document.activeElement).toBe(button('画布辅助')); expect(button('画布辅助').getAttribute('aria-selected')).toBe('true')
  await act(async () => { key(button('画布辅助'), 'End') })
  expect(document.activeElement).toBe(button('错误日志'))
  expect(button('错误日志').getAttribute('aria-selected')).toBe('true')
  await act(async () => { key(button('错误日志'), 'Escape') })
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger)
  expect(document.body.style.overflow).toBe('clip'); expect(mount.hasAttribute('inert')).toBe(false)
  expect(canvas.getAttribute('inert')).toBe('prior')
  mount.querySelector<HTMLButtonElement>('button')!.focus()
  expect(document.activeElement).toBe(mount.querySelector('button'))
})

test('composing/repeated Escape and document shortcuts do not close or edit through settings', async () => {
  const original = editor.state.doc, handler = vi.fn((event: KeyboardEvent) => dispatchEditorShortcut(editor, event, { profile: 'figma-like', platform: 'windows' }))
  window.addEventListener('keydown', handler); cleanups.push(() => window.removeEventListener('keydown', handler))
  await act(async () => root.render(<Harness />))
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }]) await act(async () => { key(dialog(), 'Escape', options) })
  expect(dialog()).not.toBeNull()
  await act(async () => { key(dialog(), 'Delete'); key(dialog(), 'd', { ctrlKey: true }) })
  expect(editor.state.doc).toBe(original); expect(handler).not.toHaveBeenCalled()
  await act(async () => { key(dialog(), 'Escape') }); expect(dialog()).toBeNull()
})

test('failed preference writes keep real controls usable and show honest session-only status', async () => {
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota exceeded') })
  await act(async () => root.render(<Harness />))
  await act(async () => checkbox('滚轮围绕鼠标缩放').click())
  expect(editor.state.scrollWheelZoom).toBe(true)
  await tab('画布辅助'); await act(async () => checkbox('标尺与参考线').click())
  expect(editor.state.rulers).toBe(true); expect(settingsPreference.getSnapshot().rulers).toBe(true)
  expect(dialog().querySelector('.settings-status')?.textContent).toContain('本次会话')
  await act(async () => button('恢复偏好默认值').click())
  expect(editor.state).toMatchObject(DEFAULT_CANVAS_SETTINGS)
  expect(dialog().querySelector('.settings-status')?.textContent).toContain('部分偏好仅在本次会话')
})

test('cross-window storage updates real Editor/checkboxes without echo writes and clear restores defaults', async () => {
  await act(async () => root.render(<Harness />)); await tab('画布辅助')
  const write = vi.spyOn(dom.window.Storage.prototype, 'setItem')
  await act(async () => {
    localStorage.setItem(SETTINGS_PREFERENCE_KEY, JSON.stringify({ snap: false, rulers: true }))
    window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_PREFERENCE_KEY }))
  })
  expect(checkbox('智能吸附').checked).toBe(false); expect(editor.state.rulers).toBe(true)
  expect(write).toHaveBeenCalledTimes(1)
  await act(async () => { localStorage.removeItem(SETTINGS_PREFERENCE_KEY); window.dispatchEvent(new StorageEvent('storage', { key: null })) })
  expect(checkbox('智能吸附').checked).toBe(true); expect(editor.state).toMatchObject(DEFAULT_CANVAS_SETTINGS)
  expect(write).toHaveBeenCalledTimes(1)
})

test.each([false, true])('saving explanation and root-owned workspace slot match desktop=%s without fake interval controls', async desktop => {
  await act(async () => root.render(<Harness desktop={desktop} />)); await tab('保存与范围')
  const panel = dialog().querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  expect(panel.textContent).toContain(desktop ? '600 毫秒' : '350 毫秒')
  expect(panel.textContent).toContain('间隔不可在此调整')
  expect(panel.textContent).toContain(desktop ? '独立打开的本地窗口使用各自配置' : '使用其他浏览器或清除网站数据后，需要重新设置')
  expect(panel.querySelector('[data-workspace-control]')).not.toBeNull()
  expect(panel.querySelector('input[type="number"]')).toBeNull()
})

test('busy guard blocks every dismiss path and outside backdrop dismissal is clean after action finishes', async () => {
  await act(async () => root.render(<Harness busy />))
  expect(document.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.disabled).toBe(true)
  await act(async () => { key(dialog(), 'Escape'); document.querySelector('.settings-backdrop')!.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })) })
  expect(dialog()).not.toBeNull()
  await act(async () => root.render(<Harness />))
  await act(async () => dialog().dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
  expect(dialog()).not.toBeNull()
  await act(async () => document.querySelector('.settings-backdrop')!.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })))
  expect(dialog()).toBeNull(); expect(document.activeElement).toBe(trigger)
})

test('unmount with disconnected trigger restores canvas and releases every background attribute', async () => {
  await act(async () => root.render(<Harness />)); trigger.remove()
  await act(async () => root.render(null))
  expect(document.activeElement).toBe(canvas); expect(document.body.style.overflow).toBe('')
  expect(mount.hasAttribute('inert')).toBe(false); expect(canvas.hasAttribute('inert')).toBe(false)
})


test('desktop companion has its own tab, no model toggle before verification, and no old fallback', async () => {
  desktopPet.configure('off')
  await act(async () => root.render(<Harness desktop />))
  await tab('Nomi 伙伴')
  expect(dialog().querySelector('select[id$="-pet"]')).toBeNull()
  expect(dialog().textContent).toContain('不会回退使用旧版素材')
  expect(dialog().textContent).toContain('目前不可启用')
  expect(dialog().textContent).not.toContain('请先关闭再开启')
})

test('old enabled preference can be turned off without enabling unverified replacement', async () => {
  const configure = vi.fn().mockResolvedValue({ mode: 'off', phase: 'off', revision: 1000 })
  Object.defineProperty(window, 'coreDesktop', { configurable: true, value: { version: 1, petConfigure: configure } })
  await act(async () => { desktopPet.configure('active'); root.render(<Harness desktop />) })
  await tab('Nomi 伙伴')
  await act(async () => button('关闭已保存的伙伴偏好').click())
  expect(desktopPet.snapshot()).toBe('off')
  expect(localStorage.getItem('core-desktop-pet-mode')).toBe('off')
  expect(configure.mock.calls).toEqual([['active'], ['off']])
})

test('web companion tab does not offer a desktop model toggle', async () => {
  await act(async () => root.render(<Harness />)); await tab('Nomi 伙伴')
  expect(dialog().textContent).toContain('Nomi 伙伴仅适用于桌面应用')
  expect(dialog().querySelector('select[id$="-pet"]')).toBeNull()
})
