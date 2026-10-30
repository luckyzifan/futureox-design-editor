import { expect, test, vi } from 'vitest'
import { createNudgePreference, DEFAULT_NUDGE_SETTINGS, NUDGE_PREFERENCE_KEY } from './nudge-preference'

test('fractional nudge settings persist, reload with stable snapshots, and contain no document data', () => {
  const values = new Map<string, string>(), storage = { getItem: vi.fn((key: string) => values.get(key) || null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
  const preference = createNudgePreference(() => storage)
  expect(preference.getSnapshot()).toEqual(DEFAULT_NUDGE_SETTINGS)
  expect(preference.set({ small: .25, big: 2.5 })).toBe(true)
  const restored = createNudgePreference(() => storage), snapshot = restored.getSnapshot()
  expect(snapshot).toEqual({ small: .25, big: 2.5 }); expect(Object.isFrozen(snapshot)).toBe(true)
  storage.getItem.mockClear()
  for (let i = 0; i < 1000; i++) expect(restored.getSnapshot()).toBe(snapshot)
  expect(storage.getItem).not.toHaveBeenCalled(); expect([...values.keys()]).toEqual([NUDGE_PREFERENCE_KEY])
})
test.each([{ small: 0, big: 10 }, { small: NaN, big: 10 }, { small: 1, big: Infinity }, { small: 20, big: 10 }, { small: 1, big: 1000001 }, { small: '1', big: 10 }, null])('rejects invalid nudge settings atomically: %j', value => {
  const storage = { getItem: () => null, setItem: vi.fn() }, preference = createNudgePreference(() => storage)
  const before = preference.getSnapshot(), listener = vi.fn(); preference.subscribe(listener)
  expect(preference.set(value as never)).toBe(false); expect(preference.getSnapshot()).toBe(before)
  expect(storage.setItem).not.toHaveBeenCalled(); expect(listener).not.toHaveBeenCalled()
})
test.each(['{broken', '{"small":0,"big":10}', '{"small":1}', 'null', '[]'])('corrupt saved setting uses safe defaults: %s', raw => {
  expect(createNudgePreference(() => ({ getItem: () => raw, setItem() {} })).getSnapshot()).toEqual(DEFAULT_NUDGE_SETTINGS)
})
test('denied storage retains usable session values and reset restores 1/10', () => {
  const preference = createNudgePreference(() => ({ getItem() { throw Error('denied') }, setItem() { throw Error('denied') } }))
  expect(preference.set({ small: .5, big: 5 })).toBe(false); expect(preference.getSnapshot()).toEqual({ small: .5, big: 5 })
  expect(preference.getPersistenceSnapshot()).toBe('session-only')
  preference.reset(); expect(preference.getSnapshot()).toEqual(DEFAULT_NUDGE_SETTINGS)
})
