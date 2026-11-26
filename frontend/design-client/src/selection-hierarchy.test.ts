import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { apply, scene, worldMatrix } from './geometry'
import { decodeFig } from './import-fig'
import { blank, node, uid } from './model'
import { componentFixture, originNode } from './component-fixtures'
import { interactivePath } from './selection-hierarchy'

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

test('a group takes the click until entered; a frame still selects child paint or its empty area', () => {
  const { editor, outer, group, inner, a, b, point } = fixture()
  const p = point(a.id)
  const empty = { x: 85, y: 95 }
  expect(editor.hit(p)).toBe(group.id)
  expect(editor.selectionHit(p)).toBe(group.id)
  expect(editor.hit(empty)).toBe(outer.id)
  expect(editor.selectionHit(empty)).toBe(outer.id)
  for (const selected of [[], [outer.id], [group.id]]) {
    editor.select(selected)
    expect(editor.selectionHit(p)).toBe(group.id)
    expect(editor.selectionHit(p, true)).toBe(a.id)
    expect(editor.selectionHit(empty, true)).toBe(outer.id)
  }
  editor.select([inner.id]); expect(editor.selectionHit(p)).toBe(a.id)
  editor.select([a.id]); expect(editor.hit(point(b.id))).toBe(b.id)
  editor.select([]); expect(editor.hit(p, true)).toBe(a.id)
  expect(editor.selectDeeper(p)).toEqual({ id: inner.id, changed: true })
})

test('a boolean group takes the click and deep-select reaches its child', () => {
  const document = blank(), shape = node('vector', 10, 10, 80, 80), child = node('rectangle', 10, 10, 30, 30), other = node('ellipse', 40, 10, 20, 20)
  shape.booleanOperation = 'union'
  shape.children = [child.id, other.id]
  document.schemaVersion = 4
  document.nodes[shape.id] = shape
  document.nodes[child.id] = child
  document.nodes[other.id] = other
  document.pages[0].children = [shape.id]
  const editor = new Editor(document); editors.push(editor)
  expect(editor.selectionHit({ x: 30, y: 30 })).toBe(shape.id)
  expect(editor.selectionHit({ x: 30, y: 30 }, true)).toBe(child.id)
  expect(editor.canUndo).toBe(false)
})

test('Figma double-click steps through frames and groups without changing the move tool', () => {
  const { editor, outer, group, inner, a, point } = fixture()
  editor.select([])
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: inner.id, changed: true })
  editor.select([outer.id])
  for (const id of [group.id, inner.id, a.id])
    expect(editor.selectDeeper(point(a.id))).toEqual({ id, changed: true })
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: a.id, changed: false })
  expect(editor.state.tool).toBe('select')
})

test('a double-click reaches a nested group before its leaf; a forced deep pick still reaches the leaf', () => {
  const { editor, group, inner, a, point } = fixture()
  editor.update([inner.id], { kind: 'group', clip: false }, 'nested group')
  editor.select([group.id])
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: inner.id, changed: true })
  expect(editor.selectDeeper(point(a.id))).toEqual({ id: a.id, changed: true })
  expect(editor.selectionHit(point(a.id), true)).toBe(a.id)
})

test('Enter on a group selects both children and Shift+Enter returns to the group', () => {
  const document = blank(), group = node('group', 20, 20, 180, 80), a = node('rectangle', 8, 8, 40, 40), b = node('ellipse', 70, 8, 36, 36)
  group.children = [a.id, b.id]
  for (const n of [group, a, b]) document.nodes[n.id] = n
  document.pages[0].children = [group.id]
  const editor = new Editor(document); editors.push(editor)
  const original = editor.state.doc
  editor.select([group.id])
  expect(editor.selectChildren()).toBe(true)
  expect(editor.state.selection).toHaveLength(2)
  expect(new Set(editor.state.selection)).toEqual(new Set([a.id, b.id]))
  expect(editor.selectParent()).toBe(true)
  expect(editor.state.selection).toEqual([group.id])
  expect(editor.state.doc).toBe(original)
  expect(editor.canUndo).toBe(false)
})

test('Enter selects direct children including hidden and locked, Shift+Enter returns to the parent', () => {
  const { editor, outer, group, inner, a, b, hidden, locked } = fixture()
  const original = editor.state.doc, version = editor.state.version
  editor.select([outer.id]); expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([group.id])
  expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  expect(editor.selectChildren()).toBe(true); expect(editor.state.selection).toEqual([locked.id, hidden.id, b.id, a.id])
  expect(hidden.visible).toBe(false); expect(locked.locked).toBe(true)
  expect(editor.state.doc).toBe(original); expect(editor.state.version).toBe(version); expect(editor.canUndo).toBe(false)
  expect(interactivePath(editor.state.doc, editor.state.page, hidden.id)).toEqual([])
  expect(interactivePath(editor.state.doc, editor.state.page, locked.id)).toEqual([])
  expect(scene(editor.state.doc, editor.state.page).some(entry => entry.id === hidden.id)).toBe(false)
  expect(scene(editor.state.doc, editor.state.page).find(entry => entry.id === locked.id)?.locked).toBe(true)
  expect(editor.selectParent()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  editor.select([hidden.id]); expect(editor.selectParent()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  editor.select([locked.id]); expect(editor.selectParent()).toBe(true); expect(editor.state.selection).toEqual([inner.id])
  editor.select([outer.id]); expect(editor.selectParent()).toBe(false); expect(editor.state.selection).toEqual([outer.id])
  expect(editor.state.doc).toBe(original); expect(editor.canUndo).toBe(false)
})

test('an authored locked container does not open and its children do not climb or cycle', () => {
  const document = blank(), inner = node('frame'), a = node('rectangle'), b = node('rectangle')
  inner.locked = true
  inner.children = [a.id, b.id]
  for (const n of [inner, a, b]) document.nodes[n.id] = n
  document.pages[0].children = [inner.id]
  const editor = new Editor(document); editors.push(editor)
  const original = editor.state.doc, version = editor.state.version
  editor.select([inner.id])
  expect(editor.selectChildren()).toBe(false)
  expect(editor.state.selection).toEqual([inner.id])
  editor.select([a.id])
  expect(editor.selectSibling(1)).toBe(false)
  expect(editor.selectParent()).toBe(false)
  expect(editor.state.selection).toEqual([a.id])
  expect(editor.state.doc).toBe(original)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
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
  expect(editor.hit(point(a.id))).toBe(group.id)
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

test('front paint wins over the frame; empty frame area stays on the frame', () => {
  const { editor, frame, small, backing, p } = overlappingFixture()
  const empty = { x: 5, y: 5 }
  expect(editor.selectionHit(p)).toBe(backing.id)
  expect(editor.selectionHit(empty)).toBe(frame.id)
  expect(editor.hoverHit(p)).toBe(small.id)
  editor.select([frame.id])
  expect(editor.selectionHit(p)).toBe(backing.id)
  expect(editor.selectionHit(empty)).toBe(frame.id)
  editor.select([small.id])
  expect(editor.hit(p)).toBe(backing.id)
  expect(editor.hoverHit(p)).toBe(small.id)
  expect(editor.selectionHit(p)).toBe(backing.id)
  expect(editor.selectionHit(p, true)).toBe(backing.id)
  editor.selectParent()
  expect(editor.selectionHit(p)).toBe(backing.id)
  expect(editor.selectionHit(empty, true)).toBe(frame.id)
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

const DASHBOARD_FIG = fileURLToPath(new URL('../../../testing/fixtures/user-regression-20261109/01有料素材 (Copy).fig', import.meta.url))
const DASHBOARD_FIG_SHA256 = '701877664bf271305c8bc103c4036a228d7bd8816f1d98f18cdc332a75c36c46'
// Mac desktop Figma 126.10.13, layers-panel order after Return on 01_Dashboard.
const DASHBOARD_CHILD_ORDER = ['1440x12xGrid', 'Header', 'Menu Panel', 'Cards', 'Monthly Chart', 'Bar Chart', 'Posting Tasks', 'Top Performance', 'Simple Chart']
const figGuid = (value: { sessionID?: number; localID?: number } | string | undefined) =>
  typeof value === 'string' ? value : value ? `${value.sessionID}:${value.localID}` : ''

function dashboardRecords(bytes: Uint8Array) {
  const { data } = decodeFig(bytes)
  const records = new Map<string, Record<string, any>>()
  for (const change of data.nodeChanges || []) {
    const id = figGuid(change.guid)
    if (change.phase === 'REMOVED') records.delete(id)
    else records.set(id, { ...records.get(id), ...change })
  }
  return records
}

test('Return on imported 01_Dashboard selects the hidden grid and Shift+Return returns to the artboard', () => {
  const bytes = readFileSync(DASHBOARD_FIG)
  expect(bytes.subarray(0, 8).toString(), 'fixture must be the FIG bytes, not a Git LFS pointer').not.toBe('version ')
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(DASHBOARD_FIG_SHA256)
  const records = dashboardRecords(bytes)
  const boards = [...records.values()].filter(record => record.name === '01_Dashboard' && record.type === 'FRAME')
  expect(boards.length).toBeGreaterThan(0)
  for (const board of boards) {
    expect(board.stackReverseZIndex).not.toBe(true)
    expect(board.stackMode === undefined || board.stackMode === 'NONE').toBe(true)
    expect(board.visible).not.toBe(false)
    expect(board.locked).not.toBe(true)
    const stored = [...records.values()].filter(record => figGuid(record.parentIndex?.guid) === figGuid(board.guid))
    stored.sort((left, right) => {
      const a = String(left.parentIndex?.position || ''), b = String(right.parentIndex?.position || '')
      return a < b ? -1 : a > b ? 1 : 0
    })
    expect(stored.map(record => record.name)).toEqual([...DASHBOARD_CHILD_ORDER].reverse())
    expect(stored.every(record => record.internalOnly !== true && record.mask !== true)).toBe(true)
    expect(stored.filter(record => record.visible === false).map(record => record.name)).toEqual(['1440x12xGrid'])
    expect(stored.some(record => record.locked === true)).toBe(false)
    const document = blank('01有料素材 (Copy)'), frame = node('frame')
    frame.name = '01_Dashboard'
    const children = stored.map(record => {
      const child = node('frame')
      child.name = record.name
      child.visible = record.visible !== false
      child.locked = !!record.locked
      return child
    })
    frame.children = children.map(child => child.id)
    document.nodes = Object.fromEntries([frame, ...children].map(child => [child.id, child]))
    document.pages[0].children = [frame.id]
    const editor = new Editor(document); editors.push(editor)
    const original = editor.state.doc, version = editor.state.version
    const grid = children.find(child => child.name === '1440x12xGrid')!
    const top = children.find(child => child.name === 'Top Performance')!
    editor.select([frame.id])
    expect(editor.selectChildren()).toBe(true)
    expect(editor.state.selection.map(id => editor.state.doc.nodes[id].name)).toEqual(DASHBOARD_CHILD_ORDER)
    expect(editor.state.doc.nodes[grid.id].visible).toBe(false)
    expect(editor.state.doc).toBe(original)
    expect(editor.state.version).toBe(version)
    expect(editor.canUndo).toBe(false)
    expect(scene(editor.state.doc, editor.state.page).some(entry => entry.id === grid.id)).toBe(false)
    expect(editor.selectParent()).toBe(true)
    expect(editor.state.selection).toEqual([frame.id])
    expect(editor.state.doc).toBe(original)
    expect(editor.canUndo).toBe(false)
    editor.select([top.id])
    expect(editor.selectParent()).toBe(true)
    expect(editor.state.selection).toEqual([frame.id])
    editor.select([grid.id])
    expect(editor.selectParent()).toBe(true)
    expect(editor.state.selection).toEqual([frame.id])
    expect(editor.state.doc.nodes[grid.id].visible).toBe(false)
    expect(editor.state.doc).toBe(original)
    expect(editor.state.version).toBe(version)
    expect(editor.canUndo).toBe(false)
  }
})
