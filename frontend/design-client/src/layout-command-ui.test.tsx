import React from 'react'
import { expect, test } from 'vitest'
import { Editor } from './engine'
import { LayoutPanel } from './LayoutPanel'
import { blank, defaultLayout, node } from './model'
function find(tree: any, predicate: (v: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return
  if (predicate(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) { const found = find(child, predicate); if (found) return found }
}
function panel(e: Editor, id: string, ids = [id]) {
  const slots: any[] = []; let cursor = 0
  const hooks = { useSyncExternalStore(_subscribe: unknown, snapshot: () => unknown) { return snapshot() },
    useState(initial: any) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v: any) => slots[i] = v] } }
  return () => {
    cursor = 0
    const internals = (React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE, old = internals.H
    internals.H = hooks
    try { return LayoutPanel({ editor: e, node: e.state.doc.nodes[id], ids }) } finally { internals.H = old }
  }
}
test.each(['target', 'ancestor', 'child', 'mixed'] as const)('LayoutPanel in-place properties permit locked %s while multiwrap remains strict', lock => {
  const doc = blank(), outer = node('frame', 0, 0, 500, 400), frame = node('frame', 0, 0, 200, 100), child = node('rectangle', 10, 10, 20, 20), other = node('frame', 300, 0, 100, 100)
  frame.layout = defaultLayout(); frame.children = [child.id]; outer.children = [frame.id, other.id]
  doc.pages[0].children = [outer.id]
  for (const n of [outer, frame, child, other]) doc.nodes[n.id] = n
  doc.nodes[lock === 'ancestor' ? outer.id : lock === 'child' ? child.id : lock === 'mixed' ? other.id : frame.id].locked = true
  const e = new Editor(doc), ids = lock === 'mixed' ? [frame.id, other.id] : [frame.id], render = panel(e, frame.id, ids)
  try {
    e.select(ids); const before = e.state.doc
    find(render(), v => v.type === 'button' && v.props.title === '移除自动布局').props.onClick()
    expect(e.state.doc.nodes[frame.id].layout).toBeUndefined(); expect(e.state.version).toBe(1)
    const removed = e.state.doc
    find(render(), v => v.type === 'button' && v.props['aria-label'] === '网格布局').props.onClick()
    if (lock === 'mixed') {
      expect(e.state.doc).toBe(removed); expect(e.state.version).toBe(1)
      expect(find(render(), v => v.props?.role === 'alert')).toBeDefined()
    } else {
      expect(e.state.doc.nodes[frame.id].layout?.mode).toBe('grid'); expect(e.state.version).toBe(2)
      e.undo(); expect(e.state.doc).toEqual(removed)
    }
    e.undo(); expect(e.state.doc).toEqual(before)
    for (const id of [outer.id, frame.id, child.id, other.id]) expect(e.state.doc.nodes[id].locked).toBe(before.nodes[id].locked)
  } finally { e.dispose() }
})
test('LayoutPanel explicit direction and remove use native history; infer remains a separate strategy', () => {
  const doc = blank(), frame = node('frame', 0, 0, 300, 100), child = node('rectangle', 10, 10, 20, 20)
  frame.children = [child.id]; doc.nodes = { [frame.id]: frame, [child.id]: child }; doc.pages[0].children = [frame.id]
  const e = new Editor(doc), render = panel(e, frame.id)
  try {
    e.select([frame.id]); const before = e.state.doc
    find(render(), v => v.type === 'button' && v.props['aria-label'] === '纵向布局').props.onClick()
    expect(e.state.doc.nodes[frame.id].layout?.mode).toBe('vertical'); expect(e.state.version).toBe(1)
    find(render(), v => v.type === 'button' && v.props.title === '移除自动布局').props.onClick()
    expect(e.state.doc.nodes[frame.id].layout).toBeUndefined(); expect(e.state.version).toBe(2)
    e.undo(); e.undo(); expect(e.state.doc).toEqual(before)
  } finally { e.dispose() }
})
