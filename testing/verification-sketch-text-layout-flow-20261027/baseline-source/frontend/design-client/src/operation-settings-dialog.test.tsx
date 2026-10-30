// Real DOM controls and real Editor/WASM; no native dialogs, socket or GPU claims.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { SettingsDialog } from './SettingsDialog'
import { AlignmentControls } from './AlignmentControls'
import { alignmentAvailability } from './alignment-availability'
import { createNudgePreference, nudgePreference, NUDGE_PREFERENCE_KEY } from './nudge-preference'
import { formatShortcutCombo, shortcutLabel } from './shortcut-profiles'

let dom: any, root: Root, editor: Editor, mount: HTMLElement
beforeEach(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'localStorage']) vi.stubGlobal(name, name === 'window' ? dom.window : dom.window[name])
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  nudgePreference.reset(); mount = document.createElement('div'); document.body.append(mount); root = (await import('react-dom/client')).createRoot(mount)
  editor = new Editor(blank('Operation preferences'))
})
afterEach(async () => { await act(async () => root.unmount()); editor.dispose(); nudgePreference.reset(); dom.window.close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const input = (label: string) => [...document.querySelectorAll('label')].find(value => value.textContent === label)!.querySelector('input')!
async function type(control: HTMLInputElement, value: string) {
  await act(async () => { control.value = value; control.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function key(control: HTMLElement, key: string, options: KeyboardEventInit = {}) {
  await act(async () => control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })))
}
test('nudge fields validate, preserve composing input, persist fractional values and reset without history changes', async () => {
  const before = editor.state.doc, onClose = vi.fn()
  await act(async () => root.render(<SettingsDialog editor={editor} onClose={onClose} />))
  const small = input('小步长'), big = input('大步长')
  await type(small, '.25'); await key(small, 'Enter', { isComposing: true }); expect(nudgePreference.getSnapshot().small).toBe(1)
  await key(small, 'Enter', { keyCode: 229 }); expect(nudgePreference.getSnapshot().small).toBe(1)
  await key(small, 'Enter'); expect(nudgePreference.getSnapshot().small).toBe(.25)
  await type(big, '2.5'); await key(big, 'Enter'); expect(nudgePreference.getSnapshot().big).toBe(2.5)
  expect(createNudgePreference(() => localStorage).getSnapshot()).toEqual({ small: .25, big: 2.5 })
  await type(small, '0'); await key(small, 'Enter'); expect(document.querySelector('[role="alert"]')!.textContent).toContain('0.01')
  expect(JSON.parse(localStorage.getItem(NUDGE_PREFERENCE_KEY)!)).toEqual({ small: .25, big: 2.5 })
  await key(small, 'Escape'); expect(small.value).toBe('0.25'); expect(onClose).not.toHaveBeenCalled()
  await act(async () => [...document.querySelectorAll('button')].find(value => value.textContent === '恢复偏好默认值')!.click())
  expect(nudgePreference.getSnapshot()).toEqual({ small: 1, big: 10 }); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
})
test('Inspector matches shared toolbar applicability for a single child, roots, lock and active gestures', async () => {
  const doc = blank(), frame = node('frame', 100, 100, 300, 200), child = node('rectangle', 30, 40, 50, 60)
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  editor.load(doc); editor.select([child.id])
  const render = async () => { await act(async () => root.render(<AlignmentControls editor={editor} />)) }
  await render(); const left = () => document.querySelector<HTMLButtonElement>('[aria-label="左对齐"]')!
  expect(alignmentAvailability(editor)).toEqual({ align: true, distribute: false }); expect(left().disabled).toBe(false)
  const before = editor.state.doc; await act(async () => left().click()); expect(editor.state.doc.nodes[child.id].transform[4]).toBe(0)
  editor.undo(); expect(editor.state.doc).toEqual(before)
  for (const change of [() => editor.select([frame.id]), () => { editor.select([child.id]); editor.update([frame.id], { locked: true }) }, () => { editor.update([frame.id], { locked: false }, '切换锁定'); editor.begin('Pointer') }]) {
    change(); await render(); expect(alignmentAvailability(editor).align).toBe(false); expect(left().disabled).toBe(true)
  }
  editor.cancel()
})
test.each(['mac', 'windows', 'linux'] as const)('file and editor menu labels share %s primary modifiers', platform => {
  const context = { platform, profile: 'figma-like' as const }
  expect(formatShortcutCombo('Mod+S', platform)).toBe(platform === 'mac' ? '⌘ S' : 'Ctrl+S')
  expect(formatShortcutCombo('Mod+O', platform)).toBe(platform === 'mac' ? '⌘ O' : 'Ctrl+O')
  expect(shortcutLabel('group', context)).toBe(formatShortcutCombo('Mod+G', platform))
  expect(shortcutLabel('undo', context)).toBe(formatShortcutCombo('Mod+Z', platform))
})
