import { expect, test } from 'vitest'
import { canDeletePage, userPages } from './fig-document'
import { applyFigDocumentSemantics } from './import-fig-document'
import { blank, node, uid, validateDocument, type Paint } from './model'

test('a hidden Figma page stays in the file and cannot be the last deleted page', () => {
  const doc = blank('File')
  doc.schemaVersion = 4
  const hidden = { ...doc.pages[0], id: uid(), name: 'Internal', children: [] }
  const cover = { ...doc.pages[0], id: uid(), name: 'Cover', children: [] }
  doc.pages = [hidden, cover]
  doc.designSystem = { collections: {}, variables: {}, activeModes: {}, styles: {}, libraries: {}, sketchContainers: { figDocument: { source: 'figma', internalPages: [hidden.id] } } }
  expect(userPages(doc).map(page => page.name)).toEqual(['Cover'])
  expect(userPages(doc)[0].id).toBe(cover.id)
  expect(canDeletePage(doc, cover.id)).toBe(false)
  expect(canDeletePage(doc, hidden.id)).toBe(true)
  expect(doc.pages).toHaveLength(2)
})

test('Figma document name, shared styles, and component sets survive validation', () => {
  const doc = blank('filename')
  const set = node('frame', 0, 0, 120, 40)
  set.name = 'Button'
  const small = node('frame', 0, 0, 40, 20)
  small.name = 'Size=Small'
  small.component = { variants: {}, properties: {} }
  const large = node('frame', 0, 0, 70, 20)
  large.name = 'Size=Large'
  large.component = { variants: {}, properties: {} }
  set.children = [small.id, large.id]
  const chip = node('rectangle', 0, 0, 20, 12)
  doc.nodes = { [set.id]: set, [small.id]: small, [large.id]: large, [chip.id]: chip }
  doc.pages[0].children = [set.id, chip.id]
  const styleKey = '4:7'
  const records = new Map<string, Record<string, unknown>>([
    ['1:1', { type: 'DOCUMENT', name: 'Brand kit', guid: { sessionID: 1, localID: 1 }, documentColorProfile: 'SRGB' }],
    ['1:2', { type: 'CANVAS' }],
    [styleKey, { type: 'RECTANGLE', name: 'Swatch', styleType: 'FILL', fillPaints: [{ type: 'SOLID' }] }],
    ['chip', { type: 'RECTANGLE', inheritFillStyleID: { sessionID: 4, localID: 7 }, componentKey: 'chip-key', boundVariables: { fill: 'color' } }],
    ['set', { type: 'COMPONENT_SET' }],
    ['small', { type: 'SYMBOL', componentKey: 'pub-small' }],
    ['large', { type: 'SYMBOL' }],
  ])
  const ids = new Map([['1:2', doc.pages[0].id], ['set', set.id], ['small', small.id], ['large', large.id], [styleKey, uid()], ['chip', chip.id]])
  const guid = (value: unknown) => {
    const guide = value as { sessionID?: number; localID?: number } | undefined
    return guide ? `${guide.sessionID}:${guide.localID}` : ''
  }
  const paint: Paint = { id: uid(), kind: 'solid', color: '#336699', opacity: 1, visible: true, angle: 0, stops: [], fit: 'cover', blend: 'normal' }
  applyFigDocumentSemantics(doc, records, ids, guid, {
    toPaint: () => paint,
    effectsOf: () => [],
    strokesOf: () => [],
    fallbackName: 'filename',
  }, { add() { return undefined } })
  doc.schemaVersion = 4
  validateDocument(doc)
  expect(doc.name).toBe('Brand kit')
  expect(set.componentSet).toBe(true)
  expect(set.component).toBeUndefined()
  expect(small.component?.variants).toEqual({ Size: 'Small' })
  expect(large.component?.variants).toEqual({ Size: 'Large' })
  expect(chip.styleRefs?.fills).toBe(ids.get(styleKey))
  expect(doc.designSystem?.styles[ids.get(styleKey)!]).toMatchObject({ name: 'Swatch', kind: 'paint' })
  expect(chip.bindings?.figComponentKey).toBe('chip-key')
  expect(chip.bindings?.figBoundVariables).toContain('color')
  const reopened = validateDocument(JSON.parse(JSON.stringify(doc)))
  expect(reopened.designSystem?.sketchContainers?.figDocument).toMatchObject({
    source: 'figma', documentId: '1:1', colorProfile: 'SRGB',
  })
  expect(reopened.nodes[small.id].component?.variants).toEqual({ Size: 'Small' })
})
