import { expect, test, vi } from 'vitest'
import { createPageMemoryPreference, PAGE_MEMORY_PREFERENCE_KEY } from './page-memory-preference'
test('local preference defaults safely, persists, notifies and resets without document mutations', () => {
  const data = new Map<string, string>(), storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  const preference = createPageMemoryPreference(() => storage), listener = vi.fn(), stop = preference.subscribe(listener)
  expect(preference.getSnapshot()).toBe('balanced')
  expect(preference.set('expanded')).toBe(true)
  expect(data.get(PAGE_MEMORY_PREFERENCE_KEY)).toBe('expanded')
  expect(createPageMemoryPreference(() => storage).getSnapshot()).toBe('expanded')
  expect(listener).toHaveBeenCalledOnce()
  preference.reset(); expect(preference.getSnapshot()).toBe('balanced'); stop()
  data.set(PAGE_MEMORY_PREFERENCE_KEY, 'unlimited')
  expect(createPageMemoryPreference(() => storage).getSnapshot()).toBe('balanced')
})
test('denied storage stays explicit session-only without discarding the selected tier', () => {
  const preference = createPageMemoryPreference(() => { throw Error('denied') })
  expect(preference.getSnapshot()).toBe('balanced')
  expect(preference.set('expanded')).toBe(false)
  expect(preference.getSnapshot()).toBe('expanded')
  expect(preference.getPersistenceSnapshot()).toBe('session-only')
})
