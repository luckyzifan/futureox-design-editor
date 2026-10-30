import { blank, node } from '../src/model'
import { scene, SpatialIndex } from '../src/geometry'
for (const count of [1000, 10000]) {
  const doc = blank()
  for (let i = 0; i < count; i++) {
    const n = node(
      i % 3 ? 'rectangle' : 'ellipse',
      (i % 100) * 120,
      Math.floor(i / 100) * 100,
      80,
      70,
    )
    doc.nodes[n.id] = n
    doc.pages[0].children.push(n.id)
  }
  const sceneTimes: number[] = [],
    queryTimes: number[] = []
  let hits = 0
  for (let i = 0; i < 25; i++) {
    const start = performance.now(),
      entries = scene(doc, doc.pages[0].id),
      index = new SpatialIndex(entries)
    sceneTimes.push(performance.now() - start)
    const queryStart = performance.now()
    for (let j = 0; j < 100; j++)
      hits += index.query({ x: j * 111, y: (i % 10) * 90, width: 100, height: 100 }).length
    queryTimes.push((performance.now() - queryStart) / 100)
  }
  const p95 = (ns: number[]) => ns.sort((a, b) => a - b)[Math.floor(ns.length * 0.95)].toFixed(3)
  console.log(
    JSON.stringify({
      nodes: count,
      sceneAndIndexP95Ms: p95(sceneTimes),
      queryP95Ms: p95(queryTimes),
      hits,
      scope: 'CPU scene + spatial index only; not browser frame rate',
    }),
  )
}
