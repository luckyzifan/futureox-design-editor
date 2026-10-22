// Mounted footer-expression contract, not a complete mounted App/Electron GUI.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Editor } from './engine'
import { blank } from './model'
import { interfacePreference, useInterfacePreferences } from './interface-preference'
import { operationStatusText } from './operation-status-messages'
test('mounted actual footer expression changes language without remount/focus/state/lifetime changes', async () => {
 const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://design.invalid/' })
 for (const name of ['window','document','navigator','HTMLElement','Element','Node','localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
 const editor = new Editor(blank()), root = createRoot(document.getElementById('root')!)
 const previousLocale = interfacePreference.getSnapshot().locale
 const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
 expect(app).toContain('{operationStatusText(s.message, s.messagePresentation, locale)}')
 const renderMessage = new Function('s','locale','operationStatusText','return operationStatusText(s.message, s.messagePresentation, locale)')
 function Footer() {
   const s = useSyncExternalStore(editor.subscribe, editor.snapshot), { locale } = useInterfacePreferences()
   return <><button id="keep-focus">Authored focus target</button><footer>{renderMessage(s, locale, operationStatusText)}</footer></>
 }
 try {
  interfacePreference.set({ locale: 'zh-CN' }); editor.notify('已复制属性', { key: 'propertiesCopied' })
  await act(async () => root.render(<Footer />))
  const button = document.getElementById('keep-focus')!, footer = document.querySelector('footer')!, state = editor.state, changed = vi.fn()
  const stop = editor.subscribe(changed); button.focus()
  expect(footer.textContent).toBe('已复制属性')
  await act(async () => { interfacePreference.set({ locale: 'en' }) })
  expect(footer.textContent).toBe('Properties copied'); expect(document.activeElement).toBe(button)
  expect(document.querySelector('footer')).toBe(footer); expect(editor.state).toBe(state); expect(changed).not.toHaveBeenCalled()
  await act(async () => { interfacePreference.set({ locale: 'zh-CN' }) })
  expect(footer.textContent).toBe('已复制属性'); expect(editor.canUndo).toBe(false); stop()
 } finally { await act(async () => root.unmount()); interfacePreference.set({ locale: previousLocale }); editor.dispose(); dom.window.close(); vi.unstubAllGlobals() }
})
