import { expect, test } from 'vitest'
import { importFigComponents } from './import-fig-components'
import { blank, node, paint, stroke } from './model'

test('component properties with several targets and stroke overrides are kept', () => {
  const doc = blank('组件')
  const main = node('frame', 0, 0, 120, 48)
  const labelFrame = node('frame', 0, 0, 48, 20)
  const labelText = node('text', 0, 0, 40, 16)
  labelText.text = 'Label'
  const instance = node('frame', 0, 60, 120, 48)
  main.children = [labelFrame.id]
  labelFrame.children = [labelText.id]
  doc.nodes = { [main.id]: main, [labelFrame.id]: labelFrame, [labelText.id]: labelText, [instance.id]: instance }
  const records = new Map<string, any>([
    ['sym', { type: 'SYMBOL', componentPropDefs: [
      { id: { sessionID: 1, localID: 8 }, name: 'Label', type: 'BOOL', initialValue: { boolValue: true } },
      { id: { sessionID: 1, localID: 9 }, name: 'Input', type: 'BOOL', initialValue: { boolValue: true } },
    ] }],
    ['frame', { type: 'FRAME', name: 'Label', componentPropRefs: [{ defID: { sessionID: 1, localID: 8 }, componentPropNodeField: 'VISIBLE' }] }],
    ['text', { type: 'TEXT', name: 'Label', componentPropRefs: [{ defID: { sessionID: 1, localID: 8 }, componentPropNodeField: 'VISIBLE' }] }],
    ['inst', { type: 'INSTANCE', symbolData: { symbolID: 'sym', symbolOverrides: [{
      guidPath: { guids: ['text'] },
      styleIdForFill: { guid: { sessionID: 4294967295, localID: 4294967295 } },
      strokePaints: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 }, opacity: 1, visible: true }],
      strokeWeight: 2,
    }] } }],
  ])
  const ids = new Map([['sym', main.id], ['frame', labelFrame.id], ['text', labelText.id], ['inst', instance.id]])
  const warnings = new Set<string>()
  importFigComponents(doc, records, ids, () => paint('#000000'), (record) => [{ ...stroke('#123456', record.strokeWeight ?? 1) }], { add: (message) => warnings.add(message) })
  const properties = doc.nodes[main.id].component!.properties
  expect(properties['1:8'].targetKey).toBe(labelFrame.id)
  expect(properties['1:8'].alsoTargets).toEqual([labelText.id])
  expect(properties['1:9'].unbound).toBe(true)
  expect([...warnings].some(message => message.includes('没有唯一目标'))).toBe(false)
  const overrides = doc.nodes[instance.id].instance!.overrides[labelText.id]
  expect(overrides.strokes).toEqual([expect.objectContaining({ width: 2 })])
  expect([...warnings].some(message => message.includes('styleIdForFill') || message.includes('strokePaints'))).toBe(false)
})

test('executable instance overrides land in kernel fields and consumption maps are kept', () => {
  const doc = blank('覆盖')
  const main = node('frame', 0, 0, 120, 80)
  const shape = node('rectangle', 0, 0, 40, 20)
  shape.strokes = [{ ...stroke('#ff0000', 1), align: 'center' }]
  shape.radii = [0, 0, 0, 0]
  const instance = node('frame', 0, 100, 120, 80)
  main.children = [shape.id]
  doc.nodes = { [main.id]: main, [shape.id]: shape, [instance.id]: instance }
  const records = new Map<string, any>([
    ['sym', { type: 'SYMBOL', size: { x: 120, y: 80 }, stackMode: 'VERTICAL', stackSpacing: 4, stackHorizontalPadding: 2, stackVerticalPadding: 2 }],
    ['shape', { type: 'RECTANGLE', parentIndex: { guid: 'sym' } }],
    ['9:3', { type: 'VARIABLE', key: 'width-token', variableResolvedType: 'FLOAT' }],
    ['inst', { type: 'INSTANCE', symbolData: { symbolID: 'sym', symbolOverrides: [
      {
        guidPath: { guids: ['shape'] },
        cornerRadius: 8,
        rectangleTopLeftCornerRadius: 2,
        size: { x: 50, y: 30 },
        strokeAlign: 'INSIDE',
        strokeWeight: 6,
        borderStrokeWeightsIndependent: true,
        borderTopWeight: 1,
        borderRightWeight: 4,
        pluginData: [{ key: 'k', value: 'v' }],
        effects: [{ type: 'DROP_SHADOW' }],
        variableConsumptionMap: { entries: [
          { variableField: 'WIDTH', variableData: { value: { alias: { assetRef: { key: 'width-token' }, guid: { sessionID: 9, localID: 3 } } } } },
          { variableField: 'STROKE_WEIGHT', variableData: { value: { alias: { guid: { sessionID: 9, localID: 3 } } } } },
        ] },
        parameterConsumptionMap: { entries: [{ variableField: 'WIDTH' }] },
      },
    ] } }],
  ])
  const ids = new Map([['sym', main.id], ['shape', shape.id], ['inst', instance.id], ['9:3', 'var-width']])
  const warnings = new Set<string>()
  const receipts = new Map<string, Record<string, string>>()
  importFigComponents(doc, records, ids, () => paint('#000000'), (record) => [{ ...stroke('#123456', record.strokeWeight ?? 1) }], { add: (message) => warnings.add(message) }, receipts, () => [{ id: 'e', kind: 'shadow', visible: true, radius: 4, x: 0, y: 0, spread: 0, color: '#000000', opacity: 1, amount: 0 }])
  const first = doc.nodes[instance.id].instance!.overrides[shape.id]
  expect(first.radii).toEqual([2, 8, 8, 8])
  expect(first.width).toBe(50)
  expect(first.height).toBe(30)
  expect(first.strokes).toEqual([expect.objectContaining({ width: 6, align: 'inside' })])
  expect(first.effects).toEqual([expect.objectContaining({ kind: 'shadow', radius: 4 })])
  expect((first.bindings as Record<string, string>).width).toBe('9:3')
  expect([...warnings].some(message => message.includes('pluginData'))).toBe(true)
  expect([...warnings].some(message => message.includes('borderStrokeWeightsIndependent'))).toBe(true)
  expect([...warnings].some(message => message.includes('variableConsumptionMap.STROKE_WEIGHT'))).toBe(true)
  expect([...warnings].some(message => message.includes('parameterConsumptionMap'))).toBe(true)
  expect([...warnings].some(message => message.includes('cornerRadius') || message.includes('strokeAlign'))).toBe(false)
  const kept = receipts.get(instance.id)?.figOverrideVariableConsumption ?? ''
  expect(kept).toContain('STROKE_WEIGHT')
  expect(kept).toContain('parameterConsumptionMap')
})

test('in-file auto-layout and font variants execute while missing targets stay reported', () => {
  const doc = blank('布局')
  const main = node('frame', 0, 0, 200, 160)
  const frame = node('frame', 0, 0, 80, 40)
  const child = node('rectangle', 0, 0, 20, 20)
  const text = node('text', 0, 0, 40, 16)
  text.text = 'Ag'
  text.fontSize = 16
  const instance = node('frame', 0, 180, 200, 160)
  main.children = [frame.id, child.id, text.id]
  doc.nodes = { [main.id]: main, [frame.id]: frame, [child.id]: child, [text.id]: text, [instance.id]: instance }
  const records = new Map<string, any>([
    ['sym', { type: 'SYMBOL', stackMode: 'VERTICAL', stackSpacing: 4, stackHorizontalPadding: 2, stackVerticalPadding: 2 }],
    ['frame', { type: 'FRAME', parentIndex: { guid: 'sym' }, stackMode: 'HORIZONTAL', stackSpacing: 4, stackHorizontalPadding: 1, stackVerticalPadding: 1 }],
    ['child', { type: 'RECTANGLE', parentIndex: { guid: 'sym' } }],
    ['text', { type: 'TEXT', parentIndex: { guid: 'sym' }, textData: { characters: 'Ag' }, fontSize: 16 }],
    ['inst', { type: 'INSTANCE', symbolData: { symbolID: 'sym', symbolOverrides: [
      { guidPath: { guids: ['frame'] }, stackSpacing: 12, stackHorizontalPadding: 6, stackVerticalPadding: 3, stackPaddingRight: 9, stackPrimarySizing: 'FIXED', proportionsConstrained: true },
      { guidPath: { guids: ['child'] }, stackChildAlignSelf: 'STRETCH', stackChildPrimaryGrow: 1 },
      { guidPath: { guids: ['text'] }, fontVariantCommonLigatures: false, fontVariantCaps: 'SMALL', toggledOnOTFeatures: ['KERN'], textTracking: 120, lineHeight: { units: 'PIXELS', value: 24 }, fontName: { family: 'Inter', style: 'Bold' }, variableConsumptionMap: { entries: [{ variableField: 'RECTANGLE_TOP_LEFT_CORNER_RADIUS', variableData: { value: { alias: { guid: { sessionID: 9, localID: 3 } } } } }] } },
      { guidPath: { guids: ['44:1'] }, stackPaddingRight: 4, fontVariantCaps: 'SMALL', fontVariantNumericFraction: 'NOT_A_FRACTION' },
    ] } }],
  ])
  const ids = new Map([['sym', main.id], ['frame', frame.id], ['child', child.id], ['text', text.id], ['inst', instance.id]])
  const warnings = new Set<string>()
  const receipts = new Map<string, Record<string, string>>()
  importFigComponents(doc, records, ids, () => paint('#000000'), () => [], { add: (message) => warnings.add(message) }, receipts)
  const frameFields = doc.nodes[instance.id].instance!.overrides[frame.id]
  expect((frameFields.layout as { gap: number; padding: number[] }).gap).toBe(12)
  expect((frameFields.layout as { padding: number[] }).padding).toEqual([3, 9, 3, 6])
  expect(frameFields.constrainProportions).toBe(true)
  const childFields = doc.nodes[instance.id].instance!.overrides[child.id]
  expect(childFields.sizing).toEqual(expect.objectContaining({ width: 'fill', height: 'fill', alignSelf: 'stretch' }))
  const textFields = doc.nodes[instance.id].instance!.overrides[text.id]
  expect((textFields.textStyle as { features: string[]; letterSpacing: number; lineHeight: number; weight: number }).letterSpacing).toBe(120)
  expect((textFields.textStyle as { lineHeight: number }).lineHeight).toBe(1.5)
  expect((textFields.textStyle as { weight: number }).weight).toBe(700)
  expect((textFields.textStyle as { features: string[] }).features).toEqual(expect.arrayContaining(['-liga', '-clig', 'smcp', 'kern']))
  const missing = doc.nodes[instance.id].instance!.overrides['44:1']
  expect(missing.layout).toBeUndefined()
  expect((missing.textStyle as { features: string[] }).features).toEqual(['smcp'])
  const messages = [...warnings]
  expect(messages.some(message => message.includes('stackPaddingRight'))).toBe(true)
  expect(messages.some(message => message.includes('fontVariantNumericFraction'))).toBe(true)
  expect(messages.some(message => message.includes('textTracking') || message.includes('lineHeight'))).toBe(false)
  expect(messages.some(message => message.includes('fontName.family=Inter'))).toBe(true)
  expect(messages.some(message => message.includes('fontVariantCaps') || message.includes('stackSpacing') || message.includes('stackChildAlignSelf'))).toBe(false)
  expect(receipts.get(instance.id)?.figOverrideVariableConsumption).toContain('RECTANGLE_TOP_LEFT_CORNER_RADIUS')
})
