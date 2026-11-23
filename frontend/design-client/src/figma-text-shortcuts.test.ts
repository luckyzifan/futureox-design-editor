import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, defaultTextStyle, node } from './model'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { resolveShortcut, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
import { commitFigmaTextCommand } from './figma-text-shortcuts'
import { validate_document_json } from './generated/design-kernel/design_kernel'

const mac: ShortcutContext = { profile: 'figma-like', platform: 'mac', uiMode: 'figma', keyboardLayout: 'us-qwerty' }
const windows: ShortcutContext = { ...mac, platform: 'windows' }
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()) })
function key(value: string, code: string, overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}): ShortcutKey & { target: EventTarget | null; preventDefault(): void } {
  return { key: value, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: null, preventDefault() {}, ...overrides }
}
function textDoc(text = 'Hello', fontSize = 16, style = defaultTextStyle(), extra: ReturnType<typeof node>[] = []) {
  const doc = blank('Typography'), layer = node('text', 10, 20, 120, 40)
  layer.text = text
  layer.fontSize = fontSize
  layer.textStyle = style
  doc.nodes[layer.id] = layer
  for (const item of extra) doc.nodes[item.id] = item
  doc.pages[0].children = [layer.id, ...extra.map(item => item.id)]
  const editor = new Editor(doc)
  editor.select([layer.id])
  editors.push(editor)
  return { editor, layer, doc }
}
async function press(editor: Editor, value: string, code: string, overrides: Partial<ShortcutKey>, context: ShortcutContext = mac) {
  return dispatchEditorShortcut(editor, key(value, code, overrides), context)
}

test('US keyboard-layout chords change font size, weight, tracking, line height and underline, then one undo restores', async () => {
  const { editor, layer } = textDoc()
  const before = editor.state.doc
  expect(await press(editor, '<', 'Comma', { metaKey: true, shiftKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(15)
  expect(editor.state.doc.schemaVersion).toBe(2)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(await press(editor, ',', 'Comma', { metaKey: true, shiftKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(15)
  expect(await press(editor, '>', 'Period', { metaKey: true, shiftKey: true })).toBe(true)
  expect(await press(editor, '.', 'Period', { metaKey: true, shiftKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(17)
  editor.undo(); editor.undo(); editor.undo()
  expect(editor.state.doc).toEqual(before)

  expect(await press(editor, '≤', 'Comma', { metaKey: true, altKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.weight).toBe(300)
  expect(await press(editor, '.', 'Period', { metaKey: true, altKey: true })).toBe(true)
  expect(await press(editor, '≥', 'Period', { metaKey: true, altKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.weight).toBe(500)
  editor.undo(); editor.undo(); editor.undo()
  expect(editor.state.doc).toEqual(before)

  expect(await press(editor, ',', 'Comma', { metaKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.letterSpacing).toBeCloseTo(-0.16)
  expect(await press(editor, '.', 'Period', { metaKey: true })).toBe(true)
  expect(await press(editor, '.', 'Period', { metaKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.letterSpacing).toBeCloseTo(0.16)
  editor.undo(); editor.undo(); editor.undo()
  expect(editor.state.doc).toEqual(before)

  expect(await press(editor, '<', 'Comma', { shiftKey: true, altKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.lineHeight).toBeCloseTo(1.2875)
  expect(editor.state.doc.nodes[layer.id].textStyle?.lineHeightAuto).toBe(false)
  expect(await press(editor, '>', 'Period', { shiftKey: true, altKey: true })).toBe(true)
  expect(await press(editor, '.', 'Period', { shiftKey: true, altKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.lineHeight).toBeCloseTo(1.4125)
  editor.undo(); editor.undo(); editor.undo()
  expect(editor.state.doc).toEqual(before)

  expect(await press(editor, '¨', 'KeyU', { altKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textRuns).toEqual([{ start: 0, end: 5, underline: true }])
  expect(editor.state.doc.nodes[layer.id].text).toBe('Hello')
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
})

test('Option+comma is not letter spacing, and the bounds do not write history', async () => {
  const { editor } = textDoc()
  const before = editor.state.doc
  expect(await press(editor, ',', 'Comma', { altKey: true })).toBe(false)
  expect(editor.state.doc).toBe(before)
  const minimum = textDoc('Hello', 1)
  const atMinimum = minimum.editor.state.doc
  expect(await press(minimum.editor, '<', 'Comma', { metaKey: true, shiftKey: true })).toBe(false)
  expect(minimum.editor.state.doc).toBe(atMinimum)
  const heavy = textDoc('Hello', 16, { ...defaultTextStyle(), weight: 1000 })
  const atWeight = heavy.editor.state.doc
  expect(await press(heavy.editor, '>', 'Period', { metaKey: true, altKey: true })).toBe(false)
  expect(heavy.editor.state.doc).toBe(atWeight)
})

test('Windows uses Ctrl for the same US chords and Ctrl+U for underline', async () => {
  const { editor, layer } = textDoc()
  expect(await press(editor, '<', 'Comma', { ctrlKey: true, shiftKey: true }, windows)).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(15)
  expect(await press(editor, '.', 'Period', { ctrlKey: true, altKey: true }, windows)).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.weight).toBe(500)
  expect(await press(editor, '.', 'Period', { ctrlKey: true }, windows)).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(15)
  expect(editor.state.doc.nodes[layer.id].textStyle?.letterSpacing).toBeCloseTo(0.15)
  expect(await press(editor, '.', 'Period', { altKey: true, shiftKey: true }, windows)).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.lineHeight).toBeCloseTo(1.416667)
  expect(await press(editor, 'u', 'KeyU', { ctrlKey: true }, windows)).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textRuns?.[0].underline).toBe(true)
})

test('lists are one undo, and bracket chords still reorder until a list is being edited', async () => {
  const shape = node('rectangle', 200, 20, 30, 30)
  const { editor, layer } = textDoc('Hello', 16, defaultTextStyle(), [shape])
  const plain = editor.state.doc
  expect(await press(editor, ']', 'BracketRight', { metaKey: true })).toBe(true)
  expect(editor.state.doc.pages[0].children).toEqual([shape.id, layer.id])
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBeUndefined()
  editor.undo()
  expect(editor.state.doc).toEqual(plain)

  expect(await press(editor, '*', 'Digit8', { metaKey: true, shiftKey: true })).toBe(true)
  expect(editor.state.doc.schemaVersion).toBe(33)
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBe('bullet')
  expect(editor.state.doc.nodes[layer.id].text).toBe('Hello')
  validate_document_json(JSON.stringify(editor.state.doc))
  const stale = structuredClone(editor.state.doc)
  stale.schemaVersion = 32
  expect(() => validate_document_json(JSON.stringify(stale))).toThrow(/33/)
  expect(await press(editor, ']', 'BracketRight', { metaKey: true })).toBe(true)
  expect(editor.state.doc.pages[0].children).toEqual([shape.id, layer.id])
  expect(editor.state.doc.nodes[layer.id].textStyle?.listLevel).toBeUndefined()
  editor.undo()
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBe('bullet')
  editor.undo()
  expect(editor.state.doc).toEqual(plain)

  expect(await press(editor, '&', 'Digit7', { metaKey: true, shiftKey: true })).toBe(true)
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBe('ordered')
  expect(editor.state.doc.nodes[layer.id].text).toBe('Hello')
  editor.undo()
  expect(editor.state.doc).toEqual(plain)
  expect(editor.canUndo).toBe(false)
})

test('a partial text range keeps the rest of the layer, and non-text targets do not change', async () => {
  const { editor, layer } = textDoc('Hello')
  const before = editor.state.doc
  expect(commitFigmaTextCommand(editor, layer.id, 'increase-font-size', [0, 2])).toBe(true)
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(16)
  expect(editor.state.doc.nodes[layer.id].textRuns).toEqual([{ start: 0, end: 2, fontSize: 17 }])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  editor.select([])
  expect(await press(editor, '<', 'Comma', { metaKey: true, shiftKey: true })).toBe(false)
  const shape = node('rectangle', 0, 0, 10, 10)
  const shapes = textDoc('Hello', 16, defaultTextStyle(), [shape])
  shapes.editor.select([shape.id])
  const shaped = shapes.editor.state.doc
  expect(await press(shapes.editor, '*', 'Digit8', { metaKey: true, shiftKey: true })).toBe(false)
  expect(await press(shapes.editor, 'u', 'KeyU', { altKey: true })).toBe(false)
  expect(shapes.editor.state.doc).toBe(shaped)
  const owned = { closest: (selector: string) => selector.includes('textarea') ? {} : null } as unknown as EventTarget
  editor.select([layer.id])
  const focused = editor.state.doc
  expect(await dispatchEditorShortcut(editor, key('<', 'Comma', { metaKey: true, shiftKey: true, target: owned }), mac)).toBe(false)
  expect(editor.state.doc).toBe(focused)
})

test('one paragraph can become a numbered list without changing the other paragraph or the words', () => {
  const { editor, layer } = textDoc('Hello\nWorld')
  expect(commitFigmaTextCommand(editor, layer.id, 'text-numbered-list', [6, 11])).toBe(true)
  const node = editor.state.doc.nodes[layer.id]
  expect(node.text).toBe('Hello\nWorld')
  expect(node.textStyle?.list).toBeUndefined()
  expect(node.textRuns?.some(run => run.paragraph?.list === 'ordered' && run.start === 6)).toBe(true)
  expect(node.textRuns?.some(run => run.start < 6 && run.paragraph?.list === 'ordered')).toBeFalsy()
})

test('sketch and German layouts do not take the US Figma text chords', () => {
  const chord = key('<', 'Comma', { metaKey: true, shiftKey: true })
  expect(resolveShortcut(chord, { profile: 'sketch-like', platform: 'mac', uiMode: 'sketch' })).toBeNull()
  expect(resolveShortcut(chord, { ...mac, keyboardLayout: 'de-qwertz' })).toBeNull()
  expect(resolveShortcut(key(',', 'Comma', { metaKey: true }), { ...mac, keyboardLayout: 'de-qwertz' })?.command).toBe('open-command-search')
  expect(resolveShortcut(key('u', 'KeyU', { altKey: true }), mac)?.command).toBe('toggle-text-underline')
  expect(resolveShortcut(key('u', 'KeyU', { metaKey: true }), mac)).toBeNull()
})
