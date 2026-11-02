import { afterEach, describe, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { screenToWorld } from './canvas-camera'
import { blank, node } from './model'
import { editorCommands } from './editor-commands'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { canvasMenuItems } from './canvas-menu-model'
import { createShortcutPreference, SHORTCUT_PROFILE_KEY } from './shortcut-preference'
import { resolveShortcut, shortcutBindings, shortcutLabel, shortcutPlatform, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.unstubAllGlobals() })
function fixture() {
  const doc = blank('Shortcuts'), a = node('rectangle', 10, 20, 30, 40), b = node('rectangle', 100, 90, 50, 60)
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editor.select([a.id]); editors.push(editor)
  return { editor, a, b }
}
function key(key: string, overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) {
  return { key, code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false, target: null, preventDefault: vi.fn(), ...overrides }
}
function mod(context: ShortcutContext) { return context.platform === 'mac' ? { metaKey: true } : { ctrlKey: true } }
const contexts: ShortcutContext[] = ['figma-like', 'sketch-like'].flatMap(profile => ['mac', 'windows', 'linux'].flatMap(platform => [false, true].map(desktop => ({ profile, platform, desktop } as ShortcutContext))))
describe('bounded keyboard presets', () => {
  test.each(contexts)('$profile $platform desktop=$desktop has unique chords and existing commands only', context => {
    const bindings = shortcutBindings(context)
    expect(new Set(bindings.map(binding => binding.combo)).size).toBe(bindings.length)
    for (const binding of bindings) expect([...editorCommands, 'toggle-lock', 'toggle-visibility']).toContain(binding.command)
  })
  test.each(contexts)('$profile $platform desktop=$desktop dispatches real tool, duplicate, undo, group and visibility state', async context => {
    const { editor, a, b } = fixture(), before = editor.state.doc
    await dispatchEditorShortcut(editor, key(context.profile === 'figma-like' ? 'p' : 'v'), context)
    expect(editor.state.tool).toBe('pen'); expect(editor.state.doc).toBe(before)
    await dispatchEditorShortcut(editor, key('d', mod(context)), context)
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(3)
    await dispatchEditorShortcut(editor, key('z', mod(context)), context)
    expect(editor.state.doc).toEqual(before)
    editor.select([a.id, b.id]); await dispatchEditorShortcut(editor, key('g', mod(context)), context)
    expect(editor.state.doc.nodes[editor.state.selection[0]].kind).toBe('group')
    await dispatchEditorShortcut(editor, key('g', { ...mod(context), shiftKey: true }), context)
    expect(editor.state.doc.pages[0].children).toEqual([a.id, b.id])
    editor.select([a.id]); await dispatchEditorShortcut(editor, key('h', { ...mod(context), shiftKey: true }), context)
    expect(editor.state.doc.nodes[a.id].visible).toBe(false)
    await dispatchEditorShortcut(editor, key('h', { ...mod(context), shiftKey: true }), context)
    expect(editor.state.doc.nodes[a.id].visible).toBe(true)
  })
  test('profile switches alter V/P/E/N without changing the document', async () => {
    const { editor } = fixture(), before = editor.state.doc
    const context: ShortcutContext = { profile: 'figma-like', platform: 'windows' }
    for (const [letter, expected] of [['v', 'select'], ['p', 'pen'], ['e', 'eraser'], ['c', 'comments']]) {
      await dispatchEditorShortcut(editor, key(letter), context); expect(editor.state.tool).toBe(expected)
    }
    context.profile = 'sketch-like'
    for (const [letter, expected] of [['v', 'pen'], ['p', 'pencil'], ['e', 'slice'], ['n', 'comments']]) {
      await dispatchEditorShortcut(editor, key(letter), context); expect(editor.state.tool).toBe(expected)
    }
    expect(await dispatchEditorShortcut(editor, key('x'), context)).toBe(false)
    expect(editor.state.doc).toBe(before)
    expect(shortcutLabel('set-tool-pencil', { ...context, profile: 'figma-like' })).toBe('Shift+P')
    expect(resolveShortcut(key('E', { code: 'KeyE', shiftKey: true }), { profile: 'figma-like', platform: 'mac', desktop: true })?.command).toBe('eraser-or-prototype')
    expect(shortcutLabel('set-tool-eraser', { profile: 'figma-like', platform: 'mac', desktop: true })).toBe('E')
    expect(shortcutLabel('bring-to-front', { ...context, profile: 'figma-like' })).toBe(']')
  })
  test.each(contexts)('menu hints match the actual dispatcher: $profile $platform desktop=$desktop', context => {
    const { editor, a, b } = fixture(); editor.select([a.id, b.id]);
    for (const item of canvasMenuItems(editor, context)) expect(item.shortcut).toBe(shortcutLabel(item.command, context))
    expect(canvasMenuItems(editor, context).find(item => item.command === 'group')?.shortcut).toBe(context.platform === 'mac' ? '⌘ G' : 'Ctrl+G')
    expect(canvasMenuItems(editor, context).find(item => item.command === 'paste-to-replace')?.shortcut).toBe(context.desktop ? (context.platform === 'mac' ? '⌘ ⇧ R' : 'Ctrl+Shift+R') : undefined)
  })
  test('preserves browser refresh/find/tabs, while native Sketch zoom changes actual view', async () => {
    const { editor } = fixture(), context: ShortcutContext = { profile: 'sketch-like', platform: 'windows' }
    for (const letter of ['r', 'f', '1', '2', '0', 't', 'w', 'l']) expect(resolveShortcut(key(letter, { ctrlKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('r', { ctrlKey: true, shiftKey: true }), context)).toBeNull()
    vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
    editor.set({ view: { x: 0, y: 0, zoom: 0.25 } })
    await dispatchEditorShortcut(editor, key(')', { code: 'Digit0', shiftKey: true }), context)
    expect(editor.state.view.zoom).toBe(1)
    context.desktop = true
    await dispatchEditorShortcut(editor, key('2', { ctrlKey: true }), context)
    expect(editor.state.view.zoom).toBeGreaterThan(1)
    await dispatchEditorShortcut(editor, key('0', { ctrlKey: true }), context)
    expect(editor.state.view.zoom).toBe(1)
  })
  test('keyboard zoom preserves the existing pointer anchor and accepts Shift-minus', async () => {
    const { editor } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'windows' }
    vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
    editor.set({ view: { x: 50, y: 60, zoom: 1 } }); editor.pointerScreen = { x: 100, y: 120 }
    const before = screenToWorld(editor.state.view, editor.pointerScreen)
    await dispatchEditorShortcut(editor, key('+', { code: 'Equal', shiftKey: true }), context)
    expect(screenToWorld(editor.state.view, editor.pointerScreen)).toEqual(before)
    const zoomed = editor.state.view.zoom
    expect(zoomed).toBe(1.25)
    await dispatchEditorShortcut(editor, key('_', { code: 'Minus', shiftKey: true }), context)
    expect(editor.state.view.zoom).toBe(1)
    expect(screenToWorld(editor.state.view, editor.pointerScreen)).toEqual(before)
  })
  test('Mac Option symbols resolve US/Generic chords without forcing unmodified letters to physical positions', () => {
    const context: ShortcutContext = { profile: 'figma-like', platform: 'mac' }
    expect(resolveShortcut(key('©', { code: 'KeyG', metaKey: true, altKey: true }), context)?.command).toBe('frame-selection')
    expect(resolveShortcut(key('Å', { code: 'KeyA', altKey: true, shiftKey: true }), context)?.command).toBe('remove-auto-layout')
    expect(resolveShortcut(key('π', { code: 'KeyP', altKey: true }), context)?.command).toBe('set-tool-pencil')
    expect(resolveShortcut(key('“', { code: 'BracketLeft', metaKey: true, altKey: true }), context)?.command).toBe('send-to-back')
    expect(resolveShortcut(key('‘', { code: 'BracketRight', metaKey: true, altKey: true }), context)?.command).toBe('bring-to-front')
    expect(resolveShortcut(key('q', { code: 'KeyA' }), context)).toBeNull()
    expect(resolveShortcut(key('q', { code: 'KeyG', metaKey: true, altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('©', { code: 'KeyA', metaKey: true, altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('Ω', { code: 'KeyG', metaKey: true, altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('p', { code: 'KeyQ' }), context)?.command).toBe('set-tool-pen')
    for (const extra of [{ ctrlKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { getModifierState: (value: string) => value === 'AltGraph' }]) {
      expect(resolveShortcut(key('©', { code: 'KeyG', metaKey: true, altKey: true, ...extra }), context)).toBeNull()
    }
    expect(resolveShortcut(key('Dead', { code: 'KeyG', metaKey: true, altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('©', { code: 'KeyG', ctrlKey: true, altKey: true }), { ...context, platform: 'windows' })).toBeNull()
  })
  test('ignores extra modifiers, wrong platform modifiers, IME, AltGraph and prevented events', async () => {
    const { editor } = fixture(), before = editor.state.doc, context: ShortcutContext = { profile: 'figma-like', platform: 'mac' }
    for (const event of [key('d', { ctrlKey: true }), key('d', { metaKey: true, ctrlKey: true }), key('d', { metaKey: true, altKey: true }), key('d', { metaKey: true, shiftKey: true }), key('d', { metaKey: true, isComposing: true }), key('d', { metaKey: true, keyCode: 229 }), key('d', { metaKey: true, defaultPrevented: true }), key('d', { metaKey: true, getModifierState: value => value === 'AltGraph' })]) {
      expect(await dispatchEditorShortcut(editor, event, context)).toBe(false); expect(event.preventDefault).not.toHaveBeenCalled()
    }
    expect(editor.state.doc).toBe(before)
  })
  test('text ownership and modal dialogs block shortcuts; repeated duplicate is consumed once', async () => {
    const { editor } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'linux' }, before = editor.state.doc
    for (const selector of ['input', 'textarea', 'select', 'contenteditable', 'textbox', 'dialog', 'menu']) {
      const target = { closest: (query: string) => query.includes(selector) ? {} : null } as unknown as EventTarget
      expect(await dispatchEditorShortcut(editor, key('d', { ctrlKey: true, target }), context)).toBe(false)
    }
    vi.stubGlobal('document', { activeElement: null, querySelector: () => ({}) })
    expect(await dispatchEditorShortcut(editor, key('d', { ctrlKey: true }), context)).toBe(false)
    vi.unstubAllGlobals(); expect(editor.state.doc).toBe(before)
    await dispatchEditorShortcut(editor, key('d', { ctrlKey: true }), context)
    const after = editor.state.doc, held = key('d', { ctrlKey: true, repeat: true })
    expect(await dispatchEditorShortcut(editor, held, context)).toBe(true)
    expect(held.preventDefault).toHaveBeenCalledOnce(); expect(editor.state.doc).toBe(after)
    editor.undo(); expect(editor.state.doc).toEqual(before)
  })
  test('busy state cannot dispatch commands and disables every context action', async () => {
    const { editor } = fixture(), before = editor.state.doc
    editor.set({ busy: true })
    await dispatchEditorShortcut(editor, key('d', { ctrlKey: true }), { profile: 'figma-like', platform: 'linux' })
    expect(editor.state.doc).toBe(before); expect(canvasMenuItems(editor).every(item => item.disabled)).toBe(true)
  })
  test('profile preference survives recreation and rejects corrupt storage; denied writes stay session-only', () => {
    const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const store = createShortcutPreference(() => storage), listener = vi.fn(), unsubscribe = store.subscribe(listener)
    expect(store.getSnapshot()).toBe('figma-like'); expect(store.set('sketch-like')).toBe(true)
    expect(listener).toHaveBeenCalledOnce(); expect(createShortcutPreference(() => storage).getSnapshot()).toBe('sketch-like')
    values.set(SHORTCUT_PROFILE_KEY, 'unknown'); expect(store.getSnapshot()).toBe('figma-like'); unsubscribe()
    const denied = createShortcutPreference(() => ({ getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') } }))
    expect(denied.getSnapshot()).toBe('figma-like'); expect(denied.set('sketch-like')).toBe(false); expect(denied.getSnapshot()).toBe('sketch-like')
  })
  test.each(contexts)('new-page is Sketch desktop only, keeps document identity and undoes: $profile $platform desktop=$desktop', async context => {
    const { editor } = fixture(), before = editor.state.doc
    const event = key('N', { ...mod(context), shiftKey: true })
    const enabled = context.profile === 'sketch-like' && context.desktop === true
    expect(await dispatchEditorShortcut(editor, event, context)).toBe(enabled)
    if (enabled) {
      expect(editor.state.doc.id).toBe(before.id)
      expect(editor.state.doc.pages).toHaveLength(before.pages.length + 1)
      expect(editor.state.page).toBe(editor.state.doc.pages.at(-1)?.id)
      const added = editor.state.doc
      await dispatchEditorShortcut(editor, key('N', { ...mod(context), shiftKey: true, repeat: true }), context)
      expect(editor.state.doc).toBe(added)
      editor.undo(); expect(editor.state.doc).toEqual(before)
      editor.redo(); expect(editor.state.doc).toEqual(added)
    } else { expect(editor.state.doc).toBe(before); expect(event.preventDefault).not.toHaveBeenCalled() }
  })
  test('new-page respects focused text, modal, composition and busy admission', async () => {
    const { editor } = fixture(), before = editor.state.doc
    const context: ShortcutContext = { profile: 'sketch-like', platform: 'mac', desktop: true }
    for (const selector of ['input', 'textarea', 'contenteditable', 'dialog', 'menu']) {
      const target = { closest: (query: string) => query.includes(selector) ? {} : null } as unknown as EventTarget
      expect(await dispatchEditorShortcut(editor, key('N', { metaKey: true, shiftKey: true, target }), context)).toBe(false)
    }
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { altKey: true }]) {
      expect(await dispatchEditorShortcut(editor, key('N', { metaKey: true, shiftKey: true, ...extra }), context)).toBe(false)
    }
    editor.set({ busy: true }); await dispatchEditorShortcut(editor, key('N', { metaKey: true, shiftKey: true }), context)
    expect(editor.state.doc).toBe(before)
  })
  test('remaining explicit Option pairs resolve; Process and unrecognized variants do not', () => {
    const context: ShortcutContext = { profile: 'figma-like', platform: 'mac' }
    for (const [value, code, command] of [['å', 'KeyA', 'select-matching'], ['ç', 'KeyC', 'copy-properties'], ['√', 'KeyV', 'paste-properties']]) {
      expect(resolveShortcut(key(value, { code, metaKey: true, altKey: true }), context)?.command).toBe(command)
    }
    expect(resolveShortcut(key('c', { code: 'KeyG', metaKey: true, altKey: true }), context)?.command).toBe('copy-properties')
    expect(resolveShortcut(key('Process', { code: 'KeyG', metaKey: true, altKey: true }), context)).toBeNull()
    expect(resolveShortcut(key('©', { code: 'KeyG', metaKey: true, altKey: true }), { ...context, platform: 'linux' })).toBeNull()
  })
  test('Option-symbol commands change real frame/layout state and undo; interaction blocks new-page', async () => {
    const { editor, a, b } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'mac', desktop: true }
    editor.select([a.id, b.id]); const before = editor.state.doc
    await dispatchEditorShortcut(editor, key('©', { code: 'KeyG', metaKey: true, altKey: true }), context)
    const frameId = editor.state.selection[0]
    expect(editor.state.doc.nodes[frameId].kind).toBe('frame')
    editor.autoLayout(); expect(editor.state.doc.nodes[frameId].layout?.mode).not.toBe('none')
    const layout = editor.state.doc
    await dispatchEditorShortcut(editor, key('Å', { code: 'KeyA', shiftKey: true, altKey: true }), context)
    expect(editor.state.doc.nodes[frameId].layout).toBeUndefined()
    editor.undo(); expect(editor.state.doc).toEqual(layout)
    editor.undo(); editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.begin('test pointer gesture')
    await dispatchEditorShortcut(editor, key('N', { code: 'KeyN', metaKey: true, shiftKey: true }), { ...context, profile: 'sketch-like' })
    expect(editor.state.doc).toEqual(before); editor.cancel()
  })
  test('figma-like Mac chords zoom frames, switch pages, and use Shift+E for the eraser or Prototype', async () => {
    const { editor } = fixture(), context: ShortcutContext = { profile: 'figma-like', platform: 'mac' }
    expect(resolveShortcut(key('n'), context)?.command).toBe('zoom-next-frame')
    expect(resolveShortcut(key('N', { code: 'KeyN', shiftKey: true }), context)?.command).toBe('zoom-previous-frame')
    expect(resolveShortcut(key('PageDown', { code: 'PageDown' }), context)?.command).toBe('next-page')
    expect(resolveShortcut(key('PageUp', { code: 'PageUp' }), context)?.command).toBe('previous-page')
    expect(resolveShortcut(key('e', { shiftKey: true }), context)?.command).toBe('eraser-or-prototype')
    expect(resolveShortcut(key('O', { code: 'KeyO', metaKey: true, shiftKey: true }), context)?.command).toBe('outline-stroke')
    expect(resolveShortcut(key('O', { code: 'KeyO', ctrlKey: true, shiftKey: true }), { ...context, platform: 'windows' })?.command).toBe('outline-stroke')
    expect(resolveShortcut(key('e', { shiftKey: true }), context)?.command).not.toBe('outline-stroke')
    expect(resolveShortcut(key('n'), { ...context, profile: 'sketch-like' })?.command).toBe('set-tool-comments')
    editor.set({ tool: 'pen' })
    await dispatchEditorShortcut(editor, key('E', { code: 'KeyE', shiftKey: true }), context)
    expect(editor.state.tool).toBe('eraser')
    await dispatchEditorShortcut(editor, key('E', { code: 'KeyE', shiftKey: true }), context)
    expect(editor.state.tool).toBe('vector')
    editor.set({ tool: 'select' })
    const { getPrototypeTab, setPrototypeTab } = await import('./prototype-chrome')
    setPrototypeTab('design')
    await dispatchEditorShortcut(editor, key('E', { code: 'KeyE', shiftKey: true }), context)
    expect(getPrototypeTab()).toBe('prototype')
    await dispatchEditorShortcut(editor, key('E', { code: 'KeyE', shiftKey: true }), context)
    expect(getPrototypeTab()).toBe('design')
    const first = editor.state.page
    editor.addPage()
    await dispatchEditorShortcut(editor, key('PageUp', { code: 'PageUp' }), context)
    expect(editor.state.page).toBe(first)
  })
  test('platform identification uses the OS, not a Mac-only assumption', () => {
    expect(shortcutPlatform('MacIntel')).toBe('mac'); expect(shortcutPlatform('Win32')).toBe('windows'); expect(shortcutPlatform('Linux x86_64')).toBe('linux')
  })
})
