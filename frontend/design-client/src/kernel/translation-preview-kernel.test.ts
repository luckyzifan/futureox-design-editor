import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Editor } from '../engine'
import { blank, defaultLayout, node, paint, type DesignDocument } from '../model'
import { emptySystem } from '../design-system'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { kernelLayout } from './picking'

afterEach(() => vi.restoreAllMocks())

function fixture(autoLayout = false) {
  const doc = blank('Translation resolver parity')
  doc.schemaVersion = 4
  doc.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: { source: { opaque: true } } } }
  const frame = node('frame', 0, 0, 220, 160)
  frame.fills = [paint('#ffffff')]
  if (autoLayout) frame.layout = { ...defaultLayout(), mode: 'vertical' }
  const moving = node('group', 10, 12, 40, 35), leaf = node('rectangle', 0, 0, 40, 35)
  leaf.fills = [paint('#21a452')]
  const text = node('text', 2, 5, 32, 18)
  text.text = 'Move'; text.fontSize = 12
  moving.children = [leaf.id, text.id]
  const other = node('vector', 80, 20, 30, 30)
  other.booleanOperation = 'subtract'
  other.fills = [paint('#204cdd')]
  const outer = node('rectangle', 0, 0, 30, 30), inner = node('rectangle', 7, 7, 16, 16)
  other.children = [outer.id, inner.id]
  frame.children = [moving.id, other.id]
  doc.nodes = Object.fromEntries([frame, moving, leaf, text, other, outer, inner].map(value => [value.id, value]))
  doc.pages[0].children = [frame.id]
  return { doc, moving, other }
}

function raster(document: DesignDocument) {
  const renderer = new VectorEngine()
  try {
    renderer.load_font(new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))))
    renderer.load_document(JSON.stringify(document))
    return renderer.render_rgba(JSON.stringify({ pageId: document.pages[0].id, width: 128, height: 96,
      view: { x: 0.125, y: 0.375, zoom: 1 }, transparent: false, rasterProfile: 'analytic' }))
  } finally { renderer.free() }
}

test('production preview matches forced resolver and CPU pixels while keeping unrelated CSG references', () => {
  const { doc, moving, other } = fixture()
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const resolve = vi.spyOn(VectorEngine.prototype, 'resolve_components')
    editor.begin('Move independent group')
    expect(editor.preview({ [moving.id]: { transform: [1, 0, 0, 1, 34, 20] } })).toBe(true)
    const after = editor.state.doc
    expect(resolve).not.toHaveBeenCalled()
    for (const id of Object.keys(after.nodes)) if (id !== moving.id) expect(after.nodes[id]).toBe(before.nodes[id])
    expect(after.nodes[other.id].network).toBe(before.nodes[other.id].network)
    const full = kernelLayout(after)
    expect(resolve).toHaveBeenCalledOnce()
    expect(after).toEqual(full)
    const movedPixels = raster(after)
    expect(movedPixels).toEqual(raster(full))
    expect(movedPixels).not.toEqual(raster(before))
  } finally { editor.dispose() }
})

test('an auto-layout parent retains the original full resolver instead of accepting manual placement', () => {
  const { doc, moving } = fixture(true)
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const candidate = { ...before, nodes: { ...before.nodes,
      [moving.id]: { ...before.nodes[moving.id], transform: [1, 0, 0, 1, 50, 60] as [number, number, number, number, number, number] } } }
    const full = kernelLayout(candidate)
    const resolve = vi.spyOn(VectorEngine.prototype, 'resolve_components')
    editor.begin('Move in auto layout')
    expect(editor.preview({ [moving.id]: { transform: [1, 0, 0, 1, 50, 60] } })).toBe(true)
    expect(resolve).toHaveBeenCalledOnce()
    expect(editor.state.doc).toEqual(full)
    expect(editor.state.doc.nodes[moving.id].transform).not.toEqual([1, 0, 0, 1, 50, 60])
  } finally { editor.dispose() }
})
