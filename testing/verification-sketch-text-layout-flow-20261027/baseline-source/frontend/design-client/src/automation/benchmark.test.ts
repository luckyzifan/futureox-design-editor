/** CPU/API workload evidence, not a renderer or frame-rate benchmark. */
import { expect, it } from 'vitest'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'
it('records a real 3000-node bounded-context and atomic-edit workload', () => {
  const document = blank('Automation workload'), roots = document.pages[0].children
  for (let i = 0; i < 3000; i++) {
    const n = node('rectangle', (i % 100) * 24, Math.floor(i / 100) * 24, 20, 20)
    n.name = `Tile ${i}`; document.nodes[n.id] = n; roots.push(n.id)
  }
  const start = performance.now(), editor = new Editor(document), initializationMs = performance.now() - start
  const api = createEditorDesignAutomation(editor), contextMs: number[] = [], editMs: number[] = []
  try {
    let contextBytes = 0
    for (let run = 0; run < 3; run++) {
      const begin = performance.now(), result = api.execute({ method: 'context.get', params: { limit: 20, maxDepth: 1 } })
      contextMs.push(performance.now() - begin)
      expect(result.ok).toBe(true)
      if (result.ok) { const context = result.result as { nodes: unknown[] }; expect(context.nodes).toHaveLength(20); contextBytes = new TextEncoder().encode(JSON.stringify(context)).byteLength }
    }
    for (let run = 0; run < 3; run++) {
      const version = editor.state.version, begin = performance.now()
      const result = api.execute({ method: 'batch.apply', documentId: editor.state.doc.id, session: editor.sessionGeneration,
        expectedRevision: version, params: { operations: roots.slice(0, 20).map((id, index) => ({ method: 'node.update', params: { ids: [id], patch: { name: `Batch ${run} / ${index}` } } })) } })
      editMs.push(performance.now() - begin)
      expect(result.ok, JSON.stringify(result)).toBe(true); expect(editor.state.version).toBe(version + 1)
    }
    console.log('AUTOMATION_BENCHMARK', JSON.stringify({ nodes: 3000, returnedContextNodes: 20, contextBytes, batchOperations: 20,
      samples: 3, initializationMs, contextMs, editMs, historyBackend: editor.historyBackend,
      scope: 'Single-machine CPU API measurements using actual Editor and WASM; excludes render and network transport; no hardware-independent latency guarantee.' }))
  } finally { api.dispose(); editor.dispose() }
}, 60000)
