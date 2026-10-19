import { afterEach, describe, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, defaultSizing, defaultTextStyle } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { selectAllCanvasIds } from './canvas-workflow-shortcuts'
import { selectionMetric } from './selection-properties'
import { resolveShortcut, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
import { shortcutPreference } from './shortcut-preference'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); shortcutPreference.set('figma-like'); vi.unstubAllGlobals() })
function fixture() {
  const doc = blank('Workflow shortcuts'), frame = node('frame', 10, 20, 300, 200), a = node('rectangle', 12, 20, 30, 40), b = node('rectangle', 80, 20, 50, 60), hidden = node('rectangle', 140, 20, 10, 10), locked = node('rectangle', 160, 20, 10, 10), outside = node('rectangle', 400, 20, 70, 80)
  hidden.visible = false; locked.locked = true; frame.children = [a.id, b.id, hidden.id, locked.id]
  for (const n of [frame, a, b, hidden, locked, outside]) doc.nodes[n.id] = n
  doc.pages[0].children = [frame.id, outside.id]
  const editor = new Editor(doc); editors.push(editor); editor.select([a.id]); return { editor, frame, a, b, hidden, locked, outside }
}
function key(key: string, overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) {
  return { key, code: key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...overrides }
}
const contexts: ShortcutContext[] = ['mac', 'windows', 'linux'].flatMap(platform => [false, true].map(desktop => ({ profile: 'sketch-like', platform, desktop } as ShortcutContext)))
const mod = (context: ShortcutContext) => context.platform === 'mac' ? { metaKey: true } : { ctrlKey: true }

describe('keyboard dimensions with real Editor/WASM', () => {
  test.each(contexts)('$platform desktop=$desktop small/large all-direction resize, identity, undo/redo and reopen', async context => {
    const { editor, a, b } = fixture(), before = editor.state.doc, untouched = before.nodes[b.id]
    for (const [arrow, shiftKey, width, height] of [['ArrowRight', false, 31, 40], ['ArrowDown', true, 31, 50], ['ArrowLeft', true, 21, 50], ['ArrowUp', false, 21, 49]] as const) {
      const handled = await dispatchEditorShortcut(editor, key(arrow, { ...mod(context), shiftKey }), context)
      expect(selectionMetric(editor.state.doc.nodes[a.id], 'width', editor.state.doc)).toBe(width)
      expect(selectionMetric(editor.state.doc.nodes[a.id], 'height', editor.state.doc)).toBe(height)
      expect(editor.state.doc.nodes[a.id].transform).toEqual(before.nodes[a.id].transform)
      expect(editor.state.doc.nodes[b.id]).toBe(untouched)
      expect(handled).toBe(true)
    }
    const after = editor.state.doc
    for (let i = 0; i < 4; i++) editor.undo()
    expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
    for (let i = 0; i < 4; i++) editor.redo()
    expect(editor.state.doc).toEqual(after)
    const reopened = new Editor(JSON.parse(JSON.stringify(after))); editors.push(reopened)
    expect(reopened.state.doc.nodes[a.id]).toEqual(after.nodes[a.id])
  })
  test('mixed text/shape selection shares one history step without changing font size', async () => {
    const { editor, a, b } = fixture()
    editor.update([b.id], { kind: 'text', text: 'Keyboard resize', fontSize: 18, textStyle: defaultTextStyle(), sizing: { ...defaultSizing(), width: 'fixed', height: 'fixed' } })
    editor.select([a.id, b.id]); const before = editor.state.doc
    await dispatchEditorCommand(editor, 'resize-width-increase-large')
    expect(selectionMetric(editor.state.doc.nodes[a.id], 'width', editor.state.doc)).toBe(40)
    expect(selectionMetric(editor.state.doc.nodes[b.id], 'width', editor.state.doc)).toBe(60)
    expect(editor.state.doc.nodes[b.id].fontSize).toBe(18); expect(editor.state.doc.nodes[b.id].textStyle?.wrap).toBe(true)
    const after = editor.state.doc; editor.undo(); expect(editor.state.doc).toEqual(before); editor.redo(); expect(editor.state.doc).toEqual(after)
  })
  test('rotation/scaled parents use displayed dimensions, aspect ratio and unchanged translation', async () => {
    const { editor, frame, a } = fixture()
    editor.update([frame.id], { transform: [2, 0, 0, 2, 10, 20] }); editor.update([a.id], { transform: [0, 1, -1, 0, 12, 20], constrainProportions: true })
    const before = editor.state.doc, w = selectionMetric(before.nodes[a.id], 'width', before), h = selectionMetric(before.nodes[a.id], 'height', before)
    await dispatchEditorCommand(editor, 'resize-width-increase-large'); const n = editor.state.doc.nodes[a.id]
    expect(selectionMetric(n, 'width', editor.state.doc)).toBeCloseTo(w + 10, 9)
    expect(selectionMetric(n, 'height', editor.state.doc)).toBeCloseTo(h * (w + 10) / w, 9)
    expect(n.transform).toEqual(before.nodes[a.id].transform); editor.undo(); expect(editor.state.doc).toEqual(before)
  })
  test('inherited lock/visibility guards protect ineligible nodes in a mixed selection', async () => {
    const { editor, frame, a, locked, hidden, outside } = fixture()
    editor.update([frame.id], { locked: true }, '切换锁定'); editor.select([a.id, locked.id, hidden.id, outside.id]); const before = editor.state.doc
    await dispatchEditorCommand(editor, 'resize-height-increase')
    for (const id of [a.id, locked.id, hidden.id, frame.id]) expect(editor.state.doc.nodes[id]).toBe(before.nodes[id])
    expect(editor.state.doc.nodes[outside.id].height).toBe(81); editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.update([frame.id], { locked: false, visible: false }, '切换可见性'); editor.select([a.id]); const hiddenBefore = editor.state.doc
    await dispatchEditorCommand(editor, 'resize-width-increase'); expect(editor.state.doc).toBe(hiddenBefore)
  })
  test('ancestor selection resizes once and group resizing reuses the established contract', async () => {
    const { editor, frame, a, outside } = fixture(); editor.select([frame.id, a.id]); const before = editor.state.doc
    await dispatchEditorCommand(editor, 'resize-width-increase'); expect(editor.state.doc.nodes[frame.id].width).toBe(301); expect(editor.state.doc.nodes[a.id].width).toBe(before.nodes[a.id].width)
    editor.undo(); editor.select([outside.id]); editor.group(); const id = editor.state.selection[0], width = selectionMetric(editor.state.doc.nodes[id], 'width', editor.state.doc)
    await dispatchEditorCommand(editor, 'resize-width-increase-large'); expect(selectionMetric(editor.state.doc.nodes[id], 'width', editor.state.doc)).toBeCloseTo(width + 10, 9)
  })
  test('dimension minimum clamps without adding no-op history', async () => {
    const { editor, a } = fixture(); editor.update([a.id], { width: .5 }); await dispatchEditorCommand(editor, 'resize-width-decrease-large'); expect(editor.state.doc.nodes[a.id].width).toBe(.01)
    const minimum = editor.state.doc; await dispatchEditorCommand(editor, 'resize-width-decrease'); expect(editor.state.doc).toBe(minimum); editor.undo(); expect(editor.state.doc.nodes[a.id].width).toBe(.5)
  })
  test('repeat resizes; IME/AltGraph/text/extra modifiers and Figma-like do not dispatch', async () => {
    const { editor, a } = fixture(), context: ShortcutContext = { profile: 'sketch-like', platform: 'mac' }
    for (const repeat of [false, true, true]) await dispatchEditorShortcut(editor, key('ArrowRight', { metaKey: true, repeat }), context)
    expect(editor.state.doc.nodes[a.id].width).toBe(33); const before = editor.state.doc
    for (const event of [key('ArrowRight', { metaKey: true, isComposing: true }), key('ArrowRight', { metaKey: true, keyCode: 229 }), key('ArrowRight', { metaKey: true, altKey: true }), key('ArrowRight', { metaKey: true, ctrlKey: true }), key('ArrowRight', { ctrlKey: true }), key('ArrowRight', { metaKey: true, getModifierState: k => k === 'AltGraph' }), key('ArrowRight', { metaKey: true, target: { closest: () => ({}) } as unknown as EventTarget })]) expect(await dispatchEditorShortcut(editor, event, context)).toBe(false)
    expect(await dispatchEditorShortcut(editor, key('ArrowRight', { metaKey: true }), { ...context, profile: 'figma-like' })).toBe(false); expect(editor.state.doc).toBe(before)
  })
  test('busy/drawing/active drag are protected; cancel restores the original design', async () => {
    const { editor, a } = fixture(), context: ShortcutContext = { profile: 'sketch-like', platform: 'linux' }, before = editor.state.doc
    editor.set({ busy: true }); await dispatchEditorShortcut(editor, key('ArrowRight', { ctrlKey: true }), context); expect(editor.state.doc).toBe(before)
    editor.set({ busy: false, tool: 'vector' }); await dispatchEditorShortcut(editor, key('ArrowRight', { ctrlKey: true }), context); expect(editor.state.doc).toBe(before)
    editor.set({ tool: 'select' }); editor.begin('Active drag'); editor.preview({ [a.id]: { width: 75 } }); const preview = editor.state.doc
    await dispatchEditorShortcut(editor, key('ArrowRight', { ctrlKey: true }), context); expect(editor.state.doc).toBe(preview); expect(editor.interactionActive).toBe(true)
    editor.cancel(); expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false); editor.select([]); await dispatchEditorCommand(editor, 'resize-width-increase'); expect(editor.state.doc).toEqual(before)
  })
})

describe('profile-aware select all', () => {
  test('Sketch selects eligible direct siblings; Figma retains page scope; selection is not a document edit', async () => {
    const { editor, frame, a, b, outside } = fixture(), before = editor.state.doc, version = editor.state.version
    await dispatchEditorShortcut(editor, key('a', { ctrlKey: true }), { profile: 'sketch-like', platform: 'windows' }); expect(editor.state.selection).toEqual([a.id, b.id])
    await dispatchEditorShortcut(editor, key('a', { ctrlKey: true }), { profile: 'figma-like', platform: 'windows' }); expect(editor.state.selection).toEqual([frame.id, outside.id])
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  })
  test('shared menu/native command follows stored profile, repeated selection and profile switching', async () => {
    const { editor, frame, a, b, outside } = fixture(); shortcutPreference.set('sketch-like'); await dispatchEditorCommand(editor, 'select-all'); expect(editor.state.selection).toEqual([a.id, b.id])
    await dispatchEditorCommand(editor, 'select-all'); expect(editor.state.selection).toEqual([a.id, b.id]); shortcutPreference.set('figma-like'); await dispatchEditorCommand(editor, 'select-all'); expect(editor.state.selection).toEqual([frame.id, outside.id])
  })
  test('empty/cross-container/stale selection falls back to active page, never another page', () => {
    const { editor, frame, a, outside } = fixture(), doc = editor.state.doc, page = editor.state.page
    for (const ids of [[], [a.id, outside.id], ['missing']]) expect(selectAllCanvasIds(doc, page, ids, 'sketch-like')).toEqual([frame.id, outside.id])
    expect(selectAllCanvasIds(doc, 'missing-page', [a.id], 'sketch-like')).toEqual([])
  })
  test('hidden/locked roots and inherited invalid paths are excluded under either profile', async () => {
    const { editor, frame, a, outside } = fixture(); editor.update([frame.id], { visible: false }, '切换可见性'); editor.update([outside.id], { locked: true }, '切换锁定')
    for (const shortcutProfile of ['figma-like', 'sketch-like'] as const) { editor.select([a.id]); await dispatchEditorCommand(editor, 'select-all', { shortcutProfile }); expect(editor.state.selection).toEqual([]) }
  })
})
test('Figma Alt+Shift+A removes auto-layout reversibly without stealing Sketch auto-pin chord', async () => {
  const { editor, frame } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'windows' }; editor.select([frame.id]); editor.autoLayout(); const before = editor.state.doc
  expect(before.nodes[frame.id].layout?.mode).not.toBe('none'); await dispatchEditorShortcut(editor, key('A', { shiftKey: true, altKey: true }), context); expect(editor.state.doc.nodes[frame.id].layout).toBeUndefined()
  editor.undo(); expect(editor.state.doc).toEqual(before); expect(resolveShortcut(key('A', { shiftKey: true, altKey: true }), { ...context, profile: 'sketch-like' })).toBeNull()
})
test('Figma Windows front/back uses Ctrl+Shift brackets, while macOS/Sketch preserve their separate chord', async () => {
  const { editor, frame, outside } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'windows' }; editor.select([frame.id]); const before = editor.state.doc
  await dispatchEditorShortcut(editor, key('}', { code: 'BracketRight', ctrlKey: true, shiftKey: true }), context); expect(editor.state.doc.pages[0].children).toEqual([outside.id, frame.id])
  await dispatchEditorShortcut(editor, key('{', { code: 'BracketLeft', ctrlKey: true, shiftKey: true }), context); expect(editor.state.doc.pages[0].children).toEqual([frame.id, outside.id]); editor.undo(); editor.undo(); expect(editor.state.doc).toEqual(before)
  expect(resolveShortcut(key(']', { ctrlKey: true, altKey: true }), context)).toBeNull()
  expect(resolveShortcut(key(']', { metaKey: true, altKey: true }), { ...context, platform: 'mac' })?.command).toBe('bring-to-front')
  expect(resolveShortcut(key(']', { ctrlKey: true, altKey: true }), { ...context, profile: 'sketch-like' })?.command).toBe('bring-to-front')
})
