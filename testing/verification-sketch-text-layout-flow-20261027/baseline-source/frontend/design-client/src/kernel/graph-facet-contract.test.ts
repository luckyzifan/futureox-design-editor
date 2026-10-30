import { expect, test } from 'vitest'
import { blank, node } from '../model'
import { Graph } from './graph'

function fixture() {
  const document = blank(), frame = node('frame')
  document.nodes[frame.id] = frame
  document.pages[0].children = [frame.id]
  const graph = Graph.open(JSON.stringify(document))
  return { graph, handle: graph.handle(frame.id), frame }
}

test('strict WASM edits and document replacements retain source and atomic history',()=>{
  const {graph,handle}=fixture()
  try {
    expect(()=>graph.api.set_name(handle,'unscoped')).toThrow(/scope/)
    graph.setName(handle,'user');expect(JSON.parse(graph.api.last_edit_scope_json()).source).toBe('user')
    const edited=JSON.parse(graph.documentJson());edited.name='from plugin'
    graph.replaceDocument(JSON.stringify(edited),{source:'plugin',ignoreUndoRedo:true})
    expect(JSON.parse(graph.api.last_edit_scope_json())).toMatchObject({source:'plugin',ignoreUndoRedo:true})
    expect(graph.undoDepth()).toBe(1)
    const before=graph.documentJson()
    expect(()=>graph.replaceDocument('{bad',{source:'ai'})).toThrow()
    expect(graph.documentJson()).toBe(before)
    expect(JSON.parse(graph.api.last_edit_scope_json()).source).toBe('plugin')
    graph.scale(handle,2);expect(JSON.parse(graph.api.last_edit_scope_json()).source).toBe('user')
    expect(()=>graph.scale(handle,-1)).toThrow()
    expect(()=>graph.api.set_name(handle,'still unscoped')).toThrow(/scope/)
    const bytes=graph.exportBinary();graph.importBinary(bytes,{source:'system'})
    expect(JSON.parse(graph.api.last_edit_scope_json()).source).toBe('system')
  } finally {graph.free()}
})

test('shared WASM Facet capabilities distinguish absent editable values and read-only summaries', () => {
  const { graph, handle } = fixture()
  try {
    expect(graph.facetCapabilities(handle)).toContainEqual({ kind: 'effects', access: 'readOnly', present: false })
    expect(graph.facetCapabilities(handle)).toContainEqual({ kind: 'stack', access: 'readWrite', present: false })
    graph.applyFacet(handle, 'stack', { kind: 'stack', horizontal: true, grid: false, gap: 12, padding: [8, 8, 8, 8] })
    expect(graph.facetCapabilities(handle)).toContainEqual({ kind: 'stack', access: 'readWrite', present: true })
    expect(graph.undoDepth()).toBe(1)
    graph.undo()
    expect(graph.facetCapabilities(handle)).toContainEqual({ kind: 'stack', access: 'readWrite', present: false })
  } finally { graph.free() }
})

test('camelCase Facet fields survive the actual TypeScript to Rust boundary', () => {
  const { graph, handle } = fixture()
  try {
    graph.applyFacet(handle, 'frame', { kind: 'frame', width: 200, height: 100, cornerRadius: 7 })
    expect(graph.facet(handle, 'frame')).toEqual({ kind: 'frame', width: 200, height: 100, cornerRadius: 7 })
    graph.undo(); graph.redo()
    expect(graph.facet(handle, 'frame')).toEqual({ kind: 'frame', width: 200, height: 100, cornerRadius: 7 })
  } finally { graph.free() }
})

test('read-only, mismatched and invalid Facet writes leave document and history unchanged', () => {
  const { graph, handle } = fixture()
  try {
    const before = graph.documentJson()
    for (const [kind, payload] of [
      ['effects', { kind: 'effects', count: 0 }],
      ['frame', { kind: 'transform', matrix: [1, 0, 0, 1, 20, 20] }],
      ['frame', { kind: 'frame', width: -100, height: 100, cornerRadius: 0 }],
    ] as const) {
      expect(() => graph.api.apply_facet_json(handle, kind, JSON.stringify(payload))).toThrow()
      expect(graph.documentJson()).toBe(before)
      expect(graph.undoDepth()).toBe(0)
      expect(graph.redoDepth()).toBe(0)
    }
  } finally { graph.free() }
})
