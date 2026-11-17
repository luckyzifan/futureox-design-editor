import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, stroke, type DesignNode } from './model'
import { emptySystem } from './design-system'
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
const figma = (platform: ShortcutContext['platform'] = 'mac'): ShortcutContext => ({ profile: 'figma-like', platform, desktop: true })
const sketch: ShortcutContext = { profile: 'sketch-like', platform: 'mac', desktop: true }
const shiftSlash = (overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) =>
  key('?', { code: 'Slash', shiftKey: true, ...overrides })

function editorFor(nodes: DesignNode[], children = nodes.map(node => node.id), selected = children) {
  const doc = blank('Remove stroke')
  doc.schemaVersion = 12
  for (const node of nodes) doc.nodes[node.id] = node
  doc.pages[0].children = children
  const editor = new Editor(doc)
  editor.select(selected)
  editors.push(editor)
  return editor
}

test('Figma layout binds Shift+/ on every platform and leaves Sketch, Control, and Option+/ unbound', () => {
  for (const platform of ['mac', 'windows', 'linux'] as const) {
    const context = figma(platform)
    expect(shortcutBindings(context).filter(binding => binding.command === 'remove-stroke').map(binding => binding.combo)).toEqual(['Shift+/'])
    expect(resolveShortcut(shiftSlash(), context)?.command).toBe('remove-stroke')
    expect(resolveShortcut(key('/', { code: 'Slash', shiftKey: true }), context)?.command).toBe('remove-stroke')
    expect(resolveShortcut(shiftSlash({ ctrlKey: true }), context)).toBeNull()
    expect(resolveShortcut(shiftSlash({ metaKey: true }), context)).toBeNull()
    expect(resolveShortcut(shiftSlash({ altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('/', { code: 'Slash' }), context)).toBeNull()
    expect(resolveShortcut(key('?', { code: 'Slash' }), context)).toBeNull()
    expect(resolveShortcut(key('?', { code: 'KeyQ', shiftKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('/', { code: 'Slash', altKey: true }), context)?.command).not.toBe('remove-stroke')
    expect(resolveShortcut(key('÷', { code: 'Slash', altKey: true }), context)?.command).not.toBe('remove-stroke')
  }
  expect(resolveShortcut(shiftSlash(), sketch)).toBeNull()
  expect(shortcutBindings(sketch).some(binding => binding.command === 'remove-stroke' || binding.combo === 'Shift+B')).toBe(false)
  expect(shortcutLabel('remove-stroke', figma('mac'))).toBe('⇧ /')
  expect(shortcutLabel('remove-stroke', figma('windows'))).toBe('Shift+/')
  expect(shortcutLabel('remove-stroke', sketch)).toBeUndefined()
  expect(presentChrome('去掉描边', 'en')).toBe('Remove stroke')
  expect(presentChrome('撤销：去掉描边', 'en')).toBe('Undo: Remove stroke')
})

test('Shift+/ removes the selected stroke and one undo restores it', async () => {
  const shape = node('rectangle', 10, 20, 30, 40)
  shape.fills = [paint('#818cf8')]
  shape.strokes = [stroke('#112233', 4)]
  const editor = editorFor([shape])
  const before = editor.state.doc
  expect(editor.canUndo).toBe(false)
  await dispatchEditorShortcut(editor, shiftSlash(), figma())
  expect(editor.state.doc.nodes[shape.id].strokes).toEqual([])
  expect(editor.state.doc.nodes[shape.id].fills).toEqual(before.nodes[shape.id].fills)
  expect(editor.state.doc.nodes[shape.id].width).toBe(before.nodes[shape.id].width)
  const cleared = editor.state.doc
  const held = shiftSlash({ repeat: true })
  expect(await dispatchEditorShortcut(editor, held, figma())).toBe(true)
  expect(held.preventDefault).toHaveBeenCalledOnce()
  expect(editor.state.doc).toBe(cleared)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
  editor.redo()
  expect(editor.state.doc.nodes[shape.id].strokes).toEqual([])
})

test('Shift+/ clears every stroke in the selection in one undo, including a hidden stroke', async () => {
  const first = node('rectangle', 0, 0, 40, 20)
  const hidden = stroke('#222222', 1)
  hidden.visible = false
  first.strokes = [stroke('#111111', 5), hidden]
  const second = node('ellipse', 50, 0, 20, 20)
  second.strokes = [stroke('#abcdef', 2.5)]
  const plain = node('rectangle', 80, 0, 10, 10)
  const editor = editorFor([first, second, plain])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, shiftSlash(), figma('windows'))
  expect(editor.state.doc.nodes[first.id].strokes).toEqual([])
  expect(editor.state.doc.nodes[second.id].strokes).toEqual([])
  expect(editor.state.doc.nodes[plain.id]).toBe(before.nodes[plain.id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
})

test('no stroke, no selection, locked layers, and unselected children do not change the document', async () => {
  const bare = node('rectangle', 0, 0, 20, 20)
  const locked = node('rectangle', 30, 0, 20, 20)
  locked.locked = true
  locked.strokes = [stroke('#445566', 2)]
  const frame = node('frame', 0, 40, 120, 80)
  frame.locked = true
  const child = node('rectangle', 8, 8, 20, 20)
  child.strokes = [stroke('#778899', 3)]
  frame.children = [child.id]
  const editor = editorFor([bare, locked, frame, child], [bare.id, locked.id, frame.id])
  const before = editor.state.doc
  editor.select([])
  expect(await dispatchEditorShortcut(editor, shiftSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
  editor.select([bare.id])
  expect(await dispatchEditorShortcut(editor, shiftSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  editor.select([locked.id])
  expect(await dispatchEditorShortcut(editor, shiftSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
  editor.select([child.id])
  expect(await dispatchEditorShortcut(editor, shiftSlash(), figma())).toBe(true)
  expect(editor.state.doc.nodes[child.id].strokes).toEqual(before.nodes[child.id].strokes)
  expect(editor.state.doc).toBe(before)
  editor.select([frame.id])
  expect(await dispatchEditorShortcut(editor, shiftSlash(), figma())).toBe(true)
  expect(editor.state.doc).toBe(before)
})

test('a selected frame loses its own stroke and keeps descendant strokes', async () => {
  const frame = node('frame', 0, 0, 160, 100)
  frame.strokes = [stroke('#101010', 2)]
  const child = node('rectangle', 12, 12, 30, 30)
  child.strokes = [stroke('#202020', 6)]
  frame.children = [child.id]
  const editor = editorFor([frame, child], [frame.id], [frame.id])
  const before = editor.state.doc
  await dispatchEditorShortcut(editor, shiftSlash(), figma())
  expect(editor.state.doc.nodes[frame.id].strokes).toEqual([])
  expect(editor.state.doc.nodes[child.id].strokes).toEqual(before.nodes[child.id].strokes)
  expect(editor.state.doc.nodes[child.id]).toBe(before.nodes[child.id])
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('text editing and composition do not remove a text stroke; outside text edit, Shift+/ does', async () => {
  const text = node('text', 0, 0, 80, 28)
  text.text = 'Hello'
  text.strokes = [stroke('#010203', 1.25)]
  const editor = editorFor([text])
  const before = editor.state.doc
  for (const selector of ['textarea', 'contenteditable', 'textbox']) {
    const target = { closest: (query: string) => query.includes(selector) ? {} : null } as unknown as EventTarget
    const event = shiftSlash({ target })
    expect(await dispatchEditorShortcut(editor, event, figma())).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
  }
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { getModifierState: (name: string) => name === 'AltGraph' }]) {
    expect(await dispatchEditorShortcut(editor, shiftSlash(extra), figma())).toBe(false)
  }
  expect(editor.state.doc).toBe(before)
  await dispatchEditorShortcut(editor, shiftSlash(), figma())
  expect(editor.state.doc.nodes[text.id].strokes).toEqual([])
  expect(editor.state.doc.nodes[text.id].text).toBe('Hello')
  expect(editor.state.doc.nodes[text.id].fills).toEqual(before.nodes[text.id].fills)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
})

test('Figma Option+/ clears fills only, and Sketch Shift+B does not change stroke visibility', async () => {
  const shape = node('rectangle', 0, 0, 40, 40)
  shape.fills = [paint('#818cf8')]
  shape.strokes = [stroke('#334455', 3)]
  const editor = editorFor([shape])
  const before = editor.state.doc
  for (const event of [key('/', { code: 'Slash', altKey: true }), key('÷', { code: 'Slash', altKey: true })]) {
    expect(await dispatchEditorShortcut(editor, event, figma())).toBe(true)
  }
  expect(editor.state.doc.nodes[shape.id].fills).toEqual([])
  expect(editor.state.doc.nodes[shape.id].strokes).toEqual(before.nodes[shape.id].strokes)
  editor.undo()
  expect(editor.state.doc).toBe(before)
  const shiftB = key('B', { code: 'KeyB', shiftKey: true })
  expect(resolveShortcut(shiftB, sketch)?.command).not.toBe('remove-stroke')
  expect(await dispatchEditorShortcut(editor, shiftB, sketch)).toBe(false)
  expect(editor.state.tool).toBe('select')
  expect(editor.state.doc.nodes[shape.id].strokes).toEqual(before.nodes[shape.id].strokes)
  expect(editor.state.doc.nodes[shape.id].strokes[0].visible).toBe(true)
  expect(editor.state.doc).toBe(before)
  await dispatchEditorShortcut(editor, shiftSlash(), sketch)
  expect(editor.state.doc).toBe(before)
})

for (const stack of ['fills', 'strokes'] as const) test(`the ${stack} shortcut removes only its style and binding`, async () => {
  const shape = node('rectangle', 0, 0, 50, 40)
  const border = stroke('#aa0000', 3.5)
  const local = stroke('#00aa00', 1)
  shape.strokes = [local]
  shape.fills = [paint('#ffffff')]
  shape.styleRefs = { fills: 'fill', strokes: 'border' }
  shape.bindings = { 'fills.0.opacity': 'fade', 'strokes.0.width': 'weight' }
  const doc = blank('Styled stroke')
  doc.schemaVersion = 12
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const system = emptySystem()
  system.collections.size = { name: 'Size', modes: ['m'], defaultMode: 'm' }
  system.variables.weight = { name: 'Weight', collection: 'size', kind: 'number', values: { m: 6 } }
  system.variables.fade = { name: 'Fade', collection: 'size', kind: 'number', values: { m: 0.5 } }
  system.activeModes = { size: 'm' }
  system.styles.fill = { name: 'Fill', kind: 'paint', value: [paint('#123456')] }
  system.styles.border = { name: 'Border', kind: 'paint', value: [], strokes: [border] }
  doc.designSystem = system
  const editor = new Editor(doc)
  editors.push(editor)
  editor.select([shape.id])
  const before = editor.state.doc
  expect(before.nodes[shape.id].styleRefs?.strokes).toBe('border')
  expect(before.nodes[shape.id].strokes.length).toBeGreaterThan(0)
  const event = stack === 'fills' ? key('÷', { code: 'Slash', altKey: true }) : shiftSlash()
  await dispatchEditorShortcut(editor, event, figma())
  const next = editor.state.doc.nodes[shape.id]
  expect(next[stack]).toEqual([])
  expect(next.styleRefs).toEqual(stack === 'fills' ? { strokes: 'border' } : { fills: 'fill' })
  expect(next.bindings).toEqual(stack === 'fills' ? { 'strokes.0.width': 'weight' } : { 'fills.0.opacity': 'fade' })
  expect(editor.state.doc.designSystem?.styles.border.strokes).toEqual(before.designSystem?.styles.border.strokes)
  expect(editor.state.doc.designSystem?.styles.fill).toEqual(before.designSystem?.styles.fill)
  expect(editor.state.doc.designSystem?.variables.weight).toEqual(before.designSystem?.variables.weight)
  editor.undo()
  expect(editor.state.doc).toEqual(before)
  expect(editor.canUndo).toBe(false)
})
