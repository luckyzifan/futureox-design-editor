import { afterEach, expect, test } from 'vitest'
import { Editor } from './engine'
import { blank, defaultTextStyle, node, paint } from './model'
import { PageResidencyCache } from './kernel/page-residency-cache'
import { applySelectionFont } from './font-management'
import { fontTestBytes } from './font-test-fixtures'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach(editor => editor.dispose()))
function fixture() {
  const document = blank(), second = blank().pages[0]
  const text = node('text', 0, 0, 100, 30)
  text.text = 'ABC'; text.textStyle = defaultTextStyle()
  document.nodes[text.id] = text; document.pages[0].children.push(text.id)
  document.pages.push(second)
  const editor = new Editor(document); editors.push(editor)
  return { editor, first: editor.state.page, second: second.id, text: text.id }
}

test('real Editor.switchPage and snapshot preserve the exact document witness across repeated revisits', () => {
  const { editor, first, second } = fixture(), document = editor.snapshot().doc
  const version = editor.state.version, session = editor.sessionGeneration
  const cache = new PageResidencyCache<object>(), pixels = {}
  cache.synchronize(document, String(session))
  for (let i = 0; i < 5; i++) {
    cache.store(first, [pixels], 4)
    editor.switchPage(second)
    expect(editor.snapshot().doc).toBe(document)
    expect(cache.synchronize(editor.snapshot().doc, String(editor.sessionGeneration))).toBe(false)
    editor.switchPage(first)
    expect(editor.snapshot().doc).toBe(document)
    expect(cache.take(first)?.[0]).toBe(pixels)
  }
  expect(editor.state.version).toBe(version)
  expect(editor.sessionGeneration).toBe(session)
  expect(editor.canUndo).toBe(false)
})

test('real embedded font import and undo/redo publish a new document witness without mutating previous resources', () => {
  const { editor, text } = fixture(), before = editor.snapshot().doc
  const resource = { family: 'Noto Latin', data: fontTestBytes('noto-latin').toString('base64'), index: 0 }
  const result = applySelectionFont(editor, [text], 'imported-latin', {}, resource)
  expect(result.status).toBe('committed')
  const edited = editor.snapshot().doc
  expect(edited).not.toBe(before)
  expect(before.fonts?.['imported-latin']).toBeUndefined()
  expect(edited.fonts?.['imported-latin'].data).toBe(resource.data)
  const cache = new PageResidencyCache<object>()
  cache.synchronize(edited, 'session'); cache.store('page', [{}], 4)
  editor.undo()
  expect(editor.snapshot().doc).not.toBe(edited)
  expect(cache.synchronize(editor.snapshot().doc, 'session')).toBe(true)
  const undone = editor.snapshot().doc
  cache.store('page', [{}], 4); editor.redo()
  expect(editor.snapshot().doc).not.toBe(undone)
  expect(cache.synchronize(editor.snapshot().doc, 'session')).toBe(true)
})

test('real image update publishes immutable resource bytes under a new document witness', () => {
  const { editor } = fixture()
  const id = editor.add('rectangle', { x: 0, y: 0, width: 10, height: 10 })
  const before = editor.snapshot().doc
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  editor.update([id], { fills: [{ ...paint('#ffffff', 'image'), image }] }, '导入图片')
  expect(editor.snapshot().doc).not.toBe(before)
  expect(before.nodes[id].fills[0].image).toBeUndefined()
  expect(editor.snapshot().doc.nodes[id].fills[0].image).toBe(image)
})
