import { expect, test } from 'vitest'
import { createInterfacePreference, DEFAULT_INTERFACE_PREFERENCES, FIGMA_INSPECTOR_WIDTH, FIGMA_LAYERS_WIDTH, INTERFACE_PREFERENCE_KEY, interfacePreference, LEGACY_SHARED_INSPECTOR_WIDTH, LEGACY_SHARED_LAYERS_WIDTH, SKETCH_INSPECTOR_WIDTH, SKETCH_LAYERS_WIDTH } from './interface-preference'
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
  expect(createInterfacePreference(() => storage).getSnapshot()).toMatchObject({ uiMode: 'sketch', leftWidth: SKETCH_LAYERS_WIDTH, rightWidth: SKETCH_INSPECTOR_WIDTH })
  memory.set({ uiMode: 'figma' })
  expect(createInterfacePreference(() => storage).getSnapshot()).toMatchObject({ uiMode: 'figma', leftWidth: FIGMA_LAYERS_WIDTH })
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
  interfacePreference.reset()
  applyInterfaceLayout('sketch')
  expect(interfacePreference.getSnapshot().uiMode).toBe('sketch')
  expect(interfacePreference.getSnapshot().leftWidth).toBe(SKETCH_LAYERS_WIDTH)
  expect(interfacePreference.getSnapshot().rightWidth).toBe(SKETCH_INSPECTOR_WIDTH)
  expect(shortcutPreference.getSnapshot()).toBe('sketch-like')
  applyInterfaceLayout('figma')
  expect(interfacePreference.getSnapshot().uiMode).toBe('figma')
  expect(interfacePreference.getSnapshot().leftWidth).toBe(FIGMA_LAYERS_WIDTH)
  expect(interfacePreference.getSnapshot().rightWidth).toBe(FIGMA_INSPECTOR_WIDTH)
  expect(interfacePreference.getSnapshot().leftWidths).toEqual({ figma: FIGMA_LAYERS_WIDTH, sketch: SKETCH_LAYERS_WIDTH })
  expect(shortcutPreference.getSnapshot()).toBe('figma-like')
  for (const profile of ['figma-like', 'sketch-like'] as const) {
    const combos = shortcutBindings({ profile, platform: 'mac', desktop: true }).map(binding => binding.combo)
    expect(combos).not.toContain(FIGMA_LAYOUT_COMBO)
    expect(combos).not.toContain(SKETCH_LAYOUT_COMBO)
  }
})

test('each layout keeps its own pages and layers width, and the old shared 248 migrates', () => {
  expect(FIGMA_LAYERS_WIDTH).toBe(240)
  expect(SKETCH_LAYERS_WIDTH).toBe(230)
  expect(LEGACY_SHARED_LAYERS_WIDTH).toBe(248)
  const storage = memoryStorage()
  storage.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify({ leftWidth: LEGACY_SHARED_LAYERS_WIDTH, rightWidth: LEGACY_SHARED_INSPECTOR_WIDTH, uiMode: 'sketch' }))
  const migrated = createInterfacePreference(() => storage)
  expect(migrated.getSnapshot()).toMatchObject({ uiMode: 'sketch', leftWidth: 230, rightWidth: SKETCH_INSPECTOR_WIDTH, leftWidths: { figma: 240, sketch: 230 } })
  const custom = memoryStorage()
  custom.setItem(INTERFACE_PREFERENCE_KEY, JSON.stringify({ leftWidth: 333, uiMode: 'figma' }))
  const kept = createInterfacePreference(() => custom)
  expect(kept.getSnapshot().leftWidths).toEqual({ figma: 333, sketch: 333 })
  expect(kept.set({ leftWidth: 360 })).toBe(true)
  expect(kept.getSnapshot().leftWidth).toBe(360)
  kept.set({ uiMode: 'sketch' })
  expect(kept.getSnapshot().leftWidth).toBe(333)
  expect(kept.getSnapshot().rightWidth).toBe(SKETCH_INSPECTOR_WIDTH)
  kept.set({ leftWidth: 300 })
  kept.set({ uiMode: 'figma' })
  expect(kept.getSnapshot().leftWidth).toBe(360)
  expect(createInterfacePreference(() => custom).getSnapshot().leftWidths).toEqual({ figma: 360, sketch: 300 })
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

test('a fixed conversion window is not labelled as running out of memory', () => {
  for (const message of [
    '大型文档：Source subtree exceeds the bounded conversion window; select a smaller subtree',
    'Source conversion window exceeds its memory allowance',
    'unsupported lossless conversion: Source conversion window exceeds its memory allowance',
    'Source conversion entry exceeds its memory allowance',
    'Thumbnail dependencies exceed window',
  ]) {
    const label = canvasStatusLabel(message)
    expect(label).toContain('固定转换窗口')
    expect(label).toContain('选择较小页面、素材或子树')
    expect(label).toContain('无需退出其他应用')
    expect(label).not.toContain('内存不足')
    expect(label).not.toContain('可释放其他应用的内存后重试')
    expect(label).not.toContain('Close other documents')
  }
})

test('menus flip above the trigger when the viewport cannot hold them below', () => {
  const viewport = { width: 1280, height: 768 }
  const anchor = { left: 20, top: 700, right: 80, bottom: 732 }
  const flipped = clampAnchoredMenu(anchor, { width: 180, height: 200 }, { prefer: 'below', viewport })
  expect(flipped.top).toBeLessThan(anchor.top)
  const below = clampAnchoredMenu({ left: 20, top: 40, right: 80, bottom: 72 }, { width: 180, height: 120 }, { prefer: 'below', viewport })
  expect(below.top).toBeGreaterThan(72)
})
