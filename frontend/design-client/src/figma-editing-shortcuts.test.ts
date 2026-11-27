import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { resolveShortcut, shortcutLabel, type ShortcutContext } from './shortcut-profiles'

const figma = { profile: 'figma-like', platform: 'mac', uiMode: 'figma', desktop: true } as const

function key(value: string, code: string, extra = {}) {
  return {
    key: value, code, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false,
    isComposing: false, defaultPrevented: false, target: null, preventDefault() {}, ...extra,
  }
}

test('Figma digits use the latest selection and preserve both undo points', async () => {
  const doc = blank(), first = node('rectangle'), second = node('rectangle')
  doc.nodes = { [first.id]: first, [second.id]: second }
  doc.pages[0].children = [first.id, second.id]
  const editor = new Editor(doc)
  const press = (digit: string, context: ShortcutContext = figma) =>
    dispatchEditorShortcut(editor, key(digit, 'Digit' + digit), context)
  const opacity = (id: string) => editor.state.doc.nodes[id].opacity
  try {
    editor.select([first.id])
    await press('3')
    expect(opacity(first.id)).toBe(.3)
    await press('7')
    expect(opacity(first.id)).toBe(.37)
    editor.undo()
    expect(opacity(first.id)).toBe(.3)
    editor.undo()
    expect(opacity(first.id)).toBe(1)

    await press('0')
    expect(opacity(first.id)).toBe(1)
    await press('0')
    expect(opacity(first.id)).toBe(0)
    editor.undo()
    expect(opacity(first.id)).toBe(1)

    await press('3')
    editor.select([second.id])
    await press('7')
    expect(opacity(second.id)).toBe(.7)
    expect(opacity(first.id)).toBe(.3)
    expect(await press('5', { ...figma, uiMode: 'sketch' })).toBe(false)
    expect(opacity(second.id)).toBe(.7)
  } finally { editor.dispose() }
})

test('the Mac Figma flatten shortcut is advertised and resolves Option output', () => {
  expect(shortcutLabel('flatten', figma)?.replaceAll(' ', '')).toBe('⌥⇧F')
  expect(resolveShortcut(key('Ï', 'KeyF', { altKey: true, shiftKey: true }), figma)?.command).toBe('flatten')
  expect(resolveShortcut(key('e', 'KeyE', { metaKey: true }), figma)?.command).toBe('flatten')
  expect(resolveShortcut(key('Ï', 'KeyF', { altKey: true, shiftKey: true }), { ...figma, uiMode: 'sketch' })).toBeNull()
})
