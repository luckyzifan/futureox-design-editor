// Mounted text editor plus real Editor/WASM. jsdom keyboard events, not macOS key delivery.
// @ts-expect-error jsdom is a test-only runtime dependency.
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { CanvasTextEditor } from './TextEditor'
import { Editor } from './engine'
import { blank, defaultTextStyle, node } from './model'
import { closeCanvasActions } from './canvas-action-diagnostics'
import { interfacePreference } from './interface-preference'

let dom: JSDOM, mount: HTMLDivElement, root: Root, editor: Editor
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://design.invalid/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLInputElement', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent']) {
    vi.stubGlobal(key, key === 'window' ? dom.window : dom.window[key as 'document'])
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  interfacePreference.reset()
  mount = document.createElement('div')
  document.body.append(mount)
  root = createRoot(mount)
})
afterEach(async () => {
  await act(async () => root.unmount())
  closeCanvasActions(editor)
  editor.dispose()
  interfacePreference.reset()
  dom.window.close()
  vi.unstubAllGlobals()
})
function open(text = 'Hello', sibling = false) {
  const doc = blank('Edit'), layer = node('text', 0, 0, 160, 40)
  layer.text = text
  layer.fontSize = 16
  layer.textStyle = defaultTextStyle()
  doc.nodes[layer.id] = layer
  doc.pages[0].children = [layer.id]
  if (sibling) {
    const shape = node('rectangle', 200, 0, 20, 20)
    doc.nodes[shape.id] = shape
    doc.pages[0].children.push(shape.id)
  }
  editor = new Editor(doc)
  editor.select([layer.id])
  return layer
}
async function render() {
  const layer = editor.state.doc.nodes[editor.state.selection[0]]
  await act(async () => root.render(<CanvasTextEditor node={layer} document={editor.state.doc} editor={editor} matrix={[1, 0, 0, 1, 0, 0]} onClose={vi.fn()} onPreview={vi.fn()} />))
  const input = mount.querySelector('textarea')!
  expect(document.activeElement).toBe(input)
  return input
}
async function press(input: HTMLTextAreaElement, value: string, code: string, modifiers: KeyboardEventInit = {}) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: value, code, bubbles: true, cancelable: true, ...modifiers }))
  })
}

test('editing text applies the Figma chords and Cmd+Z restores that step', async () => {
  const layer = open()
  const input = await render()
  input.setSelectionRange(0, layer.text.length)
  await press(input, '<', 'Comma', { metaKey: true, shiftKey: true })
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(15)
  await press(input, 'z', 'KeyZ', { metaKey: true })
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(16)
  expect(editor.canUndo).toBe(false)

  input.setSelectionRange(0, layer.text.length)
  await press(input, 'u', 'KeyU', { altKey: true })
  expect(editor.state.doc.nodes[layer.id].textRuns).toEqual([{ start: 0, end: 5, underline: true }])
  await press(input, 'z', 'KeyZ', { metaKey: true })
  expect(editor.state.doc.nodes[layer.id].textRuns).toBeUndefined()

  input.setSelectionRange(0, layer.text.length)
  await press(input, '*', 'Digit8', { metaKey: true, shiftKey: true })
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBe('bullet')
  expect(editor.state.doc.nodes[layer.id].text).toBe('Hello')
  await press(input, 'z', 'KeyZ', { metaKey: true })
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBeUndefined()
  expect(editor.state.doc.nodes[layer.id].text).toBe('Hello')
  await press(input, '*', 'Digit8', { metaKey: true, shiftKey: true })
  await press(input, ']', 'BracketRight', { metaKey: true })
  expect(editor.state.doc.nodes[layer.id].textStyle?.listLevel).toBe(1)
  expect(editor.state.doc.pages[0].children).toEqual([layer.id])
  await press(input, '[', 'BracketLeft', { metaKey: true })
  expect(editor.state.doc.nodes[layer.id].textStyle?.listLevel).toBeUndefined()
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBe('bullet')
})

test('bracket chords reorder a layer that is not a list', async () => {
  const layer = open('Hello', true)
  const before = [...editor.state.doc.pages[0].children]
  const input = await render()
  await press(input, ']', 'BracketRight', { metaKey: true })
  expect(editor.state.doc.pages[0].children).toEqual([before[1], before[0]])
  expect(editor.state.doc.nodes[layer.id].textStyle?.list).toBeUndefined()
  expect(editor.state.doc.nodes[layer.id].fontSize).toBe(16)
})
