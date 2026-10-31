/** Actual Editor/WASM CPU measurements; no rendering, GPU, socket or timing gates. */
import { expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { Editor } from '../engine'
import { blank, node } from '../model'
import { createEditorDesignAutomation } from './index'

it('measures compact bulk edits and equivalent batches on the actual Editor', () => {
  const document = blank('Bulk CPU workload')
  for (let i = 0; i < 1000; i++) {
    const n = node('rectangle', i % 50 * 25, Math.floor(i / 50) * 25, 20, 20)
    n.name = `Tile ${i}`; document.nodes[n.id] = n; document.pages[0].children.push(n.id)
  }
  const records = []
  for (const method of ['node.patchMany', 'batch.apply']) {
    const start = performance.now(), editor = new Editor(structuredClone(document)), initializationMs = performance.now() - start
    const api = createEditorDesignAutomation(editor), editMs: number[] = [], undoMs: number[] = []
    try {
      let requestBytes = 0
      for (let run = 0; run < 3; run++) {
        const before = editor.state.doc
        const targets = document.pages[0].children.slice(0, 100).map((nodeId, i) => ({ nodeId,
          patch: { name: `Changed ${run}/${i}`, width: 21 + run }, expected: { name: before.nodes[nodeId].name, width: 20 } }))
        const params = method === 'node.patchMany' ? { targets } : { operations: targets.map(({ nodeId, ...rest }) => ({ method: 'node.patch', params: { ids: [nodeId], ...rest } })) }
        const request = { method, params, documentId: before.id, session: editor.sessionGeneration, expectedRevision: editor.state.version }
        requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength
        const begin = performance.now(), response = api.execute(request); editMs.push(performance.now() - begin)
        expect(response.ok, JSON.stringify(response)).toBe(true)
        expect(editor.state.version).toBe(request.expectedRevision + 1)
        expect(editor.state.doc.nodes[targets[99].nodeId].name).toBe(`Changed ${run}/99`)
        const undoBegin = performance.now(); editor.undo('automation'); undoMs.push(performance.now() - undoBegin)
        expect(editor.state.doc).toEqual(before); expect(editor.canUndo).toBe(false)
      }
      records.push({ method, initializationMs, requestBytes, editMs, undoMs, historyBackend: editor.historyBackend })
    } finally { api.dispose(); editor.dispose() }
  }
  const evidence = { nodes: 1000, targets: 100, samples: 3, records,
    scope: 'Actual Editor and WASM CPU workload; excludes rendering, GPU, transport, and cross-machine latency claims.' }
  console.log('BULK_CPU_BENCHMARK', JSON.stringify(evidence))
  if (process.env.BULK_CPU_REPORT) writeFileSync(process.env.BULK_CPU_REPORT, JSON.stringify(evidence, null, 2))
}, 120000)
