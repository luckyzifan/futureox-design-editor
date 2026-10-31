import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import * as commands from './editor-commands'

// Executable source-route contract: run the actual desktop subscription's
// command-routing tail with controlled dependencies. This is not a mounted App,
// a synthetic copied routing implementation, or actual Electron GUI evidence.
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const start = app.indexOf("      if (name === 'open') void desktopSession.open()")
const end = app.indexOf('\n    }\n    const shortcut =', start)
if (start < 0 || end < 0) throw Error('Desktop callback route boundary changed; review this contract')
// Erase only the baseline's TypeScript-only EditorCommand assertions.
const route = new Function('name', 'editor', 'editorCommands', 'resolveDesktopEditorCommand', 'dispatchEditorCommand', 'desktopSession', 'blank', app.slice(start, end).replace(/\s+as EditorCommand\b/g, ''))
afterEach(() => vi.unstubAllGlobals())
it.each(['zoomIn', 'zoomOut', 'zoom100'])('actual App desktop route delivers %s to the camera', async name => {
  const editor = new Editor(blank()), pending: Promise<void>[] = []
  editor.set({ view: { x: 10, y: 20, zoom: 0.75 } })
  vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
  const dispatch = vi.fn((owner: Editor, command: commands.EditorCommand) => {
    const result = commands.dispatchEditorCommand(owner, command); pending.push(result); return result
  })
  try {
    route(name, editor, commands.editorCommands, (commands as any).resolveDesktopEditorCommand, dispatch, {}, blank)
    await Promise.all(pending)
    // Baseline fails here because its actual route never dispatches camelCase.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(editor.state.view.zoom).not.toBe(0.75)
    if (name === 'zoom100') expect(editor.state.view.zoom).toBe(1)
  } finally { editor.dispose() }
})
