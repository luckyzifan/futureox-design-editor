import { afterEach, expect, test, vi } from 'vitest'
import { Editor } from './engine'
import { dispatchEditorShortcut } from './editor-shortcuts'
import { interfaceLayoutFromShortcut } from './interface-layout'
import { adjacentLayerFindResult, layerFindResults, layerFindType, locateLayerFindResult, type LayerFindOptions } from './layer-find'
import { topPerformanceFindDocument } from './layer-find-fixture'
import { closeLayerFind, layerFindRefocus, layerFindSnapshot } from './layer-find-session'
import { blank, node, paint, type DesignDocument } from './model'
import { resolveShortcut, type ShortcutContext, type ShortcutKey } from './shortcut-profiles'

const editors: Editor[] = []
afterEach(() => { closeLayerFind(); editors.splice(0).forEach(editor => editor.dispose()) })
function editorFor(doc: DesignDocument) {
  const editor = new Editor(doc)
  editors.push(editor)
  return editor
}
const desktop: ShortcutContext = { profile: 'figma-like', platform: 'mac', desktop: true }
function key(value: string, overrides: Partial<ShortcutKey> & { target?: EventTarget | null } = {}) {
  return {
    key: value, code: value.length === 1 ? `Key${value.toUpperCase()}` : value,
    ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, target: null, preventDefault: vi.fn(), ...overrides,
  }
}
function options(doc: DesignDocument, patch: Partial<LayerFindOptions> = {}): LayerFindOptions {
  return { query: 'Top Performance', scope: 'page', pageId: doc.pages[0].id, matchCase: false, wholeWords: false, types: new Set(), ...patch }
}

test('fixture text and same-named group stay in panel order on this page and across pages', () => {
  const fixture = topPerformanceFindDocument()
  const page = layerFindResults(fixture.doc, options(fixture.doc))
  expect(page.map(result => [result.type, result.id, result.name])).toEqual([
    ['group', fixture.groupId, 'Top Performance'],
    ['text', fixture.textId, 'Top Performance'],
  ])
  expect(page.some(result => result.id === fixture.frameId)).toBe(false)
  const all = layerFindResults(fixture.doc, options(fixture.doc, { scope: 'file' }))
  expect(all.map(result => [result.pageId, result.type, result.id])).toEqual([
    [fixture.pageId, 'group', fixture.groupId],
    [fixture.pageId, 'text', fixture.textId],
    [fixture.otherPageId, 'text', fixture.otherTextId],
  ])
  expect(layerFindResults(fixture.doc, options(fixture.doc, { scope: 'page', pageId: fixture.otherPageId })).map(result => result.id)).toEqual([fixture.otherTextId])
})

test('freeform siblings use panel order, and text copy matches without a matching name', () => {
  const doc = blank('Order'), frame = node('frame'), back = node('text'), front = node('text'), label = node('text')
  back.name = 'Alpha'; back.text = 'Alpha'
  front.name = 'Alpha'; front.text = 'Alpha'
  label.name = 'Label'; label.text = 'Top Performance'
  frame.children = [back.id, front.id, label.id]
  doc.nodes[frame.id] = frame; doc.nodes[back.id] = back; doc.nodes[front.id] = front; doc.nodes[label.id] = label
  doc.pages[0].children = [frame.id]
  const found = layerFindResults(doc, options(doc, { query: 'Alpha' }))
  expect(found.map(result => result.id)).toEqual([front.id, back.id])
  const copy = layerFindResults(doc, options(doc))
  expect(copy.map(result => [result.type, result.id, result.name])).toEqual([['text', label.id, 'Label']])
  expect(doc.nodes[label.id]).toBe(label)
})

test('match case, whole words, and type filters classify without copying the document', () => {
  const doc = blank('Filters')
  const group = node('group'); group.name = 'Top Performance'
  const text = node('text'); text.name = 'Top Performance'; text.text = 'Top Performance'
  const lower = node('text'); lower.name = 'top performance'; lower.text = 'top performance'
  const glued = node('text'); glued.name = 'TopPerformance'; glued.text = 'TopPerformance'
  const shape = node('rectangle'); shape.name = 'Top Performance'
  const image = node('rectangle'); image.name = 'Top Performance'; image.fills = [{ ...paint(), kind: 'image' }]
  const component = node('frame'); component.name = 'Top Performance'; component.component = { variants: {}, properties: {} }
  const instance = node('frame'); instance.name = 'Top Performance'
  instance.instance = { componentId: component.id, overrides: {}, propertyValues: {} }
  const hidden = node('group'); hidden.name = 'Top Performance'; hidden.visible = false
  for (const item of [group, text, lower, glued, shape, image, component, instance, hidden]) doc.nodes[item.id] = item
  doc.pages[0].children = [group.id, text.id, lower.id, glued.id, shape.id, image.id, component.id, instance.id, hidden.id]
  const all = layerFindResults(doc, options(doc))
  expect(all.map(result => result.id)).toEqual([hidden.id, instance.id, component.id, image.id, shape.id, lower.id, text.id, group.id])
  expect(all.map(result => result.type)).toEqual(['group', 'instance', 'component', 'image', 'shape', 'text', 'text', 'group'])
  expect(all.map(result => result.id)).not.toContain(glued.id)
  expect(layerFindResults(doc, options(doc, { matchCase: true })).map(result => result.id)).not.toContain(lower.id)
  expect(layerFindResults(doc, options(doc, { matchCase: true })).map(result => result.id)).toContain(text.id)
  expect(layerFindResults(doc, options(doc, { query: 'top performance', matchCase: true })).map(result => result.id)).toEqual([lower.id])
  expect(layerFindResults(doc, options(doc, { query: 'Perf' })).map(result => result.id)).toContain(text.id)
  expect(layerFindResults(doc, options(doc, { query: 'Perf', wholeWords: true }))).toEqual([])
  expect(layerFindResults(doc, options(doc, { query: 'Top', wholeWords: true })).map(result => result.id)).toEqual([hidden.id, instance.id, component.id, image.id, shape.id, lower.id, text.id, group.id])
  expect(layerFindResults(doc, options(doc, { query: 'Top', wholeWords: true })).map(result => result.id)).not.toContain(glued.id)
  expect(layerFindResults(doc, options(doc, { types: new Set(['text']) })).map(result => result.id)).toEqual([lower.id, text.id])
  expect(layerFindResults(doc, options(doc, { types: new Set(['group']) })).map(result => result.id)).toEqual([hidden.id, group.id])
  expect(layerFindType(image)).toBe('image')
  expect(layerFindType(shape)).toBe('shape')
  expect(doc.nodes[text.id]).toBe(text)
})

test('next and previous locate the page and layer without writing history', () => {
  const fixture = topPerformanceFindDocument()
  const editor = editorFor(fixture.doc)
  editor.select([fixture.frameId])
  const before = editor.state.doc
  const version = editor.state.version
  const page = layerFindResults(fixture.doc, options(fixture.doc))
  expect(adjacentLayerFindResult(page, null, 1)?.id).toBe(fixture.groupId)
  expect(adjacentLayerFindResult(page, null, -1)?.id).toBe(fixture.textId)
  expect(locateLayerFindResult(editor, page[0])).toBe(true)
  expect(editor.state.selection).toEqual([fixture.groupId])
  expect(editor.state.page).toBe(fixture.pageId)
  expect(locateLayerFindResult(editor, page[1])).toBe(true)
  expect(editor.state.selection).toEqual([fixture.textId])
  expect(adjacentLayerFindResult(page, { id: fixture.groupId, pageId: fixture.pageId }, -1)).toBeNull()
  const all = layerFindResults(fixture.doc, options(fixture.doc, { scope: 'file' }))
  expect(locateLayerFindResult(editor, all[2])).toBe(true)
  expect(editor.state.page).toBe(fixture.otherPageId)
  expect(editor.state.selection).toEqual([fixture.otherTextId])
  expect(editor.revealSnapshot()).toMatchObject({ pageId: fixture.otherPageId, ids: [fixture.otherTextId] })
  expect(editor.state.doc).toBe(before)
  expect(editor.state.version).toBe(version)
  expect(editor.canUndo).toBe(false)
  expect(editor.canRedo).toBe(false)
  editor.set({ page: fixture.pageId, selection: [fixture.frameId] })
  editor.update([fixture.frameId], { name: 'Renamed dashboard' }, '重命名图层')
  const renamed = editor.state.doc
  const renamedVersion = editor.state.version
  expect(editor.canUndo).toBe(true)
  expect(locateLayerFindResult(editor, all[2])).toBe(true)
  expect(editor.state.page).toBe(fixture.otherPageId)
  expect(editor.state.selection).toEqual([fixture.otherTextId])
  expect(editor.state.doc).toBe(renamed)
  expect(editor.state.version).toBe(renamedVersion)
  expect(editor.canUndo).toBe(true)
  editor.undo()
  expect(editor.state.doc.nodes[fixture.frameId].name).toBe('01_Dashboard')
  expect(editor.state.page).toBe(fixture.pageId)
  expect(editor.state.selection).toEqual([fixture.frameId])
  expect(editor.canUndo).toBe(false)
  expect(locateLayerFindResult(editor, { ...all[2], id: 'missing' })).toBe(false)
  expect(editor.state.selection).toEqual([fixture.frameId])
})

test('desktop figma Mod+F opens find and does not edit; browser, sketch, text, and layout chords do not', async () => {
  const fixture = topPerformanceFindDocument()
  const editor = editorFor(fixture.doc)
  editor.select([fixture.frameId])
  const before = editor.state.doc
  expect(resolveShortcut(key('f', { metaKey: true }), desktop)?.command).toBe('open-layer-find')
  expect(resolveShortcut(key('f', { ctrlKey: true }), { profile: 'figma-like', platform: 'linux', desktop: true })?.command).toBe('open-layer-find')
  expect(resolveShortcut(key('f', { metaKey: true }), { ...desktop, desktop: false })).toBeNull()
  expect(resolveShortcut(key('f', { ctrlKey: true }), { profile: 'figma-like', platform: 'windows', desktop: false })).toBeNull()
  expect(resolveShortcut(key('f', { metaKey: true }), { profile: 'sketch-like', platform: 'mac', desktop: true })?.command).toBe('frame-selection')
  expect(resolveShortcut(key('f', { metaKey: true, altKey: true }), desktop)).toBeNull()
  expect(interfaceLayoutFromShortcut({ key: 'f', code: 'KeyF', metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBe('figma')
  const owned = key('f', { metaKey: true, target: { closest: () => ({}) } as unknown as EventTarget })
  expect(await dispatchEditorShortcut(editor, owned, desktop)).toBe(false)
  expect(owned.preventDefault).not.toHaveBeenCalled()
  expect(layerFindSnapshot()).toBe(0)
  expect(await dispatchEditorShortcut(editor, key('f', { metaKey: true }), desktop)).toBe(true)
  const generation = layerFindSnapshot()
  expect(generation).toBeGreaterThan(0)
  const repeated = key('f', { metaKey: true, repeat: true })
  expect(await dispatchEditorShortcut(editor, repeated, desktop)).toBe(true)
  expect(layerFindSnapshot()).toBe(generation)
  expect(layerFindRefocus()).toBe(0)
  expect(await dispatchEditorShortcut(editor, key('f', { metaKey: true }), desktop)).toBe(true)
  expect(layerFindRefocus()).toBe(1)
  expect(editor.state.doc).toBe(before)
  expect(editor.canUndo).toBe(false)
  expect(editor.state.tool).toBe('select')
  closeLayerFind()
  editor.begin('pointer gesture')
  expect(await dispatchEditorShortcut(editor, key('f', { metaKey: true }), desktop)).toBe(true)
  expect(layerFindSnapshot()).toBe(0)
  expect(editor.state.doc).toBe(before)
  editor.cancel()
})
