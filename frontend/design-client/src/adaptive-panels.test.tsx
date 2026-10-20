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
  expect(css).toContain('@media (max-width: 900px)'); expect(css).toContain('@media (max-width: 560px)'); expect(css).toContain('@media (prefers-reduced-motion: reduce)'); expect(css).toContain('html[data-reduced-motion=true]'); expect(css).toContain('animation: panel-enter-left 140ms ease-out'); expect(css).toContain('animation: interface-enter 160ms ease-out')
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
