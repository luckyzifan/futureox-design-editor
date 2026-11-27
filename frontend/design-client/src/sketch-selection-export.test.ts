import { expect, test } from 'vitest'
import { selectedDocument } from './clipboard-core'
import { createMain, insertInstance } from './components'
import { emptySystem } from './design-system'
import { blank, node } from './model'
import { selectedSketchDocument } from './sketch-selection-export'

test('Sketch selection preserves only emitted text font metadata and keeps explicit source overrides', () => {
  const source = blank()
  source.schemaVersion = 4
  const frame = node('frame')
  const label = node('text')
  const masked = node('text')
  const outside = node('text')
  frame.children = [label.id, masked.id]
  source.pages[0].children = [frame.id, outside.id]
  source.nodes = Object.fromEntries([frame, label, masked, outside].map(layer => [layer.id, layer]))
  const rawFonts = JSON.stringify({ style: 'Sketch-Fallback', runs: { 0: 'Sketch-Fallback-Bold' } })
  const rawStyle = JSON.stringify({
    native: { _class: 'fontDescriptor', attributes: { name: 'Sketch-Style', size: 19 } },
    face: 'Sketch-Fallback', size: 28, weight: 400,
  })
  const typed = { style: 'Explicit-Match', runs: { 0: 'Explicit-Match-Bold' }, resolved: ['Explicit-Match'] }
  source.designSystem = {
    ...emptySystem(),
    fontSources: { [label.id]: typed, [masked.id]: {}, [outside.id]: { style: 'Unselected' } },
    sketchContainers: {
      unrelatedContainer: { before: 'ignored' },
      nodeMetadata: {
        [label.id]: { bindings: {
          sketchSourceFonts: rawFonts, sketchSourceStyleFontDescriptor: rawStyle, sketchUnrelatedField: 'ignored',
        } },
        [masked.id]: { bindings: { sketchSourceFonts: rawFonts } },
        [outside.id]: { bindings: { sketchSourceStyleFontDescriptor: rawStyle } },
      },
    },
  }
  const ids = [frame.id, frame.id, label.id]
  const exported = selectedSketchDocument(source, ids, 'Sketch selection')
  expect(exported.pages[0].children).toEqual([frame.id])
  expect(Object.keys(exported.nodes).sort()).toEqual([frame.id, label.id, masked.id].sort())
  expect(exported.designSystem?.sketchContainers).toEqual({
    nodeMetadata: {
      [label.id]: { bindings: { sketchSourceFonts: rawFonts, sketchSourceStyleFontDescriptor: rawStyle } },
      [masked.id]: { bindings: { sketchSourceFonts: rawFonts } },
    },
  })
  expect(exported.designSystem?.fontSources).toEqual({ [label.id]: typed, [masked.id]: {} })
  expect(exported.designSystem?.fontSources?.[label.id]).not.toBe(typed)
  expect(exported.designSystem?.fontSources?.[label.id].runs).not.toBe(typed.runs)
  const generic = selectedDocument(source, ids, 'Clipboard selection').document
  expect(generic.designSystem?.sketchContainers).toBeUndefined()
  expect(generic.designSystem?.fontSources).toBeUndefined()

  const pageId = source.pages[0].id
  const master = createMain(source, [frame.id], pageId)
  const instance = insertInstance(source, master, pageId, { x: 400, y: 0 })
  const withDependency = selectedSketchDocument(source, [label.id, instance, instance], 'Sketch instance selection')
  const remappedText = withDependency.nodes[master].children[0]
  expect(remappedText).not.toBe(label.id)
  expect(source.nodes[remappedText]).toBeUndefined()
  expect(withDependency.designSystem?.fontSources?.[label.id]).toEqual(typed)
  expect(withDependency.designSystem?.fontSources?.[masked.id]).toEqual({})
  expect(withDependency.designSystem?.fontSources?.[remappedText]).toBeUndefined()
  expect(withDependency.designSystem?.sketchContainers?.nodeMetadata).toMatchObject({
    [label.id]: { bindings: { sketchSourceFonts: rawFonts, sketchSourceStyleFontDescriptor: rawStyle } },
  })
  expect(withDependency.designSystem?.sketchContainers?.nodeMetadata).not.toHaveProperty(remappedText)
})
