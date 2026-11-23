import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, defaultLayout, node, uid } from './model'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { allParents, multiply, translate, worldMatrix } from './geometry'
import { createClip } from './animation'
import { canvasMenuItems } from './canvas-menu-model'
import { componentFixture } from './component-fixtures'
import { interfacePreference } from './interface-preference'
import { createDesignAutomation } from './automation/core'

const editors: Editor[] = []
afterEach(() => { editors.splice(0).forEach(editor => editor.dispose()); interfacePreference.set({ uiMode: 'figma' }) })
function fixture() {
  const doc = blank(), frame = node('frame', 100.25, 80.125, 400, 300), a = node('rectangle', 20.5, 30.25, 60, 40), b = node('ellipse', 120, 30, 60, 40)
  frame.transform = [1.2, .25, -.15, .9, 100.25, 80.125]
  doc.nodes = Object.fromEntries([frame, a, b].map(n => [n.id, n])); frame.children = [a.id, b.id]; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor); return { doc: editor.state.doc, editor, frame, a, b }
}
test('Mac Figma paste steps inspector X/Y by 10, including a selected frame and a repeat', () => {
  const doc = blank(), source = node('frame', 0, 0, 200, 160), target = node('frame', 400, 50, 200, 160), child = node('rectangle', 20, 30, 40, 40)
  source.children = [child.id]
  doc.nodes = Object.fromEntries([source, target, child].map(n => [n.id, n]))
  doc.pages[0].children = [source.id, target.id]
  const editor = new Editor(doc); editors.push(editor)
  editor.select([child.id]); editor.copy(); editor.select([target.id]); editor.pasteToSelection(false)
  const copy = editor.state.selection[0]
  expect(copy).not.toBe(child.id)
  expect(allParents(editor.state.doc).get(copy)).toBe(target.id)
  expect(editor.state.doc.nodes[copy].transform[4]).toBeCloseTo(30, 8)
  expect(editor.state.doc.nodes[copy].transform[5]).toBeCloseTo(40, 8)
  expect(editor.state.doc.nodes[child.id]).toEqual(doc.nodes[child.id])
  editor.select([copy]); editor.pasteToSelection(false)
  const again = editor.state.selection[0]
  expect(allParents(editor.state.doc).get(again)).toBe(target.id)
  expect(editor.state.doc.nodes[again].transform[4]).toBeCloseTo(40, 8)
  expect(editor.state.doc.nodes[again].transform[5]).toBeCloseTo(50, 8)
})
test('copy and paste offsets a page layer and a sibling by 10, including the clipboard roundtrip', () => {
  const doc = blank(), frame = node('frame', 100, 80, 200, 160), child = node('rectangle', 20, 30, 40, 40), page = node('rectangle', 15, 25, 10, 10)
  frame.children = [child.id]
  doc.nodes = Object.fromEntries([frame, child, page].map(n => [n.id, n]))
  doc.pages[0].children = [frame.id, page.id]
  const editor = new Editor(doc); editors.push(editor)
  editor.select([page.id]); editor.copy(); editor.pasteToSelection(false)
  const pasted = editor.state.doc.nodes[editor.state.selection[0]]
  expect(pasted.transform[4]).toBeCloseTo(25, 8)
  expect(pasted.transform[5]).toBeCloseTo(35, 8)
  editor.select([child.id]); editor.copy(); editor.pasteToSelection(false)
  const sibling = editor.state.doc.nodes[editor.state.selection[0]]
  expect(allParents(editor.state.doc).get(sibling.id)).toBe(frame.id)
  expect(sibling.transform[4]).toBeCloseTo(30, 8)
  expect(sibling.transform[5]).toBeCloseTo(40, 8)
  editor.importClipboard(editor.exportClipboard()!)
  editor.pasteToSelection(false)
  const round = editor.state.doc.nodes[editor.state.selection[0]]
  expect(allParents(editor.state.doc).get(round.id)).toBe(frame.id)
  expect(round.transform[4]).toBeCloseTo(40, 8)
  expect(round.transform[5]).toBeCloseTo(50, 8)
})
test('ordinary duplicate keeps the affine parent, appearance and one native history action', () => {
  const { editor, doc, frame, a } = fixture(); editor.select([a.id]); editor.duplicate()
  const copy = editor.state.selection[0]
  expect(copy).not.toBe(a.id)
  expect(allParents(editor.state.doc).get(copy)).toBe(frame.id)
  expect(worldMatrix(editor.state.doc, copy)).toEqual(worldMatrix(doc, a.id))
  expect(editor.state.doc.nodes[a.id]).toEqual(doc.nodes[a.id])
  editor.undo(); expect(editor.state.doc).toEqual(doc); expect(editor.canUndo).toBe(false)
})
test('repeating an unmoved Figma duplicate stays exactly on top without affine roundoff', () => {
  const { editor, doc, a } = fixture(); editor.select([a.id])
  const source = worldMatrix(doc, a.id)
  for (let i = 0; i < 12; i++) {
    editor.duplicate()
    expect(worldMatrix(editor.state.doc, editor.state.selection[0])).toEqual(source)
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
  expect(last[5] - next[5]).toBeCloseTo(-10.25, 10)
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

test('Figma layout ⌘D places page-level frames and sections to the right and leaves other objects on top', () => {
  interfacePreference.set({ uiMode: 'figma' })
  const doc = blank('top-level duplicate')
  const frame = node('frame', 100, 50, 300, 200)
  const turned = node('frame', 0, 0, 80, 40)
  turned.transform = [0, 1, -1, 0, 100, 50]
  const sibling = node('frame', 500, 20, 40, 40)
  const nested = node('frame', 12, 16, 40, 30)
  const section = node('section', 20, 30, 80, 40)
  const group = node('group', 8, 12, 40, 20)
  const shape = node('rectangle', 4, 6, 10, 10)
  const pageShape = node('rectangle', 300, 0, 10, 10)
  frame.children = [nested.id, shape.id]
  doc.nodes = Object.fromEntries([frame, turned, sibling, nested, section, group, shape, pageShape].map(n => [n.id, n]))
  doc.pages[0].children = [frame.id, turned.id, sibling.id, section.id, group.id, pageShape.id]
  const editor = new Editor(doc); editors.push(editor)
  const place = (id: string) => {
    editor.select([id])
    const before = [...worldMatrix(editor.state.doc, id)]
    editor.duplicate()
    const copy = editor.state.selection[0]
    return { before, copy, after: [...worldMatrix(editor.state.doc, copy)] }
  }
  const ordinary = place(shape.id)
  expect(ordinary.after[4] - ordinary.before[4]).toBeCloseTo(0, 8)
  expect(ordinary.after[5] - ordinary.before[5]).toBeCloseTo(0, 8)
  expect(ordinary.copy).not.toBe(shape.id)
  editor.undo()
  const inner = place(nested.id)
  expect(inner.after[4] - inner.before[4]).toBeCloseTo(0, 8)
  expect(inner.after[5] - inner.before[5]).toBeCloseTo(0, 8)
  expect(allParents(editor.state.doc).get(inner.copy)).toBe(frame.id)
  editor.undo()
  for (const id of [group.id, pageShape.id]) {
    const stepped = place(id)
    expect(stepped.after[4] - stepped.before[4]).toBeCloseTo(0, 8)
    expect(stepped.after[5] - stepped.before[5]).toBeCloseTo(0, 8)
    expect(stepped.copy).not.toBe(id)
    editor.undo()
  }
  const sectionCopy = place(section.id)
  expect(sectionCopy.after[4] - sectionCopy.before[4]).toBeCloseTo(section.width + 40, 8)
  expect(sectionCopy.after[5] - sectionCopy.before[5]).toBeCloseTo(0, 8)
  editor.undo()
  const first = place(frame.id)
  expect(first.after).toEqual([1, 0, 0, 1, 100 + 300 + 40, 50])
  expect(editor.state.doc.nodes[frame.id].transform).toEqual(first.before)
  editor.duplicate()
  const again = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(again[4] - first.after[4]).toBeCloseTo(340, 8)
  expect(again[5] - first.after[5]).toBeCloseTo(0, 8)
  const duplicated = editor.state.doc
  editor.undo(); editor.undo()
  expect(editor.state.doc.nodes[first.copy]).toBeUndefined()
  expect(worldMatrix(editor.state.doc, frame.id)).toEqual(first.before)
  editor.redo(); editor.redo(); expect(editor.state.doc).toEqual(duplicated)
  editor.undo(); editor.undo()
  const rotated = place(turned.id)
  expect(rotated.after.slice(0, 4)).toEqual([0, 1, -1, 0])
  expect(rotated.after[4]).toBeCloseTo(180, 8)
  expect(rotated.after[5]).toBeCloseTo(50, 8)
  editor.undo()
  editor.select([frame.id, sibling.id])
  const left = worldMatrix(editor.state.doc, frame.id), right = worldMatrix(editor.state.doc, sibling.id)
  editor.duplicate()
  const [copyLeft, copyRight] = editor.state.selection
  expect(worldMatrix(editor.state.doc, copyLeft)[4] - left[4]).toBeCloseTo(440 + 40, 8)
  expect(worldMatrix(editor.state.doc, copyLeft)[5]).toBeCloseTo(left[5], 8)
  expect(worldMatrix(editor.state.doc, copyRight)[4] - right[4]).toBeCloseTo(440 + 40, 8)
  expect(worldMatrix(editor.state.doc, copyRight)[5]).toBeCloseTo(right[5], 8)
  editor.undo()
  editor.select([frame.id, pageShape.id]); editor.duplicate()
  const mixed = editor.state.selection.map(id => worldMatrix(editor.state.doc, id))
  expect(mixed[0][4] - left[4]).toBeCloseTo(0, 8)
  expect(mixed[0][5] - left[5]).toBeCloseTo(0, 8)
  expect(mixed[1][4]).toBeCloseTo(300, 8)
  expect(mixed[1][5]).toBeCloseTo(0, 8)
  expect(editor.state.selection[0]).not.toBe(frame.id)
})

test('Sketch layout and an explicit offset do not use the Figma top-level frame landing', () => {
  const doc = blank('sketch duplicate'), frame = node('frame', 10, 20, 100, 80)
  doc.nodes[frame.id] = frame; doc.pages[0].children = [frame.id]
  interfacePreference.set({ uiMode: 'sketch' })
  const editor = new Editor(doc); editors.push(editor)
  editor.select([frame.id]); editor.duplicate()
  expect(worldMatrix(editor.state.doc, editor.state.selection[0])).toEqual([1, 0, 0, 1, 20, 30])
  editor.undo()
  const sketchApi = createDesignAutomation(editor)
  const sketchCopy = sketchApi.execute({ method: 'node.duplicate', params: { ids: [frame.id] },
    documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  expect(sketchCopy.ok, JSON.stringify(sketchCopy)).toBe(true)
  if (!sketchCopy.ok) throw Error(sketchCopy.error.message)
  const sketchId = (sketchCopy.result as { operations: { result: { ids: string[] } }[] }).operations[0].result.ids[0]
  expect(worldMatrix(editor.state.doc, sketchId)).toEqual([1, 0, 0, 1, 20, 30])
  editor.undo()
  interfacePreference.set({ uiMode: 'figma' })
  const api = createDesignAutomation(editor)
  const response = api.execute({ method: 'node.duplicate', params: { ids: [frame.id], offsetX: 7, offsetY: -3 },
    documentId: editor.state.doc.id, session: editor.sessionGeneration, expectedRevision: editor.state.version })
  expect(response.ok, JSON.stringify(response)).toBe(true)
  if (!response.ok) throw Error(response.error.message)
  const copy = (response.result as { operations: { result: { ids: string[] } }[] }).operations[0].result.ids[0]
  expect(worldMatrix(editor.state.doc, copy)).toEqual([1, 0, 0, 1, 17, 17])
  editor.undo()
  editor.select([frame.id]); editor.createComponent(); editor.duplicate()
  const instance = editor.state.doc.nodes[editor.state.selection[0]]
  expect(instance.instance?.componentId).toBe(frame.id)
  expect(instance.transform).toEqual([1, 0, 0, 1, 10 + 100 + 40, 20])
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

test('⌘D and Editor.duplicate land the same top-level frame, then repeat that gap', async () => {
  interfacePreference.set({ uiMode: 'figma' })
  const make = () => {
    const doc = blank('shortcut duplicate'), frame = node('frame', 80, 36, 240, 180)
    doc.nodes[frame.id] = frame; doc.pages[0].children = [frame.id]
    const editor = new Editor(doc); editors.push(editor); editor.select([frame.id])
    return editor
  }
  const viaCommand = make()
  viaCommand.duplicate()
  const commandCopy = worldMatrix(viaCommand.state.doc, viaCommand.state.selection[0])
  expect(commandCopy).toEqual([1, 0, 0, 1, 80 + 240 + 40, 36])
  viaCommand.duplicate()
  const commandAgain = worldMatrix(viaCommand.state.doc, viaCommand.state.selection[0])
  expect(commandAgain[4] - commandCopy[4]).toBeCloseTo(280, 8)
  expect(commandAgain[5]).toBe(commandCopy[5])
  for (const platform of ['mac', 'linux'] as const) {
    const viaShortcut = make()
    const event = {
      key: 'd', code: 'KeyD', ctrlKey: platform !== 'mac', metaKey: platform === 'mac',
      altKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false,
      target: null, preventDefault() {},
    }
    const context = { profile: 'figma-like' as const, platform, uiMode: 'figma' as const }
    expect(await dispatchEditorShortcut(viaShortcut, event, context)).toBe(true)
    expect(worldMatrix(viaShortcut.state.doc, viaShortcut.state.selection[0])).toEqual(commandCopy)
    expect(await dispatchEditorShortcut(viaShortcut, event, context)).toBe(true)
    expect(worldMatrix(viaShortcut.state.doc, viaShortcut.state.selection[0])).toEqual(commandAgain)
  }
})

test('Figma ⌘D places a frame inside a section to the right and grows ancestor sections', () => {
  interfacePreference.set({ uiMode: 'figma' })
  const doc = blank('section duplicate')
  const outer = node('section', 0, 0, 150, 120), inner = node('section', 20, 15, 80, 70)
  const frame = node('frame', 10, 10, 60, 40), shape = node('rectangle', 4, 6, 10, 10)
  const fitted = node('frame', 12, 18, 40, 30)
  inner.children = [frame.id]; outer.children = [inner.id, fitted.id]
  const wide = node('section', 400, 90, 500, 200), inside = node('frame', 15, 20, 100, 80)
  wide.children = [inside.id]
  doc.nodes = Object.fromEntries([outer, inner, frame, shape, fitted, wide, inside].map(n => [n.id, n]))
  doc.pages[0].children = [outer.id, shape.id, wide.id]
  const editor = new Editor(doc); editors.push(editor)
  const sourceWorld = worldMatrix(editor.state.doc, frame.id)
  editor.select([frame.id]); editor.duplicate()
  const copy = editor.state.selection[0]
  const copyWorld = worldMatrix(editor.state.doc, copy)
  expect(allParents(editor.state.doc).get(copy)).toBe(inner.id)
  expect(copyWorld[4] - sourceWorld[4]).toBeCloseTo(100, 8)
  expect(copyWorld[5]).toBeCloseTo(sourceWorld[5], 8)
  expect(worldMatrix(editor.state.doc, frame.id)).toEqual(sourceWorld)
  expect(editor.state.doc.nodes[inner.id].width).toBe(170)
  expect(editor.state.doc.nodes[outer.id].width).toBe(190)
  expect(editor.state.doc.nodes[outer.id].height).toBe(120)
  editor.undo()
  expect(editor.state.doc.nodes[inner.id].width).toBe(80)
  expect(editor.state.doc.nodes[outer.id].width).toBe(150)
  editor.select([fitted.id]); editor.duplicate()
  expect(worldMatrix(editor.state.doc, editor.state.selection[0])[4] - worldMatrix(editor.state.doc, fitted.id)[4]).toBeCloseTo(80, 8)
  expect(editor.state.doc.nodes[outer.id].width).toBe(150)
  editor.undo()
  const insideWorld = worldMatrix(editor.state.doc, inside.id)
  editor.select([inside.id]); editor.duplicate()
  expect(worldMatrix(editor.state.doc, editor.state.selection[0])[4] - insideWorld[4]).toBeCloseTo(140, 8)
  expect(editor.state.doc.nodes[wide.id].width).toBe(500)
  expect(worldMatrix(editor.state.doc, inside.id)).toEqual(insideWorld)
  editor.undo()
  editor.select([shape.id]); editor.duplicate()
  expect(worldMatrix(editor.state.doc, editor.state.selection[0])).toEqual(worldMatrix(editor.state.doc, shape.id))
  const left = node('frame', 10, 12, 40, 30), right = node('frame', 80, 12, 50, 30)
  const row = node('section', 0, 300, 200, 80)
  row.children = [left.id, right.id]
  editor.change('row', draft => {
    draft.nodes[left.id] = left; draft.nodes[right.id] = right; draft.nodes[row.id] = row
    draft.pages[0].children.push(row.id)
  })
  const leftWorld = worldMatrix(editor.state.doc, left.id), rightWorld = worldMatrix(editor.state.doc, right.id)
  editor.select([left.id, right.id]); editor.duplicate()
  const [copyLeft, copyRight] = editor.state.selection
  expect(worldMatrix(editor.state.doc, copyLeft)[4] - leftWorld[4]).toBeCloseTo(160, 8)
  expect(worldMatrix(editor.state.doc, copyRight)[4] - rightWorld[4]).toBeCloseTo(160, 8)
  expect(worldMatrix(editor.state.doc, copyLeft)[5]).toBeCloseTo(leftWorld[5], 8)
  expect(editor.state.doc.nodes[row.id].width).toBe(290)
  expect(worldMatrix(editor.state.doc, left.id)).toEqual(leftWorld)
})

test('Figma ⌘D shifts a section that starts above its parent and keeps world positions', () => {
  interfacePreference.set({ uiMode: 'figma' })
  const doc = blank('section origin'), section = node('section', 100, 200, 180, 90), frame = node('frame', 10, -20, 50, 40)
  section.children = [frame.id]
  doc.nodes = { [section.id]: section, [frame.id]: frame }; doc.pages[0].children = [section.id]
  const editor = new Editor(doc); editors.push(editor)
  const source = worldMatrix(editor.state.doc, frame.id)
  editor.select([frame.id]); editor.duplicate()
  const copy = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(copy[4] - source[4]).toBeCloseTo(90, 8)
  expect(copy[5]).toBeCloseTo(source[5], 8)
  expect(worldMatrix(editor.state.doc, frame.id)).toEqual(source)
  expect(editor.state.doc.nodes[section.id].transform.slice(4)).toEqual([100, 180])
  expect(editor.state.doc.nodes[section.id].width).toBe(180)
  expect(editor.state.doc.nodes[section.id].height).toBe(110)
})

test('Figma auto-layout duplicate inserts the next flow sibling instead of the canvas gap', () => {
  interfacePreference.set({ uiMode: 'figma' })
  const doc = blank('flow duplicate'), frame = node('frame', 0, 0, 400, 240)
  const a = node('rectangle', 0, 0, 40, 24), b = node('rectangle', 0, 0, 30, 18)
  frame.layout = { ...defaultLayout(), mode: 'horizontal' }; frame.children = [a.id, b.id]
  doc.nodes = { [frame.id]: frame, [a.id]: a, [b.id]: b }; doc.pages[0].children = [frame.id]
  const editor = new Editor(doc); editors.push(editor)
  const gap = editor.state.doc.nodes[frame.id].layout!.gap
  const ax = editor.state.doc.nodes[a.id].transform[4], bx = editor.state.doc.nodes[b.id].transform[4]
  editor.select([a.id]); editor.duplicate()
  const copy = editor.state.selection[0]
  expect(editor.state.doc.nodes[frame.id].children).toEqual([a.id, copy, b.id])
  expect(editor.state.doc.nodes[copy].transform[4]).toBeCloseTo(ax + editor.state.doc.nodes[a.id].width + gap, 6)
  expect(editor.state.doc.nodes[b.id].transform[4]).toBeCloseTo(bx + editor.state.doc.nodes[copy].width + gap, 6)
  expect(editor.state.doc.nodes[copy].transform[4] - ax).not.toBeCloseTo(40, 6)
  editor.undo()
  const source = worldMatrix(editor.state.doc, frame.id)
  const laidOut = editor.state.doc.nodes[frame.id]
  editor.select([frame.id]); editor.duplicate()
  const board = worldMatrix(editor.state.doc, editor.state.selection[0])
  expect(board[4] - source[4]).toBeCloseTo(laidOut.width + 40, 6)
  expect(board[5]).toBeCloseTo(source[5], 6)
  const vertical = node('frame', 20, 30, 200, 300), top = node('rectangle', 0, 0, 36, 28), below = node('rectangle', 0, 0, 36, 16)
  vertical.layout = { ...defaultLayout(), mode: 'vertical' }; vertical.children = [top.id, below.id]
  const flow = blank('vertical duplicate')
  flow.nodes = { [vertical.id]: vertical, [top.id]: top, [below.id]: below }; flow.pages[0].children = [vertical.id]
  const flowEditor = new Editor(flow); editors.push(flowEditor)
  const gapY = flowEditor.state.doc.nodes[vertical.id].layout!.gap
  const topY = flowEditor.state.doc.nodes[top.id].transform[5]
  const belowY = flowEditor.state.doc.nodes[below.id].transform[5]
  flowEditor.select([top.id]); flowEditor.duplicate()
  const down = flowEditor.state.selection[0]
  expect(flowEditor.state.doc.nodes[vertical.id].children).toEqual([top.id, down, below.id])
  expect(flowEditor.state.doc.nodes[down].transform[5]).toBeCloseTo(topY + flowEditor.state.doc.nodes[top.id].height + gapY, 6)
  expect(flowEditor.state.doc.nodes[below.id].transform[5]).toBeCloseTo(belowY + flowEditor.state.doc.nodes[down].height + gapY, 6)
  expect(flowEditor.state.doc.nodes[down].transform[4]).toBeCloseTo(flowEditor.state.doc.nodes[top.id].transform[4], 6)
})

test('Sketch duplicate keeps the +10,+10 step for frames, sections, and shapes', () => {
  interfacePreference.set({ uiMode: 'sketch' })
  const doc = blank('sketch steps'), frame = node('frame', 10, 20, 100, 80)
  const section = node('section', 30, 40, 90, 70), shape = node('rectangle', 4, 6, 12, 12)
  const inner = node('frame', 8, 9, 40, 30)
  section.children = [inner.id]
  doc.nodes = Object.fromEntries([frame, section, shape, inner].map(n => [n.id, n]))
  doc.pages[0].children = [frame.id, section.id, shape.id]
  const editor = new Editor(doc); editors.push(editor)
  const width = section.width
  for (const id of [frame.id, section.id, shape.id, inner.id]) {
    editor.select([id])
    const before = worldMatrix(editor.state.doc, id)
    editor.duplicate()
    const after = worldMatrix(editor.state.doc, editor.state.selection[0])
    expect(after[4] - before[4]).toBeCloseTo(10, 8)
    expect(after[5] - before[5]).toBeCloseTo(10, 8)
    editor.undo()
  }
  expect(editor.state.doc.nodes[section.id].width).toBe(width)
})
