import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node, uid } from './model'
import { allParents, multiply, translate, worldMatrix } from './geometry'
import { createClip } from './animation'
import { canvasMenuItems } from './canvas-menu-model'
import { componentFixture } from './component-fixtures'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture() {
  const doc = blank(), frame = node('frame', 100.25, 80.125, 400, 300), a = node('rectangle', 20.5, 30.25, 60, 40), b = node('ellipse', 120, 30, 60, 40)
  frame.transform = [1.2, .25, -.15, .9, 100.25, 80.125]
  doc.nodes = Object.fromEntries([frame, a, b].map(n => [n.id, n])); frame.children = [a.id, b.id]; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor); return { doc: editor.state.doc, editor, frame, a, b }
}
test('ordinary duplicate keeps the affine parent, appearance and one native history action', () => {
  const { editor, doc, frame, a } = fixture(); editor.select([a.id]); editor.duplicate()
  const copy = editor.state.selection[0]
  expect(copy).not.toBe(a.id)
  expect(allParents(editor.state.doc).get(copy)).toBe(frame.id)
  expect(worldMatrix(editor.state.doc, copy)).toEqual(worldMatrix(doc, a.id))
  expect(editor.state.doc.nodes[a.id]).toEqual(doc.nodes[a.id])
  editor.undo(); expect(editor.state.doc).toEqual(doc); expect(editor.canUndo).toBe(false)
})
test('repeating an unmoved duplicate does not accumulate affine roundoff', () => {
  const { editor, doc, a } = fixture(); editor.select([a.id])
  for (let i = 0; i < 12; i++) {
    editor.duplicate()
    expect(worldMatrix(editor.state.doc, editor.state.selection[0])).toEqual(worldMatrix(doc, a.id))
  }
})
test('repeated duplicate carries the last world displacement without using the OS clipboard', () => {
  const { editor, a } = fixture(); editor.select([a.id]); editor.duplicate()
  editor.transformSelection(translate(25.125, -10.25))
  const at = worldMatrix(editor.state.doc, editor.state.selection[0]); editor.duplicate()
  const next = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(next[4] - at[4]).toBeCloseTo(25.125, 10); expect(next[5] - at[5]).toBeCloseTo(-10.25, 10)
  editor.duplicate(); const last = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(last[4] - next[4]).toBeCloseTo(25.125, 10)
})
test('Option preview toggles without extra versions, cancel preserves original graph, commit is one undo', () => {
  const { editor, doc, a } = fixture(); editor.select([a.id]); const version = editor.state.version
  editor.begin('拖动复制'); const [copy] = editor.moveDuplication(true, [a.id])
  const start = editor.state.doc.nodes[copy].transform
  editor.preview({ [copy]: { transform: multiply(translate(15.25, 3.75), start) } })
  expect(editor.state.doc.nodes[a.id]).toEqual(doc.nodes[a.id]); expect(editor.state.version).toBe(version)
  editor.moveDuplication(false, [a.id]); expect(editor.state.doc).toBe(doc)
  expect(editor.moveDuplication(true, [a.id])).toEqual([copy])
  editor.cancel(); expect(editor.state.doc).toBe(doc); expect(editor.canUndo).toBe(false)
  editor.begin('拖动复制'); editor.moveDuplication(true, [a.id]); editor.commit()
  expect(editor.state.version).toBe(version + 1); editor.undo(); expect(editor.state.doc).toEqual(doc); expect(editor.canUndo).toBe(false)
})
test('locked layers copy losslessly but cannot be cut through keyboard dispatch', () => {
  const { editor, a } = fixture(); editor.update([a.id], { locked: true }); editor.select([a.id])
  const payload = JSON.parse(editor.exportClipboard()!)
  expect(payload.document.nodes[a.id].locked).toBe(true)
  expect(canvasMenuItems(editor).find(item => item.command === 'copy')?.disabled).toBe(false)
  expect(() => editor.exportClipboard(true)).toThrow('解锁')
})
test('page duplication/remap/reorder retain precision and support undo navigation', () => {
  const { editor, doc, frame, a } = fixture(); const page = editor.state.page
  editor.duplicatePage(); const copyPage = editor.state.page
  expect(copyPage).not.toBe(page); expect(editor.state.doc.pages).toHaveLength(2)
  const clone = editor.state.doc.nodes[editor.state.doc.pages[1].children[0]]
  expect(clone.id).not.toBe(frame.id); expect(clone.transform).toEqual(frame.transform)
  expect(editor.state.doc.nodes[clone.children[0]].transform).toEqual(a.transform)
  editor.reorderPage(copyPage, page); expect(editor.state.doc.pages[0].id).toBe(copyPage)
  editor.undo(); expect(editor.state.doc.pages[0].id).toBe(page)
  editor.undo(); expect(editor.state.doc).toEqual(doc); expect(editor.state.page).toBe(page)
})
test('internal copies preserve prototype links and duplicate tracks in the same clip', () => {
  const { doc, a, b } = fixture(); const source = structuredClone(doc); source.schemaVersion = 4
  source.prototype = { interactions: { [a.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: b.id, durationMs: 0 }] }] } }
  source.animations = [createClip(source, source.pages[0].id, [a.id])]
  const editor = new Editor(source); editors.push(editor); editor.select([a.id, b.id]); editor.duplicate()
  const [ac, bc] = editor.state.selection
  const content = editor.state.doc.nodes[ac].kind === 'group' ? editor.state.doc.nodes[ac].children[0] : ac
  expect(editor.state.doc.prototype?.interactions[content][0].actions[0].target).toBe(bc)
  expect(editor.state.doc.animations?.[0].tracks.some(track => track.nodeId === content)).toBe(true)
  expect(editor.state.doc.animations).toHaveLength(1)
})
test('duplicating an instance retains its definition and copying a page remaps copied definitions together', () => {
  const { doc, ids } = componentFixture(), editor = new Editor(doc); editors.push(editor)
  editor.select([ids.a]); editor.duplicate()
  expect(editor.state.doc.nodes[editor.state.selection[0]].instance?.componentId).toBe(ids.button)
  const old = editor.state.doc, page = editor.state.page
  editor.duplicatePage(page)
  expect(editor.state.page, editor.state.message).not.toBe(page)
  const roots = editor.state.doc.pages.find(value => value.id === editor.state.page)!.children
  const button = roots.map(id => editor.state.doc.nodes[id]).find(n => n.component && n.name === '按钮')!
  expect(button.id).not.toBe(ids.button)
  const instances = roots.map(id => editor.state.doc.nodes[id]).filter(n => n.instance)
  expect(instances.every(n => n.instance!.componentId === button.id)).toBe(true)
  expect(editor.state.doc.nodes[ids.button]).toEqual(old.nodes[ids.button])
})

test('Option-copy in auto layout leaves source flow stationary, restores sizing at drop, and undoes once', () => {
  const {editor,frame,a,b}=fixture()
  editor.select([frame.id]);editor.autoLayout('horizontal')
  const before=editor.state.doc;editor.select([a.id]);editor.begin('Flow copy')
  const [copy]=editor.moveDuplication(true,[a.id])
  expect(editor.state.doc.nodes[a.id]).toEqual(before.nodes[a.id]);expect(editor.state.doc.nodes[b.id]).toEqual(before.nodes[b.id])
  expect(editor.state.doc.nodes[copy].sizing?.absolute).toBe(true)
  editor.finishMoveDuplication({x:1e5,y:1e5});editor.commit()
  expect(editor.state.doc.nodes[frame.id].children.at(-1)).toBe(copy)
  expect(editor.state.doc.nodes[copy].sizing).toEqual(before.nodes[a.id].sizing)
  editor.undo();expect(editor.state.doc).toEqual(before)
})
