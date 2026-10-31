import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, paint, validateDocument } from './model'
import { defaultVectorBrush, validateVectorBrush } from './vector-brush'
import { pathNetwork } from './path-network'
import { encodeDocumentBinary, decodeDocumentBinary } from './kernel/binfmt'
import { kernelBounds, kernelSvgPaths } from './kernel/picking'
const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(e => e.dispose()))
function fixture() {
  const d = blank(), n = node('vector', 0, 0, 40, 20)
  n.network = pathNetwork('M0 0L40 0'); n.fills = [paint('#426bdf')]
  d.nodes[n.id] = n; d.pages[0].children = [n.id]
  const editor = new Editor(d); editors.push(editor)
  return { editor, n, brush: defaultVectorBrush(pathNetwork('M-2 -1C-1 -3 1 -3 2 -1L2 1L-2 1Z')) }
}
test('embedded source, guide and deterministic seed survive save/reopen, undo and redo', () => {
  const { editor, n, brush } = fixture(), before = editor.state.doc
  editor.updateProperties([n.id], n => { n.vectorBrush = brush }, 'Brush')
  expect(editor.state.doc.nodes[n.id].vectorBrush).toEqual(brush)
  const reopened = validateDocument(JSON.parse(JSON.stringify(editor.state.doc)))
  expect(validateDocument(decodeDocumentBinary(encodeDocumentBinary(editor.state.doc))).nodes[n.id].vectorBrush).toEqual(brush)
  expect(reopened.nodes[n.id].vectorBrush).toEqual(brush)
  expect(reopened.nodes[n.id].network).toEqual(n.network)
  const fill = kernelSvgPaths(editor.state.doc.nodes[n.id])!.fill
  expect(fill).toContain('C')
  editor.undo(); expect(editor.state.doc).toEqual(before)
  editor.redo(); expect(kernelSvgPaths(editor.state.doc.nodes[n.id])!.fill).toBe(fill)
  expect(kernelBounds(editor.state.doc.nodes[n.id])!.height).toBeGreaterThan(0)
})
test('brush update invalidates geometry; bake is an explicit reversible edit', () => {
  const { editor, n, brush } = fixture()
  editor.updateProperties([n.id], n => { n.vectorBrush = brush }, 'Brush')
  const old = kernelSvgPaths(editor.state.doc.nodes[n.id])!.fill
  editor.updateProperties([n.id], n => { n.vectorBrush!.width = 30 }, 'Width')
  const changed = editor.state.doc.nodes[n.id], fill = kernelSvgPaths(changed)!.fill
  expect(fill).not.toBe(old)
  editor.updateProperties([n.id], n => { n.network = pathNetwork(fill); delete n.vectorBrush }, 'Bake brush')
  expect(editor.state.doc.nodes[n.id].vectorBrush).toBeUndefined()
  editor.undo(); expect(editor.state.doc.nodes[n.id].vectorBrush!.width).toBe(30)
})
test('finite parameters, seed range and network limits are enforced before serialization', () => {
  const { n, brush } = fixture(); n.vectorBrush = brush
  for (const seed of [-1, .5, 4294967296, NaN]) { n.vectorBrush = { ...brush, seed }; expect(() => validateVectorBrush(n)).toThrow() }
  n.vectorBrush = { ...brush, width: NaN }; expect(() => validateVectorBrush(n)).toThrow()
  n.vectorBrush = { ...brush, spacing: 0 }; expect(() => validateVectorBrush(n)).toThrow()
  n.vectorBrush = { ...brush, source: { ...brush.source, vertices: Array(4097).fill(brush.source.vertices[0]) } }; expect(() => validateVectorBrush(n)).toThrow()
})
test('unsupported curved Stretch and excessive scatter fail atomically', () => {
  const { editor, n, brush } = fixture()
  editor.updateProperties([n.id], n => { n.network = pathNetwork('M0 0C0 40 40 40 40 0') }, 'Curved guide')
  const before = editor.state.doc
  editor.updateProperties([n.id], n => { n.vectorBrush = { ...brush, mode: 'stretch' } }, 'Unsupported stretch')
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('Curved Stretch')
  editor.updateProperties([n.id], n => { n.vectorBrush = { ...brush, spacing: .001 } }, 'Too many stamps')
  expect(editor.state.doc).toBe(before)
  expect(editor.state.message).toContain('budget')
})
test('native WASM admission rejects embedded duplicate IDs and Sketch export cannot drop the brush', async () => {
  const { validate_document_json, export_sketch_json } = await import('./generated/design-kernel/design_kernel')
  const { editor, n, brush } = fixture()
  editor.updateProperties([n.id], n => { n.vectorBrush = brush }, 'Brush')
  const document = structuredClone(editor.state.doc)
  expect(() => validate_document_json(JSON.stringify(document))).not.toThrow()
  expect(() => export_sketch_json(JSON.stringify(document))).toThrow(/vector brush/)
  const edges = document.nodes[n.id].vectorBrush!.source.edges
  edges[1].id = edges[0].id
  expect(() => validate_document_json(JSON.stringify(document))).toThrow(/identifiers/)
})
test('closed curved WASM Scatter certifies station count or rejects unresolved seam ambiguity', () => {
  const { editor, n, brush } = fixture()
  editor.updateProperties([n.id], n => { n.network = pathNetwork('M0 0C0 100 100 100 100 0Z'); n.vectorBrush = { ...brush, spacing: 97 } }, 'Closed brush')
  expect(kernelSvgPaths(editor.state.doc.nodes[n.id])!.fill.match(/M/g)?.length).toBe(4)
  const before = editor.state.doc
  editor.updateProperties([n.id], n => { n.vectorBrush!.spacing = 100 }, 'Exact seam station')
  if (editor.state.doc === before) expect(editor.state.message).toContain('seam count is ambiguous')
  else expect(kernelSvgPaths(editor.state.doc.nodes[n.id])!.fill.match(/M/g)?.length).toBe(3)
})
