import { expect, test } from 'vitest'
import type { DesignDocument, DesignNode } from './model'
import { applyIslandLayout, layoutFlowIsland, sameChildOrder } from './layout-reorder-island'

function rect(id: string, width = 40): DesignNode {
  return { id, kind: 'rectangle', name: id, width, height: 20, transform: [1, 0, 0, 1, 0, 0], children: [], fills: [], strokes: [], effects: [] } as DesignNode
}
function frame(id: string, children: string[], layout: DesignNode['layout'], sizing?: DesignNode['sizing']): DesignNode {
  return { ...rect(id, 200), kind: 'frame', children, layout, sizing, fills: [] } as DesignNode
}
function document(nodes: DesignNode[], pageChildren: string[]): DesignDocument {
  return {
    id: 'd', name: 'd', schemaVersion: 1,
    pages: [{ id: 'p', name: 'p', children: pageChildren, background: '#ffffff' }],
    nodes: Object.fromEntries(nodes.map(node => [node.id, node])),
  } as DesignDocument
}
function parentsOf(doc: DesignDocument): Map<string, string> {
  const parents = new Map<string, string>()
  for (const page of doc.pages) for (const id of page.children) parents.set(id, page.id)
  for (const node of Object.values(doc.nodes)) for (const id of node.children) parents.set(id, node.id)
  return parents
}

test('an unchanged flow order is identical and a cold sibling stays outside the island', () => {
  const a = rect('a'), b = rect('b'), cold = rect('cold')
  const stack = frame('stack', [a.id, b.id], { mode: 'horizontal', gap: 8, lineGap: 0, padding: [0, 0, 0, 0] } as DesignNode['layout'])
  const doc = document([stack, a, b, cold], [stack.id, cold.id])
  expect(sameChildOrder(stack.children, [a.id, b.id])).toBe(true)
  expect(sameChildOrder(stack.children, [b.id, a.id])).toBe(false)
  const island = layoutFlowIsland(doc, parentsOf(doc), stack.id, [b.id, a.id])!
  expect(island.nodes[cold.id]).toBeUndefined()
  expect(island.pages[0].children).toEqual([stack.id])
  expect(island.nodes[stack.id].children).toEqual([b.id, a.id])
  expect(island.nodes[a.id]).toBe(a)
  const resolved = { ...island, nodes: { ...island.nodes, [b.id]: { ...b, transform: [1, 0, 0, 1, 48, 0] as DesignNode['transform'] } } }
  const merged = applyIslandLayout(doc, island, resolved)
  expect(merged.nodes[cold.id]).toBe(cold)
  expect(merged.nodes[a.id]).toBe(a)
  expect(merged.nodes[b.id].transform[4]).toBe(48)
  expect(merged.nodes[stack.id].children).toEqual([b.id, a.id])
})

test('a hug ancestor is the island root; a component, connector or text keeps the full document', () => {
  const a = rect('a', 40), b = rect('b', 80), c = rect('c', 40), tail = rect('tail')
  const horizontal = { mode: 'horizontal', wrap: true, gap: 0, lineGap: 0, padding: [0, 0, 0, 0] } as DesignNode['layout']
  const vertical = { mode: 'vertical', gap: 0, lineGap: 0, padding: [0, 0, 0, 0] } as DesignNode['layout']
  const hug = { width: 'fixed', height: 'hug' } as DesignNode['sizing']
  const stack = frame('stack', [a.id, b.id, c.id], horizontal, hug)
  stack.width = 100
  const outer = frame('outer', [stack.id, tail.id], vertical, hug)
  const cold = rect('cold')
  const doc = document([outer, stack, a, b, c, tail, cold], [outer.id, cold.id])
  const island = layoutFlowIsland(doc, parentsOf(doc), stack.id, [a.id, c.id, b.id])!
  expect(island.pages[0].children).toEqual([outer.id])
  expect(island.nodes[cold.id]).toBeUndefined()
  expect(Object.keys(island.nodes).sort()).toEqual([a.id, b.id, c.id, outer.id, stack.id, tail.id].sort())
  const component = document([{ ...stack, component: {} } as DesignNode, a, b, c], [stack.id])
  expect(layoutFlowIsland(component, parentsOf(component), stack.id, [c.id, a.id, b.id])).toBeUndefined()
  const wire = rect('wire')
  wire.connector = { from: { point: { x: 0, y: 0 }, nodeId: b.id, anchor: { x: 0, y: 0 } }, to: { point: { x: 1, y: 1 } }, style: 'straight' }
  const wired = document([outer, stack, a, b, c, tail, wire], [outer.id, wire.id])
  expect(layoutFlowIsland(wired, parentsOf(wired), stack.id, [a.id, c.id, b.id])).toBeUndefined()
  const label = rect('label')
  label.kind = 'text'
  const host = frame('host', [stack.id, label.id], { mode: 'horizontal', gap: 0, lineGap: 0, padding: [0, 0, 0, 0] } as DesignNode['layout'])
  const textDoc = document([host, stack, a, b, label], [host.id])
  expect(layoutFlowIsland(textDoc, parentsOf(textDoc), stack.id, [b.id, a.id])).toBeUndefined()
})
