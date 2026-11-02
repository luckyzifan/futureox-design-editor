import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { apply, worldMatrix } from './geometry'
import { blank, node, uid } from './model'
import { componentFixture, originNode } from './component-fixtures'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture() {
  const document = blank(), outer = node('frame', 80, 90, 420, 300), group = node('group', 15, 20, 330, 200),
    inner = node('frame', 10, 10, 250, 150), a = node('rectangle', 10, 10, 40, 40),
    b = node('ellipse', 75, 10, 40, 40), hidden = node('rectangle', 140, 10, 40, 40),
    locked = node('rectangle', 190, 10, 40, 40), outside = node('rectangle', 650, 100, 40, 40)
  hidden.visible = false; locked.locked = true
  outer.children = [group.id]; group.children = [inner.id]; inner.children = [a.id, b.id, hidden.id, locked.id]
  for (const n of [outer, group, inner, a, b, hidden, locked, outside]) document.nodes[n.id] = n
  document.pages[0].children = [outer.id, outside.id]
  const editor = new Editor(document); editors.push(editor)
  const point = (id: string) => apply(worldMatrix(editor.state.doc, id), { x: 20, y: 20 })
  return { editor, outer, group, inner, a, b, hidden, locked, outside, point }
}

test('single click respects unentered frame/group ancestry; repeated clicks do not drill into the selected container', () => {
  const { editor, outer, group, inner, a, b, point } = fixture()
  const p = point(a.id)
  expect(editor.hit(p)).toBe(outer.id)
  expect(editor.selectionHit(p)).toBe(outer.id)
  expect(editor.selectionHit(p, true)).toBe(a.id)
  editor.select([outer.id]); expect(editor.hit(p)).toBe(outer.id)
  editor.select([group.id]); expect(editor.hit(p)).toBe(group.id)
  editor.select([inner.id]); expect(editor.hit(p)).toBe(inner.id)
  editor.select([a.id]); expect(editor.hit(point(b.id))).toBe(b.id)
  editor.select([]); expect(editor.hit(p, true)).toBe(a.id)
})

test('double click enters exactly one selected ancestor at a time and identifies an already selected leaf', () => {
  const { editor, outer, group, inner, a, point } = fixture()
  editor.select([outer.id])
  for (const id of [group.id, inner.id, a.id]) {
    expect(editor.selectDeeper(point(a.id))).toEqual({ id, changed: true })
    expect(editor.state.selection).toEqual([id])
  }
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: a.id, changed: false })
  expect(editor.state.tool).toBe('select')
})

test('Enter selects visible unlocked direct children, Shift+Enter deduplicates their parent, roots stay selected', () => {
  const { editor, outer, group, inner, a, b } = fixture()
  editor.select([outer.id]); expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([group.id])
  expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([b.id, a.id])
  expect(editor.selectParent()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  editor.select([outer.id]); expect(editor.selectParent()).toBe(false); expect(editor.state.selection).toEqual([outer.id])
})

test('sibling navigation follows visible Layers order, skips hidden/locked layers and does not edit history', () => {
  const { editor, a, b, outer, outside } = fixture()
  const original = editor.state.doc, version = editor.state.version
  editor.select([b.id]); expect(editor.selectSibling(1)).toBe(true); expect(editor.state.selection).toEqual([a.id])
  expect(editor.selectSibling(-1)).toBe(true); expect(editor.state.selection).toEqual([b.id])
  editor.select([outside.id]); editor.selectSibling(1); expect(editor.state.selection).toEqual([outer.id])
  editor.selectSibling(1); expect(editor.state.selection).toEqual([outside.id])
  expect(editor.state.doc).toBe(original); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
})

test('multi-container child and parent navigation stays on the active page and ordinary Esc clearing is UI-only', () => {
  const { editor, outer, group, outside } = fixture()
  editor.select([outer.id, outside.id]); editor.selectChildren()
  expect(editor.state.selection).toEqual([group.id, outside.id])
  editor.selectParent(); expect(editor.state.selection).toEqual([outer.id, outside.id])
  editor.clearSelection(); expect(editor.state.selection).toEqual([]); expect(editor.canUndo).toBe(false)
})

test('inherited lock blocks navigation and canvas hover; layer hover can identify a locked layer', () => {
  const { editor, inner, a, locked, hidden } = fixture()
  editor.hoverLayer(locked.id, 'canvas'); expect(editor.state.hover).toBeNull()
  editor.hoverLayer(locked.id, 'layers'); expect(editor.state.hover).toBe(locked.id)
  editor.hoverLayer(hidden.id, 'layers'); expect(editor.state.hover).toBeNull()
  editor.update([inner.id], { locked: true }, '切换锁定')
  editor.select([inner.id]); expect(editor.selectChildren()).toBe(false)
  editor.select([a.id]); expect(editor.selectSibling(1)).toBe(false)
})

test('hover ownership cannot erase a new panel hover and never mutates or persists document state', () => {
  const { editor, a, b } = fixture()
  const original = editor.state.doc, version = editor.state.version
  editor.hoverLayer(a.id, 'canvas'); editor.hoverLayer(b.id, 'layers'); editor.hoverLayer(null, 'canvas')
  expect(editor.state.hover).toBe(b.id); expect(editor.state.hoverSource).toBe('layers')
  editor.hoverLayer(null, 'layers'); expect(editor.state.hover).toBeNull()
  expect(editor.state.doc).toBe(original); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  editor.hoverLayer(a.id, 'layers'); editor.load(blank()); expect(editor.state.hover).toBeNull()
})

test('a selected ancestor owns descendant hits even if a Shift selection also contains its child', () => {
  const { editor, outer, group, a, point } = fixture()
  editor.select([outer.id, a.id])
  expect(editor.hit(point(a.id))).toBe(outer.id)
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: group.id, changed: true })
})

test('page switches and hidden or removed ancestors clear stale hover and exclude foreign navigation', () => {
  const { editor, outer, a } = fixture()
  const otherPage = { ...editor.state.doc.pages[0], id: uid(), children: [] }
  editor.change('添加页面', document => { document.pages.push(otherPage) })
  expect(editor.state.doc.pages).toHaveLength(2)
  editor.hoverLayer(a.id, 'layers'); editor.set({ page: otherPage.id })
  expect(editor.state.hover).toBeNull(); expect(editor.selectChildren()).toBe(false)
  editor.set({ page: editor.state.doc.pages[0].id }); editor.hoverLayer(a.id, 'layers')
  editor.update([outer.id], { visible: false }, '切换可见性')
  expect(editor.state.hover).toBeNull()
})

test('generated component descendants keep the instance boundary and parent navigation', () => {
  const { doc, ids } = componentFixture(), editor = new Editor(doc)
  editors.push(editor)
  const label = originNode(editor.state.doc, ids.a, editor.state.doc.nodes[ids.label].componentKey!)
  const p = apply(worldMatrix(editor.state.doc, label.id), { x: 2, y: 2 })
  expect(editor.hit(p)).toBe(ids.a)
  expect(editor.selectionHit(p)).toBe(ids.a)
  expect(editor.selectionHit(p, true)).toBe(label.id)
  expect(editor.hit(p, true)).toBe(label.id)
  editor.select([ids.a])
  expect(editor.selectDeeper(p)).toEqual({ id: label.id, changed: true })
  expect(editor.selectionHit(p)).toBe(label.id)
  expect(editor.selectParent()).toBe(true)
  expect(editor.state.selection).toEqual([ids.a])
})

test('selection atomically retires stale canvas ancestor hover while preserving layer-panel hover ownership', () => {
  const { editor, outer, group, a, b, point } = fixture()
  const original = editor.state.doc, version = editor.state.version
  editor.select([outer.id]); editor.hoverLayer(outer.id, 'canvas')
  const observed: { selection: string[]; hover: string | null }[] = []
  const unsubscribe = editor.subscribe(() => observed.push({ selection: [...editor.state.selection], hover: editor.state.hover }))
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: group.id, changed: true })
  expect(observed).toEqual([{ selection: [group.id], hover: null }])
  expect(editor.state.hoverSource).toBeNull()
  unsubscribe()
  editor.hoverLayer(b.id, 'layers'); editor.select([a.id])
  expect(editor.state.hover).toBe(b.id); expect(editor.state.hoverSource).toBe('layers')
  expect(editor.state.doc).toBe(original); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
})

function overlappingFixture() {
  const document = blank(), frame = node('frame', 0, 0, 400, 300),
    small = node('rectangle', 40, 40, 40, 30), backing = node('rectangle', 20, 20, 300, 200)
  frame.children = [small.id, backing.id]
  document.nodes = Object.fromEntries([frame, small, backing].map(n => [n.id, n]))
  document.pages[0].children = [frame.id]
  const editor = new Editor(document); editors.push(editor)
  return { editor, frame, small, backing, p: { x: 50, y: 50 } }
}

test('ordinary click selects the unentered frame; an entered child uses paint order', () => {
  const { editor, frame, small, backing, p } = overlappingFixture()
  expect(editor.selectionHit(p)).toBe(frame.id)
  expect(editor.hoverHit(p)).toBe(small.id)
  editor.select([frame.id]); expect(editor.selectionHit(p)).toBe(frame.id)
  editor.select([small.id])
  expect(editor.hit(p)).toBe(backing.id)
  expect(editor.hoverHit(p)).toBe(small.id)
  // The frame is entered, so the click hits the front sibling, not the frame.
  expect(editor.selectionHit(p)).toBe(backing.id)
  expect(editor.selectionHit(p, true)).toBe(backing.id)
  editor.selectParent(); expect(editor.selectionHit(p)).toBe(frame.id)
  expect(editor.canUndo).toBe(false)
})

test('scoped picking preserves unopened groups and foreground boards', () => {
  const { editor, frame, small, backing, p } = overlappingFixture()
  const group = node('group', 0, 0, 100, 100)
  editor.change('Nest small target', d => {
    group.children = [small.id]; d.nodes[group.id] = group; d.nodes[frame.id].children = [group.id, backing.id]
  })
  editor.select([backing.id]); expect(editor.selectionHit(p)).toBe(backing.id);expect(editor.hoverHit(p)).toBe(small.id)
  const front = node('frame', 0, 0, 400, 300)
  editor.change('Foreground board', d => { d.nodes[front.id] = front; d.pages[0].children.push(front.id) })
  editor.select([small.id]); expect(editor.selectionHit(p)).toBe(front.id)
})

test('scoped picking excludes hidden, inherited locked, and clipped children', () => {
  const { editor, frame, small, backing, p } = overlappingFixture()
  editor.select([backing.id])
  editor.update([small.id], { visible: false }); expect(editor.selectionHit(p)).toBe(backing.id)
  editor.update([small.id], { visible: true, locked: true }); expect(editor.selectionHit(p)).toBe(backing.id)
  editor.update([small.id], { locked: false }, '切换锁定')
  editor.update([frame.id], { width: 30, height: 30, clip: true })
  expect(editor.selectionHit(p)).toBeNull()
  editor.update([frame.id], { width: 400, height: 300, locked: true }, '切换锁定')
  expect(editor.selectionHit(p)).toBeNull()
})
