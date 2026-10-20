import { describe, expect, it } from 'vitest'
import { Editor } from './engine'
import { blank } from './model'
import { appendImageFiles as appendImages, captureImageImportAnchor, type DecodeImportImage, type DecodedImportImage } from './append-image-files'
import { worldToScreen } from './canvas-camera'
const viewport = { width: 800, height: 600 }
const appendImageFiles = (editor: Editor, files: File[], decode: DecodeImportImage) => appendImages(editor, files, captureImageImportAnchor(editor, viewport), decode)
const image = { uri: 'data:image/png;base64,AA==', width: 20, height: 30 }
const file = {} as File
function pending() { let resolve!: (image: DecodedImportImage) => void; const promise = new Promise<DecodedImportImage>(yes => { resolve = yes }); return { promise, resolve } }
describe('image import target ownership', () => {
  it('never inserts decoded images into a document opened while decoding', async () => {
    const editor = new Editor(blank('first')); const decode = pending()
    const work = appendImageFiles(editor, [file], () => decode.promise)
    editor.load(blank('second')); const target = editor.state.doc; const version = editor.state.version
    decode.resolve(image)
    await expect(work).rejects.toThrow(/已变化/)
    expect(editor.state.doc).toBe(target); expect(editor.state.version).toBe(version)
    expect(Object.keys(target.nodes)).toHaveLength(0); editor.dispose()
  })
  it('never inserts into a page selected while decoding', async () => {
    const editor = new Editor(blank()); const first = editor.state.page; editor.addPage(); editor.switchPage(first)
    const decode = pending(); const work = appendImageFiles(editor, [file], () => decode.promise)
    editor.switchPage(editor.state.doc.pages[1].id); const target = editor.state.doc
    decode.resolve(image); await expect(work).rejects.toThrow(/已变化/)
    expect(editor.state.doc).toBe(target); expect(Object.keys(target.nodes)).toHaveLength(0); editor.dispose()
  })
  it('does not interleave an import with edits made during decoding', async () => {
    const editor = new Editor(blank()); const decode = pending(); const work = appendImageFiles(editor, [file], () => decode.promise)
    editor.add('rectangle', { x: 0, y: 0, width: 10, height: 10 }); const target = editor.state.doc
    decode.resolve(image); await expect(work).rejects.toThrow(/已变化/)
    expect(editor.state.doc).toBe(target); expect(Object.keys(target.nodes)).toHaveLength(1); editor.dispose()
  })
  it('imports all images in one history operation when the original target remains current', async () => {
    const editor = new Editor(blank()); const before = editor.state.doc
    expect(await appendImageFiles(editor, [file, file], async () => image)).toEqual({ count: 2, status: 'committed' })
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(2)
    editor.undo(); expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0)
    expect(editor.state.doc.pages[0].children).toEqual(before.pages[0].children); editor.dispose()
  })
  it('does not announce success when the actual document validator rejects the image', async () => {
    const editor = new Editor(blank()); const before = editor.state.doc
    const result = await appendImageFiles(editor, [file], async () => ({ ...image, width: NaN }))
    expect(result.status).toBe('rejected'); expect(editor.state.doc).toBe(before)
    expect(editor.state.message).not.toContain('已导入'); editor.dispose()
  })
  it('does not commit a partial image batch when a later decode fails', async () => {
    const editor = new Editor(blank()); const before = editor.state.doc; let calls = 0
    await expect(appendImageFiles(editor, [file, file], async () => { if (calls++) throw new Error('decode failed'); return image })).rejects.toThrow('decode failed')
    expect(editor.state.doc).toBe(before); expect(editor.canUndo).toBe(false); editor.dispose()
  })

  it('centers image batches using the actual panned and zoomed canvas projection', async () => {
    const editor = new Editor(blank()); editor.set({ view: { x: -300, y: 120, zoom: 2 } })
    const anchor = captureImageImportAnchor(editor, viewport)
    let index = 0
    await appendImages(editor, [file, file], anchor, async () => ({ ...image, height: index++ ? 70 : 30 }))
    const nodes = editor.state.doc.pages[0].children.map(id => editor.state.doc.nodes[id])
    expect(nodes[1].transform[5] - (nodes[0].transform[5] + nodes[0].height)).toBe(20)
    const top = nodes[0].transform[5], bottom = nodes[1].transform[5] + nodes[1].height
    expect(worldToScreen(editor.state.view, { x: nodes[0].transform[4] + nodes[0].width / 2, y: (top + bottom) / 2 })).toEqual({ x: 400, y: 300 })
    editor.dispose()
  })
  it('keeps the captured import anchor when the camera pans during decoding', async () => {
    const editor = new Editor(blank()); const anchor = captureImageImportAnchor(editor, viewport); const decode = pending()
    const work = appendImages(editor, [file], anchor, () => decode.promise)
    editor.set({ view: { x: 900, y: -700, zoom: 4 } }); decode.resolve(image); await work
    const imported = Object.values(editor.state.doc.nodes)[0]
    expect(imported.transform[4] + imported.width / 2).toBe(anchor.x)
    expect(imported.transform[5] + imported.height / 2).toBe(anchor.y)
    editor.dispose()
  })
  it('refuses to invent a viewport center when the canvas has no measurable viewport', () => {
    const editor = new Editor(blank())
    expect(() => captureImageImportAnchor(editor, { width: 0, height: 0 })).toThrow(/画布尚未显示/)
    expect(Object.keys(editor.state.doc.nodes)).toHaveLength(0); editor.dispose()
  })

})
