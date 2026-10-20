// Opt-in real Editor + Rust/WASM benchmark. No renderer, GPU, browser, or mocks.
// CPU_INCREMENTAL_BENCH=1 CPU_INCREMENTAL_REPORT=/absolute/report.json vitest run --config vitest.cpu-benchmark.config.ts
import { test, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { Editor } from './engine'
import { CanvasSceneSnapshots } from './canvas-scene-snapshots'
import { scene, SpatialIndex } from './geometry'
import { blank, node, type DesignDocument } from './model'

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
// These sentinels cannot occur in this deterministic fixture. Preserve explicit
// undefined fields and signed zero as well as authored property order/values.
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
  entry === undefined ? '__CPU_EXPLICIT_UNDEFINED__' :
  typeof entry === 'number' && Object.is(entry, -0) ? '__CPU_NEGATIVE_ZERO__' : entry)).digest('hex')
function fixture(count: number, version: DesignDocument['schemaVersion']) {
  const doc = blank('CPU incremental benchmark')
  doc.id = uuid(1); doc.pages[0].id = uuid(2); doc.schemaVersion = version
  for (let i = 0; i < count; i++) {
    const n = node('rectangle', (i % 100) * 40 + .125, Math.floor(i / 100) * 30 + .375, 20.25, 15.5)
    n.id = uuid(10 + i); n.fills[0].id = uuid(100010 + i)
    doc.nodes[n.id] = n; doc.pages[0].children.push(n.id)
  }
  return doc
}
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], samplesMs: values }
}

test.skipIf(process.env.CPU_INCREMENTAL_BENCH !== '1')('3k/10k authored edits and exact scene/history CPU comparison', () => {
  const rows: unknown[] = []
  for (const count of [3000, 10000]) for (const version of [2, 14] as const) for (const operation of ['rename', 'fill', 'translate'] as const) {
    const editor = new Editor(fixture(count, version)), store = new CanvasSceneSnapshots()
    try {
      editor.warmEditingHistory(editor.state.doc, editor.sessionGeneration)
      store.begin(editor, editor.sessionGeneration, editor.state.page, true)
      let prior = store.currentScene(editor.state.doc, editor.state.page); void prior.index
      const editTimes: number[] = [], sceneTimes: number[] = [], totalTimes: number[] = [], hashes: string[] = []
      let sceneBuilds = 0, indexBuilds = 0
      for (let i = 0; i < 12; i++) {
        const id = uuid(10 + (i * 97) % count), before = editor.state.doc
        const start = performance.now()
        const result = editor.change('Benchmark edit', draft => {
          if (operation === 'rename') draft.nodes[id].name = `Edit ${i}`
          if (operation === 'fill') draft.nodes[id].fills[0].color = i % 2 ? '#ff0022' : '#0044ff'
          if (operation === 'translate') draft.nodes[id].transform[4] += 1.125
        })
        const edited = performance.now(), current = store.currentScene(editor.state.doc, editor.state.page)
        const currentIndex = current.index, finished = performance.now()
        expect(result?.status).toBe('committed')
        if (i >= 3) {
          editTimes.push(edited - start); sceneTimes.push(finished - edited); totalTimes.push(finished - start)
          sceneBuilds += Number(current.entries !== prior.entries); indexBuilds += Number(currentIndex !== prior.index)
        }
        const after = editor.state.doc, afterHash = digest(after)
        hashes.push(afterHash)
        editor.undo(); expect(editor.state.doc).toBe(before)
        editor.redo(); expect(editor.state.doc).toBe(after); expect(digest(editor.state.doc)).toBe(afterHash)
        prior = current
      }
      // Separately count full node-sized Object.values enumerations; do not use
      // this instrumentation for the timings reported above.
      let nodeEnumerations = 0
      const values = Object.values
      Object.values = ((value: object) => {
        const result = values(value)
        if (result.length === count && result[0] && typeof result[0] === 'object' && 'transform' in result[0]) nodeEnumerations++
        return result
      }) as typeof Object.values
      try { editor.change('Counter edit', draft => { draft.nodes[uuid(10)].name = 'Counter edit' }) }
      finally { Object.values = values }
      const actual = store.currentScene(editor.state.doc, editor.state.page), expected = scene(editor.state.doc, editor.state.page)
      expect(actual.entries).toEqual(expected)
      const referenceIndex = new SpatialIndex(expected), queries = [{ x: 0, y: 0, width: 500, height: 500 }, { x: -1e30, y: -1e30, width: 2e30, height: 2e30 }]
      for (const query of queries) expect(actual.index.query(query)).toEqual(referenceIndex.query(query))
      rows.push({ count, schemaVersion: version, operation, edit: stats(editTimes), scene: stats(sceneTimes), total: stats(totalTimes), sceneBuilds, indexBuilds, countedNodeEnumerations: nodeEnumerations, hashes, finalDocument: digest(editor.state.doc), finalScene: digest(actual.entries) })
    } finally { editor.dispose() }
  }
  const report = { contract: 'Real Editor + WASM graph history + CPU geometry/index; 3 warmups, 9 measured edits; exact per-edit undo/redo identities, authored hashes and scene/query equivalence. No GPU/GUI or input-to-photon claim.', rows }
  if (process.env.CPU_INCREMENTAL_REPORT) writeFileSync(process.env.CPU_INCREMENTAL_REPORT, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}, 300_000)
