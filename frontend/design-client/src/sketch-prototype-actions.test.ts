import { expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, node } from './model'
import {
  canConvertToHotspot, canRemovePrototypeLinks, canSetPrototypeStart,
  convertSelectionToHotspot, removePrototypeLinks, setPrototypeStart,
} from './sketch-prototype-actions'

function fixture() {
  const doc = blank('Prototype actions')
  const frame = node('frame', 0, 0, 320, 640)
  frame.name = 'Home'
  const other = node('frame', 360, 0, 320, 640)
  other.name = 'Detail'
  const button = node('rectangle', 20, 30, 80, 40)
  button.name = 'Button'
  doc.nodes[frame.id] = frame
  doc.nodes[other.id] = other
  doc.nodes[button.id] = button
  doc.pages[0].children = [frame.id, other.id, button.id]
  return { editor: new Editor(doc), frame, other, button }
}

test('Use Frame as Start Point commits one undoable prototype edit', () => {
  const { editor, frame, button } = fixture()
  try {
    editor.select([button.id])
    expect(canSetPrototypeStart(editor)).toBe(false)
    expect(setPrototypeStart(editor)).toBe(false)
    editor.select([frame.id])
    expect(canSetPrototypeStart(editor)).toBe(true)
    expect(setPrototypeStart(editor)).toBe(true)
    expect(editor.state.doc.prototype?.startNode).toBe(frame.id)
    editor.undo()
    expect(editor.state.doc.prototype?.startNode).toBeUndefined()
    editor.select([frame.id])
    editor.updateProperties([frame.id], value => { value.locked = true })
    expect(canSetPrototypeStart(editor)).toBe(false)
  } finally { editor.dispose() }
})

test('Convert to Hotspot Layer reuses the importer metadata and stays undoable', () => {
  const { editor, frame, button } = fixture()
  try {
    editor.select([frame.id])
    expect(canConvertToHotspot(editor)).toBe(false)
    editor.select([button.id])
    expect(canConvertToHotspot(editor)).toBe(true)
    expect(convertSelectionToHotspot(editor)).toBe(true)
    const hotspot = editor.state.doc.nodes[button.id]
    expect(hotspot.fills).toEqual([])
    expect(hotspot.strokes).toEqual([])
    expect((editor.state.doc.designSystem?.sketchContainers?.nodeMetadata as Record<string, unknown> | undefined)?.[button.id])
      .toEqual({ bindings: { sketchSourceHotspot: 'true' } })
    expect(editor.state.doc.prototype?.interactions[button.id]).toEqual([{ trigger: 'click', actions: [] }])
    expect(canConvertToHotspot(editor)).toBe(false)
    editor.undo()
    expect(editor.state.doc.nodes[button.id].fills.length).toBeGreaterThan(0)
    expect((editor.state.doc.designSystem?.sketchContainers?.nodeMetadata as Record<string, unknown> | undefined)?.[button.id])
      .toBeUndefined()
  } finally { editor.dispose() }
})

test('Remove Links drops only the selected interactions and keeps undo history', () => {
  const { editor, frame, button } = fixture()
  try {
    editor.change('author links', draft => {
      draft.prototype = {
        startNode: frame.id,
        interactions: {
          [button.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: frame.id }] }],
          [frame.id]: [{ trigger: 'click', actions: [{ kind: 'navigate', target: frame.id }] }],
        },
      }
    })
    editor.select([button.id])
    expect(canRemovePrototypeLinks(editor)).toBe(true)
    expect(removePrototypeLinks(editor)).toBe(true)
    expect(editor.state.doc.prototype?.interactions?.[button.id]).toBeUndefined()
    expect(editor.state.doc.prototype?.interactions?.[frame.id]).toEqual([{ trigger: 'click', actions: [{ kind: 'navigate', target: frame.id }] }])
    expect(editor.state.doc.prototype?.startNode).toBe(frame.id)
    editor.undo()
    expect(editor.state.doc.prototype?.interactions?.[button.id]).toHaveLength(1)
  } finally { editor.dispose() }
})