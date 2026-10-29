import { afterEach, describe, it, expect, vi } from 'vitest'
import { imageData } from '../image-import'
import { appendImageFiles, captureImageImportAnchor } from '../append-image-files'
import { blank } from '../model'
import type { Editor } from '../engine'
afterEach(() => vi.unstubAllGlobals())
// Controlled browser decoding, real admission/return logic. Not a codec test.
function decoder(data: string) {
  vi.stubGlobal('FileReader', class { result = data; onload = () => {}; readAsDataURL() { queueMicrotask(() => this.onload()) } })
  vi.stubGlobal('Image', class { naturalWidth = 200; naturalHeight = 150; src = ''; async decode() {} })
}
// Transaction recorder isolates actual image construction from Editor/WASM.
// ../append-image-files.test.ts separately tests real validation/history/ownership.
function editorRecorder() {
  const doc = blank('image construction contract'), changes: string[] = []
  const recorder = {
    sessionGeneration: 1, state: { doc, page: doc.pages[0].id, version: 0, busy: false }, interactionActive: false,
    flushPendingView: () => ({ x: -300, y: 120, zoom: 2 }),
    change(label: string, callback: (draft: typeof doc) => void) { changes.push(label); callback(doc); return { status: 'committed' } },
    notify: vi.fn(),
  }
  return { editor: recorder as unknown as Editor, doc, changes }
}
describe('production image import admission/construction with controlled browser/transaction boundaries', () => {
  for (const [label, mime] of [['PNG', 'image/png'], ['JPG/JPEG', 'image/jpeg'], ['WEBP', 'image/webp']]) {
    it(`accepts ${label} through production imageData and preserves encoded payload`, async () => {
      const payload = `data:${mime};base64,EXACT+ORIGINAL==`; decoder(payload)
      expect(await imageData(new File(['encoded fixture'], 'misleading-name.bin', { type: mime }))).toEqual({ data: payload, width: 200, height: 150 })
    })
  }
  it('creates canonical image fill nodes through appendImageFiles', async () => {
    const f = editorRecorder(), uri = 'data:image/png;base64,EXACT=='
    expect(await appendImageFiles(f.editor, [new File(['bytes'], 'sample.png', {type:'image/png'})], { x: 500, y: 400 }, async () => ({ uri, width: 200, height: 150 }))).toEqual({ count: 1, status: 'committed' })
    const [id] = f.doc.pages[0].children, node = f.doc.nodes[id]
    expect(node).toMatchObject({ kind: 'rectangle', width: 200, height: 150, transform: [1, 0, 0, 1, 400, 325] })
    expect(node.fills[0]).toMatchObject({ kind: 'image', image: uri, fit: 'cover', visible: true, opacity: 1 })
    expect(f.changes).toEqual(['导入图片'])
  })
  it('captures viewport center through production pending-camera projection', () => {
    expect(captureImageImportAnchor(editorRecorder().editor, { width: 1000, height: 800 })).toEqual({ x: 400, y: 140 })
  })
  it('constructs all imported nodes with production spacing and a centered batch', async () => {
    const f = editorRecorder(), dimensions = [{ width: 100, height: 80 }, { width: 150, height: 100 }, { width: 120, height: 90 }]
    let index = 0
    await appendImageFiles(f.editor, dimensions.map(() => new File(['bytes'], 'sample.png', {type:'image/png'})), { x: 500, y: 400 }, async () => ({ uri: 'data:image/png;base64,AA==', ...dimensions[index++] }))
    const nodes = f.doc.pages[0].children.map(id => f.doc.nodes[id])
    expect(nodes.map(node => node.transform[5])).toEqual([245, 345, 465])
    expect(nodes.map(node => node.transform[4])).toEqual([450, 425, 440]); expect(f.changes).toHaveLength(1)
  })
  it('a PNG extension cannot bypass production MIME admission', async () => {
    await expect(imageData(new File(['not an image'], 'fake.png', { type: 'text/plain' }))).rejects.toThrow(/PNG、JPEG 或 WebP/)
  })
})
