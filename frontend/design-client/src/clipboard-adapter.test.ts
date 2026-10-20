// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import { dispatchEditorCommand } from './editor-commands'
import { CLIPBOARD_FORMA_TYPE, CLIPBOARD_TEXT_PREFIX, MAX_CLIPBOARD_BYTES, readEditorClipboard, writeWebGraphClipboard } from './clipboard-adapter'

// Browser Clipboard/Blob transport doubles, production adapter + real Editor,
// admission, and WASM history. These are not an OS permission/paste claim.
const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function fixture() {
  const doc = blank(), a = node('rectangle', 10, 20, 30, 40), b = node('rectangle', 60, 70, 30, 40)
  doc.nodes[a.id] = a; doc.nodes[b.id] = b; doc.pages[0].children = [a.id, b.id]
  const editor = new Editor(doc); editor.select([a.id]); editors.push(editor)
  return { editor, a, b }
}
function item(values: Record<string, Blob>) { return { types: Object.keys(values), getType: vi.fn(async (type: string) => values[type]) } }
function browser(values: Record<string, unknown>) { vi.stubGlobal('navigator', { clipboard: values }) }
const text = (value: string, type = 'text/plain') => new Blob([value], { type })

describe('production rich clipboard adapter', () => {
  it('prefers the native transport and preserves cancellation without web access', async () => {
    const read = vi.fn(); browser({ read })
    vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: async () => ({ status: 'ok', svg: '<svg/>' }) } } })
    expect(await readEditorClipboard()).toMatchObject({ svg: '<svg/>' }); expect(read).not.toHaveBeenCalled()
    vi.stubGlobal('window', { coreDesktop: { version: 1, clipboard: { read: async () => ({ status: 'cancelled' }) } } })
    await expect(readEditorClipboard()).rejects.toThrow('取消'); expect(read).not.toHaveBeenCalled()
  })
  it('reads the graph representation ahead of image/text across items', async () => {
    const source = fixture(), destination = new Editor(blank()); editors.push(destination)
    const encoded = source.editor.exportClipboard()!, plain = item({ 'text/plain': text('fallback') }), rich = item({ [CLIPBOARD_FORMA_TYPE]: text(encoded, 'application/x-forma-nodes-v1'), 'image/png': new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })
    const readText = vi.fn(); browser({ read: async () => [plain, rich], readText })
    await dispatchEditorCommand(destination, 'paste-in-place')
    expect(destination.state.selection).toHaveLength(1)
    const pasted = destination.state.doc.nodes[destination.state.selection[0]]
    expect(pasted.kind).toBe('rectangle'); expect(pasted.transform).toEqual(source.a.transform)
    expect(rich.getType).toHaveBeenCalledExactlyOnceWith(CLIPBOARD_FORMA_TYPE); expect(plain.getType).not.toHaveBeenCalled(); expect(readText).not.toHaveBeenCalled()
    destination.undo(); expect(Object.keys(destination.state.doc.nodes)).toHaveLength(0)
  })
  it('reads SVG through the production import/admission and makes one undoable paste', async () => {
    const editor = new Editor(blank()); editors.push(editor)
    vi.stubGlobal('DOMParser', new JSDOM('').window.DOMParser)
    browser({ read: async () => [item({ 'image/svg+xml': text('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#f00"/></svg>', 'image/svg+xml'), 'text/plain': text('fallback') })] })
    const before = editor.state.doc
    await dispatchEditorCommand(editor, 'paste')
    expect(editor.state.doc).not.toBe(before); expect(editor.state.selection.length).toBeGreaterThan(0)
    expect(Object.values(editor.state.doc.nodes).some(n => n.kind === 'text' && n.text === 'fallback')).toBe(false)
    editor.undo(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
  it.each(['image/png', 'image/jpeg', 'image/webp'])('preserves binary bytes for %s before the image decoder', async mime => {
    const bytes = new Uint8Array([0, 128, 255, 16]), image = item({ [mime]: new Blob([bytes], { type: mime }) })
    browser({ read: async () => [image] })
    expect(await readEditorClipboard()).toEqual({ image: `data:${mime};base64,AID/EA==` })
  })
  it('falls back to plain text only when the rich API is absent or unsupported', async () => {
    const readText = vi.fn(async () => 'plain')
    browser({ readText }); expect(await readEditorClipboard()).toEqual({ text: 'plain' })
    browser({ read: async () => { throw new DOMException('unsupported', 'NotSupportedError') }, readText })
    expect(await readEditorClipboard()).toEqual({ text: 'plain' }); expect(readText).toHaveBeenCalledTimes(2)
  })
  it('does not fall back on denied rich read, decode failure, or unsupported MIME', async () => {
    const readText = vi.fn(async () => 'must not read')
    browser({ read: async () => { throw new DOMException('permission denied', 'NotAllowedError') }, readText })
    await expect(readEditorClipboard()).rejects.toThrow('permission denied')
    browser({ read: async () => [{ types: ['image/svg+xml', 'text/plain'], getType: async () => { throw new Error('decode failure') } }], readText })
    await expect(readEditorClipboard()).rejects.toThrow('decode failure')
    browser({ read: async () => [item({ 'text/html': text('<b>not supported</b>', 'text/html') })], readText })
    await expect(readEditorClipboard()).rejects.toThrow('支持'); expect(readText).not.toHaveBeenCalled()
  })
  it('bounds bytes before reading or allocating a payload, and checks MIME consistency', async () => {
    const payload = { size: MAX_CLIPBOARD_BYTES + 1, type: 'text/plain', text: vi.fn(), arrayBuffer: vi.fn() } as unknown as Blob
    browser({ read: async () => [item({ 'text/plain': payload })] })
    await expect(readEditorClipboard()).rejects.toThrow('32 MiB'); expect(payload.text).not.toHaveBeenCalled()
    browser({ read: async () => [item({ 'image/png': text('bad', 'image/jpeg') })] })
    await expect(readEditorClipboard()).rejects.toThrow('MIME')
    browser({ read: async () => Array.from({ length: 17 }, () => item({})) })
    await expect(readEditorClipboard()).rejects.toThrow('项目过多')
  })
  it.each(['NotAllowedError', 'SecurityError'])('preserves original layers and history on %s', async name => {
    const { editor, a } = fixture(), before = editor.state.doc
    const writeText = vi.fn(async () => { throw new DOMException('denied', name) })
    browser({ writeText, read: async () => { throw new DOMException('denied', name) } })
    await dispatchEditorCommand(editor, 'cut'); expect(editor.state.doc).toBe(before); expect(editor.state.doc.nodes[a.id]).toBeDefined()
    await dispatchEditorCommand(editor, 'paste'); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
  it('cannot silently cut when no system clipboard write API is available', async () => {
    const { editor } = fixture(), before = editor.state.doc; browser({})
    await dispatchEditorCommand(editor, 'cut')
    expect(editor.state.doc).toBe(before); expect(editor.state.message).toContain('原图层已保留'); expect(editor.canUndo).toBe(false)
  })
  it('rejects malformed/empty rich packets without falling back to readable text or the old copy', async () => {
    const { editor } = fixture(), before = editor.state.doc
    browser({ writeText: async () => {} }); await dispatchEditorCommand(editor, 'copy')
    for (const encoded of ['', '{bad json', JSON.stringify({ format: 'forma-nodes', version: 1, document: blank(), roots: ['missing'] })]) {
      browser({ read: async () => [item({ [CLIPBOARD_FORMA_TYPE]: text(encoded), 'text/plain': text('fallback') })] })
      await dispatchEditorCommand(editor, 'paste'); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
    }
    browser({ readText: async () => CLIPBOARD_TEXT_PREFIX }); await dispatchEditorCommand(editor, 'paste'); expect(editor.state.doc).toBe(before)
  })
  it.each(['selection', 'selection-return', 'revision', 'page', 'page-return', 'document', 'interaction'])('fences an asynchronous read after a %s change', async change => {
    const { editor, b } = fixture()
    let resolve!: (items: unknown[]) => void
    browser({ read: () => new Promise(done => { resolve = done }) })
    const pending = dispatchEditorCommand(editor, 'paste')
    if (change === 'selection') editor.select([b.id])
    else if (change === 'selection-return') { const previous = editor.state.selection; editor.select([b.id]); editor.select(previous) }
    else if (change === 'revision') editor.update(editor.state.selection, { opacity: .5 })
    else if (change === 'page') editor.set({ page: 'new-page' })
    else if (change === 'page-return') { const previous = editor.state.page; editor.set({ page: 'new-page' }); editor.set({ page: previous }) }
    else if (change === 'document') editor.load(blank('new'))
    else editor.begin('drag')
    const before = editor.state.doc, version = editor.state.version
    resolve([item({ 'text/plain': text('do not paste') })]); await pending
    expect(editor.state.doc).toBe(before); expect(editor.state.version).toBe(version); expect(editor.state.message).toContain('变化')
    if (change === 'interaction') editor.cancel()
  })
  it('preserves native custom PNG bytes through the Web adapter', async () => {
    browser({ read: async () => [item({ 'web application/x-forma-png-v1': new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'application/x-forma-png-v1' }), 'image/png': new Blob(['alternate'], { type: 'image/png' }) })] })
    expect(await readEditorClipboard()).toEqual({ image: 'data:image/png;base64,iVBORw==' })
  })
  it('retains a valid image as one undoable paste after the browser decoder seam', async () => {
    const editor = new Editor(blank()); editors.push(editor)
    // Image decoding is a browser API double, not real pixel validation.
    class DecodedImage { src = ''; naturalWidth = 2; naturalHeight = 3; async decode() {} }
    vi.stubGlobal('Image', DecodedImage)
    browser({ read: async () => [item({ 'image/png': new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })] })
    const before = editor.state.doc
    await dispatchEditorCommand(editor, 'paste')
    expect(editor.state.selection).toHaveLength(1)
    const image = editor.state.doc.nodes[editor.state.selection[0]]
    expect(image.width).toBe(2); expect(image.height).toBe(3); expect(image.fills[0].image).toBe('data:image/png;base64,iVBORw==')
    editor.undo(); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
  it('image decode failure and oversized decoded dimensions cannot mutate history', async () => {
    const { editor } = fixture(), before = editor.state.doc
    browser({ read: async () => [item({ 'image/png': new Blob(['bad'], { type: 'image/png' }) })] })
    class RejectedImage { src = ''; async decode() { throw new Error('decode rejected') } }
    vi.stubGlobal('Image', RejectedImage); await dispatchEditorCommand(editor, 'paste')
    expect(editor.state.message).toContain('decode rejected'); expect(editor.state.doc).toBe(before)
    class HugeImage { src = ''; naturalWidth = 8192; naturalHeight = 8192; async decode() {} }
    vi.stubGlobal('Image', HugeImage); await dispatchEditorCommand(editor, 'paste')
    expect(editor.state.message).toContain('像素过大'); expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false)
  })
  it('denied readText fallback never revives an earlier copy', async () => {
    const { editor } = fixture(), before = editor.state.doc
    browser({ writeText: async () => {} }); await dispatchEditorCommand(editor, 'copy')
    browser({ readText: async () => { throw new DOMException('denied text', 'NotAllowedError') } })
    await dispatchEditorCommand(editor, 'paste'); expect(editor.state.doc).toBe(before); expect(editor.state.message).toContain('denied text')
  })
  it('writes custom graph plus portable text and never retries a denied rich write', async () => {
    class Item { static supports = () => true; constructor(readonly values: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', Item)
    const write = vi.fn(async () => {}), writeText = vi.fn(async () => {})
    browser({ write, writeText }); await writeWebGraphClipboard('graph')
    const written = write.mock.calls[0] as unknown as [Item[]]
    expect(await written[0][0].values[CLIPBOARD_FORMA_TYPE].text()).toBe('graph')
    expect(await written[0][0].values['text/plain'].text()).toBe(CLIPBOARD_TEXT_PREFIX + 'graph')
    expect(writeText).not.toHaveBeenCalled()
    browser({ write: async () => { throw new DOMException('denied', 'NotAllowedError') }, writeText })
    await expect(writeWebGraphClipboard('graph')).rejects.toThrow('denied'); expect(writeText).not.toHaveBeenCalled()
  })
})
