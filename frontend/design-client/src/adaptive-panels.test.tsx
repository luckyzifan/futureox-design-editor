// Mounted DOM/state tests only. jsdom does not validate rendered pixel geometry.
// @ts-expect-error jsdom is a test runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { InterfaceSettings, PanelResizeHandle, useAdaptivePanels } from './AdaptivePanels'
import { createInterfacePreference, DEFAULT_INTERFACE_PREFERENCES, interfacePreference, INTERFACE_PREFERENCE_KEY, interfaceText } from './interface-preference'
import { readFileSync } from 'node:fs'
import { hasPendingEdits, registerPendingEdit } from './pending-edits'
let dom: any, root: Root, mount: HTMLElement
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  interfacePreference.reset(); mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
})
afterEach(async () => { await act(async () => root.unmount()); interfacePreference.reset(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const render = async (element: React.ReactNode) => { await act(async () => root.render(element)) }
const key = async (target: HTMLElement, key: string) => { await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))) }
async function pointer(target: HTMLElement, type: string, x: number) { await act(async () => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, clientX: x, button: 0 }); target.dispatchEvent(event) }) }
function Shell() { const panels = useAdaptivePanels(); return <div className="editor-shell" style={panels.style}><button onClick={() => panels.setLeftOpen(value => !value)} aria-expanded={panels.leftOpen}>Layers</button><PanelResizeHandle side="left" /><InterfaceSettings /></div> }
test('keyboard resize bounds, persisted reopen, layout reset and locale labels', async () => {
  await render(<Shell />); const handle = document.querySelector<HTMLElement>('[role=separator]')!
  await key(handle, 'End'); expect(handle.getAttribute('aria-valuenow')).toBe('480')
  await key(handle, 'ArrowRight'); expect(interfacePreference.getSnapshot().leftWidth).toBe(480)
  await key(handle, 'Home'); await key(handle, 'ArrowLeft'); expect(interfacePreference.getSnapshot().leftWidth).toBe(208)
  expect(createInterfacePreference(() => localStorage).getSnapshot().leftWidth).toBe(208)
  await act(async () => (document.querySelector('select')!.value = 'en', document.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }))))
  expect(handle.getAttribute('aria-label')).toBe('Resize panel: Layers panel')
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Reset panel layout')!.click())
  expect(interfacePreference.getSnapshot().leftWidth).toBe(248)
  expect(interfacePreference.getSnapshot().locale).toBe('en')
})
test('drag writes once on release; cancellation restores session width', async () => {
  await render(<Shell />); const handle = document.querySelector<HTMLElement>('[role=separator]')!, shell = document.querySelector<HTMLElement>('.editor-shell')!
  const initial = localStorage.getItem(INTERFACE_PREFERENCE_KEY)
  await pointer(handle, 'pointerdown', 250); await pointer(handle, 'pointermove', 320)
  expect(handle.getAttribute('aria-valuenow')).toBe('318'); expect(localStorage.getItem(INTERFACE_PREFERENCE_KEY)).toBe(initial)
  await pointer(handle, 'pointercancel', 320); expect(interfacePreference.getSnapshot().leftWidth).toBe(248); expect(shell.style.getPropertyValue('--workspace-layers-width')).toContain('248px')
  await pointer(handle, 'pointerdown', 250); await pointer(handle, 'pointermove', 400); await pointer(handle, 'pointerup', 400)
  expect(createInterfacePreference(() => localStorage).getSnapshot().leftWidth).toBe(398)
})
test('disabled separator preserves a mounted pending input and its draft', async () => {
  const owner = {}, unregister = registerPendingEdit(owner, { dirty: () => document.querySelector('input')?.value !== 'pending draft', commit: () => false })
  await render(<div><input defaultValue="pending draft" /><PanelResizeHandle side="right" canResize={() => !hasPendingEdits(owner)} /></div>)
  const field = document.querySelector('input')!, handle = document.querySelector<HTMLElement>('[role=separator]')!
  field.value = 'unfinished 12.'; field.focus(); await key(handle, 'End'); await pointer(handle, 'pointerdown', 200); await pointer(handle, 'pointermove', 10); await pointer(handle, 'pointerup', 10)
  expect(field.value).toBe('unfinished 12.'); expect(document.activeElement).toBe(field); expect(interfacePreference.getSnapshot().rightWidth).toBe(280); expect(hasPendingEdits(owner)).toBe(true); unregister()
})
test('motion toggles apply to the root and restore on unmount; collapse persists on desktop', async () => {
  await render(<Shell />)
  await act(async () => document.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
  expect(document.documentElement.dataset.reducedMotion).toBe('true')
  await act(async () => document.querySelector('button')!.click())
  expect(createInterfacePreference(() => localStorage).getSnapshot().leftOpen).toBe(false)
  await render(null); expect(document.documentElement.hasAttribute('data-reduced-motion')).toBe(false)
})
test('corrupt and out-of-range storage is bounded; denied storage remains usable', () => {
  const malformed = createInterfacePreference(() => ({ getItem: () => '{', setItem() {} })); expect(malformed.getSnapshot()).toEqual(DEFAULT_INTERFACE_PREFERENCES)
  const large = createInterfacePreference(() => ({ getItem: () => JSON.stringify({ leftWidth: 1e9, rightWidth: -1, locale: 'bogus' }), setItem() {} })); expect(large.getSnapshot()).toMatchObject({ leftWidth: 480, rightWidth: 260, locale: 'zh-CN' })
  const denied = createInterfacePreference(() => { throw Error('denied') }); expect(denied.set({ reducedMotion: true })).toBe(false); expect(denied.getSnapshot().reducedMotion).toBe(true)
  expect(denied.reset()).toBe(false); expect(denied.getSnapshot()).toEqual(DEFAULT_INTERFACE_PREFERENCES)
})
test('static CSS contracts cover compact breakpoints and both motion preferences, not pixel layout', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).toContain('@media (max-width: 900px)'); expect(css).toContain('@media (max-width: 560px)'); expect(css).toContain('@media (prefers-reduced-motion: reduce)'); expect(css).toContain('html[data-reduced-motion=true]');   expect(css).toContain('animation: panel-enter-left 140ms ease-out'); expect(css).toContain('animation: interface-enter 160ms ease-out')
  expect(css).toContain('@keyframes panel-enter-left { from { transform: translateX(-4px); } to { transform: translateX(0); } }')
  expect(css).not.toContain('panel-enter-left { from { opacity: 0')
  expect(interfaceText.en.documentName).toBe('Document name'); expect(interfaceText['zh-CN'].searchLayers).toBe('搜索图层'); expect(interfaceText.en.collapseChrome).toBe('Collapse interface')
  expect(Object.keys(interfaceText.en)).toEqual(Object.keys(interfaceText['zh-CN']))
})
test('compact resize mode preserves desktop collapse memory and live panel descendants', async () => {
  await render(<Shell />)
  expect(document.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true }); window.dispatchEvent(new Event('resize')) })
  expect(document.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  await act(async () => document.querySelector('button')!.click())
  expect(document.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
  expect(interfacePreference.getSnapshot().leftOpen).toBe(true)
  await act(async () => { Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true }); window.dispatchEvent(new Event('resize')) })
  expect(document.querySelector('button')!.getAttribute('aria-expanded')).toBe('true')
})
test('unmount during width gesture discards the uncommitted preview', async () => {
  await render(<Shell />); const handle = document.querySelector<HTMLElement>('[role=separator]')!
  await pointer(handle, 'pointerdown', 250); await pointer(handle, 'pointermove', 450)
  await render(null)
  expect(interfacePreference.getSnapshot().leftWidth).toBe(248)
  expect(createInterfacePreference(() => localStorage).getSnapshot().leftWidth).toBe(248)
})
test('remember viewport is opt-in, persists via mounted setting and resets with preferences', async () => {
  await render(<InterfaceSettings />)
  const remember = [...document.querySelectorAll('label')].find(label => label.textContent === '重新打开时恢复上次视图')!.querySelector('input')!
  expect(remember.checked).toBe(false)
  await act(async () => remember.click())
  expect(createInterfacePreference(() => localStorage).getSnapshot().rememberViewport).toBe(true)
  await act(async () => interfacePreference.reset())
  expect(remember.checked).toBe(false)
})

test('capped panel drag starts from visible geometry, not the saved large-screen width', async () => {
  interfacePreference.set({ leftWidth: 480 })
  await render(<Shell />)
  const handle = document.querySelector<HTMLElement>('[role=separator]')!
  vi.spyOn(handle.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 260 } as DOMRect)
  await pointer(handle, 'pointerdown', 260); await pointer(handle, 'pointermove', 248); await pointer(handle, 'pointerup', 248)
  expect(interfacePreference.getSnapshot().leftWidth).toBe(248)
})
test('capped panel keyboard resize starts from visible geometry and keeps cancelled preference', async () => {
  interfacePreference.set({ leftWidth: 480 }); await render(<Shell />)
  const handle = document.querySelector<HTMLElement>('[role=separator]')!
  vi.spyOn(handle.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 260 } as DOMRect)
  await key(handle, 'ArrowLeft'); expect(interfacePreference.getSnapshot().leftWidth).toBe(252)
  await act(async () => interfacePreference.set({ leftWidth: 480 }))
  await pointer(handle, 'pointerdown', 260); await pointer(handle, 'pointermove', 230); await pointer(handle, 'pointercancel', 230)
  expect(interfacePreference.getSnapshot().leftWidth).toBe(480)
})
test('compact simultaneous panels have separate vertical slots without hiding either descendant', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).toContain('.editor-shell:not(.chrome-hide-layers):not(.chrome-hide-inspector) .adaptive-layers-shell')
  expect(css).toContain('height: calc((100% - 8px) / 2)')
  expect(css).toContain('.editor-shell:not(.chrome-hide-layers):not(.chrome-hide-inspector) .properties-workspace')
})

test('right panel resize uses its capped edge in the reversed drag direction', async () => {
  interfacePreference.set({ rightWidth: 480 }); await render(<div className="properties-workspace"><PanelResizeHandle side="right" /></div>)
  const handle = document.querySelector<HTMLElement>('[role=separator]')!
  vi.spyOn(handle.parentElement!, 'getBoundingClientRect').mockReturnValue({ width: 312 } as DOMRect)
  await pointer(handle, 'pointerdown', 500); await pointer(handle, 'pointermove', 512); await pointer(handle, 'pointerup', 512)
  expect(interfacePreference.getSnapshot().rightWidth).toBe(300)
})
test('compact open/close/restore matrix preserves both mounted drafts and keyboard focus owners', async () => {
  function Pair() {
    const panels = useAdaptivePanels()
    return <div className={`editor-shell ${panels.leftOpen ? '' : 'chrome-hide-layers'} ${panels.rightOpen ? '' : 'chrome-hide-inspector'}`} style={panels.style}>
      <button id="toggle-left" onClick={() => panels.setLeftOpen(value => !value)}>left</button>
      <button id="toggle-right" onClick={() => panels.setRightOpen(value => !value)}>right</button>
      <div className="adaptive-layers-shell"><input id="left-draft" defaultValue="left 12." /></div>
      <div className="properties-workspace"><input id="right-draft" defaultValue="right 34." /></div>
    </div>
  }
  await render(<Pair />)
  const left = document.getElementById('left-draft') as HTMLInputElement, right = document.getElementById('right-draft') as HTMLInputElement
  const desktop = interfacePreference.getSnapshot()
  for (const viewport of [800, 560]) {
    await act(async () => { Object.defineProperty(window, 'innerWidth', { value: viewport, configurable: true }); window.dispatchEvent(new Event('resize')) })
    const shell = document.querySelector('.editor-shell')!
    if (shell.classList.contains('chrome-hide-layers')) await act(async () => document.getElementById('toggle-left')!.click())
    if (shell.classList.contains('chrome-hide-inspector')) await act(async () => document.getElementById('toggle-right')!.click())
    expect(shell.classList.contains('chrome-hide-layers')).toBe(false); expect(shell.classList.contains('chrome-hide-inspector')).toBe(false)
    left.focus(); expect(document.activeElement).toBe(left); right.focus(); expect(document.activeElement).toBe(right)
    expect(document.getElementById('left-draft')).toBe(left); expect(document.getElementById('right-draft')).toBe(right)
    expect([left.value, right.value]).toEqual(['left 12.', 'right 34.'])
    await act(async () => document.getElementById('toggle-left')!.click()); expect(document.activeElement).toBe(right)
    await act(async () => document.getElementById('toggle-left')!.click()); expect(document.activeElement).toBe(right)
  }
  await act(async () => { Object.defineProperty(window, 'innerWidth', { value: 1500, configurable: true }); window.dispatchEvent(new Event('resize')) })
  expect(interfacePreference.getSnapshot()).toEqual(desktop)
  expect(document.getElementById('left-draft')).toBe(left); expect(document.getElementById('right-draft')).toBe(right)
  // Arithmetic + CSS contract only; jsdom cannot prove visible scrolling/focus.
  for (const availableHeight of [40, 180, 400]) {
    const slot = (availableHeight - 8) / 2
    expect(slot).toBeGreaterThan(0); expect(slot * 2 + 8).toBe(availableHeight)
  }
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  expect(css).toContain('height: calc((100% - 8px) / 2); min-height: 0; overflow: auto;')
  expect(css).toContain('.adaptive-layers-shell > .layers-panel { min-height: 240px; }')
  expect(css).toContain('.properties-workspace > .properties-content { min-height: 160px; flex-shrink: 0; }')
})
