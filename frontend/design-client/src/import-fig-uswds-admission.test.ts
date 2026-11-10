import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { decodeFig, importFig } from './import-fig'
import { validateDocument } from './model'
import { Editor } from './engine'
import { kernelLayout } from './kernel/picking'
import { forma_decode_json, forma_encode_json, VectorEngine } from './generated/design-kernel/design_kernel'

const OFFICIAL_BYTES = 5_353_509
const OFFICIAL_SHA256 = 'df1c5bfdc6df46e93a2348f529788cba66083d22725198325b2dac352e64bdc8'
const figPath = process.env.USWDS_FIG

test.skipIf(!figPath)('official USWDS fig is admitted with pages, resources, layout, undo, save, and pixels', () => {
  if (!figPath || !existsSync(figPath)) throw new Error(`USWDS_FIG is not a readable file: ${figPath}`)
  const bytes = new Uint8Array(readFileSync(figPath))
  expect(bytes.byteLength).toBe(OFFICIAL_BYTES)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(OFFICIAL_SHA256)
  const decoded = decodeFig(bytes)
  expect(decoded.data.nodeChanges).toHaveLength(18_648)
  expect(Object.keys(decoded.files).filter(name => name.startsWith('images/')).length).toBeGreaterThan(0)
  const imported = importFig(bytes, 'USWDS')
  const document = validateDocument(imported.document)
  expect(document.pages.length).toBeGreaterThan(0)
  expect(Object.keys(document.nodes).length).toBeGreaterThan(1000)
  expect(document.pages.every(page => typeof page.id === 'string' && page.name.length > 0)).toBe(true)
  const laidOut = validateDocument(kernelLayout(document))
  expect(laidOut.pages.map(page => page.id)).toEqual(document.pages.map(page => page.id))
  expect(Object.keys(document.nodes).every(id => laidOut.nodes[id])).toBe(true)
  expect(Object.keys(laidOut.nodes).length).toBeGreaterThanOrEqual(Object.keys(document.nodes).length)
  const editor = new Editor(laidOut)
  try {
    const target = Object.values(editor.state.doc.nodes).find(node => node.kind !== 'group' && node.visible)
    expect(target).toBeTruthy()
    const id = target!.id
    const before = editor.state.doc.nodes[id].opacity
    const next = before === 0.25 ? 0.5 : 0.25
    editor.change('Adjust imported opacity', draft => { draft.nodes[id].opacity = next })
    expect(editor.state.doc.nodes[id].opacity).toBe(next)
    editor.undo()
    expect(editor.state.doc.nodes[id].opacity).toBe(before)
    editor.redo()
    expect(editor.state.doc.nodes[id].opacity).toBe(next)
    const encoded = forma_encode_json(JSON.stringify(editor.state.doc))
    const reopened = validateDocument(JSON.parse(forma_decode_json(encoded)))
    expect(reopened.pages.map(page => page.children.length)).toEqual(editor.state.doc.pages.map(page => page.children.length))
    expect(Object.keys(reopened.nodes).length).toBe(Object.keys(editor.state.doc.nodes).length)
    expect(reopened.nodes[id].opacity).toBe(next)
    const instances = Object.values(reopened.nodes).filter(node => node.instance)
    const components = Object.values(reopened.nodes).filter(node => node.component)
    expect(instances.length + components.length).toBeGreaterThan(0)
    const engine = new VectorEngine()
    try {
      engine.load_font(readFileSync(new URL('../public/fonts/NotoSansSC.ttf', import.meta.url)))
      engine.load_document(JSON.stringify(reopened))
      const page = reopened.pages[0]
      const pixels = engine.render_rgba(JSON.stringify({
        pageId: page.id,
        width: 48,
        height: 48,
        view: { x: 0, y: 0, zoom: 0.1 },
        transparent: false,
        grid: false,
        rasterProfile: 'analytic',
      }))
      expect(pixels.length).toBe(48 * 48 * 4)
      let ink = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] !== 255 || pixels[index + 1] !== 255 || pixels[index + 2] !== 255) ink += 1
      }
      expect(ink).toBeGreaterThan(0)
    } finally {
      engine.free()
    }
  } finally {
    editor.dispose()
  }
}, 300_000)
