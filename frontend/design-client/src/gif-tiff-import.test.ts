import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { appendImageFiles } from './append-image-files'
import { Editor } from './engine'
import { imageData } from './image-import'
import { forma_decode_json, forma_encode_json, VectorEngine } from './generated/design-kernel/design_kernel'
import { blank, node, paint, validateDocument } from './model'

// Node's test realm has File/Blob but not FileReader. This transport writes the
// real file bytes into a data URL; GIF/TIFF dimensions still come from WASM.
vi.stubGlobal('FileReader', class {
  result: string | null = null
  error: Error | null = null
  onload: null | (() => void) = null
  onerror: null | (() => void) = null
  onabort: null | (() => void) = null
  readAsDataURL(file: Blob) {
    file.arrayBuffer().then(buffer => {
      const type = file.type || 'application/octet-stream'
      this.result = `data:${type};base64,${Buffer.from(buffer).toString('base64')}`
      this.onload?.()
    }, error => {
      this.error = error instanceof Error ? error : new Error(String(error))
      this.onerror?.()
    })
  }
})

const gifBytes = new Uint8Array(readFileSync(new URL('../../../testing/fixtures/design/io/two-frame-64x48.gif', import.meta.url)))
const tiffBytes = new Uint8Array(readFileSync(new URL('../../../testing/fixtures/design/io/red-64x48.tiff', import.meta.url)))
const anchor = { x: 320, y: 240 }

function dataUrl(mime: string, bytes: Uint8Array) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

function renderImported(uri: string, width: number, height: number) {
  const doc = blank('raster import')
  const shape = node('rectangle', 0, 0, width, height)
  shape.name = '图片'
  shape.fills = [{ ...paint('#ffffff'), kind: 'image', image: uri, fit: 'stretch' }]
  doc.nodes[shape.id] = shape
  doc.pages[0].children = [shape.id]
  const admitted = validateDocument(doc)
  const engine = new VectorEngine()
  try {
    engine.load_document(JSON.stringify(admitted))
    const rgba = engine.render_rgba(JSON.stringify({
      pageId: admitted.pages[0].id, width, height, view: { x: 0, y: 0, zoom: 1 },
      transparent: true, grid: false, rasterProfile: 'analytic',
    }))
    return rgba
  } finally { engine.free() }
}

test('GIF first frame and single-page TIFF import through production admission, undo, save and WASM render', async () => {
  const gif = new File([gifBytes], 'frames.gif', { type: 'image/gif' })
  const tiff = new File([tiffBytes], 'plate.tiff', { type: '' })
  const editor = new Editor(blank('import'))
  const gifImage = await imageData(gif)
  const tiffImage = await imageData(tiff)
  expect(gifImage).toMatchObject({ width: 64, height: 48, animation: 'first-frame', data: dataUrl('image/gif', gifBytes) })
  expect(tiffImage).toMatchObject({ width: 64, height: 48, data: dataUrl('image/tiff', tiffBytes) })
  expect(tiffImage.animation).toBeUndefined()

  const imported = await appendImageFiles(editor, [gif, new File([tiffBytes], 'plate.tif', { type: 'image/tiff' })], anchor)
  expect(imported).toEqual({ count: 2, status: 'committed' })
  expect(editor.state.message).toContain('动画 GIF 只导入并绘制首帧')
  const nodes = editor.state.doc.pages[0].children.map(id => editor.state.doc.nodes[id])
  expect(nodes.map(node => [node.width, node.height])).toEqual([[64, 48], [64, 48]])
  expect(nodes[0].fills[0].image).toBe(gifImage.data)
  expect(nodes[1].fills[0].image).toBe(tiffImage.data)
  const saved = JSON.parse(forma_decode_json(forma_encode_json(JSON.stringify(editor.state.doc))))
  expect(saved.nodes[nodes[0].id].fills[0].image).toBe(gifImage.data)
  expect(saved.nodes[nodes[1].id].fills[0].image).toBe(tiffImage.data)

  for (const image of [gifImage, tiffImage]) {
    const rgba = renderImported(image.data, image.width, image.height)
    expect(Array.from(rgba.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(rgba.slice(-4))).toEqual([255, 0, 0, 255])
  }

  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc.pages[0].children).toEqual([])
  expect(Object.keys(editor.state.doc.nodes)).toEqual([])
  editor.dispose()
})

test('corrupt GIF and TIFF are rejected before the canvas changes', async () => {
  const editor = new Editor(blank('unchanged'))
  const before = editor.state.doc
  await expect(imageData(new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], 'broken.gif', { type: 'image/gif' }))).rejects.toThrow(/GIF decode failed/)
  await expect(imageData(new File([new Uint8Array([0x49, 0x49, 0x2a, 0x00])], 'broken.tiff', { type: 'image/tiff' }))).rejects.toThrow(/TIFF/)
  await expect(appendImageFiles(editor, [new File([gifBytes], 'notes.gif', { type: 'text/plain' })], anchor)).rejects.toThrow(/PNG、JPEG、WebP、GIF 或 TIFF/)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  editor.dispose()
})
