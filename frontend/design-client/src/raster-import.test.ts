import { readFileSync } from 'node:fs'
import { afterEach, expect, test, vi } from 'vitest'
import { appendImageFiles, captureImageImportAnchor } from './append-image-files'
import { Editor } from './engine'
import { GIF_FIRST_FRAME_NOTICE, imageData } from './image-import'
import { VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, validateDocument } from './model'

afterEach(() => vi.unstubAllGlobals())

/** Node's test realm has File but not FileReader. This reads the real bytes
 * into a data URL; it does not invent dimensions or replace the codec. */
function installFileReader() {
  vi.stubGlobal('FileReader', class {
    result: string | null = null
    onload: null | (() => void) = null
    onerror: null | (() => void) = null
    onabort: null | (() => void) = null
    error: Error | null = null
    readAsDataURL(file: Blob) {
      void file.arrayBuffer().then(buffer => {
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        this.result = `data:${file.type || 'application/octet-stream'};base64,${btoa(binary)}`
        this.onload?.()
      }, error => {
        this.error = error instanceof Error ? error : new Error(String(error))
        this.onerror?.()
      })
    }
  })
}

function fixture(name: string, type: string, filename: string) {
  const b64 = readFileSync(new URL(`../../../design-studio/crates/design-kernel/tests/fixtures/${name}.b64`, import.meta.url), 'utf8').trim()
  const bytes = Uint8Array.from(atob(b64), char => char.charCodeAt(0))
  return { b64, bytes, file: new File([bytes], filename, { type }) }
}

test('production imageData keeps original GIF and TIFF bytes and the codec dimensions', async () => {
  installFileReader()
  const gif = fixture('gif', 'image/gif', 'two-frame.gif')
  const tiff = fixture('tiff', 'image/tiff', 'single.tiff')
  const gifImage = await imageData(gif.file)
  const tiffImage = await imageData(tiff.file)
  expect(gifImage).toEqual({ data: `data:image/gif;base64,${gif.b64}`, width: 64, height: 48 })
  expect(tiffImage).toEqual({ data: `data:image/tiff;base64,${tiff.b64}`, width: 64, height: 48 })
  expect(gifImage.data.includes('image/png')).toBe(false)
  expect(tiffImage.data.includes('image/png')).toBe(false)
  for (const [name, mime] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
    const sample = fixture(name, mime, `control.${name}`)
    const engine = new VectorEngine()
    try {
      expect(JSON.parse(engine.image_info(`data:${mime};base64,${sample.b64}`))).toEqual([64, 48])
    } finally { engine.free() }
  }
})

test('picker import of a two-frame GIF is one undo and save/reopen keeps the first-frame bytes', async () => {
  installFileReader()
  const editor = new Editor(blank('gif import'))
  const before = editor.state.doc
  const gif = fixture('gif', 'image/gif', 'two-frame.gif')
  const anchor = captureImageImportAnchor(editor, { width: 800, height: 600 })
  await expect(appendImageFiles(editor, [gif.file], anchor)).resolves.toEqual({ count: 1, status: 'committed' })
  const id = editor.state.doc.pages[0].children[0]
  const node = editor.state.doc.nodes[id]
  expect(node.width).toBe(64)
  expect(node.height).toBe(48)
  expect(node.fills[0].image).toBe(`data:image/gif;base64,${gif.b64}`)
  expect(editor.state.message).toContain(GIF_FIRST_FRAME_NOTICE)
  expect(editor.canUndo).toBe(true)
  const reopened = validateDocument(structuredClone(editor.state.doc))
  expect(reopened.nodes[id].fills[0].image).toBe(node.fills[0].image)
  editor.undo()
  expect(editor.state.doc).toBe(before)
  expect(editor.state.doc.pages[0].children).toEqual([])
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})

test('single-page TIFF import matches the PNG control size and restores on undo', async () => {
  installFileReader()
  const editor = new Editor(blank('tiff import'))
  const before = editor.state.doc
  const tiff = fixture('tiff', 'image/tiff', 'page.tif')
  const anchor = captureImageImportAnchor(editor, { width: 800, height: 600 })
  await appendImageFiles(editor, [tiff.file], anchor)
  const id = editor.state.doc.pages[0].children[0]
  expect(editor.state.doc.nodes[id]).toMatchObject({ width: 64, height: 48 })
  expect(editor.state.doc.nodes[id].fills[0].image).toBe(`data:image/tiff;base64,${tiff.b64}`)
  editor.undo()
  expect(editor.state.doc).toBe(before)
  editor.dispose()
})

test('corrupt GIF, multi-page TIFF, and an over-limit file leave the canvas unchanged', async () => {
  installFileReader()
  const editor = new Editor(blank('reject'))
  const before = editor.state.doc
  const anchor = captureImageImportAnchor(editor, { width: 800, height: 600 })
  const corrupt = fixture('corrupt-gif', 'image/gif', 'broken.gif')
  await expect(appendImageFiles(editor, [corrupt.file], anchor)).rejects.toThrow(/图片解码失败/)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  const multi = fixture('multi', 'image/tiff', 'pages.tiff')
  await expect(appendImageFiles(editor, [multi.file], anchor)).rejects.toThrow(/多页 TIFF/)
  expect(editor.state.doc).toBe(before)
  const abnormal = fixture('abnormal-tiff', 'image/tiff', 'odd.tiff')
  await expect(appendImageFiles(editor, [abnormal.file], anchor)).rejects.toThrow(/图片解码失败/)
  expect(editor.state.doc).toBe(before)
  await expect(imageData({ type: 'image/gif', size: 8 * 1024 * 1024 + 1 } as File)).rejects.toThrow(/8 MB/)
  await expect(imageData(fixture('gif', 'image/gif', 'wide.gif').file, 10)).rejects.toThrow(/像素预算/)
  expect(editor.state.doc).toBe(before)
  editor.dispose()
})
