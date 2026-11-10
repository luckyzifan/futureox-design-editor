import { afterEach, expect, test } from 'vitest'
import { canvasMarqueeSelection, marqueeReleasePlan } from './canvas-selection-workflows'
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
