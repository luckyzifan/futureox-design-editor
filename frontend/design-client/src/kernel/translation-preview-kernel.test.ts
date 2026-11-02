import { afterEach, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Editor } from '../engine'
import { blank, defaultLayout, node, paint, type ConstraintAnchor, type DesignDocument, type Matrix } from '../model'
import { emptySystem } from '../design-system'
import { VectorEngine } from '../generated/design-kernel/design_kernel'
import { kernelLayout } from './picking'
import { translationOnlyChanges } from './translation-preview'

afterEach(() => vi.restoreAllMocks())

// Observe both current authoritative entry points. The old resolve_components
// export is retained for other callers but is no longer the Editor bridge.
function observeResolution() {
  const calls = vi.fn()
  for (const name of ['resolve_components_full', 'resolve_components_patch'] as const) {
    const original = VectorEngine.prototype[name]
    vi.spyOn(VectorEngine.prototype, name).mockImplementation(function(this: VectorEngine, ...args: any[]) {
      calls(name)
      return (original as (...values: any[]) => string).apply(this, args)
    })
  }
  return calls
}

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

function raster(document: DesignDocument, view = { x: 0.125, y: 0.375, zoom: 1 }) {
  const renderer = new VectorEngine()
  try {
    renderer.load_font(new Uint8Array(readFileSync(new URL('../../public/fonts/NotoSansSC.ttf', import.meta.url))))
    renderer.load_document(JSON.stringify(document))
    return renderer.render_rgba(JSON.stringify({ pageId: document.pages[0].id, width: 128, height: 96,
      view, transparent: false, rasterProfile: 'analytic' }))
  } finally { renderer.free() }
}

test('production preview matches forced resolver and CPU pixels while keeping unrelated CSG references', () => {
  const { doc, moving, other } = fixture()
  const editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const resolve = observeResolution()
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

function constrainedFixture(horizontal: ConstraintAnchor = 'scale', vertical: ConstraintAnchor = 'center', parentScale = false) {
  const doc = blank('Actual FIG constraint topology')
  doc.schemaVersion = 4
  doc.designSystem = { ...emptySystem(), sketchContainers: { nodeMetadata: { source: { opaque: true } } } }
  // Exact sizes, positions and constraint anchors from the profiled FIG target
  // and its two frame ancestors. Text content/style uses the bundled test font.
  const root = node('frame', 13937, -271, 1440, 1030)
  root.constraints = { horizontal: 'scale', vertical: 'scale' }
  const frame = node('frame', 428.1404113769531, 618, 584, 166)
  if (parentScale) frame.transform = [2, 0, 0, 3, frame.transform[4], frame.transform[5]]
  const moving = node('text', 75.85958862304688, 0, 456, 49)
  moving.text = 'Whooops, that page i'; moving.fontSize = 32; moving.fills = [paint('#192738')]
  moving.constraints = { horizontal, vertical, referenceWidth: 584, referenceHeight: 166 }
  frame.children = [moving.id]; root.children = [frame.id]
  doc.nodes = { [root.id]: root, [frame.id]: frame, [moving.id]: moving }
  doc.pages[0].children = [root.id]
  return { doc, moving, frame, root }
}

function translate(document: DesignDocument, id: string, x: number, y: number): DesignDocument {
  const moving = document.nodes[id]
  return { ...document, nodes: { ...document.nodes, [id]: { ...moving,
    transform: [...moving.transform.slice(0, 4), x, y] as Matrix } } }
}

test.each(['start', 'center', 'end', 'stretch', 'scale'] as const)('exact %s constraint fixed points match the real full WASM resolver', mode => {
  const f = constrainedFixture(mode, mode), editor = new Editor(f.doc)
  try {
    const before = editor.state.doc, candidate = translate(before, f.moving.id, 100, 24)
    const resolve = observeResolution()
    expect(translationOnlyChanges(before, candidate)).toEqual([f.moving.id])
    const fast = kernelLayout(candidate, before)
    expect(resolve).not.toHaveBeenCalled()
    const oracle = kernelLayout(candidate) // Explicitly no previous snapshot: force full Rust/WASM resolve.
    expect(resolve).toHaveBeenCalledOnce()
    expect(fast).toEqual(oracle)
  } finally { editor.dispose() }
})

test('profiled FIG scale/center target and inert page-root constraints retain exact pixels, editing and undo', () => {
  const f = constrainedFixture(), editor = new Editor(f.doc)
  try {
    const before = editor.state.doc, candidate = translate(before, f.moving.id, 99.86, 0)
    const resolve = observeResolution()
    expect(translationOnlyChanges(before, candidate)).toEqual([f.moving.id])
    const fast = kernelLayout(candidate, before)
    expect(resolve).not.toHaveBeenCalled()
    const oracle = kernelLayout(candidate)
    expect(resolve).toHaveBeenCalledOnce(); expect(fast).toEqual(oracle)
    const view = { x: -13937 - 428.1404113769531 + 0.125, y: 271 - 618 + 0.375, zoom: 1 }
    expect(raster(fast, view)).toEqual(raster(oracle, view))
    expect(raster(fast, view)).not.toEqual(raster(before, view))
    resolve.mockClear()
    editor.change('Translate constrained FIG text', doc => { doc.nodes[f.moving.id].transform[4] = 99.86 })
    expect(resolve).not.toHaveBeenCalled(); expect(editor.state.doc).toEqual(oracle)
    editor.undo(); expect(editor.state.doc).toEqual(before)
    editor.redo(); expect(editor.state.doc).toEqual(oracle)
  } finally { editor.dispose() }
})

test('stationary scaled parents keep local constraint axes and match the full WASM oracle', () => {
  const f = constrainedFixture('scale', 'center', true), editor = new Editor(f.doc)
  try {
    const before = editor.state.doc, candidate = translate(before, f.moving.id, 99.86, 12)
    expect(translationOnlyChanges(before, candidate)).toEqual([f.moving.id])
    expect(kernelLayout(candidate, before)).toEqual(kernelLayout(candidate))
  } finally { editor.dispose() }
})

test.each(['parent-resize', 'reference-mismatch', 'end-rounding', 'negative-zero', 'reference-owner'] as const)(
  '%s rejects the shortcut and retains the full WASM result', variant => {
    const f = constrainedFixture(variant === 'end-rounding' ? 'end' : 'scale')
    if (variant === 'end-rounding') { f.frame.width = 1e7; f.moving.constraints!.referenceWidth = 1e7 }
    if (variant === 'reference-owner') f.frame.componentKey = 'authored-component-reference'
    const editor = new Editor(f.doc)
    try {
      let before = editor.state.doc
      if (variant === 'reference-mismatch') {
        before = { ...before, nodes: { ...before.nodes, [f.moving.id]: { ...before.nodes[f.moving.id],
          constraints: { ...before.nodes[f.moving.id].constraints!, referenceWidth: 583 } } } }
      }
      let candidate = translate(before, f.moving.id, variant === 'end-rounding' ? 0.1 : variant === 'negative-zero' ? -0 : 99.86, 0)
      if (variant === 'parent-resize') candidate = { ...candidate, nodes: { ...candidate.nodes,
        [f.frame.id]: { ...candidate.nodes[f.frame.id], width: 600 } } }
      const resolve = observeResolution()
      expect(translationOnlyChanges(before, candidate)).toBeNull()
      const guarded = kernelLayout(candidate, before)
      expect(resolve).toHaveBeenCalledOnce()
      expect(guarded).toEqual(kernelLayout(candidate))
    } finally { editor.dispose() }
  })

test('a parent-preserving drag stays on the translation path and does not stringify the document', () => {
  const { doc, moving } = fixture(false), editor = new Editor(doc)
  try {
    const before = editor.state.doc
    const stringify = vi.spyOn(JSON, 'stringify')
    const resolve = observeResolution()
    editor.begin('Move')
    expect(editor.preview({ [moving.id]: { transform: [1, 0, 0, 1, 48, 52] } },
      { ids: [moving.id], point: { x: 48, y: 52 }, force: false, preserveParent: true })).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(stringify.mock.calls.some(([value]) => value === before || value === editor.state.doc)).toBe(false)
    expect(editor.state.doc.nodes[moving.id].transform).toEqual([1, 0, 0, 1, 48, 52])
    stringify.mockClear()
    expect(editor.preview({ [moving.id]: { transform: [1, 0, 0, 1, 60, 70] } },
      { ids: [moving.id], point: { x: 60, y: 70 }, force: false, preserveParent: true })).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
    expect(stringify.mock.calls.some(([value]) => value === editor.state.doc)).toBe(false)
    editor.cancel()
    expect(editor.state.doc).toBe(before)
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
    const resolve = observeResolution()
    editor.begin('Move in auto layout')
    expect(editor.preview({ [moving.id]: { transform: [1, 0, 0, 1, 50, 60] } })).toBe(true)
    expect(resolve).toHaveBeenCalledOnce()
    expect(editor.state.doc).toEqual(full)
    expect(editor.state.doc.nodes[moving.id].transform).not.toEqual([1, 0, 0, 1, 50, 60])
  } finally { editor.dispose() }
})
