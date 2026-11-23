import { afterEach, expect, test } from 'vitest'
import { canvasMarqueeSelection, marqueeReleasePlan, marqueeUsesMatchingSelection } from './canvas-selection-workflows'
import { canEnterOutlineEdit, deepSelectChord, doubleClickFollowUp, enterKeyEditsOutline, enterKeyEditsText } from './figma-basic-ops'
import { Editor } from './engine'
import { blank, node } from './model'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))

test('double-click edits text, drills containers, and enters an already selected outline', () => {
  const text = { id: 't', kind: 'text' }
  const frame = { id: 'f', kind: 'frame' }
  const rect = { id: 'r', kind: 'rectangle' }
  const ellipse = { id: 'e', kind: 'ellipse' }
  const vector = { id: 'v', kind: 'vector', network: { vertices: [], edges: [] } }
  const instance = { id: 'i', kind: 'frame', instance: { componentId: 'c' } }
  const locked = { id: 'l', kind: 'rectangle', locked: true }
  expect(doubleClickFollowUp({ id: 't', changed: true }, text, true)).toBe('edit-text')
  expect(doubleClickFollowUp({ id: 't', changed: false }, text, true)).toBe('edit-text')
  expect(doubleClickFollowUp({ id: 'f', changed: true }, frame, true)).toBe('select')
  expect(doubleClickFollowUp({ id: 'r', changed: true }, rect, true)).toBe('select')
  expect(doubleClickFollowUp({ id: 'r', changed: false }, rect, true)).toBe('edit-vector')
  expect(doubleClickFollowUp({ id: 'e', changed: false }, ellipse, true)).toBe('edit-vector')
  expect(doubleClickFollowUp({ id: 'v', changed: true }, vector, true)).toBe('select')
  expect(doubleClickFollowUp({ id: 'v', changed: false }, vector, true)).toBe('edit-vector')
  expect(doubleClickFollowUp({ id: 'i', changed: false }, instance, true)).toBe('instance')
  expect(doubleClickFollowUp({ id: 'i', changed: true }, instance, true)).toBe('select')
  expect(doubleClickFollowUp({ id: 'l', changed: false }, locked, true)).toBe('select')
  expect(doubleClickFollowUp({ id: 't', changed: false }, text, false)).toBe('select')
  expect(doubleClickFollowUp(null, text, true)).toBe('select')
  for (const kind of ['polygon', 'star', 'line'])
    expect(doubleClickFollowUp({ id: kind, changed: false }, { id: kind, kind }, true)).toBe('edit-vector')
  for (const kind of ['frame', 'section', 'group', 'slice', 'text'])
    expect(canEnterOutlineEdit({ kind })).toBe(false)
  expect(canEnterOutlineEdit({ kind: 'rectangle', instanceOrigin: { owner: 'i' } })).toBe(false)
  expect(enterKeyEditsOutline(['r'], ['r'], rect)).toBe(true)
  expect(enterKeyEditsOutline(['r', 'e'], ['r', 'e'], rect)).toBe(false)
  expect(enterKeyEditsOutline(['l'], [], locked)).toBe(false)
  expect(enterKeyEditsOutline(['v'], ['v'], vector)).toBe(true)
})

test('deep select is Command on Mac and Control elsewhere', () => {
  expect(deepSelectChord({ metaKey: true, ctrlKey: false }, 'mac')).toBe(true)
  expect(deepSelectChord({ metaKey: false, ctrlKey: true }, 'mac')).toBe(false)
  expect(deepSelectChord({ metaKey: false, ctrlKey: true }, 'windows')).toBe(true)
  expect(deepSelectChord({ metaKey: true, ctrlKey: false }, 'linux')).toBe(false)
})

test('Enter edits only a selected text layer', () => {
  expect(enterKeyEditsText({ kind: 'text' }, false)).toBe(true)
  expect(enterKeyEditsText({ kind: 'text' }, true)).toBe(false)
  expect(enterKeyEditsText({ kind: 'rectangle' }, false)).toBe(false)
  expect(enterKeyEditsText({ kind: 'frame' }, false)).toBe(false)
  expect(enterKeyEditsText(null, false)).toBe(false)
})

test('marquee commits only past the drag threshold and Figma Shift adds from either end', () => {
  expect(marqueeReleasePlan({
    sketch: false, shift: false, alt: true, deep: false, multiselect: false,
    startedAdditive: false, passedThreshold: false,
  })).toEqual({ apply: false })
  expect(marqueeReleasePlan({
    sketch: false, shift: true, alt: true, deep: true, multiselect: false,
    startedAdditive: false, passedThreshold: true,
  })).toEqual({ apply: true, deep: true, contained: false, additive: true, toggle: false })
  expect(marqueeReleasePlan({
    sketch: false, shift: false, alt: false, deep: false, multiselect: false,
    startedAdditive: true, passedThreshold: true,
  })).toMatchObject({ apply: true, additive: true })
  const sketch = marqueeReleasePlan({
    sketch: true, shift: false, alt: true, deep: false, multiselect: false,
    startedAdditive: true, passedThreshold: true,
  })
  expect(sketch).toMatchObject({ apply: true, contained: true, additive: false, toggle: false })
})

test('a page marquee selects frames, and Cmd marquee selects nested leaves', () => {
  const document = blank()
  const frame = node('frame', 40, 40, 200, 120), child = node('rectangle', 16, 16, 40, 24)
  const outside = node('rectangle', 400, 40, 30, 30)
  frame.children = [child.id]
  for (const n of [frame, child, outside]) document.nodes[n.id] = n
  document.pages[0].children = [frame.id, outside.id]
  const editor = new Editor(document); editors.push(editor)
  const area = { x: 0, y: 0, width: 800, height: 400 }
  const entries = editor.entries()
  const shallow = canvasMarqueeSelection(document, document.pages[0].id, [], entries, area, {
    deep: false, contained: false, additive: false, toggle: false,
  })
  expect(shallow.sort()).toEqual([frame.id, outside.id].sort())
  const deep = canvasMarqueeSelection(document, document.pages[0].id, [], entries, area, {
    deep: true, contained: false, additive: false, toggle: false,
  })
  expect(deep.sort()).toEqual([child.id, outside.id].sort())
  expect(editor.selectionHit({ x: 70, y: 70 })).toBe(child.id)
  expect(editor.selectionHit({ x: 45, y: 45 })).toBe(frame.id)
  expect(editor.selectionHit({ x: 70, y: 70 }, true)).toBe(child.id)
  expect(editor.selectionHit({ x: 45, y: 45 }, true)).toBe(frame.id)
  expect(editor.canUndo).toBe(false)
})

test('a page marquee selects the group, and Cmd marquee selects the child inside it', () => {
  const document = blank()
  const group = node('group', 40, 40, 80, 80), child = node('rectangle', 10, 10, 30, 30)
  const beside = node('rectangle', 200, 40, 20, 20)
  group.children = [child.id]
  for (const n of [group, child, beside]) document.nodes[n.id] = n
  document.pages[0].children = [group.id, beside.id]
  const editor = new Editor(document); editors.push(editor)
  const area = { x: 30, y: 30, width: 100, height: 100 }
  const entries = editor.entries()
  const shallow = canvasMarqueeSelection(document, document.pages[0].id, [], entries, area, {
    deep: false, contained: false, additive: false, toggle: false,
  })
  expect(shallow).toEqual([group.id])
  const deep = canvasMarqueeSelection(document, document.pages[0].id, [beside.id], entries, area, {
    deep: true, contained: false, additive: true, toggle: false,
  })
  expect(deep.sort()).toEqual([beside.id, child.id].sort())
  expect(editor.selectionHit({ x: 60, y: 60 })).toBe(group.id)
  editor.select([child.id])
  expect(editor.selectionHit({ x: 60, y: 60 })).toBe(child.id)
  expect(editor.canUndo).toBe(false)
})

test('Figma Shift marquee toggles matching layers across frames and leaves ordinary marquees alone', () => {
  const document = blank()
  const frames = [node('frame', 0, 0, 200, 160), node('frame', 320, 0, 200, 160)]
  const rows = frames.map(() => node('group', 16, 16, 150, 100))
  const icons = frames.map(() => node('rectangle', 8, 8, 80, 16))
  const other = node('rectangle', 8, 40, 40, 24)
  const duplicate = frames.map(() => [node('rectangle', 8, 70, 30, 16), node('rectangle', 48, 70, 30, 16)])
  frames.forEach((frame, index) => {
    frame.name = `Screen ${index}`
    rows[index].name = 'Row'
    icons[index].name = 'Icon'
    duplicate[index].forEach(item => { item.name = 'Dot' })
    rows[index].children = [icons[index].id, ...duplicate[index].map(item => item.id)]
    frame.children = [rows[index].id]
  })
  rows[1].children = [icons[1].id, other.id, ...duplicate[1].map(item => item.id)]
  other.name = 'Other'
  const sectionA = node('section', 0, 400, 240, 180), sectionB = node('section', 320, 400, 240, 180)
  const sectionFrames = [node('frame', 20, 20, 160, 120), node('frame', 20, 20, 160, 120)]
  const sectionIcons = [node('rectangle', 12, 12, 80, 16), node('rectangle', 12, 12, 80, 16)]
  sectionIcons.forEach(icon => { icon.name = 'Icon' })
  sectionFrames.forEach((frame, index) => {
    frame.children = [sectionIcons[index].id]
    ;(index === 0 ? sectionA : sectionB).children = [frame.id]
  })
  const locked = node('rectangle', 8, 8, 80, 16)
  locked.name = 'Icon'
  locked.locked = true
  const lockedFrame = node('frame', 640, 0, 160, 120)
  lockedFrame.children = [locked.id]
  const nodes = [frames, rows, icons, other, duplicate.flat(), sectionA, sectionB, sectionFrames, sectionIcons, locked, lockedFrame].flat()
  for (const item of nodes) document.nodes[item.id] = item
  document.pages[0].children = [frames[0].id, frames[1].id, sectionA.id, sectionB.id, lockedFrame.id]
  const editor = new Editor(document); editors.push(editor)
  const entries = editor.entries()
  const page = document.pages[0].id
  const options = { deep: false, contained: false, additive: true, toggle: false, matching: true }
  const across = { x: 300, y: -10, width: 250, height: 200 }
  const added = canvasMarqueeSelection(document, page, [icons[0].id], entries, across, options)
  expect(added.sort()).toEqual([icons[0].id, icons[1].id].sort())
  expect(added).not.toContain(other.id)
  expect(added).not.toContain(frames[1].id)
  const removed = canvasMarqueeSelection(document, page, added, entries, { x: 330, y: 20, width: 90, height: 30 }, options)
  expect(removed).toEqual([icons[0].id])
  const secondDot = canvasMarqueeSelection(document, page, [duplicate[0][1].id], entries, across, options)
  expect(secondDot.sort()).toEqual([duplicate[0][1].id, duplicate[1][1].id].sort())
  expect(secondDot).not.toContain(duplicate[1][0].id)
  const sections = canvasMarqueeSelection(document, page, [sectionIcons[0].id], entries, { x: 300, y: 380, width: 400, height: 220 }, options)
  expect(sections).toEqual([sectionIcons[0].id])
  const lockedOnly = canvasMarqueeSelection(document, page, [icons[0].id], entries, { x: 620, y: -10, width: 200, height: 180 }, options)
  expect(lockedOnly).toEqual([icons[0].id])
  const deep = canvasMarqueeSelection(document, page, [icons[0].id], entries, across, { ...options, deep: true, matching: true })
  expect(deep.sort()).toEqual([icons[0].id, icons[1].id, other.id, ...duplicate[1].map(item => item.id)].sort())
  const top = canvasMarqueeSelection(document, page, [frames[0].id], entries, across, options)
  expect(top.sort()).toEqual([frames[0].id, frames[1].id].sort())
  expect(marqueeUsesMatchingSelection({ sketch: false, deep: false, shift: true, startedWithShift: false })).toBe(true)
  expect(marqueeUsesMatchingSelection({ sketch: false, deep: true, shift: true, startedWithShift: true })).toBe(false)
  expect(marqueeUsesMatchingSelection({ sketch: true, deep: false, shift: true, startedWithShift: true })).toBe(false)
  expect(editor.canUndo).toBe(false)
})
