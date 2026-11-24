import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, stroke, type DesignNode } from './model'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { presentChrome } from './english-chrome'
import { resolveShortcut, shortcutBindings, shortcutLabel, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.unstubAllGlobals() })

function key(value: string, overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) {
  return {
    key: value,
    code: value.length === 1 && /[a-z]/i.test(value) ? `Key${value.toUpperCase()}` : value,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
    isComposing: false, defaultPrevented: false, target: null, preventDefault: vi.fn(),
    ...overrides,
  }
}
const figma = (platform: ShortcutContext['platform'] = 'mac'): ShortcutContext => ({ profile: 'figma-like', platform, desktop: true, uiMode: 'figma' })
const sketch: ShortcutContext = { profile: 'sketch-like', platform: 'mac', desktop: true, uiMode: 'sketch' }
const optionSlash = (overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) =>
  key('÷', { code: 'Slash', altKey: true, ...overrides })
const altComma = (overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) =>
  key(',', { code: 'Comma', altKey: true, ...overrides })
const shiftSlash = (overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) =>
  key('?', { code: 'Slash', shiftKey: true, ...overrides })

function editorFor(nodes: DesignNode[], children = nodes.map(item => item.id), selected = children) {
  const doc = blank('Remove fill')
  doc.schemaVersion = 12
  for (const item of nodes) doc.nodes[item.id] = item
  doc.pages[0].children = children
  const editor = new Editor(doc)
  editor.select(selected)
  editors.push(editor)
  return editor
}

test('Figma layout binds official Remove fill keys and leaves Shift+/ as remove stroke', () => {
  expect(shortcutBindings(figma('mac')).filter(binding => binding.command === 'remove-fill').map(binding => binding.combo)).toEqual(['Alt+/'])
  expect(resolveShortcut(optionSlash(), figma())?.command).toBe('remove-fill')
  expect(resolveShortcut(key('/', { code: 'Slash', altKey: true }), figma())?.command).toBe('remove-fill')
  expect(resolveShortcut(key('≤', { code: 'Comma', altKey: true }), figma())).toBeNull()
  expect(resolveShortcut(key(',', { code: 'Comma', altKey: true }), figma())).toBeNull()
  for (const platform of ['windows', 'linux'] as const) {
    expect(shortcutBindings(figma(platform)).filter(binding => binding.command === 'remove-fill').map(binding => binding.combo)).toEqual(['Alt+,'])
    expect(resolveShortcut(altComma(), figma(platform))?.command).toBe('remove-fill')
    expect(resolveShortcut(key('≤', { code: 'Comma', altKey: true }), figma(platform))?.command).toBe('remove-fill')
    expect(resolveShortcut(key('/', { code: 'Slash', altKey: true }), figma(platform))).toBeNull()
    expect(resolveShortcut(optionSlash(), figma(platform))).toBeNull()
    // Shift or Ctrl turns Alt+, into an official text chord, not Remove fill.
    expect(resolveShortcut(altComma({ shiftKey: true }), figma(platform))?.command).toBe('decrease-line-height')
    expect(resolveShortcut(altComma({ ctrlKey: true }), figma(platform))?.command).toBe('decrease-font-weight')
    expect(resolveShortcut(shiftSlash(), figma(platform))?.command).toBe('remove-stroke')
    expect(resolveShortcut(key(',', { code: 'Comma', shiftKey: true }), figma(platform))?.command).not.toBe('remove-stroke')
  }
  const german = { ...figma('mac'), keyboardLayout: 'de-qwertz' as const }
  expect(resolveShortcut(altComma(), german)?.command).toBe('remove-fill')
  expect(resolveShortcut(optionSlash(), german)).toBeNull()
  expect(resolveShortcut(shiftSlash(), german)?.command).not.toBe('remove-stroke')
  expect(resolveShortcut(key(',', { code: 'Comma', shiftKey: true }), german)?.command).toBe('remove-stroke')
  expect(shortcutLabel('remove-fill', figma('mac'))).toBe('⌥ /')
  expect(shortcutLabel('remove-fill', figma('windows'))).toBe('Alt+,')
  expect(shortcutLabel('remove-fill', figma('linux'))).toBe('Alt+,')
  expect(shortcutLabel('remove-fill', german)).toBe('⌥ ,')
  expect(shortcutLabel('remove-fill', sketch)).toBeUndefined()
  expect(shortcutBindings(sketch).some(binding => binding.command === 'remove-fill')).toBe(false)
  expect(presentChrome('去掉填充', 'en')).toBe('Remove fill')
  expect(presentChrome('撤销：去掉填充', 'en')).toBe('Undo: Remove fill')
})

test('Option+/ clears every fill on the same target and one undo restores it', async () => {
  const shape = node('rectangle', 10, 20, 40, 30)
  const hidden = paint('#ff8800')
  hidden.visible = false
  shape.fills = [paint('#112233'), hidden]
  shape.strokes = [stroke('#101010', 3)]
  const editor = editorFor([shape])
  const target = shape.id
  const before = editor.state.doc
  expect(before.nodes[target].fills).toHaveLength(2)
  expect(editor.canUndo).toBe(false)
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.selection).toEqual([target])
  expect(editor.state.doc.nodes[target].fills).toEqual([])
  expect(editor.state.doc.nodes[target].strokes).toEqual(before.nodes[target].strokes)
  expect(editor.state.doc.nodes[target].id).toBe(target)
  expect(editor.state.message).toBe('去掉填充')
  const cleared = editor.state.doc
  const held = optionSlash({ repeat: true })
  expect(await dispatchEditorShortcut(editor, held, figma())).toBe(true)
  expect(held.preventDefault).toHaveBeenCalledOnce()
  expect(editor.state.doc).toBe(cleared)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[target].fills).toEqual(before.nodes[target].fills)
  expect(editor.state.doc.nodes[target].strokes).toEqual(before.nodes[target].strokes)
  expect(editor.canUndo).toBe(false)
  editor.redo()
  expect(editor.state.doc.nodes[target].fills).toEqual([])
  expect(editor.state.doc.nodes[target].strokes).toEqual(before.nodes[target].strokes)
  editor.undo()
  expect(editor.state.doc.nodes[target]).toEqual(before.nodes[target])
})

test('Windows and Linux Alt+, remove the same target fill and Alt+/ does not', async () => {
  for (const platform of ['windows', 'linux'] as const) {
    const shape = node('rectangle', 0, 0, 24, 24)
    shape.fills = [paint('#445566'), paint('#778899')]
    shape.strokes = [stroke('#010203', 2)]
    const editor = editorFor([shape])
    const target = shape.id
    const before = editor.state.doc
    const slash = key('/', { code: 'Slash', altKey: true })
    expect(await dispatchEditorShortcut(editor, slash, figma(platform))).toBe(false)
    expect(slash.preventDefault).not.toHaveBeenCalled()
    expect(editor.state.doc).toBe(before)
    expect(editor.canUndo).toBe(false)
    await dispatchEditorShortcut(editor, altComma(), figma(platform))
    expect(editor.state.selection).toEqual([target])
    expect(editor.state.doc.nodes[target].fills).toEqual([])
    expect(editor.state.doc.nodes[target].strokes).toEqual(before.nodes[target].strokes)
    editor.undo()
    expect(editor.state.doc).toEqual(before)
    expect(editor.state.doc.nodes[target].fills).toHaveLength(2)
    expect(editor.canUndo).toBe(false)
  }
})

test('one Option+/ clears every selected top layer and one undo restores those same targets', async () => {
  const first = node('rectangle', 0, 0, 40, 20)
  const hidden = paint('#222222')
  hidden.visible = false
  first.fills = [paint('#111111'), hidden]
  const second = node('ellipse', 50, 0, 20, 20)
  second.fills = [paint('#abcdef')]
  const plain = node('rectangle', 80, 0, 10, 10)
  plain.fills = []
  const editor = editorFor([first, second, plain])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.doc.nodes[first.id].fills).toEqual([])
  expect(editor.state.doc.nodes[second.id].fills).toEqual([])
  expect(editor.state.doc.nodes[plain.id]).toBe(before.nodes[plain.id])
  expect(editor.state.selection).toEqual([first.id, second.id, plain.id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[first.id].fills).toEqual(before.nodes[first.id].fills)
  expect(editor.state.doc.nodes[second.id].fills).toEqual(before.nodes[second.id].fills)
  expect(editor.canUndo).toBe(false)
})

test('no fill, no selection, locked layers, and locked descendants do not change the document', async () => {
  const bare = node('rectangle', 0, 0, 20, 20)
  bare.fills = []
  const locked = node('rectangle', 30, 0, 20, 20)
  locked.locked = true
  locked.fills = [paint('#445566')]
  const frame = node('frame', 0, 40, 120, 80)
  frame.locked = true
  frame.fills = [paint('#101010')]
  const child = node('rectangle', 8, 8, 20, 20)
  child.fills = [paint('#778899')]
  frame.children = [child.id]
  const editor = editorFor([bare, locked, frame, child], [bare.id, locked.id, frame.id])
  const before = editor.state.doc
  editor.select([])
  expect(await dispatchEditorShortcut(editor, optionSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
  editor.select([bare.id])
  expect(await dispatchEditorShortcut(editor, optionSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  editor.select([locked.id])
  expect(await dispatchEditorShortcut(editor, optionSlash(), figma())).toBe(true)
  expect(editor.state.doc.nodes[locked.id]).toEqual(before.nodes[locked.id])
  expect(editor.state.doc).toBe(before)
  editor.select([child.id])
  expect(await dispatchEditorShortcut(editor, optionSlash(), figma())).toBe(true)
  expect(editor.state.doc.nodes[child.id].fills).toEqual(before.nodes[child.id].fills)
  expect(editor.state.doc).toBe(before)
  editor.select([frame.id])
  expect(await dispatchEditorShortcut(editor, optionSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
})

test('a selected frame loses its own fill and keeps descendant fills', async () => {
  const frame = node('frame', 0, 0, 160, 100)
  frame.fills = [paint('#ffffff')]
  const child = node('rectangle', 12, 12, 30, 30)
  child.fills = [paint('#ff0000')]
  frame.children = [child.id]
  const editor = editorFor([frame, child], [frame.id], [frame.id])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.doc.nodes[frame.id].fills).toEqual([])
  expect(editor.state.doc.nodes[child.id].fills).toEqual(before.nodes[child.id].fills)
  expect(editor.state.doc.nodes[child.id]).toBe(before.nodes[child.id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[frame.id].fills).toEqual(before.nodes[frame.id].fills)
})

test('selecting only the child clears that child, and selecting parent plus child clears only the parent', async () => {
  const frame = node('frame', 0, 0, 160, 100)
  frame.fills = [paint('#eeeeee')]
  const child = node('rectangle', 12, 12, 30, 30)
  child.fills = [paint('#00aa00')]
  frame.children = [child.id]
  const editor = editorFor([frame, child], [frame.id], [child.id])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.selection).toEqual([child.id])
  expect(editor.state.doc.nodes[child.id].fills).toEqual([])
  expect(editor.state.doc.nodes[frame.id]).toEqual(before.nodes[frame.id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)

  editor.select([frame.id, child.id])
  const both = editor.state.doc
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.selection).toEqual([frame.id, child.id])
  expect(editor.state.doc.nodes[frame.id].fills).toEqual([])
  expect(editor.state.doc.nodes[child.id]).toEqual(both.nodes[child.id])
  expect(editor.state.doc.nodes[child.id].fills).toEqual(before.nodes[child.id].fills)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('a selected group loses its own fill and keeps child fills', async () => {
  const group = node('group', 0, 0, 80, 80)
  group.fills = [paint('#cccccc')]
  const child = node('rectangle', 8, 8, 20, 20)
  child.fills = [paint('#123456')]
  group.children = [child.id]
  const editor = editorFor([group, child], [group.id], [group.id])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.doc.nodes[group.id].fills).toEqual([])
  expect(editor.state.doc.nodes[child.id]).toBe(before.nodes[child.id])
  editor.undo()
  expect(editor.state.doc.nodes[group.id].fills).toEqual(before.nodes[group.id].fills)
  expect(editor.state.doc.nodes[child.id].fills).toEqual(before.nodes[child.id].fills)
})

test('text editing and composition do not remove a text fill; outside text edit, Option+/ does', async () => {
  const text = node('text', 0, 0, 80, 28)
  text.text = 'Hello'
  text.fills = [paint('#00aa00')]
  text.strokes = [stroke('#010203', 1)]
  const editor = editorFor([text])
  const before = editor.state.doc
  for (const selector of ['textarea', 'contenteditable', 'textbox']) {
    const target = { closest: (query: string) => query.includes(selector) ? {} : null } as unknown as EventTarget
    const event = optionSlash({ target })
    expect(await dispatchEditorShortcut(editor, event, figma())).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { getModifierState: (name: string) => name === 'AltGraph' }]) {
    expect(await dispatchEditorShortcut(editor, optionSlash(extra), figma())).toBe(false)
  }
  expect(editor.state.doc).toBe(before)
  await dispatchEditorShortcut(editor, optionSlash(), figma())
  expect(editor.state.doc.nodes[text.id].fills).toEqual([])
  expect(editor.state.doc.nodes[text.id].text).toBe('Hello')
  expect(editor.state.doc.nodes[text.id].strokes).toEqual(before.nodes[text.id].strokes)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[text.id].fills).toEqual(before.nodes[text.id].fills)
})

test('Shift+/ still removes only the stroke on the same target', async () => {
  const shape = node('rectangle', 0, 0, 40, 40)
  shape.fills = [paint('#818cf8'), paint('#112233')]
  shape.strokes = [stroke('#334455', 3)]
  const editor = editorFor([shape])
  const target = shape.id
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, shiftSlash(), figma())
  expect(editor.state.doc.nodes[target].strokes).toEqual([])
  expect(editor.state.doc.nodes[target].fills).toEqual(before.nodes[target].fills)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.state.doc.nodes[target].strokes).toEqual(before.nodes[target].strokes)
  expect(editor.canUndo).toBe(false)
  await dispatchEditorShortcut(editor, shiftSlash(), sketch)
  expect(editor.state.doc).toBe(before)
})
