import { expect, test } from 'vitest'
import { createInterfacePreference, DEFAULT_INTERFACE_PREFERENCES, interfacePreference } from './interface-preference'
import { applyInterfaceLayout, interfaceLayoutFromShortcut, FIGMA_LAYOUT_COMBO, SKETCH_LAYOUT_COMBO } from './interface-layout'
import { shortcutPreference } from './shortcut-preference'
import { shortcutBindings } from './shortcut-profiles'
import { displayColorHex } from './color'
import { canvasStatusLabel } from './canvas-status-label'
import { clampAnchoredMenu } from './anchored-menu'

function memoryStorage() {
  const bag = new Map<string, string>()
  return { getItem: (key: string) => bag.get(key) ?? null, setItem: (key: string, value: string) => { bag.set(key, value) } }
}

test('ui mode is remembered and unknown values stay on Figma', () => {
  const storage = memoryStorage()
  const memory = createInterfacePreference(() => storage)
  expect(memory.getSnapshot().uiMode).toBe('figma')
  expect(memory.set({ uiMode: 'sketch' })).toBe(true)
  expect(createInterfacePreference(() => storage).getSnapshot().uiMode).toBe('sketch')
  const bogus = createInterfacePreference(() => ({ getItem: () => JSON.stringify({ uiMode: 'photoshop' }), setItem() {} }))
  expect(bogus.getSnapshot().uiMode).toBe('figma')
  expect(DEFAULT_INTERFACE_PREFERENCES.uiMode).toBe('figma')
})

test('layout chords switch the shell and the matching editor shortcut profile', () => {
  expect(interfaceLayoutFromShortcut({ key: 'f', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('figma')
  expect(interfaceLayoutFromShortcut({ key: 's', metaKey: false, ctrlKey: true, altKey: true, shiftKey: false })).toBe('sketch')
  expect(interfaceLayoutFromShortcut({ key: 'f', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull()
  expect(interfaceLayoutFromShortcut({ key: 'f', metaKey: true, ctrlKey: true, altKey: true, shiftKey: false })).toBeNull()
  expect(interfaceLayoutFromShortcut({ key: 's', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true })).toBeNull()
  // US Mac Option+F / Option+S: key is ƒ / ß, code stays KeyF / KeyS.
  expect(interfaceLayoutFromShortcut({ key: 'ƒ', code: 'KeyF', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('figma')
  expect(interfaceLayoutFromShortcut({ key: 'ß', code: 'KeyS', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('sketch')
  expect(interfaceLayoutFromShortcut({ key: 'ƒ', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBeNull()
  expect(interfaceLayoutFromShortcut({ key: '©', code: 'KeyG', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBeNull()
  expect(interfaceLayoutFromShortcut({ key: 'Ï', code: 'KeyF', metaKey: true, ctrlKey: false, altKey: true, shiftKey: true })).toBeNull()
  applyInterfaceLayout('sketch')
  expect(interfacePreference.getSnapshot().uiMode).toBe('sketch')
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  applyInterfaceLayout('figma')
  expect(interfacePreference.getSnapshot().uiMode).toBe('figma')
  expect(shortcutPreference.getSnapshot()).toBe('figma-like')
  for (const profile of ['figma-like', 'sketch-like'] as const) {
    const combos = shortcutBindings({ profile, platform: 'mac', desktop: true }).map(binding => binding.combo)
    expect(combos).not.toContain(FIGMA_LAYOUT_COMBO)
    expect(combos).not.toContain(SKETCH_LAYOUT_COMBO)
  }
})

test('opaque srgb page background displays as hex', () => {
  expect(displayColorHex('color(srgb 0.949019610 0.949019610 0.949019610)')).toBe('#F2F2F2')
  expect(displayColorHex('color(srgb 0.949019610 0.949019610 0.949019610 / 1)')).toBe('#F2F2F2')
  expect(displayColorHex('#f2f2f2')).toBe('#F2F2F2')
  expect(displayColorHex('color(display-p3 0.9 0.9 0.9)')).toBeNull()
  expect(displayColorHex('color(srgb 0.1 0.2 0.3 / 0.5)')).toBeNull()
})

test('english memory banners collapse to a short status', () => {
  expect(canvasStatusLabel('The document exceeds the available WASM memory allowance. Close other documents or use a machine with more memory.')).toBe('内存不足，当前画面已保留')
  expect(canvasStatusLabel('已自动保存到工作副本')).toBe('已自动保存到工作副本')
})

test('menus flip above the trigger when the viewport cannot hold them below', () => {
  const viewport = { width: 1280, height: 768 }
  const anchor = { left: 20, top: 700, right: 80, bottom: 732 }
  const flipped = clampAnchoredMenu(anchor, { width: 180, height: 200 }, { prefer: 'below', viewport })
  expect(flipped.top).toBeLessThan(anchor.top)
  const below = clampAnchoredMenu({ left: 20, top: 40, right: 80, bottom: 72 }, { width: 180, height: 120 }, { prefer: 'below', viewport })
  expect(below.top).toBeGreaterThan(72)
})
