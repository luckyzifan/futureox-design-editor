import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import * as commands from './editor-commands'
import { Editor } from './engine'
import { blank } from './model'
// Native menu and before-input-event both emit these legacy bridge names.
// Resolve at the renderer boundary, then retain the canonical focus policy.
const resolve = (name: string) => (commands as unknown as { resolveDesktopEditorCommand(name: string): commands.EditorCommand | undefined }).resolveDesktopEditorCommand(name)
afterEach(() => vi.unstubAllGlobals())
it.each([['zoomIn', 'zoom-in'], ['zoomOut', 'zoom-out'], ['zoom100', 'zoom-100']])('native %s resolves to %s', (native, canonical) => {
  expect(resolve(native)).toBe(canonical); expect(resolve(canonical)).toBe(canonical)
})
it('does not admit arbitrary native names', () => { expect(resolve('saveAs')).toBeUndefined(); expect(resolve('constructor')).toBeUndefined() })
it.each(['zoomIn', 'zoomOut', 'zoom100'])('native %s obeys focused-input ownership', async name => {
  const editor = new Editor(blank()), view = editor.state.view
  const input = { tagName: 'INPUT', closest: (selector: string) => selector.startsWith('input,') ? {} : null, getAttribute: () => null }
  vi.stubGlobal('document', { activeElement: input, querySelector: () => null })
  try { await commands.dispatchEditorCommand(editor, resolve(name)!); expect(editor.state.view).toBe(view) }
  finally { editor.dispose() }
})
it.each(['zoomIn', 'zoomOut', 'zoom100'])('native %s and canonical dispatch produce identical view', async name => {
  const a = new Editor(blank()), b = new Editor(blank())
  a.set({ view: { x: 5, y: 9, zoom: 0.75 } }); b.set({ view: { x: 5, y: 9, zoom: 0.75 } })
  vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
  try { await commands.dispatchEditorCommand(a, resolve(name)!); await commands.dispatchEditorCommand(b, ({zoomIn:'zoom-in',zoomOut:'zoom-out',zoom100:'zoom-100'} as const)[name as 'zoomIn'])
    expect(a.state.view).toEqual(b.state.view); expect(a.state.view.zoom).not.toBe(0.75)
  } finally { a.dispose(); b.dispose() }
})

it('App routes native callbacks through the canonical resolver and shared dispatcher', () => {
  // Static integration contract, not a mounted App or actual Electron GUI test.
  const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  expect(source).toContain('const command = resolveDesktopEditorCommand(name)')
  expect(source).toContain('if (command) void dispatchEditorCommand(editor, command)')
  expect(source).not.toContain('editorCommands.includes(name as EditorCommand)')
})
