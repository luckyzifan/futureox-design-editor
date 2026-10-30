import { expect, test } from 'vitest'
import { admitDocumentSync } from './document-admission'
import { Editor } from './engine'
import { scene, SpatialIndex, type SceneEntry } from './geometry'
import { blank, identity, node, type Bounds } from './model'

const cellSize = 256
const unsafeOrigin = 2 ** 54 * cellSize
const box = (x = 0, y = 0, width = 0, height = 0): Bounds => ({ x, y, width, height })
function entry(id: string, bounds: Bounds, hitBounds?: Bounds): SceneEntry {
  return { id, parent: 'page', matrix: identity(), bounds, hitBounds, depth: 0, ancestors: [], locked: false }
}
function linear(entries: SceneEntry[], query: Bounds) {
  return entries.filter((e) => {
    const b = e.hitBounds || e.bounds
    return b.x <= query.x + query.width && b.x + b.width >= query.x &&
      b.y <= query.y + query.height && b.y + b.height >= query.y
  })
}

test.each([
  [unsafeOrigin, 0],
  [-unsafeOrigin, 0],
  [0, unsafeOrigin],
  [0, -unsafeOrigin],
])('arithmetic regression: one unsafe cell at (%s, %s) remains queryable', (x, y) => {
  const coordinate = (x || y) / cellSize
  expect(Number.isFinite(coordinate)).toBe(true)
  expect(coordinate + 1).toBe(coordinate)
  const target = box(x, y)
  const first = entry('first', target), second = entry('second', target)
  const entries = [first, entry('near', box(10, 10, 2, 2)), second]
  const index = new SpatialIndex(entries)
  expect(index.query(target)).toEqual([first, second])
  expect(index.query(box(10, 10))).toEqual([entries[1]])
})

test.each([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER + 1])(
  'safe boundary cell %s retains exact point addressing', (cell) => {
    const target = box(cell * cellSize, -cell * cellSize)
    const e = entry('boundary', target)
    const index = new SpatialIndex([e])
    expect(index.query(target)).toEqual([e])
    expect(index.query(box(target.x + cellSize * 4, target.y))).toEqual([])
  },
)

test('small ranges ending at the safe integer boundary remain indexed without stalling', () => {
  const end = Number.MAX_SAFE_INTEGER
  const target = box((end - 1) * cellSize, -end * cellSize, cellSize, cellSize)
  const e = entry('boundary-range', target)
  const index = new SpatialIndex([e])
  expect(index.query(box(end * cellSize, (-end + 1) * cellSize))).toEqual([e])
  expect(index.query(target)).toEqual([e])
})

test('grid and large-entry paths preserve hit bounds, deduplication and scene order', () => {
  const entries = [
    entry('large-first', box(-cellSize * 300, -cellSize * 300, cellSize * 600, cellSize * 600)),
    entry('hit-proxy', box(10000, 10000, 10, 10), box(-20, -20, 40, 40)),
    entry('negative', box(-cellSize - 1, -cellSize - 1, cellSize * 2, cellSize * 2)),
    entry('grid-last', box(0, 0, cellSize, cellSize)),
  ]
  const index = new SpatialIndex(entries)
  for (const query of [box(), box(-cellSize, -cellSize), box(10000, 10000),
    box(-cellSize * 100, -cellSize * 100, cellSize * 200, cellSize * 200)])
    expect(index.query(query)).toEqual(linear(entries, query))
  expect(index.query(box()).map((e) => e.id)).toEqual(entries.map((e) => e.id))
})

test('entry and query cell budgets retain results on both sides of their thresholds', () => {
  const entries = [
    entry('256-cells', box(0, 0, cellSize * 15, cellSize * 15)),
    entry('272-cells', box(0, 0, cellSize * 16, cellSize * 15)),
    entry('257-cells', box(0, 0, cellSize * 256, 0)),
  ]
  const index = new SpatialIndex(entries)
  for (const query of [box(), box(0, 0, cellSize * 63, cellSize * 63),
    box(0, 0, cellSize * 64, cellSize * 63), box(0, 0, cellSize * 4096, 0)])
    expect(index.query(query)).toEqual(entries)
})

test('huge spans and finite endpoint overflow fall back without losing intersecting entries', () => {
  const edge = Number.MAX_SAFE_INTEGER * cellSize
  const spanning = box(-edge, -edge, edge * 2, edge * 2)
  const overflow = box(Number.MAX_VALUE, 0, Number.MAX_VALUE, 1)
  expect(Number.isFinite(overflow.width)).toBe(true)
  expect(overflow.x + overflow.width).toBe(Infinity)
  const entries = [entry('huge', spanning), entry('near', box()), entry('overflow', overflow)]
  const index = new SpatialIndex(entries)
  for (const query of [spanning, overflow, box(), box(Number.MAX_VALUE, 0)])
    expect(index.query(query)).toEqual(linear(entries, query))
  expect(index.query(box())).toEqual(entries.slice(0, 2))
  expect(index.query(overflow)).toEqual([entries[2]])
})

test('nonfinite and reversed bounds use the existing linear intersection semantics', () => {
  const unusual = [
    box(Infinity, 0), box(-Infinity, 0), box(NaN, 0),
    box(0, Infinity), box(0, -Infinity), box(0, NaN),
    box(0, 0, Infinity, 1), box(0, 0, 1, Infinity),
    box(0, 0, NaN, 1), box(0, 0, 1, NaN),
    box(cellSize * 2, 0, -cellSize * 2, 1),
    box(0, cellSize * 2, 1, -cellSize * 2),
  ]
  const entries = [entry('near', box()), ...unusual.map((b, i) => entry(`unusual-${i}`, b))]
  const index = new SpatialIndex(entries)
  for (const query of [box(), box(0, 0, cellSize * 2, cellSize * 2), ...unusual])
    expect(index.query(query)).toEqual(linear(entries, query))
})

test('rebuilding scene snapshots handles insertion, moves and removal across fallback cells', () => {
  const near = entry('moving', box(10, 10, 1, 1))
  const far = entry('moving', box(unsafeOrigin, -unsafeOrigin))
  const huge = entry('moving', box(-unsafeOrigin, -unsafeOrigin, unsafeOrigin * 2, unsafeOrigin * 2))
  const stationary = entry('stationary', box(20, 20, 1, 1))
  const snapshots = [[], [near, stationary], [far, stationary], [huge, stationary],
    [near, stationary], [stationary], []]
  for (const entries of snapshots) {
    const index = new SpatialIndex(entries)
    for (const query of [box(10, 10), box(20, 20), box(unsafeOrigin, -unsafeOrigin),
      box(-unsafeOrigin, -unsafeOrigin, unsafeOrigin * 2, unsafeOrigin * 2)])
      expect(index.query(query)).toEqual(linear(entries, query))
  }
})

test.each([-1, 1])('canonical-valid nested transforms retain a finite far-away leaf (sign %s)', (sign) => {
  const doc = blank()
  const groups = [...Array.from({ length: 3 }, () => 1e7),
    ...Array.from({ length: 6 }, () => 1e-4)].map((scale, i) => {
    const group = node('group', 0, 0, 1, 1)
    group.transform = [scale, 0, 0, scale, i < 3 ? sign * 1e7 : 0, i < 3 ? -sign * 1e7 : 0]
    group.fills = []
    return group
  })
  const leaf = node('rectangle', 0, 0, 1, 1)
  const nodes = [...groups, leaf]
  for (let i = 0; i < nodes.length; i++) {
    if (i + 1 < nodes.length) nodes[i].children = [nodes[i + 1].id]
    doc.nodes[nodes[i].id] = nodes[i]
  }
  doc.pages[0].children = [groups[0].id]
  // The real CPU WASM admission validates authored transforms and hierarchy.
  // Rendering has a separate precision budget; it must not be needed to stop a
  // synchronous scene-index loop during document adoption or pointer handling.
  const admitted = admitDocumentSync(doc)
  const entries = scene(admitted, admitted.pages[0].id)
  const leafEntry = entries.find((e) => e.id === leaf.id)!
  expect(leafEntry.matrix.every(Number.isFinite)).toBe(true)
  expect(leafEntry.bounds.width).toBe(0)
  expect(leafEntry.bounds.height).toBe(0)
  const cell = Math.floor(leafEntry.bounds.x / cellSize)
  expect(Number.isSafeInteger(cell)).toBe(false)
  expect(cell + 1).toBe(cell)
  const index = new SpatialIndex(entries)
  expect(index.query(leafEntry.bounds)).toEqual(linear(entries, leafEntry.bounds))
  expect(index.query(leafEntry.bounds)).toContain(leafEntry)
  expect(new Editor(admitted).hit({ x: 0, y: 0 })).toBe(null)
})
