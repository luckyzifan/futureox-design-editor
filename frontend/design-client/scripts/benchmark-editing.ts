import { blank, node } from '../src/model'
import { shareDocument, documentPatch } from '../src/document-patch'
for (const count of [1000, 10000]) {
  const doc = blank()
  for (let i = 0; i < count; i++) {
    const n = node('rectangle', i % 100, Math.floor(i / 100))
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
  }
  const id = doc.pages[0].children[0],
    results = []
  for (const mode of ['full-json', 'shared-patch', 'sparse-patch']) {
    const samples = []
    let bytes = 0,
      shared = 0
    for (let i = 0; i < 12; i++) {
      const start = performance.now(),
        draft =
          mode === 'sparse-patch'
            ? { ...doc, nodes: { ...doc.nodes, [id]: structuredClone(doc.nodes[id]) } }
            : structuredClone(doc)
      draft.nodes[id].opacity = 0.5
      if (mode === 'full-json') {
        const before = JSON.stringify(doc),
          after = JSON.stringify(draft)
        if (before === after) throw new Error('edit missing')
        bytes = after.length
      } else {
        const after = shareDocument(doc, draft)
        bytes = JSON.stringify(documentPatch(doc, after)).length
        shared = Object.keys(doc.nodes).filter((key) => doc.nodes[key] === after.nodes[key]).length
      }
      if (i >= 2) samples.push(performance.now() - start)
    }
    samples.sort((a, b) => a - b)
    results.push({
      mode,
      medianMs: samples[5],
      p95Ms: samples.at(-1),
      serializedBytes: bytes,
      sharedNodes: shared,
    })
  }
  console.log(
    JSON.stringify({
      nodes: count,
      scope:
        'clone + no-op/diff detection + serialization; excludes Rust/layout/rendering and browser input',
      results,
    }),
  )
}
