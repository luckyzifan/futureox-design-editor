import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node, defaultTextStyle } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { activateDocumentFonts, pickingGeometryEpoch, kernelTextLayout, kernelBounds } from './kernel/picking'

afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const doc = blank('font owner'); doc.fonts = {}
  const shape = node('rectangle', 0, 0, 20, 20)
  doc.nodes[shape.id] = shape; doc.pages[0].children.push(shape.id)
  const editor = new Editor(doc); editor.select([shape.id])
  activateDocumentFonts(editor.state.doc)
  return { editor, shape }
}
function expectCurrentFonts(editor: Editor) {
  const epoch = pickingGeometryEpoch()
  activateDocumentFonts(editor.state.doc)
  expect(pickingGeometryEpoch()).toBe(epoch)
}
it('export restores current fonts without changing document or revision', () => {
  const { editor } = fixture(), before = editor.state.doc, version = editor.state.version
  try { expect(editor.exportClipboard()).toBeTruthy(); expectCurrentFonts(editor)
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  } finally { editor.dispose() }
})
it('malformed imported roots restore current fonts and preserve document', () => {
  const { editor } = fixture(), before = editor.state.doc
  try { expect(() => editor.importClipboard(JSON.stringify({ format: 'forma-nodes', version: 1, document: blank(), roots: ['missing'] }))).toThrow()
    expectCurrentFonts(editor); expect(editor.state.doc).toBe(before)
  } finally { editor.dispose() }
})
it.each(['ok', 'cancelled', 'error'])('native copy %s restores fonts and preserves source history', async status => {
  const { editor } = fixture(), before = editor.state.doc, version = editor.state.version
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { write: async () => ({ status, message: 'failure' }) } } })
  try { await dispatchEditorCommand(editor, 'copy'); expectCurrentFonts(editor)
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  } finally { editor.dispose() }
})
it.each([false, true])('ordinary paste restores committed or locked destination fonts (locked=%s)', async locked => {
  const source = fixture(), destination = fixture()
  const packet = source.editor.exportClipboard()!
  destination.editor.update([destination.shape.id], { locked })
  activateDocumentFonts(destination.editor.state.doc)
  const before = destination.editor.state.doc, version = destination.editor.state.version
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: async () => ({ status: 'ok', forma: packet }) } } })
  try { await dispatchEditorCommand(destination.editor, 'paste'); expectCurrentFonts(destination.editor)
    if (locked) { expect(destination.editor.state.doc).toBe(before); expect(destination.editor.state.version).toBe(version) }
    else { expect(destination.editor.state.version).toBe(version + 1); destination.editor.undo(); expect(destination.editor.state.doc).toEqual(before) }
  } finally { source.editor.dispose(); destination.editor.dispose() }
})
it.each(['cancelled', 'error'])('paste read %s leaves document/history/fonts intact', async status => {
  const { editor } = fixture(), before = editor.state.doc, version = editor.state.version
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: async () => ({ status, message: 'failure' }) } } })
  try { await dispatchEditorCommand(editor, 'paste'); expectCurrentFonts(editor)
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
  } finally { editor.dispose() }
})
it('late clipboard read cannot paste after selection changes', async () => {
  const source = fixture(), destination = fixture(), packet = source.editor.exportClipboard()!
  activateDocumentFonts(destination.editor.state.doc)
  let complete!: (value: unknown) => void
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: () => new Promise(resolve => { complete = resolve }) } } })
  const before = destination.editor.state.doc, version = destination.editor.state.version
  try { const pending = dispatchEditorCommand(destination.editor, 'paste'); destination.editor.select([])
    complete({ status: 'ok', forma: packet }); await pending; expectCurrentFonts(destination.editor)
    expect(destination.editor.state.doc).toBe(before); expect(destination.editor.state.version).toBe(version)
  } finally { source.editor.dispose(); destination.editor.dispose() }
})

const embeddedFont = () => readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)).toString('base64')
it.each([
  ['copy', 'ok'], ['copy', 'cancelled'], ['copy', 'error'], ['cut', 'ok'],
  ['paste', 'ok'], ['paste', 'cancelled'], ['paste', 'error'],
] as const)('deferred %s %s after document switch keeps final embedded-font geometry/history', async (command, status) => {
  const bytes = embeddedFont()
  const documentWithText = (fontId: string) => {
    const doc = blank(fontId), text = node('text', 10, 20, 180, 40)
    doc.schemaVersion = 4; doc.fonts = { [fontId]: { family: fontId, data: bytes } }
    text.text = '字体117'; text.textStyle = { ...defaultTextStyle(), fontId }
    doc.nodes[text.id] = text; doc.pages[0].children = [text.id]
    return { doc, id: text.id }
  }
  const original = documentWithText('origin'), current = documentWithText('current')
  const editor = new Editor(original.doc); editor.select([original.id])
  const packet = editor.exportClipboard()!, originalSnapshot = editor.state.doc
  let complete!: (value: unknown) => void
  const deferred = () => new Promise(resolve => { complete = resolve })
  vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: deferred, write: deferred } } })
  try {
    const pending = dispatchEditorCommand(editor, command)
    expect(complete).toBeTypeOf('function')
    editor.load(current.doc)
    editor.update([current.id], { text: '当前字体 117' })
    const before = editor.state.doc, version = editor.state.version, session = editor.sessionGeneration
    const layout = kernelTextLayout(before.nodes[current.id]), geometry = kernelBounds(before.nodes[current.id])
    const epoch = pickingGeometryEpoch()
    expect(layout.glyphs.length).toBeGreaterThan(0)
    expect(layout.glyphs.every(g => (g as unknown as { fontId: string }).fontId === 'current')).toBe(true)
    expect(editor.canUndo).toBe(true)
    complete({ status, message: 'clipboard unavailable', forma: packet }); await pending
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version)
    expect(editor.sessionGeneration).toBe(session); expect(editor.canUndo).toBe(true); expect(editor.canRedo).toBe(false)
    expect(pickingGeometryEpoch()).toBe(epoch)
    expect(kernelTextLayout(editor.state.doc.nodes[current.id])).toEqual(layout)
    expect(kernelBounds(editor.state.doc.nodes[current.id])).toEqual(geometry)
    expectCurrentFonts(editor)
    expect(originalSnapshot.nodes[original.id].text).toBe('字体117')
    editor.undo(); expect(editor.state.doc.nodes[current.id].text).toBe('字体117')
    expect(editor.state.doc.nodes[original.id]).toBeUndefined()
    editor.redo(); expect(editor.state.doc).toEqual(before)
    expect(kernelTextLayout(editor.state.doc.nodes[current.id])).toEqual(layout)
  } finally { editor.dispose() }
})
