// Local preference event isolation only; not an Electron GUI/persistence acceptance test.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, expect, test, vi } from 'vitest'
import { createInterfacePreference, INTERFACE_PREFERENCE_KEY } from './interface-preference'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(stop => stop()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function fixture() {
  const dom = new JSDOM('', { url: 'https://design.invalid/' })
  cleanup.push(() => dom.window.close())
  vi.stubGlobal('window', dom.window)
  const preference = createInterfacePreference(() => dom.window.localStorage)
  const notify = vi.fn()
  cleanup.push(preference.subscribe(notify))
  // Simulate quota failure after an earlier successfully persisted Chinese locale.
  dom.window.localStorage.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify({ locale: 'zh-CN' }))
  vi.spyOn(dom.window.Storage.prototype, 'setItem').mockImplementation(() => { throw Error('quota') })
  preference.set({ locale: 'en' }); notify.mockClear()
  return { dom, preference, notify }
}

test.each([INTERFACE_PREFERENCE_KEY, null])('unrelated sessionStorage event %s cannot discard a session-only locale', key => {
  const { dom, preference, notify } = fixture()
  const snapshot = preference.getSnapshot()
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key, storageArea: dom.window.sessionStorage }))
  expect(preference.getSnapshot()).toBe(snapshot)
  expect(preference.getSnapshot().locale).toBe('en')
  expect(preference.getPersistenceSnapshot()).toBe(false)
  expect(notify).not.toHaveBeenCalled()
})

test('matching localStorage event still refreshes locale without writing back', () => {
  const { dom, preference, notify } = fixture()
  dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: INTERFACE_PREFERENCE_KEY, storageArea: dom.window.localStorage }))
  expect(preference.getSnapshot().locale).toBe('zh-CN')
  expect(notify).toHaveBeenCalledTimes(1)
})
