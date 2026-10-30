import test from 'node:test'
import assert from 'node:assert/strict'
import { forwardNativeEditorShortcut, nativeShortcutRoute } from '../src/keyboard-shortcuts.mjs'
const input = (key, extra = {}) => ({ type: 'keyDown', key, code: `Key${key.toUpperCase()}`, control: false, meta: false, alt: false, shift: false, isAutoRepeat: false, isComposing: false, ...extra })
for (const platform of ['darwin', 'win32', 'linux']) {
  const mod = platform === 'darwin' ? { meta: true } : { control: true }
  test(`${platform}: native boundary forwards exactly once, suppresses held destructive chords and resets suppression`, () => {
    const commands = [], menus = []; let prevented = 0
    const forward = event => forwardNativeEditorShortcut({ preventDefault() { prevented++ } }, event, { platform, sendCommand: command => commands.push(command), setIgnoreMenuShortcuts: value => menus.push(value) })
    forward(input('d', mod)); forward(input('d', { ...mod, isAutoRepeat: true })); forward(input('z', mod))
    assert.deepEqual(commands, ['duplicate', 'undo']); assert.equal(prevented, 3); assert.deepEqual(menus, [false, true, false])
    forward(input('+', { ...mod, shift: true, isAutoRepeat: true })); assert.equal(commands.at(-1), 'zoomIn')
    forward(input('n', { ...mod, isAutoRepeat: true })); assert.equal(menus.at(-1), true)
  })
  test(`${platform}: composing, extra modifiers and keyup never forward`, () => {
    for (const event of [input('d', { ...mod, isComposing: true }), input('d', { ...mod, keyCode: 229 }), input('Process', mod), input('d', { ...mod, shift: true }), input('d', { control: true, meta: true }), input('d', { ...mod, type: 'keyUp' })]) assert.equal(nativeShortcutRoute(event, platform).command, undefined)
    assert.equal(nativeShortcutRoute(input('d', { ...mod, isComposing: true }), platform).suppressMenu, true)
  })
  test(`${platform}: native aliases and renderer profile commands remain distinct`, () => {
    for (const [key, extra, expected] of [['z', { shift: true }, 'redo'], ['v', { shift: true }, 'paste-over-selection'], ['r', { shift: true }, 'paste-to-replace'], ['g', { shift: true }, 'ungroup'], ['c', {}, 'copy']]) assert.equal(nativeShortcutRoute(input(key, { ...mod, ...extra }), platform).command, expected)
    for (const key of ['1', '2', 'f', 'p', 'e']) assert.equal(nativeShortcutRoute(input(key, mod), platform).command, undefined)
    if (platform === 'darwin') {
      assert.equal(nativeShortcutRoute(input('ç', { ...mod, alt: true, code: 'KeyC' }), platform).command, 'copy-properties')
      assert.equal(nativeShortcutRoute(input('ç', { ...mod, alt: true, shift: true, code: 'KeyC' }), platform).command, undefined)
    } else {
      const altGr = nativeShortcutRoute(input('c', { ...mod, alt: true }), platform)
      assert.equal(altGr.command, undefined); assert.equal(altGr.consume, false); assert.equal(altGr.suppressMenu, true)
    }
  })
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: paste-over-selection preserves native repeat, IME, modifier and keyup policy`, () => {
    const mod = platform === 'darwin' ? { meta: true } : { control: true }
    const commands = [], menus = []; let prevented = 0
    const forward = extra => forwardNativeEditorShortcut({ preventDefault() { prevented++ } }, input('v', { ...mod, shift: true, ...extra }), {
      platform, sendCommand: command => commands.push(command), setIgnoreMenuShortcuts: value => menus.push(value),
    })
    forward({})
    assert.deepEqual(commands, ['paste-over-selection'])
    assert.equal(prevented, 1)
    assert.equal(menus.at(-1), false)
    forward({ isAutoRepeat: true })
    assert.equal(prevented, 2, 'Consume held chord without repeating the edit')
    assert.equal(menus.at(-1), true)
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { key: 'Dead' }, { key: 'Process' }]) {
      forward(extra)
      assert.equal(menus.at(-1), true, 'IME must suppress competing menu shortcuts')
      assert.equal(prevented, 2, 'IME events remain available to the renderer')
    }
    for (const extra of [{ type: 'keyUp' }, { meta: true, control: true }, { alt: true }]) forward(extra)
    assert.equal(prevented, 2)
    assert.deepEqual(commands, ['paste-over-selection'])
    forward({ key: 'V' })
    assert.deepEqual(commands, ['paste-over-selection', 'paste-over-selection'])
    assert.equal(prevented, 3)
    assert.equal(menus.at(-1), false, 'A fresh valid chord resets menu suppression')
    forward({ shift: false })
    assert.equal(commands.at(-1), 'paste', 'Ordinary paste retains its own route')
  })
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: Shift+Mod+N remains renderer-owned, never a native new-document alias`, () => {
    const mod = platform === 'darwin' ? { meta: true } : { control: true }
    const route = nativeShortcutRoute(input('N', { ...mod, shift: true }), platform)
    assert.equal(route.command, undefined)
    assert.equal(route.consume, false)
  })
}
