import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Exercise production admission/aggregation with explicit scene entries. No
// generated geometry, browser, GPU, or rasterization is involved.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './geometry' && context.parentURL === new URL('./retained-board-preview.ts', import.meta.url).href)
      return { url: 'retained-test:geometry', shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (!/\.[cm]?[jt]sx?$/.test(url.pathname)) url.pathname += '.ts'
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'retained-test:geometry') return { format: 'module', shortCircuit: true, source: `
      export const scene = doc => doc.entries;
      export const intersects = (a,b) => a.x <= b.x+b.width && a.x+a.width >= b.x && a.y <= b.y+b.height && a.y+a.height >= b.y;
      export const unionBounds = boxes => {
        const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
        return { x, y, width: Math.max(...boxes.map(b => b.x+b.width))-x, height: Math.max(...boxes.map(b => b.y+b.height))-y };
      };` }
    if (url.startsWith('file:') && url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) }
    return next(url, context)
  },
})
const { retainedBoardPlan, retainedBoardOffset, retainedBoardTransformOffset } = await import('./retained-board-preview.ts')
hooks.deregister()
const identity = [1, 0, 0, 1, 0, 0]
const node = () => ({ visible: true, mask: false, opacity: 1, blend: 'normal', transform: identity, strokes: [], effects: [] })
function fixture() {
  const source = { pages: [{ id: 'p', children: ['board', 'other'] }], nodes: { board: node(), other: node() } }
  const plan = { id: 'board', source, matrix: identity, box: { x: 0, y: 0, width: 10, height: 10 },
    others: [{ x: 50, y: 0, width: 10, height: 10 }] }
  const moved = transform => ({ ...source, nodes: { ...source.nodes, board: { ...source.nodes.board, transform } } })
  return { source, plan, moved }
}
test('transform-only admission preserves exact offsets and rejects overlap, scaling, and nonfinite values', () => {
  const { plan } = fixture()
  assert.deepEqual(retainedBoardTransformOffset(plan, [1, 0, 0, 1, .25, -1.5]), { x: .25, y: -1.5 })
  for (const transform of [[1, 0, 0, 1, 40, 0], [2, 0, 0, 1, 0, 0], [1, 0, 0, 1, NaN, 0]])
    assert.equal(retainedBoardTransformOffset(plan, transform), null)
})
test('immutable source and transform-only pointer checks do not enumerate a 3000-node map', () => {
  const { source, plan } = fixture()
  for (let i = 0; i < 3000; i++) source.nodes[`other-${i}`] = node()
  let scans = 0
  source.nodes = new Proxy(source.nodes, { ownKeys(value) { scans++; return Reflect.ownKeys(value) } })
  assert.deepEqual(retainedBoardOffset(plan, source), { x: 0, y: 0 })
  for (let i = 0; i < 60; i++) retainedBoardTransformOffset(plan, [1, 0, 0, 1, -i, 0])
  assert.equal(scans, 0)
})
test('new snapshots revalidate all content and top-level rendering contracts', () => {
  const { source, plan, moved } = fixture()
  assert.deepEqual(retainedBoardOffset(plan, moved([1, 0, 0, 1, 1, 2])), { x: 1, y: 2 })
  assert.equal(retainedBoardOffset(plan, { ...source, rasterProfile: 'figma' }), null)
  const changed = moved([1, 0, 0, 1, 1, 2]); changed.nodes.other = { ...changed.nodes.other, opacity: .5 }
  assert.equal(retainedBoardOffset(plan, changed), null)
  const deleted = moved([1, 0, 0, 1, 1, 2]); delete deleted.nodes.board.effects
  assert.equal(retainedBoardOffset(plan, deleted), null)
})
test('3000-root capture warmup examines scene ancestry once per entry rather than roots × entries', () => {
  const nodes = {}, entries = [], children = []
  let ancestorReads = 0
  for (let i = 0; i < 3000; i++) {
    const id = `root-${i}`; nodes[id] = node(); children.push(id)
    entries.push({ id, matrix: identity, bounds: { x: i * 20, y: 0, width: 10, height: 10 },
      get ancestors() { ancestorReads++; return [] } })
  }
  const source = { nodes, entries, pages: [{ id: 'p', children }] }
  const plan = retainedBoardPlan(source, 'p', ['root-0'])
  assert.equal(plan.others.length, 2999)
  assert.equal(ancestorReads, 3000)
})
test('one-pass root aggregation retains descendant shadows and isolation rejection', () => {
  const { source } = fixture()
  source.nodes.child = { ...node(), effects: [{ visible: true, radius: 2, spread: 0, x: 0, y: 0 }] }
  source.entries = [
    { id: 'board', ancestors: [], matrix: identity, bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'child', ancestors: ['board'], matrix: identity, bounds: { x: 8, y: 0, width: 10, height: 10 } },
    { id: 'other', ancestors: [], matrix: identity, bounds: { x: 50, y: 0, width: 10, height: 10 } },
  ]
  assert.deepEqual(retainedBoardPlan(source, 'p', ['board']).box, { x: 0, y: -6, width: 24, height: 22 })
  source.entries[2].bounds.x = 23
  assert.equal(retainedBoardPlan(source, 'p', ['board']), null)
})
