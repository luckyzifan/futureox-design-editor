import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, expect, test, vi } from '../../frontend/design-client/node_modules/vitest/dist/index.js'
import { kernelLayout } from '../../frontend/design-client/src/kernel/picking'
import { translationOnlyChanges } from '../../frontend/design-client/src/kernel/translation-preview'
import { VectorEngine } from '../../frontend/design-client/src/generated/design-kernel/design_kernel'
import { Editor } from '../../frontend/design-client/src/engine'
import { setNodePosition } from '../../frontend/design-client/src/selection-properties'
import type { DesignDocument, Matrix } from '../../frontend/design-client/src/model'

afterEach(() => vi.restoreAllMocks())
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fixture(): DesignDocument {
  const path = process.env.FIG_LAYOUT_BEFORE
  if (!path) throw Error('FIG_LAYOUT_BEFORE must name the actual fully rehydrated 19,959-node SQLite revision; no substitute/skip')
  return JSON.parse(readFileSync(path, 'utf8'))
}
function differences(a: DesignDocument, b: DesignDocument) {
  const result: string[] = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (key !== 'nodes' && !isDeepStrictEqual(a[key as keyof DesignDocument], b[key as keyof DesignDocument])) result.push(key)
  for (const key of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    if (isDeepStrictEqual(a.nodes[key], b.nodes[key])) continue
    const fields = new Set([...Object.keys(a.nodes[key] || {}), ...Object.keys(b.nodes[key] || {})])
    for (const field of fields) if (!isDeepStrictEqual((a.nodes[key] as unknown as Record<string, unknown>)?.[field], (b.nodes[key] as unknown as Record<string, unknown>)?.[field])) result.push(`nodes/${key}/${field}`)
  }
  return result
}
test('complete actual FIG: forced full WASM versus constrained translation, repeated absolute poses and undo/redo', () => {
  const before = fixture()
  expect(Object.keys(before.nodes)).toHaveLength(19959)
  // Imports mint IDs; require the exact selected target from that run rather
  // than choosing the first duplicate layer with the same authored name.
  const id = process.env.FIG_LAYOUT_TARGET ?? 'dd342d13-8d8d-424f-ae78-1efe393d8cc5'
  expect(before.nodes[id]?.kind).toBe('text')
  expect(before.nodes[id]?.name).toBe('Whooops, that page i')
  expect(before.nodes[id].transform).toEqual([1, 0, 0, 1, 75.85958862304688, 0])
  expect(before.nodes[id].constraints).toEqual({ horizontal: 'scale', vertical: 'center', referenceWidth: 584, referenceHeight: 166 })
  const baselineHash = digest(before)
  const resolve = vi.spyOn(VectorEngine.prototype, 'resolve_components')
  const positions = [[99.86, 0], [75.85958862304688, 24], [101.125, 17.5], [-12.25, 8], [99.86, 0]]
  let after: DesignDocument | undefined
  for (const [x, y] of positions) {
    const candidate: DesignDocument = { ...before, nodes: { ...before.nodes,
      [id]: { ...before.nodes[id], transform: [...before.nodes[id].transform.slice(0, 4), x, y] as Matrix } } }
    expect(translationOnlyChanges(before, candidate)).toEqual([id])
    resolve.mockClear()
    const fast = kernelLayout(candidate, before)
    expect(resolve).not.toHaveBeenCalled()
    const full = kernelLayout(candidate) // No previous: mandatory full WASM oracle over every real node/resource.
    expect(resolve).toHaveBeenCalledOnce()
    expect(differences(fast, full)).toEqual([])
    expect(digest(fast)).toBe(digest(full))
    expect(differences(kernelLayout(fast, fast), full)).toEqual([])
    expect(differences(kernelLayout(before, fast), kernelLayout(before))).toEqual([])
    expect(digest(before)).toBe(baselineHash)
    after = fast
  }
  const editor = new Editor(before)
  try {
    expect(differences(editor.state.doc, before)).toEqual([])
    const editorBefore = editor.state.doc
    // Exact actual Inspector mutation entry: this also runs component cleanup.
    // A semantic-only assertion missed its former unconditional component
    // clones, which silently rejected translation admission in Electron.
    resolve.mockClear()
    editor.updateProperties([id], node => { setNodePosition(node, 'x', 99.86, editor.state.doc) })
    expect(resolve).not.toHaveBeenCalled()
    expect(differences(editor.state.doc, after!)).toEqual([])
    const properties = editor.state.doc
    for (const node of Object.values(editorBefore.nodes).filter(node => node.component)) {
      expect(properties.nodes[node.id]).toBe(editorBefore.nodes[node.id])
      expect(properties.nodes[node.id].component).toBe(node.component)
    }
    editor.undo(); expect(differences(editor.state.doc, before)).toEqual([])
    editor.redo(); expect(differences(editor.state.doc, after!)).toEqual([])
    editor.undo()
    resolve.mockClear()
    editor.change('actual constrained FIG X', document => { document.nodes[id].transform[4] = 99.86 })
    expect(resolve).not.toHaveBeenCalled()
    expect(differences(editor.state.doc, after!)).toEqual([])
    editor.undo(); expect(differences(editor.state.doc, before)).toEqual([])
    expect(digest(editor.state.doc)).toBe(baselineHash)
    editor.redo(); expect(differences(editor.state.doc, after!)).toEqual([])
  } finally { editor.dispose() }
})
