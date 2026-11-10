import { expect, test } from 'vitest'
import { canDeletePage, userPages } from './fig-document'
import { applyFigDocumentSemantics, importFigVariableNodes } from './import-fig-document'
import { blank, defaultLayout, node, uid, validateDocument, type Paint } from './model'
import { Editor } from './engine'

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
  const metadata = doc.designSystem?.sketchContainers?.nodeMetadata as Record<string, { bindings: Record<string, string> }>
  expect(metadata[chip.id].bindings.figComponentKey).toBe('chip-key')
  expect(metadata[chip.id].bindings.figBoundVariables).toContain('color')
  expect(chip.bindings?.figComponentKey).toBeUndefined()
  expect(chip.bindings?.figBoundVariables).toBeUndefined()
  const reopened = validateDocument(JSON.parse(JSON.stringify(doc)))
  expect(reopened.designSystem?.sketchContainers?.figDocument).toMatchObject({
    source: 'figma', documentId: '1:1', colorProfile: 'SRGB',
  })
  expect(reopened.nodes[small.id].component?.variants).toEqual({ Size: 'Small' })
})

test('FIG provenance remains inert through real editor admission and reload', () => {
  const doc = blank('FIG provenance'), chip = node('rectangle')
  doc.schemaVersion = 4
  doc.nodes[chip.id] = chip
  doc.pages[0].children.push(chip.id)
  const records = new Map([['chip', { type: 'RECTANGLE', componentKey: 'published-component',
    boundVariables: { opacity: { sessionID: 9, localID: 2 } } }]])
  applyFigDocumentSemantics(doc, records, new Map([['chip', chip.id]]), String, {
    toPaint: () => ({}) as Paint, effectsOf: () => [], strokesOf: () => [], fallbackName: doc.name,
  }, { add() {} })
  importFigVariableNodes(doc, records)
  const editor = new Editor(doc)
  try {
    expect(editor.load(JSON.parse(JSON.stringify(editor.authoredDocument)))).toBe(true)
    expect(editor.state.doc.nodes[chip.id].bindings).toBeUndefined()
    expect(editor.state.doc.designSystem?.sketchContainers?.nodeMetadata).toMatchObject({
      [chip.id]: { format: 'fig', bindings: { figComponentKey: 'published-component',
        figBoundVariables: JSON.stringify({ opacity: { sessionID: 9, localID: 2 } }) } },
    })
  } finally { editor.dispose() }
})

test('variable set aliases resolve by publish key and supported fields bind', () => {
  const doc = blank('Tokens')
  doc.schemaVersion = 4
  const chip = node('rectangle', 0, 0, 40, 24)
  doc.nodes = { [chip.id]: chip }
  doc.pages[0].children = [chip.id]
  const records = new Map<string, Record<string, unknown>>([
    ['1:3', { type: 'VARIABLE_SET', name: 'Primitives', key: 'set-key', variableSetModes: [
      { name: 'Light', id: { sessionID: 9, localID: 1 } },
      { name: 'Dark', id: { sessionID: 9, localID: 2 } },
    ] }],
    ['1:4', { type: 'VARIABLE', name: 'Gap', key: 'gap-key', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'set-key' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 8 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 12 } } },
      ] } }],
    ['1:5', { type: 'VARIABLE', name: 'Gap alias', key: 'gap-alias', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'set-key' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
      ] } }],
    ['1:6', { type: 'RECTANGLE', variableConsumptionMap: { entries: [
      { variableField: 'WIDTH', variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
      { variableField: 'RECTANGLE_TOP_LEFT_CORNER_RADIUS', variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
    ] } }],
  ])
  importFigVariableNodes(doc, records, new Map([['1:6', chip.id]]))
  expect(doc.designSystem?.collections['set-key'].modes).toEqual(['Light', 'Dark'])
  expect(doc.designSystem?.variables['1:5'].values.Light).toEqual({ alias: '1:4' })
  expect(doc.designSystem?.variables['1:4'].values.Dark).toBe(12)
  expect(chip.bindings?.width).toBe('1:4')
  expect(chip.bindings?.figVariableConsumption).toBeUndefined()
  expect(doc.designSystem?.sketchContainers?.figDocument).toMatchObject({
    notes: expect.arrayContaining(['FIG variable fields without an executable property are retained as figVariableConsumption']),
  })
  validateDocument(doc)
})

test('node modes and counter-axis bindings follow the variable collection', () => {
  const doc = blank('Modes')
  doc.schemaVersion = 6
  const board = node('frame', 0, 0, 80, 40)
  board.layout = { ...defaultLayout(), mode: 'horizontal', gap: 4 }
  doc.nodes = { [board.id]: board }
  doc.pages[0].children = [board.id]
  const modes = Array.from({ length: 33 }, (_, index) => ({ name: `M${String(index).padStart(2, '0')}`, id: { sessionID: 3, localID: index } }))
  const entries = modes.map((mode, index) => ({ modeID: mode.id, variableData: { value: { floatValue: index + 0.5 } } }))
  const records = new Map<string, Record<string, unknown>>([
    ['1:3', { type: 'VARIABLE_SET', name: 'Primitives', key: 'set-key', variableSetModes: [
      { name: 'Light', id: { sessionID: 9, localID: 1 } },
      { name: 'Dark', id: { sessionID: 9, localID: 2 } },
    ] }],
    ['1:4', { type: 'VARIABLE', name: 'Gap', key: 'gap-key', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'set-key' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 8 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 12 } } },
      ] } }],
    ['1:8', { type: 'VARIABLE', name: 'Paragraph', key: 'para-key', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'set-key' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 3 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 4 } } },
      ] } }],
    ['wide', { type: 'VARIABLE_SET', name: 'Wide', key: 'wide', variableSetModes: modes }],
    ['wide-a', { type: 'VARIABLE', name: 'A', key: 'wide-a', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'wide' } },
      variableDataValues: { entries } }],
    ['wide-b', { type: 'VARIABLE', name: 'B', key: 'wide-b', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'wide' } },
      variableDataValues: { entries: [{ modeID: { sessionID: 3, localID: 0 }, variableData: { value: { floatValue: 7 } } }] } }],
    ['board', { type: 'FRAME', variableConsumptionMap: { entries: [
      { variableField: 'WIDTH', variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
      { variableField: 'STACK_COUNTER_SPACING', variableData: { value: { alias: { assetRef: { key: 'gap-key' } } } } },
      { variableField: 'PARAGRAPH_SPACING', variableData: { value: { alias: { assetRef: { key: 'para-key' } } } } },
    ] }, variableModeBySetMap: { entries: [
      { variableSetID: { assetRef: { key: 'set-key' } }, variableModeID: { sessionID: 9, localID: 2 } },
    ] } }],
  ])
  importFigVariableNodes(doc, records, new Map([['board', board.id]]))
  expect(board.variableModes).toEqual({ 'set-key': 'Dark' })
  expect(board.bindings?.width).toBe('1:4')
  expect(board.bindings?.['layout.lineGap']).toBe('1:4')
  expect(board.bindings?.['layout.lineGap']).not.toBe('1:8')
  expect(doc.designSystem?.collections.wide.modes).toHaveLength(32)
  expect(doc.designSystem?.collections.wide.modes[0]).toBe('M00')
  expect(doc.designSystem?.variables['wide-a'].values.M00).toBe(0.5)
  expect(doc.designSystem?.variables['wide-b'].collection).toBe('wide')
  expect(JSON.stringify(doc.designSystem?.sketchContainers?.figDocument)).toContain('32')
  validateDocument(doc)
})

test('variable set membership follows a nested guid instead of inventing one collection per variable', () => {
  const doc = blank('Theme')
  doc.schemaVersion = 4
  const records = new Map<string, Record<string, unknown>>([
    ['2082:2349', { type: 'VARIABLE_SET', name: 'USWDS Theme', variableSetModes: [
      { name: 'Project theme', id: { sessionID: 1, localID: 1 } },
    ] }],
    ['9:1', { type: 'VARIABLE', name: 'theme/font/role/ui', variableResolvedType: 'STRING', variableSetID: { guid: { sessionID: 2082, localID: 2349 } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 1, localID: 1 }, variableData: { value: { textValue: { characters: 'Source Sans Pro' } } } },
      ] } }],
    ['9:2', { type: 'VARIABLE', name: 'theme/font/role/heading', variableResolvedType: 'STRING', variableSetID: { guid: { sessionID: 2082, localID: 2349 } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 1, localID: 1 }, variableData: { value: { textValue: { characters: 'Merriweather' } } } },
      ] } }],
  ])
  importFigVariableNodes(doc, records)
  expect(Object.keys(doc.designSystem?.collections ?? {})).toEqual(['2082:2349'])
  expect(doc.designSystem?.variables['9:1'].collection).toBe('2082:2349')
  expect(doc.designSystem?.variables['9:2'].collection).toBe('2082:2349')
  validateDocument(doc)
})

test('fig opacity percentages are copied at import and ordinary numbers stay', () => {
  const doc = blank('Opacity')
  doc.schemaVersion = 6
  const chip = node('rectangle', 0, 0, 40, 24)
  const main = node('frame', 0, 40, 40, 24)
  main.component = { variants: {}, properties: {} }
  const instance = node('frame', 0, 80, 40, 24)
  instance.instance = {
    componentId: main.id,
    overrides: { child: { bindings: { opacity: '1:4', width: '1:4' } } },
    propertyValues: {},
  }
  doc.nodes = { [chip.id]: chip, [main.id]: main, [instance.id]: instance }
  doc.pages[0].children = [chip.id, main.id, instance.id]
  const records = new Map<string, Record<string, unknown>>([
    ['1:3', { type: 'VARIABLE_SET', name: 'Theme', key: 'theme', variableSetModes: [
      { name: 'Light', id: { sessionID: 9, localID: 1 } },
      { name: 'Dark', id: { sessionID: 9, localID: 2 } },
    ] }],
    ['1:4', { type: 'VARIABLE', name: 'Disabled 50%', key: 'disabled', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'theme' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 50 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 20 } } },
      ] } }],
    ['1:6', { type: 'VARIABLE', name: 'Solo 50%', key: 'solo', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'theme' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 80 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 40 } } },
      ] } }],
    ['1:5', { type: 'VARIABLE', name: 'Half', key: 'half', variableResolvedType: 'FLOAT', variableSetID: { assetRef: { key: 'theme' } },
      variableDataValues: { entries: [
        { modeID: { sessionID: 9, localID: 1 }, variableData: { value: { floatValue: 0.25 } } },
        { modeID: { sessionID: 9, localID: 2 }, variableData: { value: { floatValue: 0.25 } } },
      ] } }],
    ['chip', { type: 'RECTANGLE', variableConsumptionMap: { entries: [
      { variableField: 'WIDTH', variableData: { value: { alias: { assetRef: { key: 'disabled' } } } } },
      { variableField: 'OPACITY', variableData: { value: { alias: { assetRef: { key: 'disabled' } } } } },
    ] } }],
    ['unit', { type: 'RECTANGLE', variableConsumptionMap: { entries: [
      { variableField: 'OPACITY', variableData: { value: { alias: { assetRef: { key: 'half' } } } } },
    ] } }],
    ['solo', { type: 'RECTANGLE', variableConsumptionMap: { entries: [
      { variableField: 'OPACITY', variableData: { value: { alias: { assetRef: { key: 'solo' } } } } },
    ] } }],
  ])
  importFigVariableNodes(doc, records, new Map([['chip', chip.id], ['unit', main.id], ['solo', instance.id]]))
  expect(doc.designSystem?.variables['1:4'].values.Light).toBe(50)
  expect(doc.designSystem?.variables['1:4'].values.Dark).toBe(20)
  expect(doc.designSystem?.variables['1:4#fig-opacity'].values).toEqual({ Light: 0.5, Dark: 0.2 })
  expect(doc.designSystem?.variables['1:5#fig-opacity']).toBeUndefined()
  expect(doc.designSystem?.variables['1:6#fig-opacity']).toBeUndefined()
  expect(doc.designSystem?.variables['1:6'].values).toEqual({ Light: 0.8, Dark: 0.4 })
  expect(instance.bindings?.opacity).toBe('1:6')
  expect(chip.bindings?.width).toBe('1:4')
  expect(chip.bindings?.opacity).toBe('1:4#fig-opacity')
  expect(main.bindings?.opacity).toBe('1:5')
  const override = instance.instance?.overrides.child.bindings as Record<string, string>
  expect(override.opacity).toBe('1:4#fig-opacity')
  expect(override.width).toBe('1:4')
  validateDocument(doc)
})
